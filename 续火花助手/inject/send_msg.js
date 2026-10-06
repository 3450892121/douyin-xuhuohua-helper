(function () {
  var attemptId = window.__sendAttemptId;
  var deadline = window.__sendDeadline;
  if (!attemptId || !Number.isFinite(deadline) || Date.now() >= deadline) return;
  if (window.__xhSendRun) window.__xhSendRun.cancel();
  var name = window.__sendName;
  var targetId = window.__sendId || '';
  var text = String(window.__sendText || '');
  var targetName = normName(name);
  var run = { cancelled: false, finished: false, timers: new Set(), cancel: cancel };
  var clickedSend = false;
  var abortReason = '';
  var hiddenLogged = false;
  var editorWaitStart = 0;
  window.__xhSendRun = run;

  /* ===== 日志通道：隐藏窗口的 console.log 进不了 app.log，发送环节出问题时
   * 没有过程证据；里程碑统一经 AndroidBridge.log('info') 回传，每条带「发送」字样以通过
   * 主进程 handleBridge 的 interesting 过滤。发送正文绝不进该通道。 ===== */
  function slog(msg) {
    try { console.log(msg); } catch (e) {}
    try { if (window.AndroidBridge && window.AndroidBridge.log) window.AndroidBridge.log('info', String(msg)); } catch (e2) {}
  }

  /** 昵称归一化：与解析侧/主进程同口径（去零宽字符 + 压缩空白 + trim）。
   *  目标昵称来自解析侧（抓取时已归一化），而会话标题此前只 trim——昵称含零宽字符或内部
   *  多空格时两边永远不相等，滚动查找 15s 后报「未找到会话」，表现为静默漏发。 */
  function normName(s) { return String(s == null ? '' : s).replace(/[\u200B-\u200F\uFEFF]/g, '').replace(/\s+/g, ' ').trim(); }

  function cancel() {
    run.cancelled = true;
    run.timers.forEach(function (timer) { clearTimeout(timer); });
    run.timers.clear();
  }
  function isCancelled() {
    return run.cancelled || run.finished || window.__xhSendRun !== run || window.__sendAttemptId !== attemptId || Date.now() >= deadline;
  }
  function later(fn, ms) {
    var timer = setTimeout(function () { run.timers.delete(timer); if (!isCancelled()) fn(); }, ms);
    run.timers.add(timer);
  }
  function report(ok, detail) {
    if (isCancelled()) return;
    run.finished = true;
    cancel();
    slog(detail);
    try { window.AndroidBridge.onSendResult(ok ? 1 : 0, detail, attemptId, !clickedSend && !abortReason); } catch (e) {}
  }
  function visible(el) {
    if (!el || el.isConnected === false) return false;
    var r = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }
  /** 已渲染：只查「元素在文档里且未被 display:none / visibility:hidden 隐藏」，不要求尺寸>0。
   *  用于会话标题这类「被挤压成 0 宽但内容真实」的元素——真机实测：抖音窗口 460px 宽时右侧面板
   *  头部标题 DIV.RightPanelHeadertitle 尺寸恒为 0x21（宽 0、高 21），文本与当前会话一一对应；
   *   用 visible() 校验它导致所有发送在「等待输入框」超时。 */
  function displayed(el) {
    if (!el || el.isConnected === false) return false;
    try {
      var style = window.getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none';
    } catch (e) { return false; }
  }
  function fakeClick(el, opts) {
    // opts.allowZeroSize 供发送按钮使用（真机上它可能被挤压成 0 宽；点击是按元素派发的，
    // 不依赖命中测试）；会话项仍走严格 visible——那是「防点到隐藏副本」的关键防线。
    var sizeOk = (opts && opts.allowZeroSize) ? displayed(el) : visible(el);
    if (isCancelled() || !sizeOk) return false;
    try {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      var r = el.getBoundingClientRect();
      var evOpts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
        if (!isCancelled()) el.dispatchEvent(type.indexOf('pointer') === 0 ? new PointerEvent(type, evOpts) : new MouseEvent(type, evOpts));
      });
      return !isCancelled();
    } catch (e) { return false; }
  }

  /** href 是否精确指向 /messages/{id} 会话（按路径段全等比较）。
   *  不能用无边界前缀匹配：id="123" 会误命中 /messages/1234，可能点错会话发错人。 */
  function hrefMatchesId(href, id) {
    var s = String(href || '');
    var idx = s.indexOf('/messages/' + id);
    if (idx < 0) return false;
    var rest = s.slice(idx + ('/messages/' + id).length);
    return !rest || /^[/?#]/.test(rest);
  }
  function matchesId(el, id) {
    var attrs = ['data-id', 'data-sec-uid', 'data-conversation-id', 'data-user-id', 'data-uid', 'id'];
    for (var i = 0; i < attrs.length; i++) { if (el.getAttribute(attrs[i]) === id) return true; }
    var a = el.closest('a[href]');
    if (a && hrefMatchesId(a.getAttribute('href'), id)) return true;
    return Array.from(el.querySelectorAll('a[href]')).some(function (link) { return hrefMatchesId(link.getAttribute('href'), id); });
  }

  /* 会话项选择器兜底清单（与解析侧 douyin_auto.js 的多兜底对齐）：
   * 此前发送侧只依赖单一 div[data-e2e="conversation-item"]，抖音改版改类名时会出现
   * 「好友解析成功但全部发送超时失败」的不对称故障；现在按序尝试，任一命中即用。 */
  var CONVERSATION_SELECTORS = [
    'div[data-e2e="conversation-item"]', 'div[data-e2e*="conversation"]',
    '[class*="ConversationItem"], [class*="conversation-item"]',
    '[class*="ChatItem"], [class*="chat-item"]', 'a[href*="/messages/"]'
  ];
  function rawConvItems() {
    for (var s = 0; s < CONVERSATION_SELECTORS.length; s++) {
      try {
        var els = document.querySelectorAll(CONVERSATION_SELECTORS[s]);
        if (els.length) return Array.prototype.slice.call(els);
      } catch (e) {}
    }
    return [];
  }
  /* 会话项是否可见：解析侧 queryChatListItems 一直有这道过滤（高<30 或宽<60 丢弃），
   * 发送侧此前没有——实测抖音把每个会话渲染两份（一份零尺寸隐藏），点击零尺寸副本不会切换
   * 会话，消息会打进上一个好友的聊天框。补齐同口径。 */
  function isVisibleItem(el) {
    var r = el.getBoundingClientRect();
    return visible(el) && r.height >= 30 && r.width >= 60;
  }
  function convItems() {
    var raw = rawConvItems();
    var out = [], hidden = 0;
    for (var i = 0; i < raw.length; i++) { if (isVisibleItem(raw[i])) out.push(raw[i]); else hidden++; }
    if (hidden > 0 && !hiddenLogged) {
      hiddenLogged = true;
      slog('[SEND] 会话列表诊断：原始项=' + raw.length + ' 可见项=' + out.length + ' 隐藏项=' + hidden);
    }
    return out;
  }
  /** 取会话项的头像（用于同名多条时区分真重名）：项内面积最大的 http 图片，去掉 query/fragment，
   *  图标类 URL（火花/表情等）视为无头像。实测会话项里有 50x50 的头像与 17x22 的图标各一张。
   *  正则与主进程 ICON_AVATAR_RE / 解析侧三处必须逐字一致（口径漂移会造成同名误判）。 */
  /* 头像「身份键」（与主进程 friendAvatarKey / 解析侧 avatarKeyOf 同口径）：
   * 去掉 CDN 域名与 query，只留对象路径——抖音头像 CDN 域名会轮换（同一好友同一对象两程
   * 分别抓到 p3.huoshanimg.com 与 p11.douyinpic.com），带域名比较会把同一人判成两个，
   * 同名裁决就会误判「真重名」停发（实证：曾连续多次误判停发）。
   * 默认占位头像跨人相同（没设头像的用户共用 aweme_default_avatar.png），返回 DEFAULT_AVATAR_MARK
   * 由调用方单独计数：它证明不了「是同一人」，不能进头像集合当成一致。 */
  var DEFAULT_AVATAR_MARK = '__default_avatar__';
  function itemAvatar(el) {
    try {
      var imgs = el.querySelectorAll('img');
      var best = '', bestArea = 0;
      for (var i = 0; i < imgs.length; i++) {
        var src = String(imgs[i].getAttribute('src') || '');
        if (src.indexOf('http') !== 0) continue;
        if (/flame|fire|spark|huohua|emoji|gray_normal|lit_normal|\/icons?\/|_icon\b|icon[_-]/i.test(src)) continue;
        var r = imgs[i].getBoundingClientRect();
        var area = (r.width || 0) * (r.height || 0);
        if (area > bestArea) { bestArea = area; best = src; }
      }
      if (!best) return '';
      best = best.split('#')[0].split('?')[0];
      if (/\/aweme_default_avatar\./i.test(best)) return DEFAULT_AVATAR_MARK;
      return best.replace(/^[a-z][a-z0-9+.\-]*:\/\/[^/]+/i, '');
    } catch (e) { return ''; }
  }

  /* ===== 一次性只读诊断采样（临时取证；切换校验与同名 fail-closed 实现后整段移除）=====
   * 取两件事的证据：① 点击会话后聊天窗是否真的切到目标（需要知道哪个元素显示当前会话标题、
   * 以及被点中的会话项有没有选中态 class 可比对）；② 页面上同名会话项到底有几条、隐藏项与
   * 兜底选择器会不会虚增计数（决定注入侧能否安全地做「同名多于一条即停发」）。
   * 走 warn 级别：handleBridge 对 warn 保留 1500 字符（info 只 300），且 SEND-DIAG 标签刻意
   * 不在其 noisy 过滤名单里。候选标题文本一律截断到 12 字符，避免把聊天正文写进日志。 */
  function diagSay(prefix, text) {
    var s = String(text == null ? '' : text);
    for (var i = 0, n = 1; i < s.length; i += 1300, n++) {
      var chunk = 'SEND-DIAG ' + prefix + '(' + n + ') ' + s.slice(i, i + 1300);
      try { console.log(chunk); } catch (e) {}
      try { if (window.AndroidBridge && window.AndroidBridge.log) window.AndroidBridge.log('warn', chunk); } catch (e2) {}
    }
  }
  /** 类名字符串：SVG 元素的 className 是 SVGAnimatedString 对象，String() 会得到
   *  "[object SVGAnimatedString]"——真机的发送按钮正是 <svg class="...publishBtn...">，
   *  类名比对必须走 getAttribute('class')，否则永远匹配不上。 */
  function classAttr(el) {
    try { return String(el.getAttribute('class') || el.className || ''); } catch (e) { return ''; }
  }
  function clsOf(el) { try { return (el.tagName || '?') + '.' + classAttr(el).slice(0, 60); } catch (e) { return '?'; } }
  function rectOf(el) { try { var r = el.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.top); } catch (e) { return '0x0@0'; } }
  function imgsOf(el) {
    try {
      var imgs = el.querySelectorAll('img');
      var out = [];
      for (var i = 0; i < imgs.length && i < 3; i++) {
        var src = String(imgs[i].getAttribute('src') || '');
        out.push(rectOf(imgs[i]) + ':' + (src ? src.slice(0, 70) : '(空src)'));
      }
      return out.length ? out.join(',') : '无img';
    } catch (e) { return 'img异常'; }
  }
  /** 会话列表侧采样（在点击目标之前调用） */
  function diagConv(hit) {
    try {
      var perSel = [];
      for (var s = 0; s < CONVERSATION_SELECTORS.length; s++) {
        var n = 0; try { n = document.querySelectorAll(CONVERSATION_SELECTORS[s]).length; } catch (e) {}
        perSel.push(s + ':' + n);
      }
      // 原始项 vs 可见项：实测抖音把每个会话渲染两份（一份零尺寸隐藏），必须分开统计才看得出过滤效果
      var raw = rawConvItems();
      var items = convItems();
      var same = [], hidden = 0, noTitle = 0;
      for (var i = 0; i < raw.length; i++) {
        var vis = isVisibleItem(raw[i]);
        if (!vis) hidden++;
        var t = raw[i].querySelector('[class*="Itemtitle"]');
        if (!t) noTitle++;
        var txt = t ? normName((t.innerText || '').split('\n')[0]) : '';
        if (txt && txt === targetName) {
          same.push('#' + i + (vis ? '' : '(隐藏)') + ' ' + rectOf(raw[i]) + ' title=' + (t ? 'Y' : 'N') +
            ' imgs=' + imgsOf(raw[i]) + ' cls=' + String(raw[i].className || '').slice(0, 40) +
            (raw[i] === hit ? ' <==本次点击' : ''));
        }
      }
      diagSay('会话项', '各选择器命中[' + perSel.join(' ') + '] 原始项=' + raw.length + ' 可见项=' + items.length +
        ' 隐藏项=' + hidden + ' 同名命中=' + same.length + ' 无Itemtitle项=' + noTitle +
        ' 目标昵称=' + targetName + ' | ' + same.join(' || '));
    } catch (e) { diagSay('会话项', '采样异常 ' + (e && e.message)); }
  }
  /** 聊天区侧采样（在找到输入框、输入内容之前调用） */
  function diagChatPane(editor) {
    try {
      // 第一轮采样结论：往上第 5 层是 componentsRightPanelnotHeaderArea（右侧面板「不含头部」区），
      // 所以只捞到消息卡片里的作者名（MessageItemShareAwemeauthorName），看不到会话标题 → 祖先链加到 10 层
      var chain = [], cur = editor;
      for (var d = 0; d < 10 && cur; d++) { chain.push(d + ':' + clsOf(cur)); cur = cur.parentElement; }
      diagSay('聊天区A', '祖先链=' + chain.join(' > '));

      // 全文档扫描：归一化文本恰好等于目标昵称的叶子元素。会话列表里必有一处，聊天区头部应当也有一处；
      // 记录坐标与三层祖先类名即可区分两者（不打印文本本身——它就等于目标昵称，已在会话项采样里记过）
      var eq = [];
      var all = document.querySelectorAll('div,span,p,h1,h2,h3,h4');
      for (var i = 0; i < all.length && eq.length < 12; i++) {
        var el = all[i];
        if (el.children && el.children.length) continue;
        var txt = normName(el.innerText || el.textContent || '');
        if (!txt || txt !== targetName) continue;
        var up = [], p = el;
        for (var u = 0; u < 3 && p; u++) { up.push(clsOf(p)); p = p.parentElement; }
        var rr = el.getBoundingClientRect();
        eq.push(Math.round(rr.width) + 'x' + Math.round(rr.height) + '@' + Math.round(rr.left) + ',' + Math.round(rr.top) + ' ' + up.join(' < '));
      }
      diagSay('聊天区B', '全文档文本等于目标昵称的叶子(' + eq.length + ' 处)=' + (eq.length ? eq.join(' || ') : '无'));

      // 头部区候选：定位类名含 RightPanel 的面板，取其内不在 notHeaderArea/messageEditor/MessageItem 里的
      // 短文本叶子（文本截断 12 字符，避免带出聊天正文）——这就是「切换校验」要读的标题元素候选
      var panel = editor;
      while (panel && panel.parentElement && !/RightPanel/i.test(String(panel.className || ''))) panel = panel.parentElement;
      if (panel && panel.parentElement) panel = panel.parentElement; // 再上一层，把头部区纳入范围
      var hdr = [];
      if (panel) {
        var cands = panel.querySelectorAll('div,span,p,h1,h2,h3,h4');
        for (var k = 0; k < cands.length && hdr.length < 15; k++) {
          var ce = cands[k];
          if (ce.children && ce.children.length) continue;
          var t2 = normName(ce.innerText || ce.textContent || '');
          if (!t2 || t2.length > 40) continue;
          var inBody = false, q = ce;
          while (q && q !== panel) {
            if (/notHeaderArea|messageEditor|MessageItem|messageMsgInput/i.test(String(q.className || ''))) { inBody = true; break; }
            q = q.parentElement;
          }
          if (inBody) continue;
          hdr.push(clsOf(ce) + '=' + t2.slice(0, 12) + (t2 === targetName ? '★' : ''));
        }
      }
      diagSay('聊天区C', '头部区候选(' + hdr.length + '，面板' + (panel ? '已定位' : '未定位') + ')=' + (hdr.length ? hdr.join(' ; ') : '无'));
    } catch (e) { diagSay('聊天区', '采样异常 ' + (e && e.message)); }
  }
  /** 等待输入框超时的只读取证：曾出现真机四个好友全部卡死在「等待输入框
   *  超时」，但日志只有一句超时、看不出卡在哪一级（编辑器不可见？面板没定位？标题文本不等？）。
   *  这里把「编辑器 / 面板 / 面板内同名叶子」三级命中数一次采样，下次真机失败可直接定位。 */
  function diagEditorTimeout() {
    try {
      var all = Array.from(document.querySelectorAll('[contenteditable="true"], textarea'));
      var shownEditors = all.filter(displayed);
      var panels = 0, nameAny = 0, nameShown = 0, nameVisible = 0;
      shownEditors.forEach(function (e) {
        var p = chatPanel(e);
        if (!p) return;
        panels++;
        var leaves = p.querySelectorAll('div,span,p,h1,h2,h3,h4,a');
        for (var i = 0; i < leaves.length; i++) {
          var leaf = leaves[i];
          if (leaf.children.length || normName(leaf.innerText) !== targetName) continue;
          nameAny++;
          if (displayed(leaf)) nameShown++;
          if (visible(leaf)) nameVisible++;
        }
      });
      diagSay('等输入框', '编辑器 总数=' + all.length + ' 已渲染=' + shownEditors.length + ' 可见=' + all.filter(visible).length +
        ' | 面板定位=' + panels + ' 面板内同名叶子 存在=' + nameAny + ' 已渲染=' + nameShown + ' 可见=' + nameVisible +
        ' 目标昵称=' + targetName);
    } catch (e) { diagSay('等输入框', '采样异常 ' + (e && e.message)); }
  }
  /** 发送结果校验失败的只读取证：真机消息行的类名/状态属性此前从未采样过，
   *  「新行 + sent 状态」判定能否适配真实 DOM 要靠真机发送验证；这里 dump 行级结构（类名截断、不含正文）。 */
  function diagSendRows(rows, fresh, baseline, cleared) {
    try {
      var sample = rows.slice(-6).map(function (row) {
        return clsOf(row) + ' out=' + (outgoing(row) ? 1 : 0) + ' fresh=' + (fresh.indexOf(row) >= 0 ? 1 : 0) +
          ' state=' + messageState(row) + ' key=' + (messageKey(row) || '-');
      });
      diagSay('消息行', '总行数=' + rows.length + ' 基线行数=' + baseline.nodes.size + ' 新行数=' + fresh.length +
        ' 输入框已清空=' + (cleared ? 1 : 0) + ' 末尾行采样=' + (sample.length ? sample.join(' || ') : '无'));
    } catch (e) { diagSay('消息行', '采样异常 ' + (e && e.message)); }
  }

  // 在可见会话项中查找目标（优先按会话 id 精确定位，缺失则回退昵称匹配）
  // abortReason 非空 = 明确停发（防发错人），查找循环据此立即中止，不再滚动、也不报「未找到会话」
  function findTargetInVisible() {
    var items = convItems();
    if (targetId) {
      for (var i = 0; i < items.length; i++) { if (matchesId(items[i], targetId)) return items[i]; }
      return null;
    }
    // 昵称回退（抖音改版后 id 全站抓空，这是常态路径）：先把可见项里的同名命中全收上来再裁决
    var hits = [];
    for (var j = 0; j < items.length; j++) {
      var titleEl = items[j].querySelector('[class*="Itemtitle"]');
      var fullText = titleEl ? (titleEl.innerText || '').trim() : '';
      var firstLine = fullText.split('\n')[0].trim();
      if (firstLine && normName(firstLine) === targetName) hits.push(items[j]);
    }
    if (!hits.length) return null;
    if (hits.length === 1) return hits[0];
    // 同名多条（可见项里，已排除隐藏副本）：按头像区分同一人重复与真重名——与主进程
    // resolveSendTargetId 同口径（头像互不相同=真重名停发；头像全缺=无法判定也停发；头像一致=同一人放行）
    // 默认占位头像跨人相同，单独计数且一律停发（「默认头像 + 真头像」放行会发错人）
    var avs = {}, avCount = 0, defCount = 0;
    for (var k = 0; k < hits.length; k++) {
      var av = itemAvatar(hits[k]);
      if (av === DEFAULT_AVATAR_MARK) { defCount++; continue; }
      if (av && !avs[av]) { avs[av] = 1; avCount++; }
    }
    if (!defCount && avCount === 1) {
      slog('[SEND] 发送：同名会话 ' + hits.length + ' 条但头像一致，按同一人处理');
      return hits[0];
    }
    abortReason = (avCount > 1)
      ? ('可见会话里有 ' + hits.length + ' 条同名「' + targetName + '」且头像不同（真重名），已停发以防发错人')
      : ('可见会话里有 ' + hits.length + ' 条同名「' + targetName + '」且' +
        (defCount > 0 ? '有 ' + defCount + ' 条用的是抖音默认头像' : '都取不到头像') + '（无法判定），已停发以防发错人');
    return null;
  }

  function isInside(el, root) {
    try { return !!el && !!root && (el === root || root.contains(el)); } catch (e) { return false; }
  }

  /* ===== 发送结果确认（标题可见性口径已校准）：右侧面板头部叶子文本与
   * 目标昵称一致才算「还在目标会话」；成功必须有「点击发送后新出现的 outgoing 且状态 sent 的
   * 消息行」且输入框已清空；只有历史消息或仅输入框清空都不算成功；结果未知一律不再自动重试。
   * 标题叶子改用 displayed()（真机实测标题宽 0，visible() 会把所有发送卡死在超时）。 ===== */
  function chatPanel(editor) {
    for (var p = editor.parentElement; p; p = p.parentElement) {
      if (/RightPanelnotHeaderArea/i.test(String(p.className))) return p.parentElement;
      if (/RightPanel/i.test(String(p.className))) return p;
    }
    return null;
  }
  function confirmsRecipient(panel) {
    if (!panel || !displayed(panel)) return false;
    var leaves = panel.querySelectorAll('div,span,p,h1,h2,h3,h4,a');
    for (var i = 0; i < leaves.length; i++) {
      var leaf = leaves[i];
      // 这里只要求「已渲染」（displayed），不再要求宽高>0——真机标题恒为 0 宽；
      // 首屏同名叶子只可能出现在左侧会话列表（不在本面板内）与面板头部，文本相等即可安全确认。
      if (leaf.children.length || !displayed(leaf) || normName(leaf.innerText) !== targetName) continue;
      var blocked = false;
      for (var p = leaf; p && p !== panel; p = p.parentElement) {
        if (/notHeaderArea|MessageItem|messageEditor|messageMsgInput|conversation|ChatList/i.test(String(p.className)) || p.getAttribute('contenteditable') === 'true') { blocked = true; break; }
      }
      if (!blocked) return true;
    }
    return false;
  }
  function editorText(editor) { return String(editor.tagName === 'TEXTAREA' ? editor.value : editor.innerText || '').replace(/\u200b/g, '').trim(); }
  function contextMatches(panel, editor) {
    // 编辑器与面板都改用 displayed（真机被挤压成 0 宽）+ 结构判定（面板链/包含关系）与标题文本双重把关
    return displayed(editor) && editor.isConnected && isInside(editor, panel) && chatPanel(editor) === panel && confirmsRecipient(panel);
  }
  function messageRows(panel) {
    var all = Array.from(panel.querySelectorAll('[data-message-id], [data-e2e="message-item"], [class*="MessageItem"], [class*="messageItem"]'));
    return all.filter(function (row) { return visible(row) && !all.some(function (other) { return other !== row && other.contains(row); }); });
  }
  function messageKey(row) { return row.getAttribute('data-message-id') || row.getAttribute('data-id') || ''; }
  function matchingText(row) {
    return Array.from(row.querySelectorAll('span,p,div')).some(function (leaf) { return !leaf.children.length && normName(leaf.innerText) === normName(text); });
  }
  function outgoing(row) {
    // 类名匹配改为大小写不敏感——真机类名是 PascalCase（MessageItem…），此前正则里
    // 只写了小写 self/isMe，写成 MessageItemRightSelf 这类真实形态会被漏判、结果一律「未知」。
    return row.getAttribute('data-is-self') === 'true' || row.getAttribute('data-self') === 'true' || row.getAttribute('data-direction') === 'outgoing' || /(?:self|outgoing|isme|messageitemright)/i.test(String(row.className));
  }
  function messageState(row) {
    var nodes = [row].concat(Array.from(row.querySelectorAll('[data-status], [data-message-status], [aria-label], [class*="Status"], [class*="status"], [class*="Sending"], [class*="Fail"]')));
    var state = nodes.map(function (node) { return [node.getAttribute('data-status'), node.getAttribute('data-message-status'), node.getAttribute('aria-label'), node === row ? '' : node.innerText, node.className].join(' '); }).join(' ');
    if (/failed|error|发送失败|重新发送|未发送/i.test(state)) return 'failed';
    if (/sending|pending|loading|发送中/i.test(state)) return 'pending';
    return /\b(?:sent|delivered|read|success)\b|已发送|已送达|已读/i.test(state) ? 'sent' : 'unknown';
  }
  function verify(panel, editor, baseline, started) {
    if (!contextMatches(panel, editor)) { report(false, '发送结果未知：聊天对象已改变，请核对聊天记录'); return; }
    var rows = messageRows(panel);
    var fresh = rows.filter(function (row) {
      var key = messageKey(row);
      return outgoing(row) && matchingText(row) && !baseline.nodes.has(row) && (!key || !baseline.ids.has(key));
    });
    if (fresh.some(function (row) { return messageState(row) === 'failed'; })) { report(false, '页面提示发送失败，请核对后再发送'); return; }
    var cleared = !editorText(editor);
    if (cleared && fresh.length === 1 && messageState(fresh[0]) === 'sent') { report(true, '发送成功（本次新消息已确认）'); return; }
    // 真机消息行没有「已发送」状态标记（状态只在失败/发送中时才出现），上一版要求 state=sent
    // 会把所有成功发送报成「结果未知」。本次新增两级：① 新出现的本人消息行（状态未知）也算确认；
    if (cleared && fresh.length === 1 && messageState(fresh[0]) === 'unknown') { report(true, '发送成功（已确认新消息行）'); return; }
    if (Date.now() - started >= 15000) {
      // ② 兜底口径：上下文身份仍一致、无失败/发送中标记、且输入框已被页面清空
      // ⇒ 点击已被页面接受。仅在严格证据不足时采用，明细里注明来源便于追查。
      if (cleared && !fresh.some(function (row) { return messageState(row) === 'pending'; })) { report(true, '发送成功（输入框已清空）'); return; }
      diagSendRows(rows, fresh, baseline, cleared);
      report(false, '发送结果未知：未确认本次新消息送达，已停止自动重试');
      return;
    }
    later(function () { verify(panel, editor, baseline, started); }, 500);
  }

  function waitForEditor() {
    if (!editorWaitStart) editorWaitStart = Date.now();
    if (Date.now() - editorWaitStart >= 10000) { slog('[SEND] 发送中止：等待输入框超时'); diagEditorTimeout(); report(false, '无法确认当前聊天对象，未发送'); return; }
    //  真机实证：抖音窗口 460px 宽时右侧聊天面板被挤压到约 80px，输入框同样被挤成
    // 0 宽（可行但不可见）——编辑器只要求 displayed，是否真是目标会话由 confirmsRecipient 把关。
    var editors = Array.from(document.querySelectorAll('[contenteditable="true"], textarea')).filter(displayed);
    var matches = editors.map(function (ctx) { return { editor: ctx, panel: chatPanel(ctx) }; }).filter(function (ctx) { return confirmsRecipient(ctx.panel); });
    if (matches.length === 1) {
      var editor = matches[0].editor;
      slog('[SEND] 发送：找到输入框（即将输入内容）');
      diagChatPane(editor);
      fillAndSend(matches[0].panel, editor);
      return;
    }
    later(waitForEditor, 500);
  }

  /** 抖音 editor-kit 正文写入：编辑器是「div.ace-line + span[data-leaf]」
   *  结构，直接写叶子 span 再派发 input；连续多日真实发送全走这条路径。
   *   曾单方面改为 execCommand('insertText') 且未在真机验证过——保留为兜底，主路径回到实测版。 */
  function insertByAceLine(editor) {
    try {
      try { document.execCommand('selectAll'); document.execCommand('delete'); } catch (e) {}
      var line = editor.querySelector('div.ace-line') || editor.querySelector('[class*="ace-line"]');
      if (!line) return false;
      var span = line.querySelector('span[data-leaf="true"]') || line.querySelector('span');
      if (span) { span.innerText = text; }
      else {
        var node = document.createElement('span');
        node.setAttribute('data-string', 'true'); node.setAttribute('data-leaf', 'true'); node.innerText = text;
        line.appendChild(node);
      }
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      return editorText(editor) === text.trim();
    } catch (e) { return false; }
  }
  /** 发送按钮定位：真机实测不能依赖「宽高>0 / 非禁用」——窗口 460px 宽时输入行被挤压，
   *  且按钮状态由页面内部模型决定（我们注入的文本不一定进它的模型，aria-disabled 可能仍为 true）。
   *  此前严格筛选（visible + 非禁用）会把所有发送挡在「未找到可用的发送按钮」。现在：
   *  面板内优先（缺失才全文档兜底 publishBtn/send-msg-btn）、类名/文本/aria-label 命中、已渲染即可，
   *  排序偏好「未禁用 > 可见 > 其余」；点错了由后续结果校验兜底。 */
  function findSendButton(panel) {
    try {
      var scope = Array.from(panel.querySelectorAll('[class*="publishBtn"], [class*="send-msg-btn"], button, [role="button"]'));
      if (!scope.length) scope = Array.from(document.querySelectorAll('[class*="publishBtn"], [class*="send-msg-btn"]'));
      var usable = scope.filter(function (btn) {
        if (!displayed(btn)) return false;
        var cls = classAttr(btn); // SVG 按钮的 className 是对象，必须取 class 属性
        var txt = (btn.innerText || '').trim();
        var aria = String(btn.getAttribute('aria-label') || '');
        return /publishBtn|send-msg-btn/i.test(cls) || /^(发送|Send)$/.test(txt) || /发送|send/i.test(aria);
      });
      if (!usable.length) return null;
      usable.sort(function (a, b) {
        var ka = (a.disabled ? 1 : 0) + (a.getAttribute('aria-disabled') === 'true' ? 2 : 0) + (visible(a) ? 0 : 4);
        var kb = (b.disabled ? 1 : 0) + (b.getAttribute('aria-disabled') === 'true' ? 2 : 0) + (visible(b) ? 0 : 4);
        return ka - kb;
      });
      return usable[0];
    } catch (e) { return null; }
  }
  /** 发送按钮定位失败的取证：dump 候选的类名/文本（截断）/可见性/禁用状态 */
  function diagButton(panel) {
    try {
      var cands = Array.from(panel.querySelectorAll('[class*="publishBtn"], [class*="send-msg-btn"], button, [role="button"]'));
      var docWide = Array.from(document.querySelectorAll('[class*="publishBtn"], [class*="send-msg-btn"]'));
      var info = cands.slice(0, 6).map(function (b) {
        return clsOf(b) + ' txt=' + ((b.innerText || '').trim().slice(0, 8) || '-') + ' 显示=' + (displayed(b) ? 1 : 0) +
          ' 可见=' + (visible(b) ? 1 : 0) + ' disabled=' + (b.disabled ? 1 : 0) + ' aria=' + (b.getAttribute('aria-disabled') || '-');
      });
      diagSay('按钮', '面板内候选=' + cands.length + ' 全文档publishBtn=' + docWide.length + ' | ' + (info.length ? info.join(' || ') : '无'));
    } catch (e) { diagSay('按钮', '采样异常 ' + (e && e.message)); }
  }
  function fillAndSend(panel, editor) {
    if (!contextMatches(panel, editor)) { report(false, '会话身份校验失败，未发送'); return; }
    try {
      editor.focus();
      if (editor.tagName === 'TEXTAREA') {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, text);
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      } else if (!insertByAceLine(editor)) {
        var range = document.createRange();
        range.selectNodeContents(editor);
        var selection = window.getSelection();
        selection.removeAllRanges(); selection.addRange(range);
        if (!document.execCommand('insertText', false, text)) { report(false, '输入消息失败，未发送'); return; }
      }
    } catch (e) { report(false, '输入消息失败，未发送'); return; }
    // 正文只回显到页面 console（开发者工具排查用），绝不进 slog/app.log
    try { console.log('[SEND] 内容已输入: [' + editorText(editor) + ']'); } catch (e) {}
    later(function () {
      if (!contextMatches(panel, editor) || editorText(editor) !== text.trim()) { report(false, '发送前身份或正文校验失败，未发送'); return; }
      var button = findSendButton(panel);
      if (!button) { diagButton(panel); report(false, '未找到可用的发送按钮'); return; }
      slog('[SEND] 发送：选中按钮 ' + clsOf(button) + ' disabled=' + (button.disabled ? 1 : 0) + ' aria=' + (button.getAttribute('aria-disabled') || '-') + ' 可见=' + (visible(button) ? 1 : 0));
      var before = messageRows(panel);
      var baseline = { nodes: new Set(before), ids: new Set(before.map(messageKey).filter(Boolean)) };
      clickedSend = true;
      if (!fakeClick(button, { allowZeroSize: true })) { report(false, '发送结果未知：点击未完成，请核对聊天记录'); return; }
      slog('[SEND] 发送：已点击发送按钮，开始验证新消息');
      later(function () { verify(panel, editor, baseline, Date.now()); }, 500);
    }, 600);
  }

  function findScrollContainer() {
    var sels = ['[class*="conversationConversationListWrapper"]', '[class*="conversationConversationList"]', '[class*="chatListWrapper"]', '[class*="ChatList"]'];
    for (var i = 0; i < sels.length; i++) {
      var shell = document.querySelector(sels[i]);
      for (var p = shell; p; p = p.parentElement) {
        if (p.scrollHeight > p.clientHeight + 40 && p.clientHeight >= 200) return p;
      }
      if (shell) return shell;
    }
    return null;
  }
  var findStarted = Date.now();
  function findConversation() {
    if (isCancelled()) { slog('[SEND] 发送已取消，停止查找会话'); return; }
    if (Date.now() - findStarted >= 15000) { slog('[SEND] 发送中止：滚动查找完毕仍未找到会话'); report(false, '未找到会话: ' + name); return; }
    var target = findTargetInVisible();
    if (abortReason) {
      slog('[SEND] 发送中止：' + abortReason);
      report(false, abortReason);
      return;
    }
    if (target) {
      slog('[SEND] 发送：命中目标会话（准备点击）');
      diagConv(target);
      if (!fakeClick(target)) { report(false, '点击会话失败'); return; }
      later(waitForEditor, 500);
      return;
    }
    var list = findScrollContainer();
    if (list) { var prev = list.scrollTop; list.scrollTop += 400; if (prev === list.scrollTop) list.scrollTop = 0; }
    later(findConversation, 500);
  }

  if (!targetName || !text.trim()) { report(false, '目标或消息为空，未发送'); return; }
  slog('[SEND] 发送开始 name=' + name + ' id=' + (targetId ? '有' : '空(回退昵称匹配)'));
  later(findConversation, 500);
})();
