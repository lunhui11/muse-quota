import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
spec = importlib.util.spec_from_file_location('github_inspection', Path(__file__).with_name('github_server_inspect.py'))
github = importlib.util.module_from_spec(spec)
spec.loader.exec_module(github)


class GitHubInspectionTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.directory = '/srv/muse-quota-fixture'
        self.data = {
            '/healthz': {'status': 'ready'},
            '/api/pool': {'executor': {'enabled': False, 'status': 'disabled', 'task_id': None,
                                      'last_error': 'fixture-private-secret'},
                          'tasks': [{'id': 'fixture-private-task', 'status': 'completed',
                                     'prompt': 'fixture-private-prompt'}]},
            '/api/quotas': {'accounts': [{'id': 'fixture-private-account', 'job': None,
                                         'login_open': False, 'pool_busy': False,
                                         'quota': {'weekly_used_pct': 78.124},
                                         'proxy_password': 'fixture-private-password'}]},
        }
        test = self
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                test.calls.append(('GET', self.path))
                self.send_response(200 if self.path in test.data else 404)
                self.end_headers()
                self.wfile.write(json.dumps(test.data.get(self.path, {})).encode())
            def log_message(self, *args): pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = 'http://127.0.0.1:' + str(self.server.server_port)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        state = {'status': 'observed', 'ActiveState': 'active', 'WorkingDirectory': self.directory}
        self.unit = patch.object(github, 'unit_status', return_value=state).start()
        self.disk = patch.object(github, 'disk_source', return_value=github.source_summary({})).start()
        self.addCleanup(patch.stopall)

    def collect(self):
        return github.collect(self.base, self.directory, ['muse-quota.service'])

    def test_old_api_still_demonstrates_runner_readonly_checks_without_leaking_data(self):
        report, code = self.collect()
        self.assertEqual(code, 0)
        self.assertIn('deployment_identity_pending', report['pending_or_blocked_checks'])
        self.assertFalse(report['update_authorized'])
        self.assertFalse(report['backup_verified'])
        output = json.dumps(report)
        self.assertNotIn('fixture-private', output)
        self.assertNotIn('weekly_used_pct', output)
        self.assertNotIn('78.124', output)
        self.assertNotIn(self.directory, output)
        self.assertEqual(report['task_counts'], {'completed': 1})
        self.assertEqual(len(self.calls), 4)
        self.assertTrue(all(method == 'GET' for method, _ in self.calls))

    def test_idle_but_enabled_does_not_pass(self):
        self.data['/api/pool']['executor'].update(enabled=True, status='idle')
        report, code = self.collect()
        self.assertEqual(code, 1)
        self.assertFalse(report['idle_service_checks_passed'])

    def test_profile_ownership_alone_counts_as_busy(self):
        self.data['/api/quotas']['accounts'][0]['pool_busy'] = True
        report, code = self.collect()
        self.assertEqual(code, 1)
        self.assertEqual(report['busy_account_count'], 1)
        self.assertIn('account_profile_busy', report['pending_or_blocked_checks'])

    def test_unknown_task_and_wrong_service_directory_do_not_pass(self):
        self.data['/api/pool']['tasks'][0]['status'] = 'fixture-private-unknown-status'
        self.unit.return_value['WorkingDirectory'] = '/srv/different-fixture'
        report, code = self.collect()
        self.assertEqual(code, 1)
        self.assertIn('tasks_require_review', report['pending_or_blocked_checks'])
        self.assertFalse(report['service_states'][0]['working_directory_matches'])
        self.assertNotIn('fixture-private', json.dumps(report))

    def test_missing_pool_is_pending_without_printing_response(self):
        del self.data['/api/pool']
        report, code = self.collect()
        self.assertEqual(code, 1)
        self.assertIn('api_check_pending', report['pending_or_blocked_checks'])

    def test_remote_url_and_missing_selector_rejected_before_network(self):
        for base, directory in [('http://example.invalid', self.directory),
                                (self.base, ''), (self.base, '/')]:
            report, code = github.collect(base, directory, [])
            self.assertEqual(code, 1)
        self.assertEqual(self.calls, [])

    def test_workflow_sha_and_api_version_fields_are_sanitized(self):
        self.data['/api/deployment'] = {
            'runtime_files_complete': True, 'source_kind': 'fixture-private-kind',
            'source_commit': 'fixture-private-token', 'runtime_sha256': 'fixture-private-token',
            'service_root': 'fixture-private-path',
        }
        with patch.dict('os.environ', {'GITHUB_SHA': 'fixture-private-token'}):
            report, code = self.collect()
        self.assertEqual(code, 0)
        self.assertIsNone(report['workflow_commit'])
        self.assertIsNone(report['running_process_source']['commit'])
        self.assertNotIn('fixture-private', json.dumps(report))

    def test_main_does_not_echo_invalid_config_or_exception_text(self):
        with patch.dict('os.environ', {'MUSE_BASE_URL': 'http://fixture-private-secret@example.invalid',
                                      'MUSE_DEPLOY_DIR': self.directory}), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(github.main(['--service', 'muse-quota.service']), 1)
        self.assertNotIn('fixture-private', output.getvalue())
        self.assertEqual(self.calls, [])


class DiskSourceTests(unittest.TestCase):
    def test_actual_node_helper_is_invoked_and_returns_only_fixed_identity_fields(self):
        result = github.disk_source(github.ROOT)
        self.assertEqual(result['kind'], 'git_checkout')
        self.assertRegex(result['commit'], r'^[a-f0-9]{40}$')
        self.assertRegex(result['runtime_sha256'], r'^[a-f0-9]{64}$')
        self.assertNotIn('service_root', result)
        self.assertNotIn('process_cwd', result)


if __name__ == '__main__':
    unittest.main()
