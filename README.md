# 链路观察台

在两台服务器上分别安装管理节点和测速节点。管理节点提供网页后台、实时监控，以及“本地 ↔ 管理节点”和“管理节点 ↔ 测速节点”的按需带宽测试；测速节点提供受令牌保护的测速探针。节点名称按用途区分，可部署在任意地域。需要 Node.js 20+，安装脚本可在 Debian/Ubuntu 或使用 dnf 的发行版上自动安装 Node.js 22。

## 本地演示

在项目根目录运行 `node scripts/preview.mjs`，终端会显示本地后台地址和演示账号。演示包含两台可切换的本机探针，节点编辑、连通性测试和带宽测试均可操作。演示数据保存在系统临时目录，按 Ctrl+C 停止并清理，不影响正式配置。

## Linux 安装

在两台 Linux 服务器上分别安装。若服务器可以访问 GitHub 仓库，推荐先克隆再运行：

```bash
git clone https://github.com/bunnya33/overseas-server.git
cd overseas-server
sudo ./install.sh
```

已经克隆过项目时，在项目目录执行 `sudo bash install.sh` 即可。不要使用旧版本的 `sh install.sh`；旧脚本中的 `pipefail` 需要 Bash。更新到新版后，`sudo sh install.sh` 也会自动转用 Bash。

也提供一行 `curl` 命令，但部分网络无法访问 `raw.githubusercontent.com`；遇到 `curl: (52) Empty reply from server` 时请使用上面的 Git 克隆方式：

```bash
curl -fsSL https://raw.githubusercontent.com/bunnya33/overseas-server/main/bootstrap.sh | sudo bash
```

引导脚本需要 `curl`、`tar` 和交互终端；下载归档失败时会尝试使用 `git clone`。两种方式都会提示选择本机节点类型和监听端口。

安装时选择：

- `1` 管理节点，默认监听 `8787`。
- `2` 测速节点，默认监听 `8788`。

安装脚本会询问监听端口、创建 `netpath` 系统账号、生成管理员密码或探针令牌、注册并启动 `netpath.service`。首次安装时请记录终端显示的密码或令牌；重新运行单命令或安装脚本会保留原有后台账号、服务器列表和探针令牌。执行单命令安装会以 root 权限运行 GitHub 仓库中的代码，请先确认仓库来源可信。

安装后运行 `sudo netpath` 打开管理菜单。也可以直接使用：

```bash
sudo netpath status
sudo netpath restart
sudo netpath logs
sudo netpath port
sudo netpath password  # 管理节点：重设后台密码
sudo netpath token     # 测速节点：重设测速令牌
sudo netpath show-token # 测速节点：查看现有测速令牌
```

程序位于 `/opt/netpath`，管理节点保存的节点列表与账号位于 `/var/lib/netpath/settings.json`，systemd 服务名为 `netpath.service`。安装脚本不会自动修改防火墙，请自行放行管理节点的网页端口，并只允许管理节点访问测速节点的探针端口。

## 在后台配置服务器

打开 `http://管理节点IP:管理端口/admin`，使用安装时显示的 `admin` 账号和密码登录。在“服务器节点”中添加测速节点：

- 测速节点 IP / 域名：填写测速节点服务器的公网地址。
- 探测端口：只测试两台服务器之间的连通性时，填写测速节点的探针监听端口，默认 `8788`。如需测试其他服务端口，也可改填该端口。
- 探测协议：探针端口选 TCP；目标服务确实提供 TLS 时才选 TLS。
- 测速探针地址：填写测速节点的完整基础地址，例如 `http://测速节点IP:8788`，不要追加 `/api/health`。
- 测速令牌：填写测速节点安装时生成的令牌；忘记时在测速节点运行 `sudo netpath show-token` 查看。

可以保存多台测速节点。“设为当前”会立即切换监控页和节点间带宽测试使用的节点，其他配置保留。后台还提供单节点连通性测试、编辑、删除和修改管理员密码。浏览器访问 `http://管理节点IP:管理端口/` 查看实时监控。带宽测试需先登录后台，同一浏览器即可操作。

观察台会将链路图、延迟卡片、图例和带宽标题中的测速节点名称替换为当前保存的节点名称，例如“管理节点 → 东京”。管理节点名称读取 `config.json` 中的 `dashboard.relayName`。故障时间线按浏览器所在时区显示完整的 `YYYY-MM-DD HH:mm:ss` 日期和时间。

观察台新增“近期连接记录”和“近期带宽记录”：当前浏览器按节点分别保留最近 30 次连接监测、最近 10 次手动测速，刷新后仍会保留，切换节点后显示对应记录；更改节点探测地址或端口会使用独立记录。失败记录保留在列表中，延迟、下载和上传的平均值分别只计算有效结果，节点间重复的同一次采样不会重复计入。记录保存在浏览器本地，不会上传到服务器或同步到其他浏览器；浏览器禁止本地存储时仅保留当前页面中的记录。

点击“复制统计结果”会同时复制当前节点的连接与带宽统计，包含实际测试次数、平均值和有效样本数。纯文本使用固定列宽，并按中文字符宽度补空格；较长名称会换行而不挤乱数值列。在 Word 等支持富文本的文档中保留源格式粘贴，可保留对齐的表格；纯文本请使用等宽字体，例如等距更纱黑体或宋体。普通比例字体、Markdown 或 HTML 正文可能合并空格，无法保证纯文本对齐。“查看可复制的统计结果”提供预览和手动复制入口。

如果修改了测速节点监听端口，还需在管理后台更新探测端口和测速探针地址。若重设了测速节点令牌，也需同步更新管理后台保存的测速令牌。

## 测试路径

```text
本地浏览器 ── HTTP 延迟/带宽 ──> 管理节点
                                      │
                                      ├── TCP/TLS 建连 ──> 测速节点探测端口
                                      └── HTTP 带宽 ─────> 测速节点探针
```

持续监控每 3 秒采样当前节点，显示延迟、抖动、采样失败率、DNS、TCP/TLS 建连和故障时间线。带宽测试由用户手动触发，单次传输数据量受配置限制。若希望“本地 → 管理节点”反映直连质量，应让管理节点的仪表盘域名在 Clash 中走 `DIRECT`。探针连通不等于 VPN 握手或 HAProxy 转发正常；要测试 HAProxy 实际转发路径，应将测速探针也通过该路径转发。

## 手动运行与开发

管理节点（源码目录 `domestic-server`）：

```bash
cd domestic-server
npm start
```

首次启动会在终端打印随机管理员密码。打开 `/admin` 添加测速节点。监听端口在 `domestic-server/config.json` 的 `server.port` 修改。节点列表和当前选中项写入 `domestic-server/data/settings.json`；此文件不应纳入版本控制。

测速节点（源码目录 `overseas-server`）：

```bash
cd overseas-server
```

先修改 `config.json` 的 `security.token`，不要使用示例占位令牌，然后执行 `npm start`。监听端口在同一文件的 `server.port` 修改。

两个目录可分别运行 `npm test`。安装脚本支持通过 `NETPATH_ROLE=domestic`（管理节点）或 `NETPATH_ROLE=overseas`（测速节点）以及 `NETPATH_PORT=端口` 在非交互模式下指定节点类型和端口。

公网访问管理后台建议经 HTTPS 反向代理；测速节点令牌也应通过 HTTPS 或受限网络传输。
