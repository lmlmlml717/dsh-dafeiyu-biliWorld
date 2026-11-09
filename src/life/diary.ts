/**
 * 她的日记：按日期找文件、读文件，并拦住对「已经合上的那一天」的改写。
 *
 * 导出：createDiaryReader、closedDiaryRefusal。
 * 调用方：runtime 把 closedDiaryRefusal 挂成工具守卫，console 侧用 reader 列日期、读正文。
 * 依赖：node:fs/node:path 与 activity.collectPaths。
 * 坑：日期只认 YYYY-MM-DD，防止 `../` 逃出日记目录；只拦日记目录顶层的 `YYYY-MM-DD.md`，
 * 别处的同名文件放行，交给宿主自己的工具规则去管。
 */
/**
 * 【链路位置】
 * 回顾链路的终点守卫：她把当天写进日记，用的是宿主的 write/edit，落盘前先过这个函数。
 * 上游：runtime.ts 的 guard 回调，传入这次调用的 cwd、日记目录和 openDiaryDays() 算出的开放日期。
 * 下游：不读写文件，只用 activity.collectPaths 从参数里收路径；命中已合上的那天就返回拒绝文案。
 * 读写：只判定路径，不读也不写正文；控制台经 createDiaryReader 列日期、经 /console/diary 读正文。
 * 开放集合：今天，加上回顾还没结束的那一天；跨过午夜也仍然算开着，不会被误拦。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { collectPaths } from './activity.ts';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const diaryName = /^(\d{4}-\d{2}-\d{2})\.md$/;
/**
 * 谁调用：console/snapshot.ts 建快照源时创建一个；Diary 卡片翻日期时经 /console/diary 读。
 * 参数：diaryDir 是 worlds/<worldId>/diary 的绝对路径，不存在也不创建。
 * 返回：dates() 只列目录顶层的 YYYY-MM-DD.md，按日期倒序；read() 日期不合格式或文件不存在时给 undefined。
 * 失败：读盘出错照常抛出，路由兜成 500，前端显示「读取失败」。
 */
/**
 * 只读的日记访问器；目录不存在时 dates() 返回空数组，read() 返回 undefined。
 * @param diaryDir 日记目录，不存在也不会创建。
 * @returns dates() 按日期倒序；read() 只接受 YYYY-MM-DD。
 */
export function createDiaryReader(diaryDir: string) {
  const dates = () => existsSync(diaryDir) ? readdirSync(diaryDir).filter(name => diaryName.test(name)).map(name => name.slice(0, 10)).sort().reverse() : [];
  /** Only YYYY-MM-DD names are accepted, so a date can never escape the diary directory. */
  const read = (date: string) => { const file = join(diaryDir, `${date}.md`); return datePattern.test(date) && existsSync(file) ? readFileSync(file, 'utf8') : undefined; };
  return { dates, read };
}

/** The host's file tools that change a file; reading tools and the shell are not judged. */
const DIARY_WRITERS = new Set(['write', 'edit']);
/**
 * 【上游参考】
 * 宿主在工具真正执行前调用守卫，守卫返回非空字符串就拦下这次调用；这里沿用这个机制。
 * 只判改文件的两个工具，读文件和 shell 不判，交给宿主自己的规则去管。
 */
/**
 * Why a file tool call may not run: it changes the diary of a day already closed. A wrong or outgrown entry is
 * corrected in today's diary, so what she wrote then stays as she wrote it. Only `YYYY-MM-DD.md` files directly in the
 * diary directory are dated diaries; any other file there is left to her. Relative paths resolve against `cwd`.
 */
/**
 * 谁调用：runtime.ts 的 guard，每次宿主工具调用前都会问一次。
 * 参数：tool 是宿主工具名；args 是原始参数；cwd 是这次调用的工作目录；
 *   open 是 openDiaryDays() 给出的开放日期；today 是配置时区里的今天，只用来在拒绝文案里指路。
 * 返回：不拦返回 undefined；拦下返回一段以「已经合上了」开头的中文说明。
 * 时机：只认 write/edit；回顾还没结束的那天仍在 open 里，所以跨过午夜也不会被当成旧账。
 */
export function closedDiaryRefusal(tool: string, args: unknown, diaryDir: string, cwd: string, open: ReadonlySet<string>, today: string): string | undefined {
  if (!DIARY_WRITERS.has(tool)) return undefined;
  for (const path of collectPaths(args, false, [])) {
    // 相对路径按这次调用的 cwd 解析，和宿主工具实际会写的文件保持一致。
    const file = resolve(cwd, path);
    const day = diaryName.exec(basename(file))?.[1];
    // 不是日记、当天还开着、或不在日记目录顶层，都放行。
    if (!day || open.has(day) || relative(resolve(diaryDir), dirname(file)) !== '') continue;
    return `${day} 的日记已经合上了，不能再改。写错了或者现在想法不一样了，就写进今天（${today}）的日记：哪里记错了、现在怎么看。`;
  }
  return undefined;
}
