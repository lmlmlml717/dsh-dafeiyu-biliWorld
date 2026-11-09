/**
 * 插件的数据形状：配置（WorldConfig）与归档记录（ConversationRecord 及其分页、轮次视图）。
 *
 * 导出：WorldConfig、DeliveryState、ConversationRecord、ArchiveScope、ArchiveCursor、PageQuery、RecordPage、
 * ConversationTurn、ArchiveReader。
 * 调用方：几乎所有模块都只 import 这里的类型；值从哪里来由 store.ts 与 archive.ts 决定。
 * 依赖：宿主的会话头、微信/QQ 的身份与出口配置，以及归档范围的取值类型。
 *
 * 坑：WorldConfig 的字段全是可选的覆盖项，真正生效的默认值在 index.ts 的 schemastery 与 worldSwitch.ts；
 * ConversationRecord 一旦写进 archive.sqlite 就是原件，只能往后加字段，不能改已有字段的含义。
 */
// 【链路位置】B 站相关只有 WorldConfig 里的 dailyBili 与 comment 两段：index.ts 的 Config（schemastery）
// 给出默认值与校验，apply 读出来后分别交给 createDailyBili（dailyBili 段，见 src/bili/dailyBili.ts）与
// mirrorCommentConfig（comment 段，镜像进 bili.config.json 供工具链读）。
// 写在这里的理由：主配置是事实来源，bili.config.json 只是镜像与面板的落点，类型跟着主配置走。
// 本文件只声明形状，不读盘、不解析、没有运行时副作用。
import type { OutletConfig } from './ecosystem/shared/outlets.ts';
import type { SessionHeader } from '@deepseek-ai/dsh-session';
import type { SpeakerIdentity } from './ecosystem/shared/identity.ts';
import type { MemoryArchiveScope } from './archiveSelection.ts';

