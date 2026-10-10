# 上传前检查记录

日期：2026-10-09（Asia/Shanghai）

完成代码审查、本地回归测试及 Git 历史敏感数据检查。测试通过表示当前检查范围内未发现未修复问题，不代表不存在所有潜在缺陷。

## 已修复

- 保存账号和检测结果时，串行处理数据变更；文件保存失败会回滚。修复新增账号未保存却留在内存，以及并发保存包含未确认修改的问题。
- 合并请求数据块后再解码 UTF-8，避免中文名称和备注乱码。超出 16 KB 的请求返回 413。
- 拒绝负数、带千位逗号及超过 100% 的异常用量，避免误判为低用量。
- 退出面板时清空展示数据，并忽略旧连接的异步响应，避免后台刷新重新显示账号信息。

## 验证结果

- `npm test`：通过。覆盖中英文额度解析、两个临时浏览器的 Cookie 隔离、鉴权、保存失败回滚及恢复、中文分段请求、名称备注保存、退出刷新竞态、登录与检测互斥、串行队列、重复检测、失败保留旧值、桌面和手机页面。
- `npm audit --omit=dev --registry=https://registry.npmjs.org --json`：已知漏洞 0。
- JavaScript 语法检查、`git diff --check`：通过。
- Git 历史检查：未发现账号数据目录、浏览器会话、访问密钥、本地 `.env` 或已知 GitHub 令牌格式。仅上传 Git 跟踪的项目文件。
- 当前已登录真实账号的中文额度页面已在上一轮核验，周用量、重置日期、额外额度和有效期读取成功。

## 尚未验证

本机未安装 Docker，未执行镜像构建、Linux 容器运行或云服务器部署。Muse 页面变化、登录过期、代理失效仍可能导致探测失败；此时保留旧读数并标记错误或过期。

## 账号池更新检查

- 新增账号目录绑定、每天北京时间资料同步、额度阈值暂停请求、双目录交接包复制和下载校验、版本校验、服务重启恢复以及最终成果上传。
- `npm test` 包含原有浏览器回归及账号池测试：通过。验证账号1→账号2→账号3的交接、上传失败不切号、旧账号更新拒绝、重复领取拒绝、每日同步、目录/资料/任务面板及手机布局。
- Google Drive 传输测试通过模拟 HTTP 响应验证令牌刷新、幂等更新和内容校验；真实 Google Drive 上传尚未验证。
- `npm audit --omit=dev`：已知漏洞 0。
- 当前云环境 Google 认证请求返回 `MISSING_CREDENTIALS`；需要有效 Google 授权、目录权限和外部任务执行程序，才能验收真实 Muse 自动续做。任务执行程序接入协议见 docs/account-pool.md。

## 账号池 Bug 复查

- 使用新增测试复现并修复 6 项问题：保存失败后仍在内存发布新归属、没有备用账号时未备份暂停进度、原账号额度恢复后无法续做、目录变更后未补同步当天资料、已完成任务被取消改写、不完整 OAuth 配置阻断凭据文件回退。
- 新增 9 项回归测试，覆盖上述问题及源网盘失败重试、最终状态保存失败、并发领取；修复前对应 6 项测试失败，修复后全部通过。
- 测试临时目录改用系统 tmpdir；账号池浏览器测试沿用 Windows Chrome 配置。当前验收机器为 Linux，没有宣称已运行 Windows 测试。
- 完整浏览器/账号池测试及 git diff --check 通过。真实 Google 授权和 Muse 执行程序尚未接入，仍需真实端到端验收。

## 内置执行器检查（2026-10-10，尚未上传）

- 实现持久账号会话执行、网盘文件下载校验、逐步读取额度、文本成果保留、双账号续做和最终结果上传。
- 新增 19 项执行器测试，配合既有 9 项账号池回归及原浏览器套件。测试响应全部模拟，真实临时 Chromium 不访问 Muse，不消耗实际额度。
- 发送只按一次 Enter；收到暂停后在发送日志落盘期间再次校验执行权。可能已发送的异常和重启均进入人工检查，不自动切号或重发；原草稿不被覆盖。
- 当前云环境未配置可确认的真实 Muse/Google 授权，网络策略不包含 Muse/Google 服务域名；未验证真实自动执行和 Docker。
- 微信桥接仓库 https://github.com/penghuitiyu/wechat-ilink-bridge 在 Git、网页和 main/master README 检查均不可访问，尚未安装或生成二维码。
- 按最新要求保留所有源代码改动在本地，没有向 GitHub 推送。

本轮最终检查：npm test 全部通过，其中 Node test runner 的 28 项测试（19 项执行器 + 9 项账号池回归）全部通过；原有浏览器及账号池套件同时通过。已重启本地服务并验证 health、面板、额度、执行器和账号池 API，执行器初始关闭。git diff --check 通过。

