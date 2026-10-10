# Muse 额度探针

独立浏览器会话读取 muse.ai 的周用量百分比、重置日期、套餐和额外额度。支持手动/定时检测及每个账号的固定代理。

支持额度探测和账号池任务交接：每个账号绑定网盘目录，每日同步文本资料，额度接近阈值时保存进度，上传并校验后分配给下一账号。内置 Muse 网页执行器可在面板启动，下载网盘资料、分步发送任务并自动续做；外部执行程序协议仍可使用。账号注册、登录和 Google 授权由你手动完成。

使用步骤、Google 授权、任务领取及续做协议见 [账号池使用说明](docs/account-pool.md)。

截至 2026-10-10 的云服务器真实联调、暂停状态和后续验收步骤见 [实机交接记录](docs/LIVE_HANDOFF_2026-10-10.md)。

对应的源码交接 ZIP 和 SHA-256 校验文件位于 [releases 目录](releases/)。压缩包仅含源码和文档，不含运行数据或凭据。

## Windows 使用

需要 Node.js 20.12+ 和 Google Chrome。

在项目目录运行：

~~~powershell
powershell -ExecutionPolicy Bypass -File .\Start.ps1
~~~

启动脚本安装锁定依赖、后台启动服务，然后打开 http://127.0.0.1:8788，直接显示账号面板，无需访问密钥。

1. 使用默认的「Muse 账号1」，或添加你需要的账号。
2. 点「打开登录窗口」，在独立浏览器里手动登录 Muse。
3. 登录完成后回到面板，点「保存登录并查询」。
4. 点账号卡片的「编辑」修改名称和备注，保存后保留原来的账号 ID、登录会话和额度记录。备注可留空，最多 1000 字；正在登录或检测时请稍后编辑。
5. 把探针的周用量和重置日期与官网设置里的 Usage/用量页面对照。

密码和验证码只在官网窗口输入。账号会话保存在 data/profiles/<账号ID>；不读取你日常 Chrome 的资料。

仅后台启动、不打开页面：

~~~powershell
.\Start.ps1 -NoBrowser
~~~

在终端前台运行：

~~~powershell
npm ci --ignore-scripts --no-audit --no-fund
node server.mjs
~~~

关闭前台服务用 Ctrl+C。后台实例的进程 ID 保存在 data/service.pid；停止该实例前先核对进程命令行确为本项目的 server.mjs。

## 配置

复制 .env.example 为 .env 后修改，重启服务生效：

- PROBE_INTERVAL_MINUTES：默认每 30 分钟检测，允许 1–1440 分钟。
- PAUSE_AT_PERCENT：默认 90，达到此周用量时不再建议分配新请求。
- DATA_DIR：数据目录；默认项目里的 data。
- BROWSER_CHANNEL：Windows 默认 chrome；Linux 默认 Playwright Chromium。
- BROWSER_EXECUTABLE_PATH：可选，指向已有 Chrome/Chromium 的绝对路径；设置后优先于 BROWSER_CHANNEL，部署前运行测试确认兼容。
- HOST/PORT：本地默认 127.0.0.1:8788。
- ALLOW_LOGIN：设为 0 时禁止从面板打开交互式浏览器。
- EXECUTOR_HEADLESS：默认 1，设为 0 时显示 Muse 执行浏览器。
- EXECUTOR_TIMEOUT_SECONDS：默认 300，每次回复等待上限。
- EXECUTOR_MAX_STEPS：默认 20，每次领取的执行步骤上限；达到后保存进度等待人工检查。
- DRIVE_PROXY_URL：Google Drive OAuth 和 API 使用的 HTTP(S) 代理地址；与各 Muse 账号的浏览器代理分别配置。
- DRIVE_IMPORT_ENABLED：设为 1 后，每天从各账号绑定目录读取 UTF-8 的 txt/md/json 文件，并把当天快照加入新任务。

账号数据和浏览器会话保存在 data 目录。该目录和 .env 被排除在 Git 与 Docker 镜像之外。迁移或升级前保存该目录，不能同时让两份服务写同一目录。

