import json
from dataclasses import replace
from pathlib import Path
import httpx
import pytest
from wechat_muse_bridge.ilink.models import AuthExpired, NetworkError
from wechat_muse_bridge.muse.client import MuseError
from muse_pool_wechat.config import Settings, load_env
from muse_pool_wechat.storage import Store
from muse_pool_wechat.relay import Relay, message_ref
from muse_pool_wechat.pool import PoolClient, PoolError
from muse_pool_wechat.cli import instance_lock, main


class PoolFixture:
    def __init__(self):
        self.tasks = {}
        self.calls = 0
        self.lose_response = False
        self.controls = []

    def create_task(self, prompt, request_id):
        self.calls += 1
        task = self.tasks.setdefault(request_id, {'id': str(len(self.tasks) + 1).zfill(12), 'request_id': request_id, 'prompt': prompt, 'status': 'queued', 'revision': 0})
        if self.lose_response:
            self.lose_response = False
            raise httpx.ReadTimeout('fixture response lost after creation')
        return dict(task)

    def task(self, task_id):
        return dict(next(t for t in self.tasks.values() if t['id'] == task_id))

    def cancel(self, task_id):
        t = next(t for t in self.tasks.values() if t['id'] == task_id)
        if t['status'] == 'running':
            raise PoolError(409, '任务执行中或状态已变化，请先安全暂停并检查进度。')
        t['status'] = 'cancelled'
        return dict(t)

    def executor(self, action):
        self.controls.append(action)
        return {'enabled': action == 'start'}


class ILinkFixture:
    def __init__(self):
        self.sends = []
        self.calls = 0
        self.fail_at = None
        self.expired = False

    def send_message(self, user, token, text):
        self.calls += 1
        if self.expired:
            raise AuthExpired('fixture expired')
        if self.calls == self.fail_at:
            raise NetworkError('fixture timeout')
        self.sends.append((user, token, text))


class MuseFixture:
    def __init__(self, fail=False):
        self.calls = []
        self.fail = fail

    def send_user_message(self, session, text):
        self.calls.append((session, text))
        if self.fail:
            raise MuseError('fixture uncertain delivery')


def message(ident='1', user='alice', token='fixture-context-alice', text='写报告', **extra):
    return {'message_id': ident, 'from_user_id': user, 'context_token': token, 'message_type': 1,
            'group_id': '', 'item_list': [{'type': 1, 'text_item': {'text': text}}], **extra}


@pytest.fixture
def clean_env(monkeypatch):
    for key in ('ALLOWED_USER_IDS','WECHAT_MUSE_DATA_DIR','TASK_POOL_BASE_URL','WECHAT_DEFAULT_MODE','MUSEGADGET_COMMAND'):
        monkeypatch.delenv(key, raising=False)


@pytest.fixture(autouse=True)
def isolated_environment(clean_env):
    pass


@pytest.fixture
def f(tmp_path):
    settings = Settings(tmp_path, frozenset({'alice', 'bob'}))
    store, pool, ilink, muse = Store(tmp_path), PoolFixture(), ILinkFixture(), MuseFixture()
    relay = Relay(settings, store, pool, ilink, muse)
    yield relay, store, pool, ilink, muse
    store.close()


def drain(relay):
    for _ in range(30):
        if not relay.flush_one():
            return
    pytest.fail('unexpected persistent pending queue')


def test_durable_inbox_filters_and_does_not_change_reply_routes(f):
    relay, store, _, _, _ = f
    relay.ingest([message()], 'c1')
    rejected = [message('2', user='intruder'), message('3', group_id='group'),
                message('4', item_list=[{'type': 2}]), message('5', text='x' * 8001),
                message('6', token=''), message('', text='missing ID')]
    relay.ingest(rejected, 'c2')
    assert store.db.execute('SELECT COUNT(*) FROM inbox').fetchone()[0] == 1
    assert store.db.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 1
    assert store.db.execute('SELECT token FROM users').fetchone()[0] == 'fixture-context-alice'
    assert store.meta('cursor') == 'c2'


def test_lost_creation_response_reuses_server_id_after_restart(f):
    relay, store, pool, ilink, _ = f
    relay.ingest([message()], 'cursor')
    pool.lose_response = True
    relay.process_one()
    assert store.pending() is None  # backoff
    assert len(pool.tasks) == 1
    second = Store(store.directory)
    try:
        second.recover()
        with second.db:
            second.db.execute('UPDATE inbox SET next_attempt=0')
        restarted = Relay(relay.settings, second, pool, ilink)
        restarted.process_one()
        assert len(pool.tasks) == 1
        assert pool.calls == 2
        assert second.receipt(message_ref('alice', '1'))['task_id'] == '000000000001'
    finally:
        second.close()


