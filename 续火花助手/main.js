'use strict';
/* =====================================================================
 * 抖音续火花助手 - Electron 主进程（多账号版；版本号单一来源=package.json）
 * 职责：UI 窗口 + 唯一抖音窗口（固定持久分区）、桥接路由、好友解析、
 *      单账号发送队列、每好友独立定时 + 全局统一时间、Windows 计划任务、
 *      配置/日志、邮箱通知（登录失效 / 续火花失败 / 发送测试邮件）、
 *      托盘/退出关闭行为
 * v0.7 对比 v0.4：拆回单账号（去掉 accounts[]/按账号分区窗口/多账号 IPC）、
 *      每好友独立时间（friendTimes 映射 + targets[i].time 双写法，未设者用全局 time）、
 *      邮箱「发送测试邮件」IPC。旧版 accounts[] 配置在 loadConfig 时自动迁移到新形状。
 * （所有数据只写本工程 data/ 或 %APPDATA%，不污染其它目录）
 * ===================================================================== */
const { app, BrowserWindow, ipcMain, protocol, Tray, Menu, nativeImage, session, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

/* 控制台加固：GUI 程序被分离/管道关闭时写 console 会抛 EPIPE，统一吞掉避免死循环 */
(function () {
  var orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = function () { try { orig.log.apply(console, arguments); } catch (e) {} };
  console.warn = function () { try { orig.warn.apply(console, arguments); } catch (e) {} };
  console.error = function () { try { orig.error.apply(console, arguments); } catch (e) {} };
})();

const DOUYIN_CHAT_URL = 'https://www.douyin.com/chat';
const DOUYIN_HOME_URL = 'https://www.douyin.com/';
/* 导航地址收敛（再去掉全部自定义 query）：所有加载统一走 navTo
 * 3 秒去重；chatUrl/homeUrl 返回不带任何参数的官方原始地址——from=dsx 这类自定义
 * 渠道标记是明显的非浏览器访问特征（正常 Chrome 地址栏访问不会带），在抖音风控环境下属于可被
 * 直接命中的指纹。所有加载仍必须走 navTo 去重，不得绕过它直连 loadURL。 */
function chatUrl() { return DOUYIN_CHAT_URL; }
function homeUrl() { return DOUYIN_HOME_URL; }

/* ---------------- 浏览器指纹标准化（对齐标准 Chrome） ----------------
 * 只作用于抖音分区 session；主界面窗口 session 不做此处理。
 *
 * 背景（实测）：Electron 默认 UA 会把 productName+版本与 Electron
 * 内核段写进 navigator.userAgent——实际值为「...Gecko) 抖音续火花助手/0.20.15 Chrome/152.x
 * Electron/44.0.0 Safari/537.36」；Sec-CH-UA 客户端提示头与 navigator.userAgentData.brands
 * 同样不含 Google Chrome。新建的全新账号分区（无任何历史 cookie）打开
 * 登录页后数分钟内即连续收到「系统繁忙，请重启应用或刷新页面后重试」「访问太频繁，请稍后再试」
 * ——说明限流维度是 IP+环境指纹而不是账号登录态，系统浏览器（既有受信会话）不受影响。
 *
 *  修正要点（Electron 44 运行时实测，探测脚本三组对照）：
 *  ① **窗口创建之后再调 session.setUserAgent 完全不生效**：navigator.userAgent 与请求头都保持
 *    Electron 默认值（实验 E）。原「层 1」因此从未真正生效过——页内风险脚本读到的 UA 仍是
 *    「抖音续火花助手/0.20.x ... Electron/44.0.0」，而 JS 侧 brands 却已被补成 Google Chrome，
 *    两者自相矛盾（这种矛盾恰恰是最容易被风控判成「伪装客户端」的特征，比不伪装更糟）。
 *    修法：取到 session 后**先**应用指纹**再**建窗口（实验 B），建好后再补一次
 *    webContents.setUserAgent（实验 F，JS 侧与请求头同时变干净）。
 *  ② 标准 Chrome 的 UA 只报大版本、其余补零（UA Reduction）：`Chrome/152.0.0.0`；完整内核版本
 *    只出现在 Sec-CH-UA-Full-Version-List 与 userAgentData 高熵值里。早期写的
 *    `Chrome/152.0.7977.54` 不是真实 Chrome 的形态。
 *  ③ Linux/Windows/macOS 三平台 UA 结构保持官方形态。
 *  ④ Electron 44 **完全不发 sec-ch-ua 客户端提示头**（HTTPS 请求打到回显服务实测：只有
 *    User-Agent/Accept-Language/sec-fetch-*），而标准 Chrome 在 HTTPS 上必带低熵三件套
 *    （sec-ch-ua / sec-ch-ua-mobile / sec-ch-ua-platform）。这里在缺失时按 Chrome 口径补齐；
 *    已存在的高熵头（Full-Version-List 等）仍只替换不新增，避免制造多余特征。
 *  ⑤ navigator.userAgentData 的 JS 侧对齐在注入脚本入口完成（见 inject/douyin_auto.js 顶部）。
 * 全部只读改写本应用自己发出的请求，不碰抖音接口逻辑。 */
/** 内核完整版本（如 152.0.7977.54；只用于高熵提示头与注入脚本的 JS 对齐） */
function chromeFullVersion() {
  return (process.versions && process.versions.chrome) || '152.0.0.0';
}
function chromeMajorVersion() {
  const m = String(chromeFullVersion()).match(/^(\d+)/);
  return m ? m[1] : '152';
}
/** 与当前 Electron 内嵌内核同大版本的标准 Chrome UA 串（按平台给出官方结构；
 *  版本段为 major.0.0.0——真实 Chrome 的 UA 只报大版本，实测见注释 ②） */
function chromeUaString() {
  const ver = chromeMajorVersion() + '.0.0.0';
  if (process.platform === 'darwin') {
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/' + ver + ' Safari/537.36';
  }
  if (process.platform === 'linux') {
    return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/' + ver + ' Safari/537.36';
  }
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/' + ver + ' Safari/537.36';
}
/** 低熵 Sec-CH-UA 头值：GREASE 位 + Chromium + Google Chrome（GREASE brand/version 取
 * Electron 44 内核实测值 Not?A_Brand/v24，与同内核 Chrome 一致） */
function secChUaBrandsHeader() {
  const major = chromeMajorVersion();
  return '"Not?A_Brand";v="24", "Chromium";v="' + major + '", "Google Chrome";v="' + major + '"';
}
/** 高熵 Sec-CH-UA-Full-Version-List 头值：结构与低熵一致、版本写全（GREASE 固定 24.0.0.0） */
function secChUaFullVersionListHeader() {
  const full = chromeFullVersion();
  return '"Not?A_Brand";v="24.0.0.0", "Chromium";v="' + full + '", "Google Chrome";v="' + full + '"';
}
/** 低熵 Sec-CH-UA-Mobile 头值（桌面三平台都是 ?0，与标准 Chrome 一致） */
function secChUaMobileHeader() { return '?0'; }
/** 低熵 Sec-CH-UA-Platform 头值（按运行平台给出标准 Chrome 的写法） */
function secChUaPlatformHeader() {
  if (process.platform === 'darwin') return '"macOS"';
  if (process.platform === 'linux') return '"Linux"';
  return '"Windows"';
}
/** 在抖音分区 session 上应用标准 Chrome 指纹（UA 串 + 客户端提示请求头）。
 *  ⚠️ 调用时机：必须在 BrowserWindow 创建**之前**（实测窗口建好后再 session.setUserAgent 无效），
 *  建好窗口后还应补一次 webContents.setUserAgent 双保险（见 ensureDouyinWindow）。
 *  任一步失败都不影响窗口创建与正常加载（守卫内 try/catch）。导出供测试使用。 */
function applySessionFingerprint(ses) {
  if (!ses) return;
  try { ses.setUserAgent(chromeUaString()); } catch (e) {}
  try {
    ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, function (details, callback) {
      try {
        const h = details.requestHeaders || {};
        const lc = {};
        Object.keys(h).forEach(function (k) { lc[String(k).toLowerCase()] = k; });
        // Electron 实测在 HTTPS 上也不发低熵客户端提示头（真实 Chrome 必发），缺失时按 Chrome 口径补齐；
        // 已存在的（含服务器经 Accept-CH 点名的高熵头）只替换不新增，避免制造多余特征。
        // mobile/platform 的值 Electron 与 Chrome 本就一致 → 已存在时原样保留（连键名大小写都不动），
        // 仅在缺失且 https 时补上；sec-ch-ua 已存在时按 Chrome 口径重写（补 Google Chrome、剔除 Electron）。
        const secure = /^https:/i.test(String((details && details.url) || ''));
        function put(lower, canonical, value, replaceExisting) {
          if (lc[lower]) {
            if (replaceExisting) { delete h[lc[lower]]; h[canonical] = value; }
          } else if (secure) { h[canonical] = value; }
        }
        put('sec-ch-ua', 'Sec-CH-UA', secChUaBrandsHeader(), true);
        put('sec-ch-ua-mobile', 'Sec-CH-UA-Mobile', secChUaMobileHeader(), false);
        put('sec-ch-ua-platform', 'Sec-CH-UA-Platform', secChUaPlatformHeader(), false);
        if (lc['sec-ch-ua-full-version-list']) {
          delete h[lc['sec-ch-ua-full-version-list']];
          h['Sec-CH-UA-Full-Version-List'] = secChUaFullVersionListHeader();
        }
      } catch (e2) {}
      callback({ requestHeaders: details.requestHeaders });
    });
  } catch (e) {}
}
// 提前注册抖音深链协议，避免 Windows 弹出「打开方式」对话框（bytedance:// 等）
try {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'bytedance', privileges: {} },
    { scheme: 'snssdk1128', privileges: {} },
    { scheme: 'bytedanceweb', privileges: {} },
    { scheme: 'aweme', privileges: {} },
    { scheme: 'isnssdk1128', privileges: {} }
  ]);
} catch (e) {}
const DIR = __dirname;
const IS_PACKAGED = !!(app && app.isPackaged);
// 钉死 userData 目录（必须在 DATA_DIR 计算前调用）： 引入 productName 后，
// Electron 默认 userData 会随 productName 变成 %APPDATA%\抖音续火花助手，导致既有数据
// （config/好友缓存/发送记录/登录分区）看起来"丢失"。这里固定回 %APPDATA%\douyin-xuhuohua-helper
// （与使用说明.txt 记载路径一致），并在启动时做一次性数据迁移兜底（见 migrateLegacyUserData）。
if (IS_PACKAGED && app && typeof app.setPath === 'function') {
  try { app.setPath('userData', path.join(app.getPath('appData'), 'douyin-xuhuohua-helper')); } catch (e) {}
}
// 显式设置应用用户模型 ID（必须在 ready 前，与 setPath 同区段）：
// ⚠️ API 拼写是 setAppUserModelId（小写 d）——大写 D 的 setAppUserModelID 在 Electron 44 运行时
// 不存在（typeof 为 undefined），而下面的 typeof 守卫会把这种拼写错误静默吞掉（早期
// 因此 AUMID 从未设置成功，登录启动项回落到共享默认名 electron.app.Electron，现已修复）。
// 登录启动项的注册表值名 = 进程 AUMID 原样（Electron 44 实测），AUMID 唯一化后自启条目不再被
// 其它 Electron 应用互相覆盖。
if (app && typeof app.setAppUserModelId === 'function') {
  try { app.setAppUserModelId('douyin-xuhuohua-helper'); } catch (e) {}
}
const DATA_DIR = IS_PACKAGED ? path.join(app.getPath('userData'), 'data') : path.join(DIR, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 日志超过 5MB 轮转为 app.log.1
const SHIM = fs.readFileSync(path.join(DIR, 'inject', 'android-bridge-shim.js'), 'utf8');
const AUTO_JS = fs.readFileSync(path.join(DIR, 'inject', 'douyin_auto.js'), 'utf8');
const SEND_JS = fs.readFileSync(path.join(DIR, 'inject', 'send_msg.js'), 'utf8');
const QR_POLL_JS = fs.readFileSync(path.join(DIR, 'inject', 'qr_poll.js'), 'utf8');
const SENDLOG_FILE = path.join(DATA_DIR, 'send-log.json');
const notifyMod = require(path.join(DIR, 'lib', 'notify.js'));
// 版本号单一来源：一律从 package.json 读，界面/构建脚本都从这里取，避免多处硬编码漏改
const APP_VERSION = (function () { try { return require('./package.json').version || ''; } catch (e) { return ''; } })();

const autoMode = app.commandLine.hasSwitch('auto') || process.argv.includes('--auto');

// 兼容性：配置里开了「禁用GPU加速」（白屏/花屏/远程桌面自救）须在 app ready 前生效。
// loadConfig 为提升的函数声明，此处可安全调用（userData 已在顶层钉死）
try { if (loadConfig().disableGpu) app.disableHardwareAcceleration(); } catch (e) {}

let uiWin = null;
let autoStarted = false;
let quitting = false;   // 程序退出标志：托盘「退出」等 app.quit 来源置位后，close 处理器放行

/* ---------------- 单账号状态（唯一抖音窗口，固定分区 persist:dsh-default） ---------------- */
/* ---------------- 多账号状态：每账号独立的窗口/登录态/好友/网络/定时 ---------------- */
const accounts = new Map(); // accountId -> 账号运行时状态
function acctState(id) {
  if (!accounts.has(id)) {
    accounts.set(id, {
      win: null,
      injected: false, autoParsed: false,
      lastLogin: null,      // null=未知 / true=已登录 / false=未登录
      navAt: 0, chatGoOnce: false, falseSince: 0,
      lastNavUrl: '',       // 上一次导航目标（navTo 用它做 3 秒重复保护）
      latestFriends: [],
      netFilterActive: false, netBlockedCount: 0, offlineTimer: null,
      friendTimers: {}, globalTimer: null, globalTimer2: null, timersGeneration: 0,
      autoRunStamp: ''   // 常驻定时最近一次批次执行日（YYYY-MM-DD），计划任务 --auto 代执行据此防同日重复发送
    });
  }
  return accounts.get(id);
}
function markNav(st) { try { st.navAt = Date.now(); } catch (e) {} }

/* ---------------- 配置 / 日志 ---------------- */
function ensureDirs() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {} }
/* 一次性数据迁移兜底： 因 productName 使 userData 短暂切到 %APPDATA%\抖音续火花助手，
 * 若用户在那期间写入过数据（新账号/登录分区/发送记录），这里把缺失文件/分区合并回钉死目录。
 * 只补缺失项，绝不覆盖既有数据；config.json 仅在目标缺失或目标账号列表为空时才回填。 */
function migrateLegacyUserData() {
  try {
    if (!IS_PACKAGED) return;
    const legacyBase = path.join(app.getPath('appData'), '抖音续火花助手');
    if (!fs.existsSync(legacyBase)) return;
    const legacyData = path.join(legacyBase, 'data');
    if (fs.existsSync(legacyData)) {
      for (const name of fs.readdirSync(legacyData)) {
        if (name === 'logs') continue;
        const src = path.join(legacyData, name);
        if (!fs.statSync(src).isFile()) continue;
        const dst = path.join(DATA_DIR, name);
        if (fs.existsSync(dst)) {
          if (name === 'config.json') {
            try {
              const c = JSON.parse(fs.readFileSync(dst, 'utf8'));
              if (Array.isArray(c.accounts) && c.accounts.length > 0) continue; // 目标已有账号，不覆盖
            } catch (e) {}
          } else { continue; }
        }
        fs.copyFileSync(src, dst);
        logLine('info', '[迁移] 已从 %APPDATA%\\抖音续火花助手 补齐数据文件: ' + name);
      }
    }
    const legacyParts = path.join(legacyBase, 'Partitions');
    if (fs.existsSync(legacyParts)) {
      for (const name of fs.readdirSync(legacyParts)) {
        if (name === 'dsh-') continue; // 空 accountId 产生的垃圾分区
        const src = path.join(legacyParts, name);
        const dst = path.join(app.getPath('userData'), 'Partitions', name);
        if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
        copyDirSync(src, dst);
        logLine('info', '[迁移] 已补齐登录分区: ' + name);
      }
    }
  } catch (e) { try { logLine('warn', '[迁移] 数据迁移跳过: ' + String(e && e.message || e)); } catch (e2) {} }
}
function copyDirSync(src, dst) {
  try {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      const s = path.join(src, name), d = path.join(dst, name);
      if (fs.statSync(s).isDirectory()) copyDirSync(s, d); else fs.copyFileSync(s, d);
    }
  } catch (e) {}
}
var lastCrashLogAt = 0;
/** 落 crash.log：此前只追加不轮转，而 app.log 有 5MB×2 保留 —— 崩溃循环下
 *  （每 5 秒一条）crash.log 会无限增长。同阈值轮转，只保留一份 crash.log.1。 */
function appendCrashLog(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const f = path.join(LOG_DIR, 'crash.log');
    if (fs.existsSync(f) && fs.statSync(f).size > MAX_LOG_BYTES) {
      fs.rmSync(f + '.1', { force: true });
      fs.renameSync(f, f + '.1');
    }
    fs.appendFileSync(f, '[' + new Date().toISOString() + '] ' + msg + '\n');
  } catch (e) {}
}
/** 崩溃日志节流：5 秒内只落一条，避免崩溃循环刷爆磁盘 */
function crashThrottled() {
  const now = Date.now();
  if (now - lastCrashLogAt < 5000) return true;
  lastCrashLogAt = now;
  return false;
}
process.on('uncaughtException', function (err) {
  try {
    var msg = String(err && (err.stack || err));
    if (/EPIPE|broken pipe|ECONNRESET/i.test(msg)) return;
    if (crashThrottled()) return;
    appendCrashLog(msg);
  } catch (e) {}
});
// 未处理的 Promise 拒绝同样落 crash.log（async 代码量大，静默丢问题最难排查）
process.on('unhandledRejection', function (reason) {
  try {
    var msg = String((reason && (reason.stack || reason.message)) || reason || '');
    if (/EPIPE|broken pipe|ECONNRESET/i.test(msg)) return;
    if (crashThrottled()) return;
    appendCrashLog('[unhandledRejection] ' + msg);
  } catch (e) {}
});
/**  预置纯文字快捷文案（无 emoji，防特殊字符干扰）：QM_SEED_VERSION 变更时才会再次并入存量配置 */
const PURE_TEXT_QUICK_MESSAGES = ['续火花啦，今天也别断哦', '在吗？来续火花呀', '滴滴，续火花时间到，记得回我', '小火花不能灭，快续上', '记得续火花哦，等你回消息'];
const QM_SEED_VERSION = '0.20.7';