/** 插件配置：世界标识、预设、时区，以及各条线（记忆、生活、渠道、B 站）自己的开关与路径。 */
export interface WorldConfig {
  worldId: string;
  agentPreset: string;
  timeZone: string;
  /** Archive her current home alone, or ordinary sessions in its workspace (default). */
  archiveScope?: MemoryArchiveScope;
  /** The life line (home session, alarm, tools, console); on by default. */
  life?: boolean;
  /** On the first start in a profile, switch its stock compaction row to the tool-free one (restart to load it); on by default. */
  replaceCompaction?: boolean;
  /** Her diary directory; defaults to `<world>/diary`. */
  diaryDir?: string;
  /** Local HH:MM of the morning wake when no alarm is pending (she set none, or cancelled hers); 09:00 by default. */
  fallbackWakeTime?: string;
  /** Her own "who I am" file, part of the world prompt; defaults to `<world>/room/我是谁.md` in the plugin. */
  selfFile?: string;
  /** Her name (home title, notifications, memory labels); TA when unset. */
  companionName?: string;
  /** What she calls her partner in the plugin's own words; 伙伴 when unset. */
  partnerName?: string;
  /** Her layered persona, edited in the world console; defaults to `<world>/persona.md`. */
  personaFile?: string;
  /** The world prompt template; defaults to `<world>/world-prompt.md` when it exists, else the shipped one. */
  worldPromptFile?: string;
  /** The alarm wording template; defaults to `<world>/alarm.md` when it exists, else the shipped one. */
  alarmTemplateFile?: string;
  /** Where her words go outside DSH: replies to bridged words, the busy notice, reach_out. */
  outlets?: OutletConfig[];
  /** Runs the bridge: a local app may hand her partner's words to her home. */
  bridge?: boolean;
  /** The independent local WeChat module; the Windows adapter uses `<world>/wechat.json`. */
  wechat?: boolean;
  /** QQ straight to OneBot: no qq-bridge process, the plugin owns the sockets, the sessions and the state. */
  qqNative?: { enabled?: boolean; wsUrl?: string; accessToken?: string; allowPrivate?: string[]; ownerQQ?: string; allowGroups?: string[]; autoReply?: boolean; batchQuietMs?: number; contextMessages?: number; bindHomeSession?: 'owner' | 'all' | 'none' | '';
    /** 群里什么时候接话：mention 只接被叫到的（被 @ / 被引用她的话 / 命中关键词），all 每句都接。 */
    groupTrigger?: 'mention' | 'all';
    /** 群里命中这些词也算在叫她。 */
    groupKeywords?: string[];
    /** 只停嘴不停耳：这个时间（ISO）之前照收、照记上下文，但一句都不回；到点自己醒。空着就是没静默。 */
    mutedUntil?: string;
    /** SnowLuma 装在哪；空着就靠猜（D:\SnowLuma、C:\SnowLuma、~/SnowLuma）。 */
    snowlumaHome?: string;
    /** 看门狗：通道开着时盯住 wsUrl 的端口，不通就按 snowlumaHome 把 SnowLuma 拉起来。默认开。 */
    supervise?: boolean;
    /** 阳台：让这台机器上别的程序能跟家里说话（一行一条 JSON 的 WebSocket）。port 为 0 就不开。 */
    bridge?: { port?: number; token?: string; title?: string; contextMessages?: number };
  };
  /** With `wechat`, run the Windows adapter for as long as the module runs; naming both here is the standing permission for it to send (`--allow-send`). */
  wechatAdapter?: { python?: string; config?: string };
  /** reach_out also shows a system notification (Windows only); on by default. */
  toast?: boolean;
  /** The desktop's notification identity (AppUserModelID); found in the Start menu when absent. */
  toastAppId?: string;
  /** Names besides this machine the console and the bridge answer to (a LAN address or domain behind a reverse proxy). */
  allowedHosts?: string[];
  // dailyBili 段的字段各有去处：enabled 决定 startLife 里建不建定时器；dailyTime 只在工具链
  // 模块缺失时兜底；dailyMaxVideos 进 DailyBiliOptions 与 prompt 的条数上限；allowWrite 既是 prompt 里的
  // 干跑提示，也镜像成 bili.config.json 的 comment.allowWrite（真发总开关）；napcatHttp / ownerQQ 只用于
  // prompt 末尾「把动态摘要发 QQ」那一段。作息窗口不在这里：wakeTime / reviewTime 由 world.json 决定，
  // B 站只读不改。
  /** 每日 B 站打卡：定时唤醒 home session，让 agent 刷视频→深读→写动态→发 QQ 通知主人。 */
  dailyBili?: {
    /** 开/关；显式写出来才开（防不小心误启动）。 */
    enabled?: boolean;
    /** 本地 HH:MM，默认 20:00。 */
    dailyTime?: string;
    /** 每日转发视频硬上限（跨 fire 累加；0=不限），默认 10。 */
    dailyMaxVideos?: number;
    /** 通知主人 QQ 的 OneBot HTTP 地址，默认 http://127.0.0.1:3000。 */
    napcatHttp?: string;
    /** 主人 QQ（显式写在这，或从 qqNative.allowPrivate[0] 拿）。 */
    ownerQQ?: string;
    /** 真发开关（对应工具链 guard.dryRun=false 才生效；dailyBili 这里再兜一层）。 */
    allowWrite?: boolean;
  };
  // comment 段由 mirrorCommentConfig 镜像成 bili.config.json 的 comment 段，工具链的 comment 命令
  // 读那份文件（config() 不缓存，改完下一次读就生效）；真发还要求同文件的 allowWrite，而它来自 dailyBili。
  // enabled 改完要重启才装上新路由；hardDailyMax 是面板 dailyMax 的上限；minIntervalSec 是两条评论的最小间隔。
  /** 给视频发顶层评论（不回复任何人）；真发还要求 `dailyBili.allowWrite`。 */
  comment?: {
    /** 功能开关，默认关。 */
    enabled?: boolean;
    /** 每日硬上限：面板里可改的条数不能超过它（0 = 不限），默认 5。 */
    hardDailyMax?: number;
    /** 两条评论之间最小间隔（秒），默认 3600。 */
    minIntervalSec?: number;
  };
  // 外面那个 qq-bridge 进程在 2026-10-27 拆掉了，它的五个配置键（qqBridgeDir/Port/Node/AutoStart/
  // BindHomeSession）一起没了：QQ 现在由 qqNative 自己直连 OneBot。
}
/** 一条待发消息的投递状态：pending 未确认、sent 全部发出、uncertain 中间某条不明、failed 明确失败。 */
export interface DeliveryState { status: 'pending' | 'sent' | 'uncertain' | 'failed'; confirmed: number; total: number }
/** 归档里的一行：谁在什么时候说了什么，带来源会话、消息与轮次，用来去重和排轮次。 */
export interface ConversationRecord extends Partial<SpeakerIdentity> {
  schemaVersion: 1;
  worldId: string;
  recordId: string;
  sourceSessionId: string;
  sourceMessageId: string;
  sourceSeq: number;
  turnId: string;
  role: 'user' | 'assistant';
  occurredAt: string;
  content: string;
  // interrupted 表示那条回复没说完（被打断或撞上输出上限）；记忆仍照收，只是标出来。
  status: 'complete' | 'interrupted';
  wechatDelivery?: DeliveryState;
}
/** 归档一条事件时需要知道的上下文：世界、会话头、继承来但不算她的话的事件数，以及当前轮次。 */
export interface ArchiveScope {
  worldId: string;
  header: SessionHeader;
  // 这个会话从父会话抄来的前缀长度：它之前的事件已经记在父会话名下。
  inheritedEventCount: number;
  turn: number;
}
/**
 * 分页游标：上一页最后一行的排序键，外加取游标时的最大 sequence。
 * 带上 maxSequence 是为了让翻页期间新写入的行不会挤进后面的页，造成重复或漏读。
 */
export interface ArchiveCursor {
  date: string;
  occurredAt: string;
  recordId: string;
  maxSequence: number;
}
/** 读一页的请求：可选游标与条数上限。 */
export interface PageQuery {
  before?: ArchiveCursor;
  limit: number;
}
/** 读一页的结果：记录与下一页游标；没有下一页时不带 nextCursor。 */
export interface RecordPage {
  records: ConversationRecord[];
  nextCursor?: ArchiveCursor;
}
/** 一轮：同一 turnId 下按发言顺序排列的记录，轮到记忆里的一行 JSON。 */
export interface ConversationTurn {
  turnId: string;
  occurredAt: string;
  messages: ConversationRecord[];
}
/** 记忆层需要的只读归档接口：按页读与按轮读；写入不经过这里。 */
export interface ArchiveReader {
  readPage(query: PageQuery): Promise<RecordPage>;
  readTurn(turnId: string, afterSeq?: number, limit?: number): Promise<ConversationRecord[]>;
}