def test_local_commit_failure_after_server_creation_is_retryable_without_new_task(f, monkeypatch):
    relay, store, pool, _, _ = f
    relay.ingest([message()], 'c')
    original = store.enqueue
    def fail(*_):
        raise OSError('fixture disk full')
    monkeypatch.setattr(store, 'enqueue', fail)
    with pytest.raises(OSError):
        relay.process_one()
    assert len(pool.tasks) == 1
    assert store.task_owner('000000000001') is None
    monkeypatch.setattr(store, 'enqueue', original)
    relay.process_one()
    assert len(pool.tasks) == 1
    assert store.task_owner('000000000001')['user_id'] == 'alice'


def test_duplicate_delivery_creates_one_task_and_one_ack(f):
    relay, store, pool, ilink, _ = f
    relay.ingest([message(), message()], 'c1')
    relay.process_one()
    relay.ingest([message()], 'c2')
    relay.process_one()
    drain(relay)
    assert len(pool.tasks) == 1
    assert pool.calls == 1
    assert len(ilink.sends) == 1
    assert '任务已保存' in ilink.sends[0][2]


def test_batch_write_failure_does_not_commit_cursor_or_partial_inbox(f, monkeypatch):
    relay, store, _, _, _ = f
    monkeypatch.setattr(store, 'set_meta', lambda *_: (_ for _ in ()).throw(OSError('fixture commit failed')))
    with pytest.raises(OSError):
        relay.ingest([message()], 'bad-cursor')
    assert store.db.execute('SELECT COUNT(*) FROM inbox').fetchone()[0] == 0
    assert store.meta('cursor') == ''


def test_result_is_bound_to_original_owner_not_latest_sender(f):
    relay, store, pool, ilink, _ = f
    relay.ingest([message()], 'c1')
    relay.process_one()
    relay.ingest([message('2', user='bob', token='fixture-context-bob', text='帮助')], 'c2')
    relay.process_one()
    task = next(iter(pool.tasks.values()))
    task.update(status='completed', revision=2, checkpoint={'summary': '已完成报告'}, file={'url': 'https://drive.google.com/file/d/fixture/view'})
    relay.poll_tasks()
    relay.poll_tasks()
    drain(relay)
    finals = [s for s in ilink.sends if '已完成报告' in s[2]]
    assert len(finals) == 1
    assert finals[0][:2] == ('alice', 'fixture-context-alice')


def test_other_user_cannot_query_or_cancel_owned_task(f):
    relay, _, pool, ilink, _ = f
    relay.ingest([message()], 'c1');relay.process_one()
    relay.ingest([message('2', user='bob', token='fixture-context-bob', text='取消任务 000000000001')], 'c2')
    relay.process_one();drain(relay)
    assert next(iter(pool.tasks.values()))['status'] == 'queued'
    assert any('属于你的' in s[2] and s[0] == 'bob' for s in ilink.sends)


def test_running_cancel_keeps_task_running_and_reports_conflict(f):
    relay, _, pool, ilink, _ = f
    relay.ingest([message()], 'c1');relay.process_one()
    next(iter(pool.tasks.values()))['status'] = 'running'
    relay.ingest([message('2', text='取消任务 000000000001')], 'c2');relay.process_one();drain(relay)
    assert next(iter(pool.tasks.values()))['status'] == 'running'
    assert any('状态已变化' in s[2] for s in ilink.sends)


def test_chat_reply_uses_immutable_reference_and_per_user_sessions(f):
    relay, store, pool, ilink, muse = f
    relay.settings = replace(relay.settings, mode='chat')
    relay.ingest([message()], 'c1');relay.process_one()
    relay.ingest([message('2', user='bob', token='fixture-context-bob')], 'c2');relay.process_one()
    assert muse.calls[0][0] != muse.calls[1][0]
    assert '-m muse_pool_wechat.cli reply' in muse.calls[0][1]
    ref = message_ref('alice', '1')
    relay.reply(ref, '原消息回复')
    relay.reply(ref, '原消息回复')
    with pytest.raises(ValueError):
        relay.reply(ref, '同引用不同回复')
    drain(relay)
    assert ilink.sends == [('alice', 'fixture-context-alice', '原消息回复')]
    assert len(pool.tasks) == 0


def test_gadget_failure_and_recovery_do_not_replay_uncertain_input(f):
    relay, store, _, ilink, muse = f
    relay.settings = replace(relay.settings, mode='chat')
    muse.fail = True
    relay.ingest([message()], 'c');relay.process_one()
    store.recover();relay.process_one();drain(relay)
    assert len(muse.calls) == 1
    assert store.receipt(message_ref('alice', '1'))['status'] == 'needs_attention'
    assert any('停止自动重发' in s[2] for s in ilink.sends)