## 微信桥接复用研究

- 新研究对象：huangzuomin/wechat-muse-bridge，commit 840f3fbfec7971f1f7c85a7e3910feacd2d2593e，0.2.0。只在 /tmp 的隔离副本安装依赖，上游 57 项测试通过，没有改写上游代码或推送。
- 核对 Gadget CLI 的 stdin 入站、手动出站命令、systemd 安装、登记口令、单会话和至少一次投递语义。当前云环境没有 musegadget CLI，尚未进行真实扫码或微信测试。
- 用纯内存夹具复现被过滤的群聊消息改写默认回复对象，以及缺失 token 时跨发送者复用旧 context_token。已在 Muse 部署提示词中要求针对性修复和测试，没有把既有测试通过宣称为不存在这些问题。
- 新增 docs/muse-wechat-prompt.md，提供微信联通和账号池适配两阶段提示词；没有新增桥接应用代码。

## 微信适配框架交付（2026-10-10，Asia/Shanghai，本地保留）

上述“仅研究/没有桥接应用代码”是上一阶段记录。现在已新增 integrations/wechat，可复用上游 iLink SDK 并直接调用现有账号池，无需 Muse 重新写适配层。

- 账号池新增持久 request_id 幂等创建、单任务查询和能力声明。并发、取消、完成与重启后仍返回同一任务；不同要求不能复用同一键；写入失败不会留下未确认任务。
- 微信默认任务模式无需 Gadget，支持接单、查询/取消、显式启停、结果/异常通知；聊天模式可选 Gadget。过滤消息不能改变收件人，重复旧消息不能覆盖新的上下文，用户只能通过桥接查看自己创建的任务。
- SQLite 保存消息、cursor、归属与出站分片进度；已投递但未确认的发送不会自动重发。失效授权等待重新扫码，丢失的启停响应不重放控制操作。
- 复现固定 SDK 在发送返回 ret/errcode=-14 时的未定义变量错误，用兼容子类保留 unconfirmed 状态；不修改上游 checkout，不重写腾讯协议。
- 独立安装脚本、doctor、真实 enroll 的 SVG 输出及白名单保存、systemd 生成器、验收模板与源码打包器已提供。安装脚本在隔离 venv 实跑通过；生成的 unit 已通过 systemd-analyze verify，尚未安装或启用微信服务。
- npm ci 使用官方 registry 与工作区可写缓存安装成功；完整 npm test 通过，其中 19 项执行器 + 11 项账号池回归合计 30 项 Node runner 测试，原浏览器/账号池套件同时通过。
- 微信适配层 30 项测试通过，包含真实本机 Node HTTP 流程的微信接单→1 号阈值暂停→2 号续做→结果回传；Muse、Drive、腾讯响应和 Gadget 都是夹具。扫码包装测试生成的是测试二维码，不是实际登录二维码。
- 已重启本地 Node 服务并通过健康/面板/API 检查。安装版本 doctor 确认 pool_api/pool_idempotency 为 true；allowlist/微信凭据为空、可用账号 0、执行器关闭，ready_to_run 为 false（返回 1 符合预期）。drive_configured 只表示配置存在，不代表实际授权有效。
- 真实设备部署、Muse 登录、Google 授权、微信扫码和现场端到端验证尚未完成，交由 Muse 按 docs/MUSE_HANDOFF.md 接手。最新代码没有提交或推送到 GitHub，交接必须使用源码包。

## 维护接入与运行版本检查（2026-10-10，本轮云工作区）

历史服务器联调事实以 docs/LIVE_HANDOFF_2026-10-10.md 为准；以上各阶段的本地结果不代替实机状态。本轮未连接生产服务器、未重启服务、未启动任务、未推送 GitHub。

