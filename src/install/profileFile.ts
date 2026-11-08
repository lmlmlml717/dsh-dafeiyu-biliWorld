import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * profile 目录里文件的读、备份、原子写。
 *
 * 为什么单独一层：插件会改写宿主 profile 的 `package.json`（自注册）和 `cordis.patch.yml`（换压缩）。这两个
 * 文件坏一个字节，DSH 下次启动就停在解析阶段、桌面版直接打不开（0.8.0 的 `[]` 后面接 `- insert:` 就是这么
 * 炸的）。所以所有写盘动作都走这里，并且只有一种顺序：
 *
 *   备份 → 写同目录临时文件 → rename 覆盖
 *
 * rename 在同一卷上是原子的：崩在中间只会留下「完整的旧文件」或「完整的新文件」，外加一个可以删掉的 `.tmp`，
 * 不会出现写了一半的 YAML。
 */

/** 读文本；文件不存在时返回 undefined，让调用方区分「没有这个文件」和「文件是空的」。 */
export function readTextIfExists(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

/** 在文件旁边留一份 `<文件名>.<tag>.<随机>.bak`，返回备份路径。备份排在改名之前，所以永远能回滚。 */
export function backupBeside(file: string, tag = 'dsh-world-bili'): string {
  const backup = `${file}.${tag}.${randomBytes(16).toString('hex')}.bak`;
  copyFileSync(file, backup);
  return backup;
}

/** 原子替换整个文件；失败时清掉临时文件并原样抛出，原文件不动。 */
export function replaceAtomically(file: string, text: string): void {
  const temporary = `${file}.${randomBytes(16).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, text, 'utf8');
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
