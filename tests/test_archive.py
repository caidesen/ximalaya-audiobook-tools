import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from archive import archive, check_groups


class ArchiveTests(unittest.TestCase):
    def test_groups_and_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('第1集.xm', '第2集.xm', '番外 第1集.xm'):
                (root / name).write_bytes(b'xm')
            groups = check_groups(root)
            self.assertEqual(len(groups['正文']), 2)
            self.assertEqual(len(groups['番外']), 1)
            (root / '第4集.xm').write_bytes(b'xm')
            with self.assertRaises(ValueError):
                check_groups(root)

    def test_duplicate_empty_and_no_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError):
                check_groups(root)
            (root / '第1集.xm').touch()
            with self.assertRaises(ValueError):
                check_groups(root)
            (root / '第1集.xm').write_bytes(b'xm')
            (root / '第001集 重复.xm').write_bytes(b'xm')
            with self.assertRaises(ValueError):
                check_groups(root)

    def test_no_ffmpeg_stops_before_decrypt(self):
        with patch('archive.shutil.which', return_value=None), patch('archive.decrypt_xm_file') as decrypt:
            with self.assertRaises(ValueError):
                archive('unused')
            decrypt.assert_not_called()
