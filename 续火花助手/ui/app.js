'use strict';
/* 多账号版主界面渲染逻辑  */
var el = function (id) { return document.getElementById(id); };
var config = { accounts: [], activeAccountId: '', closeBehavior: 'tray', autoStart: false, notifyOn: false, smtpHost: '', smtpPort: '465', smtpUser: '', smtpPass: '', smtpTo: '', quickMessages: [], uiParticles: false, disableGpu: false };
var friends = [];
var selected = new Set();
var searchText = ''; // 好友搜索关键字（纯前端过滤，不持久化）
/** 每账号徽标元信息：loggedIn(null=未知/true/false)、offline、friendCount(-1=未知)。供 Tab 徽标与状态灯复用 */
var acctMeta = {};
function metaOf(id) { return acctMeta[id] || (acctMeta[id] = { loggedIn: null, offline: false, friendCount: -1 }); }
/** 由一次 getAccountState 返回更新某账号徽标（仅覆盖已明确给出的字段） */
function updateAcctMeta(id, st) {
  var m = metaOf(id);
  if (st && (st.loggedIn === true || st.loggedIn === false)) m.loggedIn = st.loggedIn;
  if (st && typeof st.offline === 'boolean') m.offline = st.offline;
  if (st && Array.isArray(st.friends)) m.friendCount = st.friends.length;
  return m;
}
/** 返回当前激活的账号对象（无则 null） */
function cur() {
  var accts = config.accounts || [];
  for (var i = 0; i < accts.length; i++) { if (accts[i].id === config.activeAccountId) return accts[i]; }
  return accts.length ? accts[0] : null;
}
/** 当前账号 id */
function curId() { var c = cur(); return c ? c.id : ''; }

window.addEventListener('DOMContentLoaded', function () {
  window.dsx.onEvent(handleEvent);
  init();
});
async function init() {
  try { config = await window.dsx.invoke('getConfig'); } catch (e) {}
  config.accounts = config.accounts || [];
  config.quickMessages = config.quickMessages || [];
  // 版本号单一来源：主进程从 package.json 读，界面不再硬编码
  var appVersion = 'v' + (config.appVersion || '');
  var verEl = document.querySelector('.ver');
  if (verEl) verEl.textContent = appVersion;
  var metaEl = document.querySelector('meta[name="app-version"]');
  if (metaEl) metaEl.setAttribute('content', appVersion);
  renderAccounts();
  renderConfig();
  renderTpl();
  renderStatus();
  initNetState();
  bindButtons();
  appendLog('info', '[界面] 多账号版 ' + appVersion + ' 就绪。先「打开抖音页/刷新二维码」扫码登录，可添加多个账号同时在线。');
  await refreshAccountState();
  loadAccountBadges();
  loadCal();
  refreshAutoStartStatus();
}

/* ============ 账号 Tab ============ */
function renderAccounts() {
  var bar = el('accountTabs');
  if (!bar) return;
  bar.innerHTML = '';
  (config.accounts || []).forEach(function (acct) {
    var tab = document.createElement('span');
    tab.className = 'acctTab' + (acct.id === config.activeAccountId ? ' active' : '');
    var nm = document.createElement('span');
    nm.className = 'acctName';
    nm.textContent = acct.name || acct.id;
    tab.appendChild(nm);
    tab.appendChild(buildAcctBadge(acct.id));
    tab.title = '点击切换到这个账号';
    tab.onclick = function () { if (acct.id !== config.activeAccountId) switchAccount(acct.id); };
    bar.appendChild(tab);
  });
  var add = document.createElement('button');
  add.className = 'acctAdd';
  add.textContent = '＋添加';
  add.title = '新增一个账号';
  add.onclick = addAccount;
  bar.appendChild(add);
  var rename = document.createElement('button');
  rename.className = 'acctAdd';
  rename.textContent = '重命名';
  rename.onclick = renameAccount;
  bar.appendChild(rename);
  var del = document.createElement('button');
  del.className = 'acctAdd danger';
  del.textContent = '删除';
  del.onclick = removeAccount;
  bar.appendChild(del);
}
/** 账号 Tab 徽标：登录点(绿/红/灰) + 📴断网 + 好友数 */
function buildAcctBadge(id) {
  var m = metaOf(id);
  var b = document.createElement('span');
  b.className = 'acctBadge';
  var dot = document.createElement('span');
  dot.className = 'miniDot ' + (m.loggedIn === true ? 'green' : (m.loggedIn === false ? 'red' : 'gray'));
  b.appendChild(dot);
  if (m.offline) {
    var off = document.createElement('span');
    off.className = 'acctOff';
    off.textContent = '📴';
    off.title = '已断网';
    b.appendChild(off);
  }
  if (m.friendCount >= 0) {
    var cnt = document.createElement('span');
    cnt.className = 'acctCnt';
    cnt.textContent = m.friendCount + '友';
    b.appendChild(cnt);
  }
  return b;
}
async function reloadConfig() {
  if (!(await flushConfigSave()).ok) return;
  try { config = await window.dsx.invoke('getConfig'); } catch (e) {}
  config.accounts = config.accounts || [];
  config.quickMessages = config.quickMessages || [];
  selected.clear();
  renderAccounts();
  renderConfig();
  renderTpl();
  await refreshAccountState();
  refreshAutoStartStatus();
}
/** 拉取式刷新当前账号状态（好友列表/登录灯/断网灯/勾选），切换/初始化时调用，不再盲目清空 */
var stateRequestId = 0;
async function refreshAccountState() {
  var requestId = ++stateRequestId;
  var c = cur();
  if (!c) { friends = []; selected.clear(); renderFriends(); renderStatus(null); return; }
  var st = await window.dsx.invoke('getAccountState', { accountId: c.id }) || {};
  if (requestId !== stateRequestId || c.id !== curId()) return;
  updateAcctMeta(c.id, st);
  friends = st.friends || [];
  renderStatus(st.loggedIn);
  renderNetState(!!st.offline);
  seedSelection((cur() || {}).targets || []);
  renderFriends();
  renderAccounts();
}
/** 初始化时拉取非激活账号的徽标（登录/断网/好友数），避免切换前 Tab 全灰 */
async function loadAccountBadges() {
  var accts = (config.accounts || []).slice();
  for (var i = 0; i < accts.length; i++) {
    if (accts[i].id === curId()) continue;
    try {
      var st = await window.dsx.invoke('getAccountState', { accountId: accts[i].id }) || {};
      updateAcctMeta(accts[i].id, st);
    } catch (e) {}
  }
  renderAccounts();
}
var accountSwitchChain = Promise.resolve();
function switchAccount(id) {
  var change = async function () {
    if (id === curId()) return;
    if (!(await flushConfigSave()).ok) return;
    var controls = Array.from(document.querySelectorAll('input,textarea,select,button')).map(function (node) { return { node: node, disabled: node.disabled }; });
    controls.forEach(function (item) { item.node.disabled = true; });
    ++stateRequestId; ++calRequestId;
    try {
      var r = await window.dsx.invoke('setActiveAccount', { accountId: id });
      if (!r || !r.ok) { appendLog('error', '[账号] 切换失败，保留当前账号'); return; }
      hideQr();
      await reloadConfig();
      await loadCal();
    } finally {
      controls.forEach(function (item) { item.node.disabled = item.disabled; });
      syncIntervalState();
    }
  };
  accountSwitchChain = accountSwitchChain.then(change, change).catch(function () { appendLog('error', '[账号] 切换失败，请重试'); });
  return accountSwitchChain;
}
async function addAccount() {
  await accountSwitchChain;
  if (!(await flushConfigSave()).ok) return;
  var r = await window.dsx.invoke('addAccount');
  if (r && r.ok) { await reloadConfig(); appendLog('info', '[账号] 已添加账号「' + (r.account ? r.account.name : '') + '」'); }
  else appendLog('error', '[账号] 添加账号失败：' + ((r && r.error) || '未知'));
}
/* 页内模态输入框：Electron 渲染进程不支持 window.prompt（调用即抛异常，上游 electron#472 wontfix）。
 * 账号重命名等需要输入的场景一律走本函数；标题用 textContent 写入，无 innerHTML 注入面 */
