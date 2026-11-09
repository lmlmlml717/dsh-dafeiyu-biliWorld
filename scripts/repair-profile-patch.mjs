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
// 【文件头】修 profile 的 cordis.patch.yml 里 0.8.0 / 0.8.1 写下的旧 `- insert:` 映射写法。
// 参数：--profile（缺省 desktop）、--home（缺省 $DSH_HOME 或 ~/.dsh）、--id（缺省 dsh-world-bili）。
// 读写：读 <home>/profiles/<profile>/cordis.patch.yml；需要修时先在同目录留 .bak 再改写。
// 输出：修好 / 不用修 / 没修的中文说明。
// 退出码：0 修好或本来就不用修；1 文件不存在、读不了或写完校验不过。
// 坑：必须在 DSH 启动前跑 —— 旧写法会让宿主在解析配置时就抛错，插件根本没被加载，selfRegister 里的修复执行不到。
import { join } from 'node:path';
import { homedir } from 'node:os';
import { repairLegacyInsert } from '../lib/install/profilePatch.js';

/** 读 `--name value`，缺省时用 fallback；只认这一种写法，和仓库里其它脚本一致。 */
function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const profile = arg('--profile', 'desktop');
// 与宿主同样的解析顺序：先 DSH_HOME，再 ~/.dsh —— 别自己另发明一套默认位置。
const home = arg('--home', process.env.DSH_HOME || join(homedir(), '.dsh'));
const id = arg('--id', 'dsh-world-bili');
const file = join(home, 'profiles', profile, 'cordis.patch.yml');

// 三种结果里只有"没修成"算失败：unchanged 是"本来就不用修"，退出码给 0，脚本可以反复跑。
const result = repairLegacyInsert(file, id);
if (result.status === 'repaired') {
  console.log(`dsh-world-bili: 已把 ${file} 的旧写法改成列表（备份在 ${result.backup}）。现在可以重启 DSH。`);
} else if (result.status === 'unchanged') {
  console.log(`dsh-world-bili: ${file} 没有旧写法，不需要修。`);
} else {
  console.error(`dsh-world-bili: 没修 ${file}：${result.reason}`);
  process.exitCode = 1;
}
