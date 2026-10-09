# 微信与 Muse 账号池适配层

复用 [wechat-muse-bridge](https://github.com/huangzuomin/wechat-muse-bridge) 0.2.0 的腾讯 iLink 登录、长轮询、文本解析、发送和可选 Gadget CLI。安装脚本固定上游 commit `840f3fbfec7971f1f7c85a7e3910feacd2d2593e`，不修改上游代码，不开放新监听端口。

已实现：持久收件箱、消息 ID 去重、账号池幂等任务创建、按微信用户绑定的任务查询/取消、结果与异常通知、可选 Side Chat 回包、私有 SQLite 状态、单实例锁和部署预检。数据、凭据和回复上下文保存在安装目标的私有 data/ 内。

## 两种模式

- `WECHAT_DEFAULT_MODE=task`（默认）：普通文本直接创建账号池任务。无需 Gadget；Muse 由已有网页执行器执行，额度切换和 Drive 交接都复用现有实现。
- `WECHAT_DEFAULT_MODE=chat`：普通文本转入 Gadget Side Chat，需要设备已有正常的 Gadget 服务和 socket 权限。明确的“新任务：……”仍创建账号池任务。每条聊天携带固定回复引用和实际回包命令，Muse 通过设备终端调用后先进入发件箱，由桥接进程发送。

前提是账号池已使用本次源码部署，`GET /api/pool` 提供 `task_request_id` 与 `task_lookup` 能力。创建新任务不会启动已经手动暂停的执行器；通过面板或微信“开始执行”明确启动。

## 安装和预检

适配层针对 Linux / Python 3.10+。Node 账号池可以在同机运行，也可以通过已有受保护的连接访问。`127.0.0.1` 只表示桥接进程所在机器，不代表 Muse 云端工作区能访问你的本机。

在项目根目录运行：

```bash
bash integrations/wechat/install.sh
work/wechat/venv/bin/muse-pool-wechat doctor --env-file work/wechat/relay.env
```

安装器会创建独立 venv、拉取已检查的上游、安装本适配层并运行测试；默认目标是被 Git 忽略的 work/wechat。传入绝对目录可更改目标。已存在的 upstream HEAD 或源代码不同会停止，不覆盖本地修改。不会扫码、写 /etc、启用服务或推送 GitHub。

如果 Node 不在桥接设备或项目根目录未运行 npm ci，真实 Node HTTP 集成测试会明确 skip；纯 Python 回归仍运行。完整验收需在安装好 Node 项目的环境运行所有测试。

修改生成的 relay.env：确认私有数据目录、TASK_POOL_BASE_URL、模式和可选 Gadget 命令。白名单留空，登记会自动保存准确 ID。配置文件按数据解析，不作为 shell 脚本执行。网络代理与 CA 信任按部署环境正常配置；不关闭 TLS 校验。

`doctor` 仅报告安装版本、配置/文件存在、账号池接口、缓存可用账号数及执行器状态；不代表 Google OAuth、Muse 登录或实际微信收发通过验收。当前配置没有白名单和登录凭据时返回 1 是预期结果。

## 微信登记与启动

先停止该 bot 的所有旧桥接进程；同一个 iLink bot 同时只允许一个轮询进程。使用将来运行服务的同一个设备账户执行：

```bash
work/wechat/venv/bin/muse-pool-wechat enroll --env-file work/wechat/relay.env --save-user
```

登记复用上游流程，输出真实终端二维码，同时保存私有 data/login.svg，供 Muse 展示扫码。扫码后需要从准备授权的微信账号发送一次性登记口令，腾讯也可能要求验证码。成功后保存准确 sender ID 为唯一白名单成员并同步登记 cursor。失败时不会启动正式服务，不伪造二维码或身份。

随后运行 doctor；缺少账号登录/Drive 权限时先在账号池面板完成，不把“凭据文件存在”当作授权成功。

```bash
work/wechat/venv/bin/muse-pool-wechat run --env-file work/wechat/relay.env
```

Ctrl+C 安全关闭。首次微信测试发送“帮助”，再发“新任务：写两段测试文字”，必要时发“开始执行”。实际微信收到回复由用户确认。

可生成 systemd unit 供设备操作者检查：

```bash
python3 integrations/wechat/render-service.py --target "$PWD/work/wechat" --user "$(id -un)" --output work/wechat/muse-pool-wechat.service
systemd-analyze verify work/wechat/muse-pool-wechat.service
```

预检、真实登记、权限核验通过后，由 Muse 在具有必要权限的设备上安装该文件至 /etc/systemd/system/，再 daemon-reload 并 enable --now muse-pool-wechat。先检查文件中的路径与账户。unit 与旧 wechat-muse-bridge.service 冲突，防止两个服务同时轮询。Python 服务使用自己的私有数据目录；不会自动部署、启动或授权 Node/Muse/Drive。

## 微信命令

| 消息 | 行为 |
|---|---|
| 帮助 / /help | 命令说明 |
| 新任务：任务目标 | 创建幂等任务，两种模式都可使用 |
| 普通文本 | task 模式建任务；chat 模式送 Gadget |
| 查询任务 任务ID / /status ID | 查询此微信创建的任务 |
| 取消任务 任务ID / /cancel ID | 取消未执行或已安全暂停的任务；执行中返回冲突 |
| 任务列表 / /tasks | 最近十个属于此微信的任务 |
| 开始执行 / /start | 明确启用账号池执行器 |
| 暂停执行 / /pause | 停止领取，等待当前步骤结束保存进度 |
| /reset | 重置此微信的 Gadget 会话，保留账号池任务 |

完成、等待账号/网盘、交接失败、需要人工检查以及新版本交接会自动通知。结果包含摘要和实际 Drive 文件链接，不把全部大文件塞进微信。需要人工检查的任务仍由原账号确认真实停工，通过管理面板提交快照，不由微信适配层自动确认。

## 持久性和异常恢复

- 整批合法消息先与 cursor 一起保存到 SQLite，再处理任务。过滤群聊、非文本、超限、缺少消息 ID/回复上下文和未授权用户的消息，不改写默认收件人或复用其他用户的 token。
- `request_id=wechat:<发送者与消息 ID 的 SHA-256>` 由账号池保存。创建响应丢失或本地保存失败时可用相同键重试；新文本不能复用旧键。任务归属持久记录，其他微信用户不能通过本适配层查询或取消它。
- 普通聊天可能已交给 Gadget 时停止自动重发。重启会将未确认投递标记为需检查；不存在原生 Gadget 端幂等保障。
- 回包引用固定收件人与入站上下文。异步任务通知使用该任务所属用户最近一条合法新消息的上下文，不使用“最近任何发言者”。旧消息重放不会覆盖新的上下文。
- 出站按段分片，确认一片才保存进度。超时或发送期间崩溃进入 uncertain，禁止自动重发。API 确认不等于用户已阅读，也不保证绝对只投递一次。
- 微信授权失效时保持等待重新登录，不高频重试。停止服务，按上游要求重新扫码；不自动删除有效凭据。
- 已兼容上游 0.2.0 在发送响应 ret/errcode=-14 时引用未定义变量的问题：适配层将回包保留为 uncertain，不崩溃或自动重发；轮询仍由上游正常识别登录过期。上游源码保持原样。

查看发送状态（不输出消息正文、收件人或 token）：

```bash
work/wechat/venv/bin/muse-pool-wechat outbox --env-file work/wechat/relay.env
```

仅在微信确认没有收到剩余片段后，才显式重试 uncertain 项：

```bash
work/wechat/venv/bin/muse-pool-wechat retry --env-file work/wechat/relay.env --event 事件ID --confirm-not-delivered
```

不回退已确认片段的 next_chunk。已经 sent 的项不能再重试。凭据、DB、cursor 和配置一起私下备份，不提交 Git，也不包含在源码交接包中。

## 验证

```bash
work/wechat/venv/bin/python -m pytest integrations/wechat/tests -q
```

测试用模拟腾讯响应、Gadget 调用和真实本机 Node HTTP API 验证创建/重放/查询/取消、用户隔离、回复绑定、分片故障、重启不重发、控制请求丢失及 1 号→2 号续做→最终通知。Muse 与 Drive 在集成测试中都是夹具，未消耗真实额度，不能当作真实扫码或真实授权验收。
