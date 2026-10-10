# 从工作区接入现有 Ubuntu 服务

GitHub 同步只更新当前代码检出。服务器上的进程可能从另一目录、复制部署或容器运行；先核实运行实例，再决定更新方式。现网数据和服务配置不通过源码包覆盖。

## 当前已知与连接条件

用户提供了公网服务器地址及 SSH 目标。主机、用户名、私钥、公钥安装状态和实际部署目录属于本地运维记录，不写入此公开文档。SSH 用户名区分大小写，应由服务器上的 `id -un` 核实。

当前托管环境没有通用互联网 SSH 出口。平台的原始 TCP CONNECT 通道用于已授权的私网地址，需要平台侧 Tailscale VPN 和精确 TCP 域名或 CIDR 授权；公网 IP 不能直接当作这个通道的私网目标。不要通过关闭代理、修改本地网络策略文件或安装工作区内 Tailscale 来绕过限制。

推荐由已能操作服务器的 Muse 完成服务器侧检查，操作者在环境设置中配置平台 VPN 和 TCP 授权。原始 TCP 不注入代理凭据，SSH 需要真实密钥文件和服务器授权公钥。既有 GitHub/Google 代理凭据不能用作 SSH 私钥。

服务器侧只读检查：

```bash
id -un
command -v tailscale
tailscale ip -4
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

若没有 Tailscale，由服务器操作者按官方 Ubuntu 安装与登录说明配置，并在平台环境设置中接入同一 Tailnet；不要自行削弱 SSH 或防火墙。只授权目标服务器的域名或单个地址。TCP 授权变更需要使用新配置版本创建替换环境；保存草稿不等于运行通道已生效。SSH 主机指纹应通过已有可信的服务器终端核验，不关闭 host-key 验证。

维护用公钥由工作区生成，私钥留在仓库外的私有目录。让服务器操作者将公钥**追加**到确认过的维护用户 `authorized_keys`，保留所有既有条目；不得发送私钥、删除旧公钥或修改其他微信服务。配置生效后，维护代理通过授权 CONNECT 转发建立 SSH，先运行只读命令核实身份和目录。

## 运行实例版本识别

新版 Node 服务提供只读 `GET /api/deployment`，报告启动时捕获的：

- `service_root`：加载 server.mjs 的真实根目录；`process_cwd` 可能与它不同。
- `source_kind=git_checkout`：根目录自身有有效 Git 元数据，附 `source_commit` 和 `runtime_modified`。
- `source_kind=source_bundle`：运行文件符合 HANDOFF-MANIFEST.json 中的哈希，版本来自清单声明。
- `source_kind=unversioned_copy`：缺少有效 Git 或可校验清单，不能凭 git pull 或文件夹名称确定版本。
- `runtime_sha256`：固定运行文件集合的哈希指纹，不读取 .env、data/、work/ 或凭据。

这份身份在服务启动时捕获。更新磁盘源码不会使旧进程报告新版本；运行中的代码需要在任务结束、备份完成后受控重启才更新。清单哈希证明运行文件与清单相符，不单独证明源码来自某个 GitHub 提交。`runtime_modified=true` 表示提交上还有本地修改，不能把提交号当作完整代码身份。

源码包生成器现在在清单中记录来源提交和未提交修改标记。不要手写一个提交号冒充校验结果。旧包缺少来源提交时保留 unknown；Docker 中未附带清单/Git 时按复制部署报告指纹。

## 只读巡检

在服务器上或经过 SSH 的回环转发运行：

```bash
python3 scripts/live_status.py --base-url http://127.0.0.1:8788
```

如果知道实际 systemd unit 名称，可以添加 `--service 实际名称.service`。只查询 ActiveState、SubState、WorkingDirectory、ExecMainPID 等必要元数据，不输出 Environment 或 ExecStart 中的参数，也不猜测或重启 unit。

巡检只使用 GET，报告实例版本、执行器开关、任务状态、缓存额度及账号浏览器是否占用。不登录、不探测真实 Muse、不刷新 Google 授权、不读取消息正文、不重放微信消息。旧服务没有版本端点时标记 pending；不要为了取得版本信息直接重启。

退出状态 0 的 `idle_snapshot` 仅表示观察时已关闭执行器且未发现运行/待暂停/人工检查任务或浏览器占用；它不代表备份完成，也不自动授权更新。退出 1 时查看 `pre_update.reasons`；执行器关闭但任务仍在暂停中，仍阻止更新。网络失败或身份信息不完整时保持 pending。

## 实机维护顺序

1. 记录可信 SSH 身份、实际服务根目录、当前版本与 unit；确认 wechat-mengmeng 独立服务不受操作影响。
2. 执行器保持关闭。检查原任务和出站记录；状态不确定时先查看原 Muse 会话，不创建替代任务或重发旧请求。
3. 核实没有运行任务及浏览器占用，备份 .env、完整 data/、work/、外置 Google 凭据和实际 unit/环境配置。SQLite 使用一致性备份，不能把运行中的 DB 主文件单独拷走；备份放私有目录并记录校验。
4. Git 检出可在保留本地改动的前提下快进至确定提交。复制部署先核对源码清单，再仅更新受控源码文件；不删除/覆盖运行数据，不用 rsync --delete 覆盖整个项目。
5. 用锁文件安装依赖并运行项目检查。通过后再受控重启账号池进程，查看它报告的启动身份，确认执行器依然关闭；保留现有微信服务。
6. OAuth 和账号额度实际检查单独记录；账号 1 旧请求先查看，不能盲目重复提交。
7. 真实 1→2 任务准备完后报告，等待用户通过微信明确发送“开始执行”。此前验收记录不能替代本轮实测。
