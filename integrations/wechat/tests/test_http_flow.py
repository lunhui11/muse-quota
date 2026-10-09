import json
from pathlib import Path
import select
import shutil
import subprocess
import time
import httpx
import pytest
from muse_pool_wechat.config import Settings
from muse_pool_wechat.storage import Store
from muse_pool_wechat.pool import PoolClient
from muse_pool_wechat.relay import Relay
from test_relay import ILinkFixture, message


@pytest.fixture
def real_pool():
    root = Path(__file__).resolve().parents[3]
    if not shutil.which('node') or not (root / 'node_modules/playwright/package.json').is_file():
        pytest.skip('Real Node API check needs Node >=20.12 and npm ci in the project root')
    process = subprocess.Popen(['node', str(Path(__file__).with_name('pool-server.mjs'))], cwd=root,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        if not select.select([process.stdout], [], [], 15)[0]:
            pytest.fail('Node fixture failed to start within 15 seconds')
        line = process.stdout.readline()
        if not line:
            pytest.fail('Node fixture failed: ' + process.stderr.read()[:1500])
        base = json.loads(line)['base']
        yield base
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill();process.wait()
        process.stdout.close();process.stderr.close()


def test_real_http_wechat_task_handoff_result_and_replay(real_pool, tmp_path):
    store=Store(tmp_path)
    pool=PoolClient(real_pool)
    ilink=ILinkFixture()
    relay=Relay(Settings(tmp_path,frozenset({'alice'}),pool_url=real_pool),store,pool,ilink)
    try:
        state=pool.check()
        assert state['capabilities']['task_request_id'] is True
        relay.ingest([message(text='新任务：分两步完成报告')], 'cursor1')
        relay.process_one();relay.flush_one()
        task_id=store.db.execute('SELECT task_id FROM tasks').fetchone()[0]
        assert task_id in ilink.sends[0][2]
        # An explicit user command enables execution; adding a task never silently unpauses it.
        relay.ingest([message('2',text='开始执行')], 'cursor2');relay.process_one()
        deadline=time.monotonic()+8
        task=None
        while time.monotonic()<deadline:
            task=pool.task(task_id)
            if task['status']=='completed':break
            time.sleep(.02)
        assert task['status']=='completed'
        assert task['revision']==2
        assert len(task['history'])==2
        assert [f['name'] for f in task['checkpoint']['artifacts']]==['first.md','second.md']
        relay.poll_tasks();relay.poll_tasks()
        while relay.flush_one():pass
        finals=[s for s in ilink.sends if '报告最终完成' in s[2]]
        assert len(finals)==1 and finals[0][:2]==('alice','fixture-context-alice')
        assert 'drive.google.com' in finals[0][2]
        relay.ingest([message(text='新任务：分两步完成报告')], 'cursor3');relay.process_one()
        assert len(pool.check()['tasks'])==1
        # Simulate loss of the client journal, while preserving the same WeChat message identity.
        with store.db:
            store.db.execute('DELETE FROM inbox')
        relay.ingest([message(text='新任务：分两步完成报告')], 'cursor4');relay.process_one()
        assert len(pool.check()['tasks'])==1
        assert store.db.execute('SELECT COUNT(*) FROM tasks').fetchone()[0]==1
        assert pool.task(task_id)['status']=='completed'
    finally:
        store.close();pool.close()


def test_real_http_idempotency_conflict_and_task_lookup(real_pool):
    with httpx.Client(base_url=real_pool,trust_env=False) as client:
        payload={'prompt':'同一微信任务','request_id':'wechat:http-fixture'}
        first=client.post('/api/pool/tasks',json=payload)
        repeated=client.post('/api/pool/tasks',json=payload)
        assert first.status_code==repeated.status_code==201
        assert first.json()['id']==repeated.json()['id']
        assert client.post('/api/pool/tasks',json={**payload,'prompt':'错误复用'}).status_code==409
        assert client.get('/api/pool/tasks/'+first.json()['id']).json()['request_id']==payload['request_id']
        assert client.get('/api/pool/tasks/000000000000').status_code==404


def test_doctor_reports_real_api_but_does_not_claim_login(real_pool,tmp_path,monkeypatch):
    import muse_pool_wechat.cli as cli
    monkeypatch.setattr(cli,'legacy_running',lambda:False)
    settings=Settings(tmp_path,frozenset({'fixture-alice'}),pool_url=real_pool)
    first=cli.doctor(settings)
    assert first['pool_api'] and first['pool_idempotency']
    assert first['gadget_cli']=='optional' and first['executor_enabled'] is False
    assert first['credentials_present'] is False and first['ready_to_run'] is False
    # A file's presence satisfies configuration preflight; no auth request is made.
    (tmp_path/'credentials.json').write_text('fixture-only-not-real-credentials')
    second=cli.doctor(settings)
    assert second['ready_to_run'] is True