检测串行执行；重复刷新不会为同一账号重复排队。登录窗口占用该账号会话，必须保存/关闭后才能检测。读不到百分比时显示未知；失败保留旧结果并标记过期，不会把失败当成 0% 用量。最后成功超过两倍刷新间隔时也标记过期。

重置日期按官网原文显示；若页面缺少年份或时区，不推算精确重置时间。未提供总 token 数时只显示百分比。

## 固定代理与隔离

添加账号时填写代理地址，例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080。认证代理在 .env 中设置环境变量，再在账号表单中填写变量名：

~~~dotenv
MUSE_A_PROXY_USER=你的代理用户名
MUSE_A_PROXY_PASSWORD=你的代理密码
~~~

不同账号可以填写不同固定代理地址。浏览器使用配置的代理访问 Muse；代理失败不回退直连。Chromium 的 SOCKS5 认证不在此实现中支持，需要认证时使用 HTTP 代理。

浏览器目录隔离 Cookie 和本地存储，不改变公网 IP，也不代表不同硬件。此工具不伪造设备指纹，不承诺防封。服务没有自动购买或分配代理。

## Linux / Docker 部署

需要 Linux、Docker Engine 和 Docker Compose。Playwright 依赖和浏览器镜像都固定在 1.62.1。

这是服务代码的部署入口，不是免配置的一键成品：新环境还需要准备私有 `.env`、Muse 官方登录、Google Drive OAuth 与目录授权，以及微信扫码登记。无头 Linux 首次登录还需自行准备受保护的图形桌面；本项目不会替你安装或公开远程桌面服务。云服务器部署前先读下方“云端首次登录”和 [实机联调交接记录](docs/LIVE_HANDOFF_2026-10-10.md)。

~~~bash
cp .env.example .env
docker compose up -d --build
docker compose logs --tail=30 probe
~~~

容器以 pwuser 运行，持久化卷名为 muse-quota-data。宿主端口只绑定 127.0.0.1。通过 SSH 隧道访问：

~~~bash
ssh -N -L 8788:127.0.0.1:8788 用户@服务器
~~~

然后在本机打开 http://127.0.0.1:8788，直接使用面板，无需读取或粘贴访问密钥。

不要将后台服务、浏览器调试端口或登录桌面直接暴露到公网。

### 云端首次登录

不能保证将 Windows Chrome 配置复制到 Linux 后仍可登录；在服务器的容器浏览器环境中重新登录。

无界面的容器无法展示登录窗口。先在服务器建立受保护的 X11 图形桌面，并在其桌面终端中运行下面的命令；只运行 SSH 隧道不会自动提供图形环境。Wayland-only 桌面需要另行配置 X11/XWayland。现在的交付不自动安装远程桌面。

先在面板添加账号，记下其 ID。下列操作让登录和后台服务使用同一容器用户、同一数据卷：

~~~bash
docker compose stop probe
mkdir -p work
chmod 700 work
task_xauth="${XAUTHORITY:-$HOME/.Xauthority}"
test -n "$DISPLAY" && test -f "$task_xauth"
cp "$task_xauth" work/desktop-auth
chmod 644 work/desktop-auth
docker compose run --rm -it \
  -e ALLOW_LOGIN=1 -e DISPLAY -e XAUTHORITY=/run/desktop-auth \
  -v /tmp/.X11-unix:/tmp/.X11-unix:ro \
  -v "$PWD/work/desktop-auth:/run/desktop-auth:ro" \
  probe node server.mjs login 你的账号ID
rm -- work/desktop-auth
docker compose up -d
~~~

DISPLAY 应是服务器本机的桌面显示编号，例如 :1。若上面的 test 失败，先配置图形会话及授权文件，不要继续执行登录命令。

在弹出的 Muse 官网窗口登录，完成后在终端按 Enter 保存退出，再启动后台服务并从面板查询。work 目录不会进入 Git 或镜像。云端的网络访问、代理、登录和容器运行都需要在实际服务器上重新核验。

## 额度 API

