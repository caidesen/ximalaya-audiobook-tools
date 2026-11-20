# 喜马拉雅音频下载与解密工具

下载喜马拉雅音频、解密本地 XM，并整理为 Audiobookshelf 多碟有声书。下载支持客户端模式和复用客户端初始登录态的独立 M4A 模式。

- [客户端下载说明](README-客户端下载.md)：客户端或独立下载、音质选择与断点续跑。
- [配置与整理说明](README-配置式使用说明.md)：本地解密、续跑与音频整理。

## 使用范围与免责声明

本项目仅供个人学习、研究和自用，用于整理本人已合法取得且获准处理的音频，不得用于商业用途。

- 仅使用本人账号及其正常权限。购买或订阅内容不代表取得复制、解密或传播等全部权利，请自行确认具体操作是否获得授权，并遵守适用法律及平台协议。
- 不得利用本工具绕过购买、会员或访问权限，不得上传、分享、出售或以其他方式传播未经授权的音频，也不得提供代下载等商业服务。
- 音频、文字、商标及第三方组件的权利归各自权利人所有。项目公开代码不构成对这些内容或组件的授权，作者不提供音频资源、账号或登录凭据。
- 工具按现状提供，不保证持续可用、兼容所有环境或处理结果完整。使用前请备份文件，妥善保管账号及会话信息，并了解脚本联网和处理本地文件的行为。
- 使用者应对自己的操作及其后果负责。在适用法律允许的范围内，作者不对使用本工具造成的数据丢失、账号异常或其他损失承担责任。

本说明用于明确使用范围和风险，不代替必要的权利授权，也不免除依法应承担的责任。

## 独立下载快速开始

下载功能依赖 macOS 商店版喜马拉雅客户端，目前已验证 4.0.13。独立下载还需要 Node.js 和 Google Chrome。

先在喜马拉雅中登录，再正常退出客户端，在项目根目录执行：

```sh
node download-independent.cjs 专辑ID ./xm-downloads 1
```

脚本读取客户端初始会话后关闭客户端，由 Node 下载固定档位 2 的 M4A，结束后恢复客户端普通启动。第三个参数限制本次新增集数，`0` 表示下载全专辑。Cookie 仅在内存使用。完整参数见 [下载说明](README-客户端下载.md#独立下载-m4a)。

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

本地解密通过 `config.json` 指定输入输出，不提供交互菜单或文件选择窗口。

解密结果按 `输出目录/专辑名/标题.格式` 保存。同名且内容不同的文件会报错并保留原文件；同名且内容相同的文件会补记进度。

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

本地解密依赖 Python 3.9 和 Wasmer 1.1.0。依赖声明在 `pyproject.toml`，版本锁定在 `uv.lock`；部分操作系统和 CPU 没有可用的 Wasmer 二进制包。

`python-magic` 还依赖系统的 libmagic。macOS 若提示找不到 libmagic，可执行 `brew install libmagic`；Debian / Ubuntu 可安装 `libmagic1`。

仅安装环境、不运行解密：

```bash
uv sync
```

更新某个依赖后应重新验证解密，并提交更新后的 `uv.lock`。使用 pip 时，可重新导出 `requirements.txt`：

```bash
uv export --no-hashes --no-emit-project --format requirements-txt --output-file requirements.txt
```

## 项目文件

- `download-xm.cjs`：通过客户端下载 XM 或 M4A。
- `download-independent.cjs`：复用客户端初始会话，独立下载 M4A。
- `sign-xm.cjs`：在隔离 Chrome 中运行签名 SDK。
- `main.py`：配置读取和音频解密。
- `archive.py`、`organize.py`：有声书归档与多碟整理。
- `xm_encryptor.wasm`：解密所需的 WASM 模块，不能移除。
- `config.json`：本地输入输出配置。
- `pyproject.toml`、`.python-version`、`uv.lock`：依赖和 Python 版本。
- `run.sh`：macOS / Linux 启动脚本。
- `.venv/`：uv 创建的虚拟环境，不提交版本控制。

## 上游来源与致谢

XM 解密部分基于 [sld272/Ximalaya-XM-Decrypt](https://github.com/sld272/Ximalaya-XM-Decrypt)，沿用其 `xm_encryptor.wasm`。感谢原作者的工作。上游 README 还列出了 @aynakeya 的解密原理博文，可从上游说明中查阅。

本仓库在此基础上增加了客户端下载、独立 M4A 下载、配置与依赖管理、断点续跑，以及 Audiobookshelf 归档整理功能。新增功能由本仓库维护。