function askText(title, defaultValue) {
  return new Promise(function (resolve) {
    var mask = document.createElement('div');
    mask.className = 'dsx-modal-mask';
    var box = document.createElement('div');
    box.className = 'dsx-modal';
    var label = document.createElement('div');
    label.className = 'dsx-modal-title';
    label.textContent = title;
    var input = document.createElement('input');
    input.className = 'dsx-modal-input';
    input.maxLength = 30;
    input.value = defaultValue == null ? '' : String(defaultValue);
    var row = document.createElement('div');
    row.className = 'dsx-modal-row';
    var ok = document.createElement('button');
    ok.className = 'dsx-modal-btn primary'; ok.textContent = '确定';
    var cancel = document.createElement('button');
    cancel.className = 'dsx-modal-btn'; cancel.textContent = '取消';
    var closed = false;
    function close(v) { if (closed) return; closed = true; document.body.removeChild(mask); resolve(v); }
    ok.onclick = function () { close(input.value.trim()); };
    cancel.onclick = function () { close(null); };
    mask.addEventListener('click', function (e) { if (e.target === mask) close(null); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); close(input.value.trim()); }
      else if (e.key === 'Escape') { e.preventDefault(); close(null); }
    });
    row.appendChild(ok); row.appendChild(cancel);
    box.appendChild(label); box.appendChild(input); box.appendChild(row);
    mask.appendChild(box);
    document.body.appendChild(mask);
    input.focus(); input.select();
  });
}
async function renameAccount() {
  var c = cur(); if (!c) return;
  var name = await askText('给「' + (c.name || c.id) + '」起个备注名：', c.name || '');
  if (name === null) return; // 取消
  if (!name) { appendLog('warn', '[账号] 备注名不能为空'); return; }
  if (!(await flushConfigSave()).ok) return;
  var r = await window.dsx.invoke('renameAccount', { accountId: c.id, name: name });
  if (r && r.ok) await reloadConfig();
  else appendLog('error', '[账号] 重命名失败：' + ((r && r.error) || '未知'));
}
async function removeAccount() {
  var c = cur(); if (!c) return;
  if (!confirm('确定删除账号「' + (c.name || c.id) + '」吗？\n将清除它的登录态和发送记录，且不可恢复。')) return;
  if (!(await flushConfigSave()).ok) return;
  ++stateRequestId; ++calRequestId;
  var r = await window.dsx.invoke('removeAccount', { accountId: c.id });
  if (r && r.ok) { await reloadConfig(); appendLog('info', '[账号] 已删除账号'); }
  else appendLog('error', '[账号] 删除失败：' + ((r && r.error) || '未知'));
}

