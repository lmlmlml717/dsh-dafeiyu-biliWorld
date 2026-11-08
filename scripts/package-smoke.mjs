import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as plugin from 'dsh-world-bili';
import * as sdk from '@snowluma/sdk';

// 包名一处定义：改名时只改这里，下面所有路径都跟着走。
const PACKAGE = 'dsh-world-bili';
// check-package copies this probe into the temporary consumer before running it.
const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
for (const name of [PACKAGE, '@snowluma/sdk']) {
  assert.ok(require.resolve(`${name}/package.json`).startsWith(join(directory, 'node_modules') + sep), `${name} must come from the freshly installed package`);
}
assert.equal(typeof plugin.apply, 'function');
assert.equal(typeof sdk.SnowLumaWebSocketClient, 'function');
const updaterHelp = execFileSync(process.execPath, [join(directory, `node_modules/${PACKAGE}/scripts/update-world.mjs`), '--help'], { encoding: 'utf8' });
assert.match(updaterHelp, /--profile/);
const { createBridge } = await import(new URL(`./node_modules/${PACKAGE}/lib/ecosystem/qq-native/snowluma.js`, import.meta.url));
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(server, 'listening');
const bridge = createBridge({ wsUrl: `ws://127.0.0.1:${server.address().port}` });
try {
  await bridge.start();
  assert.equal(bridge.getState(), 'online');
} finally {
  await bridge.stop();
  await new Promise(resolve => server.close(resolve));
}
process.stdout.write('Packed plugin entry, externally installed SDK and local QQ connection passed without install scripts.\n');