function defaultConfig() {
  return {
    // accounts = 账号数组，每个账号独立配置（targets/message/time/定时/网络/拟人化）
    accounts: [],
    activeAccountId: '',     // 当前 UI 激活的账号 id
    // 与账号无关的全局设置：
    closeBehavior: 'tray',
    autoStart: false,   // 开机自启（默认关闭）：开机静默进托盘，不弹主界面
    notifyOn: false, smtpHost: '', smtpPort: '465', smtpUser: '', smtpPass: '', smtpTo: '',
    // 快捷文案池（所有账号共用）；预置若干纯文字文案（无 emoji）
    quickMessages: ['续火花啦 🔥🔥🔥', '在吗？记得续火花 🔥', '今天也要记得续火花哦～'].concat(PURE_TEXT_QUICK_MESSAGES),
    // 纯文字文案一次性并入闸门（并入过就不再追加，用户删除后不会被复活）
    qmSeedVer: '',
    //  界面主题相关全局字段
    uiParticles: false, // 二次元背景粒子（默认关，勾选即时生效）
    disableGpu: false,  // 禁用GPU加速（白屏/花屏/远程桌面自救，重启生效）
    winBounds: null     // 主窗口位置/大小/最大化记忆
  };
}
/** 单个账号的默认字段（targets/message/time/定时/网络/拟人化） */
function accountDefaults() {
  return {
    id: '', name: '',
    targets: [], message: '续火花啦 🔥🔥🔥',
    time: '09:00', friendTimes: {},
    auto: false, intervalMs: 2000, skipSentToday: false, networkMode: 'always',
    secondTimeEnabled: false, secondTime: '21:00',
    randomMessage: false, randomInterval: false, intervalMaxMs: 8000
  };
}
function newAccountId() {
  return 'acct-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}
function getAccountById(cfg, id) {
  if (!cfg || !Array.isArray(cfg.accounts)) return null;
  for (let i = 0; i < cfg.accounts.length; i++) { if (cfg.accounts[i] && cfg.accounts[i].id === id) return cfg.accounts[i]; }
  return null;
}
function getActiveAccount(cfg) {
  if (!cfg || !Array.isArray(cfg.accounts)) return null;
  return getAccountById(cfg, cfg.activeAccountId) || (cfg.accounts.length ? cfg.accounts[0] : null);
}
/** 规范化单个账号：补齐默认字段、规范化类型、targets[i] 对象携带的独立时间同步进 friendTimes */
function normalizeAccount(a, i) {
  const d = accountDefaults();
  const acct = Object.assign(d, (a && typeof a === 'object') ? a : {});
  acct.id = String(acct.id || '').trim() || ('acct-legacy-' + (i + 1));
  acct.name = String(acct.name || '').trim() || ('账号' + (i + 1));
  acct.targets = dedupeTargets(Array.isArray(acct.targets) ? acct.targets : []); // 同一昵称只留一条（旧脏配置加载即自愈）
  acct.message = acct.message || '续火花啦 🔥🔥🔥';
  acct.time = acct.time || '09:00';
  acct.friendTimes = (acct.friendTimes && typeof acct.friendTimes === 'object' && !Array.isArray(acct.friendTimes)) ? acct.friendTimes : {};
  acct.auto = !!acct.auto;
  acct.intervalMs = Number(acct.intervalMs) > 0 ? Number(acct.intervalMs) : 2000;
  acct.skipSentToday = !!acct.skipSentToday;
  acct.networkMode = acct.networkMode === 'auto' ? 'auto' : 'always';
  acct.secondTimeEnabled = !!acct.secondTimeEnabled;
  acct.secondTime = acct.secondTime || '21:00';
  acct.randomMessage = !!acct.randomMessage;
  acct.randomInterval = !!acct.randomInterval;
  acct.intervalMaxMs = Number(acct.intervalMaxMs) > 0 ? Number(acct.intervalMaxMs) : 8000;
  acct.targets.forEach(function (t) {
    // friendTimes 键统一写归一化昵称（与 resolveFriendTime 的归一化兜底同口径）
    if (t && typeof t === 'object' && t.nickname && t.time) acct.friendTimes[normFriendNick(t.nickname) || t.nickname] = String(t.time);
  });
  // 剥离账号级全局字段死拷贝。v0.13 单账号迁移把顶层 smtp*/notifyOn/quickMessages/closeBehavior
  // 原样包进了账号（normalizeAccount 透传未知字段），其中 smtpPass 曾以明文落盘（敏感信息）；
  // 这些字段全局唯一且无任何账号级读取方（发信只读全局 cfg.smtp*，已加密存储），统一剥离
  ['smtpHost', 'smtpPort', 'smtpUser', 'smtpPass', 'smtpTo', 'notifyOn', 'quickMessages', 'closeBehavior'].forEach(function (k) { delete acct[k]; });
  return acct;
}
/**
 * 配置迁移：恒输出新多账号形状（accounts[] + activeAccountId）。
 * 兼容三种旧形状：
 *  1. v0.13.x 单账号（顶层 targets/message/time）→ 包成一个账号
 *  2. v0.4 多账号（accounts[] + currAcct 索引）→ 逐个规范化
 *  3. 新多账号 → 仅规范化字段，绝不抛异常。
 */
function migrateConfig(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const cfg = defaultConfig();
  // 全局字段
  cfg.closeBehavior = src.closeBehavior || 'tray';
  cfg.autoStart = !!src.autoStart;
  cfg.notifyOn = !!src.notifyOn;
  cfg.smtpHost = String(src.smtpHost || '');
  cfg.smtpPort = String(src.smtpPort || '465');
  cfg.smtpUser = String(src.smtpUser || '');
  cfg.smtpPass = String(src.smtpPass || '');
  cfg.smtpTo = String(src.smtpTo || '');
  cfg.uiParticles = !!src.uiParticles;
  cfg.disableGpu = !!src.disableGpu;
  if (src.winBounds && typeof src.winBounds === 'object' && !Array.isArray(src.winBounds)) cfg.winBounds = src.winBounds;
  cfg.quickMessages = (Array.isArray(src.quickMessages) && src.quickMessages.length) ? src.quickMessages.slice() : defaultConfig().quickMessages.slice();
  cfg.qmSeedVer = typeof src.qmSeedVer === 'string' ? src.qmSeedVer : '';
  // 把预置纯文字快捷文案一次性并入既有配置（版本闸门：并入过就不再追加，用户删除后不会被复活）
  if (cfg.qmSeedVer !== QM_SEED_VERSION) {
    PURE_TEXT_QUICK_MESSAGES.forEach(function (s) { if (cfg.quickMessages.indexOf(s) < 0) cfg.quickMessages.push(s); });
    cfg.qmSeedVer = QM_SEED_VERSION;
  }

  // 透传未知顶层字段（白名单外的不丢）：防止以后新增配置字段因没进白名单被保存时静默抹掉
  // appVersion 是 getConfig 动态附加的展示字段，明确排除，不落盘
  // smtpPassEnc/smtpPassUndecryptable 是 loadConfig 带出的内存态（供 saveConfig 回填不可解密的
  // 授权码），同样只在这一次 load→save 往返内传递，不落盘
  const KNOWN_TOP = new Set(['accounts', 'activeAccountId', 'closeBehavior', 'autoStart', 'notifyOn',
    'smtpHost', 'smtpPort', 'smtpUser', 'smtpPass', 'smtpTo', 'quickMessages', 'appVersion',
    'uiParticles', 'disableGpu', 'winBounds', 'qmSeedVer', 'smtpPassEnc', 'smtpPassUndecryptable']);
  Object.keys(src).forEach(function (k) {
    if (!KNOWN_TOP.has(k) && !(k in cfg)) cfg[k] = src[k];
  });

  // 提取原始账号列表：新多账号(accounts)、否则旧单账号(顶层 targets/message/time)
  let rawAccounts = [];
  if (Array.isArray(src.accounts)) {
    rawAccounts = src.accounts;
  } else if (Array.isArray(src.targets) || src.message || src.time) {
    rawAccounts = [src];
  }
  cfg.accounts = rawAccounts.map(normalizeAccount);

  // 激活账号：优先 activeAccountId；否则旧 currAcct 索引；否则第一个账号
  let actId = String(src.activeAccountId || '');
  if (!actId && typeof src.currAcct === 'number' && cfg.accounts[src.currAcct]) actId = cfg.accounts[src.currAcct].id;
  if (!(actId && getAccountById(cfg, actId))) actId = cfg.accounts.length ? cfg.accounts[0].id : '';
  cfg.activeAccountId = actId;
  return cfg;
}
/* SMTP 授权码加密存储：优先用系统级 safeStorage（DPAPI/Keychain），不可用时回退明文 */
function encryptSecret(plain) {
  const s = String(plain || '');
  if (!s) return '';
  try {
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(s).toString('base64');
    }
  } catch (e) {}
  // 加密不可用 → 明文回退（已知取舍），但必须告警不能静默
  try { logLine('warn', '[安全] 系统凭据加密(safeStorage)不可用，SMTP 授权码将以明文保存在 config.json'); } catch (e2) {}
  return s;
}
function decryptSecret(v) {
  if (typeof v !== 'string' || !v) return v || '';
  if (v.indexOf('enc:') === 0) {
    try {
      if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
      }
    } catch (e) {}
    return ''; // 加密可用性变化/换机导致无法解密 → 视作未设置，需重新填写
  }
  return v; // 旧明文，惰性迁移：下次 saveConfig 时加密
}
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
    const cfg = migrateConfig(raw);
    const stored = cfg.smtpPass; // 落盘原值（正常为 enc: 密文）
    cfg.smtpPass = decryptSecret(stored);
    // 解密失败时 smtpPass 会变空串（decryptSecret 的既定取舍），而关窗即触发的 saveWinBounds
    // 走 loadConfig→saveConfig，会把空值重新加密落盘 —— 授权码被静默永久抹掉（换机/整目录复制/DPAPI
    // 不可用时必现）。这里带上原密文与「不可解密」标记，saveConfig 据此在新值为空时原样回填；
    // 两个字段都在 migrateConfig 的 KNOWN_TOP 里，不会落盘也不会被透传持久化。
    if (stored && !cfg.smtpPass) { cfg.smtpPassEnc = stored; cfg.smtpPassUndecryptable = true; }
    return cfg;
  } catch (e) { return defaultConfig(); }
}
/** 原子写：先写临时文件再 rename，避免进程崩溃瞬间写坏配置/日志（config/send-log） */
function atomicWrite(filePath, data) {
  try {
    ensureDirs();
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, filePath);
    return true;
  } catch (e) {
    try { if (fs.existsSync(filePath + '.tmp')) fs.unlinkSync(filePath + '.tmp'); } catch (e2) {}
    return false;
  }
}
function saveConfig(cfg) {
  try {
    const migrated = migrateConfig(cfg);
    // 解密失败带出的标记 —— 新值为空时原样回填落盘密文（已是 enc: 形式，不得二次加密），
    // 否则一次关窗就会把不可解密的授权码抹成空。用户主动清空（可正常解密场景不带标记）行为不变。
    if (!migrated.smtpPass && cfg && cfg.smtpPassUndecryptable && cfg.smtpPassEnc) {
      migrated.smtpPass = String(cfg.smtpPassEnc);
    } else {
      migrated.smtpPass = encryptSecret(migrated.smtpPass);
    }
    return atomicWrite(CONFIG_FILE, JSON.stringify(migrated, null, 2));
  } catch (e) { return false; }
}
function logLine(level, msg) {
  const ts = new Date().toISOString();
  const line = '[' + ts + '] [' + level + '] ' + msg;
  console.log(line);
  try {
    const logFile = path.join(LOG_DIR, 'app.log');
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_BYTES) {
      // 保留最近 2 份轮转：app.log.1 顶到 app.log.2，app.log 顶到 app.log.1
      const f1 = path.join(LOG_DIR, 'app.log.1');
      const f2 = path.join(LOG_DIR, 'app.log.2');
      if (fs.existsSync(f2)) fs.rmSync(f2, { force: true });
      if (fs.existsSync(f1)) fs.renameSync(f1, f2);
      fs.renameSync(logFile, f1);
    }
    fs.appendFileSync(logFile, line + '\n');
  } catch (e) {}
  sendUI({ type: 'log', level: level, message: msg });
}
function sendUI(obj) {
  if (uiWin && !uiWin.isDestroyed()) { try { uiWin.webContents.send('dsx:ui', obj); } catch (e) {} }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function wc(accountId) {
  const st = acctState(accountId);
  const w = st.win;
  return (w && !w.isDestroyed()) ? w.webContents : null;
}
/** 由 webContents 反查所属账号 id（bridge 回调用），找不到返回 null */
function accountByWebContents(wcb) {
  for (const entry of accounts) {
    const st = entry[1];
    if (st.win && st.win.webContents === wcb) return entry[0];
  }
  return null;
}
function parseList(jsonOrArr) {
  if (Array.isArray(jsonOrArr)) return jsonOrArr;
  try {
    const arr = JSON.parse(typeof jsonOrArr === 'string' ? jsonOrArr : String(jsonOrArr || '[]'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

/** 昵称归一化：去零宽字符、合并连续空白、trim——双程扫描两次快照间
 *  昵称文本的不可见差异（尾部空格/换行/零宽空格）会让去重指纹失配。 */
function normFriendNick(s) {
  return String(s == null ? '' : s)
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .replace(/\s+/g, ' ').trim();
}
/** 装饰图标 URL 识别：火花/火焰/表情等图标 CDN 路径不是头像——注入脚本在
 *  虚拟列表节点复用瞬间可能把火花图标 <img> 当成头像抓到（曾出现：avatarUrl 为
 *  .../flame_icon/normal/gray_normal.png），这类 URL 归一化时一律视为「无头像」，
 *  否则它会污染「昵称+头像」指纹与防发错人守卫的头像集合。 */
const ICON_AVATAR_RE = /flame|fire|spark|huohua|emoji|gray_normal|lit_normal|\/icons?\/|_icon\b|icon[_-]/i;
/** 头像 URL 归一化：去掉 query/fragment（抖音 CDN 头像 URL 可能带签名/尺寸
 *  参数，同一对象不同时刻参数不同会让「昵称+头像」指纹失配）；data: 占位图与火花/表情
 *  图标 URL 视为空（懒加载未完成的占位图、被错抓的装饰图标都无法标识人）。 */
function normFriendAvatar(u) {
  try {
    let s = String(u == null ? '' : u).trim();
    if (!s || /^data:/i.test(s)) return '';
    s = s.split('#')[0].split('?')[0];
    if (ICON_AVATAR_RE.test(s)) return '';
    return s;
  } catch (e) { return ''; }
}
/** 默认占位头像：没设置过头像的用户全部共用同一个 CDN 对象，它不标识人
 *  （实测多个不同账号共用 aweme_default_avatar.png）。
 *  按对象路径比对会把他们并成同一个人，所以身份键里一律视为「无头像」。 */
const DEFAULT_AVATAR_RE = /\/aweme_default_avatar\./i;
function isDefaultAvatarUrl(u) {
  try { return DEFAULT_AVATAR_RE.test(String(u == null ? '' : u).split('#')[0].split('?')[0]); } catch (e) { return false; }
}
/** 头像「身份键」：在 normFriendAvatar 之上再去掉 CDN 域名，只留对象路径——
 *  域名不标识人。抖音头像 CDN 域名会轮换：同一好友的同一个头像对象，两程扫描分别抓到
 *  p3.huoshanimg.com 与 p11.douyinpic.com（全量分布还有 p3/p11/p26.douyinpic.com、
 *  p3-aweme-im-img.byteimg.com）。此前只去 query，域名差异让同一人的两条快照头像不相等
 *  → 强指纹与弱指纹都不合并 → 好友列表并排两行 → 防发错人守卫按「同名多条 + 头像互不相同」
 *  判成真重名停发（实证：同一好友曾连续多次被误判停发；整份缓存里多行是这种域名
 *  轮换造成的假重复）。
 *  注意：本函数只用于「比较是否同一人」，落盘/回填仍用 normFriendAvatar 的完整 URL。 */
function friendAvatarKey(u) {
  try {
    const s = normFriendAvatar(u);
    if (!s || isDefaultAvatarUrl(s)) return '';
    return s.replace(/^[a-z][a-z0-9+.\-]*:\/\/[^/]+/i, '');
  } catch (e) { return ''; }
}
/** 会话字段文本归一化：合并连续空白并 trim（消息预览/时间/空 id 比较用）。 */
function normFriendText(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}
/** 在线状态文本识别：好友在线时抖音会把会话行的预览位显示成「在线 / N分钟内在线 /
 *  N小时内在线」——它不是消息内容。合并两次快照时真实消息预览优先于它，避免「最后消息」列
 *  停在状态文本上（降级行先入列、真身行后到时会出现），也避免按最后消息搜索漏掉该好友。 */
const PRESENCE_TEXT_RE = /^(?:在线|\d+\s*(?:分钟|小时|天|周|个月|月)内在线)$/;
function isPresenceText(s) {
  return PRESENCE_TEXT_RE.test(normFriendText(s));
}
/**
 * 好友条目强指纹集合：id:<id>（会话 id 全站唯一）与
 *  na:<归一化昵称>|<头像身份键>（头像 CDN 对象按人唯一；身份键去掉域名，
 *  同一对象在不同 CDN 域名下仍算同一人）。两条记录共享任一强指纹即同一人。
 *  仅有强指纹不够——曾出现同一好友的两次收集，一次头像被火花图标
 *  顶替（归一化后为空）、一次懒加载抓空，且 id 结构性抓不到，强指纹全部不相交而漏网
 *  （真实缓存：某好友=真头像 vs flame_icon；另一好友=真头像 vs 空）。这类「强指纹不
 *  相交但确为同一会话」的情况由 friendsWeakSame 弱指纹兼容合并兜底。
 */
function friendFingerprints(f) {
  const keys = [];
  try {
    if (!f) return keys;
    const id = normFriendText(f.id);
    if (id) keys.push('id:' + id);
    const nick = normFriendNick(f.nickname);
    const avatar = friendAvatarKey(f.avatarUrl);
    if (nick && avatar) keys.push('na:' + nick + '|' + avatar);
  } catch (e) {}
  return keys;
}
/** 兼容包装：返回条目首个强指纹，无指纹返回空串。 */
function friendDedupKey(f) {
  const ks = friendFingerprints(f);
  return ks.length ? ks[0] : '';
}
/** 条目是否带「可识别身份」：会话 id 或有效头像任一非空。
 *  两者全缺 = 降级快照（会话行重渲染瞬间拍的：头像 img 尚未挂载 src、id 结构性抓空），
 *  它无法证明自己是「另一个人」。 */
function friendHasIdentity(f) {
  try { return !!(normFriendText(f && f.id) || normFriendAvatar(f && f.avatarUrl)); } catch (e) { return false; }
}
/** 弱指纹兼容判定：强指纹不命中时，两条记录是否为同一会话的两次收集。
 *  全部满足才算同一人：
 *   1) 归一化昵称相同；
 *   2) id 兼容：双方都有 id 时必须相等（不同 id 一定是两个会话）；
 *   3) 头像兼容：双方都有「有效头像」时必须相同——两个不同真实头像 = 真重名，不合并；
 *      一方头像空/图标/占位（懒加载未完成或被火花图标顶替）不构成矛盾；
 *      比较用 friendAvatarKey（去 CDN 域名），默认占位头像不算有效头像；
 *   4) 会话内容一致：消息预览与时间在双方都非空时必须相等（同一行两次收集内容逐字
 *      相同；真重名的两个人预览文本与时间戳不可能完全一样）。
 *   修正第 4 条适用范围：恰好一方为降级快照（id 与有效头像全缺）、另一方有身份
 *  信息时跳过内容比对——降级快照没有任何可区分身份的字段，内容差异不构成「不同人」的证据；
 *  双方都无身份信息时仍按第 4 条保守保留（不合并）。
 *  曾出现：第二时段预刷新紧跟第一时段发送之后，刚发过消息的会话行正在重渲染/重排序，
 *  拍到的快照头像缺 src、预览位被在线状态顶替（「30分钟内在线」）或换成了扫描期间新到的
 *  消息（「00:36」→「刚刚」），与已收集的同名行内容不一致 → 第 4 条判为矛盾 → 重复入列
 *  （整份缓存里多行是重复快照），「今日已守护」按行数虚高。
 *  最坏情况仅为「同名、头像都抓空、预览与时间全同的两个真人」被合并——概率远低于
 *  每程重复导致守卫整批拦停；且防发错人守卫发送前仍独立校验，不会发错人。 */
function friendsWeakSame(a, b) {
  try {
    const na = normFriendNick(a.nickname), nb = normFriendNick(b.nickname);
    if (!na || na !== nb) return false;
    const ia = normFriendText(a.id), ib = normFriendText(b.id);
    if (ia && ib && ia !== ib) return false;
    const aa = friendAvatarKey(a.avatarUrl), ab = friendAvatarKey(b.avatarUrl);
    if (aa && ab && aa !== ab) return false;
    // 恰好一方为降级快照（无 id 无有效头像）、另一方有身份信息：内容差异不构成矛盾，按昵称并入
    // （双方都无身份信息时不在此返回，继续走下面的内容一致判定 → 保守保留）
    if (friendHasIdentity(a) !== friendHasIdentity(b)) return true;
    const ma = normFriendText(a.lastMessage), mb = normFriendText(b.lastMessage);
    if (ma && mb && ma !== mb) return false;
    const ta = normFriendText(a.lastTimeText), tb = normFriendText(b.lastTimeText);
    if (ta && tb && ta !== tb) return false;
    return true;
  } catch (e) { return false; }
}
/** 合并两条同人记录：保留信息更全的一份（空 id/头像/预览/时间用另一份补），火花取「有」。 */
function mergeFriendRows(dst, src) {
  try {
    if (!normFriendText(dst.id) && normFriendText(src.id)) dst.id = src.id;
    if (!normFriendAvatar(dst.avatarUrl) && normFriendAvatar(src.avatarUrl)) dst.avatarUrl = src.avatarUrl;
    if (!normFriendText(dst.lastMessage) && normFriendText(src.lastMessage)) dst.lastMessage = src.lastMessage;
    // 预览位被在线状态顶替过时，用另一程的真实消息预览覆盖（降级行先入列也不留状态文本）
    if (isPresenceText(dst.lastMessage) && normFriendText(src.lastMessage) && !isPresenceText(src.lastMessage)) dst.lastMessage = src.lastMessage;
    if (!normFriendText(dst.lastTimeText) && normFriendText(src.lastTimeText)) dst.lastTimeText = src.lastTimeText;
    if (src.hasSpark) dst.hasSpark = true;
    if (src.unread) dst.unread = true;
  } catch (e) {}
  return dst;
}
/** 好友列表归一化：丢弃无昵称的无效项 → 强指纹（id/头像）去重 → 弱指纹（昵称+内容
 *  兼容）兜底合并并补全字段 → 重排 domIndex。
 *  所有好友列表入口（桥接解析/自动读取/手动刷新/定时预刷新/磁盘缓存加载）都必须经过这里。 */
function dedupeFriends(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach(function (f) {
    if (!f || !normFriendNick(f.nickname)) return;
    let hit = -1;
    const id = normFriendText(f.id);
    const avatar = friendAvatarKey(f.avatarUrl);
    // 第一轮：强指纹（id 相同 / 有效头像相同）
    for (let i = 0; i < out.length; i++) {
      const o = out[i];
      const oid = normFriendText(o.id);
      const oav = friendAvatarKey(o.avatarUrl);
      if (id && oid && id === oid) { hit = i; break; }
      if (id && oid && id !== oid) continue;
      if (avatar && oav && avatar === oav && normFriendNick(f.nickname) === normFriendNick(o.nickname)) { hit = i; break; }
    }
    // 第二轮：弱指纹兼容（昵称相同 + id/头像/预览/时间不矛盾）
    if (hit < 0) {
      for (let j = 0; j < out.length; j++) {
        if (friendsWeakSame(f, out[j])) { hit = j; break; }
      }
    }
    if (hit >= 0) { mergeFriendRows(out[hit], f); return; }
    out.push(f);
  });
  out.forEach(function (f, i) { try { f.domIndex = i; } catch (e) {} });
  return out;
}

/** 续火花目标去重：按归一化昵称只保留首次出现的条目（原样保留字符串或
 *  {nickname,time} 对象形态与顺序）。必须去重的原因：好友列表重复行时代保存的配置可能把
 *  同一好友写进去两遍，而「跳过今天已发过」只在发送循环之前过滤一次、循环内发完第一条只
 *  markSent 不复查 → 同一人会在同一批里收到两条；列表合并成一行后防发错人守卫也拦不住
 *  （sameCount=1 直接放行）。同时让「目标 N 个」日志与日历 total/ok/fail 口径回到人数。 */
function dedupeTargets(targets) {
  const out = [];
  const seen = Object.create(null);
  (Array.isArray(targets) ? targets : []).forEach(function (t) {
    const nick = (typeof t === 'string') ? t : ((t && t.nickname) || '');
    const key = normFriendNick(nick);
    if (!key || seen[key]) return;
    seen[key] = 1;
    out.push(t);
  });
  return out;
}

/* ---------------- 好友列表磁盘缓存（每账号独立，切换/重启不丢） ---------------- */
function friendsCacheFile(accountId) { return path.join(DATA_DIR, 'friends-' + accountId + '.json'); }
function loadCachedFriends(accountId) {
  try {
    const arr = JSON.parse(fs.readFileSync(friendsCacheFile(accountId), 'utf8').replace(/^\uFEFF/, ''));
    const raw = Array.isArray(arr) ? arr : [];
    const clean = dedupeFriends(raw);
    // 自愈：旧版本可能把重复入列的坏列表落盘，加载时归一化后顺手重写，
    // 让磁盘缓存与内存一致（重启/切号不再读到重复行）
    if (clean.length && clean.length !== raw.length) {
      try { atomicWrite(friendsCacheFile(accountId), JSON.stringify(clean)); } catch (e) {}
    }
    return clean;
  } catch (e) { return []; }
}
function saveCachedFriends(accountId, list) {
  if (!Array.isArray(list) || !list.length) return; // 空列表不覆盖已有缓存（解析失败/未登录时保护）
  try { atomicWrite(friendsCacheFile(accountId), JSON.stringify(dedupeFriends(list))); } catch (e) {}
}
function clearCachedFriends(accountId) {
  try { if (fs.existsSync(friendsCacheFile(accountId))) fs.unlinkSync(friendsCacheFile(accountId)); } catch (e) {}
}
/** 日志里的账号标识：多账号下「解析完成 N 条」这类行不带账号，两个账号的日志混在一起，
 *  排查时只能靠时间戳与「到点前 5 分钟预刷新」的规律反推是谁。 */
function acctLabel(accountId) {
  try {
    const a = getAccountById(loadConfig(), accountId);
    return '「' + ((a && a.name) || accountId) + '」';
  } catch (e) { return '「' + accountId + '」'; }
}
/** 好友列表落地前的空值闸门：解析结果为空时返回 []，调用方据此**不覆盖内存、不落盘、不推 UI**。
 *  为什么必须有：桥接 payload 被 sanitizeBridgeArgs 截断（单参数上限 BRIDGE_MAX_ARG_LEN）时 parseList
 *  会静默返回 []。实践中多次出现「[好友] 解析完成: 0 条会话」紧跟注入侧「解析完成 94~100 条会话」
 *  （相差 1ms），而同期注入侧的「解析完成 0 条」日志与 parse_list_error/fatal 错误行均为 0 次 ——
 *  空结果不是抓出来的，是载荷在传输环节坏了。无条件覆盖的后果：① 界面好友列表与勾选被清空，此时点
 *  「全选有火花」会把 targets 存成空数组（勾选目标丢失）；② resolveSendTargetId 拿到空列表 → sameCount=0
 *  → 防发错人守卫直接放行、发送回退到 DOM 里第一个同名标题。磁盘缓存早有同样的空列表保护
 *  （saveCachedFriends），这里把内存与 UI 的口径补齐；四个入口（桥接 handleFriendList / autoParse /
 *  手动 parseFriends / 定时 prepareForSend）统一走它。
 *  warn 里带原始载荷长度：正好等于桥接上限即可判定为截断（用以区分「真抓到 0 条」）。 */
function guardFriendList(accountId, list, rawPayload, via) {
  const clean = dedupeFriends(Array.isArray(list) ? list : []);
  if (clean.length) return clean;
  const st = acctState(accountId);
  const rawLen = (typeof rawPayload === 'string') ? rawPayload.length : -1;
  logLine('warn', '[好友] ' + acctLabel(accountId) + via + '解析结果为空，保留原有 ' +
    ((st.latestFriends && st.latestFriends.length) || 0) + ' 条不覆盖（原始载荷长度 ' + rawLen +
    (rawLen === BRIDGE_MAX_ARG_LEN ? '，正好等于桥接单参数上限 → 基本可判定被截断' : '') + '）');
  return [];
}

/* ---------------- 抖音窗口导航（统一入口 + 3 秒重复保护） ---------------- */
/** 唯一的抖音页导航入口：同一账号 3 秒内对同一 URL 只加载一次。
 *  为什么必须有：此前 4 个入口（ensureLogin/extractQr/logout/桥接 loginState）各自直接 loadURL，
 *  互相之间没有去重，实践中出现过短时间内对同一 URL（/jingxuan?from=dsx-logout）连加载 3 次；
 *  抖音页每次整页加载都会重新初始化 passport SDK 并重新请求二维码，是「登录请求过于频繁」的
 *  直接放大器。返回是否真的发起了加载。 */
function navTo(accountId, url, why) {
  const st = acctState(accountId);
  const w = st.win;
  if (!w || w.isDestroyed()) return false;
  const now = Date.now();
  if (st.lastNavUrl === url && now - (st.navAt || 0) < 3000) {
    logLine('info', '[导航] 3 秒内重复目标，跳过重复加载（' + why + '）: ' + url);
    return false;
  }
  st.lastNavUrl = url;
  markNav(st);
  try { w.loadURL(url); } catch (e) { return false; }
  return true;
}
/* ---------------- 唯一抖音窗口 ---------------- */
function ensureDouyinWindow(accountId, loadUrl) {
  if (!accountId) { logLine('warn', '[账号] 空 accountId，拒绝创建抖音窗口（避免产生空登录分区）'); return null; }
  const st = acctState(accountId);
  const partition = 'persist:dsh-' + accountId;
  let w = st.win;
  if (w && !w.isDestroyed()) return w;
  // 必须在 BrowserWindow 之前取 session 并应用指纹——实测 Electron 44 里「窗口创建后
  // 再 session.setUserAgent」对 JS 侧 UA 与请求头都不生效（探测实验 E），会让页内看到的 UA 与
  // brands 自相矛盾。顺序：先 session 指纹 → 建窗口 → 再补 webContents.setUserAgent 双保险。
  let ses = null;
  try {
    ses = session.fromPartition(partition);
    applySessionFingerprint(ses);
  } catch (e) {}
  w = new BrowserWindow({
    width: 460, height: 720, show: false,
    icon: path.join(DIR, 'ui', 'icon.png'),
    webPreferences: {
      preload: path.join(DIR, 'preload-douyin.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false, // 省内存：不加载拼写词典
      partition: partition
    }
  });
  st.win = w;
  // 双保险（实测有效）：窗口建好后再用 webContents 级 UA 覆盖一次，JS 侧 navigator.userAgent
  // 与请求头会同时变成标准 Chrome 串（必须在首个 loadURL 之前调用）
  try { w.webContents.setUserAgent(chromeUaString()); } catch (e) {}
  // 安全：拒绝抖音页面的权限请求（通知/定位/摄像头等），防止第三方脚本诱导授权
  try {
    if (ses) {
      ses.setPermissionRequestHandler(function (wc0, permission, callback) { try { callback(false); } catch (e) {} });
    }
  } catch (e) {}
  w.webContents.on('dom-ready', function () { injectDouyin(accountId, w.webContents); });
  w.webContents.on('did-navigate', function () { st.injected = false; });
  // 首个地址也写进 navTo 的去重状态：否则窗口刚建好就会因「目标相同的导航」在 3 秒内再加载一次
  const firstUrl = loadUrl || chatUrl();
  st.lastNavUrl = firstUrl;
  markNav(st);
  try { w.loadURL(firstUrl); } catch (e) {}
  w.on('close', function (ev) {
    // 关闭抖音窗口 = 隐藏（登录态保留在 persist 分区），退出程序时放行真正关闭
    if (quitting) return;
    ev.preventDefault();
    try { w.hide(); } catch (e) {}
    logLine('info', '[抖音窗口] 已隐藏（登录态保留，点「显示抖音页」可重新打开）');
  });
  w.webContents.on('render-process-gone', function () {
    cancelAccountSend(accountId, '抖音页面进程已退出，发送结果未知');
    if (!w.isDestroyed()) w.destroy();
  });
  w.on('closed', function () {
    cancelAccountSend(accountId, '抖音窗口已关闭');
    st.win = null;
    st.injected = false; st.autoParsed = false; st.lastLogin = null;
    st.chatGoOnce = false; st.falseSince = 0; st.navAt = 0;
  });
  return w;
}
/* ---------------- 网络控制（每账号独立 partition 断网/联网） ---------------- */
/* 断网时切到的离线提示页（纯内联，不依赖网络） */
const OFFLINE_HTML = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<html><head><meta charset="utf-8"></head><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#101928;color:#cfd8e3;font-family:Microsoft YaHei,sans-serif"><div style="text-align:center;line-height:2"><div style="font-size:34px">📴</div><div style="font-size:16px;font-weight:600">已断开网络（离线模式）</div><div style="font-size:13px;color:#ff9800">到定时续火花时间会自动恢复网络并发送</div></div></body></html>'
);
/** 排定「N 毫秒后彻底断网」：auto 模式且已登录时生效，新计划取代旧计划 */
function scheduleOffline(accountId, ms, reason) {
  const st = acctState(accountId);
  if (st.offlineTimer) { clearTimeout(st.offlineTimer); st.offlineTimer = null; }
  const acct = getAccountById(loadConfig(), accountId);
  if (!acct || acct.networkMode !== 'auto') return;
  st.offlineTimer = setTimeout(function () {
    st.offlineTimer = null;
    const c2 = getAccountById(loadConfig(), accountId);
    if (c2 && c2.networkMode === 'auto' && st.lastLogin === true && !st.sendBusy) {
      setNetworkOffline(accountId, true);
      logLine('info', '[网络] ' + reason + '，已彻底断网');
    }
  }, ms);
}
function setNetworkOffline(accountId, on) {
  const st = acctState(accountId);
  try {
    const ses = session.fromPartition('persist:dsh-' + accountId);
    const w = st.win;
    if (on) {
      if (!st.netFilterActive) {
        st.netBlockedCount = 0;
        ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, function (details, callback) { st.netBlockedCount++; callback({ cancel: true }); });
        st.netFilterActive = true;
        logLine('info', '[网络] 已断开抖音页网络（离线模式，后续请求将被拦截）');
      }
      // 彻底断网：停止加载并切到离线提示页（避免还能看已缓冲/已加载内容）
      if (w && !w.isDestroyed()) {
        try { w.webContents.stop(); } catch (e) {}
        try { w.loadURL(OFFLINE_HTML); } catch (e) { try { w.loadURL('about:blank'); } catch (e2) {} }
        // 页面已被换成离线页（data:），navTo 记忆的上一个抖音地址随即失效——
        // 不清掉的话，若「联网→断网→恢复联网」发生在 3 秒内，恢复时的 chat 加载会被误判为重复而跳过。
        st.lastNavUrl = '';
        st.navAt = 0;
      }
      sendUI({ type: 'netState', accountId: accountId, offline: true });
    } else {
      if (st.offlineTimer) { clearTimeout(st.offlineTimer); st.offlineTimer = null; }
      if (st.netFilterActive) {
        ses.webRequest.onBeforeRequest(null);
        st.netFilterActive = false;
        logLine('info', '[网络] 已恢复抖音页网络连接（离线期间拦截 ' + st.netBlockedCount + ' 个请求）');
      }
      // 恢复页面：重新加载会话列表（登录态在 persist 分区保留）
      if (w && !w.isDestroyed()) {
        navTo(accountId, chatUrl(), '恢复联网');
      }
      sendUI({ type: 'netState', accountId: accountId, offline: false });
    }
  } catch (e) { logLine('warn', '[网络] 切换网络模式失败: ' + String(e && e.message || e)); }
}
/** 注入门槛：hostname 必须是 douyin.com 或其子域（旧 url.indexOf 子串匹配会把
 *  evil-douyin.com / douyin.com.evil.com 之类误放进来，已改为严格解析） */
function isDouyinHost(url) {
  try { return /(^|\.)douyin\.com$/i.test(new URL(String(url)).hostname); } catch (e) { return false; }
}
async function injectDouyin(accountId, w) {
  const st = acctState(accountId);
  if (st.injected) return;
  try {
    const url = (w && w.getURL()) || '';
    if (!isDouyinHost(url)) return;
    await w.executeJavaScript(SHIM + '\n' + AUTO_JS + '\n' + QR_POLL_JS + '\n;void 0;', true);
    st.injected = true;
    try { await w.executeJavaScript('window.DouyinAuto && window.DouyinAuto.init(location.href)', true); } catch (e) {}
    logLine('info', '[注入] 已注入自动化脚本');
  } catch (e) {
    logLine('warn', '[注入] 注入失败(可能页面未就绪): ' + String(e && (e.message || e)));
  }
}
/** 启动后延迟检测登录态（供 UI 状态灯与自动读取好友使用） */
function detectLoginOnStartup(accountId) {
  const st = acctState(accountId);
  const w = wc(accountId); if (!w) return;
  setTimeout(async function () {
    try {
      // 只在注入脚本已就绪并明确返回 true/false 时才写登录态：脚本未注入时旧表达式
      // (window.DouyinAuto && ...) 求值为 undefined，!!undefined=false 会把「还没注入完成」
      // 误判成「未登录」，导致刚启动时的定时发送被 runSendNow 的 lastLogin===false 短路跳过。
      // 表达式取 detectLoginState() 原始三态（true/false/'pending'/null）——页面加载初期
      // 脚本按 'pending' 上报，不再被 === true 压成 false 误写 lastLogin=false。
      const v = await w.executeJavaScript('window.DouyinAuto ? window.DouyinAuto.detectLoginState() : null', true);
      if (v !== true && v !== false) return; // 未注入/加载初期('pending')/探测失败：维持未知，等桥接 loginState / getAccountState 再确认
      st.lastLogin = v;
      sendUI({ type: 'loginState', accountId: accountId, loggedIn: v });
      if (!v) logLine('info', '[登录] 当前未登录');
    } catch (e) {}
  }, 2500);
}
/** 登录后延迟自动读取好友列表（打开自动获取） */
function autoParse(accountId) {
  const st = acctState(accountId);
  if (st.autoParsed) return;
  st.autoParsed = true;
  const w = wc(accountId); if (!w) return;
  setTimeout(async function () {
    try {
      await ensureOnChat(accountId);
      const w2 = wc(accountId); if (!w2) return;
      const arr = await w2.executeJavaScript('window.DouyinAuto.parseFriendList({}).then(function (j) { return JSON.parse(j); })', true);
      // 空结果视同读取失败——复位一次性闸门允许下次重试，且不覆盖内存/不推空列表给 UI
      const clean = guardFriendList(accountId, arr, arr, '自动');
      if (!clean.length) { st.autoParsed = false; return; }
      st.latestFriends = clean;
      saveCachedFriends(accountId, clean);
      logLine('info', '[自动] ' + acctLabel(accountId) + '好友读取完成: ' + clean.length + ' 条');
      notifyFriends(accountId, clean);
      scheduleOffline(accountId, 60 * 1000, '好友列表读取完成 1 分钟');
    } catch (e) {
      st.autoParsed = false; // 失败复位一次性闸门：允许下次触发（重新登录/切号拉状态）时自动重试
      logLine('warn', '[自动] 自动读取失败: ' + String(e && e.message || e));
    }
  }, 3500);
}

/* ---------------- 浏览器数据隔离 ----------------
 * 早期 曾提供「从浏览器导入登录态」：CDP 采集系统 Edge/Chrome 的抖音
 * cookie/localStorage 注入账号分区。该方案已**整体移除**，不要再加回来，原因（实测后果）：
 *  1 采集用的调试实例会带着用户的登录 cookie 主动访问 www.douyin.com——同一 sessionid 从两个
 *    不同环境指纹同时使用，抖音按「会话疑似被窃取」直接把该会话作废，用户自己的浏览器被踢下线；
 *  2 过程中要强制结束用户的浏览器进程并反复重启（观测到 4 分钟内 3~5 次），浏览器
 *    异常退出也可能丢掉会话；
 *  3 用户的浏览器资料属于用户私有数据，本应用不得读取/复制/改写。
 * 登录只能在本应用自己的分区里完成（扫码或短信），任何绕过登录的取巧手段都不再做。 */

/* ---------------- 邮箱通知 ---------------- */
function notifyEmail(subject, body) {
  const cfg = loadConfig();
  if (!cfg.notifyOn || !cfg.smtpHost || !cfg.smtpUser || !cfg.smtpPass || !cfg.smtpTo) return Promise.resolve(false);
  return notifyMod.sendEmail(cfg, subject, body)
    .then(function () { logLine('info', '[通知] 邮件已发送: ' + subject); return true; })
    .catch(function (e) { logLine('warn', '[通知] 邮件发送失败: ' + String(e && e.message || e)); return false; });
}
/** 统一在发送后上报告警：登录失效 / 续火花失败（带账号名，多账号下可区分） */
function notifyProblems(accountId, r, context) {
  if (!r) return;
  const acct = getAccountById(loadConfig(), accountId);
  const name = (acct && acct.name) || accountId;
  if (r.error === '未登录') {
    notifyEmail('抖音登录失效', '「' + name + '」续火花前未登录（' + (context || '发送') + '），请打开应用重新扫码登录。');
  } else if (r.fails && r.fails.length) {
    notifyEmail('续火花失败', '「' + name + '」续火花失败明细（' + (context || '发送') + '）：\n' + r.fails.join('\n'));
  }
}

/* ---------------- UI 窗口 ---------------- */
/* 主窗口记忆：读回上次位置/大小/最大化（无记录/尺寸过小时回默认） */
function loadWinBounds() {
  try {
    const b = loadConfig().winBounds;
    if (b && typeof b === 'object' && Number(b.width) >= 1080 && Number(b.height) >= 760) {
      return { x: Number(b.x), y: Number(b.y), width: Number(b.width), height: Number(b.height), maximized: !!b.maximized };
    }
  } catch (e) {}
  return null;
}
/* 主窗口记忆：关闭（托盘隐藏/退出都触发）时保存位置/大小/最大化到配置 */
function saveWinBounds() {
  try {
    if (!uiWin || uiWin.isDestroyed()) return;
    const b = uiWin.getBounds();
    const cfg = loadConfig();
    cfg.winBounds = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: !!(uiWin.isMaximized && uiWin.isMaximized()) };
    saveConfig(cfg);
  } catch (e) {}
}
function createUI() {
  try {
    const wb = loadWinBounds();
    const opts = {
      width: wb ? wb.width : 1280, height: wb ? wb.height : 920,
      minWidth: 1080, minHeight: 760,
      title: '抖音续火花助手',
      icon: path.join(DIR, 'ui', 'icon.png'),
      webPreferences: {
        preload: path.join(DIR, 'preload-ui.js'),
        contextIsolation: true, nodeIntegration: false,
        spellcheck: false // 省内存：不加载拼写词典
      }
    };
    if (wb && typeof wb.x === 'number' && typeof wb.y === 'number') { opts.x = wb.x; opts.y = wb.y; }
    uiWin = new BrowserWindow(opts);
    uiWin.loadFile(path.join(DIR, 'ui', 'index.html'));
    uiWin.once('ready-to-show', function () {
      try { if (wb && wb.maximized) uiWin.maximize(); uiWin.show(); } catch (e) {}
    });
    // 稳定性：界面渲染进程崩溃自动重载恢复，避免白屏/死窗口需手动重启
    uiWin.webContents.on('render-process-gone', function (ev, details) {
      if (quitting) return;
      logLine('error', '[界面] 界面渲染进程异常退出(' + String((details && details.reason) || 'unknown') + ')，3 秒后自动重载');
      setTimeout(function () {
        if (uiWin && !uiWin.isDestroyed()) {
          try { uiWin.loadFile(path.join(DIR, 'ui', 'index.html')); } catch (e) {}
        }
      }, 3000);
    });
    uiWin.on('close', function (ev) {
      saveWinBounds(); // 托盘隐藏与退出都会保存窗口位置/大小/最大化
      if (quitting) { logLine('info', '[关闭] 程序退出中，放行窗口关闭'); return; }
      const cfg = loadConfig();
      const isTray = cfg.closeBehavior === 'tray';
      logLine('info', '[关闭] closeBehavior=' + (cfg.closeBehavior || '(空)') + ' -> ' + (isTray ? '托盘' : '退出'));
      if (isTray) {
        ev.preventDefault();
        try { uiWin.hide(); } catch (e) {}
        logLine('info', '[托盘] 已最小化到托盘（点托盘图标或再双击启动可唤回）');
      } else {
        // 直接退出：销毁所有抖音窗口，两个窗口都不在后由 window-all-closed 兜底退出
        try { accounts.forEach(function (st) { if (st.win && !st.win.isDestroyed()) st.win.destroy(); }); } catch (e) {}
        logLine('info', '[关闭] 退出分支：关闭主窗口并销毁抖音窗口，即将退出');
      }
    });
    uiWin.on('closed', function () { uiWin = null; });
  } catch (e) {}
}

let tray = null;
/** 开机自启：按配置把本程序写进/移出 Windows 登录启动项（HKCU\Run，无需管理员）。
 * 带 --hidden 参数启动，运行时据此识别「本次为开机自启唤起」，静默进托盘不弹主界面。
 * 注意（Electron 44 实测）：
 *  ① 写与读都必须传同一组 args——getLoginItemSettings 比较的是完整命令行（path+args），
 *     写时带 --hidden，读时不带就会字符串不相等而误报「未写入」；
 *  ② 登录启动项的注册表值名 = 进程 AUMID 原样（不是 "electron.app."+productName）。AUMID 未设置
 *     成功时回落共享默认名 electron.app.Electron，会被其它 Electron 应用互相覆盖——必须在顶层
 *     用正确拼写 app.setAppUserModelId(...)（小写 d）唯一化，早期 因大写 D 拼写 +
 *     typeof 守卫静默跳过而退化到共享名。 */
function applyAutoStart(cfg) {
  try {
    if (typeof app.setLoginItemSettings !== 'function') return; // 无该 API（测试 mock/异常环境）静默跳过
    const want = !!(cfg && cfg.autoStart);
    // 无条件清理本应用残留启动项（开启/关闭都要清：关闭时也需移除旧版本目录的死条目）
    try { cleanupStaleRunEntries(); } catch (e2) {}
    // 显式传 path（默认值在某些环境可能与预期不符），args 固定 --hidden：开机自启唤起时静默进托盘
    app.setLoginItemSettings({ openAtLogin: want, path: process.execPath, args: ['--hidden'] });
  } catch (e) {
    logLine('warn', '[自启] 设置开机自启失败: ' + String(e && e.message || e));
  }
}
/** 从 getLoginItemSettings 的 launchItems 里取第一个匹配本程序 exe 的注册表值路径（Electron 返回的
 * 顶层 execPath 不存在，路径在 launchItems[i].path） */
function firstLaunchItemPath(s) {
  try { const li = s && s.launchItems; if (Array.isArray(li) && li.length && li[0] && li[0].path) return String(li[0].path); } catch (e) {}
  return '';
}
/** 清理本应用残留的登录启动项（值名 = 进程 AUMID 原样）。覆盖三类残留：
 *  ① 共享默认名 electron.app.Electron——AUMID 未设置成功时的回落名；
 *  ② 旧前缀名 electron.app.douyin-xuhuohua-helper——历史版本运行时的产物（如指向已删除的旧版本目录）；
 *  ③ 一切「路径落在本应用目录下但不是当前有效条目」的值——旧版本目录随发布删除后即成死条目，
 *    开机时 Windows 会尝试启动不存在的 exe（静默失败）。
 * 实现：getLoginItemSettings 的 launchItems 只含「指向当前 exe」的条目（实测），看不到其它名字的
 * 残留，故直接 reg query 枚举 HKCU\Run 全量对比清理。
 * 安全边界：① 只处理「路径落在本应用目录下」的条目，绝不触碰其它应用的启动项；当前有效条目
 * （douyin-xuhuohua-helper → 当前 exe）保留不动。② 仅打包版（XHHelper.exe）执行——dev/测试
 * 进程（node/electron.exe）一律跳过，避免测试误删真实注册表条目。 */
function cleanupStaleRunEntries() {
  try {
    if (!/xhhelper\.exe$/i.test(process.execPath)) return; // dev/测试门控：只有打包版才允许动注册表
    const cp = require('child_process');
    const q = cp.spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']);
    if (!q || q.status !== 0 || !q.stdout) return;
    // reg.exe 在中文 Windows 上输出 GBK（OEM 936）编码：按 utf8 解码会把中文路径变乱码，
    // 导致「路径含本应用目录」永远匹配不上而静默跳过清理，改用 GBK 解码
    let text;
    try { text = new TextDecoder('gbk').decode(q.stdout); }
    catch (eEnc) { text = q.stdout.toString('utf8'); }
    const target = normalizePath(process.execPath);
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s{4}(.+?)\s+REG_SZ\s+(.*)$/);
      if (!m) continue;
      const name = m[1].trim();
      const data = m[2].trim();
      const pm = data.match(/^"([^"]+)"/);
      const rawPath = pm ? pm[1] : data.split(' ')[0];
      const p = normalizePath(rawPath);
      if (p.indexOf('抖音续火花助手') < 0) continue; // 非本应用条目，不碰
      if (name === 'douyin-xuhuohua-helper' && p === target) continue; // 当前唯一名有效条目，保留
      const r = cp.spawnSync('reg',
        ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', name, '/f'],
        { stdio: 'ignore' });
      if (r && r.status === 0) logLine('info', '[自启] 已清理残留启动项: ' + name + ' → ' + rawPath);
      else logLine('info', '[自启] 残留启动项已不存在（无需清理）: ' + name);
    }
  } catch (e) {}
}
/** 归一化路径（转小写 + 反斜杠统一），供路径比较，避免大小写/分隔符差异造成误报 */
function normalizePath(p) { return String(p || '').trim().toLowerCase().replace(/\//g, '\\').replace(/\\+/g, '\\'); }
/** 读取当前系统登录启动项实际状态（供 UI/日志展示，区分「配置里想开」与「系统里是否真开了」）。
 * 必须与写入用同一组 args(['--hidden']) 读取，否则 Electron 比较完整命令行会误判为未写入。 */
function getAutoStartSetting() {
  try {
    const s = app.getLoginItemSettings({ args: ['--hidden'] });
    return { openAtLogin: !!(s && s.openAtLogin), execPath: firstLaunchItemPath(s), appPath: process.execPath };
  } catch (e) { return { openAtLogin: false, execPath: '', appPath: process.execPath }; }
}
function showMainWindow() {
  if (uiWin) { if (uiWin.isMinimized()) uiWin.restore(); uiWin.show(); uiWin.focus(); }
  else createUI();
}
function createTray() {
  try {
    // 托盘优先用专用 32px 小图标（小尺寸更清晰），无则回退主图标
    const trayIcon = path.join(DIR, 'ui', 'tray.png');
    const iconPath = fs.existsSync(trayIcon) ? trayIcon : path.join(DIR, 'ui', 'icon.png');
    const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA0AAAANCAYAAABy6+R8AAAAFElEQVR42mP8z8BQz0AEYBxVg0EAAAAxMDB7iL9n0wAAAABJRU5ErkJggg==');
    tray = new Tray(icon);
    tray.setToolTip('抖音续火花助手');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开主界面', click: function () { showMainWindow(); } },
      { label: '显示抖音页', click: function () { const acct = getActiveAccount(loadConfig()); const w = acct && acctState(acct.id).win; if (w && !w.isDestroyed()) { try { w.show(); } catch (e) {} } } },
      { label: '立即续火花', click: function () { runAutoOnce().then(function () {}); } },
      { type: 'separator' },
      { label: '退出', click: function () { app.quit(); } }
    ]));
    tray.on('click', showMainWindow);
    tray.on('double-click', showMainWindow);
  } catch (e) { logLine('warn', '[托盘] 创建失败: ' + String(e && e.message || e)); }
}

