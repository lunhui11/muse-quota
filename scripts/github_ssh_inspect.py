#!/usr/bin/env python3
"""SSH from a GitHub-hosted runner; upload temporary read-only inspection code."""
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile

from github_server_inspect import validate

ROOT = Path(__file__).resolve().parents[1]
HOST = re.compile(r'[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\Z')
USER = re.compile(r'[A-Za-z_][A-Za-z0-9_-]{0,31}\Z')
DIRECTORY = re.compile(r'/[A-Za-z0-9_./-]+\Z')
FINGERPRINT = re.compile(r'SHA256:[A-Za-z0-9+/]{43}\Z')
REMOTE_TEMP = re.compile(r'/tmp/muse-quota-gh-inspect\.[A-Za-z0-9]{8}\Z')


class CheckFailed(Exception):
    pass


def config(environ):
    host = environ.get('MUSE_SSH_HOST', '')
    user = environ.get('MUSE_SSH_USER', '')
    port_text = environ.get('MUSE_SSH_PORT', '22')
    directory = environ.get('MUSE_DEPLOY_DIR', '')
    base = environ.get('MUSE_BASE_URL', 'http://127.0.0.1:8788')
    fingerprint = environ.get('MUSE_SSH_HOST_FINGERPRINT', '')
    key = environ.get('MUSE_SSH_PRIVATE_KEY', '')
    if (not HOST.fullmatch(host) or not USER.fullmatch(user) or user == 'root'
            or not port_text.isdecimal() or not 1 <= int(port_text) <= 65535
            or not DIRECTORY.fullmatch(directory) or '..' in Path(directory).parts
            or not validate(base, directory) or not FINGERPRINT.fullmatch(fingerprint)
            or not key.strip()):
        raise CheckFailed('missing_or_invalid_ssh_configuration')
    return {'host': host, 'user': user, 'port': str(int(port_text)), 'directory': directory,
            'base': base.rstrip('/'), 'fingerprint': fingerprint, 'key': key}


def classify(stderr):
    text = stderr.lower()
    for marker, code in [('connection refused', 'connection_refused'),
                         ('permission denied', 'ssh_authorization_failed'),
                         ('host key verification failed', 'host_key_check_failed'),
                         ('timed out', 'connection_timeout'),
                         ('could not resolve hostname', 'dns_failed')]:
        if marker in text:
            return code
    return 'ssh_or_command_failed'


def run(args, timeout=30, allow_failure=False):
    # The raw private key must not reach subprocess environments or command lines.
    env = dict(os.environ)
    env.pop('MUSE_SSH_PRIVATE_KEY', None)
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        raise CheckFailed('connection_or_command_timeout') from None
    except OSError:
        raise CheckFailed('ssh_tool_unavailable') from None
    if len(result.stdout) + len(result.stderr) > 512 * 1024:
        raise CheckFailed('command_output_too_large')
    if result.returncode and not allow_failure:
        raise CheckFailed(classify(result.stderr))
    return result


def verify_host(cfg, known_hosts):
    scan = run(['ssh-keyscan', '-T', '10', '-p', cfg['port'], '-t', 'ed25519', cfg['host']],
               timeout=20)
    if not scan.stdout.strip():
        raise CheckFailed('host_key_unavailable')
    known_hosts.write_text(scan.stdout)
    known_hosts.chmod(0o600)
    keys = run(['ssh-keygen', '-E', 'sha256', '-lf', str(known_hosts)])
    fingerprints = [line.split()[1] for line in keys.stdout.splitlines() if len(line.split()) >= 2]
    if not fingerprints or any(fp != cfg['fingerprint'] for fp in fingerprints):
        raise CheckFailed('host_fingerprint_mismatch')


