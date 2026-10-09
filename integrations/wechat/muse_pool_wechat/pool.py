import ipaddress
from urllib.parse import urlsplit
import httpx


class PoolError(RuntimeError):
    def __init__(self, status, message='账号池暂时不可用。'):
        self.status = status
        super().__init__(message)


class PoolClient:
    def __init__(self, url, client=None):
        self.url = url.rstrip('/')
        host = urlsplit(url).hostname
        try:
            local = ipaddress.ip_address(host).is_loopback
        except ValueError:
            local = host == 'localhost'
        # Local API traffic stays local; remote HTTPS preserves the session proxy.
        self.client = client or httpx.Client(timeout=20, trust_env=not local, follow_redirects=False)

    def close(self):
        self.client.close()

    def call(self, method, path, data=None):
        response = self.client.request(method, self.url + '/api/' + path, **({'json': data} if data is not None else {}))
        if response.status_code >= 500:
            raise PoolError(response.status_code)
        if not response.is_success:
            message = '账号池拒绝本次操作，请查看面板。'
            if response.status_code == 409:
                message = '任务执行中或状态已变化，请先在面板安全暂停并检查进度。'
            if response.status_code == 404:
                message = '任务不存在，请检查账号池数据目录。'
            raise PoolError(response.status_code, message)
        try:
            result = response.json()
        except ValueError as exc:
            raise PoolError(502) from exc
        if not isinstance(result, dict):
            raise PoolError(502)
        return result

    def check(self):
        state = self.call('GET', 'pool')
        caps = state.get('capabilities', {})
        if caps.get('task_request_id') is not True or caps.get('task_lookup') is not True:
            raise PoolError(409, '账号池版本过旧：请部署交接包中的本地版本，再启动桥接。')
        return state

    def create_task(self, prompt, request_id):
        return self.call('POST', 'pool/tasks', {'prompt': prompt, 'request_id': request_id})

    def task(self, task_id):
        task = self.call('GET', 'pool/tasks/' + task_id)
        revision = task.get('revision')
        if (task.get('id') != task_id or not isinstance(task.get('status'), str) or
                not isinstance(revision, int) or isinstance(revision, bool) or revision < 0):
            raise PoolError(502)
        return task

    def cancel(self, task_id):
        return self.call('POST', 'pool/tasks/' + task_id + '/cancel', {})

    def executor(self, action):
        return self.call('POST', 'executor/' + action, {})
