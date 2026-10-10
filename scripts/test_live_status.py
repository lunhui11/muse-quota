import importlib.util
import json
from pathlib import Path
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('live_status',Path(__file__).with_name('live_status.py'))
live=importlib.util.module_from_spec(spec);spec.loader.exec_module(live)


class LiveStatusTests(unittest.TestCase):
    def setUp(self):
        self.calls=[]
        self.data={
            '/healthz':{'status':'ready'},
            '/api/deployment':{'source_kind':'source_bundle','source_commit':'a'*40,
                               'runtime_files_complete':True,'service_root':'/srv/muse-quota','secret':'fixture-do-not-print'},
            '/api/pool':{'executor':{'enabled':False,'status':'disabled','task_id':None},
                         'tasks':[{'id':'000000000001','status':'completed','revision':1,'prompt':'fixture-private-prompt'}]},
            '/api/quotas':{'accounts':[{'id':'000000000001','status':'success','quota':{'weekly_used_pct':10},
                                        'job':None,'login_open':False,'pool_busy':False,'proxy_password':'fixture-private-proxy'}]},
        }
        test=self
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                test.calls.append(('GET',self.path))
                self.send_response(200 if self.path in test.data else 404);self.end_headers()
                self.wfile.write(json.dumps(test.data.get(self.path,{})).encode())
            def log_message(self,*args): pass
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.base='http://127.0.0.1:'+str(self.server.server_port)
        self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown)

    def test_readonly_snapshot_filters_private_data_and_recognizes_copy(self):
        report=live.inspect(self.base)
        self.assertEqual(report['pre_update']['status'],'idle_snapshot')
        self.assertFalse(report['pre_update']['backup_verified'])
        self.assertFalse(report['deployment']['git_pull_applicable'])
        self.assertNotIn('fixture-private',json.dumps(report))
        self.assertNotIn('do-not-print',json.dumps(report))
        self.assertTrue(all(method=='GET' for method,_ in self.calls))

    def test_disabled_switch_with_active_task_is_still_blocked(self):
        self.data['/api/pool']['tasks'][0]['status']='pause_requested'
        report=live.inspect(self.base)
        self.assertEqual(report['pre_update']['status'],'blocked')
        self.assertIn('active_task_000000000001',report['pre_update']['reasons'])

    def test_old_service_without_identity_cannot_claim_current_version(self):
        del self.data['/api/deployment']
        report=live.inspect(self.base)
        self.assertEqual(report['deployment']['status'],'pending')
        self.assertEqual(report['deployment']['reason'],'http_404')
        self.assertEqual(report['pre_update']['status'],'blocked')

    def test_busy_browser_and_review_task_block_update(self):
        self.data['/api/pool']['tasks'][0]['status']='needs_attention'
        self.data['/api/quotas']['accounts'][0]['job']='running'
        reasons=live.inspect(self.base)['pre_update']['reasons']
        self.assertIn('task_requires_review_000000000001',reasons)
        self.assertIn('account_profile_busy_000000000001',reasons)

    def test_off_loopback_target_is_rejected_before_requests(self):
        with self.assertRaises(SystemExit),patch('sys.stderr'):
            live.main(['--base-url','http://example.invalid'])
        self.assertEqual(self.calls,[])

    def test_unknown_task_state_cannot_authorize_update(self):
        self.data['/api/pool']['tasks'][0]['status']='future_worker_state'
        report=live.inspect(self.base)
        self.assertEqual(report['pre_update']['status'],'blocked')
        self.assertIn('unknown_task_state_000000000001',report['pre_update']['reasons'])

    def test_malformed_quota_returns_blocked_report_without_crashing(self):
        self.data['/api/quotas']['accounts'][0]['quota']='invalid'
        report=live.inspect(self.base)
        self.assertEqual(report['pre_update']['status'],'blocked')
        self.assertIn('quotas_invalid_account_quota',report['pre_update']['reasons'])


if __name__=='__main__':unittest.main()
