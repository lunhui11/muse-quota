import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
spec = importlib.util.spec_from_file_location('github_ssh', Path(__file__).with_name('github_ssh_inspect.py'))
ssh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ssh)


class GitHubSSHTests(unittest.TestCase):
    def setUp(self):
        self.env = {'MUSE_SSH_HOST': 'server.example.invalid', 'MUSE_SSH_USER': 'ubuntu',
                    'MUSE_SSH_PORT': '22', 'MUSE_DEPLOY_DIR': '/srv/muse-quota-fixture',
                    'MUSE_SSH_HOST_FINGERPRINT': 'SHA256:' + 'A' * 43,
                    'MUSE_SSH_PRIVATE_KEY': 'fixture-private-key', 'GITHUB_SHA': 'b' * 40}
        self.calls = []
        self.fingerprint = self.env['MUSE_SSH_HOST_FINGERPRINT']
        self.temp = '/tmp/muse-quota-gh-inspect.ABCD1234'
        self.cleanup_fails = False

    def fake_run(self, args, **kwargs):
        self.calls.append(args)
        stdout = ''
        if args[0] == 'ssh-keyscan':
            stdout = 'fixture-public-host-key\n'
        elif args[0] == 'ssh-keygen' and '-lf' in args:
            stdout = '256 ' + self.fingerprint + ' fixture (ED25519)\n'
        elif args[0] == 'ssh':
            command = args[-1]
            if command == 'id -un': stdout = 'ubuntu\n'
            elif 'mktemp -d' in command: stdout = self.temp + '\n'
            elif 'python3' in command:
                stdout = json.dumps({'inspection': 'read_only', 'executor': {'enabled': False},
                                     'task_counts': {'completed': 2}, 'update_authorized': False})
            elif command.startswith('rm -rf') and self.cleanup_fails:
                raise ssh.CheckFailed('connection_timeout')
        return subprocess.CompletedProcess(args, 0, stdout, '')

    def test_verified_ssh_uploads_only_inspection_source_and_cleans_its_temp(self):
        with patch.object(ssh, 'run', side_effect=self.fake_run):
            report, code = ssh.inspect_server(self.env)
        self.assertEqual(code, 0)
        self.assertTrue(report['host_key_verified'])
        self.assertTrue(report['ssh_authenticated'])
        self.assertFalse(report['deployment_performed'])
        self.assertEqual(report['remote_temp_cleanup'], 'completed')
        self.assertNotIn('fixture-private-key', json.dumps(report))
        for call in self.calls:
            self.assertNotIn('fixture-private-key', ' '.join(call))
        commands = [call for call in self.calls if call[0] == 'ssh']
        self.assertTrue(all('StrictHostKeyChecking=yes' in call for call in commands))
        self.assertEqual(commands[-1][-1], 'rm -rf -- ' + self.temp)
        uploaded = [call for call in self.calls if call[0] == 'scp']
        self.assertEqual(len(uploaded), 2)
        self.assertTrue(all('.env' not in item and '/data/' not in item for call in uploaded for item in call))

    def test_fingerprint_mismatch_stops_before_key_authentication_or_remote_commands(self):
        self.fingerprint = 'SHA256:' + 'B' * 43
        with patch.object(ssh, 'run', side_effect=self.fake_run):
            report, code = ssh.inspect_server(self.env)
        self.assertEqual(code, 1)
        self.assertEqual(report['reason'], 'host_fingerprint_mismatch')
        self.assertFalse(report['ssh_authenticated'])
        self.assertFalse(any(call[0] in {'ssh', 'scp'} for call in self.calls))
        self.assertFalse(any(call[0] == 'ssh-keygen' and '-y' in call for call in self.calls))

    def test_missing_secret_or_shell_injection_is_rejected_before_network(self):
        for field, value in [('MUSE_SSH_PRIVATE_KEY', ''), ('MUSE_SSH_HOST', 'server;id'),
                             ('MUSE_SSH_USER', 'ubuntu;id'), ('MUSE_SSH_USER', 'root'),
                             ('MUSE_SSH_PORT', '22;id'), ('MUSE_DEPLOY_DIR', '/srv/test;id'),
                             ('MUSE_DEPLOY_DIR', '/srv/../etc'),
                             ('MUSE_BASE_URL', 'http://example.invalid')]:
            with patch.object(ssh, 'run', side_effect=self.fake_run):
                report, code = ssh.inspect_server({**self.env, field: value})
            self.assertEqual(code, 1)
            self.assertEqual(report['reason'], 'missing_or_invalid_ssh_configuration')
        self.assertEqual(self.calls, [])

    def test_unexpected_temp_path_is_never_removed(self):
        self.temp = '/home/ubuntu/muse-quota'
        with patch.object(ssh, 'run', side_effect=self.fake_run):
            report, code = ssh.inspect_server(self.env)
        self.assertEqual(code, 1)
        self.assertEqual(report['remote_temp_cleanup'], 'pending')
        self.assertFalse(any(call[0] == 'scp' or call[-1].startswith('rm -rf') for call in self.calls))

    def test_cleanup_failure_is_pending_and_not_reported_as_success(self):
        self.cleanup_fails = True
        with patch.object(ssh, 'run', side_effect=self.fake_run):
            report, code = ssh.inspect_server(self.env)
        self.assertEqual(code, 1)
        self.assertEqual(report['remote_temp_cleanup'], 'pending')
        self.assertEqual(report['inspection_temp_directory'], self.temp)

    def test_raw_secret_is_not_in_subprocess_environment_or_error_report(self):
        command = subprocess.CompletedProcess([], 255, '', 'Permission denied fixture-private-secret')
        with patch.dict('os.environ', {'MUSE_SSH_PRIVATE_KEY': 'fixture-private-key'}), \
                patch.object(ssh.subprocess, 'run', return_value=command) as execute:
            with self.assertRaises(ssh.CheckFailed) as caught:
                ssh.run(['ssh', 'fixture'])
        self.assertEqual(str(caught.exception), 'ssh_authorization_failed')
        self.assertNotIn('MUSE_SSH_PRIVATE_KEY', execute.call_args.kwargs['env'])

    def test_copy_failure_still_cleans_only_its_new_temp(self):
        def fail_copy(args, **kwargs):
            if args[0] == 'scp':
                self.calls.append(args)
                raise ssh.CheckFailed('ssh_or_command_failed')
            return self.fake_run(args, **kwargs)
        with patch.object(ssh, 'run', side_effect=fail_copy):
            report, code = ssh.inspect_server(self.env)
        self.assertEqual(code, 1)
        self.assertEqual(report['remote_temp_cleanup'], 'completed')
        self.assertEqual(self.calls[-1][-1], 'rm -rf -- ' + self.temp)


if __name__ == '__main__':
    unittest.main()
