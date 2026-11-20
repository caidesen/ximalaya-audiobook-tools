"""检查一个 XM 专辑，解密并归档为 Audiobookshelf 多碟目录。"""

import argparse
import shutil
import subprocess
from pathlib import Path

from main import decrypt_xm_file, replace_invalid_chars
from organize import AUDIO_EXTENSIONS, episode_number


def check_groups(source):
    source = Path(source)
    if not source.is_dir():
        raise ValueError(f'下载目录不存在: {source}')
    groups = {}
    for path in source.glob('*.xm'):
        category = '番外' if path.stem.startswith('番外') else '正文'
        groups.setdefault(category, []).append(path)
    if not groups:
        raise ValueError('下载目录中没有 XM 文件')
    for category, files in groups.items():
        numbers = [episode_number(p.stem) for p in files]
        missing = sorted(set(range(1, max(numbers) + 1)) - set(numbers))
        if missing or len(numbers) != len(set(numbers)):
            raise ValueError(f'{category} 存在重复集号或缺集，缺集: {missing}')
        if any(p.stat().st_size == 0 for p in files):
            raise ValueError(f'{category} 存在空文件')
        groups[category] = sorted(files, key=lambda p: episode_number(p.stem))
        print(f'集号检查通过: {category}，第 1–{max(numbers)} 集', flush=True)
    return groups


def archive(source, book=None):
    if not shutil.which('ffmpeg'):
        raise ValueError('缺少 ffmpeg，请先安装: brew install ffmpeg')
    source = Path(source).resolve()
    groups = check_groups(source)
    book = replace_invalid_chars(book or source.name)
    for category, files in groups.items():
        title = f'{book}（{category}）'
        for index, path in enumerate(files, 1):
            print(f'[{category} 解密 {index}/{len(files)}]', flush=True)
            decrypt_xm_file(path, 'abs-library', book=title)
        target = Path('abs-library') / title
        audio = sorted(p for p in target.rglob('*') if p.suffix.lower() in AUDIO_EXTENSIONS)
        if len(audio) != len(files):
            raise ValueError(f'{category} 归档数量不符: 预期 {len(files)}，实际 {len(audio)}')
        for index, path in enumerate(audio, 1):
            print(f'[{category} 全长校验 {index}/{len(audio)}] {path.name}', flush=True)
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-xerror',
                            '-i', str(path), '-f', 'null', '-'], check=True)
    print(f'全部完成，归档目录: {Path("abs-library").resolve()}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', help='下载完成的 XM 专辑目录')
    parser.add_argument('--book', help='归档书名，默认使用源目录名')
    args = parser.parse_args()
    try:
        archive(args.source, args.book)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'归档失败: {error}\n')
