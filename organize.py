"""按集数复制已解密音频，生成 Audiobookshelf 多碟目录。"""

import argparse
import io
import re
from pathlib import Path

import mutagen
from mutagen.id3 import TALB, TPOS, TRCK
from mutagen.wave import WAVE

from main import atomic_write, replace_invalid_chars, safe_output_path


AUDIO_EXTENSIONS = {'.mp3', '.m4a', '.flac', '.wav'}


def episode_number(stem):
    # 只接受明确集号或文件名开头的数字，避免把标题中的年份当作集号。
    match = re.search(r'第\s*(\d+)\s*[集章回期]', stem)
    if match is None:
        match = re.match(r'^\s*(\d+)(?=$|[\s._、\-集章回期])', stem)
    if match is None or int(match[1]) < 1:
        raise ValueError(f'无法确定集号，请使用“第001集”或“001 标题”命名: {stem}')
    return int(match[1])


def build_plan(source, destination, book, group_size):
    source = Path(source).resolve()
    destination = Path(destination).resolve()
    if not source.is_dir():
        raise ValueError(f'输入专辑目录不存在: {source}')
    if type(group_size) is not int or group_size < 1:
        raise ValueError('每组集数必须为正整数')
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError('输入目录和整理目录必须独立，不能相同或互相包含')
    book = replace_invalid_chars(book or source.name)
    plan = []
    episodes = set()
    # 一次只整理一个专辑，递归兼容已有分组目录；忽略续跑和隐藏目录。
    for path in sorted(source.rglob('*')):
        relative = path.relative_to(source)
        if any(part.startswith('.') for part in relative.parts):
            continue
        if not path.is_file() or path.suffix.lower() not in AUDIO_EXTENSIONS:
            continue
        if path.is_symlink() or source not in path.resolve().parents:
            raise ValueError(f'不支持输入符号链接: {path}')
        episode = episode_number(path.stem)
        if episode in episodes:
            raise ValueError(f'集号重复: 第 {episode} 集，请先确认是否存在多个版本')
        episodes.add(episode)
        disc = (episode - 1) // group_size + 1
        track = (episode - 1) % group_size + 1
        filename = f'CD {disc} - {track:04d} - {replace_invalid_chars(path.stem)}{path.suffix.lower()}'
        target = safe_output_path(destination, book, f'CD {disc}', filename)
        plan.append((episode, path, target, disc, track))
    if not plan:
        raise ValueError('输入目录中没有可整理的 mp3、m4a、flac 或 wav 文件')
    return destination, book, sorted(plan)


def tagged_audio(data, book, disc, track):
    buffer = io.BytesIO(data)
    audio = mutagen.File(buffer, easy=True)
    if audio is None:
        raise ValueError('无法读取音频格式')
    if audio.tags is None:
        audio.add_tags()
    if isinstance(audio, WAVE):
        audio.tags.add(TALB(encoding=3, text=[book]))
        audio.tags.add(TPOS(encoding=3, text=[str(disc)]))
        audio.tags.add(TRCK(encoding=3, text=[str(track)]))
    else:
        audio['album'] = [book]
        audio['discnumber'] = [str(disc)]
        audio['tracknumber'] = [str(track)]
    audio.save(buffer)
    return buffer.getvalue()


def organize(source, destination, book=None, group_size=200, dry_run=False):
    root, book, plan = build_plan(source, destination, book, group_size)
    copied = skipped = 0
    for episode, path, target, disc, track in plan:
        print(f'第 {episode} 集: {path} -> {target}')
        if dry_run:
            continue
        # 写入前再次检查目录，阻止预览后出现的符号链接将输出导向目录外。
        target = safe_output_path(root, target.relative_to(root))
        result = tagged_audio(path.read_bytes(), book, disc, track)
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            if target.read_bytes() != result:
                raise FileExistsError(f'目标内容不同，未覆盖: {target}')
            skipped += 1
            continue
        try:
            atomic_write(target, result)
            copied += 1
        except FileExistsError:
            if target.read_bytes() != result:
                raise FileExistsError(f'目标内容不同，未覆盖: {target}')
            skipped += 1
    print(f'{"预览" if dry_run else "整理"}完成: 共 {len(plan)} 集，新增 {copied}，跳过 {skipped}')
    return copied, skipped


def cli():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, help='一部书的已解密音频目录')
    parser.add_argument('--destination', required=True, help='独立的 Audiobookshelf 整理根目录')
    parser.add_argument('--book', help='书名，默认使用输入目录名')
    parser.add_argument('--group-size', type=int, default=200, help='每碟集数，默认 200')
    parser.add_argument('--dry-run', action='store_true', help='仅预览，不创建或写入文件')
    args = parser.parse_args()
    try:
        organize(args.source, args.destination, args.book, args.group_size, args.dry_run)
    except (OSError, ValueError, mutagen.MutagenError) as error:
        parser.exit(1, f'整理失败: {error}\n')


if __name__ == '__main__':
    cli()
