/**
 * 系统通知（Windows toast）与 reach_out 的通道集合。
 *
 * 导出：Notifier、toastSupported、KNOWN_DSH_APP_IDS、toastScript、windowsToast。
 * 调用方：life/tools.ts 的 reach_out 与 runtime 里的 Notifier 组装。
 * 依赖：node:child_process（PowerShell）、ecosystem/shared/outlets 的 Outlet 类型。
 * 坑：宿主是纯 Node，没有 Electron 的 Notification，只能借 WinRT；PowerShell 会把弯引号当单引号，
 * 所以文案一律走 base64，绝不拼进脚本；Windows 只给「开始菜单里有身份」的应用显示通知，
 * 找不到身份要大声失败，不能假装发出去了。
 */
/**
 * 【链路位置】
 * 不在日记/回顾的正文链路上，是送达的旁路：回顾与闹钟的文案由 runtime 写好，不经过这里。
 * 上游：life/tools.ts 的 reach_out（她自己决定要联系谁时）与 runtime 里的 Notifier 组装。
 * 下游：Windows 走 PowerShell/WinRT 的系统通知；其余平台只用 outlets 里注册的通道。
 * 读写：不碰世界目录；只把标题和正文送出去，失败抛错由调用方登记。
 * 边界：只负责「送到」，不生成也不改写任何文案，不参与回顾排期。
 */
import { spawn } from 'node:child_process';
import type { Outlet } from '../ecosystem/shared/outlets.ts';

/** reach_out's channels: the system notification where there is one, then every outlet that takes `reach`. */
export interface Notifier {
  toast?(title: string, body: string): Promise<void>;
  outlets: readonly Outlet[];
}
/** System notifications exist on Windows only (WinRT through PowerShell); elsewhere the channel is simply absent. */
/**
 * 【上游参考】
 * 宿主是纯 Node，没有 Electron 的 Notification，只能借 WinRT 发系统通知；
 * 这条通道不在 dsh-dafeiyu-life 的闹钟/回顾模型里，属于宿主环境的补丁。
 */
export const toastSupported = () => process.platform === 'win32';
// 先去控制字符再转义，顺序反了会把转义出来的 & 再转一次。
const xmlEscapes: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };
const xml = (text: string) => text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[<>&'"]/g, char => xmlEscapes[char]!);
// toast 有长度上限，超出就截断加省略号，免得整条被系统拒收。
const cap = (text: string, max: number) => { const chars = [...text]; return chars.length > max ? `${chars.slice(0, max).join('')}…` : text; };
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

/**
 * The DSH desktop's notification identity (AppUserModelID) differs between builds: newer ones register
 * `com.deepseek.dsh`, older ones Electron's default. Tried in this order, then any Start entry named after DSH.
 */
export const KNOWN_DSH_APP_IDS = ['com.deepseek.dsh', 'electron.app.DeepSeek Harness'] as const;

/**
 * The host runs as plain Node (no Electron Notification), so toasts go through WinRT from PowerShell.
 * PowerShell treats U+2018/2019/201A/201B as single quotes, so no text is ever interpolated: it travels as base64.
 *
 * Windows shows a desktop app's toast only for an identity with a Start menu entry, and for any other identity
 * `Show` still succeeds while nothing appears. So the identity is looked up there (`lookup`), the configured one
 * included, and a missing or switched-off one fails loudly. The identity used is written to stdout.
 */
/**
 * 谁调用：windowsToast 拼成 -EncodedCommand 的内容。
 * 参数：appId 是配置的通知身份，为空就按开始菜单里的 DSH 身份找；lookup=false 表示复用已找到的。
 * 失败：找不到身份、通知被系统关掉、或 Show 失败都会写 stderr 并 exit 1，由 windowsToast 变成 reject。
 */
export function toastScript(appId: string | undefined, title: string, body: string, lookup = true): string {
  const payload = `<toast><visual><binding template="ToastGeneric"><text>${xml(cap(title, 64))}</text><text>${xml(cap(body, 500))}</text></binding></visual></toast>`;
  const decode = (text: string) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(text)}'))`;
  return [
    // Progress records would reach stderr as CLIXML and bury the reason.
    "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'",
    'try {',
    '$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    '$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
    `$appId = ${decode(appId ?? '')}`,
    ...lookup ? [
      '$apps = @(Get-StartApps)',
      'if ($appId) {',
      '  if (-not ($apps | Where-Object { $_.AppID -eq $appId })) { throw "开始菜单里没有通知身份 $appId，Windows 不会显示它的通知" }',
      '} else {',
      `  $known = @(${KNOWN_DSH_APP_IDS.map(id => decode(id)).join(', ')})`,
      '  $app = $known | ForEach-Object { $id = $_; $apps | Where-Object { $_.AppID -eq $id } } | Select-Object -First 1',
      "  if (-not $app) { $app = $apps | Where-Object { $_.Name -like '*DeepSeek Harness*' } | Select-Object -First 1 }",
      `  if (-not $app) { throw ${decode(`开始菜单里找不到 DSH 桌面版的通知身份（${KNOWN_DSH_APP_IDS.join(' 或 ')}），Windows 不会显示通知；可在配置里写 toastAppId`)} }`,
      '  $appId = $app.AppID',
      '}',
    ] : [],
    '$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)',
    "if (\"$($notifier.Setting)\" -ne 'Enabled') { throw \"Windows 关闭了 $appId 的通知（$($notifier.Setting)）\" }",
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml(${decode(payload)})`,
    '$notifier.Show([Windows.UI.Notifications.ToastNotification]::new($xml))',
    '[Console]::Out.Write($appId)',
    '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
  ].join('\n');
}
/** `appId` is the configured identity; without one it is found once and reused while it keeps working. */
/**
 * 谁调用：runtime 组装 Notifier 时传给 tools.ts 的 reach_out。
 * 返回：一个 (title, body) => Promise；成功 resolve，超时、非零退出、身份找不到都 reject。
 * 状态：找到的身份缓存在闭包里，失败时清掉，下次重新找。
 */
export function windowsToast(appId?: string, spawnImpl: typeof spawn = spawn, timeoutMs = 15_000) {
  // 身份只在第一次查；查到就复用，失败时清掉，下次重新查。
  let found: string | undefined;
  return (title: string, body: string) => new Promise<void>((resolvePromise, reject) => {
    const encoded = Buffer.from(toastScript(found ?? appId, title, body, found === undefined), 'utf16le').toString('base64');
    const child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { found = undefined; reject(error); return; }
      found = stdout.trim() || found;
      resolvePromise();
    };
    const timer = setTimeout(() => { child.kill(); settle(new Error(`系统通知超时（${Math.round(timeoutMs / 1000)} 秒）`)); }, timeoutMs);
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr!.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => settle(error));
    child.on('close', code => settle(code === 0 ? undefined : new Error(`powershell 退出码 ${code}：${stderr.trim().slice(0, 200)}`)));
  });
}
