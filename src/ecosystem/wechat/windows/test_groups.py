import unittest
from groups import mentionedIds, recentContext
from adapter import incomingMessage
from incoming import ImageUnavailable


class GroupTest(unittest.TestCase):
    def test_group_images_keep_sender_provenance_and_only_the_two_latest_are_read(self):
        rows = [dict(local_id=i, shard='m.db', sort_seq=i, create_time=1700000000+i, type='文本' if i==5 else '图片', sender_username='wxid_mom', content='@鲸鲸 看图' if i==5 else 'private-image-xml') for i in range(5,0,-1)]
        class Database:
            reads = []
            unavailable = False
            def get_message_row(self,*args,**kwargs): return dict(source='<msgsource><atuserlist>wxid_bot</atuserlist></msgsource>')
            def get_nickname(self,user): return '妈妈'
            def get_messages(self,_chat,limit,offset=0): return rows[offset:offset+limit]
            def readImage(self,chat,row):
                self.reads.append(row['local_id'])
                if self.unavailable: raise ImageUnavailable('图片尚未下载')
                return dict(file=str(row['local_id'])*64+'.png', quality='cached')
        database=Database()
        chat=dict(id='group@chatroom',name='家',trigger='mention')
        message=incomingMessage(database,chat,rows[0],dict(selfId='wxid_bot'))
        self.assertEqual(database.reads,[4,3])
        self.assertEqual(sum('image' in entry for entry in message['context']),2)
        self.assertEqual(message['context'][-1]['identity']['speakerId'],'wechat:wxid_mom')
        self.assertNotIn('private-image-xml',str(message))
        database.unavailable=True
        message=incomingMessage(database,chat,rows[0],dict(selfId='wxid_bot'))
        self.assertNotIn('image',message['context'][-1])
        self.assertIn('图片尚未下载',message['context'][-1]['text'])

    def test_only_real_bot_mentions_trigger_with_sender_identified_context(self):
        before = dict(local_id=1, shard='m.db', sort_seq=1, create_time=1700000000, type='文本', sender_username='wxid_dad', content='昨天的话')
        current = dict(local_id=2, shard='m.db', sort_seq=2, create_time=1700000001, type='文本', sender_username='wxid_mom', content='@鲸鲸 在吗')
        class Database:
            source = '<msgsource/>'
            def get_message_row(self, *args, **kwargs): return dict(source=self.source)
            def get_nickname(self, user): return {'wxid_mom': '妈妈', 'wxid_dad': '爸爸'}[user]
            def get_messages(self, _chat, limit, offset=0): return [current, before][offset:offset+limit]
        database = Database()
        config = dict(selfId='wxid_bot')
        chat = dict(id='family@chatroom', name='家庭群', trigger='mention')
        self.assertIsNone(incomingMessage(database, chat, current, config))
        database.source = '<msgsource><atuserlist>wxid_bot</atuserlist></msgsource>'
        message = incomingMessage(database, chat, current, config)
        self.assertEqual(message['identity']['speakerId'], 'wechat:wxid_mom')
        self.assertEqual(message['identity']['conversationType'], 'group')
        self.assertEqual(message['identity']['platformMessageId'], 'm.db:2')
        self.assertEqual(message['identity']['mentionIds'], ['wechat:wxid_bot'])
        self.assertEqual(message['context'][0]['identity']['speakerId'], 'wechat:wxid_dad')
        self.assertEqual(message['context'][0]['text'], '昨天的话')

    def test_mentions_come_from_decoded_source_metadata_and_match_exact_ids(self):
        import zstandard
        source = b'<msgsource><atuserlist><![CDATA[wxid_bot,wxid_mom]]></atuserlist></msgsource>'
        self.assertEqual(mentionedIds(zstandard.ZstdCompressor().compress(source)), ['wxid_bot', 'wxid_mom'])
        self.assertEqual(mentionedIds('<msgsource><signature>@bot</signature></msgsource>'), [])
        self.assertNotIn('wxid_bot', mentionedIds('<msgsource><atuserlist>wxid_bot2</atuserlist></msgsource>'))

    def test_context_is_chronological_paginated_and_never_includes_the_trigger_or_future(self):
        rows = [dict(local_id=i, shard='m.db', sort_seq=i) for i in range(15, 0, -1)]
        class Database:
            def get_messages(self, _chat, limit, offset=0):
                return rows[offset:offset+limit]
        result = recentContext(Database(), 'group', rows[3], lambda row: dict(id=str(row['local_id']), text='x'), pageSize=2, limit=8)
        self.assertEqual([r['id'] for r in result], [str(n) for n in range(4, 12)])
        # With no limit given, the default of five applies.
        result = recentContext(Database(), 'group', rows[3], lambda row: dict(id=str(row['local_id']), text='x'), pageSize=2)
        self.assertEqual([r['id'] for r in result], [str(n) for n in range(7, 12)])

    def test_nontext_rows_do_not_displace_the_recent_text_context(self):
        rows = [dict(local_id=i, shard='m.db', sort_seq=i) for i in range(20, 0, -1)]
        class Database:
            def get_messages(self, _chat, limit, offset=0): return rows[offset:offset+limit]
        result = recentContext(Database(), 'group', rows[0], lambda row: dict(id=str(row['local_id'])) if row['local_id'] <= 8 else None, pageSize=3, limit=8)
        self.assertEqual([r['id'] for r in result], [str(n) for n in range(1, 9)])


if __name__ == '__main__':
    unittest.main()
