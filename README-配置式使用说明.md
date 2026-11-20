# 喜马拉雅音频解密工具 - 配置式版本

通过 `config.json` 指定输入输出，适合自动化和批处理。

## 配置文件说明

程序使用 `config.json` 文件来配置输入和输出参数。配置文件格式如下：

```json
{
    "input_files": [
        "/path/to/file1.xm",
        "/path/to/file2.xm"
    ],
    "input_directory": "/path/to/input/directory",
    "output_directory": "./output",
    "batch_mode": false
}
```

### 配置参数说明

- **input_files**: 要解密的单个文件列表（数组格式）
- **input_directory**: 批量解密时的输入目录路径
- **output_directory**: 解密后文件的输出目录
- **batch_mode**: 是否启用批量模式
  - `false`: 单文件模式，使用 `input_files` 中的文件列表
  - `true`: 批量模式，处理 `input_directory` 目录当前层的所有 `.xm` 文件（不递归子目录）

首次运行前请先安装 uv，详见 [uv 运行说明](README.md)。uv 会自动准备 Python 和依赖。

## 使用方法

### 1. 单文件模式

编辑 `config.json`：

```json
{
    "input_files": [
        "./audio1.xm",
        "./audio2.xm",
        "/absolute/path/to/audio3.xm"
    ],
    "output_directory": "./output",
    "batch_mode": false
}
```

### 2. 批量模式

编辑 `config.json`：

```json
{
    "input_directory": "./xm_files",
    "output_directory": "./decrypted_output",
    "batch_mode": true
}
```

### 3. 运行程序

```bash
# 使用自动化脚本
./run.sh

# 或在项目根目录使用 uv 运行
uv run python main.py
```

## 中断后继续

运行命令不变：

```bash
uv run python main.py
```

- 每个文件完成后，程序在输出目录的 `.progress/` 下保存进度，以源文件内容的 SHA-256 作为标识。
- 再次运行时，会校验已记录的输出文件；内容匹配就直接跳过解密，并单独统计跳过数量。
- 续跑以整份音频文件为单位。中断时正在处理的文件会重新处理，不从文件内部的字节位置续接。
- 输出先写到同目录临时文件，再原子发布到最终文件名，避免把半成品误认为完成。
- 输出缺失会重新生成；输出被修改或遇到不同内容的同名文件会报错，保留已有文件。需要重新生成时，请先备份或移走冲突文件。
- 旧输出或进度记录丢失时，会重新解密并比较内容：完全相同则补记进度，不同则报错。
- 保留原输出目录及 `.progress/` 即可续跑。更换输出目录将使用独立进度；扫描输入和校验内容仍需要读取文件。
- 写入依赖输出文件系统支持硬链接；不支持时会报错，不会退化成覆盖写入。

## 配置文件自动生成

如果 `config.json` 不存在，程序会自动创建一个默认配置文件：

```json
{
    "input_files": [],
    "input_directory": "",
    "output_directory": "./output",
    "batch_mode": false
}
```

您需要根据实际需求修改这个配置文件。

## 错误处理

程序会验证配置文件的有效性：

- 单文件模式下，检查 `input_files` 中的所有文件是否存在
- 批量模式下，检查 `input_directory` 是否存在
- 如果配置有误，程序会显示具体错误信息并退出

## 示例场景

### 场景1: 解密少量指定文件

```json
{
    "input_files": [
        "./downloads/song1.xm",
        "./downloads/song2.xm"
    ],
    "output_directory": "./my_music",
    "batch_mode": false
}
```

### 场景2: 批量处理整个目录

```json
{
    "input_directory": "./all_xm_files",
    "output_directory": "./decrypted",
    "batch_mode": true
}
```

## 注意事项

- 确保 `xm_encryptor.wasm` 文件与程序在同一目录下
- 配置文件使用UTF-8编码
- 路径可以使用相对路径或绝对路径
- 输出目录会自动创建（如果不存在）
- 本工具仅供学习交流使用，严禁用于商业用途

## 整理为 Audiobookshelf 有声书

解密后可运行独立整理命令，一次处理一部书。无需修改 `config.json`：

```bash
# 先预览：替换为实际的专辑目录和书名
uv run python organize.py \
  --source "./output/专辑名" \
  --destination "./abs-library" \
  --book "诡秘之主" \
  --dry-run

# 确认预览后，去掉 --dry-run 正式复制
uv run python organize.py \
  --source "./output/专辑名" \
  --destination "./abs-library" \
  --book "诡秘之主"
```

默认每组 200 集，通过 `--group-size 100` 可以改为每组 100 集；省略 `--book` 时使用输入目录名。示例结果：

```text
abs-library/
└── 诡秘之主/
    ├── CD 1/
    │   ├── CD 1 - 0001 - 第001集 开始.mp3
    │   └── CD 1 - 0200 - 第200集 标题.mp3
    └── CD 2/
        └── CD 2 - 0001 - 第201集 标题.mp3
```

将 `abs-library` 添加为 Audiobookshelf 图书库目录。按照其 [官方目录规则](https://audiobookshelf.org/docs/documentation/libraries/book-library/directory-structure/)，`CD 1`、`CD 2` 是同一本书的碟目录，按碟号和曲目号播放，不会在书库里拆成每 200 集一本书。本功能暂不生成独立分卷条目。

整理行为：

- 递归读取输入专辑目录下的 MP3、M4A、FLAC、WAV，忽略隐藏文件和目录，不读取 XM。
- 集号来自文件名中的 `第001集`、`第001章`、`第001回`、`第001期`，或开头的 `001 标题`、`001-标题`。仅支持阿拉伯数字；无法识别或集号重复时，在复制前报错。输入目录必须只包含一部书。
- 按实际集号分段，不按文件数量分段；缺集不影响其他集号。例如第 401 集始终进入 `CD 3`（默认组大小）。
- 复制后更新专辑名、碟号和碟内曲目号，保留其他标签，不转码。原音频和 `.progress` 不变，原解密续跑不受影响。
- 仅预览时检查文件名和目录，不验证音频能否解码或写入标签。正式整理遇到损坏音频会停止；修复后重复运行即可。
- 整理目录必须与输入目录独立，不能互相包含；输出使用原子写入，不覆盖内容不同的同名文件。相同内容直接跳过，可以中断后重新运行。
- 请预留一份音频副本的空间。只复制音频，暂不复制封面和其他附属文件。
- 更改书名、组大小或源文件名会产生不同路径，不会自动清理旧目录。已加入 Audiobookshelf 的书籍改结构前，请备份播放进度。
