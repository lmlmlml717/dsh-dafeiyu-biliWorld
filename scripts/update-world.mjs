// 【文件头】把一个编译好的 dsh-world 包升级进指定 profile：备份 → pnpm add → 校验 → 失败回滚。
// 参数：--profile <DSH_HOME/profiles/名字>、--package <编译好的 .tgz>、--pnpm <DSH 的 pnpm.cjs|mjs>；--help 打用法。
// 读写：读 profile 的 package.json 与传入的 tgz；写 <DSH_HOME>/backups/ 下的备份、profile 的 node_modules 与
//       package.json，并在 profiles/ 下短暂持有一把 lock。
// 输出：过程日志走 log（默认 console.log）；用法与失败原因走 stderr。
// 退出码：0 升级成功；1 任何一步失败（含回滚后重新抛出）。
// 坑：必须先正常退出 DSH —— 有未跑完的回合时替换包会把状态写坏，所以安装前后各查一次进程。
//       回滚是否可靠全看备份，所以备份与指纹都核对完，才允许开始安装。
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs, promisify } from 'node:util';

// 所有外部命令都从这里出去，统一 windowsHide：否则每次 tar / robocopy 都会弹一下黑框。
const execute = promisify(execFile);
// maxBuffer 给到 16MB：tar 列目录在依赖多的 profile 上很容易超过默认的 1MB，一超就被当成命令失败。
const command = (file, args, options = {}) => execute(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options });
// GNU tar (the one Git Bash puts first) reads the `C:` of an archive path as a remote host; naming the archive from its own folder works with every tar.
const readArchive = (run, archive, args, options = {}) => run('tar', [args[0], basename(archive), ...args.slice(1)], { ...options, cwd: dirname(archive) });
// 去 BOM：Windows 上的 JSON 常被编辑器写成带 BOM，JSON.parse 遇到它会直接抛。
const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
// 只把"不存在"当 false：权限之类的其它错误照抛，不能被当成"没有这个文件"糊过去。
async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
// 流式算 sha256：包可能有几十 MB，整块读进内存没必要。
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function copyDirectory(from, to) {
  if (process.platform !== 'win32') return cp(from, to, { recursive: true, verbatimSymlinks: true });
  // fs.cp recreates pnpm junctions as privileged file symlinks on Windows.
  // robocopy 只把 0-7 当成功（/SJ /SL 就是让它按链接原样复制），8 以上才是真失败 —— 用别的命令行的 0/非 0 口径判断会误报。
  try { await command('robocopy.exe', [from, to, '/E', '/SJ', '/SL', '/R:0', '/W:0', '/COPY:DAT', '/DCOPY:DA', '/NFL', '/NDL', '/NJH', '/NJS', '/NP']); }
  catch (error) { if (!Number.isInteger(error.code) || error.code < 0 || error.code >= 8) throw error; }
}
// 把"目录里每个文件的内容"压成一份可比较的指纹：升级前后各算一次，用来证明没动别人的东西。
async function fingerprint(root, excluded = []) {
  const files = Object.create(null);
  if (!await exists(root)) return files;
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    // 按名字排序再遍历：两次指纹的键顺序一致，isDeepStrictEqual 才比得出真实差异。
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name), key = relative(root, file);
      if (excluded.includes(key)) continue;
      // 符号链接记目标路径而不是内容：跟着读会把链接另一头的整个目录卷进指纹。
      if (entry.isSymbolicLink()) files[key] = 'link:' + await readlink(file);
      else if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files[key] = await digest(file);
      else throw new Error(`Unsupported filesystem entry: ${file}`);
    }
  }
  await visit(root);
  return files;
}

/**
 * 找出正在运行、会占用 profile 的宿主/适配器进程；返回为空才允许升级。
 * @param {Function} [run] 执行命令的注入点，测试里替换
 * @returns {Promise<string[]>} 每项形如 "进程名 pid 1234"
 */
