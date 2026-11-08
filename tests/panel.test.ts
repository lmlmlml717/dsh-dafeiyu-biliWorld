import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsoleDoors, createPanelSecrets, discoverSnowlumaHome, findSnowlumaConsole, loginSnowluma, openInBrowser, PANEL_FILE } from '../src/ecosystem/qq/panel.ts';

function tempHome(runtime?: unknown): string {
  const home = mkdtempSync(join(tmpdir(), 'snowluma-home-'));
  mkdirSync(join(home, 'config'), { recursive: true });
  if (runtime !== undefined) writeFileSync(join(home, 'config', 'runtime.json'), JSON.stringify(runtime));
  return home;
}
const reply = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

test('SnowLuma 的控制台地址从它自己的 runtime.json 里读，不是写死的端口', () => {
  const home = tempHome({ webuiPort: 5099, webuiHost: '127.0.0.1', webuiTls: { enabled: false } });
  assert.deepEqual(findSnowlumaConsole(home)?.base, 'http://127.0.0.1:5099');
});

test('绑在所有网卡上的控制台仍然从本机按名字访问；没有配置就说没有', () => {
  assert.equal(findSnowlumaConsole(tempHome({ webuiPort: 6100, webuiHost: '0.0.0.0' }))?.base, 'http://127.0.0.1:6100');
  assert.equal(findSnowlumaConsole(tempHome())?.base, undefined);
  assert.equal(findSnowlumaConsole(''), undefined);
  const empty = mkdtempSync(join(tmpdir(), 'no-snowluma-'));
  assert.equal(findSnowlumaConsole(empty), undefined);
});

test('SnowLuma 的家：配置里给了就只认它；没给才去几个常见位置里找（桥的配置已经不在了）', () => {
  const home = tempHome({ webuiPort: 5099 });
  assert.equal(discoverSnowlumaHome(home), home);
  // 配置指了一个空目录，就算别处真有也不换 —— 指哪儿是哪儿。
  const wrong = mkdtempSync(join(tmpdir(), 'wrong-home-'));
  assert.equal(discoverSnowlumaHome(wrong, [home]), '');
  // 没配置时按候选表找，只认「里面有 config/runtime.json」的。
  assert.equal(discoverSnowlumaHome('', [wrong, home]), home);
  const nothing = mkdtempSync(join(tmpdir(), 'nothing-'));
  assert.equal(discoverSnowlumaHome('', [wrong, nothing]), '');
});

// 「只有本机用户能读」在 Windows 上是 ACL，在 Linux 上是 mode 位 —— 断言写的是前者。
test('面板密码记在她世界目录旁边，只有本机用户能读；空密码不算记过', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'world-panel-'));
  const secrets = createPanelSecrets(dir);
  assert.equal(secrets.read(), undefined);
  secrets.remember('', 'hunter2');
  assert.deepEqual(secrets.read(), { username: 'admin', password: 'hunter2' });
  const file = join(dir, PANEL_FILE);
  assert.ok(existsSync(file));
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  secrets.forget();
  assert.equal(secrets.read(), undefined);
});

test('面板密码换来的会话令牌直接写进 URL，页面拿到就是登录态', async () => {
  const day = await loginSnowluma('http://127.0.0.1:5099/', 'admin', 'hunter2', reply(200, { success: true, token: 'abc123' }));
  assert.deepEqual(day, { url: 'http://127.0.0.1:5099/?token=abc123' });
});

test('密码错、被限流、连不上，三种都说得清', async () => {
  assert.deepEqual(await loginSnowluma('http://x', 'admin', 'bad', reply(401, { success: false, message: '密码错误' })), { error: '密码错误' });
  const limited = await loginSnowluma('http://x', 'admin', 'bad', reply(429, { success: false })) as { error: string };
  assert.match(limited.error, /登录尝试太多/);
  const dead = await loginSnowluma('http://x', 'admin', 'bad', (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch) as { error: string };
  assert.match(dead.error, /连不上 SnowLuma 控制台/);
});

test('只剩一扇门：SnowLuma 没密码时先要密码，记住之后才开门；指不到家也说清楚', async () => {
  const world = mkdtempSync(join(tmpdir(), 'world-doors-'));
  const home = tempHome({ webuiPort: 5099, webuiHost: '127.0.0.1' });
  const doors = createConsoleDoors({ worldDir: world, snowlumaHome: home });
  assert.equal((await doors.snowluma() as { needs?: string }).needs, 'password');
  const secrets = createPanelSecrets(world);
  assert.equal(secrets.read(), undefined);
  const nowhere = createConsoleDoors({ worldDir: world, snowlumaHome: mkdtempSync(join(tmpdir(), 'empty-home-')) });
  const missing = await nowhere.snowluma() as { error?: string };
  assert.match(String(missing.error), /没找到 SnowLuma 的控制台配置/);
  assert.match(String((await nowhere.open('snowluma') as { error: string }).error), /没找到 SnowLuma/);
});

test('打开用的是桌面自己的浏览器（两个控制台都不许被框；现在只剩 SnowLuma 那个）', () => {
  const seen: string[] = [];
  const fake = ((command: string, args: string[]) => { seen.push(`${command} ${args.join(' ')}`); return { unref() {} }; }) as unknown as typeof import('node:child_process').spawn;
  const opened = openInBrowser('http://127.0.0.1:5099/?token=abc', fake);
  assert.deepEqual(opened, { opened: true });
  assert.equal(seen.length, 1);
  assert.match(seen[0] ?? '', /127\.0\.0\.1:5099/);
});