/* ---------------- 桥接路由（抖音页 -> 主进程 -> UI） ---------------- */
/* 桥接事件白名单：只接受我们注入脚本会发出的 name，未知 name 一律丢弃；
 * 参数做形状校验 + 长度/数量上限，避免抖音页面自身脚本（第三方不可信）伪造事件刷日志/刷 UI。 */
const BRIDGE_ALLOWED_NAMES = new Set([
  'qr', 'qrFailed', 'loginState', 'pageReady', 'friendList', 'enterChat',
  'sendResult', 'sendResult2', 'backList', 'progress', 'error', 'log',
  'chatData', 'chatDataAppend', 'chatDataSupplement'
]);
const BRIDGE_MAX_ARGS = 20;
// 单参数字符串上限 64KB：二维码 data URL（高 DPR/大画布下 base64 可超 4KB）与好友列表 JSON 等
// 合法大载荷不能被截断损坏；仍保留上限防页面脚本恶意刷大字符串（20×64KB≈1.25MB/事件，可控）
const BRIDGE_MAX_ARG_LEN = 65536;
function sanitizeBridgeArgs(args) {
  if (!Array.isArray(args) || args.length > BRIDGE_MAX_ARGS) return null;
  let bytes = 0;
  for (const arg of args) {
    if (typeof arg === 'string') {
      if (arg.length > BRIDGE_MAX_ARG_LEN) return null;
      bytes += Buffer.byteLength(arg, 'utf8');
    } else if (typeof arg !== 'boolean' && !(typeof arg === 'number' && Number.isFinite(arg))) return null;
  }
  return bytes <= 256 * 1024 ? args.slice() : null;
}
function trustedMainFrame(ev, isUI) {
  try {
    if (!ev || !ev.senderFrame || ev.senderFrame !== ev.sender.mainFrame) return false;
    const url = new URL(ev.senderFrame.url);
    if (isUI) return !!uiWin && ev.sender === uiWin.webContents && url.href === require('url').pathToFileURL(path.join(DIR, 'ui', 'index.html')).href;
    return url.protocol === 'https:' && isDouyinHost(url.href);
  } catch (e) { return false; }
}
const bridgeRates = new WeakMap();
function validBridgePayload(name, args) {
  const schemas = {
    qr: ['string', 'string'], qrFailed: ['string'], loginState: ['boolean'], pageReady: ['string', 'string'],
    friendList: ['string'], enterChat: ['boolean', 'string', 'string'], sendResult: ['boolean', 'string', 'string'],
    sendResult2: ['boolean', 'string', 'string', 'boolean'], backList: ['boolean', 'string'],
    progress: ['number', 'number', 'string', 'string'], error: ['string', 'string'], log: ['string', 'string'],
    chatData: ['string'], chatDataAppend: ['string'], chatDataSupplement: ['string']
  };
  const shape = schemas[name];
  if (!shape || !args || args.length !== shape.length || shape.some(function (type, i) { return typeof args[i] !== type; })) return false;
  if (name === 'friendList') {
    try {
      const rows = JSON.parse(args[0]);
      const fields = { id: 'string', nickname: 'string', avatarUrl: 'string', lastMessage: 'string', lastTimeText: 'string', hasSpark: 'boolean', unread: 'boolean', domIndex: 'number' };
      if (!Array.isArray(rows) || rows.length > 500) return false;
      return rows.every(function (row) {
        return row && typeof row === 'object' && !Array.isArray(row) && typeof row.nickname === 'string' && row.nickname.length <= 200 &&
          Object.keys(row).every(function (key) { return Object.hasOwn(fields, key) && typeof row[key] === fields[key] && (typeof row[key] !== 'string' || row[key].length <= 2048); });
      });
    } catch (e) { return false; }
  }
  return true;
}
ipcMain.on('dsx:bridge', function (ev, payload) {
  if (!trustedMainFrame(ev, false) || !payload || typeof payload !== 'object' || !BRIDGE_ALLOWED_NAMES.has(payload.name)) return;
  const accountId = accountByWebContents(ev.sender);
  if (!accountId) return;
  const args = sanitizeBridgeArgs(payload.args);
  if (!validBridgePayload(payload.name, args)) return;
  const now = Date.now();
  let rate = bridgeRates.get(ev.sender);
  if (!rate || now - rate.at >= 1000) { rate = { at: now, count: 0, bytes: 0 }; bridgeRates.set(ev.sender, rate); }
  rate.count++;
  rate.bytes += args.reduce(function (sum, arg) { return sum + (typeof arg === 'string' ? Buffer.byteLength(arg, 'utf8') : 8); }, 0);
  if (rate.count > 200 || rate.bytes > 1024 * 1024) return;
  handleBridge(accountId, payload.name, args);
});

