#!/usr/bin/env python3
"""Prepare GitHub SSH inspection settings; never upload keys or run server tasks."""
import argparse
import json
import os
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from github_ssh_inspect import CheckFailed, config as validate_ssh

ENVIRONMENT = 'server-maintenance'
KEY_NAMES = ('MUSE_SSH_PRIVATE_KEY', 'SSH_PRIVATE_KEY', 'SSH_KEY')
VARIABLES = ('MUSE_SSH_HOST', 'MUSE_SSH_PORT', 'MUSE_SSH_USER', 'MUSE_DEPLOY_DIR',
             'MUSE_SSH_HOST_FINGERPRINT', 'MUSE_BASE_URL')


class Failed(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class API:
    def __init__(self):
        self.opener = build_opener(NoRedirect())
        self.token = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN')

    def call(self, method, path, body=None, missing=False):
        headers = {'Accept': 'application/vnd.github+json',
                   'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'muse-quota-maintenance'}
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        data = None if body is None else json.dumps(body).encode()
        if data is not None:
            headers['Content-Type'] = 'application/json'
        request = Request('https://api.github.com' + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=20) as response:
                content = response.read(1024 * 1024 + 1)
                if len(content) > 1024 * 1024:
                    raise Failed('github_response_too_large')
                return json.loads(content) if content else {}
        except HTTPError as exc:
            if missing and exc.code == 404:
                return None
            # Do not print request headers, body, URLs from errors, or raw responses.
            raise Failed('github_http_' + str(exc.code)) from None
        except (URLError, OSError, ValueError):
            # A failed write may have reached GitHub. Read state before any retry.
            raise Failed('github_network_or_response_pending') from None


def entries(api, path, key):
    result = []
    for page in range(1, 101):
        response = api.call('GET', path + '?per_page=100&page=' + str(page))
        values = response.get(key) if isinstance(response, dict) else None
        if not isinstance(values, list):
            raise Failed('github_metadata_invalid')
        result.extend(values)
        if len(values) < 100:
            return result
    raise Failed('github_metadata_pagination_pending')


def selectors(settings):
    repo = settings.get('repository')
    if not isinstance(repo, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
        raise Failed('invalid_repository')
    values = {name: settings.get(name, '') for name in VARIABLES}
    values['MUSE_SSH_PORT'] = values['MUSE_SSH_PORT'] or '22'
    values['MUSE_BASE_URL'] = values['MUSE_BASE_URL'] or 'http://127.0.0.1:8788'
    if any(not isinstance(value, str) for value in values.values()):
        raise Failed('invalid_ssh_selectors')
    try:
        validate_ssh({**values, 'MUSE_SSH_PRIVATE_KEY': 'validation-only'})
    except CheckFailed:
        raise Failed('invalid_ssh_selectors') from None
    return repo, values


def prepare(api, settings, apply=False):
    repo, values = selectors(settings)
    root = '/repos/' + repo
    metadata = api.call('GET', root)
    if not isinstance(metadata, dict) or metadata.get('permissions', {}).get('admin') is not True:
        raise Failed('github_repository_admin_access_required')
    env_path = root + '/environments/' + ENVIRONMENT
    environment = api.call('GET', env_path, missing=True)
    report = {'repository': repo, 'environment': ENVIRONMENT, 'mode': 'apply' if apply else 'check',
              'server_touched': False, 'workflow_dispatched': False, 'secret_values_read': False,
              'actions_url': 'https://github.com/' + repo + '/actions', 'pending': []}
    if environment is None:
        if not apply:
            report['pending'].append('environment_missing')
            report['configuration_complete'] = False
            return report
        # Only create a new environment. Never replace an existing environment's protections.
        owner = metadata.get('owner', {})
        if owner.get('type') != 'User' or type(owner.get('id')) is not int:
            raise Failed('environment_reviewer_requires_configuration')
        api.call('PUT', env_path, {
            'deployment_branch_policy': {'protected_branches': False, 'custom_branch_policies': True},
            'reviewers': [{'type': 'User', 'id': owner['id']}], 'prevent_self_review': False})
        environment = api.call('GET', env_path)
    policy = environment.get('deployment_branch_policy') if isinstance(environment, dict) else None
    if not isinstance(policy, dict) or policy.get('custom_branch_policies') is not True:
        raise Failed('existing_environment_branch_policy_requires_review')
    protections = environment.get('protection_rules', [])
    if not any(rule.get('type') == 'required_reviewers' and rule.get('reviewers') for rule in protections):
        report['pending'].append('environment_approval_required')
    branches = entries(api, env_path + '/deployment-branch-policies', 'branch_policies')
    # An existing broader allowlist needs review rather than destructive deletion.
    if any(branch.get('name') != 'main' or branch.get('type', 'branch') != 'branch' for branch in branches):
        raise Failed('existing_environment_allows_other_refs_requires_review')
    if not branches:
        if apply:
            api.call('POST', env_path + '/deployment-branch-policies', {'name': 'main', 'type': 'branch'})
        else:
            report['pending'].append('main_branch_rule_missing')
    actual = {item['name']: item.get('value') for item in entries(api, env_path + '/variables', 'variables')}
    for name, value in values.items():
        if actual.get(name) == value:
            continue
        if apply:
            method = 'PATCH' if name in actual else 'POST'
            path = env_path + '/variables' + ('/' + name if name in actual else '')
            api.call(method, path, {'name': name, 'value': value})
        else:
            report['pending'].append('variable_missing_or_different:' + name)
    # List names only: GitHub never returns saved private key contents.
    names = {item.get('name') for path in (env_path + '/secrets', root + '/actions/secrets')
             for item in entries(api, path, 'secrets')}
    report['ssh_secret_name'] = next((name for name in KEY_NAMES if name in names), None)
    if report['ssh_secret_name'] is None:
        report['pending'].append('ssh_private_key_secret_missing')
    if apply:
        verified = prepare(api, settings, apply=False)
        report['pending'] = verified['pending']
        report['ssh_secret_name'] = verified.get('ssh_secret_name')
    report['configuration_complete'] = not report['pending']
    report['ssh_connection_verified'] = False
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, help='Local JSON with repository and non-secret selectors')
    parser.add_argument('--apply', action='store_true', help='Create missing environment and update its variables')
    args = parser.parse_args(argv)
    try:
        settings = json.loads(Path(args.config).read_text())
        if not isinstance(settings, dict):
            raise Failed('invalid_local_configuration')
        report = prepare(API(), settings, args.apply)
        code = 0 if report['configuration_complete'] else 1
    except (Failed, OSError, ValueError) as exc:
        reason = str(exc) if isinstance(exc, Failed) else 'local_configuration_unavailable'
        report, code = {'status': 'pending', 'reason': reason, 'server_touched': False}, 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return code


if __name__ == '__main__':
    sys.exit(main())
