'use strict';
/* 主进程纯函数测试（node:test，零依赖，node --test 运行）。
 *
 * main.js 顶层 require('electron')，这里用 Module._load 注入最小桩：
 *   - app.isPackaged=true + getPath 指向 os.tmpdir()：DATA_DIR 落到临时目录，测试绝不写工程 data/；
 *   - whenReady 返回永不 resolve 的 Promise：阻止真实启动流程（建窗/托盘/计划任务/注册表）执行。
 * 覆盖历史上真实踩过的坑（按注释里的「曾出现」条目固化）：
 *   好友去重与防发错人裁决（含在线状态文本回归）、定时次序冲突、配置迁移、发送日志、
 *   桥接参数闸门、导航白名单、UA 指纹、打包自检清单。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

/* ---------------- electron 桩 ---------------- */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xh-test-'));
process.on('exit', function () { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {} });
const electronStub = {
  app: {
    isPackaged: true,
    commandLine: { hasSwitch: function () { return false; } },
    getPath: function (name) { return path.join(tmpRoot, name); },
    setPath: function () {},
    setAppUserModelId: function () {},
    requestSingleInstanceLock: function () { return true; },
    on: function () {},
    whenReady: function () { return new Promise(function () {}); },
    quit: function () {},
    setLoginItemSettings: function () {},
    getLoginItemSettings: function () { return { openAtLogin: false, launchItems: [] }; }
  },
  BrowserWindow: function () {},
  ipcMain: { on: function () {}, handle: function () {} },
  protocol: { registerSchemesAsPrivileged: function () {}, handle: function () {} },
  Tray: function () {},
  Menu: { setApplicationMenu: function () {}, buildFromTemplate: function () { return {}; } },
  nativeImage: { createFromPath: function () { return {}; }, createFromDataURL: function () { return {}; } },
  session: { fromPartition: function () { return {}; } },
  safeStorage: {
    isEncryptionAvailable: function () { return false; }, // 走「明文回退」分支（encryptSecret 的既定取舍）
    encryptString: function () { throw new Error('safeStorage unavailable'); },
    decryptString: function () { throw new Error('safeStorage unavailable'); }
  }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};
const m = require('../main.js');
const ROOT = path.join(__dirname, '..');
const DEFAULT_AV = 'https://p3.douyinpic.com/aweme_default_avatar.png';

/* ==================== 好友去重与身份裁决 ==================== */

test('同一好友两程快照：头像 CDN 域名轮换（对象路径相同）应合并', function () {
  const rows = m.dedupeFriends([
    { id: '', nickname: '小明', avatarUrl: 'https://p3.huoshanimg.com/aweme-avatar/obj1~c5.jpg?a=1', lastMessage: '在吗', lastTimeText: '昨天' },
    { id: '', nickname: '小明', avatarUrl: 'https://p11.douyinpic.com/aweme-avatar/obj1~c5.jpg?b=2', lastMessage: '在吗', lastTimeText: '昨天' }
  ]);
  assert.equal(rows.length, 1);
});

test('真重名（同名 + 头像对象不同）必须保留两行', function () {
  const rows = m.dedupeFriends([
    { id: '', nickname: '老王', avatarUrl: 'https://x.com/aweme-avatar/o1.jpg', lastMessage: 'a', lastTimeText: '昨天' },
    { id: '', nickname: '老王', avatarUrl: 'https://x.com/aweme-avatar/o2.jpg', lastMessage: 'b', lastTimeText: '昨天' }
  ]);
  assert.equal(rows.length, 2);
});

test('降级快照（无 id 无头像）应并入有身份的同名记录，内容差异不算矛盾', function () {
  const rows = m.dedupeFriends([
    { id: '', nickname: '小美', avatarUrl: '', lastMessage: 'hello', lastTimeText: '刚刚' },
    { id: '', nickname: '小美', avatarUrl: 'https://x.com/aweme-avatar/o9.jpg', lastMessage: '完全不同的预览', lastTimeText: '昨天' }
  ]);
  assert.equal(rows.length, 1);
});

test('默认占位头像不算身份：同名两人内容不同必须保留两行（防误合并）', function () {
  const rows = m.dedupeFriends([
    { id: '', nickname: '路人', avatarUrl: DEFAULT_AV, lastMessage: '一', lastTimeText: '昨天' },
    { id: '', nickname: '路人', avatarUrl: DEFAULT_AV, lastMessage: '二', lastTimeText: '昨天' }
  ]);
  assert.equal(rows.length, 2);
});

