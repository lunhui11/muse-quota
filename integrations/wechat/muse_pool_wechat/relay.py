import hashlib
import json
import logging
import re
import shlex
import sys
import time
import uuid
from urllib.parse import urlsplit
import httpx
from wechat_muse_bridge.ilink.models import AuthExpired, ILinkError
from wechat_muse_bridge.ilink.protocol import inbound_text
from wechat_muse_bridge.muse.client import MuseClient, MuseError
from wechat_muse_bridge.send import chunk_text, clean_text
from .pool import PoolError

log = logging.getLogger(__name__)
LABELS = {
    'queued': '等待调度', 'ready': '已就绪，等待执行', 'running': '执行中',
    'waiting_account': '等待可用账号', 'waiting_drive': '等待网盘授权',
    'pause_requested': '等待当前步骤结束并保存进度', 'uploading': '上传交接文件',
    'upload_failed': '交接失败，等待修复', 'checkpoint_pending': '保存暂停进度',
    'checkpoint_upload_failed': '暂停进度上传失败', 'finalizing': '上传最终成果',
    'completion_upload_failed': '最终成果上传失败', 'needs_attention': '需要人工检查',
    'completed': '已完成', 'cancelled': '已取消',
}
ATTENTION = {'waiting_account', 'waiting_drive', 'upload_failed', 'checkpoint_upload_failed', 'completion_upload_failed', 'needs_attention'}
HELP = ('新任务：任务要求\n查询任务 任务ID\n取消任务 任务ID\n任务列表\n开始执行\n暂停执行\n/reset\n'
        '任务通过账号池执行；暂停等待当前步骤结束。需要人工检查时请使用管理面板恢复。')


def message_ref(sender, message_id):
    return hashlib.sha256((sender + '\0' + message_id).encode()).hexdigest()


def result_text(task):
    status = task.get('status', '')
    text = '任务 ' + task['id'] + '\n' + LABELS.get(status, status) + ' · 版本 ' + str(task.get('revision', 0))
    if task.get('error'):
        text += '\n' + str(task['error'])[:600]
    checkpoint = task.get('checkpoint') or {}
    if checkpoint.get('summary'):
        text += '\n' + str(checkpoint['summary'])[:1800]
    url = (task.get('file') or {}).get('url', '')
    try:
        if urlsplit(url).scheme == 'https' and urlsplit(url).hostname == 'drive.google.com':
            text += '\n网盘文件：' + url[:500]
    except ValueError:
        pass
    return text