function handleBridge(accountId, name, args) {
  const st = acctState(accountId);
  switch (name) {
    case 'qr': {
      const img = String(args[0] || ''); const text = String(args[1] || '');
      // 注入侧已按内容去重（未变不重复回推），这里只补账号标识便于多账号排查
      if (img) logLine('info', '[登录] ' + acctLabel(accountId) + '二维码已生成');
      else logLine('warn', '[登录] ' + acctLabel(accountId) + '二维码暂不可直接读取: ' + text);
      sendUI({ type: 'qr', accountId: accountId, image: img, text: text });
      break;
    }
    case 'qrFailed':
      logLine('warn', '[登录] 二维码获取失败: ' + String(args[0] || '')); sendUI({ type: 'qrFailed', accountId: accountId }); break;
    case 'loginState': {
      const ok = !!args[0];
      if (!ok && st.netFilterActive) {
        logLine('warn', '[网络] 检测到未登录，恢复网络连接以便重新扫码登录');
        setNetworkOffline(accountId, false);
      }
      const wu = st.win;
      const onChat = wu && (wu.getURL() || '').indexOf('/chat') >= 0;
      // 已登录过的会话页瞬时未登录：不上报 UI，避免闪烁
      if (!(!ok && onChat && st.chatGoOnce)) {
        sendUI({ type: 'loginState', accountId: accountId, loggedIn: ok });
      }
      if (ok) {
        st.lastLogin = true; // 脚本正向确认已登录：立即校正任何瞬间假未登录
        st.falseSince = 0;
        markNav(st);
        if (onChat) {
          st.chatGoOnce = true;
          logLine('info', '[登录] ' + acctLabel(accountId) + '已登录');
          autoParse(accountId);
        } else {
          navTo(accountId, chatUrl(), '已登录跳转会话页');
          logLine('info', '[登录] ' + acctLabel(accountId) + '已登录，跳转会话页');
        }
      } else {
        st.autoParsed = false; // 未登录时复位自动读取标记，真登录后再自动读
        const freshChat = onChat && (Date.now() - st.navAt) < 4000;
        if (freshChat) {
          logLine('info', '[登录] 会话页加载中，暂不判定');
        } else if (onChat && st.chatGoOnce) {
          // 已登录过且停在会话页却被判未登录：持续 45 秒才算真失效，避免一直刷新/弹跳
          st.falseSince = st.falseSince || Date.now();
          if (Date.now() - st.falseSince > 45000) {
            st.chatGoOnce = false;
            st.falseSince = 0;
            // 已在会话页持续 45 秒判未登录 = 会话真失效，回写登录态。此前桥接的 false 从不落
            // lastLogin，掉线后它长期停在 true → getAccountState 对已掉线账号报「已登录」，状态灯/Tab 徽标
            // 错误，手动操作还要白等 30 秒 waitForLogin。只在这一分支回写（其余分支可能是瞬时抖动）。
            st.lastLogin = false;
            // 导航统一走 navTo（3 秒重复保护），不再直接 loadURL
            navTo(accountId, homeUrl(), '长时间未登录切回首页');
            logLine('info', '[登录] ' + acctLabel(accountId) + '长时间未登录，已切回首页等待扫码');
          } else {
            logLine('info', '[登录] ' + acctLabel(accountId) + '会话页暂未确认登录（等待片刻）');
          }
        } else {
          st.falseSince = 0;
          logLine('info', '[登录] ' + acctLabel(accountId) + '当前未登录，请点「打开抖音页/刷新二维码」扫码');
        }
      }
      break;
    }
    case 'pageReady': logLine('info', '[页面] 就绪: ' + String(args[0] || '').slice(0, 120)); break;
    case 'friendList': handleFriendList(accountId, args[0]); break;
    case 'enterChat': sendUI({ type: 'enterChat', accountId: accountId, ok: !!args[0], nickname: String(args[1] || ''), message: String(args[2] || '') }); break;
    case 'sendResult':
      sendUI({ type: 'sendResult', accountId: accountId, ok: !!args[0], nickname: String(args[1] || ''), text: String(args[2] || '') });
      break;
    case 'sendResult2': {
      const waiter = sendWaits.get(accountId);
      if (notifySendResult(accountId, args[0], args[1], args[2], args[3])) {
        sendUI({ type: 'sendResult', accountId: accountId, ok: args[0], nickname: waiter.nickname, text: args[1] });
      }
      break;
    }
    case 'backList': sendUI({ type: 'backList', accountId: accountId, ok: !!args[0], message: String(args[1] || '') }); break;
    case 'progress':
      sendUI({ type: 'progress', accountId: accountId, index: Number(args[0] || 0), total: Number(args[1] || 0), nickname: String(args[2] || ''), stage: String(args[3] || '') });
      break;
    case 'error':
      logLine('error', '[脚本] ' + String(args[1] !== undefined ? args[1] : args[0] || ''));
      break;
    case 'log': {
      const level = String(args[0] || 'info'); const msg = String(args[1] || '');
      if (level === 'debug') break;
      const noisy = /CHAT-DIAG|IMGS#|QR-ELS|LOGIN-BTNS|DIALOGS#|FINGERPRINT|\[scroll\]|CHAT-LIST-DIAG/.test(msg);
      if (level === 'error') { logLine('error', '[douyin] ' + msg.slice(0, 1500)); break; }
      // FINGERPRINT 不再被 noisy 名单丢掉——它是排查「环境指纹是否被抖音判异常」的唯一基线，
      // 每次注入只打一条、成本极低；此前静默吞掉等于没有基线数据可查（本次登录问题排查就吃了这个亏）。
      if (/^FINGERPRINT:/.test(msg)) { logLine('info', '[douyin] ' + msg.slice(0, 1500)); break; }
      if (level === 'warn' && noisy) break;
      const interesting = /登录|二维码|解析|会话|发送|完成|失败|超时|找不到|进度|任务|注入|已登录|未登录/.test(msg);
      if (level === 'warn') { logLine('warn', '[douyin] ' + msg.slice(0, 1500)); break; }
      if (interesting) logLine('info', '[douyin] ' + msg.slice(0, 300));
      break;
    }
    default: break;
  }
}

