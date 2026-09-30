# 链路观察台

在国内中转机和国外服务器分别安装对应节点。国内节点提供实时监控、管理后台和本地到国内、国内到国外的按需带宽测试；国外节点提供受令牌保护的测速探针。需要 Node.js 20+，安装脚本可在 Debian/Ubuntu 或使用 dnf 的发行版上自动安装 Node.js 22。

## 本地演示

在项目根目录运行 `node scripts/preview.mjs`，终端会显示本地后台地址和演示账号。演示包含两台可切换的本机探针，节点编辑、连通性测试和带宽测试均可操作。演示数据保存在系统临时目录，按 Ctrl+C 停止并清理，不影响正式配置。

## Linux 安装

在两台 Linux 服务器上分别运行同一条命令，按提示选择本机节点类型和监听端口：

```bash
curl -fsSL https://raw.githubusercontent.com/bunnya33/overseas-server/main/bootstrap.sh | sudo bash
```

该命令需要 `curl`、`tar` 和交互终端；引导脚本会下载完整项目并运行安装脚本。也可以手动获取项目再安装：

```bash
git clone https://github.com/bunnya33/overseas-server.git
cd overseas-server
sudo bash install.sh
```

安装时选择：

- `1` 国内管理节点，默认监听 `8787`。
- `2` 国外测速节点，默认监听 `8788`。

安装脚本会询问监听端口、创建 `netpath` 系统账号、生成管理员密码或探针令牌、注册并启动 `netpath.service`。首次安装时请记录终端显示的密码或令牌；重新运行单命令或安装脚本会保留原有后台账号、服务器列表和探针令牌。执行单命令安装会以 root 权限运行 GitHub 仓库中的代码，请先确认仓库来源可信。

安装后运行 `sudo netpath` 打开管理菜单。也可以直接使用：

```bash
sudo netpath status
sudo netpath restart
sudo netpath logs
sudo netpath port
sudo netpath password  # 国内节点：重设后台密码
sudo netpath token     # 国外节点：重设测速令牌
```

程序位于 `/opt/netpath`，国内节点列表与账号保存在 `/var/lib/netpath/settings.json`，systemd 服务名为 `netpath.service`。安装脚本不会自动修改防火墙，请自行放行国内管理端口，并只允许国内服务器访问国外探针端口。

## 在后台配置服务器

打开 `http://国内服务器IP:管理端口/admin`，使用安装时显示的 `admin` 账号和密码登录。在“服务器节点”中添加国外服务器：

- 服务器地址和 VPN 端口：填写国内 HAProxy 实际连接的国外服务端点。
- 探测协议：VPN 端口为普通 TCP 服务时选 TCP；确实提供 TLS 时选 TLS。
- 测速探针地址：填写国外节点地址，例如 `http://国外服务器IP:8788`。
- 测速令牌：填写国外安装时生成的令牌。

可以保存多台国外服务器。“设为当前”会立即切换监控页和跨境带宽测试使用的节点，其他配置保留。后台还提供单节点连通性测试、编辑、删除和修改管理员密码。浏览器访问 `http://国内服务器IP:管理端口/` 查看实时监控。带宽测试需先登录后台，同一浏览器即可操作。

如果修改了国外节点监听端口，还需在国内后台更新对应节点的测速探针地址。若重设了国外令牌，也需同步更新国内后台保存的测速令牌。

## 测试路径

```text
本地浏览器 ── HTTP 延迟/带宽 ──> 国内管理节点
                                      │
                                      ├── TCP/TLS 建连 ──> 国外 VPN 端口
                                      └── HTTP 带宽 ─────> 国外测速探针
```

持续监控每 3 秒采样当前节点，显示延迟、抖动、采样失败率、DNS、TCP/TLS 建连和故障时间线。带宽测试由用户手动触发，单次传输数据量受配置限制。若希望“本地 → 国内”反映直连质量，应让国内仪表盘域名在 Clash 中走 `DIRECT`。测试路径只覆盖配置的连接端点；要测试 HAProxy 实际转发路径，应将测速探针也通过该路径转发。

## 手动运行与开发

国内节点：

```bash
cd domestic-server
npm start
```

首次启动会在终端打印随机管理员密码。打开 `/admin` 添加国外节点。监听端口在 `domestic-server/config.json` 的 `server.port` 修改。节点列表和当前选中项写入 `domestic-server/data/settings.json`；此文件不应纳入版本控制。

国外节点：

```bash
cd overseas-server
```

先修改 `config.json` 的 `security.token`，不要使用示例占位令牌，然后执行 `npm start`。监听端口在同一文件的 `server.port` 修改。

两个目录可分别运行 `npm test`。安装脚本支持通过 `NETPATH_ROLE=domestic|overseas` 和 `NETPATH_PORT=端口` 在非交互模式下指定节点类型和端口。

公网访问管理后台建议经 HTTPS 反向代理；国外测速令牌也应通过 HTTPS 或受限网络传输。
