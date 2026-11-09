// 自注册：让宿主 profile 的 dsh.profile.bundles 与 cordis.patch.yml 里都有这个插件。
//
// 导出：InstallLogger / SelfRegisterOptions / SelfRegisterReport 类型与 ensureSelfRegistered。
// 被谁调用：index.ts 启动时调用一次；命令行修复脚本也会走 profilePatch 的修复函数。
// 依赖：./profileFile.ts、./profilePatch.ts、node:module 的 createRequire 与 ../faults.ts 的 errorText。
// 坑：两处都是宿主配置，写坏会让 DSH 起不来：bundles 只在 profile 真能解析到包时才写，patch 只在文件结构
//     确认可以追加时才写；任何一步不满足就跳过并记 warning，宁可这次不注册，也不把宿主写坏。
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { errorText } from '../faults.ts';
import { readTextIfExists, replaceAtomically } from './profileFile.ts';
import { appendBlock, hasRow, insertBlock, removeOwnInsert, repairLegacyInsert } from './profilePatch.ts';

/**
 * 自注册：让宿主 profile 的 `dsh.profile.bundles` 和 `cordis.patch.yml` 里都有这个插件。
 *
 * 为什么需要自注册：宿主只对白名单里的官方包自动合并 bundle 自带的 patch，第三方包即使装进了 profile 也不会
 * 自动出现在配置里，装完还是「插件没加载」。所以插件第一次跑起来时给自己补上这两处。
 *
 * 为什么这么小心：这两处都是宿主的配置文件，写坏就让 DSH 起不来。0.8.0 的教训有两个 ——
 *   - 往宿主初始化出来的 `[]` 后面直接接 `- insert:`，产出非法 YAML，host 启动直接 exit 1；
 *   - 只往 bundles 里加名字、不管包能不能解析，宿主启动报 `ERR_MODULE_NOT_FOUND`。
 * 这里对应加了两道闸：写入前先判断文件结构（profilePatch.appendVerdict），bundles 只在 profile 真能解析到
 * 这个包时才写。任何一步不满足就跳过并记 warning —— 宁可这次不注册，也不把宿主写坏。
 */