function handleFriendList(accountId, jsonOrArr) {
  const st = acctState(accountId);
  // 空/损坏结果不覆盖内存也不推空列表给 UI（详见 guardFriendList 的实证与后果说明）
  const clean = guardFriendList(accountId, parseList(jsonOrArr), jsonOrArr, '桥接');
  if (!clean.length) return;
  st.latestFriends = clean;
  saveCachedFriends(accountId, clean);
  logLine('info', '[好友] ' + acctLabel(accountId) + '解析完成: ' + clean.length + ' 条会话');
  notifyFriends(accountId, clean);
}

/** 二维码主进程截图兜底：DOM 提取不到时，用 capturePage 截取登录卡片/二维码区域发给 UI。
 *  仅当抖音窗口可见时可靠（隐藏窗口 capturePage 返回空图）；失败静默返回 false，不影响原流程。 */
async function qrCaptureFallback(accountId, wu) {
  try {
    if (!wu || wu.isDestroyed()) return false;
    if (typeof wu.isVisible !== 'function' || !wu.isVisible()) return false;
    const wc0 = wu.webContents;
    if (!wc0) return false;
    // 先尝试取登录卡片/二维码区域矩形（页面脚本返回 null 则截全窗口）
    let rect = null;
    try {
      rect = await wc0.executeJavaScript(
        '(function(){var els=document.querySelectorAll("canvas,img[src*=qrcode],img[src*=qrcode],div[role=dialog]");' +
        'for(var i=0;i<els.length;i++){var e=els[i];var r=e.getBoundingClientRect&&e.getBoundingClientRect();' +
        'if(r&&r.width>100&&r.height>100&&r.width<900){return{x:r.left,y:r.top,width:r.width,height:r.height};}}return null;})()', true);
    } catch (e) {}
    let img;
    if (rect && rect.width > 0 && rect.height > 0) {
      img = await wc0.capturePage({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
    } else {
      img = await wc0.capturePage();
    }
    if (img && typeof img.isEmpty === 'function' && !img.isEmpty()) {
      const dataUrl = img.toDataURL();
      if (dataUrl && dataUrl.length > 100) {
        sendUI({ type: 'qr', accountId: accountId, image: dataUrl, text: '' });
        logLine('info', '[登录] 已用主进程截图兜底抓取二维码');
        return true;
      }
    }
  } catch (e) { logLine('warn', '[登录] 截图兜底失败: ' + String(e && e.message || e)); }
  return false;
}

/* ---------------- UI 调用（dsx:ui-invoke） ---------------- */
ipcMain.handle('dsx:ui-invoke', async function (ev, method, args) {
  if (!trustedMainFrame(ev, true)) return { ok: false, error: '不可信的界面来源' };
  const a = args || {};
  const cfgNow = loadConfig();
  const active = getActiveAccount(cfgNow);
  const accountId = String(a.accountId || '').trim() || (active ? active.id : '');
  const st = acctState(accountId);
  // 需要联网的手动操作：断网状态下自动恢复（兜底），sendTestEmail 走主进程 SMTP 不在此列
  if (st.netFilterActive && ['ensureLogin','extractQr','parseFriends','sendNow','logout','showDouyin'].indexOf(method) >= 0) {
    logLine('info', '[网络] 手动操作需要联网，自动恢复网络连接');
    setNetworkOffline(accountId, false);
  }
  switch (method) {
    case 'getConfig': return Object.assign(loadConfig(), { appVersion: APP_VERSION });
    case 'getAutoStart': return Object.assign({ configEnabled: !!(loadConfig().autoStart) }, getAutoStartSetting());
    case 'saveConfig': {
      // 密文保护标记只存在于 loadConfig 的内存态，不能先经迁移剥离。
      const input = a.config || {};
      if (!input.smtpPass && cfgNow.smtpPassUndecryptable) {
        input.smtpPassEnc = cfgNow.smtpPassEnc;
        input.smtpPassUndecryptable = true;
      }
      const ok = saveConfig(input);
      const cfg = migrateConfig(input);
      if (ok) {
        logLine('info', '[配置] 已保存');
        applyAutoStart(cfg); // 自启开关随配置落盘即同步到系统登录启动项
        rescheduleAll(cfg);
        const acct = getAccountById(cfg, accountId);
        if (acct && acct.networkMode !== 'auto' && st.netFilterActive) {
          logLine('info', '[网络] 网络模式切换为一直联网，恢复抖音页网络连接');
          setNetworkOffline(accountId, false);
        }
      }
      return { ok: ok };
    }
    case 'saveTargets': {
      const cfg = loadConfig();
      const acct = getAccountById(cfg, accountId);
      if (!acct) return { ok: false, error: '账号不存在' };
      acct.targets = dedupeTargets(Array.isArray(a.targets) ? (a.targets || []) : []); // 落盘即去重
      const ok = saveConfig(cfg);
      if (ok) scheduleAuto(accountId, acct); // 选择变化影响每好友定时，需重建定时器
      return { ok: ok };
    }
    case 'addAccount': {
      const cfg = loadConfig();
      cfg.accounts = cfg.accounts || [];
      const acct = Object.assign(accountDefaults(), { id: newAccountId(), name: '账号' + (cfg.accounts.length + 1) });
      cfg.accounts.push(acct);
      cfg.activeAccountId = acct.id;
      const ok = saveConfig(cfg);
      if (ok) startAccount(acct.id);
      return { ok: ok, account: acct };
    }
    case 'removeAccount': {
      const cfg = loadConfig();
      const idx = (cfg.accounts || []).findIndex(function (x) { return x.id === accountId; });
      if (idx < 0) return { ok: false, error: '账号不存在' };
      cancelAccountSend(accountId, '账号已删除，停止发送');
      if (st.win && !st.win.isDestroyed()) st.win.destroy();
      // 清登录态 + send-log + 关闭窗口 + 清运行时状态
      try { await session.fromPartition('persist:dsh-' + accountId).clearStorageData(); } catch (e) {}
      removeSendLogAccount(accountId);
      clearCachedFriends(accountId);
      const st0 = accounts.get(accountId);
      if (st0) {
        // 清干净该账号的全部运行时定时器（好友独立/全局/第二时段/断网计划）：
        // 否则闭包会一直持有已删除账号的 state，到点空跑、且离线过滤器可能残留在 session 上
        clearTimers(st0);
        if (st0.offlineTimer) { try { clearTimeout(st0.offlineTimer); } catch (e) {} st0.offlineTimer = null; }
      }
      if (st0 && st0.win && !st0.win.isDestroyed()) { try { st0.win.destroy(); } catch (e) {} }
      accounts.delete(accountId);
      cfg.accounts.splice(idx, 1);
      cfg.activeAccountId = cfg.accounts.length ? cfg.accounts[0].id : '';
      const ok = saveConfig(cfg);
      if (ok) rescheduleAll(cfg);
      return { ok: ok };
    }
    case 'renameAccount': {
      const cfg = loadConfig();
      const acct = getAccountById(cfg, accountId);
      if (!acct) return { ok: false, error: '账号不存在' };
      const nm = String(a.name || '').trim();
      if (nm) acct.name = nm;
      return { ok: saveConfig(cfg) };
    }
    case 'setActiveAccount': {
      const cfg = loadConfig();
      if (!getAccountById(cfg, a.accountId)) return { ok: false, error: '账号不存在' };
      cfg.activeAccountId = a.accountId;
      return { ok: saveConfig(cfg) };
    }
    case 'showDouyin': {
      const st2 = acctState(accountId);
      const w = st2.win;
      if (w && !w.isDestroyed()) {
        // 已登录时兜回会话列表页，避免显示窗口停在首页/离线页回不到消息页
        await ensureOnChat(accountId);
        try { w.show(); w.focus(); } catch (e) {}
      }
      return { ok: !!(w && !w.isDestroyed()) };
    }
    case 'hideDouyin': { const st2 = acctState(accountId); const w = st2.win; if (w && !w.isDestroyed()) w.hide(); return { ok: true }; }
    case 'logout': {
      cancelAccountSend(accountId, '账号退出登录，停止发送');
      if (st.win && !st.win.isDestroyed()) st.win.destroy();
      try {
        await session.fromPartition('persist:dsh-' + accountId).clearStorageData();
        logLine('info', '[退出账号] 已清除登录态(cookies/localStorage)');
      } catch (e) {
        return { ok: false, error: '清除登录态失败：' + String(e && e.message || e) };
      }
      st.lastLogin = false; st.autoParsed = false; st.chatGoOnce = false; st.falseSince = 0; st.navAt = 0;
      st.latestFriends = [];
      clearCachedFriends(accountId);
      sendUI({ type: 'loginState', accountId: accountId, loggedIn: false });
      // 退出账号会清空整个分区的 storageData（设备侧标识随之重置），同一账号短时间内反复
      // 退出/重登在抖音看来就是「新设备反复登录」——这里只导航一次（navTo 去重），不再叠加多余加载。
      if (!navTo(accountId, homeUrl(), '退出账号回首页')) {
        ensureDouyinWindow(accountId, homeUrl());
      }
      logLine('info', '[退出账号] 已退出当前账号，请重新扫码登录');
      return { ok: true };
    }
    case 'ensureLogin': {
      // 用户点「打开抖音页」：显式操作，允许一次「弹出登录窗」尝试（替代原轮询里的自动连点）
      ensureDouyinWindow(accountId);
      if (!st.injected) { const w2 = wc(accountId); if (w2) await injectDouyin(accountId, w2); }
      const wu = st.win;
      if (wu) {
        const url = wu.getURL() || '';
        if (st.lastLogin !== true) {
          // 未登录且停在会话页：先回首页，登录弹窗/扫码窗才会自动出现
          if (url.indexOf('/chat') >= 0) { if (navTo(accountId, homeUrl(), '未登录回首页')) await sleep(3000); }
        } else {
          if (url.indexOf('/chat') < 0) { if (navTo(accountId, chatUrl(), '已登录开会话页')) await sleep(2000); }
        }
        const w2 = wc(accountId);
        if (w2) { try { await w2.executeJavaScript('window.DouyinAuto && window.DouyinAuto.openLoginModalOnce && window.DouyinAuto.openLoginModalOnce()', true); } catch (e) {} }
      }
      await sleep(400);
      return { ok: !!wc(accountId) };
    }
    case 'extractQr': {
      const w = wc(accountId); if (!w) return { ok: false, error: '抖音窗口不可用' };
      const wu = st.win;
      if (wu && st.lastLogin !== true && (wu.getURL() || '').indexOf('/chat') >= 0) {
        if (navTo(accountId, homeUrl(), '未登录取二维码回首页')) await sleep(4500);
      }
      try {
        // 用户显式点了「刷新二维码」：允许一次弹出登录窗的尝试（有次数上限，失败也不影响下面的提取）
        try { await w.executeJavaScript('window.DouyinAuto && window.DouyinAuto.openLoginModalOnce && window.DouyinAuto.openLoginModalOnce()', true); } catch (e) {}
        const got = await w.executeJavaScript('window.DouyinAuto.extractQrCode()', true);
        // DOM 方式（canvas/img）没抓到二维码 → 主进程截图兜底（登录卡片区域），不依赖页面 API
        if (!got || !String(got).length) await qrCaptureFallback(accountId, wu);
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    }
    case 'detectLogin': {
      const w = wc(accountId); if (!w) return { loggedIn: !!st.lastLogin };
      try {
        const ok = await w.executeJavaScript('window.DouyinAuto ? window.DouyinAuto.detectLoginState() : undefined', true);
        // undefined=脚本未注入；'pending'=页面加载初期：均维持原状不写 false（与 detectLoginOnStartup 的  修复对齐）
        if (ok === undefined || ok === null || ok === 'pending') return { loggedIn: !!st.lastLogin };
        st.lastLogin = (ok === true); return { loggedIn: st.lastLogin };
      } catch (e) { return { loggedIn: !!st.lastLogin }; }
    }
    case 'getAccountState': {
      // 好友列表优先取内存，空则回填磁盘缓存（切换/重启不丢）
      if (!st.latestFriends || !st.latestFriends.length) {
        const cached = loadCachedFriends(accountId);
        if (cached.length) st.latestFriends = cached;
      }
      let loggedIn = st.lastLogin;
      const w = wc(accountId);
      // 只在「未知」时实时探测，且仅正向确认（明确已登录才置 true）——避免把页面加载中的瞬时假未登录写进 lastLogin
      if ((loggedIn === null || loggedIn === undefined) && w) {
        try {
          const v = await w.executeJavaScript('window.DouyinAuto && window.DouyinAuto.detectLoginState() === true', true);
          if (v === true) { loggedIn = true; st.lastLogin = true; }
        } catch (e) {}
      }
      // 已登录但还没有好友缓存：后台自动补读一次（切号免等待，读完后经 friends 事件回推）
      if (loggedIn === true && (!st.latestFriends || !st.latestFriends.length)) autoParse(accountId);
      return { friends: withSentToday(accountId, st.latestFriends || []), loggedIn: loggedIn, offline: !!st.netFilterActive };
    }
    case 'parseFriends': {
      // 已登录时先把抖音页兜回会话列表页再抓取（页面停留在首页/离线页会导致抓不到列表）
      await ensureOnChat(accountId);
      const w = wc(accountId); if (!w) return { ok: false, error: '抖音窗口不可用' };
      const ok = await waitForLogin(accountId, 30000);
      if (!ok) { logLine('warn', '[好友] 当前未登录，无法读取列表'); return { ok: false, error: '未登录' }; }
      try {
        const arr = await w.executeJavaScript('window.DouyinAuto.parseFriendList({}).then(function (j) { return JSON.parse(j); })', true);
        // 手动刷新入口必须与其他入口一致经过 dedupeFriends（曾漏了这里，
        // 注入侧双程扫描产生的重复行原样进内存/推 UI，好友列表每个好友并排出现两遍）
        // 并统一走空值闸门——空结果不再当「成功读到 0 条」返回 ok:true（界面会显示假成功），
        // 改为明确失败并保留原有列表
        const clean = guardFriendList(accountId, arr, arr, '手动');
        if (!clean.length) return { ok: false, error: '解析结果为空（已保留原有列表，未覆盖）' };
        st.latestFriends = clean;
        saveCachedFriends(accountId, clean);
        logLine('info', '[好友] ' + acctLabel(accountId) + '读取完成: ' + clean.length + ' 条');
        notifyFriends(accountId, clean);
        scheduleOffline(accountId, 60 * 1000, '好友列表读取完成 1 分钟');
        return { ok: true, count: clean.length };
      } catch (e) {
        logLine('error', '[好友] 解析失败: ' + String(e && e.message || e));
        return { ok: false, error: String(e && e.message || e) };
      }
    }
    case 'sendNow': {
      const r = await runSend(accountId, a);
      notifyProblems(accountId, r, '手动发送');
      return r;
    }
    case 'sendTestEmail': {
      // 用 UI 传入的当前表单值（不要求先保存）；不依赖 notifyOn 开关
      const cfg = Object.assign(loadConfig(), a);
      const host = String(cfg.smtpHost || '').trim();
      const user = String(cfg.smtpUser || '').trim();
      const pass = String(cfg.smtpPass || '');
      const to = String(cfg.smtpTo || '').trim();
      if (!host || !user || !pass || !to) {
        const missing = [];
        if (!host) missing.push('SMTP服务器(smtpHost)');
        if (!user) missing.push('发件账号(smtpUser)');
        if (!pass) missing.push('SMTP授权码(smtpPass)');
        if (!to) missing.push('收件邮箱(smtpTo)');
        return { ok: false, error: 'SMTP 未配置：缺少 ' + missing.join('、') + '，请先在设置里填写再试。' };
      }
      const title = '抖音续火花助手测试邮件';
      const body = '这是一封来自抖音续火花助手的测试邮件，说明邮箱提醒配置正确可用。\n发送时间：' + new Date().toLocaleString('zh-CN');
      try {
        await notifyMod.sendEmail(cfg, title, body);
        logLine('info', '[测试邮件] 测试邮件已发送成功');
        return { ok: true };
      } catch (e) {
        const emsg = String(e && e.message || e);
        logLine('warn', '[测试邮件] 发送失败: ' + emsg);
        return { ok: false, error: emsg };
      }
    }
    case 'generateTask': return generateSchtasks(accountId, a);
    case 'getSendHistory': return getSendHistory(accountId);
    case 'clearSendHistory': return clearSendHistory(accountId);
    default: return { ok: false, error: 'unknown method: ' + method };
  }
});

async function waitForLogin(accountId, timeoutMs) {
  const w = wc(accountId); if (!w) return false;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await executePage(accountId, w, 'window.DouyinAuto && window.DouyinAuto.detectLoginState() === true', Math.min(10000, Math.max(1, timeoutMs - (Date.now() - start))));
      if (ok) return true;
    } catch (e) { return false; }
    await sleep(2000);
  }
  return false;
}
/** 等待抖音页注入完成（最多 timeoutMs），注入状态由 dom-ready → injectDouyin 维护 */
async function waitInjected(accountId, timeoutMs) {
  const st = acctState(accountId);
  const t0 = Date.now();
  while (!st.injected && Date.now() - t0 < (timeoutMs || 15000)) { await sleep(500); }
  return !!st.injected;
}
/** 已登录时把抖音页兜回会话列表页（/chat）并等待注入；未登录/未知返回 false，不打断二维码流程 */
async function ensureOnChat(accountId) {
  const st = acctState(accountId);
  let w = st.win;
  if (!w || w.isDestroyed()) { ensureDouyinWindow(accountId); w = st.win; }
  if (!w || w.isDestroyed()) return false;
  // 登录态：信任 lastLogin；未知则实时正向确认（只在明确已登录时才置 true，避免瞬时假未登录覆盖）
  let logged = st.lastLogin;
  if (logged !== true && logged !== false) {
    try {
      const v = await w.webContents.executeJavaScript('window.DouyinAuto && window.DouyinAuto.detectLoginState() === true', true);
      if (v === true) { logged = true; st.lastLogin = true; }
    } catch (e) {}
  }
  if (logged !== true) return false;
  let url = '';
  try { url = w.getURL() || ''; } catch (e) {}
  const onChat = (url.indexOf('/chat') >= 0 || url.indexOf('/messages') >= 0);
  if (!onChat) {
    navTo(accountId, chatUrl(), '兜回会话页');
    st.injected = false;
    await waitInjected(accountId);
  } else if (!st.injected) {
    await waitInjected(accountId);
  }
  return true;
}

/* ---------- 发送引擎：逐好友注入原版 send_msg.js ---------- */
/* 发送结果等待器按账号隔离（Map），不再依赖全局单例；即便将来手动/定时并发也不串结果 */
const sendWaits = new Map(); // accountId -> { resolve, timer }
function notifySendResult(accountId, ok, detail, attemptId, retryable) {
  const waiter = sendWaits.get(accountId);
  if (!waiter || !attemptId || waiter.id !== attemptId) return false;
  sendWaits.delete(accountId);
  clearTimeout(waiter.timer);
  waiter.resolve({ ok: !!ok, detail: String(detail || ''), retryable: retryable === true });
  return true;
}
function cancelAccountSend(accountId, reason) {
  const waiter = sendWaits.get(accountId);
  if (waiter) notifySendResult(accountId, false, reason, waiter.id, false);
  const st = accounts.get(accountId);
  if (st) st.activeSendId = '';
}
function executePage(accountId, contents, code, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      const st = accounts.get(accountId);
      try { if (st && st.win && !st.win.isDestroyed() && st.win.webContents === contents) st.win.destroy(); }
      finally { reject(new Error('页面执行超时，已关闭无响应的抖音窗口')); }
    }, timeoutMs || 10000);
    Promise.resolve().then(function () { return contents.executeJavaScript(code, true); }).then(function (value) {
      clearTimeout(timer); resolve(value);
    }, function (error) { clearTimeout(timer); reject(error); });
  });
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
/* 发送日志内存缓存：避免每次推送列表/每个好友发送都全量读盘（JSON.parse 整文件）。
 * markSent/removeSendLogAccount 直接改写缓存对象并落盘，缓存保持最新；外部无并发写本文件。 */
