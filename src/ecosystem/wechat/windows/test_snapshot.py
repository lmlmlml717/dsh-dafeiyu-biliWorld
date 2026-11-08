import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from snapshot import checkedSnapshot, fileStamp


class SnapshotTest(unittest.TestCase):
    def test_stale_main_or_failed_wal_is_never_returned(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, wal, stamp = root / 'source.db', root / 'source.db-wal', root / 'm.db.stamp'
            source.write_bytes(b'main')
            wal.write_bytes(b'wal')
            database = SimpleNamespace(workdir=directory, _db_path=lambda _: source, _wal_path=lambda _: wal)
            def writeStamp(applied):
                sm, ss = fileStamp(source)
                wm, ws = fileStamp(wal)
                stamp.write_text(f'1,{sm!r},{ss},{wm!r},{ws},{applied}')
            closed = []
            connection = SimpleNamespace(close=lambda: closed.append(True))
            writeStamp(1)
            self.assertIs(checkedSnapshot(database, 'm.db', lambda _: connection), connection)
            writeStamp(-1)
            with self.assertRaises(RuntimeError):
                checkedSnapshot(database, 'm.db', lambda _: connection)
            writeStamp(1)
            source.write_bytes(b'new-main')
            with self.assertRaises(RuntimeError):
                checkedSnapshot(database, 'm.db', lambda _: connection)
            writeStamp(1)
            wal.write_bytes(b'new-wal')
            with self.assertRaises(RuntimeError):
                checkedSnapshot(database, 'm.db', lambda _: connection)
            self.assertEqual(len(closed), 3)


if __name__ == '__main__':
    unittest.main()
