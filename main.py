import base64
import io
import sys
import magic
import pathlib
import os
import glob
import mutagen
import json
import hashlib
import tempfile
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad
from mutagen.easyid3 import ID3
from wasmer import Store, Module, Instance, Uint8Array, Int32Array, engine
from wasmer_compiler_cranelift import Compiler


class XMInfo:
    def __init__(self):
        self.title = ""
        self.artist = ""
        self.album = ""
        self.tracknumber = 0
        self.size = 0
        self.header_size = 0
        self.ISRC = ""
        self.encodedby = ""
        self.encoding_technology = ""

    def iv(self):
        if self.ISRC != "":
            return bytes.fromhex(self.ISRC)
        return bytes.fromhex(self.encodedby)


def get_str(x):
    if x is None:
        return ""
    return x


def read_file(x):
    with open(x, "rb") as f:
        return f.read()


# return number of id3 bytes
def get_xm_info(data: bytes):
    # print(EasyID3(io.BytesIO(data)))
    id3 = ID3(io.BytesIO(data), v2_version=3)
    id3value = XMInfo()
    id3value.title = str(id3["TIT2"])
    id3value.album = str(id3["TALB"])
    id3value.artist = str(id3["TPE1"])
    id3value.tracknumber = int(str(id3["TRCK"]))
    id3value.ISRC = "" if id3.get("TSRC") is None else str(id3["TSRC"])
    id3value.encodedby = "" if id3.get("TENC") is None else str(id3["TENC"])
    id3value.size = int(str(id3["TSIZ"]))
    id3value.header_size = id3.size
    id3value.encoding_technology = str(id3["TSSE"])
    return id3value


def get_printable_count(x: bytes):
    i = 0
    for i, c in enumerate(x):
        # all pritable
        if c < 0x20 or c > 0x7e:
            return i
    return len(x)


def get_printable_bytes(x: bytes):
    return x[:get_printable_count(x)]