let sendLogCache = null;
function loadSendLog() {
  if (sendLogCache !== null) return sendLogCache;
  try { sendLogCache = JSON.parse(fs.readFileSync(SENDLOG_FILE, 'utf8').replace(/^\uFEFF/, '')) || {}; }
  catch (e) { sendLogCache = {}; }
  return sendLogCache;
}
/** 发好友列表给 UI（附带「今日是否已续」标记） */
function notifyFriends(accountId, list) {
  sendUI({ type: 'friends', accountId: accountId, list: withSentToday(accountId, list) });
}
/** 给好友列表附带「今日是否已续」标记（供 UI 今日列与统计用） */
function withSentToday(accountId, list) {
  const log = loadSendLog();
  const acctLog = (log && log[accountId]) || {};
  const today = todayStr();
  // send-log 的键历史上按原始昵称写入，而好友昵称在注入侧已归一化（去零宽/压缩空白）；
  // 先建归一化索引再查，避免同一人因不可见字符差异被判成「今天没发过」而重复发送
  const sentNicks = Object.create(null);
  Object.keys(acctLog).forEach(function (k) { if (acctLog[k] === today) sentNicks[normFriendNick(k)] = 1; });
  return (list || []).map(function (f) {
    return Object.assign({}, f, { sentToday: !!(f && sentNicks[normFriendNick(f && f.nickname)]) });
  });
}
/** 发送日志键：嵌套为 {账号id: {昵称: 'YYYY-MM-DD'}}，避免不同账号同名好友串账 */
function markSent(accountId, nick) {
  try {
    const log = loadSendLog();
    if (!log[accountId]) log[accountId] = {};
    // 键统一写归一化昵称，并清掉同一人此前以原始昵称（可能带零宽字符/多余空白）留下的旧键，
    // 否则查表时可能命中旧日期，「今天已发过」判定失效 → 重复发送
    const key = normFriendNick(nick) || String(nick == null ? '' : nick);
    Object.keys(log[accountId]).forEach(function (old) {
      if (old !== key && normFriendNick(old) === key) delete log[accountId][old];
    });
    log[accountId][key] = todayStr();
    atomicWrite(SENDLOG_FILE, JSON.stringify(log, null, 2));
  } catch (e) {}
}
function wasSentToday(accountId, nick) {
  const log = loadSendLog();
  const acctLog = (log && log[accountId]) || {};
  const today = todayStr();
  const key = normFriendNick(nick);
  if (!key) return false;
  // 归一化比较：历史键可能是未归一化的原始昵称
  return Object.keys(acctLog).some(function (k) { return normFriendNick(k) === key && acctLog[k] === today; });
}

/* ---------- 续火花日历（send-history.json，每账号每天的执行结果） ----------
 * 结构：{账号id: {'YYYY-MM-DD': {ok, fail, total, skipped, status:'ok'|'fail', at}}}。
 * 记录时机：每次真正执行续火花后（手动/定时/自动统一走 runSend）；「最后一次执行结果为准」，同一天多次执行直接覆盖当天。 */
