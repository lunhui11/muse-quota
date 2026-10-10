# 通过 GitHub Actions 检查现有服务器

工作流位于 `.github/workflows/server-inspect.yml`。它在 GitHub 托管的 Ubuntu 执行机上运行 OpenSSH，由执行机连接服务器公网 SSH；不需要服务器安装 Actions runner，也不需要本次 Tailscale 接入。当前 Codex 工作区的网络限制不会自动传递给 GitHub 执行机，但服务器是否接受该连接仍需实测。

第一个入口仅做只读检查。它不会更新部署目录、安装依赖、重启服务或启动 Muse 执行器；后续实际部署需要另行实现备份、任务检查和受控更新，不能把这个工作流当作部署完成。

## 配置入口

仓库：`https://github.com/lunhui11/muse-quota`。

1. 在 **Settings → Environments** 创建 `server-maintenance`，限制部署分支为 `main`，设置主人为审批人。若只有一名管理员，确保自己能够批准自己触发的手动任务。
2. 在该环境的 **Environment variables** 配置下表中的变量，在 **Environment secrets** 中配置 SSH 私钥。优先沿用已经匹配服务器授权公钥的 GitHub SSH 密钥，不要重复生成或把密钥发到聊天。
3. 工作流提交到 main 后，在 **Actions → Inspect Muse server over SSH → Run workflow** 选择 main。任务等待审批时先审阅代码和目标，再批准。

| 名称 | 类型 | 内容 |
| --- | --- | --- |
| `MUSE_SSH_HOST` | Variable | 服务器公网 IPv4 或域名 |
| `MUSE_SSH_PORT` | Variable | SSH 端口，默认 22 |
| `MUSE_SSH_USER` | Variable | 已核实的非 root 维护用户 |
| `MUSE_DEPLOY_DIR` | Variable | 服务器现有项目的绝对目录 |
| `MUSE_SSH_HOST_FINGERPRINT` | Variable | 经可信服务器终端核验的 ED25519 `SHA256:…` 指纹 |
| `MUSE_BASE_URL` | Variable | 服务器回环 API，默认 `http://127.0.0.1:8788` |
| `MUSE_SSH_PRIVATE_KEY` | Secret | 与服务器授权公钥对应的完整 SSH 私钥；当前实现不支持加密私钥的口令交互 |

已有 Actions 的兼容名称：私钥可用 `SSH_PRIVATE_KEY` 或 `SSH_KEY`；主机可用 `SSH_HOST` 或 `HOST`；用户可用 `SSH_USER` 或 `USERNAME`；端口可用 `SSH_PORT` 或 `PORT`；目录可用 `DEPLOY_PATH`。上述旧名称按 secrets 读取；新的明确命名变量/密钥优先。不要在无法读取旧 Secret 的情况下假设它正确或要求用户把它贴出来。

如果没有可复用的密钥，由服务器操作者准备独立的 GitHub Actions 维护密钥、公钥追加到正确用户；私钥通过 GitHub 安全设置录入。它与正在撤销的 `codex-muse-quota-maintenance` 公钥不同，不要为此加回已撤销的 Codex 公钥，不删除原有公钥。

## 自动准备 GitHub 配置

`scripts/configure_github_ssh.py` 可以检查或准备上述配置，无需在服务器安装新软件。它通过官方 GitHub API 使用已有认证；若提供 `GH_TOKEN`/`GITHUB_TOKEN`，仅从环境读取，不写文件或日志。源码 Git 认证不代表拥有 API 管理权限，API 需要目标仓库管理员权限及相应 environments、variables、secret 元数据访问权限。不要把令牌发到聊天。

在仓库外创建本地 JSON，包含 `repository` 和上表六个非敏感变量，不放 SSH 私钥。先检查，再应用：

```bash
python3 scripts/configure_github_ssh.py --config /安全的本地目录/github-settings.json
python3 scripts/configure_github_ssh.py --config /安全的本地目录/github-settings.json --apply
```

首次应用创建 `server-maintenance`，仅允许 main 分支，要求个人仓库所有者审批；更新环境变量后重新读取确认。已有环境的审批规则、分支限制和密钥不会被覆盖；规则过宽或缺少审批时报告 pending，交由管理员检查。脚本只查询 SSH Secret 的名称，不读取内容、不生成或上传私钥、不派发 Actions、不接触服务器。Secret 存在仍不代表密钥匹配，需要之后真实运行验证。