- 检查目录是 /workspace/muse-quota，GitHub 仓库为 lunhui11/muse-quota。fetch 成功，HEAD 和 origin/main 均为 fb5064a4f352fb8662cbb6c2ed7f2af1f0b4f349；实机交接文档存在。新增维护改动尚未提交。
- 新增启动时运行身份快照及只读 /api/deployment，区分根目录 Git 检出、已校验源码包和未知复制部署；父目录 Git 不冒充服务 Git，修改磁盘文件不会改写旧进程身份。固定源码文件指纹不包含凭据、数据或浏览器会话。Docker 复制列表已补模块，镜像构建仍 pending。
- 新增 scripts/live_status.py，仅请求回环 API 的 GET，输出白名单元数据。执行器未确认关闭、运行/待暂停/需人工检查任务、未知任务状态、浏览器占用、无效额度结构或旧服务缺少版本端点时阻止可更新状态。空闲快照不代表备份或授权更新。
- 维护公钥与服务器侧 Muse 接入提示词已生成，保存在仓库外；私钥未输出、未打包。实际 SSH 用户大小写、主机指纹、授权公钥安装、Tailnet 地址和服务根目录均 pending。
- 当前平台策略 vpn_configured=false，未配置 TCP grant；公网 SSH 目标不满足受控私网 CONNECT 条件。没有尝试绕过网络策略。需要平台侧 VPN 与精确 TCP 授权，并使用新配置版本的替换环境；保存草稿不等于连接成功。
- install_script、start_skill 和非敏感服务器选择器已保存到环境草稿并读回核对；既有 Google 域名与凭据要求保留。安装脚本在当前工作区实际执行完成，退出 0：npm test 全部通过，Node runner 38 项、0 失败/跳过；微信 30 项；新增 Python 巡检 7 项。浏览器、Muse、Drive、微信测试响应均为夹具，不消耗实机账号额度。
- 源码交接包清单逐文件 SHA-256 检查通过，解包后身份识别为 source_bundle，runtime_modified=true，来源基线为上述提交；不把未提交改动宣称为 GitHub 已发布版本。包不含 .env、data、work、依赖缓存、SSH 密钥或实际凭据。
- 实机备份、服务/任务状态、代码更新、OAuth 可用性、两账号官方额度与 Muse 内 Drive 连接、真实 1→2 续做、微信回传、重启恢复和旧消息去重：全部 pending。接入后按 docs/SERVER_ACCESS.md 受控检查，执行器保持关闭，并保留 wechat-mengmeng。

## GitHub Actions SSH 接入框架（2026-10-10，本地待发布）

- 用户选择撤销今晚的 Tailscale/Codex 公钥接入，保留原项目、数据和微信服务；回退由已能操作服务器的 Muse 执行，当前工作区没有实际服务器清理记录。更早的实机交接确有部署和验收结果，但记录未完整注明操作者和传输通道，不能根据本轮 SSH 失败断言历史上从未接入。
- 按用户提出的 GitHub Actions SSH 方式，新增仅 main 手动触发、server-maintenance 环境审批的工作流。使用 GitHub 托管 Ubuntu 执行机，无需服务器 self-hosted runner 或 Tailscale。首个任务只读检查，不部署代码、不安装依赖、不重启服务、不启动执行器。
- actions/checkout v4.2.2 的固定 SHA 通过官方仓库 ls-remote 核对。SSH 主机指纹不匹配时阻止认证；私钥仅在执行机私有临时文件中使用，子进程环境和公开日志不携带密钥。仅上传检查源码到独立的服务器临时目录，精确校验路径后清除，不覆盖部署目录。
- 公开报告不含任务/账号 ID、提示词、具体额度、错误原文或凭据。旧 API 版本身份缺失与磁盘源码不可读保留 pending；只读检查通过也不代表备份或更新授权。
- 本地 stdlib Python 回归共 23 项通过（只读巡检 7、Actions 摘要 9、SSH 协议模拟 7），包括指纹不匹配、输入注入拒绝、子进程密钥隔离、复制失败清理、异常临时路径拒绝及清理失败 pending。工作流 YAML 已解析并核对手动/main/审批/read-only 权限结构。这些没有执行真实 GitHub→服务器 SSH。
- GitHub Git 读取正常，目前远端仅发现 main；已取回的仓库历史没有 .github 路径。GitHub REST 工作流与 Secret 元数据请求被本环境代理 403 拒绝，不能推断以前是否在其他仓库配置过通道，或当前仓库 Secret 不存在。
- 新工作流、检查脚本和 docs/GITHUB_SSH.md 尚未上传 GitHub。旧 Actions 运行链接、SSH Secret 名称复用、环境配置、第一次真实 run、服务器身份和状态结果均 pending；没有声称通道已打通。
<!-- GitHub configuration preparation: 2026-10-10 -->

## 2026-10-10 GitHub SSH 自动配置准备

已增加 `scripts/configure_github_ssh.py`：通过官方 API 检查管理员权限，创建 main 分支限定及所有者审批的维护环境，设置非敏感连接变量，重新读取验证；仅列 SSH Secret 名称，不读取或上传私钥，不派发工作流，不操作服务器。已有环境保护不覆盖，网络/权限/缺少密钥状态保留 pending。

本地 `python3 -m unittest discover -s scripts -p 'test_*.py' -v` 实测 31 项通过。凭据模式扫描和 `git diff --check` 通过。已在云环境配置草稿添加 `api.github.com`，保留 Google 域名；保存不等于实例策略生效。真实 GitHub 管理 API、GitHub-hosted runner SSH 和服务器检查均 pending，未重启服务或启动执行器。
