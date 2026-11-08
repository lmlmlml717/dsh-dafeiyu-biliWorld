"""Reject stale or partial dependency snapshots before a message cursor can advance."""
import os
import struct
from pathlib import Path


class SnapshotBusy(RuntimeError):
    pass


class SnapshotTimeout(RuntimeError):
    """No stable snapshot of the target chat could be read in time."""


class NotSent(SnapshotBusy):
    """A send gave up before anything reached WeChat, so the same job can safely be tried again."""


def fileStamp(path):
    try:
        stat = Path(path).stat()
    except FileNotFoundError as error:
        raise SnapshotBusy('微信快照文件正在变化') from error
    return stat.st_mtime, stat.st_size


def hasCurrentWalFrames(database, path):
    before = fileStamp(path)
    try:
        with open(path, 'rb') as wal:
            header = wal.read(database.WAL_HEADER_SZ)
            if len(header) != 32:
                raise SnapshotBusy('微信 WAL 文件头不完整，本轮不推进消息位置')
            magic, version, pageSize = struct.unpack('>III', header[:12])
            if magic not in (0x377f0682, 0x377f0683) or version != 3007000 or pageSize != database.WAL_FRAME_SZ - 24:
                raise SnapshotBusy('微信 WAL 文件头无效，本轮不推进消息位置')
            words = struct.unpack('<6I' if magic == 0x377f0682 else '>6I', header[:24])
            checksum1 = checksum2 = 0
            for index in (0, 2, 4):
                checksum1 = (checksum1 + words[index] + checksum2) & 0xffffffff
                checksum2 = (checksum2 + words[index + 1] + checksum1) & 0xffffffff
            if (checksum1, checksum2) != struct.unpack('>II', header[24:32]):
                raise SnapshotBusy('微信 WAL 文件头校验失败，本轮不推进消息位置')
            if (before[1] - database.WAL_HEADER_SZ) % database.WAL_FRAME_SZ:
                raise SnapshotBusy('微信 WAL 帧不完整，本轮不推进消息位置')
            current = False
            for offset in range(database.WAL_HEADER_SZ, before[1], database.WAL_FRAME_SZ):
                wal.seek(offset)
                frame = wal.read(24)
                if len(frame) != 24:
                    raise SnapshotBusy('读取期间微信 WAL 帧发生变化，本轮不推进消息位置')
                current = current or frame[8:16] == header[16:24]
            wal.seek(0)
            if wal.read(database.WAL_HEADER_SZ) != header or fileStamp(path) != before:
                raise SnapshotBusy('读取期间微信 WAL 发生变化，本轮不推进消息位置')
            return current
    except FileNotFoundError as error:
        raise SnapshotBusy('读取期间微信 WAL 消失，本轮不推进消息位置') from error


def checkedSnapshot(database, rel, openSnapshot):
    connection = openSnapshot(rel)
    try:
        stampFile = Path(database.workdir, rel.replace(os.sep, '__') + '.stamp')
        stamp = stampFile.read_text().split(',')
        source = fileStamp(database._db_path(rel))
        wal = database._wal_path(rel)
        walStamp = fileStamp(wal) if wal else (0.0, 0)
        if len(stamp) != 6 or int(stamp[5]) < 0 or (float(stamp[1]), int(stamp[2])) != source or (float(stamp[3]), int(stamp[4])) != walStamp:
            stampFile.unlink()
            raise SnapshotBusy('微信数据库快照不完整或已过期，本轮不推进消息位置')
        return connection
    except Exception:
        connection.close()
        raise
