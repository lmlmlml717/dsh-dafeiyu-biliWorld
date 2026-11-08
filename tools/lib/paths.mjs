// 统一路径解析 —— dsh-world B站工具链。
// 设计来自 dsh-bili-whale 的 tools/lib/paths.mjs（MIT），路径前缀改为 dsh-world。
//
// 两个 home 的语义（与 bili-whale / feiyu 一致，避免分叉）：
//   · DSH_HOME  —— DSH 的根（配置、会话、night 状态）
//   · HOME      —— 用户主目录（凭据、账本等"随人走"的东西放 ~/.dsh/worlds/<id>/bili）
//
// 关键设计：BILI_ROOT / WORLD_ID 相关的**全部用函数**，不能用顶层常量缓存。
// 宿主可能同时跑多个 world（world-a / world-b），顶层常量在第一个模块 import 时
// 就快照了 WORLD_ID，导致后续 world 拿到错误路径。每次函数调用都从
// process.env 读最新值。
import os from 'node:os'
import path from 'node:path'

/** 用户主目录（Windows 优先 USERPROFILE）。 */
export const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.'

/** DSH home：与宿主半边完全一致的解析顺序。 */
export const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')

/** DSH home 下的路径。 */
export const dshPath = (...parts) => path.join(DSH_HOME, ...parts)

/** 用户主目录下的路径。 */
export const homePath = (...parts) => path.join(HOME, ...parts)

/** 当前 world 的 id — 运行时读取，不缓存。 */
export function getWorldId() { return process.env.WORLD_ID || 'default' }

/** B站工具链专属数据根 — 运行时解析。 */
export function getBiliRoot() {
  if (process.env.WORLD_BILI_DATA_DIR) return path.resolve(process.env.WORLD_BILI_DATA_DIR)
  return dshPath('worlds', getWorldId(), 'bili')
}

/** 数据目录下的路径。每次调用都从运行时 BILI_ROOT 解析。 */
export function dataPath(...parts) { return path.join(getBiliRoot(), ...parts) }

/** 插件配置文件（WORLD_BILI_CONFIG 可覆盖）。不含凭据。 */
export function getConfigPath() {
  return process.env.WORLD_BILI_CONFIG || dshPath('worlds', getWorldId(), 'bili.config.json')
}

/** 凭据（与配置分离；0600；永不回显）。 */
export function getCredentialsPath() { return dataPath('credentials.json') }

/** 日志目录（requests / ban / cache 都在这里）。 */
export function getLogsDir() { return dataPath('logs') }
