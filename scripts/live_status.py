#!/usr/bin/env python3
"""Read-only loopback service inspection. Never imports the app or opens secrets."""
import argparse
import ipaddress
import json
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener

ACTIVE = {'running', 'pause_requested', 'uploading', 'checkpoint_pending', 'finalizing'}
REVIEW = {'needs_attention', 'upload_failed', 'checkpoint_upload_failed', 'completion_upload_failed'}
IDLE = {'queued', 'ready', 'waiting_account', 'waiting_drive', 'completed', 'cancelled'}
DEPLOYMENT_FIELDS = ('service_root', 'process_cwd', 'process_id', 'source_kind', 'source_commit',
                     'runtime_modified', 'bundle_declared_commit', 'manifest_runtime_verified',
                     'runtime_files_complete', 'runtime_sha256', 'captured_at')


class InspectionError(Exception):
    pass


def fetch_json(base, path):
    # SSH forwards and local APIs stay local. Do not send private management
    # traffic through a general HTTP proxy or follow a redirect off loopback.
    from urllib.request import HTTPRedirectHandler
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        with opener.open(Request(base + path, method='GET'), timeout=10) as response:
            content = response.read(4 * 1024 * 1024 + 1)
            if len(content) > 4 * 1024 * 1024:
                raise InspectionError('response_too_large')
            result = json.loads(content)
            if not isinstance(result, dict):
                raise InspectionError('invalid_response')
            return result
    except HTTPError as exc:
        raise InspectionError('http_' + str(exc.code)) from None
    except (URLError, OSError, ValueError):
        raise InspectionError('unreachable_or_invalid_response') from None


def inspect(base):
    report = {'inspection': 'read_only', 'health': 'pending', 'deployment': {'status': 'pending'},
              'executor': {'status': 'pending'}, 'tasks': [], 'quotas': [],
              'pre_update': {'status': 'blocked', 'reasons': []}}
    reasons = report['pre_update']['reasons']
    try:
        health = fetch_json(base, '/healthz')
        report['health'] = health.get('status', 'pending')
        if report['health'] != 'ready': reasons.append('service_not_ready')
    except InspectionError as exc:
        reasons.append('health_' + str(exc))
    try:
        data = fetch_json(base, '/api/deployment')
        report['deployment'] = {k: data.get(k) for k in DEPLOYMENT_FIELDS}
        report['deployment']['status'] = 'observed'
        report['deployment']['git_pull_applicable'] = data.get('source_kind') == 'git_checkout'
        if data.get('runtime_files_complete') is not True: reasons.append('runtime_identity_incomplete')
    except InspectionError as exc:
        report['deployment']['reason'] = str(exc)
        reasons.append('deployment_identity_pending')
    try:
        pool = fetch_json(base, '/api/pool')
        executor = pool.get('executor')
        tasks = pool.get('tasks')
        if not isinstance(executor, dict) or not isinstance(tasks, list):
            raise InspectionError('invalid_pool_state')
        report['executor'] = {k: executor.get(k) for k in ('enabled', 'status', 'task_id', 'revision', 'step')}
        if executor.get('enabled') is not False: reasons.append('executor_not_confirmed_disabled')
        if executor.get('status') != 'disabled' or executor.get('task_id'):
            reasons.append('executor_not_confirmed_idle')
        for task in tasks:
            if not isinstance(task, dict): raise InspectionError('invalid_task_state')
            report['tasks'].append({k: task.get(k) for k in ('id', 'status', 'revision', 'account_id')})
            if task.get('status') in ACTIVE: reasons.append('active_task_' + str(task.get('id')))
            if task.get('status') in REVIEW: reasons.append('task_requires_review_' + str(task.get('id')))
            if task.get('status') not in ACTIVE | REVIEW | IDLE:
                reasons.append('unknown_task_state_' + str(task.get('id')))
    except InspectionError as exc:
        reasons.append('pool_' + str(exc))
    try:
        data = fetch_json(base, '/api/quotas')
        accounts = data.get('accounts')
        if not isinstance(accounts, list): raise InspectionError('invalid_quota_state')
        for account in accounts:
            if not isinstance(account, dict): raise InspectionError('invalid_account_state')
            quota = account.get('quota') or {}
            if not isinstance(quota, dict): raise InspectionError('invalid_account_quota')
            report['quotas'].append({
                'account_id': account.get('id'), 'status': account.get('status'),
                'weekly_used_pct': quota.get('weekly_used_pct'), 'stale': account.get('stale'),
                'checked_at': account.get('checked_at'), 'job': account.get('job'),
                'login_open': account.get('login_open'),
            })
            if account.get('job') or account.get('login_open') or account.get('pool_busy'):
                reasons.append('account_profile_busy_' + str(account.get('id')))
    except InspectionError as exc:
        reasons.append('quotas_' + str(exc))
    report['pre_update']['status'] = 'blocked' if reasons else 'idle_snapshot'
    # This is an observation, never an update authorization or a consistent backup.
    report['pre_update']['backup_verified'] = False
    return report


def unit_status(name):
    if not name or name.startswith('-') or not name.endswith('.service') or '/' in name:
        raise ValueError('Invalid unit name')
    if not shutil.which('systemctl'):
        return {'unit': name, 'status': 'pending', 'reason': 'systemctl_unavailable'}
    try:
        result = subprocess.run(['systemctl', 'show', name, '--property=LoadState,ActiveState,SubState,WorkingDirectory,ExecMainPID'],
                                capture_output=True, text=True, timeout=5)
        if result.returncode:
            return {'unit': name, 'status': 'pending', 'reason': 'systemd_unavailable_or_unit_unknown'}
        fields = dict(line.partition('=')[::2] for line in result.stdout.splitlines()
                      if line.partition('=')[0] in {'LoadState','ActiveState','SubState','WorkingDirectory','ExecMainPID'})
        if fields.get('LoadState') != 'loaded':
            return {'unit': name, 'status': 'pending', 'reason': 'unit_not_loaded'}
        fields.update(unit=name, status='observed')
        path = fields.get('WorkingDirectory')
        if path:
            fields['directory_has_git_metadata'] = (Path(path) / '.git').exists()
        return fields
    except (OSError, subprocess.TimeoutExpired):
        return {'unit': name, 'status': 'pending', 'reason': 'systemd_unreachable'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:8788')
    parser.add_argument('--service', action='append', default=[], help='Read metadata for an existing systemd unit')
    args = parser.parse_args(argv)
    url = urlsplit(args.base_url)
    try:
        local = url.hostname == 'localhost' or ipaddress.ip_address(url.hostname).is_loopback
    except (ValueError, TypeError): local = False
    if (not local or url.scheme != 'http' or url.username or url.password or url.query or url.fragment
            or url.path not in ('', '/')):
        parser.error('Use a loopback HTTP address, locally or through a verified SSH tunnel')
    try:
        report = inspect(args.base_url.rstrip('/'))
        report['service_units'] = [unit_status(name) for name in args.service]
    except ValueError:
        parser.error('Invalid service unit name')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['pre_update']['status'] == 'idle_snapshot' else 1


if __name__ == '__main__':
    sys.exit(main())
