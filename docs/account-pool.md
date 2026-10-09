# 账号池与网盘任务交接

这部分已经实现目录绑定、每日文本资料同步、额度阈值暂停请求、交接包上传和下载校验、账号顺序选择及重启恢复。任务执行仍由你的执行程序接入；只部署本项目不会自动在 Muse 网页发送聊天，也不会自动替账号完成 Google 授权。

## 首次使用

1. 手动注册、登录 Muse 账号，在本项目中添加账号并检测额度。
2. 每个 Muse 账号手动连接自己的 Google Drive 目录。在账号「编辑」中填写对应目录链接或 ID。
3. 为上传程序配置 Google 授权。所有目录都必须允许同一个上传身份写入；不同 Google 账号的目录可以共享给该身份。目录共享不等于 Muse 已经连接目录，后者需在每个 Muse 账号里分别完成。
4. 在「每日同步资料」中保存文本资料。每天北京时间 08:00 后，运行中的服务会将这些资料写入所有已启用且已绑定目录的账号；服务当天晚启动会补执行一次。也可以点「立即同步」。相同资料更新同一文件，不每日产生重复文件。
5. 在「添加任务」中输入任务要求，接入下面的执行程序协议。

Google 授权优先使用 `.env` 中的 `DRIVE_OAUTH_CLIENT_ID`、`DRIVE_OAUTH_CLIENT_SECRET`、`DRIVE_OAUTH_REFRESH_TOKEN`。也支持 `DRIVE_CREDENTIALS_FILE` 或已有 `GOOGLE_APPLICATION_CREDENTIALS`，通过官方 google-auth-library 使用这些凭据。文件存在不等于授权可用；绑定目录和上传时会检查实际权限。凭据文件放在被忽略的 data/ 内或仓库外，不要提交到 Git，也不要通过聊天发送令牌。

用户 OAuth 配置需要在 Google Cloud 项目启用 Drive API、建立 OAuth 客户端、用户同意 `https://www.googleapis.com/auth/drive` 范围并取得离线 refresh token。Google OAuth 测试模式的用户授权可能到期，长期使用应按 Google 的应用发布要求配置。可使用已有用户授权凭据文件。服务账号只有在目标目录和 Google 存储规则允许写入时才能使用，不应假定其有个人网盘存储空间。

默认额度阈值为 90%，仍由 `PAUSE_AT_PERCENT` 控制。`DAILY_SYNC_HOUR` 设置每日同步小时（北京时间 0–23）。网页每 5 秒读状态，调度器每 15 秒运行。执行程序必须在步骤之间上报最新额度，不能只依赖默认 30 分钟的外部探针。

## 执行程序协议

所有请求在本机 API 上进行，JSON 请求体，无访问密钥。账号池接口请求体最多 256 KiB。

`GET /api/pool` 返回目录、资料、任务和交接状态。执行程序轮询属于自己账号的任务。状态 `ready` 表示交接文件已上传并下载校验，等待领取；它不表示任务已经开始。

领取：`POST /api/pool/tasks/<任务ID>/claim`

```json
{"account_id":"账号ID","revision":1}
```

200 后执行程序取得当前版本的执行权。响应包含 `bundle`（任务要求、已保存进度、成果文本和资料文件 ID）和 `file`（本账号网盘交接文件 ID、链接、SHA-256）。执行程序用对应账号打开 Muse，让 Muse 读取已连接目录中的该交接文件，并按 `checkpoint.next_steps` 继续。必须核对 Muse 确实读取了最新文件；网盘上传成功不等于 Muse 已索引成功。重复领取或旧版本请求返回 409，不应继续执行。

执行程序每完成一个可暂停的步骤，应读取当前额度并发送：`POST /api/pool/tasks/<任务ID>/quota`

```json
{"account_id":"账号ID","revision":1,"weekly_used_pct":92}
```

达到阈值后状态变为 `pause_requested`。过期或未知额度也会请求暂停。此时执行程序停止提交新步骤，等待当前步骤稳定结束，关闭使用该账号的浏览器上下文，然后提交进度：

`POST /api/pool/tasks/<任务ID>/checkpoint`

```json
{
  "account_id":"账号ID",
  "revision":1,
  "paused":true,
  "summary":"第一章已完成，尚未发布。",
  "next_steps":"读取 chapter-1.md，继续第二章；不要重新执行第一章。",
  "artifacts":[{"name":"chapter-1.md","content":"已完成的正文"}]
}
```

摘要和续做指令各最多 10000 字符；成果最多 10 个文本文件，每个内容最多 20000 字符。每次提交的是完整恢复快照，应包含续做所需的全部成果。二进制附件、聊天历史全文和账号 Cookie 不会自动导出；需要任务程序显式处理。`paused:true` 必须对应真实停工，不能把仍在执行的账号标记为已暂停。

账号池保存本地快照，按账号顺序选择下一可用账号；向源账号目录和目标账号目录写入同一个交接包，下载核对内容后，才把归属改到下一账号并递增 revision。同步资料失败、任何一份交接文件上传或校验失败时，归属不变，原账号保持暂停，状态显示 `upload_failed`。修复权限或网络后点击重试，或等待调度器重试。没有可用账号时显示 `waiting_account`，保留进度，不重放任务。

后续执行程序领取新版本，读取交接包，按续做指令工作。旧账号或旧 revision 的额度/进度上报返回 409。任务产生的发布、发送、付款等外部副作用，应由执行程序记录操作 ID 和完成状态；账号池不能独立保证这些业务操作仅执行一次。

完成时向同一 checkpoint 接口发送 `completed:true`、summary 和最终 artifacts；无需 next_steps。最终结果上传到当前账号目录，验证成功后才显示 `completed`；失败显示 `completion_upload_failed` 并保留本地结果等待重试。

服务重启后，曾经 `running` 的任务变为 `pause_requested`，不会自动重复派发。原执行程序确认停工并提交进度后，才能恢复交接。正在执行或等待暂停的账号不启动独立额度探针，避免争用持久浏览器目录；执行程序负责从自己的会话上报额度。

## API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /api/pool | 读取完整账号池状态 |
| POST | /api/pool/accounts/ID/folder | 绑定目录，JSON：folder_id |
| POST | /api/pool/documents | 保存文本资料，JSON：title、content |
| POST | /api/pool/sync | 立即同步资料到所有已启用的目录 |
| POST | /api/pool/tasks | 添加任务，JSON：prompt |
| POST | /api/pool/tick | 立即运行一次调度/重试 |
| POST | /api/pool/tasks/ID/claim | 领取任务 |
| POST | /api/pool/tasks/ID/quota | 上报当前账号额度 |
| POST | /api/pool/tasks/ID/checkpoint | 暂停交接或完成任务 |
| POST | /api/pool/tasks/ID/cancel | 取消尚未执行或已暂停的任务 |

## 验证范围

`npm test` 同时执行原有浏览器测试和 test-pool.mjs。账号池测试覆盖三个账号交接、每日同步、上传失败不切号、完整进度与成果复制、重复领取、旧版本更新拒绝、重启恢复和结果上传。Google API 请求由 HTTP 模拟响应验证；不代表真实 Drive OAuth、目录权限、Muse 网盘连接或任务执行程序已经通过验收。

真实接入应使用一个低风险测试任务：1 号完成一步，上报达到阈值，确认暂停并上传；核对两个目录中的交接文件一致；2 号领取后读取文件并继续下一步。完成该验证前，不应把状态 ready 宣称为真实任务执行成功。
