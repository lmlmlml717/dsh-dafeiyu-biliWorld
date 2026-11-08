#!/usr/bin/env node
/**
 * 修 profile 的 `cordis.patch.yml`：把 0.8.0 / 0.8.1 自注册写下的 `- insert:` **映射** 改成 0.2.2-rc.1
 * 要求的 **列表**。
 *
 * 为什么必须单独给一条命令：旧写法的 profile 会让 DSH 在解析配置时就抛
 * `patch.insert?.forEach is not a function`，那时插件还没有被加载，`selfRegister` 里的修复没有机会执行 ——
 * 只能由用户（或宿主外的工具）在启动前跑一次。
 *
 * 用法：
 *   node node_modules/dsh-world-bili/scripts/repair-profile-patch.mjs
 *   node node_modules/dsh-world-bili/scripts/repair-profile-patch.mjs --profile desktop --home ~/.dsh
 *
 * 退出码：0 修好或本来就不用修；1 文件不存在/读不了。改之前会在同目录留一份 `.bak`。
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { repairLegacyInsert } from '../lib/install/profilePatch.js';

/** 读 `--name value`，缺省时用 fallback；只认这一种写法，和仓库里其它脚本一致。 */
function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const profile = arg('--profile', 'desktop');
const home = arg('--home', process.env.DSH_HOME || join(homedir(), '.dsh'));
const id = arg('--id', 'dsh-world-bili');
const file = join(home, 'profiles', profile, 'cordis.patch.yml');

const result = repairLegacyInsert(file, id);
if (result.status === 'repaired') {
  console.log(`dsh-world-bili: 已把 ${file} 的旧写法改成列表（备份在 ${result.backup}）。现在可以重启 DSH。`);
} else if (result.status === 'unchanged') {
  console.log(`dsh-world-bili: ${file} 没有旧写法，不需要修。`);
} else {
  console.error(`dsh-world-bili: 没修 ${file}：${result.reason}`);
  process.exitCode = 1;
}
