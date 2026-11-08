import hashlib
import json
import struct
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
from pathlib import Path
from incoming import saveImage, IncomingImages, ImageUnavailable, V2_MAGIC, MediaDownloader, ScopedMedia


class IncomingTest(unittest.TestCase):
    def test_private_picture_uses_the_same_reader_with_a_private_cache_namespace(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cached = root / 'account/msg/attach/private/photo.dat'
            cached.parent.mkdir(parents=True)
            Image.new('RGB', (24, 16), 'blue').save(cached, format='PNG')
            database = SimpleNamespace(account_dir=str(root / 'account'), get_message_row=Mock(return_value=dict(local_type=3, sender_username='owner')))
            reader = IncomingImages(database, dict(selfId='bot', moduleFile=str(root / 'wechat.json'), chats=[dict(id='owner')]), lambda: None)
            reader.media = SimpleNamespace(_img_md5=lambda _: 'digest', _chat_md5=lambda _: 'private', original_ready=MediaDownloader.original_ready,
                _image_files=lambda *_: dict(mid=(str(cached), cached.stat().st_size)), download_image=Mock(return_value=str(cached)))
            result = reader.read('owner', dict(local_id=1, shard='shard', sender_username='owner'))
            key = hashlib.sha256(json.dumps(['wechat', 'bot', 'private', 'owner'], separators=(',', ':')).encode()).hexdigest()
            self.assertTrue((root / 'wechat-incoming' / key / result['file']).is_file())

    def test_normalized_images_are_content_addressed_and_separated_by_group(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'photo.jpg'
            Image.new('RGB', (32, 24), 'blue').save(source)
            image = saveImage(source, root / 'incoming', 'bot', 'group@chatroom', 'cached')
            key = hashlib.sha256(json.dumps(['wechat', 'bot', 'group', 'group@chatroom'], separators=(',', ':')).encode()).hexdigest()
            path = root / 'incoming' / key / image['file']
            self.assertEqual(path.suffix, '.png')
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest() + '.png', image['file'])
            self.assertEqual(image['quality'], 'cached')
            with Image.open(path) as decoded:
                self.assertEqual(decoded.size, (32, 24))

    def test_reader_requires_a_configured_group_and_never_chooses_another_chat(self):
        with tempfile.TemporaryDirectory() as directory:
            reader = IncomingImages(None, dict(selfId='bot', moduleFile=str(Path(directory) / 'wechat.json'), chats=[dict(id='group@chatroom')]), lambda: None)
            with self.assertRaises(ValueError): reader.read('other@chatroom', {})
            with self.assertRaises(ValueError): reader.read('private', {})

    def test_original_placeholder_does_not_hide_available_cached_image(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cached = root / 'account/msg/attach/group/photo.dat'
            cached.parent.mkdir(parents=True)
            Image.new('RGB', (24, 16), 'blue').save(cached, format='PNG')
            original = cached.with_name('photo_h.dat')
            original.write_bytes(b'0')
            database = SimpleNamespace(account_dir=str(root / 'account'), get_message_row=Mock(return_value=dict(local_type=3, sender_username='sender')))
            reader = IncomingImages(database, dict(selfId='bot', moduleFile=str(root / 'wechat.json'), chats=[dict(id='group@chatroom')]), lambda: None)
            reader.media = SimpleNamespace(_img_md5=lambda _: 'digest', _chat_md5=lambda _: 'group', original_ready=MediaDownloader.original_ready,
                _image_files=lambda *_: dict(original=(str(original), 1), mid=(str(cached), cached.stat().st_size)), download_image=Mock(return_value=str(cached)))
            image = reader.read('group@chatroom', dict(local_id=1, shard='shard', sender_username='sender'))
            self.assertEqual(image['quality'], 'cached')
            self.assertEqual(reader.media.download_image.call_args.kwargs['tier'], 'mid')

    def test_partially_written_v2_header_is_unavailable_without_stopping_listener(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cached = root / 'account/msg/attach/group/photo.dat'
            cached.parent.mkdir(parents=True)
            cached.write_bytes(V2_MAGIC)
            database = SimpleNamespace(account_dir=str(root / 'account'), get_message_row=Mock(return_value=dict(local_type=3, sender_username='sender')))
            reader = IncomingImages(database, dict(selfId='bot', moduleFile=str(root / 'wechat.json'), chats=[dict(id='group@chatroom')]), lambda: None)
            reader.media = SimpleNamespace(_img_md5=lambda _: 'digest', _chat_md5=lambda _: 'group', original_ready=MediaDownloader.original_ready,
                _image_files=lambda *_: dict(mid=(str(cached), cached.stat().st_size)))
            with self.assertRaises(ImageUnavailable):
                reader.read('group@chatroom', dict(local_id=1, shard='shard', sender_username='sender'))

    def test_image_configuration_is_loaded_once_from_bound_account(self):
        database = SimpleNamespace(wxid='bot', extract_master_key=Mock(return_value=('unused', 123456, 'bot')))
        media = ScopedMedia(database, Mock())
        media._validate_key = Mock(return_value=True)
        self.assertEqual(media._derive_cfg_key(), media.derive_image_keys(123456, 'bot'))
        media._derive_cfg_key()
        database.extract_master_key.assert_called_once_with()
        self.assertFalse(hasattr(database, 'master_key'))

    def test_v2_declared_body_must_be_complete_before_key_resolution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cached = root / 'account/msg/attach/group/photo.dat'
            cached.parent.mkdir(parents=True)
            cached.write_bytes(V2_MAGIC + struct.pack('<LL', 64, 0) + b'\x00' * 18)
            database = SimpleNamespace(account_dir=str(root / 'account'), get_message_row=Mock(return_value=dict(local_type=3, sender_username='sender')))
            reader = IncomingImages(database, dict(selfId='bot', moduleFile=str(root / 'wechat.json'), chats=[dict(id='group@chatroom')]), lambda: None)
            reader.media = SimpleNamespace(_img_md5=lambda _: 'digest', _chat_md5=lambda _: 'group', original_ready=MediaDownloader.original_ready,
                _image_files=lambda *_: dict(mid=(str(cached), cached.stat().st_size)), _resolve_aes_key=Mock(side_effect=AssertionError('truncated image must not resolve keys')))
            with self.assertRaises(ImageUnavailable):
                reader.read('group@chatroom', dict(local_id=1, shard='shard', sender_username='sender'))

    def test_image_configuration_rejects_a_different_account(self):
        database = SimpleNamespace(wxid='bot', extract_master_key=Mock(return_value=('unused', 123456, 'other')))
        media = ScopedMedia(database, Mock())
        with self.assertRaisesRegex(RuntimeError, '账号'):
            media._derive_cfg_key()


if __name__ == '__main__': unittest.main()
