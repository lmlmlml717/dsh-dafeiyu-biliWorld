/** 用户主目录（Windows 优先 USERPROFILE）。 */
export const HOME: string;
/** DSH home：与宿主半边完全一致的解析顺序。 */
export const DSH_HOME: string;
export function dshPath(...parts: any[]): string;
export function homePath(...parts: any[]): string;
/** 当前 world 的 id（world 宿主注入；没注入就 default）。 */
export const WORLD_ID: string;
/** B站工具链专属数据根：凭据 / 账本 / 缓存 全放这里，跟 world 其他数据物理隔离。 */
export const BILI_ROOT: string;
export function dataPath(...parts: any[]): string;
/** 插件配置文件（WORLD_BILI_CONFIG 可覆盖）。不含凭据。 */
export const configPath: string;
/** 凭据（与配置分离；0600；永不回显）。 */
export const credentialsPath: string;
/** 日志目录（requests / ban / cache 都在这里）。 */
export const logsDir: string;
