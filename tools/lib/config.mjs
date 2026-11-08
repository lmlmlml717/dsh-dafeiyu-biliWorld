// 统一配置层 —— 一个文件承载所有"属于使用者"的东西。
// 设计来自 dsh-bili-whale / dsh-feiyu 的 config.mjs（MIT），
// 精简到 dsh-world B站工具链真正需要的最小集。
//
// 查找顺序：$WORLD_BILI_CONFIG → ~/.dsh/worlds/<id>/bili.config.json → 内置默认值
import fs from 'node:fs'
import { getConfigPath } from './paths.mjs'

export { getConfigPath as configPath } from './paths.mjs'

/**
 * 中性默认值：换个账号也能跑；所有"个人化"的东西请写进配置文件。
 *
 * 【配置架构】
 * ┌───────────────┬──────────────────────────────────────────────────┐
 * │ section       │ 作用                                           │
 * ├───────────────┼──────────────────────────────────────────────────┤
 * │ guard         │ 风控闸门（干跑/限速/复读检测/黑名单词）          │
 * │ night         │ 作息窗口（night-plan 随机唤醒）                  │
 * │ preferences   │ 选题口味（feed 偏好词/搜索词/dislike）          │
 * │ bilibili      │ B站专属（dynamic 转发/纯动态额度、history 等）  │
 * │ ledger        │ 账本（token 用量/饭钱/额度概览）                 │
 * └───────────────┴──────────────────────────────────────────────────┘
 *
 * 【暂时注释掉的 section】
 * danmaku / react / imageComment / replies / fishCircle / follow ——
 * 目前只保留"刷视频→分析→转发动态/纯动态"这条链路，其余按需启用。
 */
