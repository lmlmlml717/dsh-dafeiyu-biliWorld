// 【文件头】打包产物的安装体检：在 .host/ 下建一个临时 consumer，装 artifacts 里的 tgz，
// 验证插件入口能 import、核心安装不会带上 QQ SDK、补装 SDK 后 smoke 脚本能跑通，最后删掉临时目录。
// 参数：没有 CLI 参数；要求由 npm run 拉起（靠环境变量 npm_execpath 找到同一个 npm）。
// 读写：读 package.json 与 artifacts/<name>-<version>.tgz；在 .host/ 下建目录并装依赖；
//       结束时只删自己建的那个临时 consumer。
// 输出：npm / node 子进程的输出原样透传；失败信息由 assert 或子进程退出码体现。
// 退出码：0 全过；非 0 来自 assert，或 execFileSync 透传的子进程失败码。
// 坑：npm 必须用 process.env.npm_execpath 调，别换成 PATH 里的 npm；安装带 --ignore-scripts，
//       为的是模拟"没有宿主、也不跑安装脚本"的真实安装结果。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
// 包名与版本都从 package.json 读：改名或发版后这里不用跟着改，路径自然对上。
const archive = join(root, 'artifacts', `${manifest.name}-${manifest.version}.tgz`);
// 先确认产物在、再确认是 npm 拉起的：这两条不满足时，后面的失败会指向完全错误的方向。
assert.ok((await stat(archive)).isFile(), 'Pack the compiled plugin into artifacts/ first');
assert.ok(process.env.npm_execpath, 'Run through npm run test:package');
// 临时 consumer 建在仓库内的 .host/ 下：和 artifacts 同盘，复制包快，也不占系统临时目录的全盘配额。
const scratch = join(root, '.host');
await mkdir(scratch, { recursive: true });
const consumer = await mkdtemp(join(scratch, 'package-check-'));
try {
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  // smoke 脚本复制进 consumer 再跑：这样它 import 到的才是刚装好的包，而不是本仓库的源码。
  await copyFile(new URL('./package-smoke.mjs', import.meta.url), join(consumer, 'smoke.mjs'));
  // The parent checkout supplies DSH peers; core installation must not install the QQ SDK.
  // --omit=dev 只装运行时依赖，--ignore-scripts 跳过安装脚本：这才是用户机器上最常见的那种安装。
  const install = ['install', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund'];
  execFileSync(process.execPath, [process.env.npm_execpath, ...install, archive, '--omit=dev'], { cwd: consumer, stdio: 'inherit', timeout: 120_000 });
  await assert.rejects(lstat(join(consumer, 'node_modules', '@snowluma', 'sdk')), { code: 'ENOENT' });
  // 用包清单里的名字，而不是写死的旧包名：改名后写死 dsh-world 会在这里 404。
  execFileSync(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(manifest.name)})`], { cwd: consumer, stdio: 'inherit', timeout: 15_000 });
  // 第二阶段补装 SDK 再跑 smoke：核心安装不该带它，但真要用 QQ 桥的人必须能自己装上。
  execFileSync(process.execPath, [process.env.npm_execpath, ...install, `@snowluma/sdk@${manifest.devDependencies['@snowluma/sdk']}`], { cwd: consumer, stdio: 'inherit', timeout: 120_000 });
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(consumer, 'smoke.mjs')], { cwd: consumer, stdio: 'inherit', timeout: 15_000 });
} finally {
  // 删除前再确认一次父目录：路径一旦算错，下一行就是能把整个仓库删掉的那一步。
  assert.equal(dirname(consumer), scratch, 'Only remove the temporary consumer under this checkout');
  await rm(consumer, { recursive: true, force: true });
}
