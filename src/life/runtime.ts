/**
 * 生活线的装配处：一个待响的闹钟、她的家、新家问候、每日回顾、花费与工具，全在这里接起来。
 *
 * 导出：LifeDeps、createLifeRuntime、LifeRuntime 类型。
 * 调用方：插件入口在启动/停止生活线时创建它，控制台通过返回的 snapshot/reschedule 读取和改作息。
 * 依赖：home、alarm、alarmTimer、earlyStop、journal、toolRegistry、photos、pricing、lifeStore 等。
 * 坑：投递以「宿主日志里出现这条 user/message」为准，不是 steer 不抛错就算送达；
 * 一句话先写进 life.json 再发，崩溃或重载后靠 reconcile 判定已送达、还在排队，还是重发。
 */
/**
 * 【链路位置】
 * 整条日记/回顾链路的装配与驱动：排期、到点投递、日记守卫、控制台读取都从这里接出去。
 * 上游：插件入口在启动/停止生活线时创建它；控制台经 snapshot 读作息、经 setSchedule 改作息。
 * 下游：nextReview/reviewOf/reviewText 算时刻与文案，say()/deliver() 送进她的家；closedDiaryRefusal 经 guard 拦住改写。
 * 读写：life.json（state）、worlds/<worldId>/diary/YYYY-MM-DD.md（经她的 write/edit）、回顾材料与我是谁（selfFile）。
 * 时序：start 排第一次 → 到点 deliver → 她开始这一步后 confirmed → lookBack 在投递前把 state.review 滚到下一天。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type {} from '@deepseek-ai/dsh-agent-loop';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-system-prompt';
import '../hostContract.ts';
import { errorText, Faults } from '../faults.ts';
import { keepSelfCopy } from '../self.ts';
import { formatLocalTime } from '../timeContext.ts';
import { inWorld } from '../sourceArchive.ts';
import type { WorldConfig } from '../types.ts';
import { homeTitle, roomTitle, worldNames } from '../worldPrompt.ts';
import { admit, reassembleOnChange } from '../worldScope.ts';
import { budgetText, cancelReply, greetingText, checkReply, earlyStopText, nextLocalTime, nextReview, planReply, resolveAlarmTime, reviewOf, reviewText, wakeText } from './alarm.ts';
import { summarizeSince } from './activity.ts';
import { createAlarmTimer, realTimers, type LifeTimers } from './alarmTimer.ts';
import { createEarlyStopWatch } from './earlyStop.ts';
import { closedDiaryRefusal } from './diary.ts';
import { createHome } from './home.ts';
import type { LifeHost } from './host.ts';
import { createJournal } from './journal.ts';
import { stepCost } from './pricing.ts';
import type { LifeStore } from './lifeStore.ts';
import { exampleTime, readAlarmMessages } from './messages.ts';
import type { Notifier } from './notify.ts';
import { createToolRegistry } from './toolRegistry.ts';
import { alarmDescriptions, lifeTools } from './tools.ts';
import type { PhotoStore } from './photos.ts';
import { photoTools } from './photoTools.ts';
import type { Alarm, Greeting, LifeOptions, PendingWake, Review, WakeRecord } from './types.ts';

// 5 分钟还没开始第一步就在控制台报「卡住了」，而不是无限等下去。
/** How long a word may sit in her home without its turn starting a step before the console says so. */
const STALL_MINUTES = 5;
// 有值才放进对象：模板变量里空字符串和「没有」不是一回事。
const withValue = <K extends string>(key: K, value: string | undefined) => (value === undefined ? {} : { [key]: value }) as Partial<Record<K, string>>;
/** 生活线的全部依赖；除 ctx/config/store/host/notifier 外都可替换，便于测试。 */
export interface LifeDeps {
  ctx: Context; config: WorldConfig; options: LifeOptions; store: LifeStore; host: LifeHost; notifier: Notifier; clock?: () => Date; timers?: LifeTimers;
  /** CNY her home may spend a day; undefined or absent is no limit. */
  dailyBudget?: () => number | undefined;
  /** Called once each evening look back has been handed to her home (not for alarms or greetings, and not when delivery failed). */
  afterReview?: () => void;
  /** Read-only facts appended after the user's alarm template is rendered. */
  alarmContext?: (now: Date) => string | undefined;
  photos?: () => PhotoStore;
  /** Her room's workspace; the life line reaches only its sessions. Absent, every session of hers. */
  inWorkspace?: (sessionId: string) => boolean;
}

