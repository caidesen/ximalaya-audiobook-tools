import tempfile
import unittest
import wave
from pathlib import Path

from mutagen.wave import WAVE

from organize import build_plan, episode_number, organize


class OrganizeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / '原专辑'
        self.source.mkdir()
        self.destination = self.root / 'library'

    def audio(self, name):
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(8000)
            audio.writeframes(b'\0\0' * 80)
        return path

    def test_numbers(self):
        for title, expected in [('第001集 开始', 1), ('书名 第201章 标题', 201),
                                ('0200-标题', 200), ('0400', 400)]:
            self.assertEqual(episode_number(title), expected)
        for title in ('序章', '书名2024版', '000 标题', '123abc'):
            with self.assertRaises(ValueError):
                episode_number(title)

    def test_real_wav_copy_tags_and_resume(self):
        original = self.audio('第201集 标题.wav')
        before = original.read_bytes()
        self.assertEqual(organize(self.source, self.destination), (1, 0))
        result = self.destination / '原专辑/CD 2/CD 2 - 0001 - 第201集 标题.wav'
        tags = WAVE(result).tags
        self.assertEqual(str(tags['TALB']), '原专辑')
        self.assertEqual(str(tags['TPOS']), '2')
        self.assertEqual(str(tags['TRCK']), '1')
        self.assertEqual(original.read_bytes(), before)
        self.assertEqual(organize(self.source, self.destination), (0, 1))
        result.write_bytes('已存在的不同内容'.encode('utf-8'))
        with self.assertRaises(FileExistsError):
            organize(self.source, self.destination)
        self.assertEqual(result.read_bytes(), '已存在的不同内容'.encode('utf-8'))

    def test_group_boundaries_and_dry_run(self):
        for episode in (1, 200, 201, 400, 401):
            self.audio(f'第{episode}集.wav')
        _, _, plan = build_plan(self.source, self.destination, '书名', 200)
        self.assertEqual([(row[3], row[4]) for row in plan],
                         [(1, 1), (1, 200), (2, 1), (2, 200), (3, 1)])
        organize(self.source, self.destination, dry_run=True)
        self.assertFalse(self.destination.exists())

    def test_duplicate_and_unrecognized_fail_before_writing(self):
        self.audio('第1集.wav')
        other = self.audio('第001集 重复.wav')
        with self.assertRaises(ValueError):
            organize(self.source, self.destination)
        other.unlink()
        self.audio('序章.wav')
        with self.assertRaises(ValueError):
            organize(self.source, self.destination)
        self.assertFalse(self.destination.exists())

    def test_path_validation(self):
        self.audio('第1集.wav')
        for destination in (self.source, self.source / 'out', self.root):
            with self.assertRaises(ValueError):
                build_plan(self.source, destination, None, 200)
        for size in (0, -1):
            with self.assertRaises(ValueError):
                build_plan(self.source, self.destination, None, size)
        self.destination.mkdir()
        (self.destination / '书名').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            build_plan(self.source, self.destination, '书名', 200)


if __name__ == '__main__':
    unittest.main()
