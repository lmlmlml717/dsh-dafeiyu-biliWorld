/**
 * 文件头：dsh-world-bili 的浏览器控制台。
 * 宿主半侧维护「她」的世界（人设、世界提示词、记忆、日记、相册、QQ/微信、B 站自动化），
 * 本文件只把这些状态画成设置页里的卡片，并把用户的修改回传给宿主。
 * 注册：__ModuleLoader__ 加载模块 dsh-world-bili，exports.apply 往 settings.section 插槽注册
 * id=world-console、order=28、label=世界控制台；React 由宿主注入，组件都用 h() 手写。
 * 读走 GET /dsh-world/console/*（api），整份状态与配置主要来自 GET /dsh-world/console/snapshot；
 * 写走带 x-dsh-world: 1 头的 JSON POST（post）；QQ 的几扇门在 /dsh-world/qq/*（qqGet/qqPost）。
 * 宿主实现见 src/console/routes.ts（路由与动作）和 src/console/snapshot.ts（把各模块拼成一份快照）。
 * 坑：控制台每 10 秒轮询 snapshot，卡片要自己管草稿；快照可能是 null（非桌面宿主）或字段缺失；
 * 保存失败只显示一句中文，不能让整页崩。
 */
/**
 * dsh-world — 浏览器半侧：设置里的「世界控制台」。
 * 模块 id 必须等于 bundle 行名 dsh-world；数据来自宿主半侧的 /dsh-world/console/* 路由。
 * 读取是 GET；会改变东西的（开始、停止、人设、世界提示词、额度、记忆轮数）是带 x-dsh-world 头的 JSON POST。
 */
/**
 * 【链路位置】
 * 本文件是浏览器控制台；日记/回顾链路走的是记录页里的 Diary 卡片这一段。
 * 上游：记录页把 snapshot 的 diaryDates 交给 Diary；点某天再读 /dsh-world/console/diary?date=。
 * 下游：宿主 routes.ts 的 /console/diary → snapshot.ts 的 diary.read → worlds/<worldId>/diary/YYYY-MM-DD.md。
 * 时序：先列日期，点哪天拉哪天；旧请求的回包靠 wanted.current 丢弃，连点两天不会盖错。
 * 空值：dates 为空显示「还没有日记」；404 或读盘失败显示「读取失败」。
 */
