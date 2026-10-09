import os
import re
import shlex
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


def load_env(path):
    # Parse data; never source an environment file as shell code.
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        key, value = key.strip(), value.strip()
        if not sep or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key):
            raise ValueError('Invalid environment file')
        if key not in {'ALLOWED_USER_IDS','WECHAT_MUSE_DATA_DIR','TASK_POOL_BASE_URL','WECHAT_DEFAULT_MODE',
                       'MUSEGADGET_COMMAND','MAX_MESSAGE_CHARS','ILINK_API_BASE_URL','ILINK_POLL_TIMEOUT_MS',
                       'HTTP_TIMEOUT_SECONDS','DEBUG_PAYLOADS','LOG_LEVEL'}:
            raise ValueError('Unsupported relay configuration key')
        if len(value) > 1 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        os.environ[key] = value


@dataclass(frozen=True)
class Settings:
    directory: Path
    allowed: frozenset
    pool_url: str = 'http://127.0.0.1:8788'
    mode: str = 'task'
    gadget: tuple = ('musegadget',)
    env_file: Path | None = None
    poll_ms: int = 5000

    @classmethod
    def from_env(cls, env_file=None, require_allowlist=True):
        if env_file:
            load_env(env_file)
        allowed = frozenset(v.strip() for v in os.environ.get('ALLOWED_USER_IDS', '').split(',') if v.strip())
        if require_allowlist and not allowed:
            raise ValueError('ALLOWED_USER_IDS must contain the enrolled sender ID')
        if 'replace-with-your-wechat-user-id' in allowed:
            raise ValueError('Replace the allowlist placeholder with the enrolled sender ID')
        url = os.environ.get('TASK_POOL_BASE_URL', 'http://127.0.0.1:8788').rstrip('/')
        parsed = urlsplit(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('Invalid TASK_POOL_BASE_URL')
        mode = os.environ.get('WECHAT_DEFAULT_MODE', 'task')
        if mode not in ('task', 'chat'):
            raise ValueError('WECHAT_DEFAULT_MODE must be task or chat')
        poll = int(os.environ.get('ILINK_POLL_TIMEOUT_MS', '5000'))
        if not 1000 <= poll <= 60000:
            raise ValueError('ILINK_POLL_TIMEOUT_MS must be 1000–60000')
        command = tuple(shlex.split(os.environ.get('MUSEGADGET_COMMAND', 'musegadget')))
        if not command:
            raise ValueError('MUSEGADGET_COMMAND must not be empty')
        directory = Path(os.environ.get('WECHAT_MUSE_DATA_DIR', 'data/wechat')).resolve()
        return cls(directory, allowed, url, mode, command, Path(env_file).resolve() if env_file else None, poll)