test('回归：预览位被在线状态顶替（默认头像/无 id）不再造成重复行与整人停发', function () {
  // 正序：先真实消息、后状态文本
  const rows = m.dedupeFriends([
    { id: '', nickname: '小张', avatarUrl: DEFAULT_AV, lastMessage: '晚安', lastTimeText: '昨天' },
    { id: '', nickname: '小张', avatarUrl: DEFAULT_AV, lastMessage: '30分钟内在线', lastTimeText: '昨天' }
  ]);
  assert.equal(rows.length, 1, '同一好友不应因状态文本被拆成两行');
  assert.equal(rows[0].lastMessage, '晚安', '真实消息必须覆盖状态文本');
  assert.equal(m.resolveSendTargetId('小张', rows).ambiguous, false, '不得再被误判为真重名停发');
  // 逆序：先状态文本、后真实消息（降级行先入列的既有场景）
  const rev = m.dedupeFriends([
    { id: '', nickname: '小张', avatarUrl: DEFAULT_AV, lastMessage: '5分钟内在线', lastTimeText: '昨天' },
    { id: '', nickname: '小张', avatarUrl: DEFAULT_AV, lastMessage: '刚刚', lastTimeText: '昨天' }
  ]);
  assert.equal(rev.length, 1, '纯状态文本差异同样不构成矛盾');
  assert.equal(rev[0].lastMessage, '刚刚', '降级行先入列时也必须被真实消息覆盖');
  // 反向对照：没有状态文本参与时，内容不同 + 无身份 → 仍保守保留两行（不放开成因人误合并）
  const keep = m.dedupeFriends([
    { id: '', nickname: '小张', avatarUrl: DEFAULT_AV, lastMessage: '晚安', lastTimeText: '昨天' },
    { id: '', nickname: '小张', avatarUrl: DEFAULT_AV, lastMessage: '早上好', lastTimeText: '昨天' }
  ]);
  assert.equal(keep.length, 2);
});

test('isPresenceText：只认在线状态文案，不吞真实消息', function () {
  // 识别范围与代码注释记载的抖音实际形态一致（在线 / N分钟内在线 / N小时内在线 / N天内在线…）；
  // 未知形态一律按真实内容处理（保守），避免误合并两个人
  assert.equal(m.isPresenceText('在线'), true);
  assert.equal(m.isPresenceText('30分钟内在线'), true);
  assert.equal(m.isPresenceText('2小时内在线'), true);
  assert.equal(m.isPresenceText('昨天'), false);
  assert.equal(m.isPresenceText('晚安'), false);
});

test('防发错人裁决：resolveSendTargetId 五个分支', function () {
  assert.deepEqual(m.resolveSendTargetId('小明', [
    { nickname: '小明', avatarUrl: 'https://a.com/aweme-avatar/x1.jpg', id: '' },
    { nickname: '小明', avatarUrl: 'https://b.com/aweme-avatar/x1.jpg', id: '' }
  ]), { ambiguous: false, id: '' }, '同名多条但头像一致 = 同一人重复入列，放行');
  assert.equal(m.resolveSendTargetId('小明', [
    { nickname: '小明', avatarUrl: 'https://a.com/aweme-avatar/x1.jpg' },
    { nickname: '小明', avatarUrl: 'https://a.com/aweme-avatar/x2.jpg' }
  ]).ambiguous, true, '头像不同 = 真重名，停发');
  assert.equal(m.resolveSendTargetId('小明', [
    { nickname: '小明', avatarUrl: 'https://a.com/aweme-avatar/x1.jpg' },
    { nickname: '小明', avatarUrl: DEFAULT_AV }
  ]).ambiguous, true, '含默认头像 = 无法判定，停发');
  assert.equal(m.resolveSendTargetId('小明', [
    { nickname: '小明', id: '111' }, { nickname: '小明', id: '222' }
  ]).ambiguous, true, '多个不同 id = 两个会话，停发');
  assert.equal(m.resolveSendTargetId('小明', [
    { nickname: '小明', id: '111' }, { nickname: '小明', id: '111' }
  ]).id, '111', 'id 唯一 = 精确定位');
});

