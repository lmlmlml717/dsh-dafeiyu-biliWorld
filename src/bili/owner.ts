// 主人是谁 —— 宿主侧的唯一口径。
//
// 为什么单独一个文件：这个判断以前散在四处（推她自主动的话、发分享、标「（你主人）」、学昵称），
// 又各写了一遍 `config.ownerQQ || config.allowPrivate[0]`。四处只要有一处口径不同，就会出现
// 「话推给 A、标记给 B」这种自相矛盾。这里收成两个纯函数，宿主只用它们，测试也直接测它们。
//
// 工具链（tools/）不读这份：它只认 `<world>/bili.config.json` 的 owner 段，
// 由宿主启动时用 mirrorOwnerConfig 把这里的 `qq` 抄过去（debrief 打码用）。
//
// 【模块卡片】
// 职责：决定「主人是哪个 QQ」，并把学到的昵称/QQ 合并进 bili.config.json 的 owner 段。
// 导出：OwnerSourceLike / OwnerPatch / ownerQqOf / mergeOwner。
// 调用方：src/index.ts 的 mirrorOwnerConfig 与 qq-native 的 ownerId。
// 数据文件：不读写文件（纯函数）；写盘由调用方负责。
// 坑：学到的昵称只在 owner.name 为空时补 —— 面板/手写填过的名字优先，别被 QQ 昵称覆盖。
// 【链路位置】
//   环节：「主人是谁」的唯一定义处 —— 推她自主发言、发分享、标「（你主人）」、镜像 owner 段都只问这里。
//   上游调用：src/index.ts 的 mirrorOwnerConfig（把 qq/name 抄进 bili.config.json）、qq-native 的 ownerId。
//   下游调用：无（纯函数，只读传入的配置对象）。
//   读写文件：不读不写；写盘由 mirrorOwnerConfig 负责。
//   失败：ownerQqOf 三个来源都空时返回空串；mergeOwner 不抛错，返回 changed 让调用方决定要不要写盘。
import type { WorldConfig } from '../types.ts';

/** 只取判断主人要用的两个字段：世界主配置的结构子集（测试可以只造这几个字段）。 */
export type OwnerSourceLike = Pick<WorldConfig, 'qqNative' | 'dailyBili'>;

/** 这一次要合并进 owner 段的字段。 */
export interface OwnerPatch {
  /** 主人的 QQ 号（来自 qqNative.ownerQQ 等）。 */
  qq?: string;
  /** 从她的私聊里学到的昵称。 */
  name?: string;
}

/**
 * 主人是哪一个 QQ：`qqNative.ownerQQ` 是第一来源，没配就退回 `dailyBili.ownerQQ`，
 * 再退回白名单第一个（和「推她自主动的话」「发分享」同一个口径）。
 * @param config 世界主配置（只读 qqNative / dailyBili）
 * @returns QQ 号；三个来源都空时返回空串
 */
export function ownerQqOf(config: OwnerSourceLike | undefined): string {
  // 逐个 trim 再判断：写成空白串的 ownerQQ 等于没配，不能把白名单的来源挡掉。
  for (const value of [config?.qqNative?.ownerQQ, config?.dailyBili?.ownerQQ, config?.qqNative?.allowPrivate?.[0]]) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

/**
 * 把这一轮的补丁合并进 owner 段。
 *
 * - `qq` 每次都写（它就是主人数本身，改了就该跟）；
 * - `name` 只在原来空着的时候写：你手填过的名字比 QQ 昵称可信；
 * - 一个字段都没变时 `changed` 为 false，调用方据此跳过写盘（这个函数在每条主人消息上都会被叫到）。
 * @param current bili.config.json 里现在的 owner 段（可缺省/不合法）
 * @param patch 这一次要合并的字段
 * @returns 合并后的 owner 段，以及是否真的有变化
 */
export function mergeOwner(current: unknown, patch: OwnerPatch): { owner: Record<string, unknown>; changed: boolean } {
  const base = current && typeof current === 'object' ? current as Record<string, unknown> : {};
  const qq = String(patch.qq ?? '').trim();
  const name = String(patch.name ?? '').trim();
  const owner: Record<string, unknown> = { ...base, ...(qq ? { qq } : {}) };
  if (name && !String(base.name ?? '').trim()) owner.name = name;
  return { owner, changed: JSON.stringify(owner) !== JSON.stringify(base) };
}