function bindButtons() {
  var ids = ['btnEnsureLogin','btnExtractQr','btnShowDouyin','btnLogout','btnParseFriends','btnSelectAllSpark','btnSelectNone','btnSendNow','btnSaveCfg','btnGenTask','btnTestMail','btnClearLog','sendText','sendTime','autoOn','skipSent','secondTimeEnabled','secondTime','closeTray','closeExit','netAlways','netAuto','filterSel','filterUnsent','intervalMs','intervalMaxMs','randomMessage','randomInterval','uiParticles','disableGpu','friendSearch','calPrev','calNext','calToday','calClear','logBox','notifyOn','autoStart','btnAddTpl','tplInput'];
  // 一次性收集全部缺失元素再整体报错（此前只报第一个就 return，其余缺失被静默跳过难排查，）
  var missing = [];
  for (var k = 0; k < ids.length; k++) { if (!el(ids[k])) missing.push('#' + ids[k]); }
  if (missing.length) { appendLog('error', '[UI] 缺少元素 ' + missing.join(' ')); return; }
  el('btnEnsureLogin').onclick = function () { ensureLogin(); };
  el('btnExtractQr').onclick = function () { extractQr(); };
  el('btnShowDouyin').onclick = function () { window.dsx.invoke('showDouyin', { accountId: curId() }); };
  el('btnLogout').onclick = function () { logout(); };
  el('btnParseFriends').onclick = function () { parseFriends(); };
  el('btnSelectAllSpark').onclick = function () {
    friends.forEach(function (f, i) { if (f.hasSpark) selected.add(i); });
    renderFriends(); saveSelection(); saveAll(false);
  };
  el('btnSelectNone').onclick = function () { selected.clear(); renderFriends(); saveSelection(); saveAll(false); };
  el('btnSendNow').onclick = function () { sendNow(); };
  el('btnSaveCfg').onclick = function () { saveAll(true); };
  el('btnGenTask').onclick = function () { genTask(); };
  el('btnTestMail').onclick = function () { sendTestEmail(); };
  el('btnClearLog').onclick = function () { el('logBox').textContent = ''; };
  el('sendText').onchange = el('sendTime').onchange = el('autoOn').onchange = el('skipSent').onchange = function () { saveDebounced(false); };
  // 第二时段改值时若早于全局/独立时间，先确认再保存（到点会提前发送，其后的定时可能重复）
  el('secondTimeEnabled').onchange = el('secondTime').onchange = function () {
    var c = cur();
    var st2 = el('secondTimeEnabled').checked ? (el('secondTime').value || '21:00') : '';
    if (c && st2 && hasLaterSchedule(c, st2) && !confirm('第二时段 ' + st2 + ' 早于某些好友的独立时间/全局时间：到点会提前把对应好友发出，其后的定时可能重复发送。\n仍要这样保存吗？（建议把第二时段设到所有时间之后）')) {
      renderConfig(); // 取消：按已存配置还原界面显示，不落盘
      return;
    }
    saveDebounced(false);
  };
  el('closeTray').onchange = el('closeExit').onchange = function () { saveDebounced(false); };
  el('netAlways').onchange = el('netAuto').onchange = function () { saveDebounced(false); };
  el('intervalMs').onchange = function () { saveDebounced(false); };
  el('intervalMaxMs').onchange = function () { saveDebounced(false); };
  el('randomMessage').onchange = function () { saveDebounced(false); };
  el('randomInterval').onchange = function () { syncIntervalState(); saveDebounced(false); };
  el('notifyOn').onchange = function () { saveDebounced(false); };
  // 开机自启：单独即时保存（不等防抖，勾选立刻落盘并同步系统登录启动项），保存完成后刷新系统侧状态
  el('autoStart').onchange = function () { saveAll(false).then(refreshAutoStartStatus); };
  // 二次元背景粒子：勾选即生效（纯前端 class 切换，无逐帧 JS 循环），随配置保存
  el('uiParticles').onchange = function () { config.uiParticles = el('uiParticles').checked; applyParticles(); saveDebounced(false); };
  // 禁用GPU加速：只保存配置，重启后由主进程生效（白屏/花屏/远程桌面自救）
  el('disableGpu').onchange = function () { saveDebounced(false); };
  el('filterSel').onchange = function () { renderFriends(); saveDebounced(false); };
  el('filterUnsent').onchange = function () { renderFriends(); };
  // 好友搜索（实时过滤，与「只看已选/只看未续」叠加）
  // 好友搜索（实时过滤，与「只看已选/只看未续」叠加）；150ms 防抖避免每键整表 innerHTML 重建
  var searchTimer = null;
  el('friendSearch').addEventListener('input', function () {
    searchText = el('friendSearch').value.trim().toLowerCase();
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { searchTimer = null; renderFriends(); }, 150);
  });
  // 续火花日历：月份切换 / 回本月 / 清空
  el('calPrev').onclick = function () { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCal(); };
  el('calNext').onclick = function () { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCal(); };
  el('calToday').onclick = function () { var n = new Date(); calYear = n.getFullYear(); calMonth = n.getMonth(); renderCal(); };
  el('calClear').onclick = function () { calClear(); };
  // 日历浮层：点标题栏 📅 图标弹出；点浮层外任意处或按 Esc 关闭
  el('btnCal').onclick = function (e) { e.stopPropagation(); toggleCalPopup(); };
  document.addEventListener('mousedown', function (e) {
    var pop = el('calPopup');
    if (!pop || pop.hidden) return;
    var btn = el('btnCal');
    if (pop.contains(e.target) || (btn && btn.contains(e.target))) return;
    toggleCalPopup(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' || e.keyCode === 27) toggleCalPopup(false);
  });
  window.addEventListener('resize', positionCalPopup);
  window.addEventListener('scroll', positionCalPopup, true); // capture：表格容器内滚动也跟随
  el('btnAddTpl').onclick = function () {
    var v = el('tplInput').value.trim();
    if (!v) return;
    config.quickMessages = config.quickMessages || [];
    config.quickMessages.push(v);
    el('tplInput').value = '';
    renderTpl();
    saveAll(false);
  };
}
function handleEvent(obj) {
  if (!obj) return;
  var id = obj.accountId || '';
  var isCur = !id || id === curId();
  switch (obj.type) {
    case 'log': appendLog(obj.level, obj.message); break;
    case 'qr':
      if (!isCur) break; // 非当前账号的二维码忽略
      if (obj.image) { el('qrImg').src = obj.image; el('qrImg').hidden = false; el('qrPlaceholder').hidden = true; }
      else { hideQr(); appendLog('warn', '二维码暂不可直接读取(' + (obj.text || '') + ')，可点「显示抖音页」'); }
      break;
    case 'qrFailed': if (!isCur) break; hideQr(); appendLog('warn', '二维码获取失败，可点「显示抖音页」手动登录'); break;
    case 'loginState': {
      if (id) { updateAcctMeta(id, { loggedIn: !!obj.loggedIn }); renderAccounts(); }
      if (!isCur) break;
      renderStatus(obj.loggedIn);
      if (obj.loggedIn) appendLog('info', '[登录] 已登录'); else appendLog('info', '[登录] 当前未登录');
      break;
    }
    case 'netState': {
      if (id) { updateAcctMeta(id, { offline: !!obj.offline }); renderAccounts(); }
      if (!isCur) break;
      renderNetState(!!obj.offline);
      break;
    }
    case 'friends':
      if (id) { updateAcctMeta(id, { friends: obj.list || [] }); renderAccounts(); }
      if (!isCur) break;
      friends = obj.list || [];
      selected.clear();
      seedSelection((cur() || {}).targets || []);
      renderFriends();
      loadCal();
      appendLog('info', '[好友] 收到好友列表 ' + friends.length + ' 条');
      break;
    case 'sendResult':
      if (!isCur) break;
      if (obj.ok) appendLog('info', '✅ ' + obj.nickname);
      else appendLog('warn', '❌ ' + obj.nickname + (obj.text ? '：' + obj.text : ''));
      break;
    case 'enterChat': if (!isCur) break; if (!obj.ok) appendLog('warn', '进入会话失败 ' + obj.nickname); break;
    default: break;
  }
}
function initNetState() { var ns = el('netStateLabel'); if (ns) { ns.textContent = '🛜 联网中'; ns.className = 'netstate on'; } }
function renderNetState(offline) { var ns = el('netStateLabel'); if (ns) { ns.textContent = offline ? '📴 已断网' : '🛜 联网中'; ns.className = 'netstate ' + (offline ? 'off' : 'on'); } }
function renderStatus(loggedIn) {
  var dot = el('statusDot'), txt = el('statusText');
  if (loggedIn === true) { dot.className = 'dot green'; txt.textContent = '已登录'; }
  else if (loggedIn === false) { dot.className = 'dot red'; txt.textContent = '未登录'; }
  else { dot.className = 'dot gray'; txt.textContent = '检测中…'; }
}
async function ensureLogin() {
  appendLog('info', '[界面] 打开抖音页…');
  var accountId = curId();
  var r = await window.dsx.invoke('ensureLogin', { accountId: accountId });
  if (!r || !r.ok) { appendLog('error', '抖音窗口不可用'); return; }
  if (accountId !== curId()) return;
  await window.dsx.invoke('showDouyin', { accountId: accountId });
  await wait(1000);
  if (accountId === curId()) extractQr();
}
function extractQr() {
  window.dsx.invoke('extractQr', { accountId: curId() }).then(function (r) { if (r && !r.ok) appendLog('warn', '刷新二维码未生效：' + (r.error || '')); });
}
function hideQr() { el('qrImg').hidden = true; el('qrPlaceholder').hidden = false; }
async function logout() {
  if (!confirm('确定要退出当前账号吗？\n将清除本应用内该账号的登录态和好友列表缓存（下次需重新扫码并重新读取好友列表），已勾选的续火花目标与定时配置会保留。\n\n提示：退出会同时清掉本机该账号的设备登录痕迹，短时间内反复「退出→重登」在抖音看来是「新设备反复登录」，容易被提示「系统繁忙/操作频繁」。如非必要，请勿连着重复退出登录。')) return;
  appendLog('info', '[界面] 正在退出账号…');
  var accountId = curId();
  var r = await window.dsx.invoke('logout', { accountId: accountId });
  if (accountId !== curId()) return;
  if (r && r.ok) {
    ++stateRequestId; ++calRequestId;
    hideQr(); friends = []; selected.clear();
    updateAcctMeta(curId(), { loggedIn: false, offline: false, friends: [] });
    renderFriends(); renderStatus(false); renderAccounts();
    appendLog('info', '[界面] 已退出账号：状态为未登录，点「刷新二维码」可重新扫码登录');
  } else {
    appendLog('error', '[界面] 退出失败：' + ((r && r.error) || '未知原因'));
  }
}
async function parseFriends() {
  appendLog('info', '[界面] 读取好友列表中（需已登录，滚动抓取约 1~2 分钟）…');
  var r = await window.dsx.invoke('parseFriends', { accountId: curId() });
  if (r && r.ok) appendLog('info', '[界面] 读取完成，共 ' + r.count + ' 条');
  else appendLog('error', '[界面] 读取失败：' + ((r && r.error) || '未知'));
}
function renderFriends() {
  var body = el('friendBody');
  body.innerHTML = '';
  var c = cur();
  // 统计按「人」不按「行」：send-log 以昵称为键，同一人若在列表里重复出现两行
  // 会被重复计数（曾出现：实际只发了 4 位好友，状态卡却显示「今日已守护 6 位」）。
  var sentPeople = Object.create(null), allPeople = Object.create(null);
  friends.forEach(function (x) {
    var n = normNick(x && x.nickname);
    if (!n) return;
    allPeople[n] = 1;
    if (x.sentToday) sentPeople[n] = 1;
  });
  var sentCount = Object.keys(sentPeople).length;
  var peopleCount = Object.keys(allPeople).length;
  el('sentStat').textContent = peopleCount ? ('今日已续 ' + sentCount + ' / 未续 ' + (peopleCount - sentCount)) : '';
  var tg = el('todayGuard');
  if (tg) tg.textContent = sentCount > 0 ? ('今日已守护 ' + sentCount + ' 位好友 🔥') : '今日尚未续火花';
  if (!friends.length) {
    var tr = document.createElement('tr'); tr.className = 'empty';
    var td = document.createElement('td'); td.colSpan = 6; td.textContent = '暂无数据。登录后自动获取好友列表，也可点「读取好友列表」手动获取。';
    tr.appendChild(td); body.appendChild(tr); return;
  }
  var filterOn = el('filterSel') && el('filterSel').checked;
  var unsentOnly = el('filterUnsent') && el('filterUnsent').checked;
  friends.forEach(function (f, i) {
    if (filterOn && !selected.has(i)) return;
    if (unsentOnly && f.sentToday) return;
    if (searchText && (f.nickname || '').toLowerCase().indexOf(searchText) < 0 && String(f.lastMessage || '').toLowerCase().indexOf(searchText) < 0) return;
    var tr = document.createElement('tr');
    var tdChk = document.createElement('td');
    var cb = document.createElement('input'); cb.type = 'checkbox';
    cb.checked = selected.has(i);
    cb.onchange = function () { if (cb.checked) selected.add(i); else selected.delete(i); saveSelection(); };
    tdChk.appendChild(cb); tr.appendChild(tdChk);
    var tdN = document.createElement('td'); tdN.textContent = f.nickname || '(无昵称)'; tr.appendChild(tdN);
    var tdS = document.createElement('td');
    if (f.hasSpark) { tdS.textContent = '🔥'; tdS.title = '有火花'; }
    else { tdS.textContent = '—'; tdS.title = '无火花'; }
    tr.appendChild(tdS);
    var tdToday = document.createElement('td');
    if (f.sentToday) { tdToday.textContent = '✅'; tdToday.title = '今天已续过火花'; }
    else { tdToday.textContent = '—'; tdToday.title = '今天尚未续火花'; }
    tr.appendChild(tdToday);
    var tdT = document.createElement('td');
    var nick = f.nickname || '';
    var ti = document.createElement('input'); ti.type = 'time'; ti.className = 'ftime';
    ti.value = (c.friendTimes && c.friendTimes[nick]) || '';
    ti.title = '留空=用全局统一时间 ' + (c.time || '09:00');
    ti.onchange = function () {
      c.friendTimes = c.friendTimes || {};
      var v = ti.value;
      if (v) c.friendTimes[nick] = v; else delete c.friendTimes[nick];
      saveAll(false);
    };
    tdT.appendChild(ti); tr.appendChild(tdT);
    var tdM = document.createElement('td'); tdM.textContent = f.lastMessage || ''; tr.appendChild(tdM);
    body.appendChild(tr);
  });
  // 「已选 N」按人不按行（与 saveSelection/currentTargets 同口径）：真重名两行都勾选时人数只算一次，
  // 否则勾选后显示的行数与落盘的人数不一致
  var selPeople = Object.create(null);
  selected.forEach(function (i) { var sn = normNick(friends[i] && friends[i].nickname); if (sn) selPeople[sn] = 1; });
  el('selCount').textContent = '已选 ' + Object.keys(selPeople).length;
}
function renderTpl() {
  var box = el('tplList');
  if (!box) return;
  Array.prototype.forEach.call(box.querySelectorAll('.tplBtn'), function (b) { b.remove(); });
  var arr = config.quickMessages || [];
  arr.forEach(function (msg, i) {
    var btn = document.createElement('button');
    btn.className = 'tplBtn';
    btn.textContent = msg;
    btn.title = '点击填入发送内容';
    btn.onclick = function () { el('sendText').value = msg; saveDebounced(false); };
    var del = document.createElement('span');
    del.className = 'tplDel';
    del.textContent = ' ×';
    del.title = '删除这条文案';
    del.onclick = function () {
      config.quickMessages.splice(i, 1);
      renderTpl();
      saveAll(false);
    };
    btn.appendChild(del);
    box.appendChild(btn);
  });
}
/* ============ 续火花日历 ============ */
var calYear = 0, calMonth = 0, calHistory = {};
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function calKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
/** 拉取当前账号的日历记录并渲染（切账号/发送后/收到好友列表时调用） */
var calRequestId = 0;
async function loadCal() {
  var requestId = ++calRequestId;
  var accountId = curId();
  try {
    var r = await window.dsx.invoke('getSendHistory', { accountId: accountId });
    if (requestId !== calRequestId || accountId !== curId()) return;
    calHistory = (r && r.history) || {};
  } catch (e) {
    if (requestId !== calRequestId || accountId !== curId()) return;
    calHistory = {};
  }
  var now = new Date();
  if (!calYear) { calYear = now.getFullYear(); calMonth = now.getMonth(); }
  renderCal();
}
/** 渲染月历：✅ 全部成功(绿) / ✕ 有失败(红) / 无记录·未来(灰)；今天加橙色外框 */
function renderCal() {
  var title = el('calTitle'), grid = el('calGrid');
  if (!grid) return;
  if (title) title.textContent = calYear + '年' + (calMonth + 1) + '月';
  var note = el('calNote');
  if (note) { var cc = cur(); note.textContent = cc ? '· 账号「' + (cc.name || cc.id) + '」' : ''; }
  grid.innerHTML = '';
  var now = new Date();
  var todayKey = calKey(now);
  ['日', '一', '二', '三', '四', '五', '六'].forEach(function (n) {
    var d = document.createElement('div'); d.className = 'calDOW'; d.textContent = n; grid.appendChild(d);
  });
  var startDow = new Date(calYear, calMonth, 1).getDay();
  var daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  for (var i = 0; i < startDow; i++) {
    var sp = document.createElement('div'); sp.className = 'calCell empty'; grid.appendChild(sp);
  }
  for (var d = 1; d <= daysInMonth; d++) {
    var dt = new Date(calYear, calMonth, d);
    var key = calKey(dt);
    var entry = calHistory[key];
    var isFuture = dt.getTime() > now.getTime();
    var isToday = key === todayKey;
    var cell = document.createElement('div');
    var cls = 'calCell';
    var mark = '';
    var tip = '';
    if (entry) {
      if (entry.status === 'ok') { cls += ' ok'; mark = '✓'; }
      else if (entry.status === 'fail') { cls += ' fail'; mark = '✕'; }
      tip = '成功 ' + (entry.ok || 0) + ' / 失败 ' + (entry.fail || 0) + (entry.skipped ? '（跳过 ' + entry.skipped + '）' : '');
    } else if (isFuture) {
      cls += ' future';
    }
    if (isToday) cls += ' today';
    cell.className = cls;
    cell.textContent = d + (mark ? ' ' + mark : '');
    if (tip) cell.title = tip;
    grid.appendChild(cell);
  }
  positionCalPopup(); // 月历格子数变化（4~6 行）后浮层高度变化，展开时重新定位
}
/* ============ 日历浮层显隐与定位 ============ */
/** 展开/收起日历浮层。show 不传 = 切换；展开时定位并拉取最新记录 */
function toggleCalPopup(show) {
  var pop = el('calPopup'), btn = el('btnCal');
  if (!pop) return;
  var willShow = (typeof show === 'boolean') ? show : pop.hidden;
  if (willShow) {
    pop.hidden = false;
    if (btn) btn.classList.add('open');
    positionCalPopup();
    loadCal();
  } else {
    pop.hidden = true;
    if (btn) btn.classList.remove('open');
  }
}
/** 浮层定位到 📅 图标下方（右缘对齐）；下方/右侧空间不足时自动翻上、贴边 */
function positionCalPopup() {
  var pop = el('calPopup'), btn = el('btnCal');
  if (!pop || pop.hidden || !btn) return;
  var r = btn.getBoundingClientRect();
  var pw = pop.offsetWidth || 292;
  var ph = pop.offsetHeight || 300;
  var left = Math.round(r.right - pw); // 浮层右缘与图标右缘对齐
  if (left < 8) left = 8;
  if (left + pw > window.innerWidth - 8) left = Math.round(window.innerWidth - pw - 8);
  var top = Math.round(r.bottom + 6);
  if (top + ph > window.innerHeight - 8) { // 下方放不下则翻到图标上方
    var above = Math.round(r.top - ph - 6);
    top = above > 8 ? above : 8;
  }
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}
async function calClear() {
  if (!confirm('确定清空当前账号的日历记录吗？不可恢复。')) return;
  var r = await window.dsx.invoke('clearSendHistory', { accountId: curId() });
  if (r && r.ok) { appendLog('info', '[日历] 已清空当前账号的日历记录'); loadCal(); }
  else appendLog('error', '[日历] 清空失败：' + ((r && r.error) || '未知'));
}
function saveSelection() {
  var c = cur(); if (!c) return;
  var names = currentTargets(); // 复用同一套去重逻辑，「已选 N」也按人数显示
  c.targets = names;
  el('selCount').textContent = '已选 ' + names.length;
  var accountId = c.id;
  configSaveChain = configSaveChain.then(function () { return window.dsx.invoke('saveTargets', { accountId: accountId, targets: names }); }).then(function (r) {
    lastSaveResult = r || { ok: false };
    if (!lastSaveResult.ok) appendLog('error', '[好友] 选择保存失败，请重试');
    return lastSaveResult;
  }).catch(function () { lastSaveResult = { ok: false }; appendLog('error', '[好友] 选择保存失败，请重试'); return lastSaveResult; });
}
function syncIntervalState() {
  var mx = el('intervalMaxMs');
  if (mx) mx.disabled = !(el('randomInterval') && el('randomInterval').checked);
}
function renderConfig() {
  el('uiParticles').checked = !!config.uiParticles;
  el('disableGpu').checked = !!config.disableGpu;
  applyParticles();
  var c = cur();
  if (!c) { el('sendText').value = ''; }
  if (c) {
  el('sendText').value = c.message || '';
  el('sendTime').value = c.time || '09:00';
  el('intervalMs').value = c.intervalMs || 2000;
  el('intervalMaxMs').value = c.intervalMaxMs || 8000;
  el('randomMessage').checked = !!c.randomMessage;
  el('randomInterval').checked = !!c.randomInterval;
  syncIntervalState();
  el('autoOn').checked = !!c.auto;
  el('skipSent').checked = !!c.skipSentToday;
  el('secondTimeEnabled').checked = !!c.secondTimeEnabled;
  el('secondTime').value = c.secondTime || '21:00';
  var cb = config.closeBehavior || 'tray';
  el('closeTray').checked = (cb === 'tray');
  el('closeExit').checked = (cb === 'exit');
  var nm = c.networkMode || 'always';
  el('netAlways').checked = (nm !== 'auto');
  el('netAuto').checked = (nm === 'auto');
  }
  el('closeTray').checked = (config.closeBehavior || 'tray') === 'tray';
  el('closeExit').checked = config.closeBehavior === 'exit';
  el('notifyOn').checked = !!config.notifyOn;
  el('autoStart').checked = !!config.autoStart;
  el('smtpHost').value = config.smtpHost || '';
  el('smtpPort').value = config.smtpPort || '465';
  el('smtpUser').value = config.smtpUser || '';
  el('smtpPass').value = config.smtpPass || '';
  el('smtpTo').value = config.smtpTo || '';
}
var configSaveChain = Promise.resolve({ ok: true });
var lastSaveResult = { ok: true };
function flushConfigSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; return saveAll(false); }
  return configSaveChain.then(function () { return lastSaveResult; });
}
function saveAll(showTip) {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  var c = cur();
  if (c) {
    c.message = el('sendText').value;
    c.time = el('sendTime').value || '09:00';
    c.auto = el('autoOn').checked;
    c.skipSentToday = el('skipSent').checked;
    c.secondTimeEnabled = el('secondTimeEnabled').checked;
    c.secondTime = el('secondTime').value || '21:00';
    c.intervalMs = parseInt(el('intervalMs').value, 10) || 2000;
    c.intervalMaxMs = parseInt(el('intervalMaxMs').value, 10) || 8000;
    c.randomMessage = el('randomMessage').checked;
    c.randomInterval = el('randomInterval').checked;
    c.networkMode = el('netAuto').checked ? 'auto' : 'always';
  }
  config.closeBehavior = el('closeExit').checked ? 'exit' : 'tray';
  config.notifyOn = el('notifyOn').checked;
  config.autoStart = el('autoStart').checked;
  config.smtpHost = el('smtpHost').value.trim();
  config.smtpPort = el('smtpPort').value || '465';
  config.smtpUser = el('smtpUser').value.trim();
  config.smtpPass = el('smtpPass').value;
  config.smtpTo = el('smtpTo').value.trim();
  config.uiParticles = el('uiParticles').checked;
  config.disableGpu = el('disableGpu').checked;
  var snapshot = JSON.parse(JSON.stringify(config));
  var accountId = curId();
  configSaveChain = configSaveChain.then(function () {
    return window.dsx.invoke('saveConfig', { accountId: accountId, config: snapshot });
  }).then(function (r) {
    lastSaveResult = r || { ok: false };
    if (!lastSaveResult.ok) appendLog('error', '[界面] 配置保存失败，修改尚未落盘');
    else if (showTip) appendLog('info', '[界面] 配置已保存');
    return lastSaveResult;
  }).catch(function () {
    lastSaveResult = { ok: false };
    appendLog('error', '[界面] 配置保存失败，请重试');
    return lastSaveResult;
  });
  return configSaveChain;
}
/* 配置保存防抖：连续改动（时间/间隔/开关等 onchange）合并成一次落盘，避免频繁原子写 + 重建所有定时器 */
var saveTimer = null;
function saveDebounced(showTip) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function () { saveTimer = null; saveAll(showTip); }, 400);
}
/**  引入、 改分钟数判定：HH:MM → 一天内分钟数（补零字符串比较判不出跨午夜次序） */
function hhmmMin(s) {
  var p = String(s == null ? '' : s).trim().split(':');
  var h = Number(p[0]), m = Number(p[1]);
  return (isFinite(h) ? h : 0) * 60 + (isFinite(m) ? m : 0);
}
/** 该时间点是否会在第二时段之后「不久」再发一次（与主进程 secondSlotOrderConflicts 同口径， 窗口收紧到 6 小时）：
 *  ① 同日更晚；② 跨午夜紧邻（从第二时段到它不足 6 小时）——兜底发完午夜一过日期翻新，
 *  「跳过今天已发过」失效，好友会在同一晚几小时内收到两条。窗口取半天会把「09:00 + 第二时段 22:00」
 *  这类正常配置误判（隔一整夜本是正常日节奏），弹无谓的确认框。完全同刻由「今天已发过」跳过，不算冲突。 */