/* ==================== 定时 ==================== */

test('nextTime：已过推明天、未到今天、非法回落 09:00', function () {
  const now = new Date(2026, 0, 1, 10, 0, 0);
  assert.equal(m.nextTime('09:00', now).getDate(), 2);
  assert.equal(m.nextTime('11:00', now).getDate(), 1);
  assert.equal(m.nextTime('abc', now).getHours(), 9);
  assert.equal(m.nextTime('11:00', now).getMinutes(), 0);
});

test('hhmmToMinutes：换算与非法输入', function () {
  assert.equal(m.hhmmToMinutes('23:59'), 1439);
  assert.equal(m.hhmmToMinutes('09:30'), 570);
  assert.equal(m.hhmmToMinutes('x'), 0);
});

test('第二时段次序冲突：同日更晚/跨午夜紧邻报警，隔夜正常配置不误报', function () {
  const S = m.secondSlotOrderConflicts;
  assert.deepEqual(S('22:00', [{ label: 'g', time: '09:00' }]), [], '隔一整夜（11 小时）属正常日节奏');
  assert.deepEqual(S('22:00', [{ label: 'g', time: '23:00' }]), ['g'], '同日更晚：兜底会先发一次');
  assert.deepEqual(S('01:00', [{ label: 'g', time: '23:00' }]), ['g'], '同日更晚（跨零点配置）');
  assert.deepEqual(S('23:00', [{ label: 'g', time: '00:00' }]), ['g'], '跨午夜紧邻（1 小时）必须判出');
  assert.deepEqual(S('21:00', [{ label: 'g', time: '21:00' }]), [], '完全同刻由「今天已发过」跳过，不算冲突');
});

/* ==================== 配置迁移与持久化 ==================== */

test('旧单账号配置迁移为 accounts[1]，账号内不残留全局敏感字段', function () {
  const cfg = m.migrateConfig({ targets: ['甲', '乙'], message: 'hi', time: '08:30', smtpPass: 'plain-pass' });
  assert.equal(cfg.accounts.length, 1);
  assert.equal(cfg.accounts[0].targets.length, 2);
  assert.equal(cfg.accounts[0].smtpPass, undefined);
  assert.equal(cfg.smtpPass, 'plain-pass');
});

test('多账号规范化：目标去重、targets[i].time 同步 friendTimes、未知字段透传、预置文案并入', function () {
  const cfg = m.migrateConfig({
    accounts: [
      { id: 'a1', name: '一号', targets: ['甲', '甲', '乙'], friendTimes: { '乙': '10:00' } },
      { id: 'a2', name: '二号', targets: [{ nickname: '丙', time: '11:11' }] }
    ],
    activeAccountId: 'a2',
    unknownFuture: { keep: 1 }
  });
  assert.equal(cfg.accounts[0].targets.length, 2);
  assert.equal(cfg.accounts[1].friendTimes['丙'], '11:11');
  assert.equal(cfg.activeAccountId, 'a2');
  assert.deepEqual(cfg.unknownFuture, { keep: 1 }, '白名单外的新字段不能被保存流程抹掉');
  assert.ok(cfg.quickMessages.indexOf('续火花啦，今天也别断哦') >= 0);
});

test('saveConfig/loadConfig 往返（safeStorage 不可用时明文回退）', function () {
  const cfg = m.defaultConfig();
  cfg.smtpHost = 'smtp.example.com'; cfg.smtpUser = 'a@b.c'; cfg.smtpPass = 'secret'; cfg.smtpTo = 'd@e.f';
  assert.equal(m.saveConfig(cfg), true);
  const back = m.loadConfig();
  assert.equal(back.smtpHost, 'smtp.example.com');
  assert.equal(back.smtpPass, 'secret');
});

test('dedupeTargets：按归一化昵称去重且保持原形态', function () {
  assert.deepEqual(m.dedupeTargets(['甲', ' 甲 ', { nickname: '甲', time: '10:00' }, '乙']), ['甲', '乙']);
});

/* ==================== 发送日志与日历 ==================== */