/** Require a normal exit; never kill a host or an adapter with an unfinished turn. */
export async function runningProcesses(run = command) {
  if (process.platform === 'win32') {
    const query = String.raw`$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Where-Object {
      $_.ProcessId -ne [int]$env:DSH_WORLD_UPDATE_PID -and (
        $_.Name -eq 'DeepSeek Harness.exe' -or
        $_.CommandLine -match '(dsh-desktop-host[\\/].*index\.js|dsh-world[\\/].*adapter\.py)'
      )
    } | ForEach-Object { "$($_.Name) pid $($_.ProcessId)" }`;
    // -EncodedCommand 收的是 UTF-16LE 的 base64：查询里带引号和正则，直接拼命令行会被转义规则吃掉。
    // 同时把自己的 pid 传进去让查询跳过自己，否则升级脚本永远能看到"还有一个进程在跑"。
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(query, 'utf16le').toString('base64')], { env: { ...process.env, DSH_WORLD_UPDATE_PID: String(process.pid) } });
    return stdout.trim().split(/\r?\n/).filter(Boolean);
  }
  const { stdout } = await run('ps', ['-axo', 'pid=,args=']);
  return stdout.split('\n').filter(line => Number(line.trim().split(/\s+/)[0]) !== process.pid && /dsh-desktop-host[/\\]|deepseek[- ]harness|dsh-world[/\\].*adapter\.py/i.test(line));
}

/**
 * 升级一个 profile 里的 dsh-world：备份 → 装包 → 校验内容与配置 → 失败回滚。
 * @param {{profile: string, archive: string, pnpm: string}} options 三处路径
 * @param {{run?: Function, processes?: Function, log?: Function}} [hooks] 执行、进程检查、日志的注入点
 * @returns {Promise<{version: string, profile: string, backup: string, archive: string, archiveSha256: string}>}
 */
