#!/usr/bin/env python3
"""Read-only server inspection with a summary safe for public Actions logs."""
import argparse
from collections import Counter
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit

from live_status import ACTIVE, IDLE, REVIEW, inspect, unit_status

ROOT = Path(__file__).resolve().parents[1]
COMMIT = re.compile(r'(?:[a-f0-9]{40}|[a-f0-9]{64})\Z')
HASH = re.compile(r'[a-f0-9]{64}\Z')
KINDS = {'git_checkout', 'source_bundle', 'unversioned_copy'}
STATUSES = ACTIVE | IDLE | REVIEW


def boolean(value):
    return value if type(value) is bool else None


def digest(value, pattern=COMMIT):
    return value if isinstance(value, str) and pattern.fullmatch(value) else None


def source_summary(data):
    return {
        'kind': data.get('source_kind') if data.get('source_kind') in KINDS else 'pending',
        'commit': digest(data.get('source_commit')),
        'modified': boolean(data.get('runtime_modified')),
        'files_complete': boolean(data.get('runtime_files_complete')),
        'runtime_sha256': digest(data.get('runtime_sha256'), HASH),
    }


def disk_source(directory):
    # The helper fingerprints fixed source files only, not .env/data/work. These
    # are files on disk, distinct from the running process's startup snapshot.
    code = """import {pathToFileURL} from 'node:url';
const {inspectDeployment}=await import(pathToFileURL(process.argv[1]));
console.log(JSON.stringify(await inspectDeployment(process.argv[2])));"""
    try:
        result = subprocess.run(['node', '--input-type=module', '-e', code,
                                 str(ROOT / 'deployment.mjs'), str(directory)],
                                capture_output=True, text=True, timeout=15,
                                env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'})
        if result.returncode or len(result.stdout) > 65536:
            return source_summary({})
        data = json.loads(result.stdout)
        return source_summary(data if isinstance(data, dict) else {})
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return source_summary({})


def validate(base, directory):
    try:
        url = urlsplit(base)
        local = url.hostname == 'localhost' or ipaddress.ip_address(url.hostname).is_loopback
        if (not local or url.scheme != 'http' or url.username or url.password
                or url.query or url.fragment or url.path not in ('', '/')):
            return False
        return bool(directory and Path(directory).is_absolute() and Path(directory) != Path('/'))
    except (TypeError, ValueError):
        return False


def collect(base, directory, units):
    if not validate(base, directory):
        return {'inspection': 'read_only', 'configuration': 'invalid_loopback_or_deployment_selector'}, 1
    raw = inspect(base.rstrip('/'))
    executor = raw.get('executor', {})
    reasons = raw.get('pre_update', {}).get('reasons', [])
    counts = Counter(task['status'] if task.get('status') in STATUSES else 'unknown'
                     for task in raw.get('tasks', []))
    services = []
    for name in units:
        state = unit_status(name)
        try:
            matches = bool(state.get('WorkingDirectory')) and (
                Path(state['WorkingDirectory']).resolve() == Path(directory).resolve())
        except OSError:
            matches = False
        services.append({'unit': name, 'observed': state.get('status') == 'observed',
                         'active': state.get('ActiveState') == 'active',
                         'working_directory_matches': matches})
    report = {
        'inspection': 'read_only',
        'health': 'ready' if raw.get('health') == 'ready' else 'pending',
        'executor': {'enabled': boolean(executor.get('enabled')),
                     'status': executor.get('status') if executor.get('status') in
                     {'disabled', 'idle', 'running', 'stopping'} else 'pending',
                     'has_task': bool(executor.get('task_id'))},
        'task_counts': dict(counts),
        'account_count': len(raw.get('quotas', [])),
        'busy_account_count': sum(r.startswith('account_profile_busy_') for r in reasons),
        'running_process_source': source_summary(raw.get('deployment', {})),
        'on_disk_source': disk_source(directory),
        'workflow_commit': digest(os.environ.get('GITHUB_SHA')),
        'service_states': services,
        'backup_verified': False,
        'update_authorized': False,
    }
    # Emit only known reason classes, never IDs, exception text, paths or values
    # from the service. No account IDs, quotas, task prompts or raw JSON in logs.
    reason_classes = {
        'service_not_ready', 'runtime_identity_incomplete', 'deployment_identity_pending',
        'executor_not_confirmed_disabled', 'executor_not_confirmed_idle',
    }
    classified = set()
    for reason in reasons:
        if reason in reason_classes:
            classified.add(reason)
        elif reason.startswith(('active_task_', 'task_requires_review_', 'unknown_task_state_')):
            classified.add('tasks_require_review')
        elif reason.startswith('account_profile_busy_'):
            classified.add('account_profile_busy')
        else:
            classified.add('api_check_pending')
    report['pending_or_blocked_checks'] = sorted(classified)
    api_confirmed = not any(r.startswith(('pool_', 'quotas_', 'health_')) for r in reasons)
    safe_idle = (report['health'] == 'ready' and report['executor']['enabled'] is False
                 and report['executor']['status'] == 'disabled' and not report['executor']['has_task']
                 and not any(status not in {'completed', 'cancelled'} for status in counts)
                 and not any(r.startswith('account_profile_busy_') for r in reasons)
                 and api_confirmed and bool(services)
                 and all(s['observed'] and s['active'] and s['working_directory_matches'] for s in services))
    report['idle_service_checks_passed'] = safe_idle
    # An older API's missing version endpoint stays pending but does not obscure
    # successful runner delivery of a read-only service check. Never authorize updates.
    return report, 0 if safe_idle else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--service', action='append', default=[])
    args = parser.parse_args(argv)
    try:
        report, code = collect(os.environ.get('MUSE_BASE_URL', 'http://127.0.0.1:8788'),
                               os.environ.get('MUSE_DEPLOY_DIR', ''), args.service)
    except (ValueError, TypeError, KeyError):
        report, code = {'inspection': 'read_only', 'status': 'invalid_response_or_unit_selector'}, 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return code


if __name__ == '__main__':
    sys.exit(main())
