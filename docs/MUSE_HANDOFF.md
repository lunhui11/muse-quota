# 给 Muse 的最终接手任务

这份文档保留最初的接手要求；2026-10-10 的实际部署结果、暂停状态和剩余工作以 [实机联调交接](LIVE_HANDOFF_2026-10-10.md) 为准。

这份说明对应本次 GitHub 更新及源码交接包。接手时拉取仓库 main 最新版本，并检查 integrations/wechat 和 executor.mjs 均存在。微信协议复用 huangzuomin/wechat-muse-bridge，适配层位于 integrations/wechat，详情见该目录 README。

## 已完成的框架

- Muse 额度探测、独立账号会话、每日 Drive 资料同步、任务分配、暂停快照、双目录交接和版本校验。
- 内置 Muse 网页执行器与面板启停、文本成果续做、发送前日志、异常恢复及步骤上限。
- 微信持久收件箱、消息去重、服务器端幂等任务、查询/取消/结果通知、用户归属与固定回复引用。
- 默认任务模式无需 Gadget；可选聊天模式调用现有 Gadget Side Chat。
- 独立安装脚本、预检、真实二维码登记包装、systemd 配置生成器，以及源码交接包生成器。

## 尚需真实环境完成

| 项目 | Muse 的执行要求 | 用户必要参与 |
|---|---|---|
| 部署设备 | 在确实可操作的 Linux 设备部署最新版 Node 项目与 Python 适配层，检查目录/进程/网络 | 必要的设备接入或权限 |
| Muse 会话 | 在目标运行环境手动登录各账号，核对额度；不能承诺复制 Windows profile 到 Linux 即可用 | 登录与官方验证 |
| Google Drive | 配置真实 OAuth、共享写入权限，绑定每个账号目录，验证实际上传及下载 | 官方 Google 授权 |
| 微信 | 运行真实 enroll，展示 SVG 二维码，写入准确 allowlist；只留一个轮询进程 | 扫码、登记口令、可能的验证码 |
| 端到端 | 微信接单、执行、保存、切号、恢复、结果回包逐项观察，记录事实 | 确认微信端收到 |

不需要 Muse 重新编写上面的框架。真实 Muse UI 的选择器、停止生成信号或回复格式若有变化，只修改 muse.mjs / executor.mjs 中对应部分，补复现检查，不移除任务版本或暂停保护。

## 直接发给 Muse 的提示词

```text
请接手 https://github.com/lunhui11/muse-quota 的 main 最新源码（或我提供的源码交接包），完成真实部署与最后联调。接手过程中不要自动推送后续修改。先读 docs/MUSE_HANDOFF.md、docs/account-pool.md 和 integrations/wechat/README.md。框架已经完成，不重新实现腾讯协议、账号池或进度交接。

首先确认你实际能操作的设备和网络。Muse 云端工作区不自动等于我的本机；若设备访问或授权缺失，准确说明并等待必要配对，不伪造成功。保存已有数据，不同时启动两份写同一账号池目录的服务。

优先采用 WECHAT_DEFAULT_MODE=task：微信消息由适配层直接进入账号池，执行由内置 Muse 网页执行器完成，初期无需 Gadget。需要普通 Side Chat 聊天时再启用 chat 模式并验证 Gadget CLI/service/socket 权限。不要启动原版 wechat-muse-bridge 和新适配层去同时轮询同一个 bot。

在实际设备部署最新版源码：安装 Node >=20.12，npm ci，安装/选择兼容浏览器，配置私有 .env 与 data/，启动 Node 服务。验证 /api/pool 的 task_request_id 与 task_lookup 能力，/api/executor 可读且初始关闭；接口缺少这些能力说明仍在运行旧版本。

运行 bash integrations/wechat/install.sh，按它生成的 relay.env 配置实际账号池地址与私有目录。运行 doctor；缺少白名单/微信凭据时返回 1 是预期。确认 Node API 可达；跨设备不能误用 127.0.0.1，也不公开无密钥管理端口。

在目标浏览器环境登录两个以上我手动注册的 Muse 账号，检测并核对实际额度。完成 Google 官方 OAuth 与目录共享权限，将每个账号目录绑定，添加一份测试资料，实际同步并验证。凭据不放源码、不写聊天、不提交 Git；云端首次登录按项目 README 使用受保护图形会话，不复制平台秘密。

停止所有该 bot 的旧轮询进程，以实际服务账户执行 muse-pool-wechat enroll --env-file 配置文件 --save-user。展示生成的真实 data/login.svg，等我扫码；若需登记口令/官方验证码给我准确动作，其余配置自动完成。不得猜测微信 sender ID 或放开全员白名单。

再运行 doctor 并启动新适配层。让我先发送“帮助”和“新任务：写两段测试文字”，通过明确“开始执行”或管理面板启用执行器。新任务不能自动覆盖人工暂停。验证任务 ID、状态、Drive 文件和微信实际收到的最终回复。

然后用低风险文本任务验证 1 号暂停保存→网盘两份交接包校验→2 号读取原成果续做→最终结果回微信。可在测试配置中选择适当的暂停阈值便于观察，但不能伪造额度或把模拟数据当真实验收。检查日志、任务 history/revision 和真实成果，确认没有重复做前一步。超时/不确定回复进入检查状态；人工确认原账号真实停工后才恢复。

检查服务重启后的任务和微信状态恢复，并验证重复消息不建第二个任务、任务查询/取消归属、分片回包。发送未确认时先检查微信再决定是否显式重试，不盲目重复发送。只在实测失败点做必要的小改动，并运行相关回归。

通过验收后再生成和安装 systemd unit，检查实际账户、目录和权限，设置开机运行。交付填写后的验收记录、部署路径、服务状态、启停及重新授权步骤。能够自动完成的工作继续做，只在扫码、官方登录、设备接入和缺失权限等必要交互时等待我。将测试通过、API 确认和我实际收到分开记录。
```

## 验收记录

复制 integrations/wechat/acceptance.template.json 到被忽略的 work/ 中填写。保留未验证项为 pending，不将上游测试或本地夹具填成真实验收。保存日期使用 Asia/Shanghai。

## 本地检查与打包

```bash
npm test
work/wechat/venv/bin/python -m pytest integrations/wechat/tests -q
python3 scripts/build_handoff.py --output work/muse-quota-handoff.zip
```

交接包包含源码和说明，不含 .env、data/、Cookie、微信凭据、SQLite 状态、node_modules、work/ 或 .git。登录与 Google/微信授权在实际部署设备完成；没有因打包自动同步私人账号资料。
