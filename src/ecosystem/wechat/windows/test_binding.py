import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
import psutil
from binding import findAccountProcess, checkAccountProcess, WechatOffline


class BindingTest(unittest.TestCase):
    def test_only_the_unique_configured_account_can_be_selected(self):
        with tempfile.TemporaryDirectory() as directory:
            config = dict(dbDir=directory, account='bot', selfId='wxid_bot', processId=1)
            def process(pid, account, name='Weixin.exe'):
                return SimpleNamespace(pid=pid, name=lambda: name, create_time=lambda: 100,
                    open_files=lambda: [SimpleNamespace(path=str(Path(directory)/account/'db_storage/message/message_0.db'))])
            owner, bot = process(1,'owner'), process(2,'bot')
            self.assertIs(findAccountProcess(config, [owner, bot]), bot)
            with self.assertRaises(WechatOffline): findAccountProcess(config, [owner])
            with self.assertRaisesRegex(RuntimeError, '多个'): findAccountProcess(config, [bot, process(3,'bot')])
            bot.open_files=lambda: [SimpleNamespace(path=str(Path(directory)/account/'db_storage/message/message_0.db')) for account in ['bot','owner']]
            with self.assertRaisesRegex(RuntimeError, '多个'): findAccountProcess(config, [bot])

    def test_old_binding_is_rejected_when_pid_is_reused_or_account_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            config = dict(dbDir=directory, account='bot', selfId='wxid_bot')
            process = SimpleNamespace(pid=10, name=lambda: 'Weixin.exe', create_time=lambda: 100,
                open_files=lambda: [SimpleNamespace(path=str(Path(directory)/'bot/db_storage/message/message_0.db'))])
            checkAccountProcess(process, config, 100)
            with self.assertRaises(WechatOffline): checkAccountProcess(process, config, 99)
            process.open_files=lambda: []
            with self.assertRaises(WechatOffline): checkAccountProcess(process, config, 100)
            process.create_time=Mock(side_effect=psutil.NoSuchProcess(10))
            with self.assertRaises(WechatOffline): checkAccountProcess(process, config, 100)


if __name__ == '__main__': unittest.main()
