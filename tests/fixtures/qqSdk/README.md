# fixtures —— 真实形状的事件样例

4 个 JSON，字段严格按 `@snowluma/sdk` 的 `dist/types/events.d.ts` 拼的（不是造着玩的）。
**用途**：你在没有 QQ、没有网桥的情况下也能写单测 —— 把 JSON 喂给归一化逻辑，断言输出符合 `lib/snowluma.js` 的契约。

| 文件 | 长什么样 | 专门用来测 |
|---|---|---|
| `event.group.text.json` | 群里一条纯文本「在吗」 | 最小通路：`group_id` / `user_id` / `message_id` / `raw_message` / `sender.card` |
| `event.group.mixed.json` | 引用 + @ + 文本 + 图片 + face + **mface** | 段→文本转换、`reply` 段取 `data.id`、`at` 段取 `data.qq`、**未知段走 default 分支**、`sender.role === 'admin'` |
| `event.private.text.json` | 私聊 + json 段，`message_id` 为**负数** | 私聊分流、负数 id 不能当 falsy 丢掉、`sender` 没有 `card` 字段（只有 `nickname`） |
| `event.notice.bot-status.json` | 机器人自己掉线（`notice_type: 'bot_status'`, `sub_type: 'offline'`） | **不该进消息通路**：要落到 `onNotice(type, msg)`，`type` 归一化为 `'bot_offline'` |

## 用之前必须知道的三件事

1. **`message` 在 SDK 类型里是 `JsonValue`，不是强类型段数组**（`dist/types/events.d.ts:35`）。段是运行时形状，代码要自己检查 `seg.type` / `seg.data`。
2. **`sender.card` 可缺**（私聊就没有），`sender.role` 只有 `string`（`events.d.ts:13`），**不是** `'owner'|'admin'|'member'` 联合类型 —— 别写穷尽 switch。
3. **`mface` 段是故意的**：SDK 的 `KnownMessageSegment` 只列了 16 种（`dist/types/messages.d.ts:84`），`mface` 不在里面，但它真的会出现。这就是为什么段→文本的 switch 必须有 `default`。

## 单测骨架（照抄，按你的实现改 import）

契约里的出口只有一个：`createBridge(options)`。最省事的测法是把假的回调塞进去，**不连网**：

```js
// lib/snowluma.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBridge } from './snowluma.js';

const load = (n) => JSON.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8'));

// 把一条 SDK 事件灌进 bridge 的内部处理链
function feed(bridge, event) {
  bridge.__emitForTest?.(event) ?? assert.fail('请暴露一个仅供测试的注入点，或把归一化拆成可 import 的纯函数');
}

test('群消息：最小通路', () => {
  const got = [];
  const bridge = createBridge({ wsUrl: 'ws://127.0.0.1:0/', onGroupMessage: (m) => got.push(m) });
  feed(bridge, load('event.group.text.json'));
  const msg = got[0];
  assert.equal(msg.kind, 'group');
  assert.equal(msg.groupId, '700000001');       // 一律字符串化
  assert.equal(msg.userId, '3000000001');
  assert.equal(msg.messageId, '2000000001');
  assert.equal(msg.selfId, '1000000001');
  assert.equal(msg.text, '在吗');
  assert.equal(msg.sender.card, '小明');
  assert.equal(msg.sender.role, 'member');
});

test('混合段：未知段不能丢，引用 id 留在 segments 里', () => {
  const got = [];
  const bridge = createBridge({ wsUrl: 'ws://127.0.0.1:0/', onGroupMessage: (m) => got.push(m) });
  feed(bridge, load('event.group.mixed.json'));
  const msg = got[0];
  assert.equal(msg.segments.length, 6);
  assert.equal(msg.segments[0].type, 'reply');
  assert.equal(msg.segments[0].data.id, '2000000001');   // 契约没给 msg.replyId，引用信息在 segments 里
  assert.match(msg.text, /帮我看下这段/);
  assert.match(msg.text, /\[动画表情\]|\[mface/, 'mface 段必须落到 default 分支留占位');
});

test('私聊：负数 message_id 与缺失 card', () => {
  const got = [];
  const bridge = createBridge({ wsUrl: 'ws://127.0.0.1:0/', onPrivateMessage: (m) => got.push(m) });
  feed(bridge, load('event.private.text.json'));
  const msg = got[0];
  assert.equal(msg.kind, 'private');
  assert.equal(msg.groupId, null);
  assert.equal(msg.messageId, '-1234567890');            // 负数不能当 falsy 丢掉
  assert.equal(msg.sender.card ?? null, null);
});

test('机器人状态：走 notice，不进消息通路', () => {
  const groupMsgs = [];
  const notices = [];
  const bridge = createBridge({
    wsUrl: 'ws://127.0.0.1:0/',
    onGroupMessage: (m) => groupMsgs.push(m),
    onNotice: (type, m) => notices.push([type, m]),
  });
  feed(bridge, load('event.notice.bot-status.json'));
  assert.equal(groupMsgs.length, 0, 'bot_status 不能当群消息');
  assert.equal(notices[0][0], 'bot_offline');            // 契约的归一化名，不是 'bot_status'
});
```

> 上面 `feed()` 里的 `__emitForTest` 是**建议**：你也可以把归一化写成 `export function normalizeInbound(event)` 独立函数，那样测试更干净，只要 `createBridge` 内部调它就行。两种都接受，别为了测试在 `lib/index.js` 里开洞。

## 出站方向（同样要测）

入站样例覆盖不到发送。出站靠 `04-snowluma-api.md` 的签名核对，最小断言：

```js
import { reply } from '@snowluma/sdk';

assert.deepEqual(reply('2000000001').at('3000000001').text('好').build(), [
  { type: 'reply', data: { id: '2000000001' } },
  { type: 'at',    data: { qq: '3000000001' } },
  { type: 'text',  data: { text: '好' } },
]);
```

（这段在真机核对过，输出就是这个形状。注意 `at` 的 qq 会被 `String()`，`reply` 一条链里只能出现一次。）