export const DEFAULTS = {
  // ── 风控闸门（来自 dafeiyu 骨架 ops/guard.py 的设计）──────────────
  // 所有对外真发的动作都必须过这里 —— 新号养号期宁可少发也别被风控盯上。
  guard: {
    dryRun: true,       // ⚠️ 默认干跑：只打印不真发。观察一周后再改 false
    minGapSec: 25,      // 同一"会话"两条消息最小间隔
    dupThreshold: 0.6,  // 3-gram Jaccard 超过即判复读
    banned: ['作为AI', '语言模型', '无法协助', '作为一个'],
  },

  // ── 作息（来自 bili-whale night-plan）───────────────────────────
  // 【重要】night.windows 已废弃，bili 现在直接从 world 主框架读 wake/review 作为唯一真相源。
  // 你在 world 面板改了回顾 23:00、早上 07:30 → bili 自动用 [07:30, 23:00] 当可用时间窗口。
  //
  // 这里只保留 skipChance / minGapMin / maxVideos：
  //   skipChance: 30% 概率今天不想刷（她也有权利歇着）
  //   minGapMin:  两次 fire 之间的最小间隔（分钟）
  //   maxVideos:  feed 选题时给 agent 的软建议（prompt 里说"挑 ≤5 条"）
  //               硬上限由 world 主配置 dailyBili.maxVideos 决定（每日总配额）
  night: {
    skipChance: 0.3,
    minGapMin: 10,
    maxVideos: 5,
    // windows: [{ start: '20:00', end: '24:00' }],   ← 已废弃，从 world 主框架自动推导
  },

  // ── 口味（feed 选题的权重来源；来自 dafeiyu 骨架的 preferences）───
  preferences: {
    like: ['AI 与 Agent 工具', '鬼畜与怀旧', '猫咪', '美食（尤其是白饭相关）'],
    dislike: ['带货', '擦边', '标题党', '纯搬运'],
    keywords: [],       // 额外搜索词（feed 每轮随机抽 1-2 个 like 里的词轮换）
    synonyms: {},       // 主人可在这里按话题追加自己的同义词
  },

  // ── 分享标尺（来自 bili-whale）────────────────────────────────
  // 评分不够 = 今天没有值得发的，是合法结果 ✓
  share: { enabled: true, via: 'dynamic', minScore: 13 },

  // ── 额度（0 = 不限，随便玩）─────────────────────────────────
  quota: { shareDaily: 3, sameVideoDays: 7 },

  // ── 评论（给视频发一条顶层评论，不回复任何人）────────────────
  //   enabled:    功能开关
  //   allowWrite: world 主配置 dailyBili.allowWrite 的镜像 —— 真发总开关（面板可改）
  //               代码里硬校验：false 时 --go 也只返回原因、不联网
  //   dailyMax:   每日上限，0 = 不限（面板可改；被 hardDailyMax 钳制）
  //   hardDailyMax: 硬上限，由 world 主配置 comment.hardDailyMax 镜像过来（面板只读）
  //   skipChance: 跳过概率，语义同 night.skipChance（0.3 = 30% 概率不动手）
  comment: { enabled: false, allowWrite: false, dailyMax: 0, hardDailyMax: 5, skipChance: 0.3, minIntervalSec: 3600 },

  // ── 账本（10-26 新增）───────────────────────────────────────
  // 让她自己看得到"饭钱"和额度 —— 以前她只能反复问主人。
  ledger: {
    enabled: true,
    dailyBudget: 3,                     // 元/天，0 = 不设预算
    mineWorkspace: 'bili-work',         // 哪个工作区的会话算"她自己吃的"
    price: { inputPerM: 2, cachePerM: 0.2, outputPerM: 3 },   // 元/百万 token
    balanceUrl: '',                     // 填 https://api.deepseek.com/user/balance 且 apiKey 有效才查余额
    apiKey: '',
    balanceTimeoutMs: 8000,
    promptInQQ: true,
  },

  // ── B 站活人感写通道（核心：转发动态 + 纯文字动态）───────────
  bilibili: {
    // 观看历史上报（debrief 后记入历史）
    reportHistory: true,

    // ── 每次 fire() 的 session 上限（防一次刷疯了）──
    //   autoFromWindow：true=按 world 作息窗口长度自动算（推荐，窗口越长刷越多，每次触发随机一个）
    //                 false=用下面手动配的 sessionMin/Max（固定用 sessionMax）
    //   sessionMin/Max：只在 autoFromWindow=false 时生效
    //   ⚠️ sessionMin/Max 留空 = 启用自动推导
    watch: {
      autoFromWindow: true,   // 默认：按窗口长度自动算（窗口 2h → [1,2]；8h → [2,6]）
      sessionMin: null,       // 手动最少（autoFromWindow=false 时用）；null = 不用
      sessionMax: null,       // 手动最多；null = 不用
    },

    // ── 动态：两种类型分开计数 ──
    //   dyn_share  = 刷视频后转发到自己动态（带视频卡片 + agent 配文）
    //                日上限 shareDailyMax；session 上限由 watch.sessionMax 控制
    //   dyn_pure   = agent 自己写的潜水日志纯文字动态
    //                日上限 pureDailyMax；session 上限 pureSessionMax
    dynamic: {
      enabled: false,
      pureDailyMax: 2,        // 纯文字动态每天上限（0 = 不限）
      shareDailyMax: 0,       // 转发视频动态每天上限（0 = 不限）
      pureSessionMin: 0,      // 本次 fire 里纯动态最少几条（0 = 可能不发）
      pureSessionMax: 1,      // 本次 fire 里纯动态最多几条
      // TODO: 纯动态独立定时触发还没实现，先注释。后端没有独立 schedule 逻辑。
      // times: ['09:30', '21:30'],  // 定时纯动态触发点（可选）
    },

    // ── 转发视频到动态：每次转发前先过 debrief ──
    //   minScore：debrief 打分 >= 这个值才值得转发（0 = 全转）
    //   shareMode：agent 写文案的模式 ——
    //     'auto' = agent 自动根据视频内容生成（默认，最灵活）
    //     'forwardOnly' = 只转发不写文案（最省心）
    share: {
      minScore: 13,
      shareMode: 'auto',
      addComment: false,
    },

    // ── 身份（自己投稿的 BV/UID，用于列表去重和归属校验）───
    ownMid: '',
    ownBvids: [],

    // ─── 暂时注释掉（按需启用）───────────────────────────────
    // 以下 section 目前不在核心链路里，先占位注释，需要时再打开。
    //
    // // 弹幕（看视频顺手发 / act danmaku 命令）
    // danmaku: { enabled: false, dailyMax: 5 },
    //
    // // 点赞 / 投币（debrief 顺手 / act like/coin）
    // react: { like: false, coin: false, likeDaily: 10, coinDaily: 1 },
    //
    // // 图片评论（贴纸/生图 → B站图床 → reply/add pictures 参数）
    // imageComment: { enabled: false, dailyMax: 2 },
    //
    // // 回应别人对我评论的回复（replies 命令）
    // replies: { enabled: false, dailyMax: 10 },
    //
    // // 鱼圈社交：选题加入「大肥鱼」相关视频
    // fishCircle: { enabled: false },
    //
    // // 关注好 UP（act follow）
    // follow: { enabled: false },
    //
    // // 自由刷（评论区 @ 主人那套 —— 需要时再打开）
    // freeRoam: { enabled: false, unlimited: true, maxVideos: 0, maxMinutes: 0, restMin: 5 },
  },
}


const merge = (base, over) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? merge(base[k] ?? {}, v) : v
  }
  return out
}

/** 读取合并后的配置（不缓存：改完保存立刻生效 —— bili-whale 的实战要求）。 */
export function config() {
  let user = {}
  try { user = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8').replace(/^\uFEFF/, '')) } catch { /* 没配置就用默认 */ }
  const cfg = merge(DEFAULTS, user)
  cfg.__hasUserFile = Object.keys(user).length > 0
  return cfg
}

/**
 * 每天能转发几条动态。**只在这里定义一次**，额度闸（quota.check/show）、写入闸（bili-write）、
 * 面板账本（src/bili/quota.ts）都调它，避免出现两套口径：
 *   - 面板的「转发视频 日上限」写 bilibili.dynamic.shareDailyMax，有值（>0）就以它为准；
 *   - 没配才回落 quota.shareDaily（默认 3）——那是 0.8.6 之前就在用的老键，留给手写配置。
 * 传 `cfg` 便于测试；不传就读当前文件。
 */
export function shareDailyLimit(cfg = config()) {
  const fromUi = Number(cfg?.bilibili?.dynamic?.shareDailyMax ?? 0)
  return fromUi > 0 ? fromUi : Number(cfg?.quota?.shareDaily ?? 3)
}
