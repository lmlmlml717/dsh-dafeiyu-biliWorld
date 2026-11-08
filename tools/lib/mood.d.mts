/**
 * 情绪 tick。每次唤醒/对话前调用一次。
 * ① 饭点 hunger +mealGain（封顶 hungerCap）② 非饭点 -decayPerTick
 * ③ 饿过头（>60）心情 -hungryMoodPenalty ④ 6% 概率无理由波动 {-9,-4,+5,+8} ⑤ clamp 0-100
 * ⑥ 跨天：心情朝 moodBase 软回归（新的一天不背着昨天的低谷）
 */
export function tickMood(random?: () => number): {
    value: number;
    hunger: number;
    updatedAt: any;
    day: any;
};
/**
 * 吃到饭 / 主人说了他吃了 → 饥饿直接掉下来（10-27）。
 * 这是"连问十次吃没吃饭"的止血点：他答过一次，她就该真的不饿了。
 */
export function fed(level?: number): {
    value: number;
    hunger: number;
    updatedAt: any;
    day: any;
};
export function mood(): {
    value: number;
    hunger: number;
    updatedAt: any;
    day: any;
};
export function stateBlock(turnsToday?: number, platform?: string, isGroup?: boolean): string;
/**
 * 走神注入 —— 8% 概率嘀咕一句，多了就成噪音（dafeiyu：别超过 10%）。
 * ⚠️ 10-27：原来三条**全是吃的**，等于每天几十次给她"想想吃的"的心理暗示，
 * 跟"连问吃没吃饭"是一条绳上的。现在只有三分之一跟吃有关，其余是别的生活小事。
 */
export function distract(random?: () => number): string;
