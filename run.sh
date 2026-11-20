#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v uv &>/dev/null; then
    echo "错误: 未找到 uv，请先安装 uv 后重试"
    exit 1
fi

exec uv run python main.py