function firesAfterSecondSlot(t, secondMin) {
  var m = hhmmMin(t);
  if (m > secondMin) return true;
  if (m === secondMin) return false;
  return (1440 - secondMin + m) < 360;
}
/** 是否存在会在第二时段之后再发一次的设定时间（全局时间/好友独立时间），供保存前确认 */
function hasLaterSchedule(c, secondTime) {
  var st2 = hhmmMin(secondTime);
  if (firesAfterSecondSlot(c.time, st2)) return true;
  var names = (c.targets || []).map(function (t) { return (typeof t === 'string') ? t : ((t && t.nickname) || ''); });
  for (var i = 0; i < names.length; i++) {
    var tm = c.friendTimes ? c.friendTimes[names[i]] : '';
    if (tm && firesAfterSecondSlot(tm, st2)) return true;
  }
  return false;
}
/** 开机自启：查询并展示系统侧实际状态（配置想开 vs 系统是否真写入），避免静默失败无感知 */
async function refreshAutoStartStatus() {
  var box = el('autoStartStatus');
  if (!box) return;
  try {
    var r = await window.dsx.invoke('getAutoStart') || {};
    var want = !!(r.configEnabled);
    var got = !!(r.openAtLogin);
    var t = '系统启动项：' + (got ? '✓ 已写入' : '— 未写入');
    if (got && r.execPath) t += ' → ' + r.execPath;
    if (want && !got) {
      t += ' ｜ 已勾选但系统侧未生效：可能被安全软件拦截或注册表写入失败，请查看运行日志';
      box.style.color = '#c0392b';
    } else {
      box.style.color = '#888';
    }
    box.textContent = t;
  } catch (e) { box.textContent = ''; }
}
/** 昵称归一化：与主进程 normFriendNick / 注入侧 normNickStr 同口径 */
function normNick(s) {
  return String(s == null ? '' : s).replace(/[\u200B-\u200F\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
}
function seedSelection(names) {
  selected.clear();
  (names || []).forEach(function (n) {
    var key = normNick(typeof n === 'string' ? n : n && n.nickname);
    if (!key) return;
    // 归一化比较：配置里存的旧昵称可能带零宽字符/多余空白，精确相等会勾不中任何行
    for (var i = 0; i < friends.length; i++) { if (normNick(friends[i].nickname) === key) { selected.add(i); break; } }
  });
}
function currentTargets() {
  var names = [], seen = Object.create(null);
  selected.forEach(function (i) {
    var n = friends[i] && friends[i].nickname;
    if (!n) return;
    var key = normNick(n);
    // 同一人只留一个目标——重复行时代两个重复行都被勾选会推两遍昵称，
    // 而主进程「跳过今天已发过」只在发送循环前过滤一次，同一人会在一批里收到两条
    if (!key || seen[key]) return;
    seen[key] = 1;
    names.push(n);
  });
  return names;
}
async function sendNow() {
  var c = cur();
  var targets = currentTargets();
  if (!(await saveAll(false)).ok) return;
  if (!targets.length) { appendLog('error', '请先在列表勾选要续火花的好友'); return; }
  if (!c.message || !c.message.trim()) { appendLog('error', '发送内容不能为空'); return; }
  appendLog('info', '[界面] 开始续火花：' + targets.length + ' 个目标（账号「' + c.name + '」）' + (c.skipSentToday ? '（跳过今天已发过的）' : ''));
  var r = await window.dsx.invoke('sendNow', { accountId: c.id, targets: targets, message: c.message, intervalMs: c.intervalMs || 2000, skipSentToday: c.skipSentToday });
  loadCal(); // 发送完成会写入日历记录，刷新
  if (r && r.ok) appendLog('info', '[界面] 全部完成（成功 ' + r.done + '，失败 ' + r.failed + '）');
  else appendLog('error', '[界面] 未能发送：' + ((r && r.error) || '未知'));
}
async function sendTestEmail() {
  var host = el('smtpHost').value.trim();
  var port = el('smtpPort').value || '465';
  var user = el('smtpUser').value.trim();
  var pass = el('smtpPass').value;
  var to = el('smtpTo').value.trim();
  if (!host || !user || !pass || !to) { appendLog('error', '[测试邮件] 发送失败：SMTP 未配置（请填写 SMTP 服务器/发件账号/授权码/收件邮箱）'); return; }
  appendLog('info', '[测试邮件] 正在发送…');
  var r = await window.dsx.invoke('sendTestEmail', { smtpHost: host, smtpPort: port, smtpUser: user, smtpPass: pass, smtpTo: to });
  if (r && r.ok) appendLog('info', '[测试邮件] 已发送成功');
  else appendLog('error', '[测试邮件] 发送失败：' + ((r && r.error) || '未知原因'));
}
async function genTask() {
  var c = cur();
  if (!(await saveAll(false)).ok) return;
  var r = await window.dsx.invoke('generateTask', { accountId: c ? c.id : '', time: c ? c.time : '09:00' });
  if (r && r.ok) {
    var box = el('taskResult');
    box.hidden = false;
    var tip = '✔ 已生成计划任务脚本：' + r.file + '\n每天 ' + (c ? c.time : '09:00') + ' 自动续火花。\n双击上方完整路径里的 install-task.bat 完成安装（免安装版在 %APPDATA%\\douyin-xuhuohua-helper\\data\\ 下）。\n删除任务：' + r.delete;
    // 常驻定时与计划任务同刻会重复发送，生成时给出二选一提醒
    if (c && c.auto) {
      tip += '\n⚠ 检测到本账号「每日自动续火花」已开启：程序常驻时到点由应用自己发送，计划任务到点再跑一遍会重复发送相同消息。二者请二选一——程序常驻使用即可不装计划任务，或关闭每日自动只用计划任务。';
      appendLog('warn', '[界面] 「每日自动」与计划任务同开会重复发送，建议二选一（详见任务提示框）');
    }
    box.textContent = tip;
    appendLog('info', '[界面] 计划任务脚本已生成：' + r.file);
  } else appendLog('error', '生成失败：' + ((r && r.error) || '未知'));
}
function appendLog(level, msg) {
  var box = el('logBox');
  var tag = { 'error': 'ERR', 'warn': 'WARN', 'info': 'INFO' }[level] || 'INFO';
  box.textContent += '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + tag + ' ' + msg + '\n';
  // 截断：只保留最近 600 行，避免长时间运行 DOM 无限膨胀
  var lines = box.textContent.split('\n');
  if (lines.length > 600) box.textContent = lines.slice(lines.length - 600).join('\n');
  box.scrollTop = box.scrollHeight;
}
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ============ 二次元背景粒子（L2，默认关） ============ */
/* 纯 CSS 动画：JS 只负责一次性生成粒子元素 + 增删 body 类名，之后交给 GPU 合成器，
 * 无 requestAnimationFrame 连续循环；关闭或系统「减少动态效果」时自动移除/隐藏。 */
var particleBox = null;
function applyParticles() {
  var on = !!(config && config.uiParticles);
  document.body.classList.toggle('particles-on', on);
  if (on && !particleBox) {
    particleBox = document.createElement('div');
    particleBox.className = 'particles';
    var colors = ['#8ECAE6', '#9AD0C2', '#FFB7C5', '#C8A8E9', '#FFD166'];
    for (var i = 0; i < 14; i++) {
      var s = document.createElement('span');
      s.className = 'spark';
      var size = 4 + Math.random() * 8;
      s.style.width = size + 'px';
      s.style.height = size + 'px';
      s.style.left = (Math.random() * 100) + '%';
      s.style.background = colors[Math.floor(Math.random() * colors.length)];
      s.style.setProperty('--dur', (12 + Math.random() * 14) + 's');
      s.style.setProperty('--delay', (-Math.random() * 22) + 's');
      s.style.setProperty('--drift', ((Math.random() * 90) - 45) + 'px');
      particleBox.appendChild(s);
    }
    document.body.appendChild(particleBox);
  } else if (!on && particleBox) {
    try { particleBox.remove(); } catch (e) {}
    particleBox = null;
  }
}