import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import main


class FakeTags(dict):
    def pprint(self):
        return ''

    def save(self, buffer):
        pass


class OutputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'input.xm'
        self.source.write_bytes(b'source')
        self.output = self.root / 'output'
        self.info = SimpleNamespace(album='album', title='title', artist='artist')
        self.decrypt = self.enterContext(patch.object(main, 'xm_decrypt', return_value=(self.info, b'audio')))
        self.enterContext(patch.object(main, 'find_ext', return_value='mp3'))
        self.enterContext(patch.object(main.mutagen, 'File', side_effect=lambda *a, **kw: FakeTags()))

    # Python 3.9 的 unittest 尚无 enterContext。
    def enterContext(self, context):
        value = context.__enter__()
        self.addCleanup(context.__exit__, None, None, None)
        return value

    def run_file(self):
        return main.decrypt_xm_file(self.source, self.output)

    def test_printable_boundary(self):
        for value, expected in [(b'', b''), (b'A', b'A'), (b'ABC', b'ABC'),
                                (b'ABC\0tail', b'ABC'), (b'\xff', b'')]:
            self.assertEqual(main.get_printable_bytes(value), expected)

    def test_resume_without_decrypting(self):
        self.assertTrue(self.run_file())
        self.assertFalse(self.run_file())
        self.decrypt.assert_called_once()

    def test_direct_archive_and_resume(self):
        self.info.title = '第201集 标题'
        with patch('organize.tagged_audio', return_value=b'tagged audio') as tag:
            self.assertTrue(main.decrypt_xm_file(self.source, self.output, book='书名'))
            target = self.output / '书名/CD 2/CD 2 - 0001 - 第201集 标题.mp3'
            self.assertEqual(target.read_bytes(), b'tagged audio')
            tag.assert_called_once_with(b'audio', '书名', 2, 1)
            self.assertFalse(main.decrypt_xm_file(self.source, self.output, book='书名'))
            self.decrypt.assert_called_once()
            self.assertEqual(list(self.output.rglob('*.mp3')), [target])
            self.assertTrue(main.decrypt_xm_file(self.source, self.output, book='另一书名'))

    def test_collision_keeps_existing_output(self):
        self.run_file()
        self.source.write_bytes(b'another source')
        self.decrypt.return_value = (self.info, b'other audio')
        with self.assertRaises(FileExistsError):
            self.run_file()
        self.assertEqual((self.output / 'album/title.mp3').read_bytes(), b'audio')

    def test_missing_output_is_recreated(self):
        self.run_file()
        (self.output / 'album/title.mp3').unlink()
        self.assertTrue(self.run_file())
        self.assertEqual(self.decrypt.call_count, 2)

    def test_modified_output_is_preserved(self):
        self.run_file()
        target = self.output / 'album/title.mp3'
        target.write_bytes(b'changed')
        with self.assertRaises(FileExistsError):
            self.run_file()
        self.assertEqual(target.read_bytes(), b'changed')

    def test_interrupted_progress_is_recovered(self):
        main_write = main.atomic_write
        with patch.object(main, 'atomic_write') as write:
            def fail_record(path, data, replace=False):
                if replace:
                    raise OSError('模拟进度记录写入失败')
                return main_write(path, data)
            write.side_effect = fail_record
            with self.assertRaises(OSError):
                self.run_file()
        self.assertTrue(self.run_file())
        self.assertFalse(self.run_file())

    def test_invalid_names_and_symlink_escape(self):
        for name in ('', '.', '..', '  ', '\0'):
            self.assertEqual(main.replace_invalid_chars(name), '_')
        self.output.mkdir()
        (self.output / 'album').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.run_file()
        with self.assertRaises(ValueError):
            main.safe_output_path(self.output.resolve(), '../escape')

    def test_atomic_write_never_overwrites(self):
        target = self.root / 'result'
        main.atomic_write(target, b'first')
        with self.assertRaises(FileExistsError):
            main.atomic_write(target, b'second')
        self.assertEqual(target.read_bytes(), b'first')
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['input.xm', 'result'])


if __name__ == '__main__':
    unittest.main()
