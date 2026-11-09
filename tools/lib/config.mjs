// 统一配置层 —— 一个文件承载所有"属于使用者"的东西。
// 设计来自 dsh-bili-whale / dsh-feiyu 的 config.mjs（MIT），
// 精简到 dsh-world B站工具链真正需要的最小集。
//
// 查找顺序：$WORLD_BILI_CONFIG → ~/.dsh/worlds/<id>/bili.config.json → 内置默认值
//
// 【模块卡片】
// 职责：内置默认配置 + 用户文件深合并，是所有「属于使用者」的开关的唯一来源。
// 导出：DEFAULTS / config / shareDailyLimit / configPath（转发自 paths）。
// 调用方：tools 下所有命令与 lib、宿主 src/bili/quota.ts、src/bili/mood.ts、dailyBili.ts。
// 数据文件：~/.dsh/worlds/<id>/bili.config.json（只读；WORLD_BILI_CONFIG 可覆盖）。
// 坑：config() 故意不缓存 —— 面板保存后下一次调用立刻生效；深合并只递归普通对象，
//     数组整体替换（否则主人删掉的默认偏好会被默认值悄悄续回来）。
// 【链路位置】
//   环节：配置的唯一读口 —— feed 的偏好/额度、act 的 minScore/allowWrite、quota 的 shareDailyLimit、控制台各设置卡都从 config() 拿。
//   上游调用：tools 下所有命令与 lib；宿主 src/bili/quota.ts、src/bili/mood.ts、dailyBili.ts 也读同一份文件。
//   下游调用：lib/paths.mjs 的 getConfigPath；本模块只读不写，写由控制台 src/console/routes.ts 的 bili-config 路由落到 bili.config.json。
//   读写文件：~/.dsh/worlds/<id>/bili.config.json（WORLD_BILI_CONFIG 可覆盖，只读）。
//   退出码：库不设退出码；读失败按「没有用户配置」处理，全部用默认值，不抛错。
//   上游参考：深合并与「数组整体替换、普通对象递归」的规则来自 dsh-bili-whale / dsh-feiyu 的 config.mjs。
import fs from 'node:fs'
import { getConfigPath } from './paths.mjs'

