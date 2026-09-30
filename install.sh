#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/netpath"
STATE_DIR="/var/lib/netpath"
ETC_DIR="/etc/netpath"
SERVICE_NAME="netpath.service"

if [[ "$(uname -s)" != "Linux" ]]; then
  printf '此安装脚本仅支持 Linux。\n' >&2
  exit 1
fi
if [[ "$(id -u)" -ne 0 ]]; then
  printf '请使用 root 运行: sudo bash install.sh\n' >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  printf '需要 systemd 才能安装为服务。\n' >&2
  exit 1
fi

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p 'Number(process.versions.node.split(".")[0])')"
    if (( major >= 20 )); then return; fi
  fi
  printf '正在安装 Node.js 22...\n'
  local bootstrap
  bootstrap="$(mktemp)"
  trap 'rm -f "$bootstrap"' EXIT
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y curl ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_22.x -o "$bootstrap"
    bash "$bootstrap"
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y curl ca-certificates
    curl -fsSL https://rpm.nodesource.com/setup_22.x -o "$bootstrap"
    bash "$bootstrap"
    dnf install -y nodejs
  else
    printf '未找到 apt-get 或 dnf，请先安装 Node.js 20+。\n' >&2
    exit 1
  fi
  local installed_major
  installed_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if (( installed_major < 20 )); then
    printf 'Node.js 版本低于 20。\n' >&2
    exit 1
  fi
}

if [[ -n "${NETPATH_ROLE:-}" ]]; then
  role="$NETPATH_ROLE"
else
  printf '选择本机节点类型:\n  1) 国内管理节点（网页与监控）\n  2) 国外测速节点\n'
  read -r -p '输入 1 或 2: ' choice
  case "$choice" in
    1) role=domestic ;;
    2) role=overseas ;;
    *) printf '无效选择。\n' >&2; exit 1 ;;
  esac
fi
if [[ "$role" != "domestic" && "$role" != "overseas" ]]; then
  printf 'NETPATH_ROLE 只能是 domestic 或 overseas。\n' >&2
  exit 1
fi

if [[ -f "$ETC_DIR/node.env" ]]; then
  existing_role="$(sed -n 's/^NETPATH_ROLE=//p' "$ETC_DIR/node.env" | head -n 1)"
  if [[ -n "$existing_role" && "$existing_role" != "$role" ]]; then
    printf '本机已安装 %s 节点。请先处理现有安装。\n' "$existing_role" >&2
    exit 1
  fi
fi

default_port=8787
if [[ "$role" == "overseas" ]]; then default_port=8788; fi
ensure_node
if [[ -f "$INSTALL_DIR/$role/config.json" ]]; then
  default_port="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).server.port' "$INSTALL_DIR/$role/config.json")"
fi
if [[ -n "${NETPATH_PORT:-}" ]]; then
  chosen_port="$NETPATH_PORT"
else
  read -r -p "监听端口 [$default_port]: " chosen_port
  chosen_port="${chosen_port:-$default_port}"
fi
if [[ ! "$chosen_port" =~ ^[0-9]+$ ]] || (( chosen_port < 1 || chosen_port > 65535 )); then
  printf '端口必须在 1-65535 之间。\n' >&2
  exit 1
fi

if ! id netpath >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin netpath
fi
install -d -m 0755 "$INSTALL_DIR" "$ETC_DIR"
install -d -m 0700 -o netpath -g netpath "$STATE_DIR"
install -d -m 0755 "$INSTALL_DIR/$role" "$INSTALL_DIR/linux"
cp -a "$SOURCE_DIR/${role}-server/server.js" "$SOURCE_DIR/${role}-server/package.json" "$INSTALL_DIR/$role/"
if [[ "$role" == "domestic" ]]; then
  cp -a "$SOURCE_DIR/domestic-server/src" "$SOURCE_DIR/domestic-server/public" "$INSTALL_DIR/domestic/"
  if [[ ! -f "$INSTALL_DIR/domestic/config.json" ]]; then
    cp "$SOURCE_DIR/domestic-server/config.json" "$INSTALL_DIR/domestic/config.json"
  fi
else
  if [[ ! -f "$INSTALL_DIR/overseas/config.json" ]]; then
    cp "$SOURCE_DIR/overseas-server/config.json" "$INSTALL_DIR/overseas/config.json"
  fi
fi
cp "$SOURCE_DIR/linux/configure.mjs" "$INSTALL_DIR/linux/configure.mjs"

config_path="$INSTALL_DIR/$role/config.json"
settings_path="$STATE_DIR/settings.json"
NETPATH_PORT="$chosen_port" node "$INSTALL_DIR/linux/configure.mjs" install "$role" "$config_path" "$settings_path"
chown -R root:root "$INSTALL_DIR"
chmod 0640 "$config_path"
chgrp netpath "$config_path"
if [[ "$role" == "domestic" ]]; then
  chown netpath:netpath "$settings_path"
  chmod 0600 "$settings_path"
fi

printf 'NETPATH_ROLE=%s\nSETTINGS_FILE=%s\n' "$role" "$settings_path" > "$ETC_DIR/node.env"
chmod 0644 "$ETC_DIR/node.env"
cat > "/etc/systemd/system/$SERVICE_NAME" <<UNIT
[Unit]
Description=Network Path Observer ($role)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=netpath
Group=netpath
WorkingDirectory=$INSTALL_DIR/$role
EnvironmentFile=$ETC_DIR/node.env
ExecStart=$(command -v node) $INSTALL_DIR/$role/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$STATE_DIR

[Install]
WantedBy=multi-user.target
UNIT

install -m 0755 "$SOURCE_DIR/linux/netpath.sh" /usr/local/bin/netpath
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
printf '\n安装完成。\n节点类型: %s\n监听端口: %s\n管理命令: netpath\n' "$role" "$chosen_port"
if [[ "$role" == "domestic" ]]; then
  printf '后台地址: http://服务器IP:%s/admin\n监控地址: http://服务器IP:%s/\n' "$chosen_port" "$chosen_port"
else
  printf '测速探针地址: http://服务器IP:%s\n' "$chosen_port"
fi
