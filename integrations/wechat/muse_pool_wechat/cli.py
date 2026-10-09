"""Foreground service, enrollment, read-only preflight and durable reply CLI."""
import argparse
import contextlib
import importlib.metadata
import io
import json
import logging
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import httpx
from wechat_muse_bridge.ilink.models import AuthExpired, ILinkError
from wechat_muse_bridge.main import enroll, load_credentials
from wechat_muse_bridge.state import BridgeState
from .config import Settings
from .pool import PoolClient, PoolError
from .relay import Relay
from .storage import Store
from .transport import ILinkTransport

log = logging.getLogger(__name__)


@contextlib.contextmanager
def instance_lock(directory):
    import fcntl
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    fd = os.open(directory / 'relay.lock', os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ValueError('Another relay or enrollment process is using this data directory') from exc
        yield
    finally:
        os.close(fd)


def legacy_running():
    if not Path('/run/systemd/system').is_dir() or not shutil.which('systemctl'):
        return False
    return subprocess.run(['systemctl', 'is-active', '--quiet', 'wechat-muse-bridge.service'],
                          capture_output=True, timeout=5, check=False).returncode == 0


def doctor(settings):
    checks = {
        'transport_version': importlib.metadata.version('wechat-muse-bridge'),
        'allowlist_configured': bool(settings.allowed),
        'credentials_present': (settings.directory / 'credentials.json').is_file(),
        'default_mode': settings.mode,
        'gadget_cli': 'optional' if settings.mode == 'task' else bool(shutil.which(settings.gadget[0])),
        'legacy_bridge_running': legacy_running(),
        'pool_api': False,
        'pool_idempotency': False,
        'drive_configured': False,
        'eligible_accounts': 0,
        'executor_enabled': False,
    }
    pool = PoolClient(settings.pool_url)
    try:
        state = pool.check()
        checks.update(pool_api=True, pool_idempotency=True,
                      drive_configured=bool(state.get('drive_configured')),
                      executor_enabled=bool(state.get('executor', {}).get('enabled')))
        accounts = pool.call('GET', 'quotas').get('accounts', [])
        checks['eligible_accounts'] = sum(a.get('eligible_for_new_requests') is True for a in accounts)
    except (httpx.HTTPError, PoolError):
        pass
    finally:
        pool.close()
    # Presence/configuration is reported separately from a real OAuth or Muse acceptance test.
    checks['ready_to_run'] = bool(checks['allowlist_configured'] and checks['credentials_present'] and
                                 checks['pool_api'] and checks['pool_idempotency'] and
                                 checks['gadget_cli'] and not checks['legacy_bridge_running'])
    return checks


def run(settings):
    if legacy_running():
        raise ValueError('Stop wechat-muse-bridge.service before starting the adapter')
    with instance_lock(settings.directory):
        pool = PoolClient(settings.pool_url)
        store = Store(settings.directory)
        ilink = None
        stop = threading.Event()
        try:
            pool.check()
            credentials = load_credentials(settings.directory / 'credentials.json')
            if credentials is None:
                raise ValueError('Run enroll before starting the relay')
            if settings.mode == 'chat' and not shutil.which(settings.gadget[0]):
                raise ValueError('Chat mode requires musegadget; use task mode for the browser account pool')
            if not store.meta('cursor') and (settings.directory / 'state.json').is_file():
                with store.db:
                    store.set_meta('cursor', BridgeState.load(settings.directory / 'state.json').cursor)
            interrupted=store.recover()
            ilink = ILinkTransport(credentials, float(os.environ.get('HTTP_TIMEOUT_SECONDS', '45')))
            relay = Relay(settings, store, pool, ilink)
            with store.db:
                for row in interrupted:
                    if row['user_id'] in settings.allowed:
                        relay.queue('gadget-error:'+row['ref'],row['user_id'],row['token'],'服务中断时 Muse 消息可能已经投递，请检查 Side Chat；不会自动重发。')
            def halt(*_):
                stop.set()
            for sig in (signal.SIGINT, signal.SIGTERM):
                signal.signal(sig, halt)
            log.info('event=relay_started; mode=%s', settings.mode)
            backoff = 1
            while not stop.is_set():
                try:
                    relay.once()
                    batch = ilink.get_updates(store.meta('cursor'), settings.poll_ms)
                    relay.ingest(batch.messages, batch.cursor)
                    backoff = 1
                except AuthExpired:
                    log.error('event=needs_login; polling_paused=true')
                    # Do not turn an expired login into an automatic restart/login storm.
                    stop.wait()
                except ILinkError:
                    log.warning('event=poll_failed; retry_seconds=%s', backoff)
                    stop.wait(backoff)
                    backoff = min(30, backoff * 2)
            log.info('event=relay_stopped')
        finally:
            if ilink:
                ilink.close()
            pool.close()
            store.close()


class EnrollmentOutput(io.TextIOBase):
    def __init__(self, target):
        self.target = target
        self.parts = []

    def write(self, value):
        self.parts.append(value)
        return self.target.write(value)

    def flush(self):
        self.target.flush()


def enroll_device(settings, save_user=False):
    if not settings.env_file:
        raise ValueError('Enrollment requires --env-file')
    if legacy_running():
        raise ValueError('Stop the old bridge before enrollment')
    with instance_lock(settings.directory):
        import qrcode
        from qrcode.image.svg import SvgPathImage
        original = qrcode.QRCode.print_ascii
        qr_path = settings.directory / 'login.svg'
        def display(qr, *args, **kwargs):
            with qr_path.open('wb') as output:
                qr.make_image(image_factory=SvgPathImage).save(output)
            os.chmod(qr_path, 0o600)
            print('QR image: ' + str(qr_path))
            return original(qr, *args, **kwargs)
        capture = EnrollmentOutput(sys.stdout)
        try:
            qrcode.QRCode.print_ascii = display
            with contextlib.redirect_stdout(capture):
                result = enroll(settings.env_file)
        finally:
            qrcode.QRCode.print_ascii = original
        if result != 0:
            return result
        match = re.search(r'^Enrolled from_user_id: (.+)$', ''.join(capture.parts), re.M)
        if save_user:
            if not match or not match[1].isprintable() or ',' in match[1] or match[1] != match[1].strip():
                raise ValueError('Enrollment did not return a valid single sender ID')
            lines = settings.env_file.read_text(encoding='utf-8').splitlines()
            lines = [line for line in lines if not re.match(r'^\s*ALLOWED_USER_IDS\s*=', line)]
            lines.append('ALLOWED_USER_IDS=' + match[1])
            temporary = settings.env_file.with_name(settings.env_file.name + '.tmp')
            fd = os.open(temporary, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as output:
                output.write('\n'.join(lines) + '\n')
            os.replace(temporary, settings.env_file)
        store = Store(settings.directory)
        try:
            with store.db:
                store.set_meta('cursor', BridgeState.load(settings.directory / 'state.json').cursor)
        finally:
            store.close()
        return 0


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(description='Reuse iLink transport to connect WeChat to muse-quota')
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('run', 'doctor', 'enroll', 'reply', 'outbox', 'retry'):
        p = sub.add_parser(name)
        p.add_argument('--env-file', required=True)
        if name == 'enroll':
            p.add_argument('--save-user', action='store_true', help='Save the exact enrolled sender as the sole allowlist entry')
        if name == 'reply':
            p.add_argument('--ref', required=True)
            p.add_argument('stdin', nargs='?', choices=['-'], default='-')
        if name == 'retry':
            p.add_argument('--event', required=True)
            p.add_argument('--confirm-not-delivered', action='store_true')
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
    logging.getLogger('httpx').setLevel(logging.WARNING)
    logging.getLogger('httpcore').setLevel(logging.WARNING)
    try:
        settings = Settings.from_env(args.env_file, require_allowlist=args.command not in ('enroll', 'doctor'))
        if args.command == 'enroll':
            return enroll_device(settings, args.save_user)
        if args.command == 'doctor':
            status = doctor(settings)
            print(json.dumps(status, ensure_ascii=False, indent=2))
            return 0 if status['ready_to_run'] else 1
        if args.command == 'run':
            run(settings)
            return 0
        store = Store(settings.directory)
        try:
            if args.command == 'reply':
                relay = Relay(settings, store, None, None)
                relay.reply(args.ref, sys.stdin.read(8001))
                print('Reply queued. Check the outbox for confirmed delivery.')
            elif args.command == 'outbox':
                rows = store.db.execute('SELECT event,status,next_chunk,error FROM outbox ORDER BY rowid DESC LIMIT 30').fetchall()
                print(json.dumps([dict(row) for row in rows], ensure_ascii=False, indent=2))
            else:
                if not args.confirm_not_delivered:
                    raise ValueError('Check WeChat first; retry requires --confirm-not-delivered')
                with store.db:
                    changed = store.db.execute("UPDATE outbox SET status='pending',error=NULL WHERE event=? AND status='uncertain'", (args.event,)).rowcount
                    if not changed:
                        raise ValueError('Only an uncertain delivery can be retried')
                print('Unconfirmed chunks queued for an explicitly acknowledged retry.')
        finally:
            store.close()
        return 0
    except (ValueError, OSError, RuntimeError, httpx.HTTPError, sqlite3.Error):
        # Never emit exception payloads or credential contents to the chat/journal.
        log.error('event=operation_failed; check=configuration_permissions_pool_or_login')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