/**
 * Her life line: one pending alarm, kept in life.json and delivered into her home with `agent.steer`, the
 * tools she sets it with, the home itself, a new home's greeting and the evening look back. The parts live in
 * their own modules; this wires them.
 */
export function createLifeRuntime(deps: LifeDeps) {
  const { ctx, config, options, store, host } = deps;
  const { timeZone } = options;
  const names = worldNames(config);
  const clock = deps.clock ?? (() => new Date());
  const timers = deps.timers ?? realTimers;
  const faults = new Faults();
  const includes = (session: Agent['session']) => inWorld(session, config, deps.inWorkspace);
  const disposers: (() => void)[] = [];
  // 状态只在内存里改，再由 record() 统一落盘；life.json 坏了会在这里直接抛。
  const state = store.read();
  let stopped = false;
  let delivery: Promise<void> | undefined;
  /**
   * 【0.9.3】生活线"自己发起"的消息有两个开关，默认都关，装配层显式传 true 才发。
   *
   * 这两类消息都是 `say()` 用 `agent.steer()` 投进她会话的 user 消息：模型看见的是"有人说了一句话"，
   * 于是会回一句；可内容只是她自己的时间线（到点了、该写日记了），回出来就成了对着主人说的话，
   * 整轮转发还会把它推到主人手机上（转发那条已由 qq-native 的白名单挡住）。
   * 0.9.3 先停掉自查，回顾留着——她的日记和「我是谁」快照都靠 23:00 那一次；理由与副作用见
   * `LifeOptions.earlyStop` / `LifeOptions.dailyReview` 的注释。
   *
   * 三处闸门：`nextJob()` 不返回 review 任务、`askIfDoneEarly()` 第一行就返回、
   * `start()` 把 life.json 里已排的 review 清掉（免得以后打开开关时补跑一次旧的）。
   */
  const earlyStopEnabled = options.earlyStop === true;
  const dailyReviewEnabled = options.dailyReview === true;

  /** Bookkeeping after the fact: a failure is a fault, never a broken turn. */
  function record(work: () => void): void {
    try { work(); faults.clear('state'); }
    catch (error) { faults.set('state', `生活状态没能保存：${errorText(error)}`); ctx.logger.error(error); }
  }
  /** Her alarm wording, read when it is used; an unreadable template is a fault and the shipped one is used. */
  function alarmMessages() {
    const messages = readAlarmMessages(options.alarmFile);
    if (messages.error) faults.set('alarm-template', messages.error); else faults.clear('alarm-template');
    return messages;
  }
  const wake = () => options.schedule().wake;
  const templateValues = () => ({ name: names.companion, partner: names.partner, homeTitle: homeTitle(names), timeZone, fallbackWakeTime: wake(), example: exampleTime(timeZone) });
  /**
   * What she actually did between setting this alarm and hearing it, in one line.
   *
   * Read from the activity log rather than from her own account of the time, so the alarm can contradict
   * her note: "歇着" plus forty tool calls is a different sentence from "歇着" plus none. Both days the
   * alarm could straddle are read, because a plan set at 23:50 and heard at 00:30 has its work split.
   */
  const didSince = (alarm: Alarm, now: Date): string => {
    const dayOf = (at: string | Date) => formatLocalTime(new Date(at), timeZone).slice(0, 10);
    const days = [...new Set([dayOf(alarm.setAt), dayOf(now)])];
    const records = days.flatMap(each => store.activity(each)).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    return summarizeSince(records, alarm.setAt, now);
  };
  /**
   * 生活线消息的形状。`lifeKind` 只说明"这条是什么性质"：闹钟（缺省）、提前停下、B 站唤醒。
   *
   * 注意它**不是**转发开关：0.9.3 起整轮转发只认 `bili-wake`（见 qq-native 的 forwardOwnTurns），
   * 加新的 kind 不会自动开始转发。这里也决定了消息按 `role: user` 投进她会话——
   * 模型会把它当成"有人说话"，所以文案开头要写清"这是我自己的闹钟"（见 templates/alarm.md）。
   */
  const lifeMessage = (text: string, lifeKind?: 'alarm' | 'early-stop') => createUserMessage({ source: { kind: 'dsh-world-life', ...(lifeKind ? { lifeKind } : {}) }, content: [{ type: 'text', text }] });
  const say = (agent: Agent, message: string | UserMessage, lifeKind?: 'alarm' | 'early-stop') => {
    // 用 steer 放进她的收件箱，再由 flush 保证宿主已经落盘，重启后才找得到。
    admit(includes, agent).steer(typeof message === 'string' ? lifeMessage(message, lifeKind) : message);
    return ctx.sessions.flush(agent.session);
  };

  // Delivery is a step that starts with the word, not a steer that did not throw: a turn can take the word out
  // of the inbox and never reach its first step (the host still starting, the app closed), and the word is then
  // lost. The host logs the word as a `user/message` only after its step has started, so that event is the proof.
  /** Whether the word is still queued in her home, to be taken by a coming step. */
  const queued = (agent: Agent, id: string) => [...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(message => message.id === id);
  let stallTimer: unknown;
  function watchStall(pending: PendingWake): void {
    // 到点还停在 delivering 就报卡住；之后任何一次确认都会清掉这条故障。
    if (stallTimer !== undefined) timers.clear(stallTimer);
    stallTimer = timers.set(() => {
      stallTimer = undefined;
      if (stopped || state.delivering?.messageId !== pending.messageId) return;
      faults.set('stall', `${pending.what}在 ${formatLocalTime(new Date(pending.sentAt), timeZone).slice(11, 16)} 送进了家，${STALL_MINUTES} 分钟了这一轮还没开始`);
    }, Math.max(0, Date.parse(pending.sentAt) + STALL_MINUTES * 60_000 - clock().getTime()));
  }
  function settle(): PendingWake | undefined {
    const pending = state.delivering;
    delete state.delivering;
    if (stallTimer !== undefined) { timers.clear(stallTimer); stallTimer = undefined; }
    faults.clear('stall');
    return pending;
  }
  function confirmed(): void {
    const pending = settle();
    if (!pending) return;
    const now = clock();
    faults.clear('delivery');
    record(() => { store.write(state); store.appendWake({ scheduledAt: pending.scheduledAt, deliveredAt: now.toISOString(), source: pending.source, lateMs: Math.max(0, now.getTime() - Date.parse(pending.scheduledAt)) }); });
    timer.reset();
  }
  /** Back on the schedule: her own alarm unless a plan of hers replaced it meanwhile, otherwise as it was. */
  function neverRan(why: string): void {
    const pending = settle();
    if (!pending) return;
    const { job } = pending;
    if ('alarm' in job) { if (!state.alarm || state.alarm.source === 'fallback') state.alarm = job.alarm; }
    else if ('review' in job) state.review = job.review;
    else state.greeting ??= job.greeting;
    record(() => store.write(state));
    faults.set('delivery', `${pending.what}没开始，${timer.failed()} 分钟后重新送：${why}`);
  }
  /**
   * After a restart: the word sent last time is in the log (it ran; counted now), still queued or in a live turn
   * (watched as if just sent), or gone with the turn that took it (sent again).
   */
  function reconcile(agent: Agent): void {
    // 先看日志：有这条 user/message 就是跑过了；否则看在不在收件箱/正在跑；都没有就是丢了。
    const pending = state.delivering;
    if (!pending) return;
    if (pending.sessionId !== agent.id) return neverRan('家换过了');
    const { session } = agent;
    for (let seq = session.seq - 1; seq >= 0; seq--) {
      const event = session.eventAt(SessionSeq(seq));
      if (event?.type === 'user/message' && event.data.id === pending.messageId) return confirmed();
    }
    if (queued(agent, pending.messageId) || agent.status === 'running') return watchStall(pending);
    neverRan('上次那一轮没开始就中断了');
  }
  /** Written before the steer, so a crash right after it still finds the word; unsaved, it is still sent and watched. */
  function expect(agent: Agent, message: UserMessage, what: string, scheduledAt: string, source: PendingWake['source'], job: PendingWake['job'], now: Date): void {
    const pending: PendingWake = { messageId: message.id, sessionId: agent.id, sentAt: now.toISOString(), what, scheduledAt, source, job };
    state.delivering = pending;
    record(() => store.write(state));
    watchStall(pending);
  }

  // Her alarm.
  // What is delivered next: a new home's greeting first, then whichever of the look back and her alarm is due sooner.
  type Job = { kind: 'greeting'; at: string; greeting: Greeting } | { kind: 'review'; at: string; review: Review } | { kind: 'alarm'; at: string; alarm: Alarm };
  /**
   * 谁调用：createAlarmTimer 的 dueAlarm 与 deliver 的开头，每次只问「现在该做什么」。
   * 参数：无，读 state；返回问候/回顾/闹钟里最早的一个，都没有时 undefined。
   * 优先级：新家问候先于到点的回顾或闹钟；回顾与闹钟同时到点，回顾先走。
   */
  function nextJob(): Job | undefined {
    // 优先级：新家问候 > 到点更早的那个（回顾或闹钟）。
    const { greeting, review, alarm } = state;
    if (greeting) return { kind: 'greeting', at: greeting.at, greeting };
    // 回顾停用时连排期都不看：state.review 可能还在（旧文件），但这里直接跳过，闹钟照常。
    if (dailyReviewEnabled && review && (!alarm || Date.parse(review.at) <= Date.parse(alarm.at))) return { kind: 'review', at: review.at, review };
    return alarm && { kind: 'alarm', at: alarm.at, alarm };
  }
  const timer = createAlarmTimer({ clock, timers, dueAlarm: () => nextJob()?.at, fire: () => void deliver() });
  const morning = (now: Date): Alarm => ({ at: nextLocalTime(now, wake(), timeZone).toISOString(), note: '', setAt: now.toISOString(), source: 'fallback' });
  /** A new alarm replaces a failing one, so its backoff and fault go with it. Saved or not, it is armed. */
  function setAlarm(alarm: Alarm): void {
    if (stopped) return;
    state.alarm = alarm; faults.clear('delivery', 'alarm');
    try { store.write(state); }
    catch (error) { faults.set('alarm', `闹钟没能保存：${errorText(error)}`); throw error; }
    finally { timer.reset(); }
  }
  /** Nothing pending means resting until the next morning. Unsaved, it still rings while the app keeps running. */
  function fallbackAlarm(): void {
    if (state.alarm || state.greeting || stopped) return;
    try { setAlarm(morning(clock())); }
    catch (error) { faults.set('alarm', `断线保护闹钟没能保存：${errorText(error)}`); ctx.logger.error(error); }
  }
  function planNext(input: { at?: string; after_minutes?: number }, note: string): string {
    if (stopped) throw new Error('生活线已停止');
    const now = clock();
    const at = resolveAlarmTime(input, now, timeZone);
    const replaced = state.alarm;
    setAlarm({ at: at.toISOString(), note: note.trim(), setAt: now.toISOString(), source: 'plan' });
    return planReply(at, replaced, timeZone);
  }
  const checkAlarm = () => checkReply(state.alarm, clock(), timeZone);
  /** Back to the morning fallback, exactly as if she had set nothing. */
  function cancelAlarm(): string {
    if (stopped) throw new Error('生活线已停止');
    const cancelled = state.alarm;
    if (cancelled?.source === 'plan') setAlarm(morning(clock())); else fallbackAlarm();
    return cancelReply(cancelled, state.alarm, timeZone);
  }
  /**
   * Moves what is pending to the console's review and morning times when they differ (changed now, or while her
   * world was stopped). The pending look back keeps its day; the plugin's morning alarm moves to the new time after
   * it was set, at once if that has passed. An alarm of hers is left alone. True when anything moved.
   */
  /**
   * 谁调用：插件入口的 setSchedule（控制台保存作息后）调 reschedule；start() 里直接跑一次 followSchedule。
   * 语义：待办的回顾保留原来的回看日、只改时刻；插件自己的兜底闹钟跟着新时间，她定的闹钟不动。
   * 返回：有东西移动过就 true，调用方据此决定要不要落盘并重排。
   */
  function followSchedule(): boolean {
    const now = clock(), { review, wake: morningTime } = options.schedule();
    const timeOf = (at: string) => formatLocalTime(new Date(at), timeZone).slice(11, 16);
    let moved = false;
    if (state.review && timeOf(state.review.at) !== review) { state.review = reviewOf(state.review.day, now, timeZone, review); moved = true; }
    if (state.alarm?.source === 'fallback' && timeOf(state.alarm.at) !== morningTime) {
      const at = nextLocalTime(new Date(state.alarm.setAt), morningTime, timeZone);
      state.alarm = { ...state.alarm, at: (at > now ? at : now).toISOString() }; moved = true;
    }
    return moved;
  }
  function reschedule(): void {
    if (stopped || !followSchedule()) return;
    record(() => store.write(state));
    timer.reset();
  }

  // Delivery: one at a time, the next only once the last started a step; a failure backs off, and a newer alarm keeps its own time.
  /**
   * 谁调用：alarmTimer 到点 fire，控制台手动触发时也会调。
   * 保证：一次只送一个；上一个还没开始下一步就不送下一个；没有待办时返回已有的 promise。
   * 失败：各 job 自己登记故障并退避，这里只负责不并发。
   */
  function deliver(): Promise<void> {
    const job = nextJob();
    if (stopped || !job || state.delivering) return delivery ?? Promise.resolve();
    return delivery ??= (job.kind === 'alarm' ? send(job.alarm) : job.kind === 'review' ? lookBack(job.review) : greet(job.greeting)).finally(() => { delivery = undefined; });
  }
  /**
   * A message of the plugin's own, taken off the schedule while it is sent and put back if it fails: it backs
   * off like an alarm, and its turn is never asked about as an early stop. It counts once its turn starts a step.
   */
  async function sayOwn(what: string, source: WakeRecord['source'], scheduledAt: string, job: PendingWake['job'], take: () => void, putBack: () => void, text: (now: Date) => string, delivered?: () => void): Promise<void> {
    try {
      const agent = await home.open();
      if (stopped) return;
      take();
      const now = clock();
      const message = lifeMessage(text(now));
      expect(agent, message, what, scheduledAt, source, job, now);
      earlyStop.startsOwnTurn();
      await say(agent, message);
      if (!stopped) delivered?.();
    } catch (error) {
      ctx.logger.error(error);
      if (stopped) return;
      earlyStop.ownTurnFailed();
      settle(); putBack();
      record(() => store.write(state));
      faults.set('delivery', `${what}没送到，${timer.failed()} 分钟后重试：${errorText(error)}`);
      return;
    }
    if (stopped) return;
    faults.clear('home');
    timer.arm();
  }
  /**
   * A new home's first words, so it has a turn (the host lists no session without one) and she knows she moved;
   * or the word that her world has started again.
   */
  const greet = (greeting: Greeting) => sayOwn(greeting.kind === 'arrival' ? '新家的第一句话' : '重新开始的那句话', greeting.kind === 'arrival' ? 'first' : 'return', greeting.at, { greeting },
    () => { delete state.greeting; }, () => { state.greeting ??= greeting; },
    () => greetingText(greeting.kind, timeZone, wake(), alarmMessages(), templateValues()));
  /**
   * 【上游参考】
   * 生活线骨架（alarm/journal/runtime 的闹钟+回顾模型）来自 dsh-dafeiyu-life；
   * 这里保留「一个待响的闹钟 + 一次每日回顾」，把投递、日记守卫与故障登记接到 DSH 宿主上。
   */
  // 回顾正在进行的那一天：它的日记在那一轮结束前都算开着，跨过午夜也一样。
  /** The day whose look back her home is in now: its diary stays open until that turn ends, even past midnight. */
  let reviewing: string | undefined;
  /** A day's diary is open until its look back has ended: today, and a day whose look back is still to come or under way. */
  /**
   * 谁调用：runtime 的 tools guard，每次宿主工具调用前算一次。
   * 参数：today 是配置时区里的今天。
   * 返回：今天 + 回顾还没结束的那一天 + 正在回顾的那一天；跨过午夜也仍然算开着。
   * 用途：这份集合交给 closedDiaryRefusal，只有不在集合里的日记才拦。
   */
  function openDiaryDays(today: string): Set<string> {
    const days = new Set([today]);
    if (state.review && state.review.day < today) days.add(state.review.day);
    if (reviewing) days.add(reviewing);
    return days;
  }
  /** The evening look back on her day; her 我是谁 is kept as it was, so she can rewrite it freely. */
  /**
   * 谁调用：deliver 在 job.kind === 'review' 时。
   * 时机：回顾到点、家已打开；take 里把 reviewing 置为回看日，并把它滚到下一天。
   * 写：回顾前用 keepSelfCopy 给我是谁留底，留底失败只登记 snapshot 故障，不挡回顾。
   * 失败：投递失败时 sayOwn 会把 state.review 放回去，并按闹钟的退避重试。
   */
  function lookBack(review: Review): Promise<void> {
    let snapshot: string | undefined;
    const take = () => {
      reviewing = review.day;
      try { snapshot = keepSelfCopy(options.selfFile, review.day); faults.clear('snapshot'); }
      catch (error) { faults.set('snapshot', `我是谁没能留底：${errorText(error)}`); ctx.logger.error(error); }
      state.review = nextReview(clock(), timeZone, options.schedule().review);
    };
    const existing = (dir: string) => { const file = join(options.worldDir, dir, `${review.day}.jsonl`); return existsSync(file) ? file : undefined; };
    return sayOwn('每日回顾', 'review', review.at, { review }, take, () => { state.review = review; }, now => reviewText(review, now, {
      ...withValue('conversations', existing('conversations')), ...withValue('activity', existing('activity')), ...withValue('snapshot', snapshot),
      diaryDir: options.diaryDir, selfFile: options.selfFile,
    }, timeZone, wake(), alarmMessages(), templateValues()), () => deps.afterReview?.());
  }
  async function send(alarm: Alarm): Promise<void> {
    try {
      // Resolve (or rebuild) the home first: a rebuilt home must still see this alarm as pending.
      const agent = await home.open();
      if (stopped) return;
      if (state.alarm !== alarm) { timer.arm(); return; }
      // Cleared before steering, so a turn that ends quickly already sees "no alarm" and gets the fallback.
      delete state.alarm;
      const now = clock();
      const text = wakeText(alarm, now, timeZone, wake(), alarmMessages(), { ...templateValues(), did: alarm.source === 'fallback' ? '' : didSince(alarm, now) });
      const context = deps.alarmContext?.(now);
      const message = lifeMessage(context ? `${text}\n\n${context}` : text);
      expect(agent, message, '闹钟', alarm.at, alarm.source, { alarm }, now);
      await say(agent, message);
    } catch (error) {
      ctx.logger.error(error);
      if (stopped) return;
      settle();
      if (state.alarm && state.alarm !== alarm) { record(() => store.write(state)); faults.set('delivery', `闹钟送达失败：${errorText(error)}`); timer.arm(); return; }
      state.alarm = alarm;
      record(() => store.write(state));
      faults.set('delivery', `闹钟送达失败，${timer.failed()} 分钟后重试：${errorText(error)}`);
      return;
    }
    if (stopped) return;
    // Steered and durable; it counts as delivered once her home starts a step with it (see `confirmed`).
    faults.clear('home');
    timer.arm();
  }

  // Stopping early: asked once per alarm whether she is done.
  const earlyStop = createEarlyStopWatch();
  function askIfDoneEarly(completed: boolean): void {
    // 0.9.3：自查停用（LifeOptions.earlyStop）。返回得早——不读 state.alarm、不落 nudged，
    // 所以以后把开关打开时，这一次没被问过的收工仍然会被问。
    if (!earlyStopEnabled) return;
    const now = clock(); const alarm = state.alarm;
    if (!earlyStop.turnEnded(completed, alarm, now) || stopped) return;
    alarm.nudged = true;
    // 先把「问过了」落盘再发，崩溃重载后不会对同一个闹钟再问一遍。
    record(() => store.write(state));
    earlyStop.startsOwnTurn();
    const text = earlyStopText(alarm, now, timeZone, alarmMessages(), templateValues());
    void home.open().then(agent => stopped ? undefined : say(agent, text, 'early-stop')).catch(error => { earlyStop.ownTurnFailed(); ctx.logger.error(error); });
  }

  // What her home spends: each model step priced as it lands; past the daily budget she is told once that day.
  function spent(usage: Parameters<typeof stepCost>[0], model: string): void {
    const now = clock(); const day = formatLocalTime(now, timeZone).slice(0, 10);
    // 跨天先换账本：午夜后的调用算新的一天，额度也跟着重算。
    const spend = state.spend?.day === day ? state.spend : (state.spend = { day, yuan: 0 });
    spend.yuan += stepCost(usage, model, now);
    const budget = deps.dailyBudget?.();
    const remind = budget !== undefined && spend.yuan >= budget && !spend.reminded;
    if (remind) spend.reminded = true;
    record(() => store.write(state));
    if (!remind) return;
    const text = budgetText(spend.yuan, budget, alarmMessages(), templateValues());
    void home.open().then(agent => {
      if (stopped) return;
      // Into the running turn at its next step, or a turn of its own that is not asked about.
      if (agent.status !== 'running') earlyStop.startsOwnTurn();
      return say(agent, text);
    }).catch(error => { earlyStop.ownTurnFailed(); ctx.logger.error(error); });
  }

  // Her tools and her home.
  const notifier: Notifier = {
    // 通知和出口都包一层故障登记：送不到要在控制台看得见，但不影响 reach_out 已经送到的部分。
    ...(deps.notifier.toast ? { toast: (title: string, body: string) => faults.track('toast', '系统通知没送到', () => deps.notifier.toast!(title, body)) } : {}),
    outlets: deps.notifier.outlets.map(outlet => ({ ...outlet, send: push => faults.track(`outlet:${outlet.name}`, `${outlet.name}没送到`, () => outlet.send(push)) })),
  };
  const tools = createToolRegistry({
    faults, logger: ctx.logger,
    inWorld: agent => !stopped && includes(agent.session),
    isHome: agent => agent.id === state.homeSessionId,
    guard: ({ name, arguments: args, agent }) => {
      // 已经合上的那天的日记不能再改：写错了就写进今天，原来的记忆保持原样。
      const today = formatLocalTime(clock(), timeZone).slice(0, 10);
      return closedDiaryRefusal(name, args, options.diaryDir, agent?.session.header.cwd ?? options.roomDir, openDiaryDays(today), today);
    },
    tools: agent => [
      ...lifeTools({ planNext, checkAlarm, cancelAlarm, notifier, names, origin: () => { try { return host.origin(); } catch { return undefined; } }, descriptions: alarmDescriptions(alarmMessages(), templateValues()) }),
      ...deps.photos ? photoTools({ agent, store: deps.photos, attachments: () => ctx.get('attachments') as AttachmentStore | undefined, inside: () => !stopped && agent.id === state.homeSessionId && includes(agent.session) }) : [],
    ],
  });
  // 在家且在世界上才挂工具，否则摘掉；pre-step 每次都会重算。
  const attach = (agent: Agent) => !stopped && includes(agent.session) ? tools.attach(agent) : tools.detach(agent);
  const home = createHome({
    host, roomDir: options.roomDir, agentPreset: config.agentPreset, title: homeTitle(names), roomTitle: roomTitle(names), faults, logger: ctx.logger,
    current: () => state.homeSessionId,
    // A new home greets her at once (the pending alarm moves in too and rings at its own time).
    moveIn(sessionId) {
      state.homeSessionId = sessionId;
      state.greeting = { at: clock().toISOString(), kind: 'arrival' };
      tools.releaseOldHomes();
      store.write(state);
    },
    opened: attach,
    inWorld: includes,
    stopped: () => stopped,
  });
  const journal = createJournal({ store, faults, roomDir: options.roomDir, logger: ctx.logger });

  /** `resumed`: started again from the console; unless an alarm of her own is pending, she is told she is back. */
  /**
   * 谁调用：插件入口启动生活线时；resumed 表示从控制台重新启动。
   * 做的事：注册监听、补排今晚的回顾、跟随控制台作息、打开家、reconcile 上次没开始的投递、
   *   按需排兜底闹钟，最后 arm 定时器。
   * 失败：家打不开只登记 home 故障，不让整个启动崩掉。
   */
  async function start(options: { resumed?: boolean } = {}): Promise<void> {
    // 监听只注册一次；stop 时按相反顺序拆掉。
    disposers.push(
      ctx.on('agent/created', ({ agent }) => { attach(agent); return undefined; }),
      reassembleOnChange(ctx, attach),
      ctx.on('agent/pre-step', ({ agent }, next) => { attach(agent); return next(); }, { prepend: true }),
      ctx.on('agent/disposed', ({ agent }) => tools.forget(agent)),
      ctx.on('agent/inbox/inserted', ({ agent, message: inserted }) => {
        attach(agent);
        // Her partner's words reach her at the next step, like being called while busy.
        if (!includes(agent.session) || agent.id !== state.homeSessionId || inserted.source.kind !== 'user' || agent.status !== 'running') return;
        if (!agent.inbox.nextTurn.some(queued => queued.id === inserted.id)) return;
        agent.inbox.remove(inserted.id); agent.steer(inserted);
      }),
      ctx.on('session/event', (session, event) => {
        if (!includes(session)) return;
        journal.world(session, event);
        if (session.id !== state.homeSessionId) return;
        journal.home(session, event);
        if (event.type === 'assistant/message' && event.data.usage) spent(event.data.usage, event.data.message.source.model);
        if (event.type === 'user/message') {
          if (event.data.source.kind === 'user') earlyStop.partnerSpoke();
          // 只认 B 站唤醒这一种：它是插件直接 steer 进来的，不走 sayOwn，所以逐轮标记的 ownTurn 收不到它。
          // 0.8.21 实测：手动「立即触发一次」后这一轮结束被当成提前收工，问了一句「现在才 16:30，这一轮就停了」——
          // 她其实就在做饭。闹钟/问候/回顾走 sayOwn，本来就标了 ownTurn，不要在这里重复放行别的来源。
          else if (event.data.source.kind === 'dsh-world-life' && (event.data.source as { lifeKind?: string }).lifeKind === 'bili-wake') earlyStop.startsOwnTurn();
        }
        // Before the fallback below, so a word whose turn never ran goes back first.
        const pending = state.delivering;
        if (pending && pending.sessionId === session.id) {
          if (event.type === 'user/message' && event.data.id === pending.messageId) confirmed();
          else if (event.type === 'turn/end') {
            const agent = ctx.agents.get(session.id);
            if (!agent || !queued(agent, pending.messageId)) neverRan(`那一轮没开始就结束了（${event.data.reason.kind}）`);
          }
        }
        if (event.type !== 'turn/end') return;
        if (state.delivering?.source !== 'review') reviewing = undefined;
        home.turnEnded(session.id);
        fallbackAlarm();
        // A stopped or failed turn is not her deciding she is done.
        askIfDoneEarly(event.data.reason.kind === 'completed');
      }),
    );
    for (const agent of ctx.agents.list()) attach(agent);
    // 0.9.3：每日回顾停用时就不排；以前排下的也清掉，免得以后打开开关时补跑一次旧的。
    if (!dailyReviewEnabled) { if (state.review) { delete state.review; record(() => store.write(state)); } }
    // 第一次启动时排上今晚的回顾；之后按日期滚动，不重复排。
    else if (!state.review) { state.review = nextReview(clock(), timeZone, deps.options.schedule().review); record(() => store.write(state)); }
    if (followSchedule()) record(() => store.write(state));
    try {
      const agent = await home.open(); faults.clear('home');
      reconcile(agent);
      // The morning fallback is the plugin's, not a plan of hers: starting again wakes her rather than leaving her asleep till then.
      if (options.resumed && !state.greeting && state.alarm?.source !== 'plan') { state.greeting = { at: clock().toISOString(), kind: 'return' }; record(() => store.write(state)); }
      // A restart with nothing scheduled and no turn to end would otherwise never wake her again.
      if (agent.status !== 'running') fallbackAlarm();
    } catch (error) { if (!stopped) { faults.set('home', `家打不开：${errorText(error)}`); ctx.logger.error(error); } }
    timer.arm();
  }
  function stop(): void {
    // 先置 stopped 再拆监听：回调里看到 stopped 就不会再排新的活。
    if (stopped) return;
    stopped = true;
    timer.stop();
    if (stallTimer !== undefined) { timers.clear(stallTimer); stallTimer = undefined; }
    for (const dispose of disposers.splice(0).reverse()) dispose();
    tools.clear();
  }
  return {
    start, stop, planNext, checkAlarm, cancelAlarm, deliver, reschedule,
    snapshot: () => ({ homeSessionId: state.homeSessionId, alarm: state.alarm, review: state.review, spend: state.spend, faults: faults.list() }),
    /** Resolves once no alarm delivery is in flight (its durability flush can outlast the turn it starts). */
    settled: async () => { while (delivery) await delivery; },
    home: () => home.open(),
    /** Whether this session is her home now; the world prompt gives the home its world line. */
    isHome: (sessionId: string) => !stopped && sessionId === state.homeSessionId,
  };
}
/** createLifeRuntime 的返回类型。 */
export type LifeRuntime = ReturnType<typeof createLifeRuntime>;