def test_partial_outbound_timeout_is_held_and_resume_only_sends_unconfirmed_chunks(f):
    relay, store, _, ilink, _ = f
    relay.ingest([message()], 'c')
    relay.reply(message_ref('alice', '1'), 'x' * 5000)
    ilink.fail_at = 2
    relay.flush_one()
    row = store.db.execute('SELECT * FROM outbox').fetchone()
    assert row['status'] == 'uncertain' and row['next_chunk'] == 1
    store.recover();relay.flush_one()
    assert ilink.calls == 2
    with store.db:
        store.db.execute("UPDATE outbox SET status='pending' WHERE status='uncertain'")
    ilink.fail_at = None;relay.flush_one()
    assert [len(s[2]) for s in ilink.sends] == [4000, 1000]


def test_sending_boundary_after_crash_is_not_automatically_resent(f):
    relay, store, _, ilink, _ = f
    with store.db:
        relay.queue('crash', 'alice', 'fixture-context', '文本')
        store.db.execute("UPDATE outbox SET status='sending'")
    store.recover();relay.flush_one()
    assert ilink.sends == []
    assert store.db.execute('SELECT status FROM outbox').fetchone()[0] == 'uncertain'


def test_expired_outbound_keeps_pending_and_never_claims_sent(f):
    relay, store, _, ilink, _ = f
    with store.db:
        relay.queue('expired', 'alice', 'fixture-context', '文本')
    ilink.expired = True
    with pytest.raises(AuthExpired):
        relay.flush_one()
    assert store.db.execute('SELECT status FROM outbox').fetchone()[0] == 'pending'
    assert ilink.sends == []


def test_removed_user_cannot_receive_queued_reply(f):
    relay, store, _, ilink, _ = f
    with store.db:
        relay.queue('removed', 'bob', 'fixture-context', '文本')
    relay.settings = replace(relay.settings, allowed=frozenset({'alice'}))
    relay.flush_one()
    assert ilink.sends == []
    assert store.db.execute('SELECT status FROM outbox').fetchone()[0] == 'held'


def test_lost_start_response_cannot_override_a_later_manual_pause(f, monkeypatch):
    relay, store, pool, _, _ = f
    def uncertain(action):
        pool.controls.append(action)
        raise httpx.ReadTimeout('fixture control result unknown')
    monkeypatch.setattr(pool, 'executor', uncertain)
    relay.ingest([message(text='开始执行')], 'c');relay.process_one()
    store.recover();relay.process_one()
    assert pool.controls == ['start']
    assert store.receipt(message_ref('alice', '1'))['status'] == 'needs_attention'


def test_pool_preflight_rejects_old_versions_and_transport_follows_no_redirects():
    seen=[]
    def handle(request):
        seen.append(request.url.path)
        return httpx.Response(200, json={'tasks': [], 'capabilities': {}})
    client=PoolClient('http://127.0.0.1:8788', httpx.Client(transport=httpx.MockTransport(handle)))
    with pytest.raises(PoolError,match='版本过旧'):
        client.check()
    assert seen == ['/api/pool'];client.close()


def test_config_is_parsed_as_data_and_cannot_override_system_environment(tmp_path, monkeypatch):
    file=tmp_path/'relay.env';sentinel=tmp_path/'not-created'
    file.write_text('ALLOWED_USER_IDS=alice\nWECHAT_MUSE_DATA_DIR='+str(tmp_path/'data')+'\nMUSEGADGET_COMMAND=$(touch '+str(sentinel)+')\n')
    settings=Settings.from_env(file)
    assert not sentinel.exists()
    assert settings.allowed == frozenset({'alice'})
    file.write_text('PATH=/incorrect\n')
    with pytest.raises(ValueError):load_env(file)


def test_private_state_and_instance_lock(tmp_path):
    store=Store(tmp_path/'data')
    assert store.path.stat().st_mode & 0o777 == 0o600
    assert store.directory.stat().st_mode & 0o777 == 0o700
    with instance_lock(store.directory):
        with pytest.raises(ValueError):
            with instance_lock(store.directory):pass
    store.close()


def test_cli_outbox_does_not_print_recipient_token_or_message(f, tmp_path, capsys):
    relay, store, _, _, _ = f
    with store.db:relay.queue('fixture-event','alice','fixture-secret-context','fixture-private-body')
    env=tmp_path/'relay.env';env.write_text('ALLOWED_USER_IDS=alice\nWECHAT_MUSE_DATA_DIR='+str(store.directory)+'\n')
    assert main(['outbox','--env-file',str(env)]) == 0
    output=capsys.readouterr().out
    assert 'fixture-event' in output
    assert 'fixture-secret-context' not in output and 'fixture-private-body' not in output
    assert main(['retry','--env-file',str(env),'--event','fixture-event']) == 1