export async function updateWorld({ profile: profilePath, archive: archivePath, pnpm: pnpmPath }, { run = command, processes = runningProcesses, log = console.log } = {}) {
  // 只认 <DSH_HOME>/profiles/<名字> 这一种布局：backups、worlds、sessions 的位置都靠它反推，猜错就会备份到别处。
  const profile = await realpath(resolve(profilePath));
  if (basename(dirname(profile)) !== 'profiles') throw new Error('Profile must be under <DSH_HOME>/profiles/');
  const home = dirname(dirname(profile));
  // 人站在 profile 目录里跑升级会出两种事：Windows 上整个目录 rename 会失败，备份也会把刚写出来的临时文件卷进去。
  const fromProfile = relative(profile, process.cwd());
  if (!fromProfile || (!fromProfile.startsWith('..' + sep) && fromProfile !== '..' && !isAbsolute(fromProfile))) throw new Error('Run the updater outside the profile directory');
  // 只升级已经装过 dsh-world 的 profile：顺手装一个新包不是这条命令的职责，装错了还得回滚。
  const original = await json(join(profile, 'package.json'));
  if (!original.dependencies?.['dsh-world']) throw new Error('Install dsh-world in this profile before updating');
  const archive = await realpath(resolve(archivePath)), pnpm = await realpath(resolve(pnpmPath));
  // 只接受 DSH 自带的 pnpm 入口：系统里的 pnpm 版本可能和宿主不一致，装出来的 node_modules 结构会漂。
  if (!/\.(?:c|m)?js$/i.test(pnpm)) throw new Error('--pnpm must point to the DSH pnpm.cjs or pnpm.mjs entry');
  // 每次要动 profile 之前都再查一遍进程：备份期间人可能又把 DSH 打开了。
  const stopped = async () => {
    const active = await processes();
    if (active.length) throw new Error(`Please exit DSH and its WeChat adapter normally before updating: ${active.join(', ')}`);
  };
  await stopped();
  const { stdout: listing } = await readArchive(run, archive, ['-tzf']);
  const entries = listing.trim().split(/\r?\n/);
  // 清单先验一遍：必须正好一个 package/package.json，并且带 lib/index.js —— 源码包或半成品包到这里就该被拒。
  if (entries.filter(file => file === 'package/package.json').length !== 1 || !entries.includes('package/lib/index.js')) throw new Error('A compiled dsh-world archive with lib/index.js is required');
  const { stdout: manifestText } = await readArchive(run, archive, ['-xOzf', 'package/package.json']);
  const target = JSON.parse(manifestText.replace(/^\uFEFF/, ''));
  // 版本号按 semver 形状校验：它会被写进 package.json 和备份目录名，形状不对说明包本身就是坏的。
  if (target.name !== 'dsh-world' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(target.version) || target.main !== 'lib/index.js') throw new Error('The archive must be a compiled dsh-world package');

  // 锁放在 profiles/ 下而不是 profile 里面：同一 profile 只允许一个 updater，第二个直接报错而不是排队等。
  const lockPath = join(dirname(profile), `.dsh-world-update-${basename(profile)}.lock`);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Another updater owns the lock: ${lockPath}`); throw error; }
  let backup, installing = false;
  try {
    await lock.writeFile(String(process.pid));
    // 先备份再校验再安装：失败时备份是唯一能救回来的东西，顺序反了就只剩一堆无法复原的半成品。
    const backupParent = join(home, 'backups');
    await mkdir(backupParent, { recursive: true });
    backup = await mkdtemp(join(backupParent, `dsh-world-${basename(profile)}-`));
    log(`Backing up profile and world data to ${backup}`);
    await copyDirectory(profile, join(backup, 'profile'));
    const protectedFiles = new Map();
    // 指纹排除 node_modules / package.json / pnpm-lock.yaml：升级本来就要动这三处，其它文件一个都不许变。
    protectedFiles.set(profile, await fingerprint(profile, ['node_modules', 'package.json', 'pnpm-lock.yaml']));
    for (const name of ['worlds', 'sessions']) {
      const root = join(home, name);
      protectedFiles.set(root, await fingerprint(root));
      if (await exists(root)) await copyDirectory(root, join(backup, name));
    }
    for (const name of Object.keys(original.dependencies).filter(name => name !== 'dsh-world')) {
      // 依赖名会拼进路径：先挡掉带 .. 或奇怪字符的名字，别让备份跑出 node_modules。
      if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) throw new Error(`Invalid dependency name: ${name}`);
      const root = join(profile, 'node_modules', name);
      if (await exists(root)) protectedFiles.set(root, await fingerprint(root));
    }
    const packages = join(backup, 'packages');
    await mkdir(packages);
    const savedArchive = join(packages, `dsh-world-${target.version}.tgz`);
    await cp(archive, savedArchive);
    const archiveSha256 = await digest(savedArchive);
    // 再核一次哈希：备份期间 tgz 被替换过的话，接下来装进去的就不是刚才验过的那个包。
    if (archiveSha256 !== await digest(archive)) throw new Error('Archive changed while backing up');
    await writeFile(join(backup, 'manifest.json'), JSON.stringify({ profile, archive: savedArchive, archiveSha256, version: target.version, protectedFiles: Object.fromEntries(protectedFiles) }, null, 2));
    await stopped();
    // 从这一行起失败就必须回滚；在此之前失败只报错，profile 还没被动过。
    installing = true;
    log(`Installing compiled dsh-world ${target.version} into ${profile}`);
    // --ignore-scripts：升级只换文件，安装脚本不该在这时候跑（它可能依赖一个正在被替换的环境）。
    const install = await run(process.execPath, [pnpm, 'add', savedArchive, '--ignore-scripts'], { cwd: profile });
    if (install.stdout?.trim()) log(install.stdout.trim());
    const installedRoot = join(profile, 'node_modules', 'dsh-world');
    const installed = await json(join(installedRoot, 'package.json'));
    // 装完立刻核对版本与内容：pnpm 命中缓存或中途失败时，可能留下一个"看起来装好了"的目录。
    if (installed.name !== 'dsh-world' || installed.version !== target.version) throw new Error('Installed dsh-world version does not match the archive');
    for (const entry of ['lib/index.js', 'scripts/update-world.mjs'].filter(file => entries.includes('package/' + file))) {
      const { stdout } = await readArchive(run, savedArchive, ['-xOzf', 'package/' + entry], { encoding: 'buffer' });
      if (createHash('sha256').update(stdout).digest('hex') !== await digest(join(installedRoot, entry))) throw new Error(`Installed package content does not match: ${entry}`);
    }
    // 再让 node 真解析一遍入口：语法在当前 Node 上跑不通的包，只比哈希是发现不了的。
    await run(process.execPath, ['--check', join(installedRoot, 'lib', 'index.js')], { cwd: profile });
    const updated = await json(join(profile, 'package.json'));
    const expected = structuredClone(original);
    expected.dependencies['dsh-world'] = updated.dependencies?.['dsh-world'];
    const specifier = expected.dependencies['dsh-world'];
    // 必须指向保留在备份里的那份 tgz：否则"可以回滚的备份"和实际装上的包就对不上了。
    if (typeof specifier !== 'string' || !specifier.startsWith('file:') || resolve(profile, specifier.slice(5)) !== savedArchive) throw new Error('Installed package is not bound to the preserved archive');
    // 除 dsh-world 的版本之外，profile 的任何字段都不该变：变了说明 pnpm 顺带动了别的依赖登记。
    if (!isDeepStrictEqual(updated, expected)) throw new Error('Other profile configuration or dependency registrations changed');
    // 最后把受保护目录再扫一遍：指纹与备份时一致，才算"只升级了包本身"。
    for (const [root, before] of protectedFiles) {
      const after = await fingerprint(root, root === profile ? ['node_modules', 'package.json', 'pnpm-lock.yaml'] : []);
      if (!isDeepStrictEqual(before, after)) throw new Error(`Protected configuration or world files changed: ${root}`);
    }
    const result = { version: installed.version, profile, backup, archive: savedArchive, archiveSha256 };
    // 结果也写进备份目录：日后想查"哪次升级、装的哪个包、哈希多少"，不用去翻 shell 历史。
    await writeFile(join(backup, 'result.json'), JSON.stringify(result, null, 2));
    log(`Updated dsh-world to ${installed.version}. Restart DSH when ready. Backup: ${backup}`);
    return result;
  } catch (error) {
    // 只有进了安装阶段才回滚：之前的失败 profile 还没被动过，拿备份盖回去反而会把新写的备份也弄乱。
    if (!installing) throw new Error(`Update was not installed: ${error.message}. Backup: ${backup ?? 'not created'}`, { cause: error });
    try {
      await stopped();
      // 先把装坏的目录整个挪走再复制回来：直接覆盖会留下新旧混杂的 profile。
      await rename(profile, join(backup, 'failed-profile'));
      await copyDirectory(join(backup, 'profile'), profile);
    } catch (restoreError) {
      throw new Error(`Update failed: ${error.message}. Profile restore failed: ${restoreError.message}. Keep DSH closed and restore from backup: ${backup}`, { cause: error });
    }
    throw new Error(`Update failed: ${error.message}. Old profile restored. Backup: ${backup}`, { cause: error });
  } finally {
    // 锁必须无条件释放：留下一个删不掉的锁文件，下一次升级就会永远报"另一个进程在跑"。
    await lock.close();
    await unlink(lockPath);
  }
}

// 只有被直接执行时才跑 CLI：测试会 import updateWorld，不能因为一次 import 就备份、装包、动真实 profile。
if (process.argv[1] && await realpath(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { profile: { type: 'string' }, package: { type: 'string' }, pnpm: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) console.log('Usage: node update-world.mjs --profile <DSH_HOME/profiles/name> --package <compiled.tgz> --pnpm <DSH pnpm.cjs or pnpm.mjs>\nExit DSH first. The updater backs up the full profile, worlds and sessions; failed installs restore the old profile. No Git, npm or TypeScript is needed.');
    else {
      if (!values.profile || !values.package || !values.pnpm) throw new Error('--profile, --package and --pnpm are required; see --help');
      const options = { profile: resolve(values.profile), archive: resolve(values.package), pnpm: resolve(values.pnpm) };
      // 把 cwd 挪到 DSH_HOME：上面要求"不在 profile 里跑"，这一步让从任意目录调用都满足它。
      process.chdir(dirname(dirname(options.profile)));
      await updateWorld(options);
    }
  // 只设退出码、不硬退：可能还有子进程句柄挂着，process.exit() 会把错误信息一起吞掉。
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