const SEND_HISTORY_FILE = path.join(DATA_DIR, 'send-history.json');
let sendHistoryCache = null;
function loadSendHistory() {
  if (sendHistoryCache !== null) return sendHistoryCache;
  try { sendHistoryCache = JSON.parse(fs.readFileSync(SEND_HISTORY_FILE, 'utf8').replace(/^\uFEFF/, '')) || {}; }
  catch (e) { sendHistoryCache = {}; }
  return sendHistoryCache;
}
/** 记录某账号某天的执行结果（最后一次为准）。只记录「真正跑过的」：无目标或 0成功0失败0跳过不写。 */
function recordSendHistory(accountId, info) {
  try {
    const total = Number(info && info.total) || 0;
    const ok = Number(info && info.ok) || 0;
    const fail = Number(info && info.fail) || 0;
    const skipped = Number(info && info.skipped) || 0;
    if (total <= 0) return;
    if (ok <= 0 && fail <= 0 && skipped <= 0) return;
    const hist = loadSendHistory();
    if (!hist[accountId]) hist[accountId] = {};
    const day = todayStr();
    const prev = hist[accountId][day];
    // 纯跳过空跑（0 成功 0 失败）不覆盖当天已有的真实执行结果（如上午已成功的记录），
    // 仅把跳过数并入明细——避免「第二时段兜底全跳过」把日历当天的成功明细冲掉。
    if (prev && ok <= 0 && fail <= 0 && (Number(prev.ok) || 0) > 0) {
      prev.skipped = Math.max(Number(prev.skipped) || 0, skipped);
      prev.at = new Date().toISOString();
      atomicWrite(SEND_HISTORY_FILE, JSON.stringify(hist, null, 2));
      return;
    }
    const status = fail > 0 ? 'fail' : 'ok';
    hist[accountId][day] = { ok: ok, fail: fail, total: total, skipped: skipped, status: status, at: new Date().toISOString() };
    atomicWrite(SEND_HISTORY_FILE, JSON.stringify(hist, null, 2));
  } catch (e) { /* 记录失败不影响发送流程 */ }
}
/** 清空某账号的日历记录 */
function clearSendHistory(accountId) {
  try {
    const hist = loadSendHistory();
    if (hist[accountId]) { delete hist[accountId]; atomicWrite(SEND_HISTORY_FILE, JSON.stringify(hist, null, 2)); }
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
/** 读取某账号的日历记录（供 UI） */
function getSendHistory(accountId) {
  const hist = loadSendHistory();
  return { history: (hist && hist[accountId]) || {} };
}

/** 防发错人：按昵称在好友列表中解析唯一会话 id。
 *  - 同名出现多次且无法唯一确定会话 → ambiguous=true（宁可停发也不猜）：
 *      a) 多个不同 id（真重名，列表读到了）；
 *      b) 同名多条、id 全取不到、但头像 URL 互不相同（真重名的两个不同好友，）；
 *      c) 同名多条且 id、头像都取不到（无法判定，停发）。
 *  - 例外（同人重复入列，放行）：同名多条但 id 全部相同；或 id 全空但头像身份键相同
 *    （抖音改版后 id 全站抓空，虚拟列表双程扫描会把同一会话重复收集，
 *     头像 CDN 对象按人唯一——同头像即同一会话，不再误拦；：头像按
 *     normFriendAvatar 归一化后比较，query 签名差异不再误判；：改按
 *     friendAvatarKey 比较，CDN 域名轮换（p3.huoshanimg.com / p11.douyinpic.com 指向
 *     同一对象）不再误判成真重名——这是「同一好友被连续多次误判停发」的根因）。
 *  - 唯一同名且唯一 id → 返回该 id
 *  - 无匹配 → 返回空 id（列表可能未读/过期，回退昵称匹配）
 */
function resolveSendTargetId(nickname, friends) {
  let sameCount = 0;
  let defaultAvatarCount = 0;
  const ids = new Set();
  const avatars = new Set();
  try {
    (Array.isArray(friends) ? friends : []).forEach(function (f) {
      if (f && normFriendNick(f.nickname) === normFriendNick(nickname)) {
        sameCount++;
        if (f.id) ids.add(String(f.id).trim());
        // 默认占位头像跨人相同，不能当身份；单独计数用于下面的 fail-closed
        if (isDefaultAvatarUrl(f.avatarUrl)) { defaultAvatarCount++; return; }
        // 头像归一化后再比较——同人两条快照头像 URL 仅 query 签名不同时，
        // 不应被误判为「真重名」拦停
        const av = friendAvatarKey(f.avatarUrl);
        if (av) avatars.add(av);
      }
    });
  } catch (e) {}
  if (ids.size > 1) return { ambiguous: true, id: '' };
  if (ids.size === 1) { let id = ''; ids.forEach(function (v) { id = v; }); return { ambiguous: false, id: id }; }
  // id 全空（抖音改版后常态）：同名多条时按头像区分——同人重复（头像一致）放行昵称回退，
  // 头像不一致（真重名）或头像信息全缺（无法判定）→ 停发
  if (sameCount > 1) {
    // 同名行里只要有一条用的是默认占位头像，就无法证明这些行是同一人 → 停发。
    // 不加这一条的话，「默认头像 + 真头像」的组合会让 avatars 只剩一个值而被放行（发错人）。
    if (defaultAvatarCount > 0) return { ambiguous: true, id: '' };
    return { ambiguous: avatars.size !== 1, id: '' };
  }
  return { ambiguous: false, id: '' };
}

async function sendToOne(accountId, w, nickname, message) {
  const st = acctState(accountId);
  const resolved = resolveSendTargetId(nickname, st.latestFriends);
  if (resolved.ambiguous) {
    logLine('warn', '[发送] 「' + nickname + '」昵称重名，已停止发送以防发错人');
    return { ok: false, detail: '昵称重名，无法确定唯一会话（防发错人）', retryable: false };
  }
  cancelAccountSend(accountId, '发送任务已被替换');
  const attemptId = require('crypto').randomUUID();
  st.activeSendId = attemptId;
  const expiresAt = Date.now() + 45000;
  const fullCode = 'window.__sendAttemptId=' + JSON.stringify(attemptId) + ';window.__sendDeadline=' + expiresAt +
    ';window.__sendName=' + JSON.stringify(nickname) + ';window.__sendId=' + JSON.stringify(resolved.id) +
    ';window.__sendText=' + JSON.stringify(message) + ';' + SEND_JS;
  const result = new Promise(function (resolve) {
    const timer = setTimeout(function () {
      notifySendResult(accountId, false, '发送结果未知（超时），已停止自动重试，请核对聊天记录', attemptId, false);
      if (st.win && !st.win.isDestroyed() && st.win.webContents === w) st.win.destroy();
    }, 45000);
    sendWaits.set(accountId, { id: attemptId, nickname: nickname, resolve: resolve, timer: timer });
  });
  executePage(accountId, w, fullCode + '\n;void 0;').catch(function (e) {
    notifySendResult(accountId, false, String(e && e.message || e), attemptId, false);
  });
  return result;
}
/** 发送串行化：同一时间多路触发（同刻独立时间/手动与定时撞车）时排队依次执行，互不干扰 */
let sendChain = Promise.resolve();
function runSend(accountId, a) {
  const p = sendChain.then(async function () {
    const st = acctState(accountId);
    st.sendBusy = true;
    try { return await runSendNow(accountId, a); }
    finally { st.sendBusy = false; }
  });
  sendChain = p.then(function () {}, function () {});
  // 发送完成后：auto 断网模式且已登录 → 1 分钟后彻底断网（给发送结果/状态同步留时间；未登录保持联网以便登录）
  return p.then(function (r) {
    const st = acctState(accountId);
    const acct = getAccountById(loadConfig(), accountId);
    if (acct && acct.networkMode === 'auto' && st.lastLogin === true && (!r || r.error !== '未登录')) {
      logLine('info', '[网络] 续火花完成，1 分钟后彻底断网');
      scheduleOffline(accountId, OFFLINE_AFTER_MS, '续火花完成 1 分钟');
    }
    // 发送完成后重新推送好友列表：刷新「今日已续」列与顶部「今日守护」状态卡（sentToday 按最新 send-log 重算）
    if (st.latestFriends && st.latestFriends.length) notifyFriends(accountId, st.latestFriends);
    return r;
  });
}
async function runSendNow(accountId, a) {
  const cfg = loadConfig();
  const acct = getAccountById(cfg, accountId);
  if (!acct) return { ok: false, error: '账号不存在' };
  const st = acctState(accountId);
  // 发送期间不允许「到点断网」打断：取消任何待触发的断网计划，发送完成后由 runSend 重新排定
  if (st.offlineTimer) { clearTimeout(st.offlineTimer); st.offlineTimer = null; }
  // 发送前：auto 断网模式下恢复网络并刷新页面状态（保证发送基于最新登录状态）
  if (st.netFilterActive) {
    logLine('info', '[网络] 发送前恢复网络并刷新页面状态');
    setNetworkOffline(accountId, false); // 内含 loadURL(chat) 恢复会话列表页面
    const dw = st.win;
    if (dw && !dw.isDestroyed()) {
      const t0 = Date.now();
      while (!st.injected && Date.now() - t0 < 15000) { await sleep(500); }
    }
  }
  let targets = (a && a.targets) ? a.targets : (acct.targets || []);
  targets = targets.map(function (t) { return (typeof t === 'string') ? t : (t && t.nickname ? t.nickname : ''); }).filter(Boolean);
  // 同一昵称一批只发一条——「跳过今天已发过」只在这之后过滤一次、循环内发完第一条
  // 只 markSent 不复查，重复昵称会让同一人收到两条（列表合并成一行后守卫也不再拦）
  const dedupedTargets = dedupeTargets(targets);
  if (dedupedTargets.length !== targets.length) {
    logLine('warn', '[发送] 目标里有 ' + (targets.length - dedupedTargets.length) + ' 个重复昵称，已按人去重（同一人一批只发一条）');
  }
  targets = dedupedTargets;
  let message = (a && a.message) || acct.message || '续火花啦 🔥🔥🔥';
  // 随机文案（可选开关）：开启时每次从全局快捷文案池随机抽一条
  if (acct.randomMessage && Array.isArray(cfg.quickMessages) && cfg.quickMessages.length > 0) {
    message = cfg.quickMessages[Math.floor(Math.random() * cfg.quickMessages.length)];
  }
  const skipSentToday = !!((a && a.skipSentToday) || acct.skipSentToday);
  if (!targets.length) return { ok: false, error: '未选择任何好友' };
  logLine('info', '[发送] 收到指令：目标 ' + targets.length + ' 个');
  const attemptCount = targets.length; // 记录日历用的当日目标数（含被「跳过今天已发过」滤掉的部分）
  // 「跳过今天已发过」过滤提前到窗口处理之前——全部跳过时不再拉起窗口；
  // 同时统一日历口径：total 恒为过滤前目标数，skipped 单独记（此前部分跳过的日子 total 少记跳过数）。
  if (skipSentToday) {
    const skipped = targets.filter(function (n) { return wasSentToday(accountId, n); });
    if (skipped.length) { targets = targets.filter(function (n) { return !wasSentToday(accountId, n); }); logLine('info', '[发送] 按「跳过今天已发过」跳过 ' + skipped.length + ' 个：' + skipped.join('、')); }
  }
  const skippedCount = attemptCount - targets.length;
  if (skipSentToday && !targets.length) {
    logLine('info', '[发送] 所有目标今天都已发过，跳过本次');
    recordSendHistory(accountId, { ok: 0, fail: 0, total: attemptCount, skipped: skippedCount });
    return { ok: true, done: 0, failed: 0, fails: [] };
  }
  let w = wc(accountId);
  if (!w) {
    // 抖音窗口被关闭后，发送前自动重建（登录态存 persist 分区，重建即恢复登录）
    logLine('info', '[发送] 抖音窗口已关闭，自动重建并等待就绪…');
    ensureDouyinWindow(accountId);
    const t0 = Date.now();
    while (!st.injected && Date.now() - t0 < 15000) { await sleep(500); }
    if (!st.injected) logLine('warn', '[发送] 抖音窗口重建后注入超时，可能影响本次发送');
    w = wc(accountId);
  }
  if (!w) {
    // 窗口不可用也是一轮真实失败——记入日历并携带 fails 供 notifyProblems 告警（此前静默且日历无记录）
    logLine('error', '[发送] 抖音窗口不可用，本轮 ' + targets.length + ' 个目标未发送');
    recordSendHistory(accountId, { ok: 0, fail: targets.length, total: attemptCount, skipped: skippedCount });
    return { ok: false, error: '抖音窗口不可用', fails: ['抖音窗口不可用（' + targets.length + ' 个目标未发送）'] };
  }
  if (st.lastLogin === false) {
    logLine('error', '[发送] 当前未登录，已直接跳过（请先扫码登录）');
    recordSendHistory(accountId, { ok: 0, fail: targets.length, total: attemptCount, skipped: skippedCount });
    return { ok: false, error: '未登录', fails: ['当前未登录（' + targets.length + ' 个目标被跳过）'] };
  }
  let done = 0; const fails = [];
  try {
    // 快速探测：明确未登录（二维码/登录弹窗）立即返回，避免 waitForLogin 傻等 30 秒
    // 表达式取 detectLoginState() 原始三态（true/false/'pending'/null）。页面重载瞬间脚本
    // 处于加载初期会按 'pending' 上报，不再被 `=== true` 压成 false 误判成「未登录」整轮跳过
    // （曾出现到点触发后目标全部被跳过的根因）；且首次明确 false 后延时 3s 复测一次，
    // 二次确认仍 false 才跳过——真未登录最多多等 3 秒，加载竞态不再误杀。
    const quickProbe = async function () {
      const v = await executePage(accountId, w, 'window.DouyinAuto ? window.DouyinAuto.detectLoginState() : null');
      return (v === true) ? true : (v === false ? false : null);
    };
    let quickLogin = await quickProbe();
    if (quickLogin === false) {
      await sleep(3000);
      quickLogin = await quickProbe();
      if (quickLogin !== false) logLine('info', '[发送] 复测登录态已恢复，继续发送流程');
    }
    if (quickLogin === false) {
      logLine('error', '[发送] 当前未登录（快速探测），已跳过');
      recordSendHistory(accountId, { ok: 0, fail: targets.length, total: attemptCount, skipped: skippedCount });
      return { ok: false, error: '未登录', fails: ['当前未登录（' + targets.length + ' 个目标被跳过）'] };
    }
    const ok = await waitForLogin(accountId, 30000);
    if (!ok) {
      logLine('error', '[发送] 未登录，无法发送');
      recordSendHistory(accountId, { ok: 0, fail: targets.length, total: attemptCount, skipped: skippedCount });
      return { ok: false, error: '未登录', fails: ['当前未登录（' + targets.length + ' 个目标被跳过）'] };
    }
    st.lastLogin = true; // 发送前确认已登录即回写状态——发送完成后据此排定自动断网，避免 lastLogin 停留在未知导致漏断网
    logLine('info', '[发送] 开始向 ' + targets.length + ' 个好友续火花');
    for (let i = 0; i < targets.length; i++) {
      if (!getAccountById(loadConfig(), accountId) || wc(accountId) !== w || st.lastLogin === false) {
        targets.slice(i).forEach(function (nick) { fails.push(nick + ': 账号或页面状态已改变，停止发送'); });
        break;
      }
      const nick = targets[i];
      let res = await sendToOne(accountId, w, nick, message);
      if (!res || !res.ok) {
        // 发送失败自动重试 2 次（保险：确保火花能续上）
        for (let rtry = 0; rtry < 2 && res && !res.ok && res.retryable === true; rtry++) {
          await sleep(2000 + Math.floor(Math.random() * 2000));
          logLine('warn', '[发送] 「' + nick + '」发送失败，自动重试 ' + (rtry + 1) + '/2');
          res = await sendToOne(accountId, w, nick, message);
        }
      }
      if (res && res.ok) { done++; markSent(accountId, nick); logLine('info', '[发送] (' + (i + 1) + '/' + targets.length + ') ✅ ' + nick); }
      else {
        const why = ((res && res.detail) || '未知原因');
        fails.push(nick + ': ' + why);
        logLine('warn', '[发送] (' + (i + 1) + '/' + targets.length + ') ❌ ' + nick + ': ' + why);
      }
      if (i < targets.length - 1) {
        // 发送间隔：随机间隔开启时在 [intervalMs, intervalMaxMs] 间随机，否则固定 intervalMs
        let delay = acct.intervalMs || 2000;
        if (acct.randomInterval) {
          const max = Math.max(acct.intervalMaxMs || (delay + 6000), delay);
          delay = delay + Math.floor(Math.random() * (max - delay + 1));
        }
        await sleep(delay);
      }
    }
    logLine('info', '[发送] 队列完成: 成功 ' + done + ' / 失败 ' + fails.length);
    recordSendHistory(accountId, { ok: done, fail: fails.length, total: attemptCount, skipped: skippedCount });
    return { ok: true, done: done, failed: fails.length, fails: fails };
  } catch (e) {
    logLine('error', '[发送] 过程异常: ' + String(e && e.message || e));
    while (done + fails.length < targets.length) fails.push('未完成发送: ' + String(e && e.message || e));
    recordSendHistory(accountId, { ok: done, fail: fails.length, total: attemptCount, skipped: skippedCount });
    return { ok: false, error: String(e && e.message || e), fails: fails };
  }
}

/* ---------- 每好友独立定时 + 全局统一时间 ---------- */
/** 解析某好友的独立时间：targets[i].time 优先，其次 friendTimes[昵称]，未设为 null（用全局 time） */
function resolveFriendTime(cfg, target) {
  const nick = (typeof target === 'string') ? target : (target && target.nickname) || '';
  if (!nick) return null;
  if (target && typeof target === 'object' && target.time) return String(target.time);
  const ft = (cfg && cfg.friendTimes) ? cfg.friendTimes[nick] : '';
  if (ft) return String(ft);
  // friendTimes 的键历史上按原始昵称写入，昵称含零宽字符/多余空白时精确查表会落空，
  // 该好友的独立时间会被忽略并退回全局时间（到点发错时间）——按归一化昵称兜底再查一次
  if (cfg && cfg.friendTimes) {
    const key = normFriendNick(nick);
    const hit = Object.keys(cfg.friendTimes).filter(function (k) {
      return cfg.friendTimes[k] && normFriendNick(k) === key;
    })[0];
    if (hit) return String(cfg.friendTimes[hit]);
  }
  return null;
}
/** 由配置推导排定计划：独立时间好友（单人触发）+ 全局统一时间覆盖名单 */
function buildFriendSchedule(cfg) {
  const plan = { friends: [], globalNicks: [] };
  const targets = Array.isArray(cfg && cfg.targets) ? cfg.targets : [];
  targets.forEach(function (t) {
    const nick = (typeof t === 'string') ? t : (t && t.nickname) || '';
    if (!nick) return;
    const ft = resolveFriendTime(cfg, t);
    if (ft) plan.friends.push({ nick: nick, time: ft });
    else plan.globalNicks.push(nick);
  });
  return plan;
}
/** 计算到下一次执行的时间（过了就往明天推） */
function nextTime(hhmm, now) {
  const parts = String(hhmm || '').split(':').map(Number);
  const hh = (parts[0] >= 0 && parts[0] <= 23) ? parts[0] : 9;
  const mm = (parts[1] >= 0 && parts[1] <= 59) ? parts[1] : 0;
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target;
}
/* 常驻定时：每条已选好友的独立定时单独排，全局统一定时单独排；每次保存配置后重建全部定时器 */
const PREPARE_BEFORE_MS = 5 * 60 * 1000; // 定时到点前 5 分钟预联网+刷新
const OFFLINE_AFTER_MS = 60 * 1000;      // 续完火花 1 分钟后彻底断网

/** 定时到点前预联网 + 刷新好友列表（保险：避免到点网络慢来不及加载导致续火花失败） */
async function prepareForSend(accountId) {
  const st = acctState(accountId);
  if (!st.netFilterActive) return; // 一直联网模式无需准备
  logLine('info', '[网络] 距续火花约 5 分钟，提前恢复网络并刷新好友列表…');
  setNetworkOffline(accountId, false);
  const dw = st.win;
  if (dw && !dw.isDestroyed()) {
    const t0 = Date.now();
    while (!st.injected && Date.now() - t0 < 15000) { await sleep(500); }
  }
  const w = wc(accountId);
  if (w) {
    try {
      const arr = await w.executeJavaScript('window.DouyinAuto && window.DouyinAuto.parseFriendList({}).then(function (j) { return JSON.parse(j); })', true);
      // 与其余三个入口统一走空值闸门（此处原本就有 if(clean.length) 保护，但空结果静默无日志）
      const clean = guardFriendList(accountId, arr, arr, '预刷新');
      if (clean.length) { st.latestFriends = clean; saveCachedFriends(accountId, clean); }
      logLine('info', '[网络] ' + acctLabel(accountId) + '好友列表已刷新（' + (st.latestFriends ? st.latestFriends.length : 0) + ' 条）');
    } catch (e) { logLine('warn', '[网络] 刷新好友列表失败: ' + String(e && e.message || e)); }
  }
}
function clearTimers(st) {
  st.timersGeneration++;
  Object.keys(st.friendTimers).forEach(function (k) { try { st.friendTimers[k](); } catch (e) {} delete st.friendTimers[k]; });
  if (st.globalTimer) { try { st.globalTimer(); } catch (e) {} st.globalTimer = null; }
  if (st.globalTimer2) { try { st.globalTimer2(); } catch (e) {} st.globalTimer2 = null; }
}
/** 每日自举定时器：到点执行 taskFn，完成后自动重排到下一个 HH:MM（次日）。
 *  每个定时器独立管理自己、互不干扰；配置变化时 clearTimers 递增代际作废旧的未触发/自举。返回 cancel。 */
function scheduleDailyAt(accountId, st, hhmm, taskFn) {
  const gen = st.timersGeneration;
  let timer = null;
  let prepareTimer = null;
  function arm() {
    if (gen !== st.timersGeneration) return;
    const now = new Date();
    const tgt = nextTime(hhmm, now);
    const waitMs = Math.max(tgt.getTime() - now.getTime(), 1000);
    // 提前 5 分钟预联网 + 刷新（断网模式保险，一直联网模式内部自动跳过）
    const prepareWait = waitMs - PREPARE_BEFORE_MS;
    if (prepareWait > 0) prepareTimer = setTimeout(function () { prepareForSend(accountId); }, prepareWait);
    timer = setTimeout(function () {
      timer = null;
      Promise.resolve().then(function () { return taskFn(); })
        .catch(function (e) { logLine('warn', '[定时] 任务执行异常: ' + String(e && e.message || e)); })
        .then(function () { if (gen === st.timersGeneration) arm(); });
    }, waitMs);
  }
  arm();
  return function cancel() {
    if (timer) { try { clearTimeout(timer); } catch (e) {} timer = null; }
    if (prepareTimer) { try { clearTimeout(prepareTimer); } catch (e) {} prepareTimer = null; }
  };
}
/** HH:MM → 一天内的分钟数（非法/缺省按 0）。字符串比较判不出跨午夜次序，统一换算成分钟再比。 */
function hhmmToMinutes(s) {
  const p = String(s == null ? '' : s).trim().split(':');
  const h = Number(p[0]), m = Number(p[1]);
  return (isFinite(h) ? h : 0) * 60 + (isFinite(m) ? m : 0);
}
/** 第二时段（兜底补发）次序冲突判定（含次序告警与跨午夜判定，阈值 6 小时）。
 *  入参 [{label, time}]，返回会在第二时段之后「不久」再发一次的条目 label（供告警文案拼接）。
 *  两类冲突：
 *   1) 同日更晚（t > second）：兜底提前发出，其后的定时可能再发一遍（关闭「跳过今天已发过」时）；
 *   2) 跨午夜紧邻（t ≤ second 且从第二时段到 t 不足 SECOND_SLOT_WRAP_WINDOW_MIN）：兜底发完按当天
 *      记账，午夜一过日期翻新，「跳过今天已发过」是按日期判定的，于是失效——好友会在几小时内收到两条。
 *       前用补零字符串比较（'23:00' > '00:00' 为假），第 2 类完全判不出来。
 *  窗口取 6 小时而非半天：半天会把「全局 09:00 + 第二时段 22:00」这类最常见的正常配置误判成冲突
 *  （间隔 660 分 < 720），每次改第二时段都弹确认框、每次重建定时器都打 warn——而那种情形下兜底发完
 *  到次日主时段隔了一整夜，本就是正常的每日节奏。要拦的是「同一晚几小时内连发两条」（如 23:00 + 01:00）。
 *  完全同刻由「今天已发过」跳过，不算冲突。 */
const SECOND_SLOT_WRAP_WINDOW_MIN = 360;
function secondSlotOrderConflicts(secondTime, items) {
  const s = hhmmToMinutes(secondTime);
  const out = [];
  (Array.isArray(items) ? items : []).forEach(function (it) {
    if (!it) return;
    const m = hhmmToMinutes(it.time);
    if (m > s) { out.push(it.label); return; }
    if (m === s) return;
    if (1440 - s + m < SECOND_SLOT_WRAP_WINDOW_MIN) out.push(it.label);
  });
  return out;
}
function scheduleAuto(accountId, acct) {
  const st = acctState(accountId);
  clearTimers(st);
  if (!acct || !acct.auto) return;
  const plan = buildFriendSchedule(acct);
  plan.friends.forEach(function (f, fi) {
    // 键加序号：重复昵称的好友各自独立句柄，不再互相覆盖（清理仍由 clearTimers 全量遍历，）
    st.friendTimers[f.nick + '#' + fi] = scheduleDailyAt(accountId, st, f.time, function () {
      logLine('info', '[定时] 好友「' + f.nick + '」独立时间到点，单独发送');
      return runSingleFriend(accountId, f.nick);
    });
    logLine('info', '[定时] 好友「' + f.nick + '」独立时间 ' + f.time + ' 已排定（首次执行于 ' + nextTime(f.time, new Date()).toLocaleString('zh-CN') + '，之后每日自举重排）');
  });
  const globalTime = (acct && acct.time) || '09:00';
  if (plan.globalNicks.length) {
    const nicks = plan.globalNicks.slice();
    st.globalTimer = scheduleDailyAt(accountId, st, globalTime, function () {
      logLine('info', '[定时] 全局统一时间 ' + globalTime + ' 到点（覆盖未设独立时间的好友 ' + nicks.length + ' 个）');
      return runGlobalBatch(accountId, nicks);
    });
    logLine('info', '[定时] 全局统一时间 ' + globalTime + ' 已排定：覆盖未设独立时间的好友 ' + nicks.length + ' 个（首次执行于 ' + nextTime(globalTime, new Date()).toLocaleString('zh-CN') + '，之后每日自举重排）');
  } else if (plan.friends.length) {
    logLine('info', '[定时] 所有已选好友均设了独立时间，无需全局统一定时');
  }
  // 第二时段兜底（可选开关）：早时段没发成功的，晚时段再补发一次
  if (acct.secondTimeEnabled && acct.secondTime) {
    const secondTime = acct.secondTime;
    // 第二时段早于全局/独立时间时告警——兜底会提前把对应好友发出，其后的定时可能重复发送
    // 改用分钟数判定（secondSlotOrderConflicts），补上跨午夜紧邻的漏判（补零字符串比较判不出）
    const slotItems = plan.friends.map(function (f) { return { label: '「' + f.nick + '」' + f.time, time: f.time }; });
    if (plan.globalNicks.length) slotItems.push({ label: '全局时间 ' + globalTime, time: globalTime });
    const later = secondSlotOrderConflicts(secondTime, slotItems);
    if (later.length) logLine('warn', '[定时] 第二时段 ' + secondTime + ' 早于以下设定时间（' + later.join('、') + '），到点会提前发送，其后的定时可能重复（跨午夜紧邻时「跳过今天已发过」还会因日期翻新失效）——建议把第二时段设到所有时间之后');
    st.globalTimer2 = scheduleDailyAt(accountId, st, secondTime, function () {
      logLine('info', '[定时] 第二时段 ' + secondTime + ' 到点，兜底补发未续火花的好友');
      st.autoRunStamp = todayStr(); // 第二时段也是常驻定时批次，同样标记防计划任务重复
      const c = getAccountById(loadConfig(), accountId);
      // 兜底语义（与 UI 提示/使用说明一致）：只补发「今天还没发送成功」的好友，强制 skipSentToday=true。
      // 若透传用户的 skipSentToday（可能为 false），第二时段会把早时段已成功发送的好友整批重发一遍。
      // 与其它定时路径对齐补上 notifyProblems——第二时段未登录/发送失败此前静默、无告警邮件。
      return runSend(accountId, { targets: (c ? c.targets : []), message: (c ? c.message : undefined), intervalMs: (c ? c.intervalMs : undefined), skipSentToday: true })
        .then(function (r) { notifyProblems(accountId, r, '第二时段兜底补发'); return r; });
    });
    logLine('info', '[定时] 第二时段 ' + secondTime + ' 已排定（首次执行于 ' + nextTime(secondTime, new Date()).toLocaleString('zh-CN') + '，之后每日自举重排，兜底补发）');
  }
}
/** 独立定时到点：只发该好友 */
async function runSingleFriend(accountId, nick) {
  const acct = getAccountById(loadConfig(), accountId);
  if (!acct || !acct.auto) return;
  acctState(accountId).autoRunStamp = todayStr(); // 标记常驻定时今天已执行过该账号批次（供计划任务 --auto 防重复）
  const r = await runSend(accountId, { targets: [nick], message: acct.message, intervalMs: acct.intervalMs, skipSentToday: acct.skipSentToday });
  notifyProblems(accountId, r, '好友「' + nick + '」独立定时');
}
/** 全局统一时间到点：发全部未设独立时间的已选好友 */
async function runGlobalBatch(accountId, globalNicks) {
  const acct = getAccountById(loadConfig(), accountId);
  if (!acct || !acct.auto || !globalNicks.length) return;
  acctState(accountId).autoRunStamp = todayStr(); // 标记常驻定时今天已执行过该账号批次（供计划任务 --auto 防重复）
  const r = await runSend(accountId, { targets: globalNicks, message: acct.message, intervalMs: acct.intervalMs, skipSentToday: acct.skipSentToday });
  notifyProblems(accountId, r, '全局统一时间自动发送');
}
/** 重建所有账号的定时（每账号独立 scheduleAuto） */
function rescheduleAll(cfg) {
  (cfg && Array.isArray(cfg.accounts) ? cfg.accounts : []).forEach(function (acct) { scheduleAuto(acct.id, acct); });
}
/** 启动一个账号：确保窗口 + 检测登录 + 排定其定时 */
function startAccount(accountId) {
  const acct = getAccountById(loadConfig(), accountId);
  if (!acct) return;
  ensureDouyinWindow(accountId);
  // 启动即回填好友缓存（切换/重启不丢，UI 经 getAccountState 拉取）
  const st = acctState(accountId);
  const cached = loadCachedFriends(accountId);
  if (cached.length) st.latestFriends = cached;
  detectLoginOnStartup(accountId);
  scheduleAuto(accountId, acct);
}
/** 删除某账号在 send-log 里的记录 */
function removeSendLogAccount(accountId) {
  try {
    const log = loadSendLog();
    if (log[accountId]) { delete log[accountId]; atomicWrite(SENDLOG_FILE, JSON.stringify(log, null, 2)); }
  } catch (e) {}
}

/* Windows 计划任务（沙箱内不实际创建，生成 bat 由本机运行；按全局统一时间兜底） */
function generateSchtasks(accountId, a) {
  const acct = getAccountById(loadConfig(), accountId);
  let time = String((a && a.time) || (acct && acct.time) || '09:00');
  // 白名单校验 + 补零：time 会被原样拼进 schtasks 命令行（install-task.bat），手改 config 注入命令在此拦下
  const tm = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!tm) return { ok: false, error: '时间格式须为 HH:MM（24 小时制，如 09:30）' };
  time = ('0' + tm[1]).slice(-2) + ':' + tm[2];
  const startBat = IS_PACKAGED ? path.join(path.dirname(process.execPath), '启动续火花助手.bat') : path.join(DIR, '启动续火花助手.bat');
  const createCmd = 'schtasks /Create /TN "DY-XH-Auto-Spark" /TR "\"' + startBat + '\" --auto" /SC DAILY /ST ' + time + ' /F';
  const deleteCmd = 'schtasks /Delete /TN "DY-XH-Auto-Spark" /F';
  const content = [
    '@echo off',
    'chcp 65001 >nul',
    'echo =====================',
    'echo  抖音自动续火花 - 计划任务',
    'echo  每天 ' + time + ' 自动执行一次（全部账号各自已选好友一起发送；各账号的独立时间仅应用常驻时生效）',
    'echo =====================',
    createCmd,
    'echo.',
    'echo 已创建/更新。删除任务用下面命令：',
    'echo ' + deleteCmd,
    'pause'
  ].join('\r\n');
  const filePath = path.join(DATA_DIR, 'install-task.bat');
  try { ensureDirs(); fs.writeFileSync(filePath, content, 'utf8'); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  return { ok: true, file: filePath, create: createCmd, delete: deleteCmd };
}

/** 执行一次自动发送（免界面）：依次发送全部账号各自的已选好友。CLI 与常驻代执行共用。
 *  opts.skipIfTimerRanToday：计划任务 --auto 唤醒常驻实例代执行时传 true——
 *  若该账号今天的定时批次（独立/全局/第二时段）已由常驻定时执行过则跳过，防止同日双触发重复发送。
 *  时序依据：常驻定时到点瞬间触发（毫秒级），计划任务拉起新进程再经单实例锁转发（秒级），几乎必然定时先跑；
 *  托盘「立即续火花」等手动调用不传该选项，永不受此闸门影响。 */
async function runAutoOnce(opts) {
  const cfg = loadConfig();
  const accts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
  if (!accts.length) {
    logLine('info', '[自动] 未配置任何账号，跳过本次');
  } else {
    for (const acct of accts) {
      if (!Array.isArray(acct.targets) || !acct.targets.length) {
        logLine('info', '[自动] 账号「' + acct.name + '」未选择好友，跳过');
        continue;
      }
      if (opts && opts.skipIfTimerRanToday && acctState(acct.id).autoRunStamp === todayStr()) {
        logLine('info', '[自动] 账号「' + acct.name + '」今天的定时批次已由常驻定时执行过，计划任务本次跳过（防重复发送）');
        continue;
      }
      const r = await runSend(acct.id, { targets: acct.targets, message: acct.message, intervalMs: acct.intervalMs, skipSentToday: acct.skipSentToday });
      notifyProblems(acct.id, r, '自动发送');
    }
  }
  logLine('info', '[自动] 结束');
}
/* 自动模式 CLI（计划任务调用）：免界面 -> 单账号发送全部已选好友 -> 退出 */
async function runAutoCli() {
  logLine('info', '[自动模式] 启动 (--auto)');
  try { await runAutoOnce(); await sleep(500); }
  finally { app.quit(); }
}

/* ---------------- 生命周期 ---------------- */
function createDouyin() {
  const cfg = loadConfig();
  const accounts0 = Array.isArray(cfg.accounts) ? cfg.accounts : [];
  if (!accounts0.length) { runAutoCli().catch(function (e) { logLine('error', String(e)); }); return; }
  const w = ensureDouyinWindow(accounts0[0].id);
  if (autoMode && !autoStarted && w) {
    let timer;
    const start = function () {
      if (autoStarted) return;
      autoStarted = true;
      clearTimeout(timer);
      runAutoCli().catch(function (e) { logLine('error', '[自动模式] ' + String(e && e.message || e)); });
    };
    timer = setTimeout(start, 20000);
    w.webContents.once('dom-ready', start);
  }
}
/** 可放行的导航域名白名单（抖音及其资源域的子域均可）；非 http(s) 或非白名单域名一律拦截，收窄抖音窗口的导航面 */
const NAV_ALLOW_HOSTS = ['douyin.com', 'douyinvod.com', 'byteimg.com', 'amemv.com', 'douyinpic.com', 'zjcdn.com', 'snssdk.com', 'bytedance.com', 'bytedance.net', 'yhgfb-cn-static.com'];
function isAllowedNavigationUrl(url) {
  const s = String(url || '');
  if (!/^https?:\/\//i.test(s)) return false;
  let host = '';
  try { host = new URL(s).hostname.toLowerCase(); } catch (e) { return false; }
  for (let i = 0; i < NAV_ALLOW_HOSTS.length; i++) {
    const h = NAV_ALLOW_HOSTS[i];
    if (host === h || host.slice(-(h.length + 1)) === '.' + h) return true;
  }
  return false;
}
/** 子框架（iframe）导航判定：只拦非 http(s) 协议（深链/脚本协议，防 Windows 弹「打开方式」）。
 *  为什么不再套域名白名单：抖音登录前的无感安全验证（rmc-nocaptcha）等风控组件是经子框架加载的，
 *   就因白名单漏放 lf-rc1.yhgfb-cn-static.com 导致二维码出不来、扫码登录卡死；验证域名由抖音
 *  随时更换/新增，硬编码白名单等于把「登录能否完成」押在一张域名表上，且失败表现就是「系统繁忙，请重启
 *  应用或刷新页面后重试」这类无从排查的报错。子框架内容受 webPreferences 隔离，放行 https 不影响主窗口
 *  导航安全（顶层 will-navigate 仍严格白名单，window.open 仍一律拒绝）。 */
function shouldBlockFrameNavigation(url) {
  return !/^https?:\/\//i.test(String(url || ''));
}
/** 导航类日志的一次性去重：同一 URL 只记一次、最多 200 条，避免子框架/弹窗尝试刷日志 */
const NAV_LOG_ONCE = new Set();
function logNavOnce(prefix, url) {
  const key = String(url || '').slice(0, 160);
  if (!key || NAV_LOG_ONCE.has(key) || NAV_LOG_ONCE.size >= 200) return;
  NAV_LOG_ONCE.add(key);
  try { logLine('info', '[导航] ' + prefix + ': ' + key); } catch (e) {}
}
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', function (ev, argv) {
    const extra = Array.isArray(argv) ? argv : [];
    if (extra.indexOf('--auto') >= 0) {
      // 计划任务到点：常驻实例代执行一次自动发送（不退出，保持窗口/托盘常驻）
      logLine('info', '[计划任务] 常驻实例收到 --auto，代执行一次自动发送');
      runAutoOnce({ skipIfTimerRanToday: true });
      return;
    }
    if (extra.indexOf('--hidden') >= 0) return; // 定时唤起的隐藏实例不弹窗
    showMainWindow();
  });
  app.on('web-contents-created', function (e2, contents) {
    const prefs = contents.getLastWebPreferences ? contents.getLastWebPreferences() : {};
    const isUI = path.basename(prefs.preload || '') === 'preload-ui.js';
    contents.on('will-redirect', function (ev, url, inPlace, isMainFrame) {
      const target = ev.url || url;
      const mainFrame = typeof ev.isMainFrame === 'boolean' ? ev.isMainFrame : isMainFrame;
      if (isUI || (mainFrame ? !isAllowedNavigationUrl(target) : shouldBlockFrameNavigation(target))) ev.preventDefault();
    });
    contents.on('will-navigate', function (ev, url) {
      // 仅放行抖音/相关域名；外部协议、非白名单 https 一律拦截，收窄导航面
      // 拦截日志升级为 warn 并保留完整 URL——这是**顶层**导航，一旦抖音把登录/验证改成
      // 顶层跳到新域名，这里就是「点了没反应/登录卡住」的根因，必须一眼能从日志里看出来
      // （子框架已改为放行 https，见 shouldBlockFrameNavigation）。
      if (isUI || !isAllowedNavigationUrl(url)) {
        ev.preventDefault();
        try { logLine('warn', '[拦截] 已阻止顶层跳转（登录/验证若走新域名会卡在这里，请把本行发给开发者）: ' + String(url).slice(0, 200)); } catch (e3) {}
      }
    });
    // 子框架(iframe)导航：只拦非 http(s) 协议深链；白名单外的 https 一律放行并留痕
    // ——抖音登录安全验证走子框架，套白名单曾把登录拦死（见 shouldBlockFrameNavigation 注释）
    contents.on('will-frame-navigate', function (ev) {
      const url = ev.url;
      if (isUI || (ev.isMainFrame ? !isAllowedNavigationUrl(url) : shouldBlockFrameNavigation(url))) {
        ev.preventDefault();
        try { logLine('warn', '[拦截] 已阻止子框架非 http(s) 跳转: ' + String(url).slice(0, 120)); } catch (e3) {}
      } else if (!isAllowedNavigationUrl(url)) {
        logNavOnce('放行白名单外 https 子框架（登录验证可能用到）', url);
      }
    });
    contents.setWindowOpenHandler(function (details) {
      // 一律拒绝弹窗（保持原有安全策略：列表本身可点，避免 Windows「打开方式」弹窗与越权窗口）；
      // https 弹窗尝试也留痕（此前只记外部协议），否则「登录/验证依赖弹窗被静默拒绝」无从排查
      const u = String((details && details.url) || '');
      if (!/^https?:\/\//i.test(u)) {
        try { logLine('warn', '[拦截] 已拒绝打开外部窗口: ' + u.slice(0, 120)); } catch (e3) {}
      } else {
        logNavOnce('已拒绝打开新窗口（安全策略：一律 deny）', u);
      }
      return { action: 'deny' };
    });
  });
  app.whenReady().then(function () {
    ensureDirs();
    // 去掉每个窗口顶部的 Electron 默认菜单栏（File/Edit/View/Window），界面更美观；
    // Windows 下文本编辑快捷键（Ctrl+C/V/A）由 Chromium 原生处理，不依赖菜单加速器
    try { Menu.setApplicationMenu(null); } catch (e6) {}
    migrateLegacyUserData(); // 把早期短暂写入 %APPDATA%\抖音续火花助手 的数据合并回钉死目录
    try { protocol.handle('bytedance', function () { return new Response(null, { status: 204 }); }); } catch (e4) {}
    try { protocol.handle('snssdk1128', function () { return new Response(null, { status: 204 }); }); } catch (e4) {}
    try { protocol.handle('bytedanceweb', function () { return new Response(null, { status: 204 }); }); } catch (e4) {}
    try { protocol.handle('aweme', function () { return new Response(null, { status: 204 }); }); } catch (e4) {}
    try { protocol.handle('isnssdk1128', function () { return new Response(null, { status: 204 }); }); } catch (e4) {}
    if (autoMode) {
      createDouyin();
    } else {
      const cfg = loadConfig();
      // 保险：ready 后再断言一次 AUMID——个别运行时会在 ready 阶段重置进程 AUMID，
      // 登录启动项的值名取决于 setLoginItemSettings 调用时的 AUMID，必须确保唯一值
      try { if (typeof app.setAppUserModelId === 'function') app.setAppUserModelId('douyin-xuhuohua-helper'); } catch (e5) {}
      applyAutoStart(cfg); // 启动时与配置同步一次登录启动项（保持一致性，防止系统侧被改动/回退）
      createTray();
      // 开机自启唤起（--hidden）：静默进托盘，不弹主界面，定时续火花照常在后台运行
      const hiddenStart = process.argv.indexOf('--hidden') >= 0;
      if (!hiddenStart) createUI();
      (cfg.accounts || []).forEach(function (acct) { startAccount(acct.id); });
      if (hiddenStart) logLine('info', '[自启] 开机自启唤起：静默进入托盘（要打开主界面请点托盘图标）');
    }
    app.on('activate', function () { if (uiWin === null && !autoMode) createUI(); });
  });
  app.on('window-all-closed', function () { app.quit(); });
  app.on('before-quit', function () { quitting = true; });  // 程序退出（托盘「退出」）先置位，避免被托盘拦截逻辑阻止退出
}

