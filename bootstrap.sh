#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  printf '此安装命令仅支持 Linux。\n' >&2
  exit 1
fi
if [[ "$(id -u)" -ne 0 ]]; then
  printf '请使用 curl ... | sudo bash 运行。\n' >&2
  exit 1
fi
for command_name in curl tar mktemp; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '缺少 %s，请先安装后重试。\n' "$command_name" >&2
    exit 1
  fi
done

if { exec 3</dev/tty; } 2>/dev/null; then
  input_fd=3
elif [[ -n "${NETPATH_ROLE:-}" && -n "${NETPATH_PORT:-}" ]]; then
  input_fd=0
else
  printf '未找到交互终端。请在终端运行，或同时设置 NETPATH_ROLE 和 NETPATH_PORT。\n' >&2
  exit 1
fi

work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT
mkdir "$work_dir/source"

printf '正在下载链路观察台...\n'
if curl -fsSL --retry 3 --retry-delay 1 \
  https://github.com/bunnya33/overseas-server/archive/refs/heads/main.tar.gz \
  -o "$work_dir/source.tar.gz" && tar -tzf "$work_dir/source.tar.gz" >/dev/null 2>&1; then
  tar -xzf "$work_dir/source.tar.gz" -C "$work_dir/source" --strip-components=1
elif command -v git >/dev/null 2>&1; then
  printf '归档下载失败，改用 Git 获取项目...\n'
  git clone --depth 1 https://github.com/bunnya33/overseas-server.git "$work_dir/source"
else
  printf '下载失败。请安装 git 后重新运行，或手动克隆仓库。\n' >&2
  exit 1
fi
if [[ ! -f "$work_dir/source/install.sh" ]]; then
  printf '下载的项目中缺少 install.sh。\n' >&2
  exit 1
fi

if [[ "$input_fd" -eq 3 ]]; then
  bash "$work_dir/source/install.sh" <&3
else
  bash "$work_dir/source/install.sh" </dev/null
fi
