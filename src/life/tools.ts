/**
 * 她手里的生活工具：定闹钟/查闹钟/取消闹钟，以及把话送到外面（reach_out）。
 *
 * 导出：AlarmDescriptions、LifeToolHost、alarmDescriptions、lifeTools。
 * 调用方：life/runtime.ts 把真实实现注入进来，再由 toolRegistry 挂到 Agent 上。
 * 依赖：defineTool、messages 的模板、notify.Notifier、outlets.pushOf、worldPrompt.WorldNames。
 * 坑：check_alarm/cancel_alarm 只有宿主同时提供两个实现时才出现，避免出现只能定不能查的工具；
 * reach_out 的每个通道独立成败，全失败才抛错，部分成功照实汇报。
 * 通道从 notifier 来：toast（仅 Windows）+ 配置的 outlets + 0.9.4 起 qq-native 注册的 QQ 私聊出口
 * （由 src/index.ts 组进 outlets，kinds 只有 reach；静默/离线时抛错，不排队）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Notifier } from './notify.ts';
import type { WorldNames } from '../worldPrompt.ts';
import { exampleTime, fillMessage, readAlarmMessages } from './messages.ts';
import { pushOf } from '../ecosystem/shared/outlets.ts';

/** 三段工具描述，来自闹钟模板；控制台改模板后重新生成。 */
export interface AlarmDescriptions { plan: string; check: string; cancel: string }
/** lifeTools 需要宿主提供的动作、通道和称呼。 */
export interface LifeToolHost {
  planNext(input: { at?: string; after_minutes?: number }, note: string): string;
  /** With both, check_alarm and cancel_alarm are offered too. */
  checkAlarm?(): string;
  cancelAlarm?(): string;
  notifier: Notifier;
  names?: WorldNames;
  /** The DSH origin, for sticker URLs in her words. */
  origin?(): string | undefined;
  /** From the alarm template; the shipped wording otherwise. */
  descriptions?: AlarmDescriptions;
}
/**
 * 从模板里取 plan_next/check_alarm/cancel_alarm 三段说明，缺的用随包文案。
 * @param messages 合并后的模板节，默认现读。
 * @param values 模板变量，默认给 UTC 示例时间与 09:00 兜底。
 * @returns 三段说明；模板缺节时是空串。
 */
export function alarmDescriptions(messages = readAlarmMessages(undefined), values: Record<string, string> = { example: exampleTime('UTC'), fallbackWakeTime: '09:00' }): AlarmDescriptions {
  return { plan: fillMessage(messages, 'plan_next 说明', values), check: fillMessage(messages, 'check_alarm 说明', values), cancel: fillMessage(messages, 'cancel_alarm 说明', values) };
}
const text = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };

/**
 * 生成生活工具；没有 checkAlarm/cancelAlarm 时只返回 [plan_next, reach_out]。
 * @param host 动作、通道、称呼与可选的工具描述。
 * @returns 至少含 plan_next 与 reach_out；宿主给了查/取实现时再加两个。
 */
export function lifeTools(host: LifeToolHost) {
  const { companion, partner } = host.names ?? { companion: 'TA', partner: '伙伴' };
  const descriptions = host.descriptions ?? alarmDescriptions();
  const planNext = defineTool({
    name: 'plan_next',
    description: descriptions.plan,
    parameters: { at: { type: 'string' }, after_minutes: { type: 'number' }, note: { type: 'string', required: true } },
    output: text,
    execute: async ({ at, after_minutes, note }) => host.planNext({ ...(at === undefined ? {} : { at }), ...(after_minutes === undefined ? {} : { after_minutes }) }, note),
  });
  const { toast, outlets } = host.notifier;
  // 只有声明了 reach 的通道才收「找 TA」的话，其余通道不打扰。
  const reaching = outlets.filter(outlet => outlet.kinds.includes('reach'));
  // 工具描述里把现有通道列出来，没有就明说，免得她以为发出去了。
  const channelNames = [...(toast ? ['系统通知'] : []), ...reaching.map(outlet => outlet.name)];
  const reachOut = defineTool({
    name: 'reach_out',
    description: `想找${partner}时用：先在家里正常把话说出来，再用它把这句话送到${partner}面前（${channelNames.length ? channelNames.join(' + ') : '现在还没有配置任何通道'}）。image 可选，是一个表情的名字，接收的一方认得才会显示。找${partner}时说一两句就好，细节留在家里，${partner}来了自己会看。`,
    parameters: { text: { type: 'string', required: true }, image: { type: 'string' } },
    output: text,
    execute: async ({ text: message, image }) => {
      if (!channelNames.length) throw new Error('现在还没有配置任何通道，话留在家里了。');
      const push = pushOf(message, 'reach', companion, host.origin?.(), image);
      const channels: [string, string, Promise<void>][] = [
        ...(toast ? [['系统通知', '已发出', toast.call(host.notifier, companion, message)] as [string, string, Promise<void>]] : []),
        ...reaching.map(outlet => [outlet.name, '已送到', outlet.send(push)] as [string, string, Promise<void>]),
      ];
      // 各通道互不等待：一个失败不该拖住其他通道，也不该把已送到的说成没送到。
      const results = await Promise.allSettled(channels.map(([, , sent]) => sent));
      const summary = `${results.map((result, index) => { const [name, done] = channels[index]!; return result.status === 'fulfilled' ? `${name}${done}` : `${name}没送到：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`; }).join('；')}。`;
      if (results.every(result => result.status === 'rejected')) throw new Error(summary);
      return summary;
    },
  });
  const { checkAlarm, cancelAlarm } = host;
  if (!checkAlarm || !cancelAlarm) return [planNext, reachOut] as const;
  const check = defineTool({ name: 'check_alarm', description: descriptions.check, parameters: {}, output: text, execute: async () => checkAlarm.call(host) });
  const cancel = defineTool({ name: 'cancel_alarm', description: descriptions.cancel, parameters: {}, output: text, execute: async () => cancelAlarm.call(host) });
  return [planNext, reachOut, check, cancel] as const;
}