def inspect_server(environ=None):
    result = {'mode': 'ssh_read_only', 'host_key_verified': False, 'ssh_authenticated': False,
              'deployment_performed': False, 'remote_temp_cleanup': 'not_needed'}
    exit_code = 1
    try:
        cfg = config(os.environ if environ is None else environ)
        with tempfile.TemporaryDirectory(prefix='muse-quota-ssh-') as private_dir:
            private_root = Path(private_dir)
            known = private_root / 'known_hosts'
            verify_host(cfg, known)
            result['host_key_verified'] = True
            key = private_root / 'identity'
            key.write_text(cfg['key'].replace('\r\n', '\n').strip() + '\n')
            key.chmod(0o600)
            try:
                run(['ssh-keygen', '-y', '-P', '', '-f', str(key)])
            except CheckFailed:
                raise CheckFailed('ssh_private_key_invalid_or_encrypted') from None
            options = ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
                       '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
                       '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=10',
                       '-o', 'ServerAliveCountMax=1', '-o', 'UserKnownHostsFile=' + str(known),
                       '-i', str(key)]
            destination = cfg['user'] + '@' + cfg['host']
            ssh = ['ssh', *options, '-T', '-p', cfg['port'], destination]
            identity = run([*ssh, 'id -un'])
            if identity.stdout.strip() != cfg['user']:
                raise CheckFailed('unexpected_remote_user')
            result['ssh_authenticated'] = True
            remote_temp = None
            try:
                created = run([*ssh, 'umask 077; mktemp -d /tmp/muse-quota-gh-inspect.XXXXXXXX'])
                candidate = created.stdout.strip()
                if not REMOTE_TEMP.fullmatch(candidate):
                    result['remote_temp_cleanup'] = 'pending'
                    raise CheckFailed('unexpected_inspection_temp_path')
                remote_temp = candidate
                run([*ssh, 'mkdir -- ' + shlex.quote(remote_temp + '/scripts')])
                scp = ['scp', *options, '-P', cfg['port']]
                run([*scp, str(ROOT / 'deployment.mjs'), destination + ':' + remote_temp + '/'])
                scripts = ['live_status.py', 'github_server_inspect.py']
                run([*scp, *[str(ROOT / 'scripts' / name) for name in scripts],
                     destination + ':' + remote_temp + '/scripts/'])
                sha = environ.get('GITHUB_SHA', '') if environ is not None else os.environ.get('GITHUB_SHA', '')
                if sha and not re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', sha):
                    raise CheckFailed('invalid_workflow_commit')
                command = shlex.join(['env', 'MUSE_BASE_URL=' + cfg['base'],
                                      'MUSE_DEPLOY_DIR=' + cfg['directory'], 'GITHUB_SHA=' + sha,
                                      'python3', remote_temp + '/scripts/github_server_inspect.py',
                                      '--service', 'muse-quota.service',
                                      '--service', 'muse-quota-desktop.service'])
                observed = run([*ssh, command], timeout=90, allow_failure=True)
                try:
                    summary = json.loads(observed.stdout)
                except ValueError:
                    raise CheckFailed('inspection_report_unavailable') from None
                if not isinstance(summary, dict) or summary.get('inspection') != 'read_only':
                    raise CheckFailed('invalid_inspection_report')
                # This response comes from our uploaded, reviewed summary script;
                # it deliberately excludes IDs, prompts, quotas and credentials.
                result['server_report'] = summary
                exit_code = 0 if observed.returncode == 0 else 1
            finally:
                if remote_temp:
                    try:
                        run([*ssh, 'rm -rf -- ' + shlex.quote(remote_temp)])
                        result['remote_temp_cleanup'] = 'completed'
                    except CheckFailed:
                        result['remote_temp_cleanup'] = 'pending'
                        result['inspection_temp_directory'] = remote_temp
                        exit_code = 1
    except CheckFailed as exc:
        result['reason'] = str(exc)
    return result, exit_code


def main():
    result, code = inspect_server()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return code


if __name__ == '__main__':
    sys.exit(main())
