/**
 * 世界提示与她的人格在系统提示里的位置：一段提示 + 一段人格，跟着「会话是否在她的世界里」进出。
 *
 * 导出：WorldPromptSource（提示源）、createPromptSections（按 agent 放置、刷新与摘除）。
 * 调用方：runtime.ts 在 agent/created、压缩结束、冷会话醒来与手动应用时调用。
 * 依赖：persona.ts（读写人格）、self.ts（我是谁）、worldPrompt.ts（渲染）、sourceArchive.ts（世界成员判断）、
 * worldScope.ts（提示变了之后重新装配）。
 *
 * 坑：位置一旦变化就要重新装配系统提示，provider 的前缀缓存随之失效，所以只在会话进出工作区、压缩之后、
 * 冷会话醒来时刷新，绝不每一步都改。预设名单独不足以判定（多数部署就是 standard），必须再确认工作区。
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { readPersona, renderPersona } from './persona.ts';
import { renderSelf } from './self.ts';
import { belongsToWorld, inWorld } from './sourceArchive.ts';
import type { WorldConfig } from './types.ts';
import { readTemplate, renderWorldPrompt, type WorldNames, type WorldPrompt } from './worldPrompt.ts';
import { reassembleOnChange } from './worldScope.ts';

/** 提示源：模板、人格、名字、世界成员判定与记忆服务，运行时按需读取，自己不做缓存。 */
export interface WorldPromptSource {
  prompt: WorldPrompt; isHome(sessionId: string): boolean; archiveSession?(sessionId: string): boolean;
  /** Resolved with the saved prompt text, so renaming does not change an existing cached prefix. */
  names?(): WorldNames;
  /** Her room's workspace; her world (all but the persona) reaches only its sessions. Absent, every session of hers. */
  inWorkspace?(sessionId: string): boolean;
  /** Long-term memory; its two tools are registered on world sessions. */
  memory?: import('./memory.ts').MemoryService;
}
/** 一次读盘的结果：模板、我是谁、人格与名字；缓存下来，免得每一步都重读磁盘。 */
interface PromptText { template: string; self?: { file: string; text: string }; persona: string; names: WorldNames }
/** `active`: the world prompt is placed (the session is in her workspace); the persona is placed either way. */
// 一个 agent 的登记项：当前读到的文本、是否生效，以及世界提示段与人格段的摘除函数。
interface Entry { text: PromptText; active: boolean; dispose: () => void; persona?: () => void }
/** The stock "You are an AI agent powered by DeepSeek Harness." line; a section of the same name on her agent shadows it. */
const HARNESS_IDENTITY = 'harness:identity';

/**
 * Her persona and the world prompt both reach only sessions of her preset inside the world's workspace, and come and
 * go together as a session enters or leaves it: the preset alone is DSH's default `standard` for most setups, so it
 * would turn every unrelated session into her (#37). Both are sections of the session's system prompt so she sees them on every
 * request. They are read when the session opens and again after each successful compaction (the host assembles
 * the system prompt before pre-step, so the refresh happens on compaction/end), when a cold session speaks again
 * (`coldHours` in `runtime.ts`, on turn/start) or on explicit console application, so the prompt stays in the provider-cached prefix. Whether the session is her home is asked per request.
 *
 * Her persona takes the place of DeepSeek Harness's stock identity line, but never of a persona someone has set: it is its own
 * section placed right after the host's persona slot, so a system persona the deployment or her preset already has stays
 * where it is and hers follows it.
 */
export function createPromptSections(config: WorldConfig, world: WorldPromptSource, deps: { logger: { warn(...args: unknown[]): void } }) {
  // 强引用 agent：生命周期跟着 add / clear 走，清理时机看得见，不交给弱引用。
  const entries = new Map<Agent, Entry>();
  // 会话到 agent 的弱引用：refresh 只拿得到 Session，靠它反查是哪个 agent。
  const agents = new WeakMap<Session, Agent>();
  function read(includeWorld: boolean): PromptText {
    const persona = world.prompt.persona ? renderPersona(readPersona(world.prompt.persona)) : '';
    const names = world.names?.() ?? world.prompt.names;
    if (!includeWorld) return { template: '', persona, names };
    const template = readTemplate(world.prompt.file);
    if (template.error) deps.logger.warn(`dsh-world-bili: ${template.error}`);
    return {
      template: template.text,
      ...(config.selfFile ? { self: { file: config.selfFile, text: renderSelf(config.selfFile) } } : {}),
      persona, names,
    };
  }
  /** Registers her persona while the session is in her workspace and she has one; drops it otherwise. */
  function placePersona(agent: Agent, entry: Entry): void {
    if (!entry.active || !entry.text.persona) { entry.persona?.(); delete entry.persona; return; }
    if (entry.persona) return;
    const prompt = agent.ctx.systemPrompt;
    // 紧跟宿主的人格位：部署或预设已经有的系统人格排在前面，她的人格排在它后面。
    const order = prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') ?? 0;
    const text = () => entry.text.persona;
    const persona = prompt.section({ name: 'dsh-world-bili-persona', order: order + 1, interpolate: false, text });
    // DeepSeek Harness's own identity line gives way to hers; a persona someone set in DSH sits in its own slot and is left alone.
    // If a preset already put its own words on that identity slot for this agent, they stay exactly as written.
    let identity: (() => void) | undefined;
    // 那个身份位被预设占了就让它留着：不抢别人写好的话，最多是这次不替换默认身份行。
    try { identity = prompt.section({ name: HARNESS_IDENTITY, order: prompt.getSectionOrder('HARNESS_IDENTITY'), interpolate: false, text: () => '' }); }
    catch { /* the slot is already taken for this agent */ }
    entry.persona = () => { persona(); identity?.(); };
  }
  return {
    add(agent: Agent): void {
      if (entries.has(agent) || !belongsToWorld(agent.session, config)) return;
      let disposeWorld: (() => void) | undefined;
      /** Places or removes the world prompt and her persona as the session enters or leaves her workspace; true when it did. */
      const sync = (): boolean => {
        if (inWorld(agent.session, config, world.inWorkspace) === entry.active) return false;
        entry.active = !entry.active;
        if (!entry.active) { disposeWorld?.(); disposeWorld = undefined; placePersona(agent, entry); return true; }
        entry.text = read(true);
        disposeWorld = agent.ctx.systemPrompt.section({ name: 'dsh-world-bili', order: 50, interpolate: false, text: () => renderWorldPrompt({ ...world.prompt, names: entry.text.names }, entry.text.template, entry.text.self, world.isHome(agent.id)) });
        placePersona(agent, entry);
        return true;
      };
      const disposeSync = reassembleOnChange(agent.ctx, sync);
      const entry: Entry = { text: read(false), active: false, dispose: () => { disposeSync(); disposeWorld?.(); } };
      entries.set(agent, entry); agents.set(agent.session, agent);
      sync();
    },
    active(session: Session): boolean {
      const agent = agents.get(session);
      return !!(agent && entries.get(agent)?.active);
    },
    refresh(session: Session): void {
      const agent = agents.get(session); const entry = agent && entries.get(agent);
      if (!agent || !entry) return;
      entry.text = read(entry.active);
      placePersona(agent, entry);
    },
    clear(): void {
      // 逐个吞异常：卸载时 agent 作用域可能已经没了，清理不能因为一个摘不掉就中断后面的。
      for (const entry of entries.values()) for (const dispose of [entry.dispose, entry.persona]) { try { dispose?.(); } catch { /* agent scope already gone */ } }
      entries.clear();
    },
  };
}