test('markSent/wasSentToday：归一化命中、不跨账号串账', function () {
  m.markSent('acct-test', ' 小\u200b 明 ');
  assert.equal(m.wasSentToday('acct-test', '小 明'), true, '零宽字符/空白差异必须归一化命中');
  assert.equal(m.wasSentToday('acct-other', '小 明'), false, '不同账号互不影响');
  assert.equal(m.wasSentToday('acct-test', '小明'), false, '不同昵称不误命中');
});

test('日历：最后一次执行为准，纯跳过空跑不冲掉当天成功明细', function () {
  const id = 'acct-hist';
  const today = m.todayStr();
  m.recordSendHistory(id, { ok: 2, fail: 0, total: 2, skipped: 0 });
  assert.equal(m.getSendHistory(id).history[today].status, 'ok');
  m.recordSendHistory(id, { ok: 0, fail: 0, total: 3, skipped: 3 });
  const day = m.getSendHistory(id).history[today];
  assert.equal(day.ok, 2, '跳过明细并入而非清空');
  assert.equal(day.skipped, 3);
  m.recordSendHistory(id, { ok: 1, fail: 1, total: 2, skipped: 0 });
  assert.equal(m.getSendHistory(id).history[today].status, 'fail', '真实执行结果覆盖当天');
  m.recordSendHistory('acct-hist-empty', { ok: 0, fail: 0, total: 0, skipped: 0 });
  assert.deepEqual(m.getSendHistory('acct-hist-empty').history, {}, '空目标不落记录');
});

/* ==================== 好友列表空值闸门 ==================== */

test('guardFriendList：空结果不覆盖内存、非空结果去重后返回', function () {
  const id = 'acct-guard';
  const st = m.acctState(id);
  st.latestFriends = [{ nickname: '甲' }];
  assert.deepEqual(m.guardFriendList(id, [], '[]', '手动'), [], '空载荷返回空数组（调用方据此保留原列表）');
  assert.equal(st.latestFriends.length, 1);
  const clean = m.guardFriendList(id, [{ nickname: '甲' }, { nickname: '甲' }], '', '手动');
  assert.equal(clean.length, 1, '非空结果统一走去重');
});

test('昵称归一化与去重键', function () {
  assert.equal(m.normFriendNick(' 小\u200b 明 '), '小 明');
  assert.equal(m.friendDedupKey({ id: 'x1', nickname: 'n', avatarUrl: '' }), 'id:x1');
  assert.equal(m.friendAvatarKey('https://p3.a.com/aweme-avatar/o.jpg?sig=1'), '/aweme-avatar/o.jpg');
  assert.equal(m.friendAvatarKey(DEFAULT_AV), '', '默认占位头像不构成身份键');
});

/* ==================== 桥接闸门与导航白名单 ==================== */

test('sanitizeBridgeArgs：长度/数量/类型边界', function () {
  assert.equal(m.sanitizeBridgeArgs(['x'.repeat(65537)]), null, '超长单参数整个事件拒绝（不是截断）');
  assert.ok(Array.isArray(m.sanitizeBridgeArgs(['x'.repeat(65536)])));
  assert.equal(m.sanitizeBridgeArgs([{}]), null);
  assert.equal(m.sanitizeBridgeArgs(new Array(21).fill(1)), null);
  assert.ok(Array.isArray(m.sanitizeBridgeArgs([true, 1, 'ok'])));
});

test('导航白名单：只放行抖音及资源域子域，拒绝仿冒域名与本地协议', function () {
  assert.equal(m.isAllowedNavigationUrl('https://www.douyin.com/chat'), true);
  assert.equal(m.isAllowedNavigationUrl('https://lf-rc1.yhgfb-cn-static.com/x'), true);
  assert.equal(m.isAllowedNavigationUrl('https://evil-douyin.com/'), false);
  assert.equal(m.isAllowedNavigationUrl('https://douyin.com.evil.com/'), false);
  assert.equal(m.isAllowedNavigationUrl('file:///etc/passwd'), false);
  assert.equal(m.isDouyinHost('https://www.douyin.com/chat'), true);
  assert.equal(m.isDouyinHost('https://notdouyin.com'), false);
});

test('桥接 shim：旧发送队列回调保持删除（防双实现回流）', function () {
  const shim = fs.readFileSync(path.join(ROOT, 'inject', 'android-bridge-shim.js'), 'utf8');
  ['onEnterChatResult', 'onSendMessageResult', 'onBackToListResult', 'onProgress', 'onChatData'].forEach(function (name) {
    assert.equal(shim.indexOf(name) < 0, true, 'shim 不应再定义 ' + name);
  });
  assert.ok(shim.indexOf('onSendResult') >= 0, '发送结果回调 onSendResult 必须保留');
  assert.ok(shim.indexOf('onFriendListParsed') >= 0, '好友列表回调必须保留');
});