/* 供冒烟/单测直接 require（Electron 主进程作为入口执行时此赋值无副作用） */
if (typeof module !== 'undefined' && typeof module.exports === 'object') {
  module.exports = {
    defaultConfig: defaultConfig, accountDefaults: accountDefaults, newAccountId: newAccountId,
    migrateConfig: migrateConfig, loadConfig: loadConfig, saveConfig: saveConfig,
    getAccountById: getAccountById, getActiveAccount: getActiveAccount,
    resolveFriendTime: resolveFriendTime, buildFriendSchedule: buildFriendSchedule, nextTime: nextTime,
    hhmmToMinutes: hhmmToMinutes, secondSlotOrderConflicts: secondSlotOrderConflicts,
    scheduleAuto: scheduleAuto, wasSentToday: wasSentToday, markSent: markSent, runSend: runSend, runAutoOnce: runAutoOnce, todayStr: todayStr,
    resolveSendTargetId: resolveSendTargetId, dedupeFriends: dedupeFriends, friendDedupKey: friendDedupKey,
    friendFingerprints: friendFingerprints, friendsWeakSame: friendsWeakSame, mergeFriendRows: mergeFriendRows,
    friendHasIdentity: friendHasIdentity,
    dedupeTargets: dedupeTargets, isPresenceText: isPresenceText,
    normFriendNick: normFriendNick, normFriendAvatar: normFriendAvatar, normFriendText: normFriendText,
    friendAvatarKey: friendAvatarKey, isDefaultAvatarUrl: isDefaultAvatarUrl,
    loadCachedFriends: loadCachedFriends, saveCachedFriends: saveCachedFriends, clearCachedFriends: clearCachedFriends,
    handleFriendList: handleFriendList, guardFriendList: guardFriendList, acctLabel: acctLabel, parseList: parseList,
    scheduleOffline: scheduleOffline, setNetworkOffline: setNetworkOffline, ensureDouyinWindow: ensureDouyinWindow,
    loadSendHistory: loadSendHistory, recordSendHistory: recordSendHistory, clearSendHistory: clearSendHistory, getSendHistory: getSendHistory,
    notifySendResult: notifySendResult, sendToOne: sendToOne, isAllowedNavigationUrl: isAllowedNavigationUrl,
    shouldBlockFrameNavigation: shouldBlockFrameNavigation, navTo: navTo, chatUrl: chatUrl, homeUrl: homeUrl,
    applyAutoStart: applyAutoStart, getAutoStartSetting: getAutoStartSetting,
    detectLoginOnStartup: detectLoginOnStartup, sanitizeBridgeArgs: sanitizeBridgeArgs, clearTimers: clearTimers, acctState: acctState,
    encryptSecret: encryptSecret, isDouyinHost: isDouyinHost,
    chromeMajorVersion: chromeMajorVersion, chromeFullVersion: chromeFullVersion, chromeUaString: chromeUaString,
    secChUaBrandsHeader: secChUaBrandsHeader, secChUaFullVersionListHeader: secChUaFullVersionListHeader,
    secChUaMobileHeader: secChUaMobileHeader, secChUaPlatformHeader: secChUaPlatformHeader,
    applySessionFingerprint: applySessionFingerprint
  };
}
