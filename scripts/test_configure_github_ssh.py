import copy
import io
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

import configure_github_ssh as setup


class FakeAPI:
    def __init__(self):
        self.calls = []
        self.environment = None
        self.branches = []
        self.variables = {}
        self.secret_names = ['SSH_KEY']

    def call(self, method, path, body=None, missing=False):
        self.calls.append((method, path, body))
        if path == '/repos/owner/repo':
            return {'permissions': {'admin': True}, 'owner': {'type': 'User', 'id': 42}}
        if path.endswith('/environments/server-maintenance'):
            if method == 'PUT':
                self.environment = {'deployment_branch_policy': body['deployment_branch_policy'],
                                    'protection_rules': [{'type': 'required_reviewers',
                                                          'reviewers': body['reviewers']}]}
            return copy.deepcopy(self.environment)
        if '/deployment-branch-policies' in path:
            if method == 'POST':
                self.branches.append(body)
                return {}
            return {'branch_policies': copy.deepcopy(self.branches)}
        if '/variables' in path:
            if method in {'POST', 'PATCH'}:
                self.variables[body['name']] = body['value']
                return {}
            return {'variables': [{'name': key, 'value': value} for key, value in self.variables.items()]}
        if '/secrets' in path:
            return {'secrets': [{'name': name} for name in self.secret_names]}
        raise AssertionError((method, path))


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.api = FakeAPI()
        self.settings = {'repository': 'owner/repo', 'MUSE_SSH_HOST': 'fixture.invalid',
                         'MUSE_SSH_USER': 'ubuntu', 'MUSE_DEPLOY_DIR': '/srv/muse-quota',
                         'MUSE_SSH_HOST_FINGERPRINT': 'SHA256:' + 'A' * 43}

    def test_check_never_writes_or_connects(self):
        result = setup.prepare(self.api, self.settings)
        self.assertEqual(result['pending'], ['environment_missing'])
        self.assertFalse(result['server_touched'])
        self.assertFalse(result['configuration_complete'])
        self.assertTrue(all(call[0] == 'GET' for call in self.api.calls))

    def test_apply_creates_review_gate_main_only_and_rechecks(self):
        result = setup.prepare(self.api, self.settings, apply=True)
        self.assertTrue(result['configuration_complete'])
        self.assertFalse(result['ssh_connection_verified'])
        self.assertEqual(result['ssh_secret_name'], 'SSH_KEY')
        self.assertEqual(self.api.branches, [{'name': 'main', 'type': 'branch'}])
        self.assertEqual(set(self.api.variables), set(setup.VARIABLES))
        writes = [call for call in self.api.calls if call[0] != 'GET']
        self.assertFalse(any('/secrets' in path or '/dispatches' in path for _, path, _ in writes))
        self.api.calls.clear()
        setup.prepare(self.api, self.settings, apply=True)
        self.assertTrue(all(call[0] == 'GET' for call in self.api.calls))

    def test_missing_key_remains_pending_without_generating_or_uploading_one(self):
        self.api.secret_names = []
        result = setup.prepare(self.api, self.settings, apply=True)
        self.assertFalse(result['configuration_complete'])
        self.assertIn('ssh_private_key_secret_missing', result['pending'])

    def test_existing_broad_policy_is_not_replaced(self):
        self.api.environment = {'deployment_branch_policy': {'custom_branch_policies': False}}
        with self.assertRaisesRegex(setup.Failed, 'requires_review'):
            setup.prepare(self.api, self.settings, apply=True)
        self.assertTrue(all(call[0] == 'GET' for call in self.api.calls))

    def test_other_branch_rules_are_never_deleted(self):
        setup.prepare(self.api, self.settings, apply=True)
        self.api.branches.append({'name': '*', 'type': 'branch'})
        self.api.calls.clear()
        with self.assertRaisesRegex(setup.Failed, 'allows_other_refs'):
            setup.prepare(self.api, self.settings, apply=True)
        self.assertTrue(all(call[0] == 'GET' for call in self.api.calls))

    def test_existing_review_requirement_is_preserved(self):
        setup.prepare(self.api, self.settings, apply=True)
        self.api.environment['protection_rules'] = []
        self.api.calls.clear()
        result = setup.prepare(self.api, self.settings, apply=True)
        self.assertIn('environment_approval_required', result['pending'])
        self.assertTrue(all(call[0] == 'GET' for call in self.api.calls))

    def test_invalid_selectors_fail_before_api(self):
        for field, value in [('repository', 'owner/repo/../../'), ('MUSE_SSH_HOST', 'host;id'),
                             ('MUSE_SSH_USER', 'root'), ('MUSE_DEPLOY_DIR', '/srv/../etc'),
                             ('MUSE_BASE_URL', 'https://outside.invalid')]:
            with self.subTest(field=field), self.assertRaises(setup.Failed):
                setup.prepare(self.api, {**self.settings, field: value}, apply=True)
        self.assertEqual(self.api.calls, [])

    def test_api_errors_do_not_expose_token_or_raw_error(self):
        with patch.dict('os.environ', {'GH_TOKEN': 'private-fixture-token'}):
            api = setup.API()
        for error in (HTTPError('fixture', 403, 'private-fixture-token', {}, io.BytesIO(b'private')),
                      URLError('private-fixture-token')):
            with patch.object(api.opener, 'open', side_effect=error), self.assertRaises(setup.Failed) as caught:
                api.call('GET', '/repos/owner/repo')
            self.assertNotIn('private', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