/** 插件要用的最小 logger 形状：`ctx.logger` 满足它，测试里给个收集数组即可。 */
export interface InstallLogger {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * ensureSelfRegistered 的输入：宿主主目录、包名、日志、要处理的 profile 与可注入的解析判断。
 */
export interface SelfRegisterOptions {
  /** `~/.dsh` 之类的宿主主目录；profile 在它下面的 `profiles/<名字>/`。 */
  dshHome: string;
  /** 插件包名，同时是模块说明符前缀、插入行里的 id 与 name。 */
  packageName: string;
  logger: InstallLogger;
  /** 默认只认桌面版 profile；以后别的 profile 也要注册时在这里加。 */
  profiles?: readonly string[];
  /** 测试注入：profile 能不能解析到这个包。默认用 createRequire 解析 `<包名>/package.json`。 */
  resolvable?: (profileDir: string, packageName: string) => boolean;
}

/** 一处注册的结果，便于测试断言、也便于调用方记日志。 */
export interface SelfRegisterReport {
  profile: string;
  bundles: 'present' | 'added' | 'unresolvable' | 'not-a-list' | 'no-manifest';
  patch: 'present' | 'inserted' | 'repaired' | 'skipped' | 'no-file';
  note?: string;
}

// 默认只注册桌面版 profile；其它发行版要在这里加。
const DESKTOP_PROFILES = ['profiles/desktop'] as const;

/** 对每个 profile 做一次自注册，返回各自的结果；整体失败只记 warning，不影响插件本体。 */
export function ensureSelfRegistered(options: SelfRegisterOptions): SelfRegisterReport[] {
  const { dshHome, packageName, logger } = options;
  const resolvable = options.resolvable ?? resolvesFromProfile;
  // 一个 profile 失败不阻断下一个：registerProfile 内部已经把异常收敛成 warning。
  return (options.profiles ?? DESKTOP_PROFILES).map(relative =>
    registerProfile(join(dshHome, relative), packageName, resolvable, logger));
}

/** 对单个 profile 做两处注册；异常在这里收敛成 warning 和当前报告，不影响其它 profile。 */
function registerProfile(
  profileDir: string,
  packageName: string,
  resolvable: (profileDir: string, packageName: string) => boolean,
  logger: InstallLogger,
): SelfRegisterReport {
  const report: SelfRegisterReport = { profile: profileDir, bundles: 'no-manifest', patch: 'no-file' };
  try {
    const manifestFile = join(profileDir, 'package.json');
    const manifest = readManifest(manifestFile);
    if (manifest === undefined) {
      logger.warn(`dsh-world-bili: ${profileDir} 里没有 package.json，跳过自注册`);
      return report;
    }
    // 先算一次「profile 能不能解析到这个包」：bundles 和 patch 都要用它。解析不到就两处都不写 ——
    // 写进去宿主会在启动阶段 import 失败（ERR_MODULE_NOT_FOUND），用户看到的就是「插件坏了」。
    const canResolve = resolvable(profileDir, packageName);
    if (!canResolve) logger.warn(`dsh-world-bili: ${profileDir} 解析不到 ${packageName}，这次不往 profile 里写任何东西（先把它装进这个 profile）`);
    // 这个插件同时是一个 profile bundle：只要它在 dsh.profile.bundles 里，bundle 自带的 patch 就会插入这一行，
    // 再往 cordis.patch.yml 写 `- insert:` 就是重复行（宿主配置编辑器会因此拒绝保存配置，见 removeOwnInsert）。
    const listedBefore = Array.isArray(manifest.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.includes(packageName);
    report.bundles = ensureBundle(manifest, manifestFile, canResolve, packageName, logger);
    report.patch = ensurePatchRow(profileDir, packageName, canResolve, logger, listedBefore || report.bundles === 'added');
  } catch (error) {
    logger.warn(`dsh-world-bili: 自注册跳过：${errorText(error)}`);
  }
  return report;
}

type ProfileManifest = { dsh?: { profile?: { bundles?: unknown } } };

/** 读 profile 的 package.json；不是合法 JSON 时抛出，由上层记 warning（配置文件坏了不能再往里写）。 */
function readManifest(file: string): ProfileManifest | undefined {
  const text = readTextIfExists(file);
  return text === undefined ? undefined : JSON.parse(text) as ProfileManifest;
}

/**
 * 把包名加进 `dsh.profile.bundles`。
 *
 * 关键的一道闸是 canResolve：宿主会按 bundles 里的名字去 profile 目录 import 这个包，包不在就直接
 * `ERR_MODULE_NOT_FOUND`，而这条错误发生在宿主启动阶段，用户看到的是「插件坏了」。所以先确认能解析，再写。
 */
function ensureBundle(
  manifest: ProfileManifest,
  manifestFile: string,
  canResolve: boolean,
  packageName: string,
  logger: InstallLogger,
): SelfRegisterReport['bundles'] {
  const bundles = manifest.dsh?.profile?.bundles;
  // bundles 不是数组就放弃：可能是用户手改的配置，不能猜着改。
  if (!Array.isArray(bundles)) return 'not-a-list';
  if (bundles.includes(packageName)) return 'present';
  if (!canResolve) return 'unresolvable';
  bundles.push(packageName);
  replaceAtomically(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  logger.info(`dsh-world-bili: 已把 ${packageName} 加进 ${manifestFile} 的 dsh.profile.bundles`);
  return 'added';
}

/**
 * 在 `cordis.patch.yml` 里补一行 `- insert:`；已经有这个 id 就什么都不做。
 *
 * `bundleProvidesRow` 为真表示这个包已经在 `dsh.profile.bundles` 里：bundle 自带的 patch 会插入这一行，
 * 这里不但不该再写，还要把旧版本写下的重复行删掉（否则配置编辑器保存会报 overridden）。
 */
function ensurePatchRow(profileDir: string, packageName: string, canResolve: boolean, logger: InstallLogger, bundleProvidesRow: boolean): SelfRegisterReport['patch'] {
  const file = join(profileDir, 'cordis.patch.yml');
  const text = readTextIfExists(file);
  if (text === undefined) return 'no-file';
  // 0.8.0/0.8.1 写的 `- insert:` 是映射，0.2.2-rc.1 的宿主读到会直接崩在启动阶段。旧行同样命中 hasRow，
  // 所以先修形状，再判断有没有这行；修不了（文件结构不支持）就退回原来的「已经有了，不动」。
  const repair = repairLegacyInsert(file, packageName);
  if (repair.status === 'repaired') {
    logger.info(`dsh-world-bili: 已把 ${file} 里的旧写法改成列表（备份在 ${repair.backup}）`);
    if (bundleProvidesRow) dropOwnInsert(file, packageName, logger);
    return 'repaired';
  }
  if (bundleProvidesRow) {
    // bundle 已经负责插入这一行；旧装如果两条都写着，就删掉自注册那条（有备份，只删自己的精确形状）。
    if (dropOwnInsert(file, packageName, logger)) return 'repaired';
    return 'present';
  }
  if (hasRow(text, packageName)) return 'present';
  if (!canResolve) return 'skipped';
  const edit = appendBlock(file, insertBlock(packageName));
  if (edit.status === 'skipped') {
    logger.warn(`dsh-world-bili: 没写 ${file}：${edit.reason}`);
    return 'skipped';
  }
  if (edit.status === 'unchanged') return 'present';
  logger.info(`dsh-world-bili: 已写自注册行到 ${file}（备份在 ${edit.backup}）`);
  return 'inserted';
}

/** 删掉自注册多余的那条 insert；删了返回 true（已记日志）。 */
function dropOwnInsert(file: string, packageName: string, logger: InstallLogger): boolean {
  const cleanup = removeOwnInsert(file, packageName);
  if (cleanup.status !== 'repaired') return false;
  logger.info(`dsh-world-bili: 已移除 ${file} 里多余的 insert 行（bundle 自带 patch 会插入它；备份在 ${cleanup.backup}）`);
  return true;
}

/** 默认的可解析性判断：以 profile 的 package.json 为锚点，按 Node 的解析规则找 `<包名>/package.json`。 */
function resolvesFromProfile(profileDir: string, packageName: string): boolean {
  try {
    createRequire(join(profileDir, 'package.json')).resolve(`${packageName}/package.json`);
    return true;
  } catch {
    return false;
  }
}
