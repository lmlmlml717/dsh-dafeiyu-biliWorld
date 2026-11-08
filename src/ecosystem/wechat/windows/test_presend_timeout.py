import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import adapter
from native import connect
from snapshot import NotSent, SnapshotBusy

REPLY = 'ab' * 32
CHAT = 'private'


class PreSendSnapshotTimeoutTest(unittest.TestCase):
    """#23: what a stable-snapshot timeout BEFORE the native send leaves behind in the adapter state."""

    def run_job(self, busy_from_read, store=None):
        """`busy_from_read`: 1-based get_messages call from which the snapshot never settles."""
        class Database:
            def __init__(self, **_):
                self.account, self.wxid, self.reads = 'bot-account', 'wxid_bot', 0

            def _message_dbs(self): return ['m.db']
            def _db_path(self, _): return 'unused.db'
            def _wal_path(self, _): return None

            def get_messages(self, _chat, limit, offset=0):
                self.reads += 1
                if self.reads >= busy_from_read: raise SnapshotBusy('busy')
                return []

            def get_message_row(self, _chat, _id, *, shard): return dict(server_id=1)

        process = SimpleNamespace(pid=123, create_time=lambda: 1)
        transport = Mock()
        modules = {
            'wechatauto.db': SimpleNamespace(WeChatDB=Database),
            'wechatauto.param': SimpleNamespace(WxParam=SimpleNamespace(ENABLE_FILE_LOGGER=False)),
            'incoming': SimpleNamespace(IncomingImages=lambda *_: SimpleNamespace(read=None, readSticker=None, readReference=None)),
        }
        state = Path(tempfile.mkdtemp())
        config = dict(dbDir='unused', account='bot-account', selfId='wxid_bot', moduleFile=str(state / 'module.json'),
                      chats=[dict(id=CHAT, name='x')])
        if store is None:
            store = adapter.MessageStore(state / 'state.sqlite')
            store.baseline(CHAT, 0)
        job = dict(id=REPLY, accountId='wxid_bot', chatId=CHAT, messages=[dict(type='text', text='你好')])
        jobs = [dict(job=job)]
        poll = lambda _config: jobs.pop(0) if jobs else dict()
        reported = []
        with patch.dict(sys.modules, modules), patch('native.findAccountProcess', return_value=process), \
                patch('native.checkAccountProcess'), patch('psutil.Process', return_value=process), \
                patch('native.fileStamp', return_value=(1, 1)), \
                patch('native.time.monotonic', side_effect=[0, 1, 21, 22, 23, 24, 25, 26]), \
                patch('native.time.sleep'), patch('sender.NativeSender', return_value=transport):
            database, send = connect(config, state)
            try:
                error = None
                try:
                    adapter.flushOutgoing(config, database, store, send, poll=poll, report=lambda _f, receipt: reported.append(receipt))
                except Exception as caught:
                    error = caught
            finally:
                send.close()
        return error, transport, store, reported

    def test_timeout_before_the_native_send_sends_nothing_and_leaves_no_trace(self):
        error, transport, store, reported = self.run_job(busy_from_read=1)
        self.assertIsInstance(error, NotSent)
        transport.send.assert_not_called()
        self.assertIsNone(store.reply(REPLY))
        self.assertEqual(reported, [])
        self.assertEqual(store.db.execute("SELECT COUNT(*) FROM messages WHERE status='pending'").fetchone()[0], 0)
        store.checkPending()  # a restart does not need a person

    def test_the_same_job_is_sent_once_when_the_snapshot_settles(self):
        busy = self.run_job(busy_from_read=1)
        self.assertIsInstance(busy[0], NotSent)
        error, transport, store, _ = self.run_job(busy_from_read=10**9, store=busy[2])
        transport.send.assert_called_once_with(CHAT, 1, '你好')
        self.assertRegex(str(error), '发送未确认')  # no server-confirmed row in this fake, so it is judged uncertain
        self.assertEqual(store.reply(REPLY)['status'], 'uncertain')

    def test_after_three_attempts_it_stays_unconfirmed_for_a_person(self):
        first = self.run_job(busy_from_read=1)
        store = first[2]
        second = self.run_job(busy_from_read=1, store=store)
        self.assertIsInstance(first[0], NotSent)
        self.assertIsInstance(second[0], NotSent)
        error, transport, store, reported = self.run_job(busy_from_read=1, store=store)
        self.assertNotIsInstance(error, NotSent)
        self.assertRegex(str(error), '连续 3 次')
        transport.send.assert_not_called()
        self.assertEqual(store.reply(REPLY)['status'], 'uncertain')
        with self.assertRaises(adapter.NeedsHuman): store.checkPending()


if __name__ == '__main__':
    unittest.main()
