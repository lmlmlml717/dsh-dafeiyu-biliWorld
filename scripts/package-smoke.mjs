// 【文件头】包安装后的冒烟测试：确认插件入口导出了 apply、外部装的 SDK 能连、内置 QQ 桥能起停。
// 参数：无；由 check-package 复制到临时 consumer 里执行，所以依赖必须从"刚装好的包"解析。
// 读写：只读 node_modules 与 updater 的 --help 输出；起一个本地 WebSocketServer（127.0.0.1 随机端口），不碰外部网络。
// 输出：通过时最后写一行英文结论（沿用包内既有文案）；失败由 assert 抛出。
// 退出码：0 通过；非 0 由 assert 或 execFileSync 透传。
// 坑：PACKAGE 是包名的单点定义；require.resolve 断言必须落在临时 consumer 的 node_modules 下，
//       否则测到的是父 checkout 里的旧包，等于没测。
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
// ESM 里没有全局 require，只能这样造一个：用它才能拿到真正的解析路径。
const require = createRequire(import.meta.url);
for (const name of [PACKAGE, '@snowluma/sdk']) {
  assert.ok(require.resolve(`${name}/package.json`).startsWith(join(directory, 'node_modules') + sep), `${name} must come from the freshly installed package`);
}
assert.equal(typeof plugin.apply, 'function');
assert.equal(typeof sdk.SnowLumaWebSocketClient, 'function');
// updater 必须随包发布且能直接跑：帮助里出现 --profile，才说明这个入口没被打包漏掉。
const updaterHelp = execFileSync(process.execPath, [join(directory, `node_modules/${PACKAGE}/scripts/update-world.mjs`), '--help'], { encoding: 'utf8' });
assert.match(updaterHelp, /--profile/);
const { createBridge } = await import(new URL(`./node_modules/${PACKAGE}/lib/ecosystem/qq-native/snowluma.js`, import.meta.url));
// 本机起一个假的服务端：测的是连接与起停，不需要真 QQ 协议，也不需要联网。
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
// port 0 = 让系统挑空闲端口：和宿主或其它测试并行跑时不会抢端口。
await once(server, 'listening');
const bridge = createBridge({ wsUrl: `ws://127.0.0.1:${server.address().port}` });
try {
  await bridge.start();
  assert.equal(bridge.getState(), 'online');
} finally {
  // 一定收尾：监听句柄留着，进程就不会退出，smoke 会表现成"卡住"而不是"失败"。
  await bridge.stop();
  await new Promise(resolve => server.close(resolve));
}
process.stdout.write('Packed plugin entry, externally installed SDK and local QQ connection passed without install scripts.\n');