class Relay:
    def __init__(self, settings, store, pool, ilink, muse=None):
        self.settings, self.store, self.pool, self.ilink = settings, store, pool, ilink
        self.muse = muse or MuseClient(settings.gadget)
        self.running = True

    def ingest(self, messages, cursor):
        # Cursor can advance after the entire batch has been durably queued.
        with self.store.db:
            for message in messages:
                sender = message.get('from_user_id')
                ident = message.get('message_id')
                token = message.get('context_token')
                text = inbound_text(message)
                if (not isinstance(sender, str) or sender not in self.settings.allowed or
                        not isinstance(ident, (str, int)) or isinstance(ident, bool) or not str(ident) or
                        text is None or len(text) > 8000 or
                        not isinstance(token, str) or not token or len(token) > 16384):
                    continue
                ref = message_ref(sender, str(ident))
                inserted=self.store.db.execute('INSERT OR IGNORE INTO inbox(ref,user_id,token,text) VALUES (?,?,?,?)',
                                               (ref, sender, token, text)).rowcount
                if not inserted:continue
                self.store.db.execute('INSERT INTO users VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET token=excluded.token',
                                      (sender, token, str(uuid.uuid4())))
            if cursor:
                self.store.set_meta('cursor', cursor)

    def queue(self, event, user, token, text):
        text = clean_text(text)
        if not text or len(text) > 8000:
            raise ValueError('Reply must contain 1–8000 characters')
        self.store.enqueue(event, user, token, chunk_text(text))

    def reply(self, ref, text):
        row = self.store.receipt(ref)
        if not row or row['user_id'] not in self.settings.allowed:
            raise ValueError('Unknown or unauthorized reply reference')
        with self.store.db:
            existing = self.store.db.execute('SELECT chunks FROM outbox WHERE event=?', ('reply:' + ref,)).fetchone()
            if existing and json.loads(existing['chunks']) != chunk_text(clean_text(text)):
                raise ValueError('A different reply already exists for this reference')
            self.queue('reply:' + ref, row['user_id'], row['token'], text)

    def _respond(self, row, text):
        with self.store.db:
            self.queue('ack:' + row['ref'], row['user_id'], row['token'], text)
            self.store.acknowledge(row['ref'])

    def _owned(self, user, task_id):
        if not re.fullmatch('[a-f0-9]{12}', task_id):
            return False
        task = self.store.task_owner(task_id)
        return bool(task and task['user_id'] == user)

    def process_one(self):
        row = self.store.pending()
        if row is None:
            return False
        text, user, ref = row['text'], row['user_id'], row['ref']
        if user not in self.settings.allowed:
            with self.store.db:
                self.store.acknowledge(ref)
            return True
        try:
            if text in ('帮助', '/help'):
                self._respond(row, HELP)
            elif text in ('开始执行', '/start'):
                self.pool.executor('start')
                self._respond(row, '自动执行已启动。可发送“新任务：任务要求”。')
            elif text in ('暂停执行', '/pause'):
                self.pool.executor('pause')
                self._respond(row, '已停止领取新任务，当前步骤结束后保存进度。')
            elif text == '/reset':
                with self.store.db:
                    self.store.db.execute('UPDATE users SET session=? WHERE user_id=?', (str(uuid.uuid4()), user))
                    self.queue('ack:' + ref, user, row['token'], 'Muse 聊天会话已重置，账号池中的任务继续保留。')
                    self.store.acknowledge(ref)
            elif text in ('任务列表', '/tasks'):
                tasks = self.store.db.execute('SELECT task_id FROM tasks WHERE user_id=? ORDER BY rowid DESC LIMIT 10', (user,)).fetchall()
                lines = [result_text(self.pool.task(t['task_id'])) for t in tasks]
                self._respond(row, '\n\n'.join(lines)[:7800] if lines else '还没有通过此微信创建的任务。')
            elif (match := re.fullmatch(r'(查询任务|取消任务|/status|/cancel)\s+(.+)', text)):
                action, task_id = match.groups()
                if not self._owned(user, task_id):
                    self._respond(row, '没有找到属于你的这个任务。')
                else:
                    task = self.pool.cancel(task_id) if action in ('取消任务', '/cancel') else self.pool.task(task_id)
                    self._respond(row, result_text(task))
            elif text.startswith(('查询任务', '取消任务', '/status', '/cancel')):
                self._respond(row, '请发送“查询任务 任务ID”或“取消任务 任务ID”。')
            elif (match := re.match(r'^(?:新任务|任务)\s*[:：]\s*(.*)$', text, re.S)) or self.settings.mode == 'task':
                prompt = match.group(1).strip() if match else text
                if not prompt:
                    self._respond(row, '请在“新任务：”之后填写任务要求。')
                else:
                    # Stable server-side request ID survives lost responses and service restarts.
                    task = self.pool.create_task(prompt, 'wechat:' + ref)
                    if not re.fullmatch('[a-f0-9]{12}', task.get('id', '')) or task.get('request_id') != 'wechat:' + ref:
                        raise PoolError(409, '账号池未确认幂等任务，请更新服务后重试。')
                    with self.store.db:
                        self.store.db.execute('INSERT OR IGNORE INTO tasks(task_id,user_id,ref) VALUES (?,?,?)', (task['id'], user, ref))
                        self.store.db.execute('UPDATE inbox SET task_id=? WHERE ref=?', (task['id'], ref))
                        self.queue('ack:' + ref, user, row['token'], '任务已保存：' + task['id'] + '\n发送“查询任务 ' + task['id'] + '”查看进度。执行器未启动时请发送“开始执行”。')
                        self.store.acknowledge(ref)
            else:
                session = self.store.db.execute('SELECT session FROM users WHERE user_id=?', (user,)).fetchone()['session']
                command = shlex.quote(sys.executable) + ' -m muse_pool_wechat.cli reply'
                if self.settings.env_file:
                    command += ' --env-file ' + shlex.quote(str(self.settings.env_file))
                command += ' --ref ' + ref + ' -'
                envelope = ('[via WeChat]\n回复引用：' + ref + '\n'
                            '完成答复后，通过已连接设备的终端执行下面命令，正文仅通过 stdin 传入；不要把正文拼接进 shell：\n' + command + '\n\n' + text)
                with self.store.db:
                    self.store.db.execute("UPDATE inbox SET status='gadget_sending' WHERE ref=?", (ref,))
                try:
                    self.muse.send_user_message(session, envelope)
                except MuseError:
                    with self.store.db:
                        self.store.db.execute("UPDATE inbox SET status='needs_attention' WHERE ref=?", (ref,))
                        self.queue('gadget-error:' + ref, user, row['token'], 'Muse 消息投递状态不明，已停止自动重发，请检查设备连接和 Side Chat。')
                else:
                    with self.store.db:
                        self.store.acknowledge(ref)
        except (httpx.HTTPError, PoolError) as exc:
            if isinstance(exc, PoolError) and exc.status < 500:
                self._respond(row, str(exc))
            else:
                with self.store.db:
                    if text in ('开始执行','/start','暂停执行','/pause'):
                        self.store.db.execute("UPDATE inbox SET status='needs_attention' WHERE ref=?", (ref,))
                        self.queue('control-error:' + ref, user, row['token'], '执行器控制结果未确认，请检查面板，再发送明确的新命令；不会自动重放控制操作。')
                    else:
                        self.store.db.execute('UPDATE inbox SET attempts=attempts+1,next_attempt=? WHERE ref=?',
                                              (time.time() + min(30, 2 ** min(row['attempts'] + 1, 5)), ref))
                        self.queue('pool-error:' + ref, user, row['token'], '账号池暂时不可用，消息已保存在本机，恢复后会自动重试。')
        return True

    def poll_tasks(self):
        rows = self.store.db.execute("SELECT * FROM tasks WHERE status NOT IN ('completed','cancelled','missing') ORDER BY polled LIMIT 20").fetchall()
        for row in rows:
            if row['user_id'] not in self.settings.allowed:
                continue
            try:
                task = self.pool.task(row['task_id'])
            except PoolError as exc:
                if exc.status==404:
                    with self.store.db:
                        user=self.store.db.execute('SELECT token FROM users WHERE user_id=?',(row['user_id'],)).fetchone()
                        if user:self.queue('missing:'+row['task_id'],row['user_id'],user['token'],'账号池中找不到任务 '+row['task_id']+'，请检查服务的数据目录；不会自动重建任务。')
                        self.store.db.execute("UPDATE tasks SET status='missing' WHERE task_id=?",(row['task_id'],))
                    continue
                break
            except httpx.HTTPError:
                break
            status, revision = task.get('status', ''), task.get('revision', 0)
            user = self.store.db.execute('SELECT token FROM users WHERE user_id=?', (row['user_id'],)).fetchone()
            with self.store.db:
                if user:
                    if status in ATTENTION or status in ('completed', 'cancelled'):
                        self.queue('task:' + row['task_id'] + ':' + status + ':' + str(revision), row['user_id'], user['token'], result_text(task))
                    elif revision > 1 and status in ('ready', 'running'):
                        self.queue('handoff:' + row['task_id'] + ':' + str(revision), row['user_id'], user['token'], result_text(task))
                self.store.db.execute('UPDATE tasks SET status=?,revision=?,polled=? WHERE task_id=?', (status, revision, time.time(), row['task_id']))

    def flush_one(self):
        row = self.store.db.execute("SELECT * FROM outbox WHERE status='pending' ORDER BY created,rowid LIMIT 1").fetchone()
        if row is None:
            return False
        if row['user_id'] not in self.settings.allowed:
            with self.store.db:
                self.store.db.execute("UPDATE outbox SET status='held',error='收件人不再授权。' WHERE event=?", (row['event'],))
            return True
        chunks = json.loads(row['chunks'])
        for index in range(row['next_chunk'], len(chunks)):
            with self.store.db:
                self.store.db.execute("UPDATE outbox SET status='sending' WHERE event=?", (row['event'],))
            try:
                self.ilink.send_message(row['user_id'], row['token'], chunks[index])
            except AuthExpired:
                with self.store.db:
                    self.store.db.execute("UPDATE outbox SET status='pending',error='微信授权失效，等待重新扫码。' WHERE event=?", (row['event'],))
                raise
            except ILinkError:
                # A timeout may happen after acceptance. Do not silently send the same chunk twice.
                with self.store.db:
                    self.store.db.execute("UPDATE outbox SET status='uncertain',error='发送未确认，请核对微信是否收到。' WHERE event=?", (row['event'],))
                return True
            with self.store.db:
                self.store.db.execute('UPDATE outbox SET next_chunk=?,status=? WHERE event=?',
                                      (index + 1, 'sent' if index + 1 == len(chunks) else 'pending', row['event']))
        return True

    def once(self):
        self.process_one()
        self.poll_tasks()
        for _ in range(20):
            if not self.flush_one():
                break
