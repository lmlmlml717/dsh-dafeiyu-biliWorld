/** 别名 → 规范名（她可能写 bili / B站 / 刷） */
export function normActivity(a: any): string;
export function labelOf(a: any): any;
/** 读当下状态。文件不在 / 坏了都返回 null —— 不干预。 */
export function readFocus(): any;
/**
 * 写下"我现在在干什么"。
 * @param {string} activity bilibili|rest|off
 * @param {number} min 打算干多久（分钟，0 = 不设时限，靠她自己收工）
 * @param {string} note 一句话（写给自己/给主人看的由头）
 */
export function writeFocus(activity: string, min?: number, note?: string): {
    activity: string;
    until: number;
    setAt: number;
    min: number;
    note: string;
};
export function clearFocus(): void;
/** 组装一份好用的快照（提示语里直接念给人听）。 */
export function focusSnapshot(now?: number): {
    activity: string;
    label: string;
    remainMin: number;
    expired: boolean;
    note: string;
    setAgoMin: number;
    min?: undefined;
} | {
    activity: string;
    label: any;
    remainMin: number;
    expired: boolean;
    note: string;
    setAgoMin: number;
    min: number;
};
/** 把配置里的开关对齐到"当下只开一个"（world 精简版只判断 bilibili 的 freeRoam）。 */
export function syncSwitches(cfg: any, activity: any): boolean;
export const FOCUS_PATH: string;
export namespace LOOP_ACTIVITIES {
    namespace bilibili {
        let label: string;
        let hint: string;
    }
}
export function isLoopActivity(a: any): boolean;