def test_reset_is_atomic_and_does_not_cancel_tasks(f):
    relay, store, pool, _, _ = f
    relay.ingest([message()], 'c1');relay.process_one()
    session=store.db.execute('SELECT session FROM users WHERE user_id=?',('alice',)).fetchone()[0]
    relay.ingest([message('2',text='/reset')], 'c2');relay.process_one()
    assert store.db.execute('SELECT session FROM users WHERE user_id=?',('alice',)).fetchone()[0] != session
    assert next(iter(pool.tasks.values()))['status'] == 'queued'


def test_old_message_replay_does_not_replace_new_reply_context(f):
    relay, store, _, _, _ = f
    relay.ingest([message(token='old-fixture-token')], 'c1')
    relay.ingest([message('2', token='new-fixture-token')], 'c2')
    relay.ingest([message(token='old-fixture-token')], 'c3')
    assert store.db.execute("SELECT token FROM users WHERE user_id='alice'").fetchone()[0] == 'new-fixture-token'
    assert store.meta('cursor') == 'c3'


def test_task_lookup_rejects_mismatched_or_malformed_backend_reply():
    for data in ({'id':'wrong','status':'running','revision':1},
                 {'id':'000000000001','status':'running','revision':'2'}):
        client=PoolClient('http://127.0.0.1:8788',httpx.Client(transport=httpx.MockTransport(lambda _:httpx.Response(200,json=data))))
        try:
            with pytest.raises(PoolError):client.task('000000000001')
        finally:client.close()


@pytest.mark.parametrize('payload',[{'ret':-14},{'errcode':-14},{'ret':0}])
def test_pinned_sdk_send_expiry_bug_is_held_without_replay(f,payload):
    from wechat_muse_bridge.ilink.models import Credentials
    from muse_pool_wechat.transport import ILinkTransport
    relay, store, _, _, _ = f
    transport=ILinkTransport(Credentials('fixture-bot-token','fixture-bot','https://example.invalid'))
    transport.client.close()
    calls=[]
    def response(request):
        calls.append(request)
        return httpx.Response(200,json=payload)
    transport.client=httpx.Client(transport=httpx.MockTransport(response))
    relay.ilink=transport
    try:
        with store.db:relay.queue('expiry-fixture','alice','fixture-context','text')
        relay.flush_one();relay.flush_one()
        expected='uncertain' if -14 in payload.values() else 'sent'
        assert store.db.execute('SELECT status FROM outbox').fetchone()[0] == expected
        assert len(calls)==1
    finally:transport.close()


def test_enrollment_wrapper_saves_svg_exact_allowlist_and_cursor(tmp_path,monkeypatch,capsys):
    import qrcode
    from wechat_muse_bridge.state import BridgeState
    import muse_pool_wechat.cli as cli
    env=tmp_path/'relay.env';directory=tmp_path/'data'
    env.write_text('ALLOWED_USER_IDS=old-fixture-user\nWECHAT_MUSE_DATA_DIR='+str(directory)+'\n')
    settings=Settings.from_env(env,require_allowlist=False)
    original=qrcode.QRCode.print_ascii
    def fixture_enroll(_):
        qr=qrcode.QRCode();qr.add_data('fixture-only-no-login');qr.make();qr.print_ascii()
        BridgeState(cursor='fixture-enrolled-cursor').save(directory/'state.json')
        print('Enrolled from_user_id: fixture-alice')
        return 0
    monkeypatch.setattr(cli,'enroll',fixture_enroll)
    monkeypatch.setattr(cli,'legacy_running',lambda:False)
    assert cli.enroll_device(settings,save_user=True)==0
    assert qrcode.QRCode.print_ascii is original
    assert 'ALLOWED_USER_IDS=fixture-alice' in env.read_text()
    assert 'old-fixture-user' not in env.read_text()
    assert env.stat().st_mode & 0o777 == 0o600
    assert (directory/'login.svg').read_text().startswith('<?xml')
    assert (directory/'login.svg').stat().st_mode & 0o777 == 0o600
    store=Store(directory)
    try:assert store.meta('cursor')=='fixture-enrolled-cursor'
    finally:store.close()
    capsys.readouterr()


def test_failed_enrollment_restores_qr_handler_and_preserves_allowlist(tmp_path,monkeypatch):
    import qrcode
    import muse_pool_wechat.cli as cli
    env=tmp_path/'relay.env';body='ALLOWED_USER_IDS=existing-fixture-user\nWECHAT_MUSE_DATA_DIR='+str(tmp_path/'data')+'\n'
    env.write_text(body)
    original=qrcode.QRCode.print_ascii
    monkeypatch.setattr(cli,'enroll',lambda _:1)
    monkeypatch.setattr(cli,'legacy_running',lambda:False)
    assert cli.enroll_device(Settings.from_env(env),save_user=True)==1
    assert env.read_text()==body and qrcode.QRCode.print_ascii is original
