// 统一路径解析 —— dsh-world B站工具链。
// 设计来自 dsh-bili-whale 的 tools/lib/paths.mjs（MIT），路径前缀改为 dsh-world。
//
// 两个 home 的语义（与 bili-whale / feiyu 一致，避免分叉）：
//   · DSH_HOME  —— DSH 的根（配置、会话、night 状态）
//   · HOME      —— 用户主目录（凭据、账本等"随人走"的东西放 ~/.dsh/worlds/<id>/bili）
//
// 关键设计：BILI_ROOT / WORLD_ID 相关的**全部用函数**，不能用顶层常量缓存。
// 宿主可能同时跑多个 world（miko / tata），顶层常量在第一个模块 import 时
// 就快照了 WORLD_ID，导致后续 world 拿到错误路径。每次函数调用都从
// process.env 读最新值。
//
// 【模块卡片】
// 职责：把所有数据/配置文件的位置收口到一处，并让路径跟着当前 world 走。
// 导出：HOME / DSH_HOME / dshPath / homePath / getWorldId / getBiliRoot / dataPath /
//       getConfigPath / getCredentialsPath / getLogsDir。
// 调用方：tools 下所有命令与 lib、宿主 src/bili/quota.ts、src/bili/mood.ts。
// 数据文件：~/.dsh/worlds/<id>/bili.config.json（配置）、<bili 根>/credentials.json、logs/。
// 坑：凡是和 BILI_ROOT / WORLD_ID 有关的都必须是函数；顶层常量只会在首次 import 时快照。
// 【链路位置】
//   环节：所有数据/配置路径的唯一解析点 —— lib 层与命令都经它拼目录，宿主 src/bili/quota.ts、mood.ts 也走同一套。
//   上游调用：tools 下所有命令与 lib；宿主 src/bili/*（按 WORLD_ID 解析到同一个 world 目录）。
//   下游调用：node:os / node:path；不读配置文件本身。
//   读写文件：只拼路径、不读写；产出 ~/.dsh/worlds/<id>/bili（数据根）、bili.config.json、credentials.json、logs/。
//   退出码：库不设退出码；输入不合法不抛错，按默认值拼路径。
//   上游参考：设计来自 dsh-bili-whale 的 tools/lib/paths.mjs（MIT），前缀与变量名改为 dsh-world 这一套。
import os from 'node:os'
import path from 'node:path'

/** 用户主目录（Windows 优先 USERPROFILE）。 */
// 先读 USERPROFILE 而不是直接 os.homedir()：Windows 上服务账户/提权进程的 homedir 可能与
// 用户实际目录不同，这里要和宿主、其它工具链解析到同一个位置。
export const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.'

/** DSH home：与宿主半边完全一致的解析顺序。 */
export const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')

/** DSH home 下的路径。 */
export const dshPath = (...parts) => path.join(DSH_HOME, ...parts)

/** 用户主目录下的路径。 */
export const homePath = (...parts) => path.join(HOME, ...parts)

// 【补充】调用方：getBiliRoot() / getConfigPath() / ledger 的 mineWorkspace 默认值。
//   参数：无。返回：process.env.WORLD_ID，未设置时 'default'。
//   失败：不抛错；空串也当未设置（走 'default'，避免拼出 worlds//bili）。
/** 当前 world 的 id — 运行时读取，不缓存。 */
export function getWorldId() { return process.env.WORLD_ID || 'default' }

// 【补充】调用方：dataPath() 与 lib 层所有数据文件；宿主 src/index.ts 的 biliRoot_() 也按同一规则解析。
//   参数：无。返回：WORLD_BILI_DATA_DIR（绝对化后）或 ~/.dsh/worlds/<id>/bili。
//   失败：不抛错；环境变量给相对路径时会按当前工作目录解析。
/** B站工具链专属数据根 — 运行时解析。 */
export function getBiliRoot() {
  // WORLD_BILI_DATA_DIR 是测试/多实例的逃生口：显式给了就完全以它为准，不再拼 world 路径。
  if (process.env.WORLD_BILI_DATA_DIR) return path.resolve(process.env.WORLD_BILI_DATA_DIR)
  return dshPath('worlds', getWorldId(), 'bili')
}

// 【补充】调用方：所有 lib 与命令拼数据文件（quota.json / mood.json / credentials.json / 缓存目录等）。
//   参数：任意段路径。返回：数据根下的绝对路径；每次调用都重新读环境变量。
//   失败：不抛错；不检查父目录是否存在，建目录由写文件的一方负责。
/** 数据目录下的路径。每次调用都从运行时 BILI_ROOT 解析。 */
export function dataPath(...parts) { return path.join(getBiliRoot(), ...parts) }

// 【补充】调用方：lib/config.mjs 的 config()、tools/bili.mjs 的 deps、宿主控制台的 readBiliConfig 用同一路径。
//   参数：无。返回：WORLD_BILI_CONFIG 或 ~/.dsh/worlds/<id>/bili.config.json。
//   失败：不抛错；文件不存在由读的一方当「没有用户配置」。
/** 插件配置文件（WORLD_BILI_CONFIG 可覆盖）。不含凭据。 */
// 配置故意留在 world 目录、不放进 bili 数据根：清空数据目录时不该把主人的口味设置一起删掉。
export function getConfigPath() {
  return process.env.WORLD_BILI_CONFIG || dshPath('worlds', getWorldId(), 'bili.config.json')
}

// 【补充】调用方：lib/cred.mjs 的 loadCred/saveCred、tools/bili.mjs 的 deps。
//   参数：无。返回：<数据根>/credentials.json。
//   失败：不抛错；凭据文件本身缺失由 loadCred 给人话指引。
/** 凭据（与配置分离；0600；永不回显）。 */
export function getCredentialsPath() { return dataPath('credentials.json') }

// 【补充】调用方：目前只有文档与排障会用到；日志三件套（requests / ban / cache）实际落在数据根，不在 logs/。
//   参数：无。返回：<数据根>/logs。
//   失败：不抛错；目录不存在也不创建。
/** 日志目录（requests / ban / cache 都在这里）。 */
export function getLogsDir() { return dataPath('logs') }
