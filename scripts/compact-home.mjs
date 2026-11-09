#!/usr/bin/env node
// Asks a running world to compact her home conversation once (held behind her running turn).
// Needs `bridge: true` in the plugin config. Usage: node scripts/compact-home.mjs [world directory]
// The world directory defaults to $DSH_WORLD_DIR, then ~/.dsh/worlds/<the only world there>.
// 【文件头】让正在运行的世界压缩一次「家会话」：POST /dsh-world/bridge/compact，她忙的话等这一轮跑完再压。
// 参数：位置参数可选，世界目录（缺省 $DSH_WORLD_DIR，再缺省 ~/.dsh/worlds 下唯一的世界）。
// 读写：读 <世界目录>/bridge.json 拿 origin 与 token；不写本地文件，压缩由宿主完成。
// 输出：受理与否的中文说明打到 stdout，失败原因打 stderr。
// 退出码：0 已受理；1 找不到目录/bridge、请求失败或宿主没受理。
// 坑：世界必须正在跑且开了 bridge；候选不止一个世界时必须显式传路径，脚本不去猜。
//       15 秒超时是给宿主排队的余量，不是压缩耗时的上限。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function worldDir() {
  // 参数 → 环境变量 → 唯一候选，三级依次退让：候选不止一个时宁可报错，也不替人挑一个来压。
  if (process.argv[2]) return process.argv[2];
  if (process.env.DSH_WORLD_DIR) return process.env.DSH_WORLD_DIR;
  const root = join(homedir(), '.dsh', 'worlds');
  const worlds = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) : [];
  if (worlds.length !== 1) throw new Error(`找不到唯一的世界目录，请把路径作为参数传入（在 ${root} 下找到 ${worlds.length} 个）`);
  return join(root, worlds[0]);
}

try {
  // bridge.json 是宿主运行时写的：它不在，要么世界没跑，要么配置里没开 bridge —— 两种都只能让人自己去查。
  const file = join(worldDir(), 'bridge.json');
  if (!existsSync(file)) throw new Error(`没有 ${file}：世界没有在运行，或者没有开启 bridge`);
  const { origin, token } = JSON.parse(readFileSync(file, 'utf8'));
  const response = await fetch(new URL('/dsh-world/bridge/compact', origin), { method: 'POST', headers: { 'x-dsh-world-token': token }, signal: AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => ({}));
  // 202 = 已排队，不是已压完：宿主回得很快，真正的压缩要等她手上这一轮结束。
  if (response.status === 202) console.log('已请求压缩家会话；她正在忙的话会等这一轮结束后再压缩。');
  else { console.error(`没有受理（${response.status}）：${body.error ?? '未知原因'}`); process.exitCode = 1; }
} catch (error) {
  // 设退出码而不是 process.exit()：报错信息还在缓冲里，硬退会把它一起吞掉。
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