若 API 被云网络策略拒绝，先在云环境配置开放 `api.github.com` 并保存生效，再检查 API 身份和管理权限；不要绕过代理。配置草稿保存不等于当前实例已获得访问权限。

## 实际执行行为

- 只允许手动触发 main，使用环境审批；没有 push、PR 或定时任务触发。checkout 固定到已核验的 v4.2.2 提交，GITHUB_TOKEN 仅 contents:read，不写入 Git 凭据。
- 先取得服务器 ED25519 公钥，计算 SHA-256 指纹，与可信配置严格比较；不匹配时不会进行密钥认证。不使用 `StrictHostKeyChecking=no`。
- 私钥仅写入 GitHub 执行机的私有临时目录，文件 600；不放入命令参数，不上传服务器，不传给子进程环境，结束后清除。
- SSH 认证后确认实际用户。在服务器新建私有 `/tmp/muse-quota-gh-inspect.XXXXXXXX`，仅上传三个检查源码文件；不复制到现有部署目录。
- 查询已有回环 API 的 GET、必要的 systemd 元数据，以及固定运行源码的哈希/Git 身份。只读取缓存额度，不登录、不刷新、不发 Muse 请求。若原部署目录对当前用户不可读，磁盘身份 pending，不自动改权限。
- 将现有服务的启动身份与磁盘身份分开记录。旧服务缺 `/api/deployment` 时该项 pending，不为获取版本强制重启。Node 不可用时磁盘身份也 pending，不安装 Node。
- 公开 Actions 日志仅输出执行器开关、任务按状态计数、账号数量/占用数量、服务是否活跃与目录是否匹配、提交和源码指纹。没有任务/账号 ID、提示词、具体额度、环境变量、Cookie 或 OAuth 信息。
- 执行器未关闭、任务尚未结束、账号浏览器占用、API 不可确认或 unit 目录不匹配时检查失败。即使只读检查成功，`backup_verified=false` 和 `update_authorized=false` 仍保持。
- 结束时只删除自己新建且通过路径校验的临时检查目录，不清理现有 data、work、.env 或会话。清理失败如实 pending。

## 如何认定连接成功

至少取得一次实际 Actions run：`host_key_verified=true`、`ssh_authenticated=true`，并返回现有服务器服务检查结果。若服务版本项 pending，单独保留；不要把工作流文件存在、密钥已配置、GitHub 的绿勾或本地夹具通过直接写成所有实机验收成功。

常见失败是没有配置 SSH Secret、指纹不匹配、SSH 认证失败、服务器网络/安全组拒绝、环境审批未完成，或工作流尚未提交 main。GitHub 托管执行机来源不同于 Muse；检查现有 SSH 访问规则，不清空防火墙，也不公开管理 API。

2026-10-10 的最新实际检查中，源码 Git 读写、仓库元数据读取和草稿 PR 创建成功；创建维护环境及读取 Actions Secret 名称返回 HTTP 403。重新查询确认维护环境尚未创建，旧 SSH Secret 是否存在未知。Git/PR 权限不代表环境、Secret 或 Actions 管理权限，不能将先前网络拒绝误报为当前所有 API 不通。

需要补充 API 权限时，在云环境的安全 Secret 设置填写 `GH_TOKEN`，通过已允许的 `api.github.com` 注入认证；不要在源码、本地 JSON 或聊天中粘贴令牌。可在 GitHub **Settings → Developer settings → Personal access tokens → Fine-grained tokens** 创建仅限此仓库的短期令牌，给予环境配置读写、Secret 元数据读取及之后手动 Actions 所需权限。保存生效后先重复只读检查，再继续配置。私钥仍留在 GitHub Actions Secret，API 令牌和 SSH 密钥是两个不同的凭据。

## 开发验证

```bash
python3 -m unittest discover -s scripts -p 'test_*.py' -v
```

SSH 测试用模拟工具输出验证指纹、密钥不泄露、命令参数校验和精确临时目录清理；服务检查测试使用本地假 API。真实 GitHub→服务器连接仍 pending，需按配置入口触发第一次任务。
