# 喜马拉雅音频下载与解密工具

支持通过本机客户端下载 XM 或 M4A、复用客户端初始登录态独立下载 M4A、解密本地 XM，以及整理为 Audiobookshelf 多碟有声书。

- [客户端下载说明](README-客户端下载.md)：客户端或独立下载、音质选择与断点续跑。
- [配置与整理说明](README-配置式使用说明.md)：本地解密、续跑与音频整理。

## 独立下载快速开始

先在本机喜马拉雅登录并正常退出，需要安装 Google Chrome：

```sh
node download-independent.cjs 专辑ID ./xm-downloads 1
```

初始会话从客户端读取，随后关闭客户端独立下载固定档位 2 的 M4A，结束后恢复普通启动。第三个参数为最多新增集数，改为 `0` 下载全专辑；Cookie 仅在内存使用。完整参数见 [下载说明](README-客户端下载.md#独立下载-m4a)。

## 本地解密快速开始

1. 安装 [uv](https://docs.astral.sh/uv/getting-started/installation/)。
2. 复制 `config.example.json` 为 `config.json`，按照 [配置式使用说明](README-配置式使用说明.md) 修改输入输出路径。本机配置不提交版本控制。
3. 在项目根目录执行：

```bash
uv run python main.py
```

macOS / Linux 也可以使用启动脚本；脚本会自动切换到项目目录：

```bash
./run.sh
```

uv 会根据 `.python-version` 选择 Python 3.9，自动创建 `.venv` 并安装 `uv.lock` 中锁定的依赖，无需激活虚拟环境。缺少对应 Python 时，uv 会自动下载。

## 配置与输出

程序没有交互菜单或文件选择窗口，所有输入输出均通过 `config.json` 指定。

解密结果按 `输出目录/专辑名/标题.格式` 保存。同名且内容不同的文件会报错并保留原文件；同名且内容完全相同的文件会被接受并记录进度。

直接运行 `uv run python main.py` 时，请位于项目根目录；配置、WASM 和相对输入输出路径均相对于当前工作目录。

## 一键解密归档

```bash
uv run python archive.py "下载完成的XM专辑目录" --book "书名"
```

自动检查集号连续性、重复和空文件，将正文与番外分别归档，每碟 200 集，最后用 FFmpeg 全长解码校验。需安装 `ffmpeg`（macOS: `brew install ffmpeg`）。

解密时直接写入 `abs-library/书名（正文或番外）/CD N/`，只保存一份解密音频，不产生 `output/` 中间副本；原 XM 保留。中断后重新运行相同命令即可，已完成音频会校验后跳过解密，全长解码校验会重新执行。

集号连续不代表与平台发布总数一致，末尾缺失需要对照平台总集数确认。自动区分以“番外”开头的文件名，其他特殊篇章需人工检查。

## Audiobookshelf 整理

解密后可使用 `uv run python organize.py --source "./output/专辑名" --destination "./abs-library" --dry-run` 预览多碟整理。确认后去掉 `--dry-run` 执行，详见 [整理说明](README-配置式使用说明.md#整理为-audiobookshelf-有声书)。

## 依赖与环境

依赖在 `pyproject.toml` 中声明，精确版本由 `uv.lock` 管理。当前保留 Python 3.9 和 Wasmer 1.1.0，以兼容现有解密实现；并非所有操作系统和 CPU 都有可用的 Wasmer 二进制包。

`python-magic` 还依赖系统的 libmagic。macOS 若提示找不到 libmagic，可执行 `brew install libmagic`；Debian / Ubuntu 可安装 `libmagic1`。

仅安装环境、不运行解密：

```bash
uv sync
```

更新某个依赖后应重新验证解密，并提交更新后的 `uv.lock`。如需兼容旧的 pip 工作流，可通过下面的命令重新导出 `requirements.txt`：

```bash
uv export --no-hashes --no-emit-project --format requirements-txt --output-file requirements.txt
```

## 项目文件

- `main.py`：配置读取和音频解密。
- `xm_encryptor.wasm`：解密所需的 WASM 模块，不能移除。
- `config.json`：本地输入输出配置。
- `pyproject.toml`、`.python-version`、`uv.lock`：依赖和 Python 版本。
- `run.sh`：macOS / Linux 启动脚本。
- `.venv/`：uv 创建的虚拟环境，不提交版本控制。