def xm_decrypt(raw_data):
    # load xm encryptor
    # print("loading xm encryptor")
    xm_encryptor = Instance(Module(
        Store(engine.Universal(Compiler)),
        pathlib.Path("./xm_encryptor.wasm").read_bytes()
    ))
    # decode id3
    xm_info = get_xm_info(raw_data)
    # print("id3 header size: ", hex(xm_info.header_size))
    # 这行代码的意思是：从原始数据（raw_data）中，截取从ID3头部结束（xm_info.header_size）开始，长度为xm_info.size的加密音频数据部分
    encrypted_data = raw_data[xm_info.header_size : xm_info.header_size + xm_info.size]

    # Stage 1 aes-256-cbc
    xm_key = b"ximalayaximalayaximalayaximalaya"
    # print(f"decrypt stage 1 (aes-256-cbc):\n"
    #       f"    data length = {len(encrypted_data)},\n"
    #       f"    key = {xm_key},\n"
    #       f"    iv = {xm_info.iv().hex()}")
    cipher = AES.new(xm_key, AES.MODE_CBC, xm_info.iv())
    de_data = cipher.decrypt(pad(encrypted_data, 16))
    # print("success")
    # Stage 2 xmDecrypt
    de_data = get_printable_bytes(de_data)
    track_id = str(xm_info.tracknumber).encode()
    stack_pointer = xm_encryptor.exports.a(-16)
    assert isinstance(stack_pointer, int)
    de_data_offset = xm_encryptor.exports.c(len(de_data))
    assert isinstance(de_data_offset, int)
    track_id_offset = xm_encryptor.exports.c(len(track_id))
    assert isinstance(track_id_offset, int)
    memory_i = xm_encryptor.exports.i
    memview_unit8: Uint8Array = memory_i.uint8_view(offset=de_data_offset)
    for i, b in enumerate(de_data):
        memview_unit8[i] = b
    memview_unit8: Uint8Array = memory_i.uint8_view(offset=track_id_offset)
    for i, b in enumerate(track_id):
        memview_unit8[i] = b
    # print(bytearray(memory_i.buffer)[track_id_offset:track_id_offset + len(track_id)].decode())
    # print(f"decrypt stage 2 (xmDecrypt):\n"
    #       f"    stack_pointer = {stack_pointer},\n"
    #       f"    data_pointer = {de_data_offset}, data_length = {len(de_data)},\n"
    #       f"    track_id_pointer = {track_id_offset}, track_id_length = {len(track_id)}")
    # print("success")
    xm_encryptor.exports.g(stack_pointer, de_data_offset, len(de_data), track_id_offset, len(track_id))
    memview_int32: Int32Array = memory_i.int32_view(offset=stack_pointer // 4)
    result_pointer = memview_int32[0]
    result_length = memview_int32[1]
    assert memview_int32[2] == 0, memview_int32[3] == 0
    result_data = bytearray(memory_i.buffer)[result_pointer:result_pointer + result_length].decode()
    # Stage 3 combine
    # print(f"Stage 3 (base64)")
    decrypted_data = base64.b64decode(xm_info.encoding_technology + result_data)
    final_data = decrypted_data + raw_data[xm_info.header_size + xm_info.size::]
    # print("success")
    return xm_info, final_data


def find_ext(data):
    exts = ["m4a", "mp3", "flac", "wav"]
    value = magic.from_buffer(data).lower()
    for ext in exts:
        if ext in value:
            return ext
    raise Exception(f"unexpected format {value}")


def decrypt_xm_file(from_file, output_path='./output', book=None, group_size=200):
    if type(group_size) is not int or group_size < 1:
        raise ValueError('每组集数必须为正整数')
    print(f"正在解密: {from_file}")
    data = read_file(from_file)
    root = pathlib.Path(output_path).resolve()
    root.mkdir(parents=True, exist_ok=True)
    progress_dir = safe_output_path(root, '.progress')
    progress_dir.mkdir(exist_ok=True)
    identity = data
    if book is not None:
        book = replace_invalid_chars(book)
        identity = json.dumps([book, group_size], ensure_ascii=False).encode('utf-8') + b'\0' + data
    progress = safe_output_path(root, '.progress', hashlib.sha256(identity).hexdigest() + '.json')
    if progress.exists():
        try:
            record = json.loads(progress.read_text(encoding='utf-8'))
            completed = safe_output_path(root, record['output'])
            if completed.is_file() and hashlib.sha256(completed.read_bytes()).hexdigest() == record['sha256']:
                print(f"跳过已完成文件: {completed}")
                return False
        except (OSError, ValueError, KeyError, TypeError):
            pass
    info, audio_data = xm_decrypt(data)
    extension = find_ext(audio_data[:0xff])
    if book is not None:
        from organize import episode_number, tagged_audio
        book = replace_invalid_chars(book)
        episode = episode_number(info.title)
        disc = (episode - 1) // group_size + 1
        track = (episode - 1) % group_size + 1
        output = safe_output_path(root, book, f'CD {disc}',
                                  f'CD {disc} - {track:04d} - {replace_invalid_chars(info.title)}.{extension}')
    else:
        output = safe_output_path(root, replace_invalid_chars(info.album),
                                  f"{replace_invalid_chars(info.title)}.{extension}")
    output.parent.mkdir(parents=True, exist_ok=True)
    buffer = io.BytesIO(audio_data)
    tags = mutagen.File(buffer, easy=True)
    tags["title"] = info.title
    tags["album"] = info.album
    tags["artist"] = info.artist
    print(tags.pprint())
    tags.save(buffer)
    result = buffer.getvalue()
    if book is not None:
        result = tagged_audio(result, book, disc, track)
    if output.exists():
        if output.read_bytes() != result:
            raise FileExistsError(f"输出文件已存在且内容不同，未覆盖: {output}")
    else:
        try:
            atomic_write(output, result)
        except FileExistsError:
            if output.read_bytes() != result:
                raise FileExistsError(f"输出文件已存在且内容不同，未覆盖: {output}")
    record = {'output': str(output.relative_to(root)), 'sha256': hashlib.sha256(result).hexdigest()}
    atomic_write(progress, json.dumps(record, ensure_ascii=False).encode('utf-8'), replace=True)
    print(f"解密成功，文件保存至{output}！")
    return True


def safe_output_path(root, *parts):
    path = root.joinpath(*parts).resolve()
    if path == root or root not in path.parents:
        raise ValueError(f"输出路径超出指定目录: {path}")
    return path


def atomic_write(path, data, replace=False):
    # 同目录临时文件保证原子发布；硬链接在目标存在时拒绝覆盖。
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
            temporary = pathlib.Path(f.name)
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if replace:
            os.replace(temporary, path)
        else:
            os.link(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def replace_invalid_chars(name):
    invalid_chars = ['/', '\\', ':', '*', '?', '"', '<', '>', '|']
    for char in invalid_chars:
        if char in name:
            name = name.replace(char, " ")
    name = ''.join(char for char in name if ord(char) >= 32).strip().rstrip('.')
    return name or '_'


def load_config(config_file='config.json'):
    """加载配置文件"""
    default_config = {
        "input_files": [],
        "input_directory": "",
        "output_directory": "./output",
        "batch_mode": False
    }

    if not os.path.exists(config_file):
        # 创建默认配置文件
        with open(config_file, 'w', encoding='utf-8') as f:
            json.dump(default_config, f, indent=4, ensure_ascii=False)
        print(f"已创建默认配置文件: {config_file}")
        return default_config

    try:
        with open(config_file, 'r', encoding='utf-8') as f:
            config = json.load(f)
        return config
    except Exception as e:
        print(f"配置文件加载失败: {e}")
        return default_config


def validate_config(config):
    """验证配置文件"""
    errors = []

    if config.get('batch_mode', False):
        # 批量模式需要目录路径
        input_dir = config.get('input_directory', '')
        if not input_dir:
            errors.append("批量模式下必须指定 input_directory")
        elif not os.path.exists(input_dir):
            errors.append(f"输入目录不存在: {input_dir}")
    else:
        # 单文件模式需要文件列表
        input_files = config.get('input_files', [])
        if not input_files:
            errors.append("单文件模式下必须指定 input_files")
        else:
            for file_path in input_files:
                if not os.path.exists(file_path):
                    errors.append(f"输入文件不存在: {file_path}")

    return errors


if __name__ == "__main__":
    print("欢迎使用喜马拉雅音频解密工具")
    print("本工具仅供学习交流使用，严禁用于商业用途")
    print()

    # 加载配置文件
    config = load_config()

    # 验证配置
    errors = validate_config(config)
    if errors:
        print("配置文件验证失败:")
        for error in errors:
            print(f"  - {error}")
        print()
        print("请修改 config.json 文件后重新运行程序")
        print("配置文件格式示例:")
        print(json.dumps({
            "input_files": ["/path/to/file1.xm", "/path/to/file2.xm"],
            "input_directory": "/path/to/directory",
            "output_directory": "./output",
            "batch_mode": False
        }, indent=4, ensure_ascii=False))
        sys.exit(1)

    # 根据配置模式处理文件
    files_to_decrypt = []
    if config.get('batch_mode', False):
        # 批量模式
        input_dir = config['input_directory']
        files_to_decrypt = glob.glob(os.path.join(input_dir, "*.xm"))
        print(f"批量模式: 在目录 {input_dir} 中找到 {len(files_to_decrypt)} 个 .xm 文件")
    else:
        # 单文件模式
        files_to_decrypt = config['input_files']
        print(f"单文件模式: 将处理 {len(files_to_decrypt)} 个文件")

    if not files_to_decrypt:
        print("没有找到要解密的文件")
        sys.exit(1)

    # 获取输出路径
    output_path = config.get('output_directory', './output')
    print(f"输出目录: {output_path}")
    print()

    # 开始解密
    success_count = 0
    skipped_count = 0
    for file_path in files_to_decrypt:
        try:
            if decrypt_xm_file(file_path, output_path):
                success_count += 1
            else:
                skipped_count += 1
        except Exception as e:
            print(f"解密文件 {file_path} 失败: {e}")

    failed_count = len(files_to_decrypt) - success_count - skipped_count
    print(f"\n解密完成! 新完成 {success_count}，跳过已完成 {skipped_count}，失败 {failed_count}")
