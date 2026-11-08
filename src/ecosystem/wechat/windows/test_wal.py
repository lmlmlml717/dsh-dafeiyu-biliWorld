import shutil
import sqlite3
import struct
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from wechatauto.db import WeChatDB
from native import connect
from snapshot import SnapshotBusy, fileStamp


# A header produced by SQLite itself, including its little-endian checksum.
WAL_HEADER = bytes.fromhex('377f0682002de21800001000000000006b8d53959e3608196a3a907e3b2a9ec1')


class WalTest(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(directory)
        self.source = self.root / 'm.db'
        self.wal = self.root / 'm.db-wal'
        with closing(sqlite3.connect(self.source)) as connection:
            connection.execute('PRAGMA page_size=4096')
            connection.execute('CREATE TABLE messages (id INTEGER PRIMARY KEY, text TEXT)')
            connection.execute("INSERT INTO messages(text) VALUES ('original')")
            connection.commit()
        source = self.source

        class Database(WeChatDB):
            def __init__(self, **options):
                self.account = options['account']
                self.workdir = options['workdir']
                self._keys = {'m.db': b'k' * 32}
                Path(self.workdir).mkdir()

            @property
            def wxid(self): return 'wxid_bot'

            def _db_path(self, _): return str(source)

            def _decrypt_file(self, source, destination, _):
                shutil.copyfile(source, destination)

        process = SimpleNamespace(pid=123, create_time=lambda: 1)
        self.enterContext(patch('wechatauto.db.WeChatDB', Database))
        self.enterContext(patch('native.findAccountProcess', return_value=process))
        self.enterContext(patch('native.checkAccountProcess'))
        self.enterContext(patch('psutil.Process', return_value=process))
        self.database, send = connect(dict(dbDir=directory, account='bot', selfId='wxid_bot'), self.root)
        self.addCleanup(send.close)

    def oldFrames(self):
        return (struct.pack('>II', 1, 0) + b'OLDSALT!' + bytes(8 + 4096)) * 102

    def test_old_generation_preserves_main_with_trailing_pages_and_caches_it(self):
        self.source.write_bytes(self.source.read_bytes() + bytes(4096))
        original = self.source.read_bytes()
        self.wal.write_bytes(WAL_HEADER + self.oldFrames())
        for _ in range(5):
            with closing(self.database._open_unlocked('m.db')) as connection:
                self.assertEqual(connection.execute('PRAGMA quick_check').fetchall()[0][0], 'ok')
                self.assertEqual(connection.execute('SELECT text FROM messages').fetchone()[0], 'original')
        self.assertEqual((Path(self.database.workdir) / 'm.db').read_bytes(), original)
        self.assertEqual((Path(self.database.workdir) / 'm.db.stamp').read_text().split(',')[5], '0')
        self.assertEqual(self.source.read_bytes(), original)

    def test_new_generation_after_old_frames_still_delivers_new_messages(self):
        self.wal.write_bytes(WAL_HEADER + self.oldFrames())
        with closing(self.database._open_unlocked('m.db')):
            pass
        updated = self.root / 'updated.db'
        shutil.copyfile(self.source, updated)
        with closing(sqlite3.connect(updated)) as connection:
            connection.execute("INSERT INTO messages(text) VALUES ('new message')")
            connection.commit()
        pages = updated.read_bytes()
        count = len(pages) // 4096
        frames = [struct.pack('>II', number, count if number == count else 0) + WAL_HEADER[16:24] + bytes(8)
                  + pages[(number - 1) * 4096:number * 4096] for number in range(1, count + 1)]
        self.wal.write_bytes(WAL_HEADER + b''.join(frames) + self.oldFrames())
        # Encryption is outside this regression; keep the real WAL merge and SQLite queries.
        with patch('wechatauto.db._decrypt_page', side_effect=lambda _key, page, _number: page):
            with closing(self.database._open_unlocked('m.db')) as connection:
                rows = connection.execute('SELECT text FROM messages ORDER BY id').fetchall()
                self.assertEqual([row[0] for row in rows], ['original', 'new message'])
                self.assertEqual(connection.execute('PRAGMA quick_check').fetchone()[0], 'ok')

    def test_malformed_or_partial_wal_never_changes_main(self):
        original = self.source.read_bytes()
        cases = [b'', WAL_HEADER[:20], bytes(4) + WAL_HEADER[4:],
                 WAL_HEADER[:4] + bytes(4) + WAL_HEADER[8:],
                 WAL_HEADER[:8] + struct.pack('>I', 8192) + WAL_HEADER[12:],
                 WAL_HEADER[:24] + bytes(8), WAL_HEADER + self.oldFrames() + b'partial']
        for value in cases:
            with self.subTest(size=len(value)):
                self.wal.write_bytes(value)
                with self.assertRaises(SnapshotBusy):
                    self.database._merge_wal(str(self.source), str(self.wal), b'unused', 0)
                self.assertEqual(self.source.read_bytes(), original)

    def test_big_endian_header_without_current_frames_preserves_main(self):
        header = bytes.fromhex('377f0683002de21800001000000000006b8d53959e36081981923a6cc6a12a3e')
        self.wal.write_bytes(header + self.oldFrames())
        original = self.source.read_bytes()
        self.assertEqual(self.database._merge_wal(str(self.source), str(self.wal), b'unused', 0), 0)
        self.assertEqual(self.source.read_bytes(), original)

    def test_wal_change_during_scan_never_accepts_main_only_snapshot(self):
        self.wal.write_bytes(WAL_HEADER + self.oldFrames())
        original = self.source.read_bytes()
        stamp = fileStamp(self.wal)
        with patch('snapshot.fileStamp', side_effect=[stamp, (stamp[0] + 1, stamp[1])]):
            with self.assertRaises(SnapshotBusy):
                self.database._merge_wal(str(self.source), str(self.wal), b'unused', 0)
        self.assertEqual(self.source.read_bytes(), original)

    def test_missing_wal_never_accepts_main_only_snapshot(self):
        with self.assertRaises(SnapshotBusy):
            self.database._merge_wal(str(self.source), str(self.wal), b'unused', 0)


if __name__ == '__main__':
    unittest.main()