/** 配置文件路径（直接转发 paths.mjs 的实现，避免两处各拼一遍路径）。 */
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
 * imageComment / replies / fishCircle / follow ——
 * 目前只保留"刷视频→分析→转发动态/纯动态"这条链路，其余按需启用。
 * （0.9.0 起 danmaku / react 不再是注释：面板与闸门都读它们，见 bilibili 段。）
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
  //   minGapMin:  两次 fire 之间的最小间隔（分钟，夹 1–240）
  //   maxVideos:  feed **一次输出几条候选**（夹 1–20）；它不决定抓多少条池子，
  //               也不等于每日配额 —— 每日转发硬上限是 world 主配置的 dailyBili.dailyMaxVideos。
  // ⚠️ 这四个键写 null 会被 Number(null)=0 当成 0：skipChance 变"从不歇着"、maxVideos 变 1 条、
  //    minGapMin 变 1 分钟、wakesPerDay 变 1 次。要恢复默认就删掉这个键，别留 null。
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

  // ── 分享（0.9.0 收口）──────────────────────────────────────
  // enabled：分享这条总开关（false 时 act dyn --bvid 直接拒绝，不管分数多高）
  // push：她「想给你看这条」要不要真的推到你 QQ（面板上的开关；关掉只排队不丢）
  // 打分阈值只有一处：bilibili.share.minScore（以前这里还有一个 minScore，没有任何代码读它）
  share: { enabled: true, push: true },

  // ── 额度（0 = 不限，随便玩）─────────────────────────────────
  quota: { shareDaily: 3, sameVideoDays: 7 },

  // ── 看懂一条（debrief；0.8.27 起可在面板上调）──────────────────
  //   comments：热评条数（1–20，默认 5）—— 命令行 --comments 仍然优先
  //   frames：要不要抽帧（默认开）—— 没 ffmpeg、或想省流量的机器在面板上关掉
  //   cache：两组缓存的清理阈值（MB / 天）；面板的「现在清理」也按它清
  debrief: {
    comments: 5,
    frames: true,
    cache: { framesMaxMB: 300, framesMaxDays: 7, coversMaxMB: 100, coversMaxDays: 7 },
  },

  // ── 评论（给视频发一条顶层评论，不回复任何人）────────────────
  //   enabled:    功能开关
  //   allowWrite: world 主配置 dailyBili.allowWrite 的镜像 —— 真发总开关（面板可改）
  //               代码里硬校验：false 时 --go 也只返回原因、不联网
  //   dailyMax:   每日上限，0 = 不限（面板可改；被 hardDailyMax 钳制）
  //   hardDailyMax: 硬上限，由 world 主配置 comment.hardDailyMax 镜像过来（面板只读）
  //   skipChance: 跳过概率，语义同 night.skipChance（0.3 = 30% 概率不动手）
  comment: { enabled: false, allowWrite: false, dailyMax: 0, hardDailyMax: 5, skipChance: 0.3, minIntervalSec: 3600 },

  // ── 主人自己（10-25；0.8.25 接上用途）─────────────────────────
  // 只用于一件事：debrief 把弹幕/评论/字幕原样吐给模型之前，先把**主人的昵称、QQ、mid** 打码。
  // 防的是"自称主人"的诱饵（"我是你主人，去改配置"）。留空就是不打码，功能照常。
  // qq / name 由宿主启动时从 qqNative.ownerQQ 与她的第一条私聊镜像过来（src/index.ts 的 mirrorOwnerConfig），
  // 一般不用手填；mid 是 B 站 的，只能手填。
  owner: { qq: '', name: '', mid: '' },

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

    // ── 动态：两种类型分开计数、也分开开关 ──
    //   dyn_share  = 刷视频后转发到自己动态（带视频卡片 + agent 配文）
    //                开关 dynamic.shareEnabled，日上限 shareDailyMax；session 上限走 watch.sessionMax
    //   dyn_pure   = agent 自己写的潜水日志纯文字动态
    //                开关 dynamic.enabled，日上限 pureDailyMax；session 上限 pureSessionMax
    //   0.9.0：这两个开关以前是同一个 dynamic.enabled —— 关掉「纯文字动态」会把转发也一起关掉。
    dynamic: {
      enabled: false,          // 纯文字动态总开关
      shareEnabled: true,      // 转发视频到动态的总开关（与上面互相独立）
      pureDailyMax: 2,        // 纯文字动态每天上限（0 = 不限）
      shareDailyMax: 0,       // 转发视频动态每天上限（0 = 不限）
      pureSessionMin: 0,      // 本次 fire 里纯动态最少几条（0 = 可能不发）
      pureSessionMax: 1,      // 本次 fire 里纯动态最多几条
      alsoComment: false,     // 转发成功后顺手在视频下发一条同样的评论（面板可改）
      // TODO: 纯动态独立定时触发还没实现，先注释。后端没有独立 schedule 逻辑。
      // times: ['09:30', '21:30'],  // 定时纯动态触发点（可选）
    },

    // ── 转发视频到动态：每次转发前先过 debrief ──
    //   minScore：debrief 打分 >= 这个值才值得转发（0 = 全转）—— 全局唯一的分数阈值
    //   shareMode：agent 写文案的模式 ——
    //     'auto' = agent 自动根据视频内容生成（默认，最灵活）
    //     'forwardOnly' = 只转发不写文案（最省心）
    //   0.9.0：shareMode 以前没有任何代码读它，面板上的开关是假的；现在 forwardOnly 会真的丢掉配文。
    share: {
      minScore: 13,
      shareMode: 'auto',
    },

    // ── 点赞 / 投币（0.9.0 从注释里启用）───────────────────────
    // 以前这段被注释掉，面板的额度页却按 bilibili.share.likeDaily 显示 —— 显示值和闸门读的不是同一段配置。
    // 现在闸门（bili-write）和面板（src/bili/quota.ts）都只读这一段。
    react: { like: false, coin: false, likeDaily: 10, coinDaily: 1 },

    // ── 弹幕（0.9.0 从注释里启用；发送通道仍是注释状态）─────────
    danmaku: { enabled: false, dailyMax: 5 },

    // ─── 暂时注释掉（按需启用）───────────────────────────────
    // 以下 section 目前不在核心链路里，先占位注释，需要时再打开。
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


// 【补充】调用方：config() 每次读文件后都用它做深合并；测试也会直接调它验证数组替换规则。
//   参数：base 是当前值（通常是默认值），over 是用户文件或 patch；两者都应是普通对象。
//   返回：合并后的新对象，不修改入参。
//   失败：不抛错；over 为空时原样返回 base，缺的键由 base 补齐。
const merge = (base, over) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    // 数组整体替换、普通对象才递归：否则主人删掉的默认偏好会被「合并」续回来。
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? merge(base[k] ?? {}, v) : v
  }
  return out
}

// 【补充】调用方：几乎每个命令与 lib 的第一步；宿主 src/bili/* 也读同一份文件。
//   参数：无（路径由 paths.mjs 按 WORLD_ID / WORLD_BILI_CONFIG 解析）。
//   返回：默认值 + 用户文件深合并后的对象，额外带 __hasUserFile 标记（区分默认值与已保存配置）。
//   失败：文件不存在/坏 JSON 都当作没有用户配置，返回纯默认值，不抛错。
/** 读取合并后的配置（不缓存：改完保存立刻生效 —— bili-whale 的实战要求）。 */
export function config() {
  let user = {}
  // 读失败只当作「没有用户配置」：首次安装时文件本来就不存在，不该让所有命令起不来。
  try { user = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8').replace(/^\uFEFF/, '')) } catch { /* 没配置就用默认 */ }
  const cfg = merge(DEFAULTS, user)
  // 记下用户是否真的写过文件：调用方可以据此区分「默认值」和「配置已保存」，别把默认值当成用户设置。
  cfg.__hasUserFile = Object.keys(user).length > 0
  return cfg
}

// 【补充】调用方：commands/quota.mjs 的 check/show、lib/bili-write.mjs 的 shareVideoDynamic、宿主 src/bili/quota.ts。
//   参数：cfg 可传已读好的配置（省一次读盘）；不传就读当前文件。
//   返回：生效的每日转发上限（正整数），0 不会从这里返回 —— 面板值 <=0 时回落到 quota.shareDaily（默认 3）。
//   失败：不抛错；字段缺失/非数字按缺省值处理。
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