test('口径一致性：在线状态正则与头像图标正则在主进程/解析侧/发送侧逐字一致', function () {
  // 代码注释明确要求「三处必须逐字一致（口径漂移会造成同名误判）」——历史上出过漂移，
  // 这里用源码级断言把不变量钉死：改动任何一个文件的正则而漏改其它文件即红。
  const srcMain = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const srcInject = fs.readFileSync(path.join(ROOT, 'inject', 'douyin_auto.js'), 'utf8');
  const srcSend = fs.readFileSync(path.join(ROOT, 'inject', 'send_msg.js'), 'utf8');
  const count = function (s, sub) { return s.split(sub).length - 1; };
  const presenceCore = '(?:在线|\\d+\\s*(?:分钟|小时|天|周|个月|月)内在线)';
  assert.equal(count(srcMain, presenceCore), 1, 'main.js PRESENCE_TEXT_RE');
  assert.equal(count(srcInject, presenceCore), 2, 'douyin_auto.js weakSameSnapshot + mergeSnapshot 两处');
  const iconCore = 'flame|fire|spark|huohua|emoji|gray_normal|lit_normal|\\/icons?\\/|_icon\\b|icon[_-]';
  // 主进程 1 处（ICON_AVATAR_RE）；解析侧 2 处（extractAvatarUrl 打分 + isIconAvatarUrl 归一化）；
  // 发送侧 1 处（itemAvatar）
  const iconExpect = { 'main.js': 1, 'inject/douyin_auto.js': 2, 'inject/send_msg.js': 1 };
  Object.keys(iconExpect).forEach(function (rel) {
    const text = { 'main.js': srcMain, 'inject/douyin_auto.js': srcInject, 'inject/send_msg.js': srcSend }[rel];
    assert.equal(count(text, iconCore), iconExpect[rel], rel + ' 头像图标正则口径');
  });
});

/* ==================== UA 指纹与打包自检 ==================== */

test('UA 指纹：标准 Chrome 形态、不含应用名/Electron 段', function () {
  const ua = m.chromeUaString();
  assert.match(ua, /Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/);
  assert.equal(ua.indexOf('Electron'), -1);
  assert.equal(ua.indexOf('抖音'), -1);
  assert.match(m.secChUaBrandsHeader(), /Google Chrome/);
  assert.match(m.secChUaFullVersionListHeader(), /Chromium";v="\d+\.\d+\.\d+\.\d+"/);
});

test('打包自检清单：main.js/ui 运行时引用在仓库中全部存在', function () {
  const check = require('../scripts/runtime-files-check.js');
  const refs = check.collectMainRefs(fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8'));
  ['inject/android-bridge-shim.js', 'inject/douyin_auto.js', 'inject/send_msg.js', 'inject/qr_poll.js',
    'lib/notify.js', 'ui/index.html', 'ui/icon.png', 'ui/tray.png', 'package.json',
    'preload-ui.js', 'preload-douyin.js'
  ].forEach(function (r) { assert.ok(refs.includes(r), '引用清单缺少 ' + r); });
  refs.forEach(function (r) {
    if (r === 'data' || r.indexOf('data/') === 0 || r === '启动续火花助手.bat') return; // dev 专用路径，打包自检已按 IS_PACKAGED 排除
    assert.ok(fs.existsSync(path.join(ROOT, r)), '运行时引用文件不存在: ' + r);
  });
  check.collectExecPathRefs(fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')).forEach(function (r) {
    assert.ok(fs.existsSync(path.join(ROOT, r)), '打包根目录引用文件不存在: ' + r);
  });
  const htmlRefs = check.collectHtmlLocalRefs(fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8'));
  ['app.css', 'app.js'].forEach(function (r) { assert.ok(htmlRefs.includes(r), '界面资源清单缺少 ' + r); });
  htmlRefs.forEach(function (r) { assert.ok(fs.existsSync(path.join(ROOT, 'ui', r)), '界面资源不存在: ' + r); });
});