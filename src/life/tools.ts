import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Notifier } from './notify.ts';
import type { WorldNames } from '../worldPrompt.ts';
import { exampleTime, fillMessage, readAlarmMessages } from './messages.ts';
import { pushOf } from '../ecosystem/shared/outlets.ts';

export interface AlarmDescriptions { plan: string; check: string; cancel: string }
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
export function alarmDescriptions(messages = readAlarmMessages(undefined), values: Record<string, string> = { example: exampleTime('UTC'), fallbackWakeTime: '09:00' }): AlarmDescriptions {
  return { plan: fillMessage(messages, 'plan_next 说明', values), check: fillMessage(messages, 'check_alarm 说明', values), cancel: fillMessage(messages, 'cancel_alarm 说明', values) };
}
const text = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };

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
  const reaching = outlets.filter(outlet => outlet.kinds.includes('reach'));
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
