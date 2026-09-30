#!/usr/bin/env bash
set -euo pipefail

ETC_FILE=/etc/netpath/node.env
INSTALL_DIR=/opt/netpath
SERVICE=netpath.service

if [[ "$(id -u)" -ne 0 ]]; then
  printf '请使用 sudo netpath 运行。\n' >&2
  exit 1
fi
if [[ ! -f "$ETC_FILE" ]]; then
  printf '尚未安装链路观察台。\n' >&2
  exit 1
fi
source "$ETC_FILE"
role="$NETPATH_ROLE"
role_label='管理节点'
if [[ "$role" == "overseas" ]]; then role_label='测速节点'; fi
config_path="$INSTALL_DIR/$role/config.json"
settings_path="${SETTINGS_FILE:-/var/lib/netpath/settings.json}"

show_info() {
  local port
  port="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).server.port' "$config_path")"
  printf '节点类型: %s\n监听端口: %s\n配置文件: %s\n' "$role_label" "$port" "$config_path"
  if [[ "$role" == "domestic" ]]; then
    printf '节点数据: %s\n后台: http://服务器IP:%s/admin\n' "$settings_path" "$port"
  else
    printf '探针: http://服务器IP:%s/api/health\n' "$port"
  fi
}

change_port() {
  local chosen_port
  read -r -p '新端口: ' chosen_port
  NETPATH_PORT="$chosen_port" node "$INSTALL_DIR/linux/configure.mjs" port "$role" "$config_path" "$settings_path"
  chgrp netpath "$config_path"
  chmod 0640 "$config_path"
  systemctl restart "$SERVICE"
}

reset_password() {
  if [[ "$role" != "domestic" ]]; then printf '仅管理节点支持此操作。\n'; return; fi
  local password
  read -r -s -p '新密码（留空则随机生成）: ' password
  printf '\n'
  NETPATH_PASSWORD="$password" node "$INSTALL_DIR/linux/configure.mjs" password domestic "$config_path" "$settings_path"
  chown netpath:netpath "$settings_path"
  systemctl restart "$SERVICE"
}

reset_token() {
  if [[ "$role" != "overseas" ]]; then printf '仅测速节点支持此操作。\n'; return; fi
  local token
  read -r -s -p '新令牌（留空则随机生成）: ' token
  printf '\n'
  NETPATH_TOKEN="$token" node "$INSTALL_DIR/linux/configure.mjs" token overseas "$config_path"
  chgrp netpath "$config_path"
  chmod 0640 "$config_path"
  systemctl restart "$SERVICE"
}

show_token() {
  if [[ "$role" != "overseas" ]]; then
    printf '仅测速节点支持此操作。\n' >&2
    return 1
  fi
  local token
  token="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).security.token' "$config_path")"
  printf '测速令牌: %s\n' "$token"
}

run_command() {
  case "$1" in
    start|stop|restart|status) systemctl "$1" "$SERVICE" ;;
    logs) journalctl -u "$SERVICE" -n 100 -f ;;
    port) change_port ;;
    password) reset_password ;;
    token) reset_token ;;
    show-token) show_token ;;
    info) show_info ;;
    *) printf '命令: netpath [start|stop|restart|status|logs|port|password|token|show-token|info]\n'; exit 1 ;;
  esac
}

if [[ $# -gt 0 ]]; then run_command "$1"; exit; fi

while true; do
  printf '\n链路观察台管理菜单\n'
  show_info
  printf '\n1. 启动服务  2. 停止服务  3. 重启服务  4. 服务状态\n5. 查看日志  6. 修改端口'
  if [[ "$role" == "domestic" ]]; then printf '  7. 重设后台密码\n'; else printf '  7. 重设探针令牌  8. 查看测速令牌\n'; fi
  printf '0. 退出\n'
  read -r -p '请选择: ' choice
  case "$choice" in
    1) run_command start ;;
    2) run_command stop ;;
    3) run_command restart ;;
    4) run_command status ;;
    5) run_command logs ;;
    6) run_command port ;;
    7) if [[ "$role" == "domestic" ]]; then run_command password; else run_command token; fi ;;
    8) if [[ "$role" == "overseas" ]]; then run_command show-token; else printf '无效选择。\n'; fi ;;
    0) exit 0 ;;
    *) printf '无效选择。\n' ;;
  esac
done
