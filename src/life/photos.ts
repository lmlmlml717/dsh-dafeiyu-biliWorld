/**
 * 她的相册：图片字节和索引存在同一个 SQLite 里，旧的 JSON 相册在首次打开时一次性搬进来。
 *
 * 导出：PhotoSummary、createPhotoStore、PhotoStore 类型。
 * 调用方：life/photoTools.ts（keep_photo/list_photos/forget_photo）、runtime 注入。
 * 依赖：node:sqlite、node:fs、@deepseek-ai/dsh-attachment 的图片引用类型。
 * 坑：迁移和写入都在事务里，任何一张旧图不合法就整批回滚、原文件不动；
 * 只接受 png/jpeg/webp/gif 且不超过 20MB；旧图路径要防软链接和目录穿越。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment';

/** 列表里的一张照片：只带元数据，不带图片字节。 */
export interface PhotoSummary { id: string; savedAt: string; attachmentId: string; mediaType: string; bytes: number; width: number; height: number; description: string; tags: string[] }
interface Row { id: string; savedAt: string; ref: string; description: string; tags: string; data?: Uint8Array }
// 单张上限 20MB：再大就不适合塞进数据库，也超出聊天图片的常见尺寸。
const MAX_BYTES = 20 * 1024 * 1024;
// 入参可能来自宿主附件层或旧相册，仍然要验一遍：类型、尺寸、字节数和大小上限。
function validate(image: StoredImageAttachment): void {
  const ref = image.ref;
  if (!ref || typeof ref.attachmentId !== 'string' || !ref.attachmentId || ref.attachmentId.length > 200
    || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType)
    || !Number.isSafeInteger(ref.width) || ref.width < 1 || !Number.isSafeInteger(ref.height) || ref.height < 1
    || !(image.data instanceof Uint8Array) || image.data.byteLength !== ref.bytes || ref.bytes < 1 || ref.bytes > MAX_BYTES) throw new Error('图片格式或大小校验失败（最多 20MB）');
}
function summary(row: Row): PhotoSummary {
  const ref = JSON.parse(row.ref) as ImageAttachmentRef;
  return { id: row.id, savedAt: row.savedAt, attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, description: row.description, tags: JSON.parse(row.tags) as string[] };
}
function metadata(description: string, tags: readonly string[]) {
  if (typeof description !== 'string' || description.length > 500 || !Array.isArray(tags) || tags.length > 8 || tags.some(tag => typeof tag !== 'string' || tag.length > 40)) throw new Error('照片说明最多 500 字，标签最多 8 个、每个最多 40 字');
  return { description: description.trim(), tags: [...new Set(tags.map(tag => tag.trim()).filter(Boolean))] };
}

/** Image bytes and their index share one transaction; earlier JSON albums remain intact. */
export function createPhotoStore(worldDir: string, clock = () => new Date()) {
  const directory = join(worldDir, 'photos'); mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'album.sqlite'));
  // 显式事务：索引和字节必须一起成功或一起失败。
  const transaction = <T>(run: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = run(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const insert = (id: string, savedAt: string, image: StoredImageAttachment, description: string, tags: readonly string[]) => {
    validate(image); const meta = metadata(description, tags);
    db.prepare('INSERT INTO photos VALUES (?,?,?,?,?,?,?)').run(id, savedAt, image.ref.attachmentId, JSON.stringify(image.ref), meta.description, JSON.stringify(meta.tags), image.data);
  };
  try {
    transaction(() => {
      db.exec('CREATE TABLE IF NOT EXISTS photos(id TEXT PRIMARY KEY,savedAt TEXT NOT NULL,attachmentId TEXT UNIQUE NOT NULL,ref TEXT NOT NULL,description TEXT NOT NULL,tags TEXT NOT NULL,data BLOB NOT NULL)');
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      // user_version 是相册格式的版本；不认识的版本停下，别去动别人的数据。
      if (version !== 0 && version !== 1) throw new Error('相册版本不受支持，原数据未修改');
      if (version !== 0) return;
      const legacy = join(directory, 'index.json');
      if (existsSync(legacy)) {
        const old = JSON.parse(readFileSync(legacy, 'utf8')) as { version: number; photos: { id: string; savedAt: string; file: string; attachment: ImageAttachmentRef; description: string; tags: string[] }[] };
        if (old.version !== 1 || !Array.isArray(old.photos)) throw new Error('旧相册索引格式无效，原文件未修改');
        // 倒着插：列表按 rowid 倒序读，旧索引里越新的越靠后，反过来才能保持原来的时间顺序。
        for (const row of old.photos.reverse()) {
          if (!/^photo-[a-z0-9-]+$/i.test(row.id) || !Number.isFinite(Date.parse(row.savedAt)) || !new RegExp(`^${row.id}\\.(png|jpg|webp|gif)$`).test(row.file)) throw new Error('旧相册包含无效图片路径，原文件未修改');
          const file = join(directory, row.file);
          // 旧索引里的路径也要防软链接和目录穿越，避免把相册外的文件读进来。
          if (lstatSync(file).isSymbolicLink() || dirname(realpathSync(file)) !== realpathSync(directory) || lstatSync(file).size > MAX_BYTES) throw new Error('旧相册图片路径或大小无效');
          insert(row.id, row.savedAt, { ref: row.attachment, data: readFileSync(file) }, row.description, row.tags);
        }
      }
      db.exec('PRAGMA user_version=1');
    });
  } catch (error) { db.close(); throw error; }
  return {
    list(limit = 20, offset = 0) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('相册分页参数无效');
      // 多取一条，用来判断后面还有没有下一页。
      const rows = db.prepare('SELECT id,savedAt,ref,description,tags FROM photos ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit + 1, offset) as unknown as Row[];
      const total = Number(db.prepare('SELECT count(*) AS total FROM photos').get()!.total);
      return { photos: rows.slice(0, limit).map(summary), total, hasMore: rows.length > limit, limit, offset };
    },
    keep(image: StoredImageAttachment, description = '', tags: readonly string[] = []): PhotoSummary {
      validate(image); metadata(description, tags);
      return transaction(() => {
        // 同一张附件只存一份：重复收藏直接返回已有的那张。
        const existing = db.prepare('SELECT id,savedAt,ref,description,tags FROM photos WHERE attachmentId=?').get(image.ref.attachmentId) as unknown as Row | undefined;
        if (existing) return summary(existing);
        const id = `photo-${randomUUID()}`;
        insert(id, clock().toISOString(), image, description, tags);
        return summary(db.prepare('SELECT id,savedAt,ref,description,tags FROM photos WHERE id=?').get(id) as unknown as Row);
      });
    },
    image(id: string): StoredImageAttachment | undefined {
      const row = db.prepare('SELECT ref,data FROM photos WHERE id=?').get(id) as unknown as Row | undefined;
      return row ? { ref: JSON.parse(row.ref) as ImageAttachmentRef, data: row.data! } : undefined;
    },
    forget(id: string): void {
      // 删除必须恰好命中一行，否则说明 id 不对，不能静默成功。
      transaction(() => { if (db.prepare('DELETE FROM photos WHERE id=?').run(id).changes !== 1) throw new Error('找不到这张照片'); });
    },
    close() { db.close(); },
  };
}
/** createPhotoStore 的返回类型。 */
export type PhotoStore = ReturnType<typeof createPhotoStore>;