本机 /api/* 路径无需访问密钥或 Authorization 请求头；请求体使用 JSON。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /api/quotas | 读取缓存额度、过期状态和分配建议 |
| GET | /api/status | 同上，含账号操作状态 |
| POST | /api/accounts | 添加账号：label、可选 notes 和代理配置 |
| POST | /api/probe-all | 所有启用账号排队检测 |
| POST | /api/accounts/ID/probe | 指定账号排队检测 |
| POST | /api/accounts/ID/login | 本机打开独立登录窗口 |
| POST | /api/accounts/ID/finish-login | 保存登录、关闭窗口并排队检测 |
| PATCH | /api/accounts/ID | 修改 label、notes 或 enabled: true/false |
| GET | /healthz | 不含账号资料的健康状态 |
| GET | /api/deployment | 运行实例的服务根目录、来源提交与启动时源码指纹 |

每条结果包含 account_id、quota、status、stale、checked_at、last_success_at、error、eligible_for_new_requests 和 reason。后续聊天网关可以读取这份建议，但不能据此保证单个任务的额度充足，也不能假设跨账号拥有同一聊天历史或文件授权。

## 验证与限制

上传前的修复和检查结果见 [audit-report.md](audit-report.md)。

~~~bash
npm test
~~~

测试使用两个真实的临时浏览器配置，通过拦截所有网络请求提供本地模拟 Muse 页面。覆盖中英文和小数解析、Cookie 隔离、无密钥访问、代理配置、队列、失败缓存及桌面/手机页面，不访问真实 Muse、不消耗账号额度。

本地模拟测试已完成。开发机器没有 Docker，因此没有在这台电脑构建或运行容器镜像。2026-10-10 云服务器实测情况与未完成项见 [实机联调交接记录](docs/LIVE_HANDOFF_2026-10-10.md)：真实 Muse 额度探测、Google Drive 交接上传/下载校验、微信扫码登记和一条小型任务回传已通过；账号 1→2 的真实跨账号续做、账号 1 的 Muse 内置 Drive 读取、生产微信重复消息重放仍为 pending。用量页面结构变化时，探针保留旧读数并显示错误，不把失败当作 0%。

参考资料：
- https://github.com/czg86389-hub/muse2api
- https://playwright.dev/docs/auth
- https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
- https://playwright.dev/docs/network
- https://playwright.dev/docs/docker

内置自动执行的首次配置、暂停恢复及限制见 [账号池使用说明](docs/account-pool.md)。先以小型文本任务验证网盘和 Muse 回复，再运行需要切号的任务。微信桥接复用 wechat-muse-bridge，默认通过现成适配层直接接入账号池；Side Chat 模式可选 Gadget。具体实测结果以 [实机联调交接记录](docs/LIVE_HANDOFF_2026-10-10.md) 为准；新环境仍需分别完成账号登录、官方授权与微信扫码，不能仅凭本地测试认定真实服务已验收。

## 微信与 Muse 接手部署

已提供可运行的 [微信适配框架](integrations/wechat/README.md)：默认任务模式直接调用现有账号池，普通聊天模式可选 Gadget。支持微信接单、幂等创建、查询/取消、成果回传、持久状态与预检。请从 GitHub 拉取本次更新后的最新源码；[给 Muse 的最终接手任务](docs/MUSE_HANDOFF.md) 包含部署、真实授权和端到端验收要求。

交接源码可用 `python3 scripts/build_handoff.py` 打包，默认保存在被忽略的 work/，不会带上账号会话或凭据。微信桥接是独立 Python 可选组件，不增加原 Node 启动的依赖。真实扫码和 Muse/Drive 联调仍由实际部署设备完成。

服务器接入、Git/复制部署区别和只读巡检步骤见 [服务器维护说明](docs/SERVER_ACCESS.md)。`python3 scripts/live_status.py` 查询运行实例，不能用工作区已拉取的提交号代替实际服务版本；巡检不启动执行器。

通过 GitHub Actions 的 SSH 接入步骤见 [GitHub SSH 检查说明](docs/GITHUB_SSH.md)。已提供手动审批的只读工作流，先验证连接和现有服务状态，再另行安排受控部署；不需要服务器安装 Actions runner 或 Tailscale。