window.__ModuleLoader__.load({
  id: 'dsh-world-bili',
  factory: (require) => {
    var react = require('react')
    var h = react.createElement
    var useState = react.useState
    var useEffect = react.useEffect
    var useRef = react.useRef

    /**
     * 把 fetch 的回复统一成 body：先读 JSON，HTTP 非 2xx 抛带 status/code 的错误，
     * 正文不是 JSON 时标记 notJson —— 上层据此区分「控制台不在」和真的出错。
     * @param {Response} r fetch 的原始回复
     */
    function settle(r) {
      return r.json().then(function (body) { return { body: body } }, function () { return null }).then(function (parsed) {
        var body = parsed && parsed.body
        if (!r.ok) { var err = new Error((body && body.error) || ('HTTP ' + r.status)); err.status = r.status; if (body && body.code) err.code = body.code; throw err }
        if (!parsed) { var bad = new Error('回复不是 JSON'); bad.notJson = true; throw bad }
        return body
      })
    }
    /** 拼前缀发 GET；no-store 防止浏览器把上一次轮询的快照当缓存交回来。 */
    function getFrom(base, path) { return fetch(base + path, { cache: 'no-store' }).then(settle) }
    /** 拼前缀发 JSON POST；x-dsh-world 是宿主要求的写头，缺了会被拒绝，body 为空也要给 {}。 */
    function postTo(base, path, body) {
      return fetch(base + path, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-dsh-world': '1' }, body: JSON.stringify(body || {}) }).then(settle)
    }
    /** console 前缀的只读请求；所有卡片读状态都走这里。 */
    function api(path) { return getFrom('/dsh-world/console/', path) }
    /** console 前缀的写请求；会改世界状态的动作都走这里。 */
    function post(path, body) { return postTo('/dsh-world/console/', path, body) }
    /** QQ 那几扇门在自己的前缀下（/dsh-world/qq/*），不和 console 混在一起。 */
    function qqGet(path) { return getFrom('/dsh-world/qq/', path) }
    /** qq 前缀的写请求；QQ 面板的开关、白名单、控制台登录都走这里。 */
    function qqPost(path, body) { return postTo('/dsh-world/qq/', path, body) }
    /** 保存没成时的那句话。 */
    function failedTo(setMsg) { return function (e) { setMsg('保存失败：' + (e.message || e)) } }
    /** 设置卡下面那行状态：没成（失败、请填…）标红，其余灰色。 */
    function Status(props) { return props.msg ? h('div', { role: 'status', className: /失败|请填/.test(props.msg) ? 'dw-bad' : 'dw-muted' }, props.msg) : null }
    /** 快照，或 null 表示控制台不在（404、不是 JSON 的页面、没有 life 字段的回复）。 */
    function loadSnapshot() {
      return api('snapshot').then(function (s) {
        return s && typeof s === 'object' && typeof s.life === 'object' ? s : null
      }, function (e) { if (e && (e.status === 404 || e.notJson)) return null; throw e })
    }
    /** 只取「时:分」，按配置时区显示；时区写错就退回原字符串，不让整张卡崩。 */
    function clock(iso, zone) {
      try { return new Date(iso).toLocaleTimeString('zh-CN', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }) } catch (e) { return String(iso) }
    }
    /** 「月/日 时:分」的本地时间；空值显示破折号，解析失败就原样返回。 */
    function local(iso, zone) {
      if (!iso) return '—'
      try { return new Date(iso).toLocaleString('zh-CN', { timeZone: zone, hourCycle: 'h23', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch (e) { return iso }
    }
    /** 把「还有多久」写成人话：天/小时/分；已过期或时间看不懂都返回「马上」。 */
    function remaining(iso) {
      var ms = Date.parse(iso) - Date.now()
      if (!(ms > 0)) return '马上'
      var m = Math.round(ms / 60000), d = Math.floor(m / 1440), hr = Math.floor(m % 1440 / 60), mi = m % 60
      return (d ? d + ' 天 ' : '') + (hr ? hr + ' 小时 ' : '') + mi + ' 分'
    }
    /** 后端字段缺失时统一成空数组，后面 map 不用再判。 */
    function list(value) { return Array.isArray(value) ? value : [] }
    var sourceLabel = { first: '新家', return: '回来', plan: '闹钟', fallback: '早上兜底', review: '回顾' }
    var statusLabel = { running: '正在做事', idle: '空闲', cold: '休息中' }

    var LAYERS = [
      { key: '名字', hint: '她叫什么。家的标题、记忆里她的署名都用它。', rows: 1 },
      { key: '她是谁', hint: '一句话：她是什么样的存在。', rows: 2 },
      { key: '性格', hint: '她的脾气、偏好和小习惯。', rows: 4 },
      { key: '说话方式', hint: '口吻、句子长短、会不会用表情。', rows: 3 },
      { key: '愿景', hint: '你希望她成为什么样子。', rows: 4 },
      { key: '补充', hint: '其他想让她知道的：底线、默契、约定。', rows: 3 },
    ]
    /** 和宿主半侧 renderPersona 一样拼：她读到的就是这段。 */
    /**
     * 把分层人设拼成一段：顺序固定为「名字 + 她是谁」→ 性格/说话方式/愿景 → 补充，空层跳过。
     * @param {Object} p 宿主 prompts 接口返回的 persona 分层对象
     */
    function renderPersona(p) {
      var opening = (p['名字'] ? '我是' + p['名字'] + '。' : '') + (p['她是谁'] || '')
      var parts = [opening]
      ;['性格', '说话方式', '愿景'].forEach(function (k) { if (p[k]) parts.push('# ' + k + '\n' + p[k]) })
      parts.push(p['补充'] || '')
      return parts.filter(Boolean).join('\n\n')
    }

    var CSS = [
      '.dw{--ink:var(--dsw-alias-label-primary,#2a2620);--soft:var(--dsw-alias-label-tertiary,#8b8475);--gold:#c49a52;',
      '--line:color-mix(in srgb,currentColor 13%,transparent);--paper:color-mix(in srgb,currentColor 3.5%,transparent);',
      '--glow:color-mix(in srgb,var(--gold) 22%,transparent);--warn:#c4553a;--serif:"Noto Serif SC","Source Han Serif SC","Songti SC","STSong","SimSun",serif;',
      'max-width:780px;display:flex;flex-direction:column;gap:18px;font-size:13px;line-height:1.65;color:var(--ink)}',
      '.dw *{box-sizing:border-box}',
      '.dw-head{position:relative;display:flex;align-items:flex-end;gap:16px;padding:18px 20px 16px;border:1px solid var(--line);border-radius:14px;',
      'background:radial-gradient(120% 140% at 100% 0%,var(--glow),transparent 55%),var(--paper);overflow:hidden}',
      '.dw-head:after{content:"";position:absolute;left:20px;right:20px;bottom:0;height:1px;background:linear-gradient(90deg,transparent,var(--gold),transparent);opacity:.55}',
      '.dw-title{flex:1;min-width:0}.dw-title small{display:block;letter-spacing:.24em;font-size:10px;text-transform:uppercase;color:var(--soft)}',
      '.dw-title h2{margin:2px 0 0;font:600 24px/1.25 var(--serif);letter-spacing:.04em}',
      '.dw-state{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--soft);margin-top:6px}',
      '.dw-dot{width:8px;height:8px;border-radius:50%;background:var(--soft);opacity:.6}',
      '.dw-on .dw-dot{background:var(--gold);opacity:1;box-shadow:0 0 0 0 var(--glow);animation:dw-breathe 2.6s ease-in-out infinite}',
      '@keyframes dw-breathe{0%,100%{box-shadow:0 0 0 0 var(--glow)}50%{box-shadow:0 0 0 7px transparent}}',
      '.dw-power{font:600 13px var(--serif);letter-spacing:.2em;padding:9px 20px 9px 22px;border-radius:999px;cursor:pointer;transition:transform .15s,box-shadow .2s,background .2s;',
      'border:1px solid var(--gold);background:var(--gold);color:#fffaf0;box-shadow:0 6px 18px -8px var(--gold)}',
      '.dw-power:hover{transform:translateY(-1px);box-shadow:0 10px 22px -8px var(--gold)}',
      '.dw-power.stop{background:transparent;color:var(--ink);border-color:var(--line);box-shadow:none}.dw-power.stop:hover{border-color:var(--warn);color:var(--warn)}',
      '.dw-power:disabled{opacity:.5;cursor:default;transform:none}',
      '.dw-tabs{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--line);padding:0 6px}',
      '.dw-tab{position:relative;font:500 13px var(--serif);letter-spacing:.12em;padding:8px 14px 10px;background:none;border:0;color:var(--soft);cursor:pointer}',
      '.dw-tab:after{content:"";position:absolute;left:50%;right:50%;bottom:-1px;height:2px;background:var(--gold);transition:left .25s,right .25s}',
      '.dw-tab.on{color:var(--ink)}.dw-tab.on:after{left:12px;right:12px}',
      '.dw-pane{display:flex;flex-direction:column;gap:14px}',
      '.dw-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}',
      '.dw-card{min-width:0;border:1px solid var(--line);border-radius:12px;padding:14px 16px;background:var(--paper);animation:dw-rise .45s both}',
      '@keyframes dw-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
      '.dw-card h4{margin:0 0 10px;font:600 13px var(--serif);letter-spacing:.14em;display:flex;align-items:center;gap:8px}',
      '.dw-card h4:before{content:"";width:14px;height:1px;background:var(--gold)}',
      '.dw-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 14px}.dw-kv dt{color:var(--soft);white-space:nowrap}.dw-kv dd{margin:0;min-width:0;overflow-wrap:anywhere}',
      '.dw-big{font:600 20px/1.2 var(--serif)}.dw-muted{color:var(--soft)}.dw-bad{color:var(--warn)}.dw-ok{color:var(--gold)}',
      '.dw-quote{border-left:2px solid var(--gold);padding:2px 0 2px 10px;margin:8px 0 0;font-family:var(--serif)}',
      '.dw-meter{height:4px;border-radius:4px;background:var(--line);overflow:hidden;margin:8px 0 4px}.dw-meter i{display:block;height:100%;background:linear-gradient(90deg,var(--gold),color-mix(in srgb,var(--gold) 55%,#fff))}',
      '.dw-trail{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:4px}.dw-trail span{display:inline-flex;align-items:center;gap:6px}.dw-trail span:before{content:"";width:5px;height:5px;border-radius:50%;background:var(--gold)}',
      '.dw-welcome{text-align:center;padding:30px 20px}.dw-welcome h3{font:600 20px var(--serif);margin:0 0 8px;letter-spacing:.06em}',
      '.dw-steps{display:inline-flex;flex-direction:column;gap:6px;text-align:left;margin-top:12px;counter-reset:s}',
      '.dw-steps li{list-style:none;counter-increment:s;display:flex;gap:10px}.dw-steps li:before{content:counter(s);font:600 12px var(--serif);color:var(--gold);border:1px solid var(--gold);border-radius:50%;width:20px;height:20px;display:inline-grid;place-items:center;flex:none}',
      '.dw-layer{display:grid;grid-template-columns:96px 1fr;gap:4px 16px;padding:14px 0;border-bottom:1px dashed var(--line)}',
      '.dw-layer:last-child{border-bottom:0}.dw-layer label{font:600 14px var(--serif);letter-spacing:.1em;padding-top:6px}',
      '.dw-layer small{grid-column:2;color:var(--soft);font-size:11.5px}',
      '.dw textarea,.dw input[type=text],.dw input[type=number]{width:100%;font:inherit;color:inherit;background:color-mix(in srgb,currentColor 2%,transparent);border:1px solid var(--line);border-radius:8px;padding:8px 10px;resize:vertical;transition:border-color .2s,box-shadow .2s}',
      '.dw textarea:focus,.dw input[type=text]:focus,.dw input[type=number]:focus{outline:none;border-color:var(--gold);box-shadow:0 0 0 3px var(--glow)}',
      '.dw input[type=number]::-webkit-outer-spin-button,.dw input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}.dw input[type=number]{-moz-appearance:textfield}',
      '.dw input.dw-name{font:600 18px var(--serif);letter-spacing:.06em}',
      '.dw-code{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:12px;line-height:1.6;min-height:340px}',
      '.dw-bar{position:sticky;bottom:0;display:flex;align-items:center;gap:10px;padding:10px 0 2px;background:linear-gradient(transparent,var(--dsw-alias-background-primary,transparent) 40%)}',
      '.dw-btn{flex-shrink:0;white-space:nowrap;font:inherit;cursor:pointer;border:1px solid var(--line);background:transparent;color:inherit;border-radius:8px;padding:6px 14px;transition:border-color .2s,background .2s}',
      '.dw-btn:hover{border-color:var(--gold)}.dw-btn.primary{background:var(--gold);border-color:var(--gold);color:#fffaf0}.dw-btn:disabled{opacity:.45;cursor:default}',
      '.dw-preview{white-space:pre-wrap;font-family:var(--serif);font-size:12.5px;margin:0;max-height:260px;overflow:auto}',
      '.dw-chip{display:inline-block;font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--line);color:var(--soft)}',
      '.dw table{width:100%;border-collapse:collapse}.dw td{padding:3px 6px;vertical-align:top;border-bottom:1px solid color-mix(in srgb,currentColor 6%,transparent)}',
      '.dw-activity{table-layout:fixed}.dw-activity td{overflow:hidden;overflow-wrap:anywhere}.dw-activity td:first-child{white-space:nowrap}',
      '.dw-clamp{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:12px}',
      '.dw-hit{padding:10px 0;border-top:1px solid var(--line);min-width:0}.dw-hit .dw-diary{max-height:320px;overflow:auto}',
      '.dw-setting{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;align-items:center}.dw-setting input[type=text]{flex:1 1 120px;max-width:200px;min-width:0}',
      '.dw-setting select{flex:1 1 140px;max-width:100%;min-width:0}',
      '.dw pre.dw-diary{white-space:pre-wrap;margin:10px 0 0;font-family:var(--serif)}',
      '.dw select{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:6px;padding:2px 6px}',
      '@media (prefers-reduced-motion:reduce){.dw *{animation:none!important;transition:none!important}}',
    ].join('')
    /** 样式只插一次；设置页重挂时靠 id 避免重复生成 <style>。 */
    function ensureStyle() {
      if (document.getElementById('dsh-world-console-style')) return
      var tag = document.createElement('style'); tag.id = 'dsh-world-console-style'; tag.textContent = CSS; document.head.appendChild(tag)
    }

    /** 通用卡片外壳：title 可空，delay 只控制入场动画的错峰。 */
    function Card(props) {
      return h('section', { className: 'dw-card', style: { animationDelay: (props.delay || 0) + 'ms' } }, props.title ? h('h4', null, props.title) : null, props.children)
    }

    /** 通用保存按钮：内部独立 useState 管自己的 loading，互不干扰 — 修闪烁的核心 */
    function SaveBtn(props) {
      var ls = useState(false), loading = ls[0], setLoading = ls[1]
      var label = props.label || '存'
      return h('button', {
        className: 'dw-btn',
        disabled: loading || props.disabled,
        onClick: function () {
          setLoading(true)
          Promise.resolve(props.onClick()).finally(function () { setLoading(false) })
        }
      }, loading ? '保存中…' : label)
    }

    /** 把 [[键, 值], …] 渲染成 dl/dt/dd；null 行直接跳过。 */
    function KV(rows) {
      return h('dl', { className: 'dw-kv' }, rows.filter(Boolean).map(function (row, i) { return [h('dt', { key: 'k' + i }, row[0]), h('dd', { key: 'v' + i }, row[1])] }))
    }

    /**
     * 活动记录卡。
     * props：days（有记录的日期，来自 snapshot.activityDays）、zone（配置时区）、
     * tick（父级轮询计数，变了就重拉当前日期）。
     * 数据：GET activity?day=&outside=1；只读，不写回。
     */
    function Activity(props) {
      var days = props.days, zone = props.zone
      var dayState = useState(days[0] || ''), day = dayState[0], setDay = dayState[1]
      var outsideState = useState(false), outside = outsideState[0], setOutside = outsideState[1]
      var rowsState = useState([]), rows = rowsState[0], setRows = rowsState[1]
      var errState = useState(null), err = errState[0], setErr = errState[1]
      useEffect(function () {
        // 日期列表为空时没有可查的日，直接不请求。
        if (!day) return
        // 切日期很快时旧请求可能晚到；用 alive 只接受当前这次的回包。
        var alive = true
        api('activity?day=' + encodeURIComponent(day) + (outside ? '&outside=1' : '')).then(
          function (r) { if (alive) { setRows(r); setErr(null) } },
          function (e) { if (alive) { setRows([]); setErr(String(e.message || e)) } })
        return function () { alive = false }
      }, [day, outside, props.tick])
      return h(Card, { title: '活动记录' },
        days.length === 0 ? h('div', { className: 'dw-muted' }, '还没有活动记录') : h('div', null,
          h('select', { value: day, onChange: function (e) { setDay(e.target.value) } }, days.map(function (d) { return h('option', { key: d, value: d }, d) })),
          ' ', h('label', { className: 'dw-muted' }, h('input', { type: 'checkbox', checked: outside, onChange: function (e) { setOutside(e.target.checked) } }), ' 只看房间外'),
          err ? h('div', { className: 'dw-bad' }, '读取失败：' + err) : null,
          h('table', { className: 'dw-activity' },
            h('colgroup', null, h('col', { style: { width: 48 } }), h('col', { style: { width: '22%' } }), h('col'), h('col', { style: { width: 40 } }), h('col', { style: { width: 64 } })),
            h('tbody', null, rows.map(function (r) {
            return h('tr', { key: r.callId + r.time }, h('td', { className: 'dw-muted' }, clock(r.time, zone)), h('td', null, r.tool), h('td', { title: r.summary }, h('div', { className: 'dw-clamp' }, r.summary)), h('td', { className: 'dw-bad' }, r.status === 'error' ? '失败' : ''), h('td', { className: r.outside ? 'dw-bad' : 'dw-muted' }, (r.gapBefore ? '（此前有缺口）' : '') + (r.outside ? '房间外' : '')))
          })))))
    }
    /**
     * 【上游参考】
     * 只读接口沿用 DSH 控制台的快照与路由：snapshot.ts 给日期列表，routes.ts 的 /console/diary 给正文；
     * 前端不直接读世界目录。
     */
    /**
     * 谁调用：记录页的 Records 渲染它，dates 来自 snapshot 的 diaryDates。
     * 参数：dates 是目录里有日记的日期，倒序；组件自己记住当前打开的那天和正文。
     * 请求：show(date) 先清空旧正文，再读 diary?date=；wanted.current 认领回包，
     *   连点两天时旧日记不会盖掉新日记。
     * 空值：dates 为空显示「还没有日记」；读不到显示「读取失败」，不自动重试。
     */
    /**
     * 日记卡。
     * props：dates（有日记的日期，来自 snapshot.diaryDates）。
     * 数据：按需 GET diary?date=，点哪天拉哪天，避免一次把全部日记搬进浏览器。
     * 只读。
     */
    function Diary(props) {
      var openState = useState(null), open = openState[0], setOpen = openState[1]
      var textState = useState(''), text = textState[0], setText = textState[1]
      var errState = useState(null), err = errState[0], setErr = errState[1]
      var wanted = useRef(null)
      /** 打开某天：先清空旧正文；wanted.current 用来认领回包，连点两天时旧日记不会盖掉新日记。 */
      function show(date) {
        wanted.current = date; setOpen(date); setText(''); setErr(null)
        api('diary?date=' + encodeURIComponent(date)).then(
          function (b) { if (wanted.current === date) setText(String(b.text || '')) },
          function (e) { if (wanted.current === date) setErr(String(e.message || e)) })
      }
      return h(Card, { title: '日记' },
        props.dates.length === 0 ? h('div', { className: 'dw-muted' }, '还没有日记') : h('div', null,
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, props.dates.map(function (d) { return h('button', { key: d, className: 'dw-btn' + (open === d ? ' primary' : ''), onClick: function () { show(d) } }, d) })),
          err ? h('div', { className: 'dw-bad' }, '读取失败：' + err) : null,
          open && !err ? h('pre', { className: 'dw-diary' }, text) : null))
    }

    /**
     * 相册卡。
     * props：tick（轮询计数）、zone（时间显示）。
     * 数据：列表 GET photos?limit=12&offset=；图片本身走 /console/photo?id=，点开才请求。
     * 只读；翻页只改本地 offset，不写回。
     */
    function PhotoAlbum(props) {
      var pageState = useState({ photos: [], total: 0, hasMore: false }), page = pageState[0], setPage = pageState[1]
      var offsetState = useState(0), offset = offsetState[0], setOffset = offsetState[1]
      var openState = useState(null), open = openState[0], setOpen = openState[1]
      var errorState = useState(''), error = errorState[0], setError = errorState[1]
      useEffect(function () {
        // offset 变化就重拉一页；alive 防止快速翻页时旧页回包覆盖新页。
        var alive = true
        api('photos?limit=12&offset=' + offset).then(function (value) { if (alive) { setPage(value); setError('') } }, function (e) { if (alive) setError(String(e.message || e)) })
        return function () { alive = false }
      }, [offset, props.tick])
      return h('div', { className: 'dw-pane' },
        h(Card, { title: '她收藏的照片' },
          h('div', { className: 'dw-muted' }, '由她用 keep_photo 决定收藏。列表只读取说明，点开才加载图片。'),
          error ? h('div', { className: 'dw-bad', role: 'alert' }, error) : null,
          page.photos.length ? page.photos.map(function (photo) {
            return h('div', { className: 'dw-setting', key: photo.id },
              h('span', { style: { flex: '1 1 180px', overflowWrap: 'anywhere' } }, photo.description || '未写说明', ' · ', photo.width + '×' + photo.height, ' · ', local(photo.savedAt, props.zone), photo.tags.length ? ' · ' + photo.tags.join('、') : ''),
              h('button', { className: 'dw-btn', onClick: function () { setOpen(open === photo.id ? null : photo.id) } }, open === photo.id ? '收起照片' : '查看照片'),
              open === photo.id ? h('img', { src: '/dsh-world/console/photo?id=' + encodeURIComponent(photo.id), alt: photo.description || '收藏的照片', style: { display: 'block', width: '100%', maxHeight: 480, objectFit: 'contain' }, onError: function () { setError('照片读取失败，请刷新后重试。') } }) : null)
          }) : h('div', { className: 'dw-muted' }, '她还没有收藏照片。'),
          h('div', { className: 'dw-setting' },
            h('button', { className: 'dw-btn', disabled: offset === 0, onClick: function () { setOffset(Math.max(0, offset - 12)); setOpen(null) } }, '上一页'),
            h('span', { className: 'dw-muted' }, '共 ' + page.total + ' 张 · 第 ' + (Math.floor(offset / 12) + 1) + ' 页'),
            h('button', { className: 'dw-btn', disabled: !page.hasMore, onClick: function () { setOffset(offset + 12); setOpen(null) } }, '下一页'))))
    }
    /**
     * props：onSaved（保存成功后让父级刷新快照）。
     * 数据：GET prompts 的 persona 字段；保存 POST persona，整份分层对象写回宿主人设。
     * 生效时机：新会话或下次压缩后，界面会提示；也可用「应用并压缩家会话」立刻触发。
     * 草稿：persona 与 saved 各存一份，JSON 比较判断有没有改动。
     */
    /** 分层人设：每层一张卡，右边是她实际读到的样子。 */
    function PersonaEditor(props) {
      var state = useState(null), persona = state[0], setPersona = state[1]
      var savedState = useState(null), saved = savedState[0], setSaved = savedState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      useEffect(function () {
        api('prompts').then(function (b) { setPersona(b.persona); setSaved(b.persona) }, function (e) { setMsg('读取失败：' + (e.message || e)) })
      }, [])
      if (!persona) return h('div', { className: 'dw-muted' }, msg || '读取中…')
      var dirty = JSON.stringify(persona) !== JSON.stringify(saved)
      /** 改某一层：拷贝一份再替换，保持 state 不可变；同时清掉上一次的提示。 */
      function set(key, value) { var next = Object.assign({}, persona); next[key] = value; setPersona(next); setMsg('') }
      /** 保存整份人设；成功后把 saved 对齐 persona，脏标记随之消失。 */
      function save() {
        setBusy(true)
        post('persona', persona).then(function () { setSaved(persona); setMsg('已保存。新会话或下次压缩后生效，也可点击「应用并压缩家会话」。'); if (props.onSaved) props.onSaved() },
          failedTo(setMsg)).then(function () { setBusy(false) })
      }
      var preview = renderPersona(persona)
      return h('div', { className: 'dw-pane' },
        h(Card, { title: '她是谁' }, h('div', { className: 'dw-muted' }, '这里写的会取代 DSH 自带的那句默认身份（“You are an AI agent powered by DeepSeek Harness.”）；如果你在 DSH 里已经设过系统人设，它原样保留，这里写的排在它后面。'), LAYERS.map(function (layer) {
          var common = { id: 'dw-' + layer.key, value: persona[layer.key] || '', onChange: function (e) { set(layer.key, e.target.value) } }
          return h('div', { className: 'dw-layer', key: layer.key },
            h('label', { htmlFor: common.id }, layer.key),
            layer.rows === 1 ? h('input', Object.assign({ type: 'text', className: 'dw-name', placeholder: '比如：鲸鲸' }, common)) : h('textarea', Object.assign({ rows: layer.rows }, common)),
            h('small', null, layer.hint))
        })),
        h(Card, { title: '她读到的样子', delay: 80 }, preview ? h('pre', { className: 'dw-preview' }, preview) : h('div', { className: 'dw-muted' }, '还什么都没写。没写的时候，她沿用 DSH 自带的默认身份和你在 DSH 里设的系统人设。')),
        h('div', { className: 'dw-bar' },
          h('button', { className: 'dw-btn primary', disabled: !dirty || busy, onClick: save }, busy ? '保存中…' : '保存人设'),
          h('span', { className: msg.indexOf('失败') >= 0 ? 'dw-bad' : 'dw-muted' }, msg || (dirty ? '有改动还没保存' : ''))))
    }
    /**
     * 无 props。
     * 数据：GET prompts 的 worldPrompt（text/custom/memory）；保存 POST world-prompt。
     * text 为空字符串表示删掉自定义模板、换回插件自带的那份；模板里的占位符由宿主替换，这里只编辑原文。
     */
    /** 世界提示词模板：自己的一份，或插件自带的。 */
    function PromptEditor() {
      var state = useState(null), prompt = state[0], setPrompt = state[1]
      var textState = useState(''), text = textState[0], setText = textState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      /** 重新读模板与 custom/memory 标记：保存后要拿服务端的新状态，不能只信本地。 */
      function load() { api('prompts').then(function (b) { setPrompt(b.worldPrompt); setText(b.worldPrompt.text) }, function (e) { setMsg('读取失败：' + (e.message || e)) }) }
      useEffect(load, [])
      if (!prompt) return h('div', { className: 'dw-muted' }, msg || '读取中…')
      /** 保存模板；成功提示由调用方给（普通保存与恢复默认文案不同）。 */
      function save(value, done) {
        post('world-prompt', { text: value }).then(function () { setMsg(done); load() }, failedTo(setMsg))
      }
      return h('div', { className: 'dw-pane' },
        h(Card, { title: '世界提示词' },
          h('div', { style: { marginBottom: 8 } }, h('span', { className: 'dw-chip' }, prompt.custom ? '你自己的一份' : '插件自带'), ' ',
            h('span', { className: 'dw-muted' }, '可用 {{name}} {{partner}} {{homeTitle}} {{roomDir}} {{diaryDir}} {{selfFile}} {{self}} 和 {{#home}}…{{/home}} 等，见 README')),
          h('textarea', { className: 'dw-code', value: text, onChange: function (e) { setText(e.target.value); setMsg('') } })),
        prompt.memory && list(prompt.memory.missing).length ? h(Card, { title: '这份提示词还没提到新的记忆能力' },
          h('div', { className: 'dw-muted' }, '你自己的这份没有用到：' + list(prompt.memory.missing).join('、') + '。工具照样可用，但她在提示里读不到它们的来历。想加的话，把下面这段贴进去；插件不会自动改你的模板。'),
          h('pre', { className: 'dw-diary' }, prompt.memory.snippet)) : null,
        h('div', { className: 'dw-bar' },
          h('button', { className: 'dw-btn primary', disabled: text === prompt.text, onClick: function () { save(text, '已保存。新会话或下次压缩后生效，也可点击「应用并压缩家会话」。') } }, '保存'),
          prompt.custom ? h('button', { className: 'dw-btn', onClick: function () { if (window.confirm('删掉你自己的这份，换回插件自带的模板？')) save('', '已换回插件自带的模板。') } }, '恢复默认') : null,
          h('span', { className: msg.indexOf('失败') >= 0 ? 'dw-bad' : 'dw-muted' }, msg)))
    }

    /**
     * 「应用已保存配置」卡。
     * props：snap（整份快照，读 snap.homeApply/running/life）、refresh（提交后重拉快照）。
     * 保存：POST apply-home；宿主排队等家空闲再压缩，本卡只轮询快照里的 waiting/compacting 状态。
     */
    function HomeApply(props) {
      var snap = props.snap, state = snap.homeApply || {}
      var sendingState = useState(false), sending = sendingState[0], setSending = sendingState[1]
      var errorState = useState(''), error = errorState[0], setError = errorState[1]
      var waiting = state.status === 'waiting', compacting = state.status === 'compacting'
      /** 提交一次；等待/压缩期间按钮保持禁用，避免重复排队。 */
      function apply() {
        setSending(true); setError('')
        post('apply-home').then(function () { props.refresh() }, function (e) { setError(String(e.message || e)) }).then(function () { setSending(false) })
      }
      return h(Card, { title: '应用已保存配置' },
        h('div', { className: 'dw-muted' }, '先保存人设和世界提示词，再提交。等待家空闲后压缩一次；压缩会调用模型并重建上下文缓存。'),
        h('div', { className: 'dw-setting' },
          h('button', { className: 'dw-btn', disabled: sending || waiting || compacting || !snap.running || !snap.life || !snap.homeApply, onClick: apply }, waiting ? '等待家空闲…' : compacting ? '正在压缩家会话…' : sending ? '提交中…' : '应用并压缩家会话'),
          h('span', { role: 'status', 'aria-live': 'polite', className: error || state.status === 'failed' ? 'dw-bad' : 'dw-muted' }, error || (waiting ? '已排队，不打断当前对话。' : compacting ? '正在执行，请稍候。' : state.message) || (!snap.running || !snap.life ? '请先启动世界生活线。' : ''))))
    }

    /**
     * props：budget（snapshot.budget，{daily, today}）、live（世界是否在跑）、onSaved（保存后刷新）。
     * 数据：额度读快照；保存 POST budget，daily 为 null 表示不限。
     * 只改额度，不碰当天已经花掉的钱。
     */
    /** 今天家里花了多少，和每天的额度（留空不限）。世界没在跑时记账那边不工作，显示「—」而不是 ¥0.00。 */
    function Budget(props) {
      var budget = props.budget || {}, daily = budget.daily, today = budget.today
      var live = props.live !== false
      var spent = today ? today.yuan : 0
      var draftState = useState(daily == null ? '' : String(daily)), draft = draftState[0], setDraft = draftState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      /** 保存每日额度；空串 = 不限，负数和非数字都拦下。 */
      function save() {
        var text = String(draft).trim(), value = text === '' ? null : Number(text)
        if (value !== null && !(value >= 0)) { setMsg('请填一个不小于 0 的数，或留空表示不限'); return }
        post('budget', { daily: value }).then(function () { setMsg(value === null ? '已改为不限' : '已保存'); if (props.onSaved) props.onSaved() }, failedTo(setMsg))
      }
      var over = live && daily != null && spent >= daily
      return h(Card, { title: '今日花费', delay: 240 },
        h('div', null,
          h('span', { className: 'dw-big' + (over ? ' dw-bad' : '') }, live ? '¥' + spent.toFixed(2) : '—'),
          h('span', { className: 'dw-muted' }, !live ? ' · 世界未启动，未统计' : daily == null ? ' · 不限额' : ' / ¥' + Number(daily).toFixed(2) + ' 每天')),
        live && daily != null ? h('div', { className: 'dw-meter' }, h('i', { style: { width: Math.min(100, daily > 0 ? Math.round(spent / daily * 100) : 100) + '%' } })) : null,
        h('div', { className: 'dw-muted', style: { marginTop: 4 } }, live ? '只算家里；按 DeepSeek 官方价与峰谷时段估算。超过后提醒她一次。' : '世界启动后才会记账；额度可以现在先设。'),
        h('div', { className: 'dw-setting' },
          h('input', { type: 'text', inputMode: 'decimal', placeholder: '每天额度（元），留空不限', value: draft, onChange: function (e) { setDraft(e.target.value); setMsg('') } }),
          h('button', { className: 'dw-btn', onClick: save }, '保存')),
        h(Status, { msg: msg }))
    }
    /**
     * props：mem（snapshot.memory：轮数/窗口/归档统计/范围）、onSaved（保存后刷新）。
     * 数据：全读快照；保存分三条 POST：memory（turns）、memory（coldHours）、archive-scope（scope）。
     * 前两条下次开始对话或压缩后生效，改归档范围要重启 DSH 才重建记忆块。
     */
    /** 记忆块带最近几轮：默认 200，下次开始对话或压缩之后生效；隔多少小时没开口就重新读：默认 24，下一轮生效。 */
    function Memory(props) {
      var mem = props.mem, window_ = mem && mem.windowTurns || 200
      var activeScope = mem && mem.archiveScope || 'workspace'
      var scopeNames = { home: '仅家会话', workspace: '家所在工作区' }
      var scopeState = useState(mem && mem.selectedArchiveScope || activeScope), scope = scopeState[0], setScope = scopeState[1]
      var draftState = useState(String(window_)), draft = draftState[0], setDraft = draftState[1]
      var coldState = useState(String(mem && mem.coldHours || 24)), cold = coldState[0], setCold = coldState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      /** 保存记忆轮数；空串表示恢复默认 200，非整数或小于 1 直接拦下。 */
      function save() {
        var text = String(draft).trim(), value = text === '' ? null : Number(text)
        if (value !== null && !(Number.isInteger(value) && value >= 1)) { setMsg('请填一个不小于 1 的整数，留空恢复默认 200'); return }
        post('memory', { turns: value }).then(function () { setMsg('已保存。下次开始对话或压缩之后生效。'); if (value === null) setDraft('200'); if (props.onSaved) props.onSaved() }, failedTo(setMsg))
      }
      /** 保存「久未开口重新读取」的小时数；上限 720 小时，空串恢复默认 24。 */
      function saveCold() {
        var text = String(cold).trim(), value = text === '' ? null : Number(text)
        if (value !== null && !(Number.isInteger(value) && value >= 1 && value <= 720)) { setMsg('请填 1 到 720 之间的整数小时，留空恢复默认 24'); return }
        post('memory', { coldHours: value }).then(function () { setMsg('已保存。各窗口从下一轮开始按新时长判断。'); if (value === null) setCold('24'); if (props.onSaved) props.onSaved() }, failedTo(setMsg))
      }
      /** 保存归档范围；宿主提示需要重启时如实转告，不假装已经生效。 */
      function saveScope() {
        post('archive-scope', { scope: scope }).then(function (result) {
          setMsg(result.restartRequired ? '已保存。请重启 DSH，启动后按新范围和消息时间重建记忆块。' : '归档范围已保存。')
          if (props.onSaved) props.onSaved()
        }, failedTo(setMsg))
      }
      return h(Card, { title: '记忆', delay: 180 }, mem ? [
        h('div', { key: 'm' }, h('span', { className: 'dw-big' }, mem.turns), h('span', { className: 'dw-muted' }, ' / ' + window_ + ' 轮')),
        h('div', { key: 'b', className: 'dw-meter' }, h('i', { style: { width: Math.min(100, Math.round((mem.turns || 0) / window_ * 100)) + '%' } })),
        h('div', { key: 'd', className: 'dw-muted' }, '约 ' + mem.approxTokens + ' token · 归档 ' + mem.records + ' 条 · 来自 ' + mem.sessions + ' 个会话'),
        h('div', { key: 'active', className: 'dw-muted' }, '当前归档：' + scopeNames[activeScope]),
        h('div', { key: 'scope', className: 'dw-setting' },
          h('select', { value: scope, 'aria-label': '记忆归档范围', onChange: function (e) { setScope(e.target.value); setMsg('') } },
            h('option', { value: 'home' }, '仅家会话'), h('option', { value: 'workspace' }, '家所在工作区')),
          h('button', { className: 'dw-btn', onClick: saveScope }, '保存范围')),
        mem.restartRequired ? h('div', { key: 'restart', className: 'dw-muted', role: 'status' }, '范围已修改，请重启 DSH。重启前继续使用当前范围。') : null,
        h('div', { key: 's', className: 'dw-setting' },
          h('input', { type: 'text', inputMode: 'numeric', 'aria-label': '记忆带最近几轮', placeholder: '最近几轮，留空为 200', value: draft, onChange: function (e) { setDraft(e.target.value); setMsg('') } }),
          h('button', { className: 'dw-btn', onClick: save }, '保存')),
        h('div', { key: 'cd', className: 'dw-muted' }, '一个窗口隔这么久再开口，就重新读一遍记忆块、人设和「我是谁」；正在聊的窗口不受影响。'),
        h('div', { key: 'c', className: 'dw-setting' },
          h('input', { type: 'text', inputMode: 'numeric', 'aria-label': '久未开口后重新读取（小时）', placeholder: '小时，留空为 24', value: cold, onChange: function (e) { setCold(e.target.value); setMsg('') } }),
          h('button', { className: 'dw-btn', onClick: saveCold }, '保存')),
        h(Status, { key: 'x', msg: msg }),
      ] : h('div', { className: 'dw-muted' }, '—'))
    }
    /**
     * 工作区默认权限卡。
     * props：workspace（snapshot.workspace：defaultPermission 与 options）、onSaved（保存后刷新）。
     * 数据：读快照；保存 POST workspace-permission，只影响之后新建的会话。
     */
    function WorkspacePermission(props) {
      var workspace = props.workspace, permission = workspace && workspace.defaultPermission
      var selectionState = useState({ saved: permission, draft: permission }), selection = selectionState[0], setSelection = selectionState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      useEffect(function () {
        // 服务端值变了才同步；用户已经改过草稿时保留草稿，别把正在选的权限冲掉。
        setSelection(function (current) { return current.saved === permission ? current : { saved: permission, draft: current.draft === current.saved ? permission : current.draft } })
      }, [permission])
      if (!workspace) return null
      var draft = selection.draft, selected = workspace.options.find(function (option) { return option.value === draft })
      /** 保存选中的权限；成功后把 saved 对齐 draft，按钮随之重新变灰。 */
      function save() {
        setBusy(true)
        post('workspace-permission', { permission: draft }).then(function () {
          setSelection({ saved: draft, draft: draft }); setMsg('已保存。新建会话将使用所选权限。')
          if (props.onSaved) props.onSaved()
        }, failedTo(setMsg)).then(function () { setBusy(false) })
      }
      return h(Card, { title: '工作区权限' },
        h('div', { className: 'dw-muted' }, '仅用于此工作区新建的会话；已有会话保留各自的权限。'),
        h('div', { className: 'dw-setting' },
          h('select', { value: draft, disabled: busy, 'aria-label': '新建会话默认权限', onChange: function (e) { setSelection({ saved: selection.saved, draft: e.target.value }); setMsg('') } },
            workspace.options.map(function (option) { return h('option', { key: option.value, value: option.value, title: option.description }, option.name) })),
          h('button', { className: 'dw-btn', disabled: busy || draft === selection.saved || !selected, onClick: save }, busy ? '保存中…' : '保存')),
        selected && selected.description ? h('div', { className: 'dw-muted' }, selected.description) : null,
        h(Status, { msg: msg }))
    }
    /**
     * props：on（当前开关，snapshot.compactAfterReview）、onSaved（保存后刷新）。
     * 数据：读快照；保存 POST compact-after-review。
     * 开关即存，没有单独的保存按钮。
     */
    /** 回顾之后是否自动应用她改过的“我是谁”：开关即存，不需要再点保存。 */
    function CompactAfterReview(props) {
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      /** 切换即提交；成功后用返回值文案告诉用户什么时候生效。 */
      function toggle(on) {
        setBusy(true)
        post('compact-after-review', { on: on }).then(function () {
          setMsg(on ? '已开启。每晚回顾后会自动应用并压缩家会话。' : '已关闭。“我是谁”要等下一次压缩才生效。')
          if (props.onSaved) props.onSaved()
        }, failedTo(setMsg)).then(function () { setBusy(false) })
      }
      return h(Card, { title: '回顾后自动压缩' },
        h('div', { className: 'dw-muted' }, '每晚回顾结束、家空闲后，自动应用并压缩一次家会话，让她刚改写的“我是谁”生效；压缩后最近的聊天会重新放回她眼前。'),
        h('label', { className: 'dw-setting' },
          h('input', { type: 'checkbox', checked: props.on, disabled: busy, 'aria-label': '回顾后自动压缩', onChange: function (e) { toggle(e.target.checked) } }),
          ' ', props.on ? '已开启' : '已关闭'),
        h(Status, { msg: msg }))
    }
    /**
     * props：schedule（snapshot.schedule：review/wake 与 defaults）、onSaved（保存后刷新）。
     * 数据：读快照；保存 POST schedule，空字符串转 null 让宿主回默认。
     * 保存后已排好的回顾和早上闹钟立刻改到新时间，她自己定的闹钟不变。
     */
    /** 每日回顾和早上兜底的时间：留空恢复默认；保存后已排好的回顾和早上闹钟立刻改到新时间。 */
    function Schedule(props) {
      var s = props.schedule
      var reviewState = useState(s.review), review = reviewState[0], setReview = reviewState[1]
      var wakeState = useState(s.wake), wake = wakeState[0], setWake = wakeState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      /** 保存作息：两个时间都按 HH:MM 校验，空串交给宿主回默认。 */
      function save() {
        var values = [String(review).trim(), String(wake).trim()]
        if (values.some(function (v) { return v !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v) })) { setMsg('请填 HH:MM 格式的时间（00:00–23:59），留空恢复默认'); return }
        post('schedule', { review: values[0] || null, wake: values[1] || null }).then(function () {
          if (!values[0]) setReview(s.defaults.review); if (!values[1]) setWake(s.defaults.wake)
          setMsg('已保存。已排好的回顾和早上闹钟已改到新时间，她自己定的闹钟不变。')
          if (props.onSaved) props.onSaved()
        }, failedTo(setMsg))
      }
      return h(Card, { title: '作息' },
        h('div', { className: 'dw-muted' }, '每日回顾：她回头看一天、写日记的时间，定在中午以前就回顾前一天。早上：她没定闹钟时醒来的时间。留空恢复默认（回顾 ' + s.defaults.review + '，早上 ' + s.defaults.wake + '）。'),
        h('div', { className: 'dw-setting' },
          h('label', null, '每日回顾 ', h('input', { type: 'time', 'aria-label': '每日回顾时间', value: review, onChange: function (e) { setReview(e.target.value); setMsg('') } })),
          h('label', null, '早上 ', h('input', { type: 'time', 'aria-label': '早上醒来时间', value: wake, onChange: function (e) { setWake(e.target.value); setMsg('') } })),
          h('button', { className: 'dw-btn', onClick: save }, '保存')),
        h('div', { className: 'dw-muted' }, '她看到的工具说明里写的早上时间，要等新开的会话或重启 DSH 后才更新。'),
        h(Status, { msg: msg }))
    }
    /**
     * props：wechat（snapshot.wechat：连接状态/计数/适配器信息）、zone（时间显示）、onSaved（动作后刷新）。
     * 数据：状态读快照；保存 POST wechat（contextMessages/bufferSeconds），重启适配器 POST wechat-adapter。
     * 适配器每约 2 秒来问一次，快照里的 lastContactAt 就是它最近一次来问的时间。
     */
    /** 微信：适配器每约 2 秒来问一次，最近一次来问的时间就是连接状态；两个读取参数在它下次来问时同步。 */
    function Wechat(props) {
      var w = props.wechat, zone = props.zone
      var contextState = useState(String(w.contextMessages)), context = contextState[0], setContext = contextState[1]
      var bufferState = useState(String(w.bufferSeconds)), buffer = bufferState[0], setBuffer = bufferState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      // 连接状态只看最近一次来问的时间：30 秒内算在线；再久就是断了，避免把旧状态显示成「已连接」。
      var age = w.lastContactAt ? Date.now() - new Date(w.lastContactAt).getTime() : null
      var contacted = age != null && age < 30000, offline = contacted && w.account === 'offline'
      var ad = w.adapter
      // 有消息待核对时适配器已经停下，这个状态要压过所有连接状态显示。
      var blocked = ad && ad.needsHuman
      var stateText = blocked ? '● 有消息待核对，适配器已停' : !contacted ? (ad && ad.building ? '● 正在重新构建原生桥' : ad && ad.running ? '● 适配器启动中' : ad && ad.error ? '● 适配器没能启动' : w.lastContactAt ? '● 适配器已断开' : '● 等待适配器') : offline ? '● 微信离线，等待重新登录' : '● 已连接'
      var adMsgState = useState(''), adMsg = adMsgState[0], setAdMsg = adMsgState[1]
      /** 让宿主重启微信适配器；成功与否都只在本卡提示，不挡整个页面。 */
      function restartAdapter() {
        setAdMsg('正在重启…')
        post('wechat-adapter', {}).then(function () { setAdMsg('已重启'); if (props.onSaved) props.onSaved() }, function (e) { setAdMsg('重启失败：' + (e.message || e)) })
      }
      /** 保存两个读取参数；空串表示回默认（上文 8 条、缓冲 3 秒），适配器下次轮询才同步。 */
      function save() {
        var c = String(context).trim() === '' ? null : Number(context), b = String(buffer).trim() === '' ? null : Number(buffer)
        if (c !== null && !(Number.isInteger(c) && c >= 1 && c <= 20)) { setMsg('请填 1–20 的整数，留空恢复默认 8'); return }
        if (b !== null && !(b >= 0 && b <= 30)) { setMsg('请填 0–30 秒，留空恢复默认 3'); return }
        post('wechat', { contextMessages: c, bufferSeconds: b }).then(function () {
          setMsg('已保存。适配器下次轮询时同步，当前这一批沿用原值。')
          if (c === null) setContext('8'); if (b === null) setBuffer('3')
          if (props.onSaved) props.onSaved()
        }, failedTo(setMsg))
      }
      return h(Card, { title: '微信', delay: 300 },
        h('div', null, h('span', { className: 'dw-big ' + (contacted && !offline ? 'dw-ok' : 'dw-bad') }, stateText)),
        KV([
          ['最近联系', w.lastContactAt ? local(w.lastContactAt, zone) : '—'],
          ['绑定账号', w.accountId || '—'],
          ad ? ['适配器', ad.running ? '由插件管理 · 运行中' + (ad.restarts ? '（已重启 ' + ad.restarts + ' 次）' : '') : '由插件管理 · 已退出' + (ad.error ? '：' + ad.error : ad.lastExit ? '（' + ad.lastExit + '），等待重启' : '')] : null,
          ['聊天', w.accountId ? w.chats + ' 个' : '—'],
          ['待发送', String(w.pending)],
          ['待核对', h('span', { className: w.uncertain ? 'dw-bad' : '' }, String(w.uncertain))],
        ]),
        w.uncertain ? h('div', { className: 'dw-muted' }, '发送结果不明的消息不会自动重发，请在微信里核对后用适配器 acknowledge 确认。') : null,
        blocked ? h('div', { className: 'dw-bad' }, '上次有消息处理到一半、结果不明。先在微信里核对是否真的发出，再用适配器的 acknowledge 确认（见适配器 README），然后点下面的重启。') : null,
        ad ? h('div', { className: 'dw-bar' }, h('button', { className: 'dw-btn', onClick: restartAdapter }, '重启适配器'), adMsg ? h('span', { className: adMsg.indexOf('失败') >= 0 ? 'dw-bad' : 'dw-muted' }, adMsg) : null) : null,
        h('div', { className: 'dw-setting' },
          h('input', { type: 'text', inputMode: 'numeric', 'aria-label': '群聊读取上文条数', placeholder: '上文条数，默认 8', value: context, onChange: function (e) { setContext(e.target.value); setMsg('') } }),
          h('input', { type: 'text', inputMode: 'decimal', 'aria-label': '消息缓冲秒数', placeholder: '缓冲秒数，默认 3', value: buffer, onChange: function (e) { setBuffer(e.target.value); setMsg('') } }),
          h('button', { className: 'dw-btn', onClick: save }, '保存')),
        h('div', { className: 'dw-muted' }, '上文按消息条数算（群聊被 @ 时带上之前几条）；缓冲是收到消息后等对方说完的秒数：同一个人在这段时间里又发来消息就重新计时，安静下来再合成一条交给她（最长等 30 秒），0 = 不等。与共享记忆的 200 轮无关。'),
        h(Status, { msg: msg }))
    }
    /**
     * props：native（snapshot.native：她自己 OneBot 通道的状态与开关）、onSaved（动作后刷新快照）、
     * onNeedPassword（控制台要密码时交给父级弹 Panel）。
     * 数据：状态读快照；写操作用 POST qq/native（自动回复/静默/白名单/合批/阳台），
     * 控制台地址走 GET qq/console、打开走 POST qq/open。所有改动都经 change()，成功后刷新快照。
     */
    /** QQ：她自己那条 OneBot 通道（原生），以及 SnowLuma 控制台的入口。 */
    function Qq(props) {
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      // 两个控制台都带 X-Frame-Options: DENY，塞不进 iframe，所以交给系统浏览器开。
      // 地址和令牌由宿主半侧现给（/dsh-world/qq/console），所以打开就是登录态。
      function openDoor(kind) {
        var label = 'SnowLuma'
        setBusy(true); setMsg('')
        qqGet('console').then(function (res) {
          var door = res && res[kind]
          // 还差密码的门也带着地址，先认这件事，别把登录页当成品打开。
          if (door && door.needs === 'password') { if (props.onNeedPassword) props.onNeedPassword(kind); return null }
          if (door && door.url) {
            return qqPost('open', { kind: kind }).then(function (r) {
              setMsg(r && r.opened ? '已在浏览器打开 ' + label + ' 控制台' : '失败：' + ((r && r.error) || '打不开'))
            })
          }
          setMsg('失败：' + ((door && door.error) || '宿主没给地址'))
          return null
        }, function (e) { setMsg('失败：' + ((e && e.message) || e)) }).then(function () { setBusy(false) })
      }
      /** 改通道的开关：一次给的几项一起生效；`done` 拿到通道的新状态，说一句结果。 */
      function change(body, done) {
        setBusy(true); setMsg('')
        qqPost('native', body).then(function (state) {
          setMsg(done ? done(state) : '')
          if (props.onSaved) props.onSaved()
        }, function (e) { setMsg('失败：' + ((e && e.message) || e)) }).then(function () { setBusy(false) })
      }
      // 阳台：拨端口就是开关（0 是关）。
      function flipBridge(port) { change({ bridge: { port: port } }) }
      /** 切换是否自动回话；只改 native.autoReply，其他通道状态不动。 */
      function flipNative(autoReply) { change({ autoReply: autoReply }) }
      // 静默：给一个时间点，到点前只收不回，到点自己醒；null 立刻恢复。
      var muteState = useState(''), muteAt = muteState[0], setMuteAt = muteState[1]
      /** 设定静默截止时间；看不懂的时间直接提示，不提交。 */
      function muteUntil(local) {
        var at = new Date(local)
        if (isNaN(at.getTime())) { setMsg('这个时间看不懂，重挑一下'); return }
        change({ mutedUntil: at.toISOString() })
      }
      // 合批窗口：同一个人在这么多秒内连发几句，合成一次问。填 0 就是每句单独回。
      var quietState = useState(''), quiet = quietState[0], setQuiet = quietState[1]
      useEffect(function () {
        var ms = props.native && typeof props.native.batchQuietMs === 'number' ? String(Math.round(props.native.batchQuietMs / 1000)) : ''
        setQuiet(function (cur) { return cur === '' ? ms : cur })
      }, [props.native && props.native.batchQuietMs])
      /** 保存合批窗口：秒数换算成毫秒传给宿主，范围 0–30 秒。 */
      function saveQuiet() {
        var sec = Number(String(quiet).trim())
        if (!isFinite(sec) || sec < 0 || sec > 30) { setMsg('填 0 到 30 之间的秒数（一批最多等 30 秒）'); return }
        change({ batchQuietMs: Math.round(sec * 1000) })
      }
      // 白名单：谁的话能进来。打开时填上现有的名单，之后不覆盖正在改的字。
      var ids = props.native ? [(props.native.allowPrivateIds || []).join(', '), (props.native.allowGroupsIds || []).join(', ')] : ['', '']
      var allowState = useState({ from: '', people: '', groups: '' }), allow = allowState[0], setAllow = allowState[1]
      useEffect(function () {
        var from = ids.join('|')
        setAllow(function (current) { return current.from === from ? current : { from: from, people: ids[0], groups: ids[1] } })
      }, [ids[0], ids[1]])
      /** 保存白名单：逗号/顿号/分号都当分隔符，只收纯数字 QQ 号；空名单表示谁都不收。 */
      function saveAllow() {
        /** 把白名单文本按空白/逗号/顿号/分号切开。 */
        function split(text) { return String(text).split(/[\s,，、;；]+/).filter(Boolean) }
        var people = split(allow.people), groups = split(allow.groups), wrong = people.concat(groups).find(function (id) { return !/^[0-9]+$/.test(id) })
        if (wrong) { setMsg('请填 QQ 号：「' + wrong + '」不是号码'); return }
        change({ allowPrivate: people, allowGroups: groups }, function () { return people.length || groups.length ? '名单存好了：私聊 ' + people.length + ' 个、群 ' + groups.length + ' 个' : '名单存好了：现在谁的话都不收' })
      }
      /** 让宿主拉起 SnowLuma；spawn 方式起的只活到 DSH 退出，要把这个限制如实说清楚。 */
      function startSnowluma() {
        change({ startSnowluma: true }, function (state) {
          var r = state && state.launch
          if (!r || !r.started) return '没起来：' + ((r && r.error) || '原因不明')
          return '已经让 SnowLuma 起来' + (r.how === 'spawn' ? '（直接起的，这条线只活到 DSH 退出）' : '') + (r.error ? '；' + r.error : '')
        })
      }
      /** 把宿主生成的那行启动命令复制到剪贴板；浏览器不给剪贴板时提示手动选中。 */
      function copyLine(text) {
        if (!text) { setMsg('这条命令还没生出来'); return }
        if (!navigator.clipboard) { setMsg('这个浏览器不给复制，自己选上面那行'); return }
        navigator.clipboard.writeText(text).then(function () { setMsg('命令已复制') }, function () { setMsg('复制失败，自己选上面那行') })
      }
      return h(Card, { title: 'QQ', delay: 240 }, [
        props.native ? (function (n) {
          if (!n) return h('div', { key: 'n', className: 'dw-muted' }, '她自己的通道：没开')
          return h('div', { key: 'n' }, [
            h('span', { key: 'a', className: n.connected ? 'dw-ok' : 'dw-muted' }, n.connected ? '● 她自己连着 ' + n.url : '● 她自己的通道没连上'),
            h('span', { key: 'b', className: 'dw-muted' }, ' · 收 ' + (n.conversations || 0) + ' 个会话 · 发 ' + (n.sent || 0) + ' 条' + (n.failed ? ' · 失败 ' + n.failed : '') + (n.outbox ? ' · 排队待发 ' + n.outbox : '') + (n.blocked ? ' · 挡下 ' + n.blocked : '') + (n.autoReply ? ' · 会自己回' : ' · 只看不回')),
            n.lastError ? h('span', { key: 'c', className: 'dw-bad' }, ' · ' + n.lastError) : null,
          ])
        })(props.native) : h('div', { key: 'n', className: 'dw-muted' }, '她自己的通道：没开（配置里 qqNative.enabled）'),
        (function (n) {
          if (!n) return null
          return h('label', { key: 'nt', className: 'dw-setting', style: { cursor: 'pointer' } }, [
            h('input', { key: 'c', type: 'checkbox', checked: n.autoReply === true, disabled: busy,
              onChange: function (e) { flipNative(e.target.checked) } }),
            h('span', { key: 't' }, n.autoReply === true ? ' 会自己回话' : ' 只看不回'),
          ])
        })(props.native),
        (function (n) {
          if (!n) return null
          var ms = typeof n.batchQuietMs === 'number' ? n.batchQuietMs : 10000
          return h('div', { key: 'quiet', className: 'dw-setting' }, [
            h('span', { key: 's', className: 'dw-muted' }, ms ? '连着发几句：' + (ms / 1000) + ' 秒内合成一次问' : '连着发几句：每句单独回'),
            h('input', { key: 'i', type: 'number', min: 0, max: 30, step: 1, 'aria-label': '合批窗口（秒）', style: { width: 64 }, disabled: busy, value: quiet, onChange: function (e) { setQuiet(e.target.value) } }),
            h('button', { key: 'b', className: 'dw-btn', disabled: busy, onClick: saveQuiet }, '存'),
          ])
        })(props.native),
        (function (n) {
          if (!n) return null
          return h('div', { key: 'mute', className: 'dw-setting' }, [
            h('span', { key: 's', className: n.mutedUntil ? 'dw-bad' : 'dw-muted' }, n.mutedUntil ? '静默到 ' + new Date(n.mutedUntil).toLocaleString() + '（只收不回）' : '现在会出声'),
            h('input', { key: 'i', type: 'datetime-local', 'aria-label': '静默到', disabled: busy, value: muteAt, onChange: function (e) { setMuteAt(e.target.value) } }),
            h('button', { key: 'b', className: 'dw-btn', disabled: busy || !muteAt, onClick: function () { muteUntil(muteAt) } }, '静默到这个点'),
            n.mutedUntil ? h('button', { key: 'r', className: 'dw-btn', disabled: busy, onClick: function () { change({ mutedUntil: null }) } }, '立刻恢复') : null,
          ])
        })(props.native),
        props.native ? h('div', { key: 'allow', className: 'dw-setting' }, [
          h('input', { key: 'p', type: 'text', 'aria-label': '私聊白名单', placeholder: '私聊 QQ 号', disabled: busy, value: allow.people, onChange: function (e) { setAllow({ from: allow.from, people: e.target.value, groups: allow.groups }) } }),
          h('input', { key: 'g', type: 'text', 'aria-label': '群白名单', placeholder: '群号', disabled: busy, value: allow.groups, onChange: function (e) { setAllow({ from: allow.from, people: allow.people, groups: e.target.value }) } }),
          h('button', { key: 'b', className: 'dw-btn', disabled: busy, onClick: saveAllow }, '存名单'),
          h('div', { key: 'h', className: 'dw-muted', style: { width: '100%' } }, '多个用逗号隔开；留空就是谁的话都不收。改完不用重启。'),
        ]) : null,
        (function (n) {
          if (!n) return null
          var b = n.bridge
          if (!b) return h('div', { key: 'nb', className: 'dw-setting' }, [
            h('span', { key: 's', className: 'dw-muted' }, '阳台：关着（要用就在这儿打开）'),
            h('button', { key: 'b', className: 'dw-btn', disabled: busy, onClick: function () { flipBridge(3210) } }, '开这条线（3210）'),
          ])
          return h('div', { key: 'nb' }, [
            h('div', { key: 'l', className: 'dw-muted' },
              h('span', { className: b.serving ? 'dw-ok' : 'dw-muted' }, b.serving ? '● 阳台开着 ' + (b.url || '') : '● 阳台关着'),
              ' · ' + ((b.lines || 0) ? '连着 ' + b.lines + ' 条线' : '还没人敲门')
                + ' · 收了 ' + (b.received || 0) + ' 句、回了 ' + (b.relayed || 0) + ' 句、她开口 ' + (b.spoken || 0) + ' 次'),
            b.lastError ? h('div', { key: 'e', className: 'dw-bad' }, ' · ' + b.lastError) : null,
            h('div', { key: 'c', className: 'dw-muted', style: { wordBreak: 'break-all', fontSize: 12 } }, b.line || ''),
            h('div', { key: 'y', className: 'dw-setting' }, [
              h('button', { key: 'c', className: 'dw-btn', disabled: busy, onClick: function () { copyLine(b.line) } }, '复制这条命令'),
              h('button', { key: 'x', className: 'dw-btn', disabled: busy, onClick: function () { flipBridge(0) } }, '关掉这条线'),
            ]),
          ])
        })(props.native),
        (function (sv) {
          if (!sv) return null
          return h('div', { key: 'sv', className: sv.lastError ? 'dw-bad' : 'dw-muted' },
            (sv.watching ? '● 看门狗盯着' : '○ 看门狗没开') + (sv.lastCheckAt ? ' · SnowLuma ' + (sv.alive ? '通着' : '不通') : '')
              + (sv.restarts ? ' · 已拉起 ' + sv.restarts + ' 次' : '') + (sv.lastError ? ' · ' + sv.lastError : ''))
        })(props.native && props.native.supervisor),
        h('div', { key: 'k', className: 'dw-setting' },
          h('button', { className: 'dw-btn', disabled: busy, onClick: function () { openDoor('snowluma') } }, '打开 SnowLuma 控制台'),
          props.native ? h('button', { className: 'dw-btn', disabled: busy, onClick: startSnowluma }, '拉起 SnowLuma') : null),
        h('div', { key: 'b', className: 'dw-setting' },
          h('button', { className: 'dw-btn', disabled: busy, onClick: function () { if (props.onSaved) props.onSaved() } }, '刷新')),
        h(Status, { key: 'x', msg: msg }),
      ])
    }
    /**
     * props：kind（要开哪扇门，当前只有 snowluma）、onClose（登录并打开成功后关弹层）。
     * 数据：POST qq/panel-password 用面板密码换会话令牌，再 POST qq/open 让宿主拉起系统浏览器。
     * 密码只在内存里过一手，不写 localStorage，也不回传浏览器。
     */
    /**
     * 第一次打开 SnowLuma 控制台时，得先用面板密码换一个会话令牌：那令牌只活在那边的进程内存里，重启就没了。
     * 密码不在浏览器里存着，填完就交给宿主半侧，换到令牌后由宿主把系统浏览器拉起来。
     * 两个控制台都发 X-Frame-Options: DENY，塞不进 iframe，所以只能这样开。
     */
    function Panel(props) {
      var passState = useState(''), pass = passState[0], setPass = passState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      var errState = useState(''), err = errState[0], setErr = errState[1]
      /** 登录流程：先换令牌再开浏览器；任一步失败都停在本弹层里显示原因。 */
      function signIn() {
        if (!pass) { setErr('先填密码'); return }
        setBusy(true); setErr('')
        qqPost('panel-password', { password: pass }).then(function (body) {
          var next = body && body.snowluma
          if (!next || !next.url) { setErr((next && next.error) || '登录失败'); return null }
          setPass('')
          return qqPost('open', { kind: 'snowluma' }).then(function (r) {
            if (r && r.opened) { if (props.onClose) props.onClose() } else setErr((r && r.error) || '打不开浏览器')
          })
        }, function (e) { setErr(String((e && e.message) || e)) }).then(function () { setBusy(false) })
      }
      return h('div', { style: { position: 'fixed', left: 0, top: 0, width: '100%', height: '100%', zIndex: 60, background: 'rgba(10,14,20,.66)', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
        h('div', { style: { width: 480, maxWidth: '92%', background: '#141b25', border: '1px solid rgba(255,255,255,.1)', borderRadius: 12, padding: 20, boxSizing: 'border-box' } },
          h('h3', { style: { margin: '0 0 8px', color: '#e8edf4' } }, '第一次打开 SnowLuma 控制台'),
          h('div', { className: 'dw-muted', style: { marginBottom: 16, lineHeight: 1.6 } }, '它只认密码、没有账号名这回事；会话令牌只存在进程内存里，过期就没了，所以要用面板密码换一次。密码留在你这台机器上，不会回传浏览器。'),
          h('label', { style: { display: 'block', marginBottom: 16, color: '#c7d2de' } }, '密码 ',
            h('input', { type: 'password', value: pass, onChange: function (e) { setPass(e.target.value) }, onKeyDown: function (e) { if (e.key === 'Enter') signIn() }, style: { width: 220 } })),
          err ? h('div', { className: 'dw-bad', style: { marginBottom: 12 } }, '● ' + err) : null,
          h('button', { className: 'dw-btn', disabled: busy, onClick: signIn }, busy ? '……' : '登录并打开'),
          h('button', { className: 'dw-btn', style: { marginLeft: 10 }, onClick: function () { if (props.onClose) props.onClose() } }, '取消')))
    }
    /**
     * props：modules（snapshot.modules：各模块 available/enabled/running/restartRequired）、
     * running（世界是否在跑，决定「启动中」文案）、onSaved（切换后刷新）。
     * 数据：读快照；保存 POST modules，body 形如 {wechat:true}；切换立即注册/撤下工具，有的要重启。
     */
    /** 接入：微信和 QQ 各一个开关，关闭即撤下通道，状态记在 world.json。 */
    function Modules(props) {
      var m = props.modules
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var busyState = useState(''), busy = busyState[0], setBusy = busyState[1]
      /** 切换一个模块；接口返回的 message 原样显示（可能提示要重启）。 */
      function flip(name, value) {
        var body = {}; body[name] = value
        setBusy(name); setMsg('')
        post('modules', body).then(function (result) { setBusy(''); if (result.message) setMsg(result.message); if (props.onSaved) props.onSaved() }, function (e) { setBusy(''); setMsg('切换失败：' + (e.message || e)) })
      }
      /** 画一行模块开关；状态文案按「检查中/未配置/要重启/已关闭/运行中/启动中」顺序判断。 */
      function row(name, label, info, onText, offText) {
        var state = busy === name ? (name === 'qq' ? '正在检查或安装 SDK…' : '切换中…') : !info.available ? '未配置' : info.restartRequired ? 'SDK 已安装，请重启 DSH' : !info.enabled ? '已关闭' : info.running ? '运行中' : props.running ? '启动中' : '已开启，世界启动后生效'
        return h('div', { key: name, className: 'dw-setting' },
          h('span', null, h('b', null, label), h('span', { className: 'dw-muted' }, ' · ' + state)),
          h('button', { className: 'dw-btn', disabled: !info.available || busy === name, onClick: function () { flip(name, !info.enabled) } }, info.enabled ? '关闭' : '开启'),
          h('div', { className: 'dw-muted', style: { flexBasis: '100%' } }, info.enabled ? onText : offText))
      }
      return h(Card, { title: '接入', delay: 270 },
        row('wechat', '微信', m.wechat, '已注册 wechat_chats、wechat_history、wechat_send、wechat_delivery，可先看群聊再发言，并随之启动适配器。关闭会撤掉它们并停掉适配器。', '工具未注册，适配器已停。开启后立即注册，无需重启。'),
        row('qq', 'QQ', m.qq, '插件自己直连 OneBot：状态和设置在 QQ 页面。关闭就断开这条通道。', '开启时检查 SDK；缺少时按需安装并提示重启 DSH。'),
        msg ? h('div', { className: msg.indexOf('失败') >= 0 ? 'dw-bad' : 'dw-muted', role: 'status' }, msg) : null)
    }
    /**
     * 概览页。
     * props：snap（整份快照）、refresh（子卡保存后重拉快照）。
     * 只读展示为主，中间嵌几张可编辑子卡（记忆、额度、权限、回顾压缩、作息、接入）。
     * 快照里缺哪一块就不渲染哪张卡，旧宿主字段不全时也不会崩。
     */
    function Overview(props) {
      var snap = props.snap, zone = snap.timeZone, life = snap.life, alarm = life && life.alarm, mem = snap.memory
      var health = list(snap.health), wakes = life ? list(life.recentWakes) : []
      // 世界没启动、也没有生活线时才算「还没住进来」，此时给三步引导。
      var welcome = !snap.running && !life
      return h('div', { className: 'dw-pane' },
        welcome ? h(Card, null, h('div', { className: 'dw-welcome' },
          h('h3', null, '她还没有住进来'),
          h('div', { className: 'dw-muted' }, '先写下她是谁，再按右上角的「开始」。'),
          h('ol', { className: 'dw-steps' },
            h('li', null, '在「人设」里写她的名字、性格和你对她的愿景'),
            h('li', null, '需要的话，在「世界提示词」里写你想对她说的话'),
            h('li', null, '按「开始」：插件建好她的房间和家，叫醒她')))) : null,
        life ? h('div', { className: 'dw-grid' },
          h(Card, { title: '此刻', delay: 0 },
            h('div', { className: 'dw-big' }, statusLabel[life.status] || life.status),
            alarm ? h('div', { style: { marginTop: 8 } }, h('span', { className: 'dw-muted' }, (sourceLabel[alarm.source] || '闹钟') + ' · '), local(alarm.at, zone), h('span', { className: 'dw-muted' }, '（还有 ' + remaining(alarm.at) + '）')) : h('div', { className: 'dw-muted' }, '没有待定的闹钟'),
            alarm && alarm.note ? h('blockquote', { className: 'dw-quote' }, alarm.note) : null),
          h(Card, { title: '家', delay: 60 }, KV([
            ['会话', String(life.homeSessionId || '还没有家').replace(/^session-/, '').slice(0, 8)],
            ['下次回顾', life.review ? local(life.review.at, zone) : '—'],
            ['最近', wakes.length ? h('div', { className: 'dw-trail' }, wakes.map(function (w, i) { return h('span', { key: i }, local(w.deliveredAt, zone) + ' ' + (sourceLabel[w.source] || w.source) + (w.lateMs >= 120000 ? ' · 晚 ' + Math.round(w.lateMs / 60000) + ' 分' : '')) })) : '—'],
          ]))) : null,
        h('div', { className: 'dw-grid' },
          h(Card, { title: '健康', delay: 120 }, health.length ? health.map(function (f, i) { return h('div', { key: i, className: 'dw-bad' }, '● ' + f) }) : h('div', { className: 'dw-ok' }, '● 一切正常')),
          h(Memory, { mem: mem, onSaved: props.refresh }),
          h(Budget, { budget: snap.budget, live: !!snap.life, onSaved: props.refresh }),
          snap.workspace ? h(WorkspacePermission, { workspace: snap.workspace, onSaved: props.refresh }) : null,
          typeof snap.compactAfterReview === 'boolean' ? h(CompactAfterReview, { on: snap.compactAfterReview, onSaved: props.refresh }) : null,
          snap.schedule ? h(Schedule, { schedule: snap.schedule, onSaved: props.refresh }) : null,
          snap.modules && (snap.modules.wechat.available || snap.modules.qq.available) ? h(Modules, { modules: snap.modules, running: snap.running, onSaved: props.refresh }) : null))
    }
    /**
     * 记录页：活动、日记、压缩历史。
     * props：snap（整份快照）、tick（活动卡按它重拉）。
     * 只读；压缩记录只取快照里最近 5 条。
     */
    function Records(props) {
      var snap = props.snap, zone = snap.timeZone, life = snap.life, compactions = list(snap.compactions)
      return h('div', { className: 'dw-pane' },
        h(Activity, { days: list(snap.activityDays), zone: zone, tick: props.tick }),
        h(Diary, { dates: list(snap.diaryDates) }),
        h(Card, { title: '压缩' }, compactions.length ? h('table', null, h('tbody', null, compactions.map(function (c, i) {
          return h('tr', { key: i }, h('td', { className: 'dw-muted' }, local(c.time, zone)), h('td', null, life && c.sessionId === life.homeSessionId ? '家' : String(c.sessionId || '').slice(-8)), h('td', { className: c.ok ? 'dw-ok' : 'dw-bad' }, c.ok ? '成功' : '失败：' + (c.error || '')), h('td', { className: 'dw-muted' }, c.shadowedTokens ? '缩掉约 ' + c.shadowedTokens + ' token' : ''))
        }))) : h('div', { className: 'dw-muted' }, '还没有压缩记录')))
    }

    /** 只认最后一次发出的请求：条件变了，迟到的旧回复不能盖掉新结果。 */
    function latest() {
      var n = 0
      return { next: function () { return ++n }, current: function (id) { return id === n } }
    }
    /**
     * 记忆查找/读原文的请求包装：每次调用登记一个序号，只有最新一次的回包能落到 UI。
     * @param {Object} guard latest() 返回的守卫
     * @param {string} path memory/find 或 memory/read
     * @param {string} query 已编码好的查询串
     * @param {Function} done 最新回包的成功回调
     * @param {Function} fail 最新回包的失败回调
     */
    function searchMemory(guard, path, query, done, fail) {
      var id = guard.next()
      return api(path + '?' + query).then(function (b) { if (guard.current(id)) done(b) }, function (e) { if (guard.current(id)) fail(e) })
    }
    /**
     * 求某时区在某一刻的 UTC 偏移（毫秒）：用 Intl 把该时区的墙上时间拆出来，再当 UTC 反算。
     * @param {number} at 毫秒时间戳
     * @param {string} zone IANA 时区
     */
    function zoneOffsetMs(at, zone) {
      var parts = {}
      new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)).forEach(function (p) { parts[p.type] = p.value })
      return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(at / 1000) * 1000
    }
    /** 配置时区里某一天的零点，写成 UTC 的 ISO 时间；date 是 YYYY-MM-DD，plusDays 取后面的日子。 */
    function dayStartIso(date, zone, plusDays) {
      var guess = Date.parse(date + 'T00:00:00Z') + (plusDays || 0) * 86400000
      // 第一次减偏移只是粗算；用粗算结果再取一次偏移，跨夏令时边界时才能落到正确的零点。
      var ms = guess - zoneOffsetMs(guess, zone)
      ms = guess - zoneOffsetMs(ms, zone)
      return new Date(ms).toISOString()
    }
    var KINDS = [['conversation', '聊天'], ['diary', '日记']]
    var basisLabel = { message: '发言时间', diaryDate: '日记日期', fileObserved: '看到文件的时间' }
    /** 筛选条件变成 memory/find 的查询串；结束日期含当天。 */
    // 结束日期含当天，所以 to 要取次日零点（plusDays=1）才能把当天整天圈进来。
    function memoryQuery(f, zone, cursor) {
      var q = []
      /** 往查询串里追加一个已编码的参数。 */
      function add(k, v) { q.push(k + '=' + encodeURIComponent(v)) }
      if (f.query) add('query', f.query)
      if (f.kinds && f.kinds.length) add('kinds', f.kinds.join(','))
      if (f.from) add('from', dayStartIso(f.from, zone))
      if (f.to) add('to', dayStartIso(f.to, zone, 1))
      if (f.sourceId) add('sourceId', f.sourceId)
      if (f.turnId) add('turnId', f.turnId)
      if (f.linkedTo) add('linkedTo', f.linkedTo)
      if (f.order === 'oldest') add('order', 'oldest')
      add('limit', '20')
      if (cursor) add('cursor', cursor)
      return q.join('&')
    }
    /**
     * 总归档查找页。
     * props：zone（日期边界按这个时区算）。
     * 数据：GET memory/find（游标分页）和 memory/read（原文分页）；只读，不改归档。
     * 草稿：筛选条件全在本地，点「查找」才发请求；游标过期要清掉旧结果重查。
     */
    function MemorySearch(props) {
      var zone = props.zone
      var formState = useState({ query: '', kinds: [], from: '', to: '', sourceId: '', turnId: '', linkedTo: '', order: 'newest' }), form = formState[0], setForm = formState[1]
      var resultState = useState(null), result = resultState[0], setResult = resultState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      var errState = useState(''), err = errState[0], setErr = errState[1]
      var openState = useState(null), open = openState[0], setOpen = openState[1]
      // 查找和读原文各一个守卫，互不影响：翻页时只有最后一次请求能改结果。
      var guards = useRef(null)
      if (!guards.current) guards.current = { find: latest(), read: latest() }
      /** 改筛选条件：同时清掉旧结果和错误，并让正在飞的那次查找作废。 */
      function change(patch) { setForm(Object.assign({}, form, patch)); setResult(null); setErr(''); guards.current.find.next() }
      /** 发一次查找；带 cursor 时把新一页接在旧结果后面，「更多」就是这样翻页的。 */
      function run(next, cursor) {
        setBusy(true); setErr('')
        searchMemory(guards.current.find, 'memory/find', memoryQuery(next, zone, cursor), function (b) {
          setBusy(false); setResult(cursor && result ? { items: result.items.concat(b.items), nextCursor: b.nextCursor, coverage: b.coverage, search: b.search } : b)
        }, function (e) {
          setBusy(false)
          if (e && e.code === 'cursorExpired') { setResult(null); setErr('资料或范围有变化，请重新查询。') } else setErr('查找失败：' + (e.message || e))
        })
      }
      /** 读一条的原文；offset 用于「继续读」，同一 ref 才把新片段接在旧正文后面。 */
      function show(item, offset) {
        setOpen({ ref: item.ref, title: item.title, loading: true, content: '' })
        searchMemory(guards.current.read, 'memory/read', 'ref=' + encodeURIComponent(item.ref) + (offset ? '&offset=' + offset : ''), function (b) {
          setOpen({ ref: item.ref, title: item.title, loading: false, content: (offset && open && open.ref === item.ref ? open.content : '') + b.content, nextOffset: b.nextOffset, total: b.totalChars, version: b.version, turnId: b.turnId, current: b.current, item: item })
        }, function (e) {
          setOpen({ ref: item.ref, title: item.title, loading: false, content: '', error: e.code === 'sourceChanged' ? '这条聊天后来被修订过，旧版正文没有保留。' : String(e.message || e) })
        })
      }
      /** 切换聊天/日记类型筛选；不改查询词，只让下一次查找带上新类型。 */
      function kindsToggle(kind) { change({ kinds: form.kinds.indexOf(kind) >= 0 ? form.kinds.filter(function (k) { return k !== kind }) : form.kinds.concat([kind]) }) }
      /** 标出「零结果不等于没发生」：有来源读失败时，结果不完整要如实说。 */
      var cov = result && result.coverage
      return h('div', { className: 'dw-pane' },
        h(Card, { title: '总归档查找' },
          h('div', { className: 'dw-muted' }, '查她的聊天原文和日记。关键词按原文字面匹配、区分大小写；这里只读。'),
          h('form', { className: 'dw-setting', onSubmit: function (e) { if (e && e.preventDefault) e.preventDefault(); run(form) } },
            h('input', { type: 'text', 'aria-label': '关键词', placeholder: '关键词（可留空，按时间翻）', value: form.query, style: { maxWidth: 'none' }, onChange: function (e) { change({ query: e.target.value }) } }),
            h('button', { className: 'dw-btn primary', type: 'submit', disabled: busy }, busy ? '查找中…' : '查找')),
          h('div', { className: 'dw-setting' }, KINDS.map(function (k) {
            return h('label', { key: k[0], className: 'dw-muted' }, h('input', { type: 'checkbox', checked: form.kinds.indexOf(k[0]) >= 0, onChange: function () { kindsToggle(k[0]) } }), ' ' + k[1])
          })),
          h('div', { className: 'dw-setting' },
            h('label', { className: 'dw-muted' }, '从 ', h('input', { type: 'date', value: form.from, onChange: function (e) { change({ from: e.target.value }) } })),
            h('label', { className: 'dw-muted' }, '到 ', h('input', { type: 'date', value: form.to, onChange: function (e) { change({ to: e.target.value }) } })),
            h('select', { value: form.order, 'aria-label': '排序', onChange: function (e) { change({ order: e.target.value }) } }, h('option', { value: 'newest' }, '新的在前'), h('option', { value: 'oldest' }, '旧的在前'))),
          form.sourceId || form.turnId || form.linkedTo ? h('div', { className: 'dw-setting' },
            form.sourceId ? h('button', { className: 'dw-btn', onClick: function () { change({ sourceId: '' }) } }, '来源：' + form.sourceId + ' ×') : null,
            form.turnId ? h('button', { className: 'dw-btn', onClick: function () { change({ turnId: '', order: 'oldest' }) } }, '同一轮：' + form.turnId + ' ×') : null,
            form.linkedTo ? h('button', { className: 'dw-btn', onClick: function () { change({ linkedTo: '' }) } }, '只看关联的内容 ×') : null) : null,
          err ? h('div', { className: 'dw-bad', role: 'alert' }, err) : null,
          cov && cov.state !== 'ready' ? h('div', { className: 'dw-muted', role: 'status' }, '有来源没能读到，零结果不代表没发生过：', list(cov.failures).map(function (f) { return ' ' + f.sourceId + '：' + f.message }).join('；')) : null,
          result ? h('div', { className: 'dw-muted' }, result.items.length ? '已显示 ' + result.items.length + ' 条' : '没有找到。' + (cov && cov.state === 'ready' ? '（范围内完整查过了）' : '')) : null,
          result ? result.items.map(function (item) {
            return h('div', { className: 'dw-hit', key: item.ref },
              h('div', { className: 'dw-muted' }, [(KINDS.filter(function (k) { return k[0] === item.kind })[0] || [0, item.kind])[1], item.title, item.time + '（' + (basisLabel[item.timeBasis] || item.timeBasis) + '）', item.current ? '' : '旧版本'].filter(Boolean).join(' · ')),
              h('div', { style: { overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' } }, item.excerpt),
              h('div', { className: 'dw-setting' },
                h('button', { className: 'dw-btn', onClick: function () { show(item, 0) } }, '读原文'),
                h('button', { className: 'dw-btn', onClick: function () { change({ linkedTo: item.ref }); run(Object.assign({}, form, { linkedTo: item.ref })) } }, '看关联'),
                item.turnId ? h('button', { className: 'dw-btn', onClick: function () { var next = Object.assign({}, form, { turnId: item.turnId, order: 'oldest' }); change({ turnId: item.turnId, order: 'oldest' }); run(next) } }, '同一轮') : null,
                h('button', { className: 'dw-btn', onClick: function () { var next = Object.assign({}, form, { sourceId: item.sourceId }); change({ sourceId: item.sourceId }); run(next) } }, '只看这个来源')),
              open && open.ref === item.ref ? h('div', null,
                open.loading ? h('div', { className: 'dw-muted' }, '读取中…') : null,
                open.error ? h('div', { className: 'dw-bad', role: 'alert' }, open.error) : null,
                open.content ? h('pre', { className: 'dw-diary' }, open.content) : null,
                open.nextOffset ? h('button', { className: 'dw-btn', onClick: function () { show(item, open.nextOffset) } }, '继续读（共 ' + open.total + ' 字）') : null) : null)
          }) : null,
          result && result.nextCursor ? h('button', { className: 'dw-btn', disabled: busy, onClick: function () { run(form, result.nextCursor) } }, '更多') : null))
    }

    // 【链路位置】B站页「Cookie 凭据」卡：对应凭据链路的读写端，工具链所有命令都靠它拿 SESSDATA / bili_jct / buvid3。
    //   数据来源：GET bili-cred（src/console/routes.ts 的 bili-cred 路由）→ 宿主 readBiliCred 读 <数据根>/credentials.json。
    //   保存去向：POST bili-cred → 宿主 saveBiliCred 合并三个字段写回同一文件（不覆盖其它字段）。
    //   失败：读取失败显示在卡内；三个字段缺一个都会提示「调用可能 401」，不会假装保存成功。
    /**
     * 无 props。
     * 数据：GET bili-cred；保存 POST bili-cred，写 bili/credentials.json，保存后立刻对工具链生效。
     * 三个字段缺一个都可能 401，下面用 needAll 直接提示。
     */
    /** Cookie 凭据编辑卡 — credentials.json */
    function BiliCredCard() {
      var state = useState(null), cred = state[0], setCred = state[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      useEffect(function () {
        api('bili-cred').then(function (c) { setCred(c); setMsg('') }, function (e) { setMsg('读取失败：' + (e.message || e)) })
      }, [])
      if (!cred) return h(Card, { title: 'Cookie 凭据' }, h('div', { className: 'dw-muted' }, msg || '读取中…'))
      /** 改一个 Cookie 字段：用计算属性拷一份再改，不直接改 state 对象。 */
      function set(key, value) { setCred(Object.assign({}, cred, (_tmp = {}, _tmp[key] = value, _tmp))) }
      var _tmp
      /** 只提交三个凭据字段；保存后重新读一次，拿到 _exists/_updatedAt 等展示字段。 */
      function save() {
        setBusy(true); setMsg('')
        var patch = { SESSDATA: cred.SESSDATA || '', bili_jct: cred.bili_jct || '', buvid3: cred.buvid3 || '' }
        post('bili-cred', patch).then(function () { setMsg('已保存'); api('bili-cred').then(setCred) }, failedTo(setMsg)).then(function () { setBusy(false) })
      }
      var needAll = cred.SESSDATA && cred.bili_jct && cred.buvid3
      return h(Card, { title: 'Cookie 凭据' },
        h('div', { className: 'dw-muted', style: { marginBottom: 8 } },
          '从 B 站浏览器登录态抓取（F12 → Application → Cookies → bilibili.com）。工具链会读 credentials.json；保存后立刻生效。'),
        h('div', { className: 'dw-layer' }, h('label', null, 'SESSDATA'), h('input', { type: 'text', value: cred.SESSDATA || '', onChange: function (e) { set('SESSDATA', e.target.value); setMsg('') }, placeholder: '浏览器 Cookie 里的 SESSDATA' }), h('small', null, '登录凭证，最长的一串')),
        h('div', { className: 'dw-layer' }, h('label', null, 'bili_jct'), h('input', { type: 'text', value: cred.bili_jct || '', onChange: function (e) { set('bili_jct', e.target.value); setMsg('') }, placeholder: 'CSRF token' }), h('small', null, '写操作（动态、投币）需要的 CSRF token')),
        h('div', { className: 'dw-layer' }, h('label', null, 'buvid3'), h('input', { type: 'text', value: cred.buvid3 || '', onChange: function (e) { set('buvid3', e.target.value); setMsg('') }, placeholder: '设备指纹' }), h('small', null, '设备指纹，读操作（feed、详情）需要')),
        h('div', { className: 'dw-setting' },
          h('button', { className: 'dw-btn primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存凭据'),
          h('span', { className: needAll ? 'dw-ok' : 'dw-bad' }, needAll ? '三件套齐全' : '缺少字段，API 调用可能 401'),
          cred._exists && cred._updatedAt ? h('span', { className: 'dw-muted' }, ' · 上次更新 ' + new Date(cred._updatedAt).toLocaleString()) : null),
        h(Status, { msg: msg }))
    }

    // 【链路位置】B站页「bili.config.json」编辑卡：整条链路（feed 选题 → debrief 打分 → act 发动态）的开关与阈值都在这里。
    //   数据来源：GET bili-config → 宿主 readBiliConfig 读 bili.config.json，并附带 __builtins.synonyms（内置词表，只读）。
    //   保存去向：POST bili-config → src/console/routes.ts 的 bili-config 路由 → 宿主 saveBiliConfig 深合并写回 bili.config.json。
    //   props：无；子卡自己持有草稿，保存成功后本地深合并 patch，不整份重读。
    //   注意：dailyBili.allowWrite 由宿主镜像成 comment.allowWrite，面板只读展示，不在这里改。
    /**
     * 无 props。
     * 数据：GET bili-config（bili.config.json 顶层 section）；保存 POST bili-config（JSON patch，后端深合并）。
     * 草稿：文本框非受控（defaultValue），改动先写回 cfg 上的临时字段（*Str），再由各保存按钮组 patch；
     * 父级轮询重渲时不会冲掉正在输入的字。
     */
    /**
     * bili.config.json 顶层 section — 通用 JSON patch 保存。
     * 核心链路：刷视频 → 分析视频 → 转发动态 / 纯文字动态。
     * 其他 section（identity/owner/freeRoam/danmaku/react/imageComment/replies 等）
     * 暂时注释掉，按需启用时把 UI 代码解开即可。
     */
    function BiliConfigEditor() {
      var state = useState(null), cfg = state[0], setCfg = state[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      // 保存成功后的「已保存」两秒自动消失；卸载前不清理也无妨，这里只在下次保存时重置。
      var msgTimer = null

      /** 深合并：savePatch 成功后合并 patch 到 cfg；setCfgDirty 触发重渲 */
      function deepMerge(a, b) {
        if (!b) return a
        var out = Array.isArray(a) ? a.slice() : Object.assign({}, a)
        Object.keys(b).forEach(function (k) {
          if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) {
            out[k] = deepMerge(a[k], b[k])
          } else {
            out[k] = b[k]
          }
        })
        return out
      }

      /** 让 React 重渲：onChange 存草稿后调一下，修输入卡顿；同时清掉旧反馈 */
      function setCfgDirty() { setCfg(function (prev) { return deepMerge(prev, cfg) }); setMsg('') }

      useEffect(function () {
        api('bili-config').then(function (c) { setCfg(c) }, function (e) { console.warn('bili-config 读取失败:', e.message || e) })
      }, [])

      if (!cfg) return h(Card, { title: 'bili.config.json' }, h('div', { className: 'dw-muted' }, '读取中…'))

      /** POST patch 到后端，成功后 deepMerge 本地 cfg + 显示反馈，失败也显示错误 */
      function savePatch(patch) {
        return post('bili-config', patch).then(
          function () {
            setCfg(function (prev) { return deepMerge(prev, patch) })
            setMsg('已保存 ✓')
            clearTimeout(msgTimer); msgTimer = setTimeout(function () { setMsg('') }, 2000)
          },
          function (e) {
            var err = '保存失败：' + (e.message || e)
            console.warn('bili-config 保存失败:', err)
            setMsg(err)
          }
        )
      }
      var b = cfg.bilibili || {}, d = b.dynamic || {}, sh = b.share || {}
      var nt = cfg.night || {}, pr = cfg.preferences || {}

      /** 勾选框：无全局 busy 依赖 */
      function SSwitch(label, checked, onChange, extraProps) {
        var props = Object.assign({ type: 'checkbox', checked: !!checked, onChange: onChange }, extraProps || {})
        return h('label', { className: 'dw-setting', style: { margin: '2px 0' } },
          h('input', props), ' ', label)
      }

      /** 文本输入：非受控（defaultValue），打字不会被父级轮询重渲冲掉；保存按钮读的仍是 cfg 上的草稿。 */
      function textInput(label, value, onChange, placeholder) {
        return h('div', { className: 'dw-layer' },
          h('label', null, label),
          h('input', { type: 'text', defaultValue: value == null ? '' : String(value), placeholder: placeholder || '', onChange: function (e) { onChange(e.target.value) } }))
      }

      /** 数字输入：非受控，同上。 */
      function numInput(val, onChange, w) { return h('input', { type: 'text', style: { width: w || 48 }, defaultValue: String(val), onChange: function (e) { onChange(Number(e.target.value)) } }) }

      /** 保存按钮转发：把调用转给顶层 SaveBtn 组件（hooks 合法） */
      function saveBtn(label, onClick) { return h(SaveBtn, { label: label, onClick: onClick }) }

      /** 三列表格行：label + 输入框 + 说明，纯 inline table 布局，避免 dw-setting 的 flex/gap 干扰 */
      function row(label, inputEl, info) {
        return h('div', { style: { paddingLeft: 18, display: 'table', width: '100%', marginTop: 6 } },
          h('div', { style: { display: 'table-row' } },
            h('div', { style: { display: 'table-cell', width: 120, whiteSpace: 'nowrap', paddingRight: 10, verticalAlign: 'middle', fontSize: 13 } }, label),
            h('div', { style: { display: 'table-cell', paddingRight: 10, verticalAlign: 'middle', width: 60 } }, inputEl),
            info ? h('div', { style: { display: 'table-cell', verticalAlign: 'middle' }, className: 'dw-muted' }, info) : null))
      }

      // ── 风控闸门：dryRun 的开关统一放在 B站页顶部「真发模式」；这里只说明，不再放第二个复选框 ──
      var guardCard = h(Card, { title: '风控闸门 guard' },
        h('div', { className: 'dw-muted', style: { fontSize: 12, lineHeight: 1.7 } },
          '干跑 / 真发（guard.dryRun）在页面顶部的「真发模式」切换，这里不重复放开关 —— 两处开关极性相反、又各自缓存，曾经会互相改回去。'),
        h('div', { className: 'dw-muted', style: { fontSize: 12, lineHeight: 1.7, marginTop: 4 } },
          '另外三项只在 bili.config.json 里改：minGapSec（两条对外消息的最小间隔秒）、dupThreshold（3-gram 复读阈值）、banned（清洗黑名单词）。'))

      // ── 作息：night-plan 随机窗口 ──
      // 草稿字符串优先：避免 Number(v) 在 "0." 中间态返回 0 覆盖用户输入
      var ntSkipStr = nt.skipChanceStr != null ? nt.skipChanceStr : String(nt.skipChance != null ? nt.skipChance : 0.3)
      var ntMaxStr = nt.maxVideosStr != null ? nt.maxVideosStr : String(nt.maxVideos != null ? nt.maxVideos : 5)
      var ntCard = h(Card, { title: '作息 night' },
        textInput('跳过概率（0–1）', ntSkipStr, function (v) { nt.skipChanceStr = v; setCfgDirty() }, '默认 0.3，30% 概率今天歇着'),
        textInput('feed 候选池数量', ntMaxStr, function (v) { nt.maxVideosStr = v; setCfgDirty() }, '抓多少条视频让 agent 挑（硬上限 20，和下面 session 上限不同）'),
        h('div', { className: 'dw-setting' }, saveBtn('保存作息', function () { savePatch({ night: { skipChance: Number(nt.skipChanceStr), maxVideos: Number(nt.maxVideosStr) } }) })))

      // ── 口味：feed 选题的权重来源 ──
      // 草稿字符串优先：避免 React 重渲时从 pr.like 数组重新 join，覆盖用户正在输入的内容
      // 分隔符统一用 |（顿号/逗号仍兼容，老数据不用重填）
      var prLike = pr.likeStr != null ? pr.likeStr : (pr.like || []).join(' | ')
      var prDis = pr.dislikeStr != null ? pr.dislikeStr : (pr.dislike || []).join(' | ')
      var prCard = h(Card, { title: '口味 preferences' },
        textInput('喜欢（| 分隔）', prLike, function (v) { pr.likeStr = v; setCfgDirty() }, 'AI | 猫咪'),
        textInput('不喜欢（| 分隔）', prDis, function (v) { pr.dislikeStr = v; setCfgDirty() }, '带货 | 擦边'),
        h('div', { className: 'dw-setting' }, saveBtn('保存口味', function () {
          savePatch({ preferences: { like: (pr.likeStr || '').split(/[|｜、,，]/).map(function (s) { return s.trim() }).filter(Boolean), dislike: (pr.dislikeStr || '').split(/[|｜、,，]/).map(function (s) { return s.trim() }).filter(Boolean) } })
        })))

      // ── 观看 + 转发（一条链：刷到好视频 → 转发到动态）─────────
      var wt = b.watch || {}
      var autoFromWin = wt.autoFromWindow !== false
      var wMin = wt.sessionMin != null ? wt.sessionMin : ''
      var wMax = wt.sessionMax != null ? wt.sessionMax : ''
      var shareMax = d.shareDailyMax != null ? d.shareDailyMax : 0
      // 同一条视频几天内不会再被端上来（quota.sameVideoDays，0 = 不按视频去重）
      var sameDays = (cfg.quota && cfg.quota.sameVideoDays != null) ? cfg.quota.sameVideoDays : 7

      /** 观看条数输入框：自动模式下禁用并置灰，改由窗口长度决定。 */
      function numInputWatch(val, onChange) {
        return h('input', {
          type: 'number', min: 0, defaultValue: val,
          disabled: autoFromWin,
          style: { width: 48, opacity: autoFromWin ? 0.4 : 1 },
          onChange: function (e) { onChange(e.target.value === '' ? null : Number(e.target.value)) },
        })
      }

      var watchCard = h(Card, { title: '观看 watch · 转发 share' },
        SSwitch('按窗口长度自动算（推荐）', autoFromWin, function (e) {
          var newAuto = e.target.checked
          savePatch({ bilibili: { watch: { autoFromWindow: newAuto, sessionMin: wt.sessionMin, sessionMax: wt.sessionMax } } })
        }),
        h('div', { className: 'dw-muted', style: { fontSize: 11, marginTop: -2, paddingLeft: 18, marginBottom: 2 } }, autoFromWin
          ? '自动模式：窗口越长→刷越多（2h→[1,2]，8h→[2,6]，15h→[3,10]）；每次触发自动随机一个 target'
          : '手动模式：在「最少–最多」之间随机（0.9.1 起两端都生效）；想每次固定同一条数，就两边填一样'),

        row('每次触发 最少转发', numInputWatch(wMin, function (v) { wt.sessionMin = v; setCfgDirty() }), '条（手动模式下在这个区间里随机）'),
        row('每次触发 最多转发', numInputWatch(wMax, function (v) { wt.sessionMax = v; setCfgDirty() }), '条（和「最少」填一样 = 固定这个数）'),

        h('div', { style: { height: 4 } }),
        SSwitch('转发时 agent 自动配文', sh.shareMode !== 'forwardOnly', function (e) {
          savePatch({ bilibili: { share: { shareMode: e.target.checked ? 'auto' : 'forwardOnly' } } })
        }),

        row('转发 minScore', numInput(sh.minScore != null ? sh.minScore : 13, function (v) { sh.minScore = v; setCfgDirty() }), '（debrief 评分 ≥ 这个值才值得转发，0 = 全转）'),
        row('转发视频 日上限', numInput(shareMax, function (v) { d.shareDailyMax = v; setCfgDirty() }), '条（0 = 不限；超过 world dailyBili.dailyMaxVideos 会被截住）'),
        row('同一条视频 隔', numInput(sameDays, function (v) { sameDays = v; setCfgDirty() }), '天才再转（0 = 不按视频去重）'),
        // 0.9.0：转发有了自己的总开关。以前它和「纯文字动态」共用 dynamic.enabled —— 关掉纯动态会把转发一起关掉。
        h('div', { className: 'dw-setting' },
          h('label', { className: 'dw-setting', style: { margin: '2px 0' } },
            h('input', {
              type: 'checkbox', checked: d.shareEnabled !== false,
              onChange: function (e) { savePatch({ bilibili: { dynamic: { shareEnabled: e.target.checked } } }) }
            }),
            ' ',
            '转发到动态（总开关）'),
          h('span', { className: 'dw-muted', style: { fontSize: 11, marginLeft: 6 } }, '和上面「纯文字动态」的开关互相独立')),

        h('div', { className: 'dw-setting' }, saveBtn('保存观看 & 转发配置', function () {
          savePatch({
            bilibili: {
              watch: { autoFromWindow: wt.autoFromWindow, sessionMin: wt.sessionMin, sessionMax: wt.sessionMax },
              dynamic: { shareDailyMax: d.shareDailyMax },
              share: { minScore: sh.minScore, shareMode: sh.shareMode },
            },
            // 同一条视频几天内不再重复转发：以前只能在 bili.config.json 手写 quota.sameVideoDays。
            quota: { sameVideoDays: sameDays },
          })
        })),
      )

      // ── 纯文字动态 ──
      var pureMax = d.pureDailyMax != null ? d.pureDailyMax : 2
      var pureSessMin = d.pureSessionMin != null ? d.pureSessionMin : 0
      var pureSessMax = d.pureSessionMax != null ? d.pureSessionMax : 1
      var dynCard = h(Card, { title: '纯文字动态 dyn_pure' },
        SSwitch('动态总开关', d.enabled, function (e) { savePatch({ bilibili: { dynamic: { enabled: e.target.checked } } }) }),
        h('div', { className: 'dw-muted', style: { fontSize: 11, paddingLeft: 18, marginTop: -2, marginBottom: 4 } }, '关掉后不仅纯文字动态不发，刷到好视频的转发也会被跳过 — 整条"写动态→发动态"链路都停'),
        row('每日总数上限', numInput(pureMax, function (v) { d.pureDailyMax = v; setCfgDirty() }), '条（今天总共能发几条，跨触发累加）'),
        row('每次触发 最少', numInput(pureSessMin, function (v) { d.pureSessionMin = v; setCfgDirty() }), '条（本次触发至少发几条，0 = 可能不发）'),
        row('每次触发 最多', numInput(pureSessMax, function (v) { d.pureSessionMax = v; setCfgDirty() }), '条（本次触发最多发几条）'),
        h('div', { className: 'dw-setting' }, saveBtn('保存纯文字动态配置', function () { savePatch({ bilibili: { dynamic: { enabled: d.enabled, pureDailyMax: d.pureDailyMax, pureSessionMin: d.pureSessionMin, pureSessionMax: d.pureSessionMax } } }) })))

      // ── 其他小开关 ──
      var otherCard = h(Card, { title: '其他' },
        SSwitch('观看历史上报', b.reportHistory !== false, function (e) { savePatch({ bilibili: { reportHistory: e.target.checked } }) }),
        msg ? h('div', { style: { marginTop: 8 } }, h(Status, { msg: msg })) : null)

      /* ═══════════════════════════════════════════════════════════════════════
       * 以下 section 暂时注释掉，保留代码不删除。需要时把注释解开即可。
       *
       * // 身份（人设已经走 world 主流程，不再从 bili.config.json 读）
       * var idt = cfg.identity || {}
       * var idSec = Section('身份 identity', h('div', null,
       *   textInput('她叫', idt.name, function (v) { idt.name = v }, '她'),
       *   textInput('主人称呼', idt.ownerTitle, function (v) { idt.ownerTitle = v }, '主人'),
       *   ... ))
       *
       * // B站主人（@ 自己功能，暂不需要）
       * var ow = cfg.owner || {}
       * var owSec = Section('你本人 owner', h('div', null, ... ))
       *
       * // 自由刷 freeRoam（评论区 @ 主人那套，整体关闭）
       * var bi = b.freeRoam || {}
       * var freeSec = Section('自由刷 freeRoam', h('div', null, ... ))
       *
       * // 弹幕 / 图片评论 / 回复 / 点赞 / 投币 / 关注
       * var dm = b.danmaku || {}, ic = b.imageComment || {}, rp = b.replies || {}, r = b.react || {}
       * var reactSec = Section('点赞 & 投币 react', ... )
       * var danmakuSec = Section('弹幕 danmaku', ... )
       * var picSec = Section('图片评论 imageComment', ... )
       * var rpSec = Section('回应回复 replies', ... )
       * var followSec = Section('关注 follow', ... )
       * ═══════════════════════════════════════════════════════════════════════ */

      // 不再套一层 .dw-pane：外面 BiliPanel 已经有一层，嵌套 flex 在某些设置页容器里会把下面整块裁掉。
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } }, guardCard, ntCard, watchCard, prCard, dynCard, otherCard)
    }

    // 【链路位置】B站页「历史账本」卡：只读展示最近的动作计数与发言台账，不参与发送判定。
    //   数据来源：GET bili-history?days= → 宿主 readBiliHistory 读 <数据根>/bili-actions.json 与 bili-outbox.md 预览。
    //   保存去向：无写操作；换天数只重拉数据。
    //   失败：读取失败保留旧表格，只把错误显示在标题行。
    /**
     * 无 props。
     * 数据：GET bili-history?days=；只读 bili-actions.json 与 bili-outbox.md 的预览。
     * 切换天数自动重拉，不写回任何文件。
     */
    /** B 站历史账本 — bili-actions.json + outbox.md 预览 */
    function BiliHistory() {
      var state = useState(null), data = state[0], setData = state[1]
      var daysState = useState('7'), days = daysState[0], setDays = daysState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      /** 按当前天数重拉；读取失败保留旧表格，只把错误显示在标题行。 */
      function load() {
        api('bili-history?days=' + encodeURIComponent(days)).then(function (d) { setData(d); setMsg('') }, function (e) { setMsg('读取失败：' + (e.message || e)) })
      }
      useEffect(load, [days])
      return h(Card, { title: '历史账本' },
        h('div', { className: 'dw-setting' },
          h('span', { className: 'dw-muted' }, '查看最近'),
          h('select', { value: days, onChange: function (e) { setDays(e.target.value) } },
            h('option', { value: '3' }, '3 天'),
            h('option', { value: '7' }, '7 天'),
            h('option', { value: '14' }, '14 天'),
            h('option', { value: '30' }, '30 天'),
            h('option', { value: '90' }, '90 天')),
          h('button', { className: 'dw-btn', onClick: load }, '刷新'),
          msg ? h('span', { className: 'dw-bad' }, msg) : null),
        data ? h('div', null,
          h('div', { className: 'dw-muted' }, '共 ' + (data.totalActions || 0) + ' 条动作记录'),
          data.recentActions && data.recentActions.length ? h('table', null, h('tbody', null,
            data.days && data.days.slice(0, 20).map(function (d) {
              var found = data.recentActions.find(function (a) { return a.day === d })
              // 后端按天汇总成 {day,total,kinds}；kinds 渲染成人读的一行，缺的字段仍按原样显示。
              var cell = found
                ? (found.kinds ? Object.keys(found.kinds).map(function (k) { return k + ' ×' + found.kinds[k] }).join(' · ') : JSON.stringify(found))
                : h('span', { className: 'dw-muted' }, '—')
              return h('tr', { key: d }, h('td', { style: { whiteSpace: 'nowrap', paddingRight: 12 } }, d), h('td', null, cell))
            }))) : null,
          data.outboxPreview ? h('details', null, h('summary', { style: { cursor: 'pointer' } }, '发出的动态（bili-outbox.md）'), h('pre', { className: 'dw-preview', style: { marginTop: 6 } }, data.outboxPreview)) : null,
        ) : h('div', { className: 'dw-muted' }, msg || '读取中…'))
    }

    // 【链路位置】配置页「定时器」卡：显示 dailyBili 下一次随机唤醒时刻，并允许改每天次数 / 最小间隔。
    //   props：bili（snapshot.bili，含 plan）、cfg（bili.config.json，含 night）、onSaved（保存后刷新快照）。
    //   数据来源：props.bili.plan（宿主 plan.json 的镜像）。
    //   保存去向：先 POST bili-config 写 night.wakesPerDay/minGapMin，再 POST bili/replan 让后端重抽下一次。
    //   倒计时只用本地每秒 tick，不额外请求服务器。
    /**
     * 定时器 Card — 展示下一次触发时间、窗口、skip 概率、今日剩余额度。
     * 数据来自 props.bili（已有 plan）和 props.cfg（已有 night 配置）。
     */
    /**
     * 定时器 Card —— 下一次触发的随机时刻、今天第几次、以及「每天次数 / 最小间隔」两个可调项。
     *
     * 倒计时用本地 1 秒 tick（不请求服务器）；随机时刻本身由后端 plan.json 提供，
     * 父级每 10 秒轮询一次快照，fire 后重排的新时刻会在下一次轮询里出现。
     * 改完两个数字点「保存并重排」→ POST bili-config 再 POST bili/replan，后端立刻按新配置重抽。
     */
    /**
     * props：bili（snapshot.bili，含 plan）、cfg（bili.config.json，含 night）、onSaved（保存后刷新快照）。
     * 保存：先 POST bili-config 写 night.wakesPerDay/minGapMin，再 POST bili/replan 让后端重抽下一次。
     * 倒计时只用本地每秒 tick，不额外请求。
     */
    function BiliTimerCard(props) {
      var bili = props.bili
      var cfg = props.cfg || {}
      var plan = bili && bili.plan ? bili.plan : null
      var night = cfg.night || {}
      var skipChance = Number(night.skipChance != null ? night.skipChance : 0.3)
      var maxVideos = Number(night.maxVideos != null ? night.maxVideos : 5)

      var wakesState = useState(night.wakesPerDay != null ? String(night.wakesPerDay) : '1')
      var wakes = wakesState[0], setWakes = wakesState[1]
      var gapState = useState(night.minGapMin != null ? String(night.minGapMin) : '10')
      var gap = gapState[0], setGap = gapState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var tickState = useState(Date.now()), now = tickState[0], setNow = tickState[1]

      // 只刷新这张卡的倒计时，不重新请求快照。
      useEffect(function () {
        var timer = setInterval(function () { setNow(Date.now()) }, 1000)
        return function () { clearInterval(timer) }
      }, [])

      // 服务端配置刷新后同步输入框（保存成功、或别处改过）。
      useEffect(function () {
        setWakes(night.wakesPerDay != null ? String(night.wakesPerDay) : '1')
        setGap(night.minGapMin != null ? String(night.minGapMin) : '10')
      }, [night.wakesPerDay, night.minGapMin])

      /** 校验两个数字，先存配置再重排；两步都成功才算保存成功。 */
      function save() {
        var w = Math.round(Number(wakes)), g = Math.round(Number(gap))
        if (!(w >= 1 && w <= 12)) { setMsg('每天次数要填 1–12'); return }
        if (!(g >= 1 && g <= 240)) { setMsg('最小间隔要填 1–240 分钟'); return }
        setMsg('保存中…')
        post('bili-config', { night: { wakesPerDay: w, minGapMin: g } })
          .then(function () { return post('bili/replan') })
          .then(function () {
            setMsg('已保存并重排')
            if (props.onSaved) props.onSaved()
          }, function (e) { setMsg('保存失败：' + (e.message || e)) })
      }

      var nextText = '等待中'
      if (plan && typeof plan.atText === 'string') nextText = plan.atText
      else if (plan && plan.atMs) nextText = new Date(plan.atMs).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

      var doneReason = plan && plan.done ? String(plan.reason || '今日已完成') : ''
      var actionText = plan && plan.action ? String(plan.action) : '—'
      var within = plan && plan.withinWindow ? String(plan.withinWindow) : '—'
      var firedToday = plan && plan.wakes != null ? Number(plan.wakes) : null
      var skipPct = Math.round(skipChance * 100)
      var left = plan && plan.atMs && !doneReason ? Math.max(0, Number(plan.atMs) - now) : null

      return h(Card, { title: '定时器 · 下一次触发' },
        h('table', null, h('tbody', null,
          h('tr', null, h('td', null, '下次触发'), h('td', null,
            plan && plan.done ? h('span', { className: 'dw-muted' }, '今日已完成')
              : h('span', { className: 'dw-ok' }, nextText + (left !== null ? '（还有 ' + remaining(new Date(plan.atMs).toISOString()) + '）' : '')))),
          h('tr', null, h('td', null, '动作'), h('td', null, actionText)),
          h('tr', null, h('td', null, '窗口'), h('td', null, within)),
          h('tr', null, h('td', null, '今天已触发'), h('td', null, firedToday === null ? '—' : firedToday + ' 次')),
          h('tr', null, h('td', null, 'skip 概率'), h('td', null, skipPct + '%')),
          h('tr', null, h('td', null, '候选池'), h('td', null, maxVideos + ' 条')))),

        h('div', { className: 'dw-setting', style: { borderTop: '1px dashed var(--line)', paddingTop: 8, marginTop: 8 } },
          h('span', { className: 'dw-muted' }, '每天次数'),
          h('input', { type: 'number', min: 1, max: 12, value: wakes, style: { width: 56 }, onChange: function (e) { setWakes(e.target.value) } }),
          h('span', { className: 'dw-muted' }, '最小间隔'),
          h('input', { type: 'number', min: 1, max: 240, value: gap, style: { width: 64 }, onChange: function (e) { setGap(e.target.value) } }),
          h('span', { className: 'dw-muted' }, '分钟'),
          h('button', { className: 'dw-btn primary', onClick: save }, '保存并重排')),

        h('div', { className: 'dw-muted', style: { fontSize: 11, marginTop: 2 } }, '每天次数 1–12；最小间隔 1–240 分钟。改完立即重抽下一次时刻，今天已触发的次数保留。'),
        doneReason ? h('div', { className: 'dw-setting' }, h('span', { className: 'dw-muted' }, doneReason)) : null,
        msg ? h(Status, { msg: msg }) : null)
    }

    // 【链路位置】配置页「心情」卡：读写 lib/mood.mjs 的同一份 mood.json，提示语里的【当下状态】就来自它。
    //   props：biliMood（snapshot.biliMood，可为空）。
    //   数据来源：挂载时 GET bili-mood → 宿主 src/bili/mood.ts 读 mood.json。
    //   保存去向：设置（value）与喂饭（feed:true）都 POST bili-mood，落回 mood.json。
    /**
     * 心情 Card — 从后端 GET bili-mood 读取，POST 设置或喂饭。
     *
     * 拖动条“拖不动”的三个坑，这里都绕开了：
     *   1. 不在 render 里 setState。父级每 10 秒轮询一次快照，每次 render 都把正在拖的值拨回服务端旧值，
     *      表现就是松手即弹回。服务端值只在 useEffect 里同步。
     *   2. 拖动期间（dragging.current）不接收任何外部值；draft 只属于用户，点「设置」才提交。
     *   3. 值没变就返回旧对象（apply 里比较 value/hunger/updatedAt），轮询不会触发无意义的重渲染。
     */
    /**
     * props：biliMood（snapshot.biliMood，可为空）。
     * 数据：挂载时 GET bili-mood；设置和喂饭都 POST bili-mood（value 或 feed:true）。
     * 草稿：draft 只在拖动期间存在，松手后交给服务端回包，轮询不会把滑块拨回去。
     */
    function BiliMoodCard(props) {
      var propData = props && props.biliMood
      var state = useState(null), data = state[0], setData = state[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var draftState = useState(null), draft = draftState[0], setDraft = draftState[1]
      var dragging = useRef(false)

      /** 值没变就沿用旧对象：父级 10 秒一次的轮询不会把整张卡重画一遍。 */
      function apply(next) {
        setData(function (previous) {
          if (previous && next
            && previous.value === next.value
            && previous.hunger === next.hunger
            && previous.updatedAt === next.updatedAt) return previous
          return next
        })
      }

      /** 读心情；正拖着滑块时不覆盖草稿。 */
      function load() {
        api('bili-mood').then(function (d) {
          if (dragging.current) return
          apply(d)
          setMsg('')
        }, function (e) { setMsg('读取失败：' + (e.message || e)) })
      }
      useEffect(load, [])

      // 父级快照里的值（轮询）同步进来；正拖着的时候不覆盖用户的草稿。
      var propValue = propData && typeof propData.value === 'number' ? propData.value : null
      var propHunger = propData && typeof propData.hunger === 'number' ? propData.hunger : null
      useEffect(function () {
        if (!dragging.current && propData) apply(propData)
      }, [propValue, propHunger])

      var useData = data || propData
      var serverValue = useData ? Number(useData.value ?? 62) : 62
      var shown = draft === null ? serverValue : draft

      /** 松手：结束拖动，之后允许外部值再同步进来。 */
      function release() { dragging.current = false }
      /** 拖动中：只改本地草稿，不提交，避免每动一格都打一次接口。 */
      function pick(event) {
        dragging.current = true
        setDraft(Number(event.target.value))
      }
      /** 提交手动设定的心情值；成功后清掉草稿，改用服务端回包。 */
      function setMood() {
        var target = Number(shown)
        post('bili-mood', { value: target }).then(function (d) {
          dragging.current = false
          setDraft(null); apply(d); setMsg('已更新')
        }, function (e) { setMsg('设置失败：' + (e.message || e)) })
      }
      /** 喂饭：让宿主按参数涨心情、加饥饿度，回包直接接管显示。 */
      function doFeed() {
        post('bili-mood', { feed: true }).then(function (d) {
          dragging.current = false
          setDraft(null); apply(d); setMsg('喂饭完成')
        }, function (e) { setMsg('喂饭失败：' + (e.message || e)) })
      }

      if (!useData) return h(Card, { title: '心情' }, h('div', { className: 'dw-muted' }, msg || '读取中…'))

      var hg = Number(useData.hunger ?? 0)
      var opts = useData.opts || { hungerCap: 70, mealGain: 7, decayPerTick: 6, moodBase: 62, hungryMoodPenalty: 1 }
      var hungryCap = Number(opts.hungerCap ?? 70)
      var moodLabel = shown >= 80 ? '很开心' : shown >= 60 ? '挺高兴' : shown >= 40 ? '正常' : shown >= 20 ? '不太想说话' : '很低落'

      return h(Card, { title: '心情' },
        h('div', null,
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
            h('span', { className: 'dw-big' }, shown),
            h('span', { className: 'dw-muted' }, '/ 100'),
            h('span', { className: 'dw-chip', style: { marginLeft: 6 } }, moodLabel)),
          h('div', { className: 'dw-meter' }, h('i', { style: { width: shown + '%' } }))),

        h('div', { style: { marginTop: 10 } },
          h('span', { className: 'dw-muted' }, '饥饿度'),
          h('span', { style: { marginLeft: 8 } }, Math.round(hg) + ' / ' + hungryCap)),
        h('div', { className: 'dw-meter' }, h('i', { style: { width: Math.min(100, (hg / hungryCap) * 100) + '%', background: hg > hungryCap * 0.7 ? 'linear-gradient(90deg,var(--warn),#fff)' : undefined } })),

        h('div', { className: 'dw-setting' },
          h('span', { className: 'dw-muted' }, '手动调整'),
          h('input', {
            type: 'range', min: 0, max: 100, value: shown,
            onInput: pick, onChange: pick,
            onMouseUp: release, onTouchEnd: release, onKeyUp: release, onBlur: release,
          }),
          h('span', { style: { minWidth: 28, textAlign: 'right' } }, shown),
          h('button', { className: 'dw-btn', onClick: setMood }, '设置'),
          h('button', { className: 'dw-btn primary', onClick: doFeed }, '喂饭 🍚')),

        h('div', { className: 'dw-setting', style: { borderTop: '1px dashed var(--line)', paddingTop: 8 } },
          h('span', { className: 'dw-muted' }, '参数：'),
          h('span', { className: 'dw-chip' }, '每餐 +' + opts.mealGain + ' 心情'),
          h('span', { className: 'dw-chip' }, '每 tick -' + opts.decayPerTick),
          h('span', { className: 'dw-chip' }, '饥饿阈值 ' + hungryCap)),
        msg ? h('div', { className: /失败/.test(msg) ? 'dw-bad' : 'dw-muted' }, msg) : null)
    }

    // 【链路位置】B站旧「今日额度」卡（已停用，整段被注释掉）：只读展示今日各桶已用/上限。
    //   数据来源：GET bili-quota → 宿主 sources.biliQuota（quota.ts 读 bili-actions.json 与配置）。
    //   现状：2026-11-07 起与「概览」页重复，代码保留在下方注释里；恢复时额度口径要与 shareDailyLimit 对齐。
    /**
     * 额度 Card — 只读展示今日五个桶的已用/上限对比。
     * 数据来自 GET bili-quota。
     */
    // [ BiliQuotaCard disabled 2026-11-07 - duplicate of world overview tab ]
    // Full impl below is commented out, remove /* */ to restore.
    /*
    function BiliQuotaCard() {
      var state = useState(null), data = state[0], setData = state[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]

      function load() {
        api('bili-quota').then(function (d) { setData(d); setMsg('') }, function (e) { setMsg('读取失败：' + (e.message || e)) })
      }
      useEffect(load, [])

      if (!data) return h(Card, { title: '今日额度' }, h('div', { className: 'dw-muted' }, msg || '读取中…'))

      var limits = data.limits || {}
      var day = data.day || ''
      var rows = [
        { key: 'dyn_pure', label: '纯动态', used: data.dyn_pure, limit: limits.dyn_pure },
        { key: 'dyn_share', label: '转发动态', used: data.dyn_share, limit: limits.dyn_share },
        { key: 'like', label: '点赞', used: data.like, limit: limits.like },
        { key: 'coin', label: '投币', used: data.coin, limit: limits.coin },
        { key: 'danmaku', label: '弹幕', used: data.danmaku, limit: limits.danmaku },
      ]

      return h(Card, { title: '今日额度', delay: 80 },
        day ? h('div', { className: 'dw-muted' }, '日期 ' + day) : null,
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          rows.map(function (r) {
            var used = Number(r.used ?? 0)
            var limit = Number(r.limit ?? 0)
            var pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0
            var over = limit > 0 && used >= limit
            return h('div', { key: r.key },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 12 } },
                h('span', null, r.label),
                h('span', { className: over ? 'dw-bad' : 'dw-muted' }, used + ' / ' + (limit > 0 ? limit : '∞'))),
              limit > 0 ? h('div', { className: 'dw-meter' }, h('i', { style: { width: pct + '%', background: over ? 'linear-gradient(90deg,var(--warn),#fff)' : undefined } })) : null)
          })),
        h('div', { className: 'dw-setting' }, h('button', { className: 'dw-btn', onClick: load }, '刷新')),
        msg ? h('div', { className: 'dw-bad' }, msg) : null)
    }    */


    // 【链路位置】B站页主入口：状态表 + 真发开关 + Cookie + 配置编辑器 + 历史账本，是控制台里 B站 链路的聚合页。
    //   props：bili（snapshot.bili）、onTrigger（手动触发后刷新快照）。
    //   数据来源：props.bili 来自 GET snapshot；配置读 GET bili-config。
    //   保存去向：真发模式、快速开关都 POST bili-config（guard.dryRun 与各项开关），写回 bili.config.json；「立即触发」POST bili/trigger。
    /**
     * B 站面板主入口：状态表 + 快速开关 + Cookie + 配置编辑器 + 历史账本。
     * 「真发模式」放在这里最上面，一眼看到，不用翻配置编辑器（全页只有这一个 dryRun 开关）。
     */
    /**
     * props：bili（snapshot.bili）、onTrigger（手动触发后刷新快照）。
     * 本页只做 B 站自动化：状态、真发开关、Cookie、配置、历史；配置实际写 bili.config.json。
     * 快速开关 POST bili-config 后无论成败都重读配置 —— 失败时界面回到服务端真实值。
     */
    function BiliPanel(props) {
      var bili = props.bili
      var cfgState = useState(null), cfg = cfgState[0], setCfg = cfgState[1]
      var triggerState = useState(null), trigMsg = triggerState[0], setTrigMsg = triggerState[1]

      // 首次渲染时加载 bili.config.json —— 快速开关改完后直接刷新
      useEffect(function () { api('bili-config').then(setCfg) }, [])
      /** 重读配置；快速开关和配置编辑器都靠它拿保存后的真实状态。 */
      function refreshCfg() { api('bili-config').then(setCfg) }
      /** 先写 patch 再重读：成功和失败都刷新，避免界面停在旧的乐观值上。 */
      function patchCfg(patch) { post('bili-config', patch).then(refreshCfg, refreshCfg) }

      /** 手动触发一次；这里只负责投递，真正的运行状态等快照轮询回来。 */
      function trigger() {
        setTrigMsg('触发中...')
        post('bili/trigger').then(function () { setTrigMsg('已投递，等 agent 开始跑'); props.onTrigger && props.onTrigger() }, function (e) { setTrigMsg(String(e.message || e)) })
      }
      var runningText = bili.running ? '运行中' : '等待中'

      var dryRun = !(cfg && cfg.guard && cfg.guard.dryRun === false)
      /** 一行快速开关；勾选状态直接反映服务端配置，不在本地留第二份。 */
      var quickRow = function (label, active, onToggle, hint) {
        return h('div', { className: 'dw-setting', style: { padding: '4px 0', borderTop: '1px dashed var(--line)' } },
          h('input', { type: 'checkbox', checked: !!active, onChange: onToggle }),
          ' ', label,
          hint ? h('span', { className: 'dw-muted', style: { fontSize: 11, marginLeft: 6 } }, hint) : null)
      }

      return h('div', { className: 'dw-pane' },
        h(Card, { title: 'B站自由模式 · 状态' },
          h('table', null, h('tbody', null,
            h('tr', null, h('td', null, '自由模式'), h('td', null, bili.enabled ? '✅ 已启用' : '❌ 未启用（主配置 dailyBili.enabled）')),
            h('tr', null, h('td', null, '运行状态'), h('td', null, runningText)),
            h('tr', null, h('td', null, '数据目录'), h('td', null, bili.dataDir || '—'))
          )),
          h('div', { style: { marginTop: 4 } },
            quickRow('真发模式', !dryRun, function (e) { patchCfg({ guard: { dryRun: !e.target.checked } }) }, '勾上才真发；关着时所有对外发的动作只打印不真发 — 新号养号期建议保持关闭')),
          h('div', { style: { marginTop: 6 } },
            h('button', { className: 'dw-btn', disabled: bili.running, onClick: trigger }, bili.running ? '正在跑，不能同时触发' : '立即触发一次'),
            trigMsg ? h('span', { className: 'dw-muted', style: { marginLeft: 8 } }, trigMsg) : null),
      ),
        h(BiliCredCard),
        h(BiliConfigEditor),
        h(BiliHistory))
    }

    // 【链路位置】「评论」页：评论功能开关、真发总开关 allowWrite、跳过概率、每日上限；对应命令 comment 与 act dyn --also-comment。
    //   props：无。
    //   数据来源：GET bili-comment（宿主 readBiliComment：主配置 comment.enabled / dailyBili.allowWrite + bili.config.json 的 comment 段）。
    //   保存去向：POST bili-comment；enabled / allowWrite 改写主配置（cordis.patch.yml），dailyMax / skipChance 写 bili.config.json 并按 hardDailyMax 钳制。
    //   草稿：draft.current.editing 挡住轮询回填，保存后清空。
    /**
     * 无 props。
     * 数据：GET bili-comment；保存 POST bili-comment。
     * 草稿：draft.current 在输入/拖动期间挡住轮询回填（editing 标记），保存后清空。
     */
    /**
     * 评论页 — 给视频发一条顶层评论（不回复任何人、不做楼中楼）。
     * 数据：GET bili-comment；保存：POST bili-comment。
     * 三个控件都先写本地草稿再提交（draft.current.editing），轮询不会把正在拖/正在输入的值弹回去。
     */
    function BiliCommentPanel() {
      var state = useState(null), data = state[0], setData = state[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var draft = useRef({})

      /** 读评论配置；正在改参数时先不覆盖，等保存后再同步。 */
      function load() {
        api('bili-comment').then(function (d) { if (!draft.current.editing) setData(d) }, function (e) { setMsg('读取失败：' + (e.message || e)) })
      }
      useEffect(load, [])

      /** 提交一个 patch；成功后清空草稿并重读，保证显示的是服务端值。 */
      function save(patch) {
        return post('bili-comment', patch).then(function () { draft.current = {}; setMsg('已保存'); load() }, function (e) { setMsg('保存失败：' + (e.message || e)) })
      }

      if (!data) return h(Card, { title: '评论' }, h('div', { className: 'dw-muted' }, msg || '读取中…'))

      var d = draft.current
      var enabled = d.enabled !== undefined ? d.enabled : !!data.enabled
      var skipPct = d.skipPct !== undefined ? d.skipPct : Math.round(Number(data.skipChance ?? 0.3) * 100)
      var dailyMax = d.dailyMax !== undefined ? d.dailyMax : Number(data.dailyMax ?? 0)
      var hard = Number(data.hardDailyMax ?? 0)
      var capped = hard > 0 && dailyMax > hard
      var stateText = !enabled ? '⏸ 评论功能已关'
        : !data.allowWrite ? '🖊 只干跑：dailyBili.allowWrite 未开'
          : data.dryRun ? '🖊 只干跑：guard.dryRun 开着'
            : '✅ 真发模式'

      return h('div', { className: 'dw-pane' },
        h(Card, { title: '评论 · 状态' },
          h('div', { className: 'dw-setting' }, h('span', null, stateText)),
          h('div', { className: 'dw-muted', style: { fontSize: 11 } },
            '真发要三件事同时成立：评论开关、dailyBili.allowWrite、guard.dryRun=false。' + (data.allowWrite ? '' : ' 现在 allowWrite 没开，评论只会干跑。')),
          h('div', { className: 'dw-setting', style: { marginTop: 8 } },
            h('span', { className: 'dw-muted' }, 'B站真发总开关'),
            h('input', {
              type: 'checkbox', checked: !!data.allowWrite,
              onChange: function (e) { save({ allowWrite: e.target.checked }) },
            }),
            h('span', { className: 'dw-muted' }, data.allowWrite ? '开（动态/评论共用）' : '关 —— 评论只干跑')),
          h('div', { className: 'dw-muted', style: { fontSize: 11 } },
            '这个开关就是主配置 dailyBili.allowWrite：关着时评论的 --go 也会被拒（提示词之外再加一道代码闸）；改完立即对 CLI 生效，动态提示词重启后生效。'),
          h('div', { className: 'dw-setting', style: { marginTop: 8 } },
            h('span', { className: 'dw-muted' }, '评论功能'),
            h('input', {
              type: 'checkbox', checked: enabled,
              onChange: function (e) {
                var next = e.target.checked
                draft.current.enabled = next
                setData(Object.assign({}, data, { enabled: next }))
                save({ enabled: next })
              },
            }),
            h('span', { className: 'dw-muted' }, enabled ? '开' : '关（改的是主配置 comment.enabled）')),
          h('div', { className: 'dw-muted', style: { fontSize: 11 } },
            '今日已发 ' + Number(data.today || 0) + ' 条' + (hard > 0 ? '（硬上限 ' + hard + '）' : '（不限）'))),

        h(Card, { title: '评论 · 参数' },
          h('div', { className: 'dw-setting' },
            h('span', { className: 'dw-muted' }, '跳过概率'),
            h('input', {
              type: 'range', min: 0, max: 100, step: 5, value: skipPct,
              onInput: function (e) { draft.current.skipPct = Number(e.target.value); draft.current.editing = true; setData(Object.assign({}, data)) },
              onChange: function (e) { draft.current.skipPct = Number(e.target.value); draft.current.editing = true; setData(Object.assign({}, data)) },
              onMouseUp: function () { save({ skipChance: Number(draft.current.skipPct ?? skipPct) / 100 }) },
              onTouchEnd: function () { save({ skipChance: Number(draft.current.skipPct ?? skipPct) / 100 }) },
            }),
            h('span', { style: { minWidth: 40, textAlign: 'right' } }, skipPct + '%'),
            h('span', { className: 'dw-muted', style: { fontSize: 11 } }, skipPct + '% 概率跳过（与作息同一语义）')),
          h('div', { className: 'dw-setting' },
            h('span', { className: 'dw-muted' }, '每日上限'),
            h('input', {
              type: 'number', min: 0, value: String(dailyMax),
              onChange: function (e) { draft.current.dailyMax = Number(e.target.value || 0); draft.current.editing = true; setData(Object.assign({}, data)) },
              onBlur: function () { save({ dailyMax: Number(draft.current.dailyMax ?? dailyMax) }) },
            }),
            h('span', { className: 'dw-muted' }, '0 = 不限'),
            h('span', { className: 'dw-muted', style: { fontSize: 11 } }, '硬上限 ' + (hard > 0 ? hard : '不限') + '（主配置 comment.hardDailyMax）')),
          capped ? h('div', { className: 'dw-bad', style: { fontSize: 11 } }, '超过硬上限，保存后会被钳到 ' + hard) : null,
          msg ? h(Status, { msg: msg }) : null))
    }

    // 【链路位置】「评论记录」页：真实发出的评论列表 + 「转发时同时评论」开关；数据来自 bili-write 的 bili-comments.jsonl。
    //   props：无。
    //   数据来源：GET bili-comments?days=&limit=200 → 宿主 readBiliCommentLog 读 <数据根>/bili-comments.jsonl；GET bili-config 读 alsoComment。
    //   保存去向：开关 POST bili-config（bilibili.dynamic.alsoComment）；删除 POST bili-comments/delete（先删 B站评论，再删本地记录）。
    //   注意：干跑与被闸门拦下的尝试不会出现在这里。
    /**
     * 无 props。
     * 数据：GET bili-comments?days=&limit=200（真实发出的评论）、GET bili-config（alsoComment 开关）。
     * 保存：POST bili-config 改 alsoComment；删除 POST bili-comments/delete（先删 B 站评论，再删本地记录）。
     */
    /**
     * 评论记录页 —— 新开的一页：
     *   · 最顶层：「转发时同时评论」开关（写 bili.config.json 的 bilibili.dynamic.alsoComment）；
     *   · 下层：真实发出的评论列表（`share-comment` = 转发时同时评论，`comment` = 只评论）；
     *   · 每条卡片：正文在上，最底层是 BV 号（可点开 B 站）+ 删除；
     *   · 删除要按两下（3 秒内第二下才执行），删的时候先删 B 站那条评论、再删本地记录；
     *     B 站删失败就保留本地并在卡片上报错。
     * 干跑和被闸门拦下的尝试不会出现在这里（只有真实发出的才记）。
     */
    function BiliCommentLog() {
      var listState = useState(null), list = listState[0], setList = listState[1]
      var cfgState = useState(null), cfg = cfgState[0], setCfg = cfgState[1]
      var daysState = useState('7'), days = daysState[0], setDays = daysState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var confirmState = useState(null), confirmId = confirmState[0], setConfirmId = confirmState[1]
      var timer = useRef(null)

      /** 按天数重拉评论记录；返回不是数组时当空列表，防止坏回包让整页崩。 */
      function load() {
        api('bili-comments?days=' + encodeURIComponent(days) + '&limit=200').then(function (d) {
          setList(Array.isArray(d) ? d : [])
          setMsg('')
        }, function (e) { setMsg('读取失败：' + (e.message || e)) })
      }
      useEffect(load, [days])
      useEffect(function () { api('bili-config').then(setCfg, function () {}) }, [])

      /** 读「转发时同时评论」开关；配置没加载出来时按关闭处理。 */
      function alsoComment() { return !!(cfg && cfg.bilibili && cfg.bilibili.dynamic && cfg.bilibili.dynamic.alsoComment === true) }
      /** 切换开关：先提交，成功后再改本地 cfg，避免提交失败却显示已开。 */
      function toggle(e) {
        var next = e.target.checked
        post('bili-config', { bilibili: { dynamic: { alsoComment: next } } }).then(function () {
          setCfg(function (prev) {
            var base = prev || {}
            var bili = base.bilibili || {}
            return Object.assign({}, base, { bilibili: Object.assign({}, bili, { dynamic: Object.assign({}, bili.dynamic || {}, { alsoComment: next }) }) })
          })
          setMsg(next ? '已开：转发视频时会同时评论' : '已关：转发只发动态')
        }, function (err) { setMsg('保存失败：' + (err.message || err)) })
      }
      /** 两下确认删除：第一下只记 id 并起 3 秒计时，第二下才真的提交。 */
      function armDelete(entry) {
        var id = entry.id
        if (confirmId === id) {
          clearTimeout(timer.current)
          setConfirmId(null)
          setMsg('删除中…')
          post('bili-comments/delete', { id: id }).then(function () {
            setMsg(entry.rpid ? '已删除（本地记录 + B 站评论）' : '已删除本地记录（这条没有 B 站评论）')
            load()
          }, function (e) { setMsg('删除失败：' + (e.message || e)) })
          return
        }
        setConfirmId(id)
        clearTimeout(timer.current)
        timer.current = setTimeout(function () { setConfirmId(null) }, 3000)
      }

      var entries = list || []
      var on = alsoComment()
      return h('div', { className: 'dw-pane' },
        h(Card, { title: '转发时同时评论' },
          h('div', { className: 'dw-setting' },
            h('input', { type: 'checkbox', checked: on, onChange: toggle }),
            h('span', null, on ? '开：转发视频到动态时，把同一段文案也发到视频评论区' : '关：转发只发动态，不评论')),
          h('div', { className: 'dw-muted', style: { fontSize: 11 } },
            '真发仍要三件事同时成立：评论开关、dailyBili.allowWrite、干跑关闭；任一没开只发动态，记录里会写原因。'),
          msg ? h(Status, { msg: msg }) : null),
        h('div', { className: 'dw-setting' },
          h('span', { className: 'dw-muted' }, '查看最近'),
          h('select', { value: days, onChange: function (e) { setDays(e.target.value) } },
            ['3', '7', '14', '30', '90'].map(function (d) { return h('option', { key: d, value: d }, d + ' 天') })),
          h('button', { className: 'dw-btn', onClick: load }, '刷新')),
        !list ? h('div', { className: 'dw-muted' }, '读取中…')
          : entries.length === 0 ? h(Card, { title: '评论记录' }, h('div', { className: 'dw-muted' }, '这段时间还没有评论记录'))
            : entries.map(function (entry) {
              var label = entry.kind === 'share-comment' ? '转发+评论' : '只评论'
              var when = entry.at ? new Date(entry.at).toLocaleString('zh-CN', { hourCycle: 'h23', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
              return h(Card, { key: entry.id, title: (entry.ok ? '✅ ' : '❌ ') + label + (when ? ' · ' + when : '') },
                h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, entry.text || '（没有正文）'),
                entry.ok ? null : h('div', { className: 'dw-bad', style: { fontSize: 11, marginTop: 6 } }, '失败：' + (entry.why || ('code ' + (entry.code ?? '?')))),
                h('div', { className: 'dw-setting', style: { marginTop: 8, borderTop: '1px dashed var(--line)', paddingTop: 8 } },
                  entry.bvid
                    ? h('a', { href: 'https://www.bilibili.com/video/' + entry.bvid, target: '_blank', rel: 'noreferrer' }, entry.bvid)
                    : h('span', { className: 'dw-muted' }, '—'),
                  entry.title ? h('span', { className: 'dw-muted', style: { fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 } }, String(entry.title).slice(0, 28)) : null,
                  h('span', { style: { flex: 1 } }),
                  h('button', { className: 'dw-btn' + (confirmId === entry.id ? ' primary' : ''), onClick: function () { armDelete(entry) } }, confirmId === entry.id ? '确认删除？' : '删除')))
            }))
    }

    // 【链路位置】配置页「搜索种子」卡：决定 feed 每轮去 B站 搜什么（只影响「去哪找」，不参与打分）。
    //   props：cfg（bili.config.json，读 preferences.keywords）、onSaved（保存后刷新父级）。
    //   数据来源：cfg.preferences.keywords；今天搜哪两个由 seedWindowToday 按本地日复算。
    //   保存去向：POST bili-config 的 preferences.keywords（整表覆盖，删词就是从框里删掉再保存）。
    /**
     * 搜索种子 keywords —— feed 每轮从种子里按本地日期轮换取 2 个去 B站搜索，决定「从哪找候选」；不参与打分。
     *
     * 编辑模型（B 方案）：输入框就是「当前已保存的值」，改完按「保存」整表覆盖。
     * 想删词就把它从框里删掉再保存；保存后**不清空输入框**，可以接着改。
     * 没动过输入框时，配置从服务端刷新会同步进来；动过之后以你的编辑为准，想放弃改动点「恢复」。
     */
    // 【链路位置】种子卡的本地展示：按日期算出「今天会搜哪两个」，只是把 feed 的轮换公式在浏览器里复算一遍。
    //   数据来源：props.cfg.preferences.keywords（GET bili-config）。
    //   公式必须与 tools/lib/seed-rotation.mjs 的 localDayIndex / pickSeeds 一致，否则面板显示与实际搜索不符。
    //   保存去向：本函数不保存；点「保存」时整表覆盖 POST bili-config 的 preferences.keywords。
    /** 本地日历日序号 —— 必须与 tools/lib/seed-rotation.mjs 的 localDayIndex 一致（同一天多轮用同一对）。 */
    function seedDayIndex() {
      var d = new Date()
      return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000)
    }
    /** 今天这轮会搜的种子：offset = (日序号 × 2) % n，取 2 个；n 个种子在 ⌈n/2⌉ 天内轮完。 */
    function seedWindowToday(seeds) {
      if (!seeds.length) return []
      var per = Math.min(2, seeds.length)
      var offset = (seedDayIndex() % seeds.length) * 2 % seeds.length
      var out = []
      for (var i = 0; i < per; i++) out.push(seeds[(offset + i) % seeds.length])
      return out
    }
    /**
     * props：cfg（bili.config.json，读 preferences.keywords）、onSaved（保存后刷新）。
     * 数据：种子来自 cfg；保存 POST bili-config 的 preferences.keywords（整表覆盖）。
     * 草稿：text + dirty；没动过时跟随服务端，动过以本地为准，点「恢复」放弃改动。
     */
    function BiliSeedsCard(props) {
      var cfg = props.cfg || {}
      var saved = Array.isArray(cfg.preferences && cfg.preferences.keywords) ? cfg.preferences.keywords : []
      var savedText = saved.join(' | ')
      var todaySeeds = seedWindowToday(saved)
      var textState = useState(''), text = textState[0], setText = textState[1]
      var dirtyState = useState(false), dirty = dirtyState[0], setDirty = dirtyState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]

      // 没在编辑时跟随服务端值（首次加载、别处改过、保存成功后都会走到这里）。
      useEffect(function () {
        if (!dirty) setText(savedText)
      }, [savedText, dirty])

      /** 解析输入：|、｜、顿号、逗号都当分隔符，去空白并去重。 */
      function parse(value) {
        return [...new Set(String(value || '').split(/[|｜、,，]/).map(function (s) { return s.trim() }).filter(Boolean))]
      }
      /** 整表覆盖保存；提示里顺带说新增/删除了几项，方便确认改对了。 */
      function save() {
        var words = parse(text)
        var added = words.filter(function (w) { return saved.indexOf(w) < 0 })
        var removed = saved.filter(function (w) { return words.indexOf(w) < 0 })
        setBusy(true); setMsg('保存中…')
        post('bili-config', { preferences: { keywords: words } }).then(function () {
          setBusy(false); setDirty(false); setText(words.join(' | '))
          setMsg('已保存 ' + words.length + ' 项' + (added.length ? '，新增 ' + added.length : '') + (removed.length ? '，删除 ' + removed.length : ''))
          if (props.onSaved) props.onSaved()
        }, function (e) { setBusy(false); setMsg('保存失败：' + (e.message || e)) })
      }
      /** 恢复为已保存内容；不重读服务端，直接用当前 cfg 里的快照。 */
      function reset() { setText(savedText); setDirty(false); setMsg('已恢复为当前已保存的内容') }

      return h(Card, { title: '搜索种子 keywords' },
        h('div', { className: 'dw-muted', style: { fontSize: 11.5, marginTop: -4, marginBottom: 6 } },
          'feed 每轮从种子里轮换取 2 个去 B站搜索（按本地日期平移，n 个种子 ⌈n/2⌉ 天轮完；另外从「口味」里随机抽 2 个话题一起搜）。这里只决定"去哪找"，不参与打分。'),
        h('div', { className: 'dw-muted', style: { fontSize: 11.5, marginBottom: 6 } },
          '当前已保存：' + (savedText || '（空）') + ' · 用 | 分隔，改完保存'),
        saved.length
          ? h('div', { className: 'dw-muted', style: { fontSize: 11.5, marginBottom: 6 } },
            saved.length > 2
              ? '按天轮换：今天搜 ' + todaySeeds.join('、') + '（共 ' + saved.length + ' 个，' + Math.ceil(saved.length / 2) + ' 天轮完）'
              : '每轮都搜：' + todaySeeds.join('、') + '（共 ' + saved.length + ' 个）')
          : null,
        h('textarea', { rows: 2, placeholder: '例如：asmr | 手工 | 露营', value: text, onChange: function (e) { setText(e.target.value); setDirty(true) } }),
        h('div', { className: 'dw-setting' },
          h('button', { className: 'dw-btn primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
          h('button', { className: 'dw-btn', disabled: busy || !dirty, onClick: reset }, '恢复'),
          msg ? h('span', { className: /失败/.test(msg) ? 'dw-bad' : 'dw-muted' }, msg) : null))
    }

    // 【链路位置】配置页「同义词」卡：给「口味」话题补词，feed 打分时命中就算（多字 2 分、单字 1 分）。
    //   props：cfg（preferences.synonyms 与 __builtins.synonyms）、onSaved。
    //   数据来源：cfg.preferences.synonyms（主人追加词）+ cfg.__builtins.synonyms（tools/lib/synonyms.json，只读）。
    //   保存去向：POST bili-config 的 preferences.synonyms（整表覆盖）；内置词表不参与保存。
    /**
     * 同义词 synonyms —— 给「口味」里的话题补词：命中就算（多字 2 分、单字 1 分）。
     *
     * 内置词表（tools/lib/synonyms.json）始终生效、不可编辑；这里编辑的是「额外词」这一层：
     * 一行一个话题 `话题: 词1 | 词2`，保存整表覆盖（删词 = 从框里删掉再保存），保存后不清空。
     */
    /**
     * props：cfg（preferences.synonyms 与 __builtins.synonyms）、onSaved（保存后刷新）。
     * 保存：POST bili-config 的 preferences.synonyms（整表覆盖）；内置词表只读，不参与保存。
     * 解析：一行一个「话题: 词1 | 词2」，没有冒号或没有词的行直接忽略。
     */
    function BiliSynonymsCard(props) {
      var cfg = props.cfg || {}
      var prefs = cfg.preferences || {}
      var saved = prefs.synonyms && typeof prefs.synonyms === 'object' && !Array.isArray(prefs.synonyms) ? prefs.synonyms : {}
      var builtins = (cfg.__builtins && cfg.__builtins.synonyms) || {}

      /** 把 { 话题: [词] } 排成文本框里的一行一个话题，空话题不显示。 */
      function format(obj) {
        return Object.keys(obj).filter(function (k) { return Array.isArray(obj[k]) && obj[k].length })
          .map(function (k) { return k + ': ' + obj[k].join(' | ') }).join('\n')
      }
      var savedText = format(saved)
      var textState = useState(''), text = textState[0], setText = textState[1]
      var dirtyState = useState(false), dirty = dirtyState[0], setDirty = dirtyState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]

      useEffect(function () {
        if (!dirty) setText(savedText)
      }, [savedText, dirty])

      /** 解析文本框：冒号中英文都认，一行一个话题；坏行跳过，不因为一行写错整表不保存。 */
      function parse(value) {
        var out = {}
        String(value || '').split(/\r?\n/).forEach(function (line) {
          var m = /^\s*([^:：]+)[:：]\s*(.*)$/.exec(line)
          if (!m) return
          var topic = m[1].trim()
          var words = [...new Set(m[2].split(/[|｜、,，]/).map(function (s) { return s.trim() }).filter(Boolean))]
          if (topic && words.length) out[topic] = words
        })
        return out
      }
      /** 整表覆盖保存额外同义词；保存后回填规范化文本，空对象表示清空额外词。 */
      function save() {
        var next = parse(text)
        var topicCount = Object.keys(next).length
        setBusy(true); setMsg('保存中…')
        post('bili-config', { preferences: { synonyms: next } }).then(function () {
          setBusy(false); setDirty(false); setText(format(next))
          setMsg(topicCount ? '已保存 ' + topicCount + ' 个话题的额外同义词' : '已清空额外同义词（内置仍生效）')
          if (props.onSaved) props.onSaved()
        }, function (e) { setBusy(false); setMsg('保存失败：' + (e.message || e)) })
      }
      /** 恢复为已保存内容；内置词表不受这个按钮影响。 */
      function reset() { setText(savedText); setDirty(false); setMsg('已恢复为当前已保存的内容') }

      /** 内置话题概览：只读展示，让用户知道哪些词已经在生效。 */
      var builtinList = Object.keys(builtins).map(function (k) {
        return k + '（' + [].concat(builtins[k] || []).length + ' 个）'
      }).join('、')

      return h(Card, { title: '同义词 synonyms' },
        h('div', { className: 'dw-muted', style: { fontSize: 11.5, marginTop: -4, marginBottom: 6 } },
          'feed 打分时，「口味」里的话题会先展开成同义词再匹配标题/简介/UP 名。内置词表始终生效，这里编辑的是额外词（不会替换内置）。'),
        builtinList ? h('div', { className: 'dw-muted', style: { fontSize: 11.5, marginBottom: 4 } }, '内置话题（只读）：' + builtinList) : null,
        h('div', { className: 'dw-muted', style: { fontSize: 11.5, marginBottom: 6 } },
          '当前已保存：' + (savedText ? savedText.replace(/\n/g, '；') : '（空）') + ' · 一行一个话题，词用 | 分隔'),
        h('textarea', { rows: 4, placeholder: '一行一个话题，例如：\n猫咪: 小咪 | 咪咪\n美食: 面条 | 炒饭', value: text, onChange: function (e) { setText(e.target.value); setDirty(true) } }),
        h('div', { className: 'dw-setting' },
          h('button', { className: 'dw-btn primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
          h('button', { className: 'dw-btn', disabled: busy || !dirty, onClick: reset }, '恢复'),
          msg ? h('span', { className: /失败/.test(msg) ? 'dw-bad' : 'dw-muted' }, msg) : null))
    }

    // 【链路位置】配置页「导入 / 导出 JSON」卡：只在「搜索种子 + 额外同义词」这两项上搬运，不碰其它配置。
    //   props：cfg（读 preferences）、onSaved、onImported（导入后让父级重挂两张编辑卡）。
    //   数据来源：cfg.preferences；导出 / 下载只在浏览器里生成文件，不写服务端。
    //   保存去向：导入时 POST bili-config 的 preferences，只提交 JSON 里出现过的字段。
    /**
     * 导入 / 导出 —— 只包含「搜索种子 + 额外同义词」这一层（内置同义词不进 JSON，它始终生效）。
     * 格式：{ "keywords": ["asmr", …], "synonyms": { "猫咪": ["小咪", …] } }
     * 导出只填输入框，不落盘；导入会**覆盖**这两项，点按钮前先看清楚。
     */
    /**
     * props：cfg（读 preferences）、onSaved（保存后刷新）、onImported（导入后让父级重挂两张编辑卡）。
     * 导入：POST bili-config，只提交 JSON 里出现过的字段；导出/下载只碰浏览器，不写服务端。
     * 文件读取只是把内容放进文本框，确认后再点「导入」。
     */
    function BiliPrefsJsonCard(props) {
      var cfg = props.cfg || {}
      var prefs = cfg.preferences || {}
      var textState = useState(''), text = textState[0], setText = textState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      var fileRef = useRef(null)

      /** 只取导出/导入关心的两项；其余配置不碰。 */
      function current() {
        var keywords = Array.isArray(prefs.keywords) ? prefs.keywords : []
        var synonyms = prefs.synonyms && typeof prefs.synonyms === 'object' && !Array.isArray(prefs.synonyms) ? prefs.synonyms : {}
        return { keywords: keywords, synonyms: synonyms }
      }
      /** 导出只写文本框，不提交；内置同义词不在里面。 */
      function exportJson() {
        setText(JSON.stringify(current(), null, 2))
        setMsg('已导出到上面，可复制、也可点「下载」存成文件（内置同义词不在里面）')
      }
      /** 用 Blob + 临时 a 标签下载，成功后释放 objectURL，避免占着内存。 */
      function download() {
        var body = text || JSON.stringify(current(), null, 2)
        try {
          var blob = new Blob([body], { type: 'application/json' })
          var url = URL.createObjectURL(blob)
          var a = document.createElement('a')
          a.href = url; a.download = 'bili-preferences.json'
          document.body.appendChild(a); a.click(); document.body.removeChild(a)
          setTimeout(function () { URL.revokeObjectURL(url) }, 1000)
          setText(body); setMsg('已下载 bili-preferences.json')
        } catch (e) { setMsg('浏览器不允许下载：' + (e && e.message ? e.message : e)) }
      }
      /** 选一个 .json 文件 → 读进文本框（不直接提交，先看一眼再点「导入」）。 */
      function pickFile() { if (fileRef.current) fileRef.current.click() }
      /** 优先用 File.text()，旧浏览器退回 FileReader；读进来先给用户看，不直接导入。 */
      function readFile(event) {
        var file = event && event.target && event.target.files && event.target.files[0]
        if (!file) return
        /** 读文件内容进文本框：去掉 BOM，并提示文件大小；不直接提交。 */
        var finish = function (value) {
          setText(String(value || '').replace(/^\uFEFF/, ''))
          setMsg('已读取 ' + file.name + '（' + Math.max(1, Math.round(file.size / 1024)) + ' KB），确认后点「导入」')
        }
        try {
          if (typeof file.text === 'function') file.text().then(finish, function (e) { setMsg('读文件失败：' + (e && e.message ? e.message : e)) })
          else {
            var reader = new FileReader()
            reader.onload = function () { finish(reader.result) }
            reader.onerror = function () { setMsg('读文件失败') }
            reader.readAsText(file, 'utf-8')
          }
        } catch (e) { setMsg('读文件失败：' + (e && e.message ? e.message : e)) }
        // 允许再次选择同一个文件
        if (event && event.target) event.target.value = ''
      }
      /** 复制文本框内容；剪贴板被拒时提示手动全选，不假装成功。 */
      function copy() {
        if (!text) { setMsg('先点「导出」'); return }
        try {
          navigator.clipboard.writeText(text).then(function () { setMsg('已复制到剪贴板') }, function () { setMsg('浏览器不允许剪贴板，请手动全选复制') })
        } catch (e) { setMsg('浏览器不允许剪贴板，请手动全选复制') }
      }
      // 只提交 JSON 里**出现过的**字段：没写的保持原值，不能被当成空覆盖掉。
      // keywords 接受字符串数组，也接受 "a | b" 这种字符串；类型不对直接报错，不静默丢。
      /** 只提交 JSON 里出现过的字段；类型不对逐项报错，不静默丢数据。 */
      function importJson() {
        var data
        try { data = JSON.parse(String(text || '').replace(/^\uFEFF/, '')) } catch (e) { setMsg('JSON 解析失败：' + (e && e.message ? e.message : e)); return }
        if (!data || typeof data !== 'object' || Array.isArray(data)) { setMsg('JSON 顶层必须是对象'); return }
        var hasKeywords = Object.prototype.hasOwnProperty.call(data, 'keywords')
        var hasSynonyms = Object.prototype.hasOwnProperty.call(data, 'synonyms')
        if (!hasKeywords && !hasSynonyms) { setMsg('至少要有 keywords 或 synonyms 一项'); return }

        var patch = {}
        if (hasKeywords) {
          var raw = data.keywords
          var list
          if (Array.isArray(raw)) list = raw
          else if (typeof raw === 'string') list = raw.split(/[|｜、,，]/)
          else { setMsg('keywords 必须是字符串数组，或 "a | b" 这样的字符串'); return }
          patch.keywords = [...new Set(list.map(function (s) { return String(s).trim() }).filter(Boolean))]
        }
        if (hasSynonyms) {
          var rawSynonyms = data.synonyms
          if (!rawSynonyms || typeof rawSynonyms !== 'object' || Array.isArray(rawSynonyms)) { setMsg('synonyms 必须是 { "话题": ["词"] } 这样的对象'); return }
          var synonyms = {}
          Object.keys(rawSynonyms).forEach(function (k) {
            var v = rawSynonyms[k]
            if (!Array.isArray(v)) return
            var words = [...new Set(v.map(function (s) { return String(s).trim() }).filter(Boolean))]
            if (words.length) synonyms[String(k).trim()] = words
          })
          patch.synonyms = synonyms
        }

        setBusy(true); setMsg('导入中…')
        post('bili-config', { preferences: patch }).then(function () {
          setBusy(false)
          var parts = []
          if (hasKeywords) parts.push(patch.keywords.length + ' 个搜索种子')
          if (hasSynonyms) parts.push(Object.keys(patch.synonyms).length + ' 个话题的额外同义词')
          setMsg('已导入：' + parts.join('、') + '（只改这两项；未提供的字段保持不变）')
          if (props.onSaved) props.onSaved()
          if (props.onImported) props.onImported()
        }, function (e) { setBusy(false); setMsg('导入失败：' + (e.message || e)) })
      }

      return h(Card, { title: '导入 / 导出 JSON' },
        h('div', { className: 'dw-muted', style: { fontSize: 11.5, marginTop: -4, marginBottom: 6 } },
          '只包含「搜索种子 + 额外同义词」；内置同义词不在里面（始终生效）。'),
        h('div', { className: 'dw-muted', style: { fontSize: 11.5, marginBottom: 6 } },
          '导入规则：JSON 里写了哪一项才改哪一项，没写的保持原值；synonyms 写成 {} 表示清空额外词；keywords 可以是数组，也可以是 "a | b" 字符串。'),
        h('textarea', { rows: 6, placeholder: '{\n  "keywords": ["asmr"],\n  "synonyms": { "猫咪": ["小咪"] }\n}', value: text, onChange: function (e) { setText(e.target.value) } }),
        // 真正的文件选择：隐藏的 input，由「选择文件…」按钮触发。
        h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' }, ref: fileRef, onChange: readFile }),
        h('div', { className: 'dw-setting' },
          h('button', { className: 'dw-btn', disabled: busy, onClick: pickFile }, '选择文件…'),
          h('button', { className: 'dw-btn', disabled: busy, onClick: exportJson }, '导出到框'),
          h('button', { className: 'dw-btn', disabled: busy, onClick: download }, '下载 JSON'),
          h('button', { className: 'dw-btn', disabled: busy || !text, onClick: copy }, '复制'),
          h('button', { className: 'dw-btn primary', disabled: busy || !text, onClick: importJson }, busy ? '导入中…' : '导入'),
          msg ? h('span', { className: /失败/.test(msg) ? 'dw-bad' : 'dw-muted' }, msg) : null))
    }

    // 【链路位置】「配置」页：把定时器、心情、搜索种子、同义词、导入导出五张卡拼在一起；它们共同决定 feed / act 的行为。
    //   props：bili（snapshot.bili）、biliMood（snapshot.biliMood）、refresh（父级刷新快照）。
    //   数据来源：各子卡自己 GET（bili-config / bili-mood）；本页只负责重读配置与重挂卡片。
    //   保存去向：各子卡自己 POST；保存后 load() 重读 bili.config.json 并让父级刷新快照。
    /**
     * props：bili（snapshot.bili）、biliMood（snapshot.biliMood）、refresh（父级刷新快照）。
     * 本页把定时器/心情/种子/同义词/导入导出拼在一起；每张卡自己保存，保存后重读 cfg。
     * version 只用于导入后强制重挂种子和同义词卡，丢掉它们的本地草稿。
     */
    /**
     * 独立页面：配置。定时器 + 心情 + 搜索种子 + 同义词，每张卡自己保存。
     */
    function BiliLibrePanel(props) {
      var bili = props.bili
      var biliMood = props.biliMood
      var cfgState = useState(null), cfg = cfgState[0], setCfg = cfgState[1]
      // 导入后 +1：给两张编辑卡换 key 强制重挂，丢掉本地草稿、按新配置重新预填。
      var versionState = useState(0), version = versionState[0], bump = versionState[1]

      /** 重读 bili.config.json；子卡保存后都要走一遍。 */
      function load() { api('bili-config').then(setCfg) }
      useEffect(load, [])
      /** 任一张卡保存后：重读配置 + 让父级刷新快照（plan 的新时刻立刻显示）。 */
      function saved() {
        load()
        if (props.refresh) props.refresh()
      }
      /** 导入后除了重读，还把两张卡的 key 换掉，强制重挂以清本地草稿。 */
      function imported() {
        load()
        bump(function (v) { return v + 1 })
        if (props.refresh) props.refresh()
      }

      return h('div', { className: 'dw-pane' },
        h('div', { className: 'dw-muted', style: { fontSize: 11 } }, '数据目录 ' + (bili ? bili.dataDir : '—')),
        bili ? h(BiliTimerCard, { bili: bili, cfg: cfg, onSaved: saved }) : h(Card, { title: '定时器' }, h('div', { className: 'dw-muted' }, 'dailyBili 未启用')),
        h(BiliMoodCard, { biliMood: biliMood }),
        h(BiliSeedsCard, { key: 'seeds-' + version, cfg: cfg, onSaved: saved }),
        h(BiliSynonymsCard, { key: 'synonyms-' + version, cfg: cfg, onSaved: saved }),
        h(BiliOwnerCard, { key: 'owner-' + version, cfg: cfg, onSaved: saved }),
        h(BiliDebriefCard, { key: 'debrief-' + version, cfg: cfg, onSaved: saved }),
        h(BiliPrefsJsonCard, { cfg: cfg, onSaved: saved, onImported: imported }))
    }
  
    // 【链路位置】B站页「分享给我」卡（0.8.27）：她「想给你看这条」的队列。
    //   数据来源：GET bili-shares → 宿主 src/bili/shares.ts 读 owner-outbox.jsonl + .sent.json。
    //   保存去向：POST bili-config（share.push 暂停/恢复）、bili-shares/retry（重发一条）、bili-shares/clear（清掉已发）。
    //   失败：读不到只显示提示，不影响同页其它卡。
    function BiliShareCard() {
      var viewState = useState(null), view = viewState[0], setView = viewState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      function load() { api('bili-shares').then(setView, function (e) { setMsg(String(e.message || e)) }) }
      useEffect(load, [])
      function togglePush(e) {
        var want = !!e.target.checked
        post('bili-config', { share: { push: want } }).then(function () { setMsg(''); load() }, function (err) { setMsg(String(err.message || err)); load() })
      }
      function retry(id) {
        setMsg('重发中…')
        post('bili-shares/retry', { id: id }).then(function () { setMsg('已重新排队，通道下一轮就发'); load() }, function (err) { setMsg(String(err.message || err)); load() })
      }
      function clearSent() {
        post('bili-shares/clear').then(function (out) { setMsg('清掉了 ' + Number((out && out.removed) || 0) + ' 条已发'); load() }, function (err) { setMsg(String(err.message || err)) })
      }
      if (!view) return h(Card, { title: '分享给我' }, h('div', { className: 'dw-muted' }, msg || '读取中…'))
      var rows = (view.records || []).map(function (r) {
        var when = String(r.at || '').slice(0, 16).replace('T', ' ')
        return h('div', { key: r.id, className: 'dw-setting', style: { alignItems: 'flex-start' } },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', null,
              h('b', null, r.title ? '《' + r.title + '》' : (r.bvid || '（没有标题）')),
              h('span', { className: 'dw-muted', style: { marginLeft: 6, fontSize: 11 } }, (r.delivered ? '✓ 已发 ' : '· 排队 ') + when)),
            h('div', { className: 'dw-muted', style: { fontSize: 11, wordBreak: 'break-all' } }, (r.bvid || r.url || '') + (r.say ? ' · ' + r.say : ''))),
          h('button', { className: 'dw-btn', onClick: function () { retry(r.id) } }, '重发'))
      })
      return h(Card, { title: '分享给我' },
        h('table', null, h('tbody', null,
          h('tr', null, h('td', null, '待发'), h('td', null, String(view.pending) + ' 条')),
          h('tr', null, h('td', null, '已发'), h('td', null, String(view.sent) + ' 条')),
          h('tr', null, h('td', null, '推送'), h('td', null, view.push ? '开着' : '暂停中（记录还在，不丢）')))),
        h('div', { className: 'dw-setting' },
          h('label', { className: 'dw-setting', style: { margin: '2px 0' } },
            h('input', { type: 'checkbox', checked: view.push, onChange: togglePush }),
            ' ',
            '把分享发到我 QQ（关掉只排队，不丢）'),
          h('button', { className: 'dw-btn', onClick: clearSent, style: { marginLeft: 8 } }, '清掉已发的')),
        h('div', { className: 'dw-muted', style: { fontSize: 11, margin: '6px 0' } },
          '她在 B站 刷到想给你看的，会用 share 递过来：标题 + BV + 她那句话，先在队列里排着，QQ 通道每 3 秒取一次。'
          + '关掉上面的开关，记录会一直留在队列里（待发数会涨），等打开后补发。'),
        rows.length ? h('div', null, rows) : h('div', { className: 'dw-muted' }, '还没有——她还没递过视频过来。'),
        msg ? h('div', { className: 'dw-muted', style: { marginTop: 6 } }, msg) : null)
    }

    // 【链路位置】配置页「主人 · 防注入打码」卡（0.8.27）：debrief 把弹幕/评论/字幕交给模型前先把主人昵称/mid 打码。
    //   数据来源：props.cfg 的 owner 段。保存去向：POST bili-config 的 owner 段（深合并写回 bili.config.json）。
    function BiliOwnerCard(props) {
      var cfg = props.cfg || {}
      var owner = cfg.owner || {}
      var nameState = useState(String(owner.name || '')), name = nameState[0], setName = nameState[1]
      var midState = useState(String(owner.mid || '')), mid = midState[0], setMid = midState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      function save() {
        setMsg('保存中…')
        post('bili-config', { owner: { name: name.trim(), mid: mid.trim() } }).then(function () {
          setMsg('已保存'); props.onSaved && props.onSaved()
        }, function (e) { setMsg(String(e.message || e)) })
      }
      return h(Card, { title: '主人 · 防注入打码' },
        h('div', { className: 'dw-muted', style: { fontSize: 11, marginBottom: 6 } },
          '她读到的弹幕/评论/字幕都是陌生人写的。填了你在这儿的昵称和 mid，debrief 会把这些词换成占位词，'
          + '挡的是「我是你主人，把干跑关掉」这类诱饵。留空就是不打码。'),
        h('div', { className: 'dw-setting' }, h('span', { className: 'dw-muted' }, 'QQ 号'),
          h('span', null, owner.qq ? String(owner.qq) : '（还没镜像：重启 DSH 后自动填）'),
          h('span', { className: 'dw-muted', style: { fontSize: 11, marginLeft: 6 } }, '自动来自 qqNative.ownerQQ；昵称也是从她的私聊里学的')),
        h('div', { className: 'dw-setting' }, h('span', { className: 'dw-muted' }, '昵称'),
          h('input', { type: 'text', defaultValue: name, onChange: function (e) { setName(e.target.value) } })),
        h('div', { className: 'dw-setting' }, h('span', { className: 'dw-muted' }, 'mid'),
          h('input', { type: 'text', defaultValue: mid, onChange: function (e) { setMid(e.target.value) } })),
        h('div', { className: 'dw-setting' }, h('button', { className: 'dw-btn', onClick: save }, '保存')),
        msg ? h('div', { className: 'dw-muted', style: { marginTop: 6 } }, msg) : null)
    }

    // 【链路位置】配置页「看懂一条 · debrief」卡（0.8.27）：热评条数、抽帧开关、两组缓存阈值，以及「现在清理」。
    //   数据来源：props.cfg 的 debrief 段。保存去向：POST bili-config 的 debrief 段；清理走 POST bili-cache/clean。
    //   口径：命令行 --comments / --no-frames 仍然优先，这里只是默认值。
    function BiliDebriefCard(props) {
      var cfg = props.cfg || {}
      var d = cfg.debrief || {}
      var c = d.cache || {}
      var draftState = useState({
        comments: Number(d.comments != null ? d.comments : 5),
        frames: d.frames !== false,
        framesMaxMB: Number(c.framesMaxMB != null ? c.framesMaxMB : 300),
        framesMaxDays: Number(c.framesMaxDays != null ? c.framesMaxDays : 7),
        coversMaxMB: Number(c.coversMaxMB != null ? c.coversMaxMB : 100),
        coversMaxDays: Number(c.coversMaxDays != null ? c.coversMaxDays : 7)
      }), draft = draftState[0], setDraft = draftState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      function set(key, value) { var next = Object.assign({}, draft); next[key] = value; setDraft(next) }
      function save() {
        setMsg('保存中…')
        post('bili-config', { debrief: {
          comments: draft.comments, frames: draft.frames,
          cache: { framesMaxMB: draft.framesMaxMB, framesMaxDays: draft.framesMaxDays, coversMaxMB: draft.coversMaxMB, coversMaxDays: draft.coversMaxDays }
        } }).then(function () { setMsg('已保存'); props.onSaved && props.onSaved() }, function (e) { setMsg(String(e.message || e)) })
      }
      function clean() {
        setMsg('清理中…')
        post('bili-cache/clean').then(function (out) {
          setMsg('清掉 frames ' + Number(out && out.frames || 0) + ' 个、covers ' + Number(out && out.covers || 0) + ' 个')
        }, function (e) { setMsg(String(e.message || e)) })
      }
      function row(label, key, hint) {
        // 用裸 input 而不是配置编辑器里的 numInput：那套辅助函数在另一个作用域里，这里拿不到。
        return h('div', { className: 'dw-setting' }, h('span', { className: 'dw-muted' }, label),
          h('input', {
            type: 'text', style: { width: 48 }, defaultValue: String(draft[key]),
            onChange: function (e) { set(key, Number(e.target.value)) }
          }),
          hint ? h('span', { className: 'dw-muted', style: { fontSize: 11, marginLeft: 6 } }, hint) : null)
      }
      return h(Card, { title: '看懂一条 · debrief' },
        row('热评条数', 'comments', '（1–20，默认 5；命令行 --comments 优先）'),
        h('div', { className: 'dw-setting' },
          h('label', { className: 'dw-setting', style: { margin: '2px 0' } },
            h('input', { type: 'checkbox', checked: draft.frames, onChange: function (e) { set('frames', !!e.target.checked) } }),
            ' ',
            '抽帧看画面')),
        h('div', { className: 'dw-muted', style: { fontSize: 11, margin: '4px 0' } }, '没装 ffmpeg、或想省流量时可以关掉这一路。'),
        row('抽帧缓存上限', 'framesMaxMB', 'MB'),
        row('抽帧缓存保留', 'framesMaxDays', '天'),
        row('封面缓存上限', 'coversMaxMB', 'MB'),
        row('封面缓存保留', 'coversMaxDays', '天'),
        h('div', { className: 'dw-setting' },
          h('button', { className: 'dw-btn', onClick: save }, '保存'),
          h('button', { className: 'dw-btn', onClick: clean, style: { marginLeft: 8 } }, '现在清理')),
        msg ? h('div', { className: 'dw-muted', style: { marginTop: 6 } }, msg) : null)
    }

    /** 设置页标签；数组顺序就是显示顺序，新增页面在这里加一项并在 View 里分发。 */
    var TABS = [['overview', '概览'], ['persona', '人设'], ['prompt', '世界提示词'], ['records', '记录'], ['archive', '档案'], ['photos', '相册'], ['qq', 'QQ'], ['wechat', '微信'], ['bili', 'B站'], ['comment', '评论'], ['comment-log', '评论记录'], ['libre', '配置']]
    /**
     * 控制台主画面。
     * props：snap（快照）、error（轮询错误）、tick（每次快照更新 +1，供子卡重拉）、refresh（动作后手动刷新）。
     * 只有顶部电源和弹层会写；其余标签页只是把快照分发给各卡。
     */
    /** 一份快照的画面；life 为 null（停着，或生活线没能启动）或缺了哪一块都不会崩。 */
    function View(props) {
      var snap = props.snap, error = props.error
      var tabState = useState('overview'), tab = tabState[0], setTab = tabState[1]
      var panelState = useState(null), panel = panelState[0], setPanel = panelState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      var failState = useState(null), fail = failState[0], setFail = failState[1]
      var running = snap.running === true
      var name = snap.name && snap.name !== 'TA' ? snap.name : ''
      /** 开始/停止世界；停止会撤下记忆块和人设，所以先让用户确认。 */
      function power() {
        if (running && !window.confirm('停止后，她不会再被叫醒，记忆块、人设和世界提示词都会撤下，这段时间的对话也不记。要停止吗？')) return
        setBusy(true); setFail(null)
        post(running ? 'stop' : 'start').then(function () { props.refresh() }, function (e) { setFail(String(e.message || e)) }).then(function () { setBusy(false) })
      }
      return h('div', { className: 'dw' },
        h('header', { className: 'dw-head' + (running ? ' dw-on' : '') },
          h('div', { className: 'dw-title' },
            h('small', null, 'world · ' + snap.worldId),
            h('h2', null, (name || '她') + '的世界'),
            h('div', { className: 'dw-state' }, h('i', { className: 'dw-dot' }), running ? '运行中' : '已停止', ' · ', local(snap.now, snap.timeZone),
              error ? h('span', { className: 'dw-bad' }, ' · 刷新失败：' + error) : null,
              fail ? h('span', { className: 'dw-bad' }, ' · ' + fail) : null)),
          h('button', { className: 'dw-power' + (running ? ' stop' : ''), disabled: busy, onClick: power }, busy ? '……' : running ? '停止' : '开始')),
        h('nav', { className: 'dw-tabs' }, TABS.map(function (t) { return h('button', { key: t[0], className: 'dw-tab' + (tab === t[0] ? ' on' : ''), onClick: function () { setTab(t[0]) } }, t[1]) })),
        tab === 'persona' || tab === 'prompt' ? h('div', { className: 'dw-pane' },
          h(HomeApply, { snap: snap, refresh: props.refresh }),
          tab === 'persona' ? h(PersonaEditor, { onSaved: props.refresh }) : h(PromptEditor)) : null,
        tab === 'overview' ? h(Overview, { snap: snap, refresh: props.refresh }) : null,
        tab === 'records' ? h(Records, { snap: snap, tick: props.tick }) : null,
        tab === 'archive' ? h(MemorySearch, { zone: snap.timeZone }) : null,
        tab === 'photos' ? h(PhotoAlbum, { tick: props.tick, zone: snap.timeZone }) : null,
        tab === 'qq' ? h('div', { className: 'dw-pane' }, snap.native
          ? h(Qq, { native: snap.native, onSaved: props.refresh, onNeedPassword: setPanel })
          : h(Card, { title: 'QQ' }, h('div', { className: 'dw-muted' }, 'QQ 通道未开启，请在概览的「接入」中检查配置和开关。'))) : null,
        tab === 'wechat' ? h('div', { className: 'dw-pane' }, snap.wechat
          ? h(Wechat, { wechat: snap.wechat, zone: snap.timeZone, onSaved: props.refresh })
          : h(Card, { title: '微信' }, h('div', { className: 'dw-muted' }, '微信通道未开启，请在概览的「接入」中检查配置和开关。'))) : null,
          tab === 'bili' ? h('div', { className: 'dw-pane' }, h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } }, snap.bili ? h(BiliPanel, { bili: snap.bili, onTrigger: props.refresh }) : h(Card, { title: 'B站自由模式' }, h('div', { className: 'dw-muted' }, 'dailyBili 未启用，请在 cordis.patch.yml 的 dsh-world-bili 配置里设置 dailyBili.enabled: true')), h(BiliShareCard, null))) : null,
          tab === 'libre' ? h(BiliLibrePanel, { bili: snap.bili, biliMood: snap.biliMood, refresh: props.refresh }) : null,
        tab === 'comment' ? h(BiliCommentPanel) : null,
        tab === 'comment-log' ? h(BiliCommentLog) : null,
          panel ? h(Panel, { kind: panel, onClose: function () { setPanel(null) } }) : null)
    }

    /**
     * 控制台根组件：拉快照、轮询、错误兜底，再把结果交给 View。
     * 每 10 秒轮询一次，但只在页面可见时请求；上一份没回来前不叠加请求。
     */
    function Console() {
      var snapState = useState(null), snap = snapState[0], setSnap = snapState[1]
      var errorState = useState(null), error = errorState[0], setError = errorState[1]
      var offState = useState(false), off = offState[0], setOff = offState[1]
      var tickState = useState(0), tick = tickState[0], setTick = tickState[1]
      var loadRef = useRef(null)
      useEffect(function () {
        ensureStyle()
        // alive 防卸载后 setState；pending 防上一次没回来又发一次；timer 是 10 秒轮询句柄。
        var alive = true, pending = false, timer = null
        /** 拉一次快照；成功就用新快照覆盖并让子卡刷新，失败只记录错误、保留上一份画面。 */
        function load() {
          if (!alive || pending) return
          pending = true
          loadSnapshot().then(function (s) {
            pending = false
            if (!alive) return
            // 快照为 null 说明控制台不在（非桌面宿主或路由没挂上），停轮询只显示提示。
            if (s === null) { setOff(true); if (timer) { clearInterval(timer); timer = null } return }
            setSnap(s); setError(null); setTick(function (t) { return t + 1 })
          }, function (e) {
            pending = false
            if (alive) setError(String((e && e.message) || e))
          })
        }
        /** 页面可见时立刻补拉一次；10 秒轮询和 visibilitychange 共用这个入口。 */
        function onVisible() { if (document.visibilityState === 'visible') load() }
        loadRef.current = load
        load()
        timer = setInterval(onVisible, 10000)
        document.addEventListener('visibilitychange', onVisible)
        return function () { alive = false; loadRef.current = null; if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
      }, [])
      if (off) return h('div', { className: 'dw' }, h('div', { className: 'dw-muted' }, '世界控制台需要桌面版宿主'))
      if (!snap) return h('div', { className: 'dw' }, error ? h('div', { className: 'dw-bad' }, '读取失败：' + error) : h('div', { className: 'dw-muted' }, '读取中…'))
      return h(View, { snap: snap, error: error, tick: tick, refresh: function () { if (loadRef.current) loadRef.current() } })
    }

    var exports = { inject: ['slots'] }
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    /** 注册到设置页插槽：宿主注入 slots 后由 apply 挂上 settings.section。 */
    exports.apply = function (ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({ name: 'settings.section', id: 'world-console', order: 28, label: '世界控制台' }, function () { return h(Console) })
      })
    }
    /** 测试用内部导出；正常渲染路径不读它。 */
    Object.defineProperty(exports, '__test', { value: { Memory: Memory, MemorySearch: MemorySearch, latest: latest, searchMemory: searchMemory, memoryQuery: memoryQuery, dayStartIso: dayStartIso, WorkspacePermission: WorkspacePermission, CompactAfterReview: CompactAfterReview, Schedule: Schedule, Modules: Modules, HomeApply: HomeApply, PhotoAlbum: PhotoAlbum, Wechat: Wechat, Activity: Activity, Diary: Diary, Qq: Qq, Panel: Panel, View: View, Overview: Overview, PersonaEditor: PersonaEditor, PromptEditor: PromptEditor, BiliCommentLog: BiliCommentLog, BiliSeedsCard: BiliSeedsCard, loadSnapshot: loadSnapshot, renderPersona: renderPersona }, enumerable: false })
    return exports
  },
})
