// 【文件头】把旧表情包插件的库（catalog.json + assets/）一次性导入世界自己的表情库，
// 保留 id、名字、标签；packs 与长释义不带。
// 参数：argv[0] 旧表情包目录，argv[1] 世界目录（两个都必填，路径都会 resolve）。
// 读写：只读旧目录；写 <世界目录>/stickers（经 lib/ecosystem/wechat/stickerLibrary.js）。
// 输出：一行汇总（导入 / 已在库里 / 跳过）+ 每条跳过原因。
// 退出码：0 导入完成（重复跑也不报错，只是加不进新的）；2 缺参数。
// 坑：旧目录只读，一个字节都不改；重复跑是幂等的，但不会更新已经在库里的表情包内容。
// One-time import of the older sticker plugin's library (catalog.json + assets/) into the world's own sticker library.
// Usage: node scripts/import-stickers.mjs <older library folder, e.g. ~/.dsh/memes> <world folder, e.g. ~/.dsh/worlds/<id>>
// Ids, names and tags carry over; packs and long meanings do not. Running it again adds nothing. The older folder is only read.
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const [legacy, world] = process.argv.slice(2);
if (!legacy || !world) {
  console.error('用法：node scripts/import-stickers.mjs <旧表情包目录> <世界目录>');
  process.exit(2);
}
// 引编译好的 lib/ 而不是 src/：脚本本身是 .mjs，跑它的机器上不一定有 TypeScript。
const modulePath = join(fileURLToPath(new URL('..', import.meta.url)), 'lib', 'ecosystem', 'wechat', 'stickerLibrary.js');
// Windows 的盘符路径不能直接进动态 import，必须转成 file:// URL。
const { createStickerLibrary, importLegacyStickers } = await import(pathToFileURL(modulePath).href);
// 表情库挂在世界目录下：世界搬到哪，库就跟到哪，不另存一份全局目录。
const library = createStickerLibrary(join(resolve(world), 'stickers'));
const report = await importLegacyStickers(resolve(legacy), library);
console.log(`导入 ${report.imported} 张，已在库里的 ${report.duplicates} 张，跳过 ${report.skipped.length} 张；表情库现有 ${(await library.list()).length} 张。`);
for (const line of report.skipped) console.log(`  跳过 ${line}`);
