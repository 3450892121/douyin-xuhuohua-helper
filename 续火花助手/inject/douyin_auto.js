/* ========================================================================
 * 抖音网页版自动化脚本
 * 注入到 WebView 页面中，暴露全局对象 window.DouyinAuto
 * 通过 window.AndroidBridge 回调原生层
 *
 * 注意：抖音网页版的 DOM 会随版本迭代发生变化，因此选择器设计尽量宽松：
 *   - 多套选择器兜底
 *   - 优先基于文本、role、aria-label、data 属性判断
 *   - 失败时返回空结果，不要抛出阻断后续流程
 *
 * ====================================================================== */

(function () {
  'use strict';

  /* navigator.userAgentData 对齐标准 Chrome（配合主进程 UA 串校准版本字段）：
   * 主进程已把「JS 侧 navigator.userAgent + 请求头」统一成标准 Chrome（见 main.js applySessionFingerprint
   * 与 ensureDouyinWindow 的时序说明），Electron 的 navigator.userAgentData.brands 实测只有
   * Not?A_Brand + Chromium、缺 Google Chrome，这里在脚本入口把 JS 侧补齐；brands/fullVersionList 的
   * 大版本一律取 UA 串（两者必须一致，矛盾比不伪装更糟）。
   *  关键点：标准 Chrome 的 UA 串只报大版本（Chrome/152.0.0.0），完整版本只出现在高熵值
   * （uaFullVersion / Sec-CH-UA-Full-Version-List）里——所以 fullVersionList 不能再用 UA 串里的版本，
   * 优先取内核自己返回的 uaFullVersion，拿不到再退回 UA 串（旧内核/测试假 DOM 场景）。
   * 全程防御：userAgentData 不存在（旧内核/测试假 DOM）时静默跳过，不影响任何既有逻辑。 */
  (function alignUserAgentData() {
    try {
      var uad = navigator.userAgentData;
      if (!uad) return;
      var uaVer = String(navigator.userAgent || '').match(/Chrome\/(\d+(?:\.\d+)+)/);
      var major = uaVer ? uaVer[1].split('.')[0] : '';
      var uaFull = uaVer ? uaVer[1] : '';
      if (!major) return;
      /* 真实完整内核版本：问一次内核自己（高熵 uaFullVersion），失败/拿不到再退回 UA 串里的版本 */
      var realFullP = null;
      function realFull() {
        if (!realFullP) {
          realFullP = Promise.resolve()
            .then(function () { return uad.getHighEntropyValues ? uad.getHighEntropyValues(['uaFullVersion']) : null; })
            .then(function (o) { return String((o && o.uaFullVersion) || '') || uaFull || (major + '.0.0.0'); })
            .catch(function () { return uaFull || (major + '.0.0.0'); });
        }
        return realFullP;
      }
      var brands = [
        { brand: 'Not?A_Brand', version: '24' },
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major }
      ];
      function fullVersionList(full) {
        return [
          { brand: 'Not?A_Brand', version: '24.0.0.0' },
          { brand: 'Chromium', version: full },
          { brand: 'Google Chrome', version: full }
        ];
      }
      var patched = {
        brands: brands,
        mobile: false,
        platform: uad.platform || 'Windows',
        getHighEntropyValues: function (hints) {
          var base = uad.getHighEntropyValues ? uad.getHighEntropyValues(hints) : {};
          return Promise.resolve(base).catch(function () { return {}; }).then(function (v) {
            v = v || {};
            var pick = function (full) {
              v.brands = brands;
              v.fullVersionList = fullVersionList(full);
              v.mobile = false;
              v.platform = v.platform || uad.platform || 'Windows';
              return v;   // 高熵值里内核原本返回的 arch/bitness/platformVersion 等一律保留
            };
            var hinted = String(v.uaFullVersion || '');
            if (hinted) return pick(hinted);
            return realFull().then(pick);
          });
        },
        toJSON: function () { return { brands: brands, mobile: false, platform: uad.platform || 'Windows' }; }
      };
      /* 实例优先、原型兜底：真实浏览器里在 navigator 实例上定义自有访问器即可遮蔽原型 getter
       * （userAgentData 不是 LegacyUnforgeable 属性）；先试实例，拿不到再退到原型。
       * 顺序不能反过来——Node 20+/测试沙箱里存在全局 Navigator 类但 navigator 是普通假对象，
       * 先打原型会"成功"地改到与假对象无关的全局原型，对齐静默失效。 */
      var defined = false;
      try { Object.defineProperty(navigator, 'userAgentData', { configurable: true, get: function () { return patched; } }); defined = true; }
      catch (eInst) {
        try {
          Object.defineProperty(Navigator.prototype, 'userAgentData', { configurable: true, get: function () { return patched; } });
          defined = true;
        } catch (eProto) {}
      }
      if (!defined) return;
    } catch (e) {}
  })();

  /** Android 桥接（注入时由 attachJavascriptInterface 提供） */
  var B = (typeof window !== 'undefined' && window.AndroidBridge) ? window.AndroidBridge : null;
  function hasBridge() { return !!B; }

  function log(level, msg) {
    try { if (hasBridge()) B.log(level, String(msg)); } catch (e) {}
    // 同时在控制台输出，便于调试
    try {
      if (level === 'error') console.error('[DouyinAuto]', msg);
      else if (level === 'warn') console.warn('[DouyinAuto]', msg);
      else if (level === 'debug') console.debug('[DouyinAuto]', msg);
      else console.log('[DouyinAuto]', msg);
    } catch (ignored) {}
  }

  function error(code, msg) {
    try { if (hasBridge()) B.onError(code, String(msg)); } catch (ignored) {}
    log('error', '[' + code + '] ' + msg);
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms || 300); }); }

  /** 判断登录状态。启发式：
   *  1. 如果存在登录弹窗、或可见的二维码登录组件 => 未登录
   *  2. 如果存在用户头像/昵称入口（通常右上角），且无强制登录遮罩 => 已登录
   *  3. 访问需要登录的 API 或 URL 检查是否 401 也可以，这里使用 DOM 特征即可
   */
  function detectLoginState() {
    try {
      // chat / messages 页：登录态由会话列表数据决定（有数据=已登录，无数据=未登录）
      if (isChatUrl()) {
        return detectLoginByConversation();
      }
      var notLoggedInSignals = [
        // 未登录主态：登录弹窗
        function () {
          var modals = document.querySelectorAll('div[role="dialog"], .login-modal, [class*="login-wrap"], [class*="LoginModal"], [class*="login--modal"]');
          for (var i = 0; i < modals.length; i++) {
            var m = modals[i];
            if (!m || m.offsetParent === null) continue;
            var html = m.innerHTML || '';
            // 包含"扫码"或"登录"字样，且有二维码 canvas/img
            if ((/扫码|登录|登錄/.test(html)) && (m.querySelector('canvas, img[src*="qrcode"], img[src*="qrcode"], img[alt*="二维码"]'))) return true;
          }
          return false;
        },
        // 登录按钮
        function () {
          var btns = document.querySelectorAll('button, a, div[role="button"]');
          for (var i = 0; i < btns.length; i++) {
            var t = (btns[i].innerText || btns[i].textContent || '').trim();
            if ((t === '登录' || t === '登錄' || t === '立即登录' || t === 'Log in') && btns[i].offsetParent !== null) return true;
          }
          return false;
        },
        // 页面正中央的二维码
        function () {
          var qrImgs = document.querySelectorAll('canvas, img[src*="qrcode"], img, div[class*="qrcode"], div[class*="QRCode"], div[class*="qr-code"]');
          for (var i = 0; i < qrImgs.length; i++) {
            var el = qrImgs[i];
            if (el.offsetParent === null) continue;
            var w = el.clientWidth || 0;
            var h = el.clientHeight || 0;
            if (w >= 160 && h >= 160) return true;
          }
          return false;
        }
      ];
      for (var k = 0; k < notLoggedInSignals.length; k++) {
        if (notLoggedInSignals[k]()) return false; // => 未登录
      }
      // 已登录信号
      var loggedInSignals = [
        // 消息页里能看到左侧好友列表
        function () {
          var items = queryChatListItems();
          return items && items.length > 0;
        },
        // 右上角有头像
        function () {
          var avatars = document.querySelectorAll('img[src*="p3-pc-sign"], img[src*="douyinpic"], img[src*="aweme-avatar"], [class*="avatar-img"], [class*="Avatar"] img');
          for (var i = 0; i < avatars.length; i++) {
            var el = avatars[i];
            if (el && el.offsetParent !== null) {
              var box = el.getBoundingClientRect();
              if (box.width > 20 && box.height > 20) return true;
            }
          }
          return false;
        },
        // URL 上带已登录特征（有时跳转到某个 ?logged_in=... 或包含 /follow 等仅登录后可见页面）
        function () {
          var loc = location.href || '';
          return /\/(messages|follow|following|fans|user|recommend-feed)/i.test(loc);
        }
      ];
      var okCount = 0;
      for (var kk = 0; kk < loggedInSignals.length; kk++) {
        try { if (loggedInSignals[kk]()) okCount++; } catch (ignored) {}
      }
      return okCount >= 1;
    } catch (e) {
      error('detect_login_error', String(e && e.stack ? e.stack : e));
      return false;
    }
  }

  /* 二维码提取失败的日志节流：登录轮询每 3s 调一次 extractQrCode，页面上没有二维码时
   * （已登录、或登录弹窗还没出来）每次失败都会写 error + notifyQr('','') 两行——实测数千次失败
   * 约占运行日志全部行数的三分之一，5MB×2 轮转下把真正有用的历史冲掉。
   * 改为：首次失败立即上报（UI 侧要及时隐藏过期二维码），之后每 60 秒最多一次并带上期间累计次数。
   * 计数是 IIFE 内的模块级变量，每次页面重载重新注入即复位。 */
  var qrFailSinceReport = 0;
  var qrFailLastReportAt = 0;
  var QR_FAIL_REPORT_INTERVAL_MS = 60000;
  function reportQrNotFound() {
    var now = Date.now();
    if (qrFailLastReportAt && now - qrFailLastReportAt < QR_FAIL_REPORT_INTERVAL_MS) { qrFailSinceReport++; return false; }
    var tail = qrFailLastReportAt ? ('（距上次上报 ' + Math.round((now - qrFailLastReportAt) / 1000) + ' 秒，期间又失败 ' + qrFailSinceReport + ' 次）') : '';
    qrFailLastReportAt = now;
    qrFailSinceReport = 0;
    error('qr_not_found', '页面中未发现二维码元素' + tail);
    notifyQr('', '');
    return true;
  }

  /* 二维码回推去重：登录轮询每 3 秒调一次 extractQrCode，此前同一个二维码每轮都回推一次
   * ——实测稳态高频重复「[登录] 二维码已生成」（单会话累计上百条），每次都带一次 IPC +
   * UI 重设 img.src。改为内容（含文案）未变就不回推，仅保留 60 秒兜底重推（界面渲染进程崩溃自动重载后
   * 仍能拿到当前二维码）。状态是 IIFE 模块级变量，页面重载重新注入即复位。 */
  var QR_RESEND_INTERVAL_MS = 60000;
  var lastQrKey = '';
  var lastQrAt = 0;
  /** 回推二维码：内容与文案都没变且在兜底窗口内则跳过。返回是否真的回推。 */
  function notifyQrOnce(payload, text) {
    var key = String(payload || '') + '|' + String(text || '');
    var now = Date.now();
    if (key === lastQrKey && now - lastQrAt < QR_RESEND_INTERVAL_MS) return false;
    lastQrKey = key;
    lastQrAt = now;
    notifyQr(payload, text);
    return true;
  }

  /* 登录页报错文案采集：抖音把「系统繁忙 / 操作频繁 / 请稍后再试」这类风控文案直接渲染在
   * 登录弹窗里，此前应用既不采集也不落日志，事后只能靠用户截图描述（排查时日志里就没有任何一条
   * 可用证据）。现在在未登录轮询里顺带采集登录卡片内的可见短文案，按内容 + 60 秒节流写一条 PAGE-ERR，
   * 便于把「本应用自身造成的非自然节奏」与「账号/IP 维度限流」区分开。 */
  var pageErrLastText = '';
  var pageErrLastAt = 0;
  var PAGE_ERR_REPORT_INTERVAL_MS = 60000;
  var PAGE_ERR_RE = /系统繁忙|操作(过于)?频繁|请求频繁|稍后再试|验证失败|存在异常|请重启/;
  function reportPageErrorText() {
    try {
      var scope = findLoginCard() || document;
      if (!scope || !scope.querySelectorAll) return false;
      var els = scope.querySelectorAll('div, span, p, label, button');
      var hits = [];
      for (var i = 0; i < els.length && hits.length < 3; i++) {
        var e = els[i];
        if (!e || e.offsetParent === null) continue;
        if (e.children && e.children.length > 0) continue; // 只看叶子，避免把整块容器的长文案当成报错
        var t = (e.innerText || e.textContent || '').trim();
        if (!t || t.length > 60) continue;
        if (PAGE_ERR_RE.test(t)) hits.push(t);
      }
      if (!hits.length) return false;
      var txt = hits.join(' / ');
      var now = Date.now();
      if (txt === pageErrLastText && now - pageErrLastAt < PAGE_ERR_REPORT_INTERVAL_MS) return false;
      pageErrLastText = txt;
      pageErrLastAt = now;
      log('warn', 'PAGE-ERR: ' + txt);
      return true;
    } catch (e) { return false; }
  }

  /** 找到登录二维码，提取为 base64 PNG。
   *  优先：canvas.toDataURL 提取，
   *  次选：<img> src，
   *  若页面尚无二维码（未弹出登录窗），返回空并上报（节流）。
   */
  function extractQrCode() {
    try {
      var qr = findQrImage();
      if (qr) {
        // 如果是 canvas 则提取 dataURL
        if (qr.tagName && qr.tagName.toLowerCase() === 'canvas') {
          try {
            var dataUrl = qr.toDataURL('image/png');
            if (dataUrl && dataUrl.indexOf('data:image/png') === 0) {
              notifyQrOnce(dataUrl, '');
              return dataUrl;
            }
          } catch (ignored) {}
          // canvas 无法转 dataURL 时，返回空，交给外层截图
          notifyQrOnce('', 'canvas-unreadable');
          return '';
        }
        // img 直接返回 src
        var src = qr.currentSrc || qr.src || '';
        if (src) {
          notifyQrOnce(src, '');
          return src;
        }
      }

      // 兜底：用 html2canvas 风格去截图登录卡片区（若不存在，返回空）
      var loginCard = findLoginCard();
      if (loginCard) {
        try {
          // 卡片诊断（两条 warn）改为 __xhDiag 开关，默认不执行——主进程的 noisy 过滤本就把
          // IMGS#/QR-ELS/LOGIN-BTNS/DIALOGS#/QR-CARD-HTML 这类 warn 全丢弃（等于零产出），而每个轮询 tick
          // 都要为此做一次 DOM 遍历。二维码状态仍照常回推（去重）。
          if (window.__xhDiag === true) {
            var box = loginCard.getBoundingClientRect();
            log('warn', '二维码无 canvas/img 可直接读取，已标记外围。卡片范围:' + JSON.stringify({w: box.width, h: box.height}));
            log('warn', 'QR-CARD-HTML: ' + (loginCard.outerHTML || '').slice(0, 3000));
          }
          notifyQrOnce('', 'qr-card-area-available');
        } catch (ignored) {}
        return '';
      }

      // 全量 DOM 诊断 dump：默认关闭，需要时在页面控制台执行 window.__xhDiag = true 再复现
      if (window.__xhDiag === true) try {
        var imgs = document.querySelectorAll('img');
        var imgList = [];
        for (var ii = 0; ii < imgs.length && ii < 40; ii++) {
          var s = imgs[ii].currentSrc || imgs[ii].src || '';
          if (s) imgList.push((imgs[ii].clientWidth || 0) + 'x' + (imgs[ii].clientHeight || 0) + ':' + s.slice(0, 90));
        }
        log('warn', 'IMGS#:' + imgs.length + ' ' + imgList.join(' | '));
        var qrEls = document.querySelectorAll('[class*="qrt"], [class*="qr"], [class*="Quick"], [data-e2e*=qr], [class*="dynamic"]');
        var qrInfo = [];
        for (var jj = 0; jj < qrEls.length && jj < 20; jj++) {
          var cls = (qrEls[jj].className || '') + ' ' + (qrEls[jj].id || '') + ' ' + (qrEls[jj].getAttribute && (qrEls[jj].getAttribute('data-e2e') || ''));
          qrInfo.push(cls.slice(0, 60));
        }
        log('warn', 'QR-ELS#' + qrEls.length + ': ' + qrInfo.join(' | '));
        // 诊断：列出所有含"登录/扫码/密码/验证码"的可见元素文本，判断登录弹窗/入口情况
        try {
          var allEls = document.querySelectorAll('button, a, div[role="button"], span, div, input, label, p');
          var loginBtns = [];
          var seenBtns = {};
          for (var bb = 0; bb < allEls.length && bb < 200; bb++) {
            var be = allEls[bb];
            if (!be || be.offsetParent === null) continue;
            var bt = (be.innerText || be.textContent || '').trim();
            if (!bt) continue;
            if (/登录|扫码|密码|验证码|手机号|注册|扫一扫/i.test(bt)) {
              if (seenBtns[bt]) continue;
              seenBtns[bt] = 1;
              var br = be.getBoundingClientRect();
              loginBtns.push((bt.slice(0, 24)) + '[' + Math.round(br.width) + 'x' + Math.round(br.height) + '@' + Math.round(br.left) + ',' + Math.round(br.top) + ']');
            }
          }
          log('warn', 'LOGIN-BTNS(' + loginBtns.length + '): ' + loginBtns.join(' | '));
          log('warn', 'DIALOGS#:' + document.querySelectorAll('[role="dialog"]').length + ' UA=' + navigator.userAgent.slice(0, 60));
        } catch (eL) { log('warn', 'loginbtn dump fail ' + eL); }
      } catch (e0) { log('warn', 'dump fail ' + e0); }

      reportQrNotFound(); // 节流上报（此前每次失败写两行，实测刷掉全日志三分之一）
      return '';
    } catch (e) {
      error('qr_extract_error', String(e && e.stack ? e.stack : e));
      return '';
    }
  }

  function findLoginCard() {
    var selectors = [
      '[role="dialog"]',
      '[class*="login-card"]',
      '[class*="LoginCard"]',
      '[class*="login-modal"]',
      '[class*="qr-wrap"]',
      '[class*="QRWrap"]',
      '[class*="qrcode-wrap"]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var list = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < list.length; j++) {
        var el = list[j];
        if (el && el.offsetParent !== null) {
          var box = el.getBoundingClientRect();
          if (box.width > 200 && box.height > 200) return el;
        }
      }
    }
    return null;
  }

  function notifyQr(base64, text) {
    try { if (hasBridge()) B.onQrCodeReady(base64 || '', text || ''); } catch (ignored) {}
  }

  /** 点击登录弹窗中的"扫码登录"切换 tab（登录弹窗默认可能停留在验证码/密码页） */
  function trySelectScanTab() {
    try {
      var roots = [];
      var card = findLoginCard();
      if (card) roots.push(card);
      roots.push(document);
      var texts = ['扫码登录', '扫码', '二维码登录', '扫一扫'];
      for (var r = 0; r < roots.length; r++) {
        var root = roots[r];
        if (!root || !root.querySelectorAll) continue;
        var els = root.querySelectorAll('*');
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          if (!el || el.offsetParent === null) continue;
          var t = (el.innerText || el.textContent || '').trim();
          if (!t) continue;
          var matched = false;
          for (var k = 0; k < texts.length; k++) {
            if (t === texts[k] || (t.indexOf(texts[k]) >= 0 && t.length <= texts[k].length + 6)) { matched = true; break; }
          }
          if (!matched) continue;
          // 只点击叶子节点（避免点到包含全部文字的外层容器）
          if (el.children && el.children.length > 0) continue;
          try {
            el.click();
            log('info', '已点击扫码登录入口: ' + t);
            return true;
          } catch (ignored) {}
        }
      }
      return false;
    } catch (e) {
      log('warn', 'trySelectScanTab err ' + e);
      return false;
    }
  }

  /** 点击目标是否位于已打开的登录弹窗内部：弹窗里的「登录」是提交按钮，
   *  点它等于代替用户提交半填的表单（抖音记为一次登录尝试，会加重「操作频繁」）。
   *  只允许通过本函数点弹窗**外面**的登录入口（用于把登录窗唤出来）。 */
  function isInsideOpenLoginCard(el) {
    try {
      var card = findLoginCard();
      return !!(card && el && card.contains && card.contains(el));
    } catch (e) { return false; }
  }

  /** 尝试点击页面上的"登录"入口，弹出登录弹窗（内联隐藏时调用）。
   *  只由用户显式操作触发（openLoginModalOnce），不再由登录轮询自动调用。 */
  function clickLoginButton(maxTimes) {
    maxTimes = maxTimes || 3;
    return new Promise(function (resolve) {
      var n = 0;
      (function tick() {
        // 若已登录，就直接成功
        if (findQrImage()) return resolve(true);
        // 若已挂出登录弹窗但默认是验证码/密码，先切换"扫码"标签
        trySelectScanTab();
        var clicked = false;
        var btns = document.querySelectorAll('button, a, div[role="button"], span, div');
        for (var i = 0; i < btns.length; i++) {
          var t = (btns[i].innerText || btns[i].textContent || '').trim();
          if (/^登录$|^登錄$|^立即登录$|^扫码登录$|^登录注册$/.test(t) && btns[i].offsetParent !== null) {
            // 弹窗已打开时，里面的「登录」是提交按钮——绝不代点（见 isInsideOpenLoginCard）
            if (isInsideOpenLoginCard(btns[i])) continue;
            try {
              btns[i].click();
              clicked = true;
            } catch (ignored) {}
            // 点击主登录后，再尝试切换扫码标签
            trySelectScanTab();
            break;
          }
        }
        n++;
        if (clicked) {
          log('info', '已点击登录按钮，等待二维码出现...');
        }
        if (!clicked || n >= maxTimes) {
          // 无登录按钮或已重试多次：若已有登录弹窗，再补一次扫码切换
          if (findLoginCard()) trySelectScanTab();
          resolve(findQrImage() != null);
          return;
        }
        setTimeout(tick, 600);
      })();
    });
  }

  /** 在当前页面查找一个至少可判定的二维码元素（canvas/img），找不到返回 null */
  function findQrImage() {
    // 0) 若存在登录弹窗，优先在其内部检索二维码（更明确）
    var card = findLoginCard();
    var scopeEls = [];
    if (card) scopeEls.push(card);
    for (var sc = 0; sc < scopeEls.length; sc++) {
      var hit = scanQrIn(scopeEls[sc]);
      if (hit) return hit;
    }
    // 1) canvas
    var canvases = document.querySelectorAll('canvas');
    for (var i = 0; i < canvases.length; i++) {
      var c = canvases[i];
      if (!c || c.offsetParent === null) continue;
      var w = c.clientWidth, h = c.clientHeight;
      if (w >= 140 && h >= 140 && w <= 700 && h <= 700 && Math.abs(w - h) <= w * 0.2) return c;
    }
    // 2) img：优先类名/alt/地址特征；其次用"方正大尺寸 + 位于视口中部"的几何启发
    var imgs = document.querySelectorAll('img');
    var bestSquare = null, bestSquareScore = -1;
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    for (var j = 0; j < imgs.length; j++) {
      var img = imgs[j];
      if (!img || img.offsetParent === null) continue;
      var ww = img.clientWidth || 0, hh = img.clientHeight || 0;
      if (ww < 130 || hh < 130) continue;
      var marker = (img.alt || '') + ' ' + (img.currentSrc || img.src || '') + ' ' + (img.className || '');
      var isQrByAttr = /qrcode|qr-code|qr_code|二维码|登录/i.test(marker);
      // 近似正方形（二维码典型特征）
      var sq = (ww >= 130 && hh >= 130 && Math.abs(ww - hh) <= Math.max(ww, hh) * 0.25);
      if (isQrByAttr && sq) return img;
      // 几何启发：方正、边长 130~500、位于视口中部 → 高度疑似二维码
      if (sq) {
        var rect = img.getBoundingClientRect();
        if (rect.width && rect.height &&
            rect.top >= vh * 0.03 && rect.top <= vh * 0.7 &&
            rect.left >= vw * 0.05 && rect.left <= vw * 0.95) {
          var score = Math.min(rect.width, rect.height);
          if (score > bestSquareScore) { bestSquareScore = score; bestSquare = img; }
        }
      }
    }
    if (bestSquare) return bestSquare;
    return null;
  }

  /** 在指定容器内查找最像二维码的子元素（img/canvas），找不到返回 null */
  function scanQrIn(root) {
    if (!root) return null;
    var best = null, bestScore = -1;
    var els = root.querySelectorAll('canvas, img');
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (!e || e.offsetParent === null) continue;
      var w = e.clientWidth || 0, h = e.clientHeight || 0;
      if (w < 110 || h < 110) continue;
      if (Math.abs(w - h) > Math.max(w, h) * 0.3) continue; // 非方正则跳过
      var isQr = false;
      if (e.tagName && e.tagName.toLowerCase() === 'img') {
        var marker = (e.alt || '') + ' ' + (e.currentSrc || e.src || '') + ' ' + (e.className || '');
        if (/qrcode|qr-code|qr_code|二维码|登录/i.test(marker)) isQr = true;
      }
      // 倾向标记过的；否则取最大方块
      var base = isQr ? 100000 : 0;
      var score = base + Math.min(w, h);
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  // ===================== 消息列表解析 =====================

  /** 聊天会话列表的容器选择器（登录后左侧会话列表） */
  function findConversationWrapper() {
    // 抖音网页版 chat 页左侧会话容器的 class；宽匹配多个版本
    var selectors = [
      '[class*="conversationConversationListWrapper"]',
      '[class*="conversationConversationList"]',
      '[class*="ConversationListWrapper"]',
      '[class*="conversation-list"]',
      '[class*="conversationList"]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      try {
        var el = document.querySelector(selectors[i]);
        // 不依赖 offsetParent（React portal/transform 布局下可能为 null），
        // 只需元素存在且实际占据空间即可作为容器
        if (el && (el.getBoundingClientRect().height > 0 || (el.clientHeight || 0) > 0)) return el;
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  /**
   * 统计 chat 页左侧会话列表中的会话条数。
   * 用户方案：有会话数据 => 已登录；无会话数据 => 未登录。
   * 返回 {count, wrapperHtml}，wrapperHtml 便于诊断容器的真实结构。
   */
  function countConversationItems() {
    try {
      var wrapper = findConversationWrapper();
      var diag = { wrapperFound: !!wrapper, count: 0, innerLen: 0, sample: '' };
      if (wrapper) {
        diag.innerLen = wrapper.innerHTML ? wrapper.innerHTML.length : 0;
        diag.sample = (wrapper.innerHTML || '').slice(0, 200);
        // 会话条目：容器内 role=listitem、会话项、可点击条目等
        var items = wrapper.querySelectorAll(
          'div[role="listitem"], li[role="listitem"], [class*="ConversationItem"], ' +
          '[class*="Conversation"], [class*="conversation-"], a[class*="chat"], ' +
          '[class*="ChatItem"], [class*="chat-item"], li, div[data-e2e*="conversation"]'
        );
        // 同一元素会同时命中多条选择器，必须按元素本身去重（Set）。
        // 旧实现把 DOM 元素当普通对象键，被 String() 成 "[object HTMLDivElement]"，
        // 所有 div 共享同一键 → 计数恒 ≤ 标签种类数，countConversation/登录启发式失真。
        var seen = new Set();
        var vis = 0;
        for (var i = 0; i < items.length; i++) {
          var el = items[i];
          if (!el || el.offsetParent === null) continue;
          var rect = el.getBoundingClientRect();
          if (rect.height < 30 || rect.width < 80) continue;
          var txt = (el.innerText || el.textContent || '').trim();
          if (!txt) continue;
          // 只统计叶子会话条目（x 轴位置最左、文本较长）
          if (seen.has(el)) continue;
          seen.add(el);
          // 如果它是某个已计目录的祖先，跳过（取最具体的）
          vis++;
        }
        diag.count = vis;
        // 直接统计文本条目数，作为兜底
        if (vis === 0) {
          var links = wrapper.querySelectorAll('a[href*="/messages/"], a[href*="/chat/"], [class*="SessionItem"], [class*="sessionItem"], [class*="Item"]');
          for (var j = 0; j < links.length; j++) {
            var l = links[j];
            if (!l || l.offsetParent === null) continue;
            var lt = (l.innerText || l.textContent || '').trim();
            if (lt) diag.count++;
          }
        }
      }
      // 诊断日志默认关闭：登录检查每 1.5s 调用本函数，全量 DOM 快照过 IPC 有持续开销；
      // 需要排查时在页面控制台执行 window.__xhDiag = true 临时开启
      if (window.__xhDiag === true) log('warn', 'CHAT-DIAG: ' + JSON.stringify(diag));
      return diag;
    } catch (e) {
      log('warn', 'CHAT-DIAG-ERR: ' + (e && e.message ? e.message : e));
      return { wrapperFound: false, count: 0, infoLen: 0, sample: '' };
    }
  }

  function isChatUrl() {
    try {
      var loc = location.href || '';
      return /\/chat(\?|$|\/)/.test(loc) || /\/messages(\?|$|\/)/.test(loc);
    } catch (e) { return false; }
  }

  /** 判断 chat 页当前是否呈现了"明确未登录"的信号（登录弹窗/登录按钮/大二维码） */
  function hasChatNotLoggedSignals() {
    try {
      var modals = document.querySelectorAll('div[role="dialog"], .login-modal, [class*="login-wrap"], [class*="LoginModal"]');
      for (var i = 0; i < modals.length; i++) {
        var m = modals[i];
        if (!m || m.offsetParent === null) continue;
        var html = m.innerHTML || '';
        if (/扫码|登录|登錄/.test(html) && m.querySelector('canvas, img[src*="qrcode"], img[src*="qrcode"]')) return true;
      }
      var qr = findQrImage();
      if (qr && qr.offsetParent !== null) {
        var w = qr.clientWidth || 0, h = qr.clientHeight || 0;
        if (w >= 120 && h >= 120) return true;
      }
      var btns = document.querySelectorAll('button, a, div[role="button"]');
      for (var j = 0; j < btns.length; j++) {
        var t = (btns[j].innerText || btns[j].textContent || '').trim();
        if (t === '登录' || t === '登錄' || t === '立即登录') return true;
      }
      return false;
    } catch (e) { return false; }
  }

  /**
   * 在 chat 页判定登录态：
   * - 有会话数据 => 已登录（true）
   * - 明确出现登录弹窗/二维码/登录按钮 => 未登录（false）
   * - 其它情况（wrapper 尚未渲染完成等）=> 返回字符串 'pending'，避免过早误判未登录
   */
  function checkChatLogin() {
      var diag = countConversationItems();
      if (diag.count > 0) return true;
      if (hasChatNotLoggedSignals()) return false;
      // wrapper 尚未出现且无明确未登录信号 => 等待中，不急于定为未登录
      if (!diag.wrapperFound) return 'pending';
      return false;
    }

    /** 在 chat 页判定登录态：pending 或瞬时假信号时防抖，避免未加载完/重载瞬间误翻转到未登录 */
    // 初始值必须为 false：wrapper 尚未渲染时 detectLoginByConversation 会沿用本值上报，
    // 若初始 true 会在登录弹窗渲染前被误报成「已登录」，触发宿主 autoParse 提前消耗一次性解析闸门
    var lastChatLoginState = false;
    var chatLoginConfirmedAt = 0; // 上一次通过会话数据确认"已登录"的时间
    var PAGE_BOOT_GRACE_MS = 3000; // 页面（重）加载初期宽限窗口
    var injectedAt = Date.now();   // 本脚本（重新）注入时刻：每次页面重载 dom-ready 注入时都会重置
    var queryListDiagLogged = false; // 列表结构诊断只输出一次，避免刷屏
    function detectLoginByConversation() {
      var r = checkChatLogin();
      if (r === true) {
        lastChatLoginState = true;
        chatLoginConfirmedAt = Date.now();
        return true;
      }
      if (r === false) {
        // 已通过会话数据确认过"已登录"，且在 8 秒内：即使瞬时出现登录信号也不翻转，避免页面重载抖动
        if (lastChatLoginState && Date.now() - chatLoginConfirmedAt < 8000) {
          return true;
        }
        // 页面（重）加载初期（注入后 3 秒内）会话数据未到、页面骨架可能先渲染出临时
        // "登录"信号（顶栏登录入口/大二维码占位），此时不能断言未登录：按"等待中"上报 'pending'，
        // 由 waitForLogin 轮询或发送前快速探测的复测继续等待，避免重载瞬间竞态误杀整轮发送
        if (Date.now() - injectedAt < PAGE_BOOT_GRACE_MS) return 'pending';
        lastChatLoginState = false;
        return false;
      }
      // checkChatLogin 返回 'pending'（会话 wrapper 尚未渲染完）等未知态：不能直接回落 lastChatLoginState，
      // 它的初值是 false —— 页面（重）加载初期会因此绕过上面仅对 r===false 生效的 3 秒注入宽限，
      // 把「列表还没渲染出来」当成「未登录」上报。宽限期内同样按 'pending' 上报，
      // 交给 waitForLogin 轮询 / 发送前快速探测的复测继续等待。
      if (Date.now() - injectedAt < PAGE_BOOT_GRACE_MS) return 'pending';
      return lastChatLoginState;
    }

  /** 返回会话列表 item 元素集合 */
  function queryChatListItems() {
    // 优先：基于登录检测用的会话容器 wrapper 取其内部的条目
    var root = findConversationWrapper() || null;
    var selectorList = [
      'div[role="listitem"]',
      'li[role="listitem"]',
      '[class*="chat-list"] [class*="item"]',
      '[class*="message-list"] [class*="item"]',
      '[class*="conversation-list"] [class*="item"]',
      '[class*="msg-list"] [class*="item"]',
      '[class*="ChatItem"]',
      '[class*="MessageItem"]',
      '[class*="ListItem"]',
      '[class*="session-item"]',
      '[class*="SessionItem"]',
      '[class*="sessionItem"]',
      '[class*="ConversationItem"]',
      '[class*="conversation-"]',
      '[data-e2e*="conversation"]',
      // 抖音常见：消息列表左侧 a 标签跳转
      'a[href*="/messages/"]'
    ];
    var seen = new Set();
    var out = [];
    for (var s = 0; s < selectorList.length; s++) {
      // 若有 wrapper 容器则只在容器内找，避免捞到弹窗/其它区域的无关元素
      var list = root ? root.querySelectorAll(selectorList[s]) : document.querySelectorAll(selectorList[s]);
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (!el) continue;
        if (seen.has(el)) continue;
        // 过滤过小或隐藏元素（弹窗较窄，宽度阈值放宽）
        var rect = el.getBoundingClientRect();
        if (rect.height < 30 || rect.width < 60) continue;
        var text = (el.innerText || el.textContent || '').trim();
        if (text.length < 1) continue;
        seen.add(el);
        out.push(el);
      }
    }
    // 按在文档流中的出现顺序
    out.sort(function (a, b) {
      var pa = a.getBoundingClientRect();
      var pb = b.getBoundingClientRect();
      var dy = pa.top - pb.top;
      if (Math.abs(dy) > 4) return dy;
      return pa.left - pb.left;
    });
    // 结构诊断只在首次解析时输出一次，避免滚动/轮询期间刷屏
    if (!queryListDiagLogged) {
      queryListDiagLogged = true;
      try {
        var diag = queryDiag();
        if (diag) log('info', 'CHAT-LIST-DIAG ' + diag);
      } catch (ignored) {}
    }
    return out;
  }

  /** 诊断 queryChatListItems 的选择器命中情况（便于排查解析 0 条） */
  function queryDiag() {
    var root = findConversationWrapper() || null;
    var selectors = [
      'div[role="listitem"]', 'li[role="listitem"]',
      '[class*="ChatItem"]', '[class*="conversation-"]',
      '[class*="sessionItem"]', '[class*="SessionItem"]',
      '[data-e2e*="conversation"]', 'a[href*="/messages/"]'
    ];
    var stats = [];
    for (var i = 0; i < selectors.length; i++) {
      var scopeEl = root ? root.querySelectorAll(selectors[i]) : document.querySelectorAll(selectors[i]);
      var n = 0;
      for (var j = 0; j < scopeEl.length; j++) {
        var r = scopeEl[j].getBoundingClientRect();
        if (r.height >= 30 && r.width >= 60) n++;
      }
      stats.push((root ? 'ROOT' : 'DOC') + selectors[i] + '=' + n);
    }
    return 'wrapper=' + !!root + ' | ' + stats.join(' | ');
  }

  /** 判断会话项是否带「火花」标记：找 🔥 / 「火花」文字 / fire·spark 图标。
   *  仅布尔判断（有没有火花），不做点亮状态/天数识别——那些依赖 DOM 细节，容易失准。 */
  function hasSparkMark(itemEl) {
    if (!itemEl) return false;
    try {
      var text = itemEl.innerText || itemEl.textContent || '';
      if (/🔥|火花|⚡/.test(text)) return true;
      var els = itemEl.querySelectorAll('img, svg');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var ssrc = (el.currentSrc || el.src || '').toLowerCase();
        var scls = (el.getAttribute('class') || '') + ' ' + (el.getAttribute('aria-label') || '');
        // URL 里的 'huo' 太短：douyinpic 随机 hash 撞上即误判有火花，URL 侧只认更具体的 huohua；
        // class/aria-label 是人工命名，保留宽松匹配
        if (/fire|spark|flame|huohua/.test(ssrc) || /fire|spark|flame|huo/.test(scls)) return true;
      }
      return false;
    } catch (e) { return false; }
  }

  /** 提取昵称：优先在可见子元素里找头像旁的名字文本 */
  function extractNickname(itemEl) {
    if (!itemEl) return '';
    try {
      // 通常是第一条文本（去掉时间、消息预览）
      var nodes = itemEl.querySelectorAll('*');
      var candidates = [];
      nodes.forEach(function (n) {
        if (n.children && n.children.length > 0) return; // 叶子节点
        var txt = (n.innerText || n.textContent || '').trim();
        if (!txt) return;
        if (txt.length > 30) return;
        // 过滤时间、最后消息
        if (/^\d{1,2}:\d{2}$/.test(txt)) return;
        if (/^昨天|^前天|^\d{1,2}月\d{1,2}日|^\d{4}-\d{1,2}-\d{1,2}/.test(txt)) return;
        candidates.push(txt);
      });
      if (candidates.length > 0) return candidates[0];
      // fallback: 直接取第一行
      var t = (itemEl.innerText || itemEl.textContent || '').split(/\n|\r/).map(function (s) { return s.trim(); }).filter(Boolean);
      return t.length ? t[0] : '';
    } catch (e) {
      return '';
    }
  }

  /* 消息预览长度上限：整份好友列表要经桥接单参数上限（65536 字符）传给主进程，
   * 预览不限长时上百行会话就能把 JSON 顶破上限——被截断后主进程 JSON.parse 失败、parseList 静默
   * 返回空列表（实践中多次出现「[好友] 解析完成: 0 条会话」紧跟注入侧「解析完成 100 条」）。
   * 预览在界面只占一行、搜索也只用开头若干字，截到 120 字符足够，同时把载荷压回可控范围。
   * 两侧快照都由本函数产出，截断口径一致，弱指纹的「预览必须相等」比对不受影响。 */
  var LAST_MESSAGE_MAX_LEN = 120;
  function extractLastMessage(itemEl) {
    if (!itemEl) return '';
    try {
      var t = (itemEl.innerText || itemEl.textContent || '').split(/\n|\r/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (t.length >= 2) return String(t[t.length - 1]).slice(0, LAST_MESSAGE_MAX_LEN);
      return '';
    } catch (e) { return ''; }
  }

  /** 提取会话项的时间戳：遍历叶子节点找时间格式（不依赖 innerText 换行，兼容 flex 布局） */
  function extractLastTime(itemEl) {
    if (!itemEl) return '';
    try {
      var nodes = itemEl.querySelectorAll('*');
      var candidates = [];
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.children && n.children.length > 0) continue; // 只取叶子节点
        var txt = (n.innerText || n.textContent || '').trim();
        if (!txt) continue;
        if (/^\d{1,2}:\d{2}$/.test(txt)
          || /^(昨天|前天)/.test(txt)
          || /^\d{1,2}[月\/]\d{1,2}日?$/.test(txt)
          || /^\d{4}-\d{1,2}-\d{1,2}/.test(txt)
          || /^刚刚$/.test(txt)
          || /\d+\s*[分钟小时]前$/.test(txt)) {
          candidates.push(txt);
        }
      }
      return candidates.length ? candidates[candidates.length - 1] : '';
    } catch (e) { return ''; }
  }
  /** 时间戳是否为「今天」：HH:MM、刚刚、N分钟前、N小时前 都算今天 */
  function isTodayTime(timeText) {
    var s = String(timeText || '').trim();
    if (!s) return false;
    return /^\d{1,2}:\d{2}$/.test(s) || /^刚刚$/.test(s) || /\d+\s*分钟前$/.test(s) || /\d+\s*小时前$/.test(s);
  }

  /** 头像 URL 提取： 前取会话行第一个 <img>——虚拟列表节点
   *  复用/重渲染瞬间第一个 img 可能是火花图标（曾出现：头像被抓成
   *  .../flame_icon/normal/gray_normal.png，去重指纹失配导致好友重复两遍）。
   *  改为遍历行内全部 img 打分：头像 CDN 路径特征 + 渲染尺寸（头像约 32~64px 方块，
   *  装饰图标 ≤24px）+ 行内最左侧位置；图标/data: 占位直接排除。取最高分且为正。 */
  function extractAvatarUrl(itemEl) {
    if (!itemEl) return '';
    try {
      var imgs = itemEl.querySelectorAll('img');
      var best = '';
      var bestScore = 0;
      for (var i = 0; i < imgs.length; i++) {
        var img = imgs[i];
        var url = img.currentSrc || img.src || '';
        if (!url || /^data:/i.test(url)) continue;
        // 火花/火焰/表情等装饰图标：不参与头像候选
        if (/flame|fire|spark|huohua|emoji|gray_normal|lit_normal|\/icons?\/|_icon\b|icon[_-]/i.test(url.split('?')[0])) continue;
        var score = 1;
        if (/aweme-avatar|douyinpic\.com\/img|head[-_]?img|avatar/i.test(url)) score += 10; // 头像 CDN 路径特征
        try {
          var r = img.getBoundingClientRect();
          if (r.width >= 28 && r.width <= 80 && r.height >= 28 && r.height <= 80) score += 5; // 头像方块尺寸
          else if ((r.width && r.width < 24) || (r.height && r.height < 24)) score -= 5;    // 小图标降权
        } catch (e) {}
        try { if (typeof img.offsetLeft === 'number' && img.offsetLeft < 80) score += 1; } catch (e) {} // 头像在会话行最左侧
        if (score > bestScore) { bestScore = score; best = url; }
      }
      if (best) return best;
      // 背景图兜底：只认头像容器（class 含 avatar/Avatar）上的 background-image，排除图标
      var styled = itemEl.querySelector('[class*="avatar"], [class*="Avatar"]');
      if (styled) {
        var bg = styled.style && styled.style.backgroundImage;
        if (bg && /url\(['"]?(http[^'")]+)/i.test(bg)) {
          var mm = /url\(['"]?(http[^'")]+)/i.exec(bg);
          if (mm && !/flame|fire|spark|huohua|emoji|icon/i.test(mm[1].split('?')[0])) return mm[1];
        }
      }
      return '';
    } catch (e) { return ''; }
  }

  function extractId(itemEl) {
    if (!itemEl) return '';
    try {
      // 优先 data-id / data-sec-uid / sec_uid（会话行自身查不到时向上祖先补查；
      // 祖先层数 4→6，抖音改版后会话 id 可能挂在更外层包裹节点上）
      var attrs = ['data-id', 'data-sec-uid', 'data-conversation-id', 'data-user-id', 'data-uid', 'id'];
      var node = itemEl;
      for (var depth = 0; node && depth < 6; depth++) {
        for (var i = 0; i < attrs.length; i++) {
          var v0 = node.getAttribute && node.getAttribute(attrs[i]);
          // 祖先上的 id 属性可能是 DOM 自动 id（如 'auto-id-1'），仅接受长 id；data-* 属性照常接受
          if (v0 && v0.length >= 4 && (attrs[i] !== 'id' || depth === 0 || /^[0-9a-zA-Z_\-:]{6,}$/.test(v0))) return String(v0);
        }
        node = node.parentElement;
      }
      // 父级链接：/messages/<id> 路径，或 query 里的 conversation_id/uid/user_id/sec_uid
      // （新版会话链接可能把会话 id 放 query 参数上）
      var a = itemEl.closest ? itemEl.closest('a[href]') : null;
      if (!a) {
        var as = itemEl.querySelectorAll && itemEl.querySelectorAll('a[href]');
        if (as && as.length) a = as[0];
      }
      if (a) {
        var href = a.getAttribute('href') || '';
        if (href.indexOf('/messages/') >= 0) {
          var id = href.split('/messages/')[1] || '';
          id = id.replace(/\/.*/, '').replace(/\?.*/, '');
          if (id.length >= 4) return id;
        }
        var qm = /[?&](?:conversation_id|conversationId|conv_id|uid|user_id|sec_uid)=([^&]+)/.exec(href);
        if (qm && qm[1] && qm[1].length >= 4) {
          try { return decodeURIComponent(qm[1]); } catch (e) { return String(qm[1]); }
        }
      }
      return '';
    } catch (e) { return ''; }
  }

  /** 完整解析会话列表，返回 JSON 数组 — 一次性全量滚动到末尾（不再依赖 scrollCount 固定次数）。
   *  scrollCount / scrollDelayMs 参数保留兼容旧调用；实际滚动策略已改为：
   *   - 最多 3 轮大循环，一轮空则刷新页面重试
   *   - 每轮最多滚 20 次，每次 800px + 等 1.2s 渲染
   *   - 连续 2 次无新增 => 判定到底 => 提前结束
   */
  function parseFriendList(scrollCount /* ignored, always auto-scroll to end */, scrollDelayMs) {
    try {
      // 自动滚到底，scrollCount 固定次数策略已废弃
      scrollDelayMs = scrollDelayMs || 1200;
      return Promise.resolve().then(function () {
        // 等待会话列表容器就绪（登录成功瞬间可能正在重渲染 DOM），最多约 5 秒
        return waitListReady(20, 250);
      }).then(function () {
        return scrollAndCollect(scrollCount, scrollDelayMs);
      }).then(function (items) {
        // items 为 collectOnce 在收集瞬间拍下的快照（字段已随元素在线时提取，直接用，不再重读 DOM）
        var arr = items.map(function (snap, idx) {
          return {
            id: snap.id || '',
            nickname: snap.nickname || '',
            avatarUrl: snap.avatarUrl || '',
            lastMessage: snap.lastMessage || '',
            lastTimeText: snap.lastTimeText || '',
            hasSpark: !!snap.hasSpark,
            unread: false,
            domIndex: idx
          };
        });
        var json = JSON.stringify(arr);
        try { if (hasBridge()) B.onFriendListParsed(json); } catch (ignored) {}
        log('info', '解析完成 ' + arr.length + ' 条会话');
        return json;
      }).catch(function (e) {
        error('parse_list_error', String(e && e.stack ? e.stack : e));
        return '[]';
      });
    } catch (e) {
      error('parse_list_fatal', String(e && e.stack ? e.stack : e));
      try { if (hasBridge()) B.onFriendListParsed('[]'); } catch (ignored) {}
      return '[]';
    }
  }

  /** 等待会话列表容器内出现可见条目，避免登录瞬间重渲染 DOM 期间解析到空列表 */
  function waitListReady(maxAttempts, intervalMs) {
    maxAttempts = maxAttempts || 20;
    intervalMs = intervalMs || 250;
    return new Promise(function (resolve) {
      var attempts = 0;
      (function poll() {
        attempts++;
        var wrapper = findConversationWrapper();
        var items = queryChatListItems();
        if (wrapper && items.length > 0) {
          return resolve(true);
        }
        if (attempts >= maxAttempts) {
          return resolve(false);
        }
        setTimeout(poll, intervalMs);
      })();
    });
  }

  /** 滚动列表并收集去重后的 itemEl 集合 — 自动滚到末尾，全量一次性收集，不依赖外部 scrollCount */
  function scrollAndCollect(times /* 兼容旧调用，现在忽略此参数，统一自动滚到底 */, delayMs) {
    // === 可调参数（v1.1 加更版：你反馈"并没有全部加载出来"，所以把滚动量 ×3、重试 ×2、到底判定加严 + 双程回溯兜底） ===
    var MAX_ATTEMPTS = 5;            // 最多 5 轮大循环：一轮空就刷新重试（原 3）
    var MAX_SCROLL_PER_ROUND = 60;   // 单轮内最多滚 60 次（原 20，×3 保证即使有 300+ 好友也能滚完）
    var WAIT_LIST_READY_MS = 45000;  // 等待会话标题选择器出现的超时
    var STABLE_BREAK = 4;            // 连续 4 次无新内容 + scrollTop 没动 => 才判定到底（原 2，给抖音懒加载接口回包留足时间）
    var STABLE_SCROLL_BREAK = 3;     // 连续 3 次 scrollTop 没变化 => 认为物理上已到底（虚拟列表可能还有已在本地但未渲染的）
    var DO_TWO_PASS = true;          // 到底后 再回滚到顶部→重新向下扫一遍（双程扫描，彻底解决虚拟列表丢中间屏 DOM 的问题）
    var MIN_WHEEL = 600;             // 每次滚动像素随机范围：600~1400（原固定 800，避免整数倍跳过分页触发点）
    var MAX_WHEEL = 1400;
    var MIN_WAIT = 700;              // 每次滚动后等待随机 700~1500ms（原固定 1200，模拟真人节奏 + 防接口节流）
    var MAX_WAIT = 1500;
    var PASS_BACK_DELAY = 1500;      // 回顶后等待 1.5s 再开始第二程
    var MOUSE_X = 200;               // 鼠标放到侧边栏上（虚拟列表监听 wheel 时的位置）
    var MOUSE_Y = 350;
    var AFTER_RELOAD_WAIT_MS = 12000; // 刷新页面后等待渲染的时间
    var WAIT_POLL_INTERVAL = 250;

    var SEEN_TITLE_SEL = '[class*="conversationConversationItemtitle"], [class*="ChatItem-title"], [class*="conversationConversationListWrapper"] div[role="listitem"], div[role="listitem"], li[role="listitem"]';

    // all 存「收集瞬间」的字段快照（不再存 DOM 元素引用）。早期存的是 el 引用、
    // 解析结束时才重读字段——双程滚动期间虚拟列表复用节点/页面重渲染会让旧引用脱离文档，
    // 重读时 id 全空、同一会话还可能因两次收集的去重键不一致而重复入列（账号2 全量停发根因）。
    var all = [];

    /** 昵称归一化：去零宽字符、合并连续空白、trim——两次快照间昵称文本的
     *  不可见差异（尾部空格/换行/零宽空格）会让去重指纹失配。 */
    function normNickStr(s) {
      return String(s == null ? '' : s).replace(/[\u200B-\u200F\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
    }
    /** 装饰图标 URL 识别：火花/火焰/表情等图标 CDN 路径不是头像——
     *  虚拟列表节点复用瞬间，会话行里第一个 <img> 可能被火花图标顶替（曾出现：
     *  avatarUrl 被抓成 .../flame_icon/normal/gray_normal.png，去重指纹失配、好友并排
     *  重复两遍）。归一化时这类 URL 一律视为「无头像」。 */
    function isIconAvatarUrl(u) {
      return /flame|fire|spark|huohua|emoji|gray_normal|lit_normal|\/icons?\/|_icon\b|icon[_-]/i.test(String(u || ''));
    }
    /** 头像 URL 归一化：去 query/fragment（抖音 CDN 头像 URL 可能带签名/尺寸
     *  参数，同一对象不同时刻参数不同）；data: 内联占位图（懒加载未完成）与火花/表情图标
     *  URL 一律视为空（不标识人）。 */
    function normAvatarUrl(u) {
      try {
        var s = String(u == null ? '' : u).trim();
        if (!s || /^data:/i.test(s)) return '';
        s = s.split('#')[0].split('?')[0];
        if (isIconAvatarUrl(s)) return '';
        return s;
      } catch (e) { return ''; }
    }
    /* 头像「身份键」（与主进程 friendAvatarKey 同口径）：在 normAvatarUrl 之上再去掉
     * CDN 域名，只留对象路径。抖音头像 CDN 域名会轮换（同一好友同一对象两程分别抓到
     * p3.huoshanimg.com 与 p11.douyinpic.com），带域名比较会把同一人判成两个 → 好友列表并排
     * 两行 → 主进程防发错人守卫误判真重名停发。默认占位头像跨人相同（未设头像的用户共用
     * aweme_default_avatar.png），一律返回空串不当身份。
     * 只用于「比较是否同一人」；落盘/合并仍用 normAvatarUrl 的完整 URL（界面要能显示头像）。 */
    function avatarKeyOf(u) {
      try {
        var s = normAvatarUrl(u);
        if (!s || /\/aweme_default_avatar\./i.test(s)) return '';
        return s.replace(/^[a-z][a-z0-9+.\-]*:\/\/[^/]+/i, '');
      } catch (e) { return ''; }
    }
    function normTxt(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
    /** 会话行强指纹集合：id:<id> 与 na:<昵称>|<归一化头像>。
     *  强指纹共享任意一条即同一人（id 全站唯一；头像 CDN 对象按人唯一）。
     *  注意：强指纹解决不了「头像被火花图标顶替/头像懒加载抓空 + id 结构性抓不到」
     *  这类重复（某好友=真头像 vs flame_icon、另一好友=
     *  真头像 vs 空）——这类走 findSameSnapshot 的弱指纹兼容合并。 */
    function friendFingerprints(snap) {
      var keys = [];
      try {
        if (!snap) return keys;
        var id = String(snap.id == null ? '' : snap.id).trim();
        if (id) keys.push('id:' + id);
        var nick = normNickStr(snap.nickname);
        var avatar = avatarKeyOf(snap.avatarUrl);
        if (nick && avatar) keys.push('na:' + nick + '|' + avatar);
      } catch (e) {}
      return keys;
    }
    /** 兼容包装：返回首个强指纹，无指纹返回 ''。 */
    function friendKeyOf(snap) {
      var ks = friendFingerprints(snap);
      return ks.length ? ks[0] : '';
    }
    /** 快照是否带「可识别身份」：id 或有效头像任一非空。两者全缺 = 降级快照
     *  （会话行重渲染瞬间拍的：头像 img 尚未挂载 src、id 结构性抓空），无法证明是「另一个人」。 */
    function hasIdentitySnapshot(snap) {
      try { return !!(normTxt(snap && snap.id) || normAvatarUrl(snap && snap.avatarUrl)); } catch (e) { return false; }
    }
    /** 弱指纹兼容判定：强指纹不命中时，两条快照是否为同一会话的两次收集。
     *  条件（全部满足才算同一人）：
     *   1) 归一化昵称相同；
     *   2) id 兼容：双方都有 id 时必须相等（不同 id 一定是两个会话）；
     *   3) 头像兼容：双方都有「有效头像」时必须相同——两个不同真实头像 = 真重名，不合并；
     *      一方头像空/图标/占位（懒加载或被火花图标顶替）时不构成矛盾；
     *      比较用 avatarKeyOf（去 CDN 域名），默认占位头像不算有效头像；
     *   4) 会话内容一致：最后消息预览与时间在双方都非空时必须相等（虚拟列表重复行内容
     *      必然逐字相同；真重名的两个人预览文本+时间戳不可能完全一样）。
     *      例外：预览位是在线状态文本（如「30分钟内在线」）时不是消息内容，按空值参与比对
     *      ——否则「默认头像/无 id」好友两程分别拍到状态文本与真实消息会被判成矛盾 →
     *      重复入列 → 主进程防发错人守卫按「同名多条、头像全缺」整人停发（与主进程
     *      friendsWeakSame 同口径）。
     *   修正第 4 条适用范围：恰好一方为降级快照（id 与有效头像全缺）、另一方有身份
     *  信息时跳过内容比对——降级快照没有任何可区分身份的字段，内容差异不构成「不同人」的证据；
     *  双方都无身份信息时仍按第 4 条保守保留（不合并）。
     *  曾出现：第二时段预刷新紧跟第一时段发送之后，刚发过消息的会话行正在重渲染/重排序，
     *  拍到的快照头像缺 src、预览位被在线状态顶替（「30分钟内在线」）或换成扫描期间新到的
     *  消息（「00:36」→「刚刚」），与已收集的同名行内容不一致 → 第 4 条判为矛盾 → 重复入列
     *  （整份缓存里多行是重复快照）。
     *  最坏情况仅为「两个同名、头像都抓空、且预览文本时间全同的真人」被合并——该概率
     *  远低于每程重复导致守卫整批拦停；且防发错人守卫发送前仍独立校验，不会发错人。 */
    function weakSameSnapshot(a, b) {
      try {
        var na = normNickStr(a.nickname), nb = normNickStr(b.nickname);
        if (!na || na !== nb) return false;
        var ia = normTxt(a.id), ib = normTxt(b.id);
        if (ia && ib && ia !== ib) return false;
        var aa = avatarKeyOf(a.avatarUrl), ab = avatarKeyOf(b.avatarUrl);
        if (aa && ab && aa !== ab) return false;
        // 恰好一方为降级快照（无 id 无有效头像）、另一方有身份信息：内容差异不构成矛盾，按昵称并入
        // （双方都无身份信息时不在此返回，继续走下面的内容一致判定 → 保守保留）
        if (hasIdentitySnapshot(a) !== hasIdentitySnapshot(b)) return true;
        // 局部闭包而非外部函数（与 mergeSnapshot 同原因：本函数可能被测试脚本按名抽取单独执行）；
        // 在线状态文本不是消息内容，按空值比对（见上方第 4 条例外说明）
        var isPresence = function (s) { return /^(?:在线|\d+\s*(?:分钟|小时|天|周|个月|月)内在线)$/.test(normTxt(s)); };
        var ma = isPresence(a.lastMessage) ? '' : normTxt(a.lastMessage);
        var mb = isPresence(b.lastMessage) ? '' : normTxt(b.lastMessage);
        if (ma && mb && ma !== mb) return false;
        var ta = normTxt(a.lastTimeText), tb = normTxt(b.lastTimeText);
        if (ta && tb && ta !== tb) return false;
        return true;
      } catch (e) { return false; }
    }
    /** 在已收集列表 all 中找同一条会话：先强指纹（id / 昵称+头像 / 头像），再弱指纹兼容。
     *  返回下标，找不到返回 -1。 */
    function findSameSnapshot(snap, all) {
      var sid = normTxt(snap.id), sav = avatarKeyOf(snap.avatarUrl), sna = normNickStr(snap.nickname);
      for (var i = 0; i < all.length; i++) {
        var o = all[i];
        var oid = normTxt(o.id), oav = avatarKeyOf(o.avatarUrl), ona = normNickStr(o.nickname);
        if (sid && oid && sid === oid) return i;
        if (sid && oid && sid !== oid) continue;
        if (sav && oav && sna && sna === ona && sav === oav) return i;
      }
      for (var j = 0; j < all.length; j++) {
        if (weakSameSnapshot(snap, all[j])) return j;
      }
      return -1;
    }
    /** 合并两次快照：保留信息更全的一份（空 id/头像/预览用另一份补），火花取「有」。 */
    function mergeSnapshot(dst, src) {
      try {
        // 局部闭包而非外部函数：本函数会被测试脚本按名抽取到沙箱单独执行，引用外部新增函数
        // 会在下面的 try 里静默抛 ReferenceError，导致整个合并失效
        var isPresence = function (s) { return /^(?:在线|\d+\s*(?:分钟|小时|天|周|个月|月)内在线)$/.test(normTxt(s)); };
        if (!normTxt(dst.id) && normTxt(src.id)) dst.id = src.id;
        if (!normAvatarUrl(dst.avatarUrl) && normAvatarUrl(src.avatarUrl)) dst.avatarUrl = src.avatarUrl;
        if (!normTxt(dst.lastMessage) && normTxt(src.lastMessage)) dst.lastMessage = src.lastMessage;
        // 预览位被在线状态顶替过时，用另一程的真实消息预览覆盖（与主进程 mergeFriendRows 同口径）
        if (isPresence(dst.lastMessage) && normTxt(src.lastMessage) && !isPresence(src.lastMessage)) dst.lastMessage = src.lastMessage;
        if (!normTxt(dst.lastTimeText) && normTxt(src.lastTimeText)) dst.lastTimeText = src.lastTimeText;
        if (src.hasSpark) dst.hasSpark = true;
        if (src.unread) dst.unread = true;
      } catch (e) {}
      return dst;
    }
    /** 在元素仍在线（挂在文档上）时一次性提取全部字段 */
    function snapshotItem(el) {
      return {
        id: extractId(el),
        nickname: normNickStr(extractNickname(el)),
        avatarUrl: normAvatarUrl(extractAvatarUrl(el)),
        lastMessage: extractLastMessage(el),
        lastTimeText: extractLastTime(el),
        hasSpark: hasSparkMark(el),
        unread: false
      };
    }

    function collectOnce() {
      try {
        var items = queryChatListItems();
        var added = 0;
        for (var i = 0; i < items.length; i++) {
          var snap = snapshotItem(items[i]);
          if (!snap.nickname) continue; // 无效行（无昵称文本）不收
          // 强指纹（id/头像）+ 弱指纹（昵称+内容兼容）双重判定同一会话，
          // 命中则把新快照补进旧快照（头像抓空/被图标顶替的一程用另一程补全），
          // 不再用单一指纹 Set——Set 无法表达「头像一程真一程空」的兼容关系。
          var hit = findSameSnapshot(snap, all);
          if (hit >= 0) { mergeSnapshot(all[hit], snap); continue; }
          all.push(snap);
          added++;
        }
        return added;
      } catch (e) {
        error('scroll_collect_once', String(e && e.stack ? e.stack : e));
        return 0;
      }
    }

    function waitOne(selector, timeoutMs) {
      return new Promise(function (resolve) {
        var start = Date.now();
        (function tick() {
          var hit = document.querySelector(selector);
          if (hit) return resolve(true);
          if (Date.now() - start > timeoutMs) return resolve(false);
          setTimeout(tick, WAIT_POLL_INTERVAL);
        })();
      });
    }

    /** 一次滚动：方向(deltaY>0向下,<0向上)，返回 { deltaMoved:实际滚动距离像素, scrollTopBefore, scrollTopAfter }
     *  - 每次滚动前重新查找 scroller（抖音懒加载会替换 DOM，旧 scroller 可能已经失效）
     *  - 优先从 conversationConversationListWrapper 的直接父容器滚动（最可靠，因为这是会话列表最外层壳）
     *  - wheel 事件 + scrollTop 赋值 + scroll 事件 三路同时触发（防虚拟列表只监听某一种）
     */
    function scrollOnce(deltaY) {
      var result = { deltaMoved: 0, scrollTopBefore: 0, scrollTopAfter: 0, usedScroller: null };
      try {
        var scroller = findChatListScroller();
        result.usedScroller = scroller;
        if (!scroller) return result;
        var before = scroller.scrollTop || 0;
        result.scrollTopBefore = before;
        var target;
        try { target = scroller.querySelector('div[role="listitem"], li[role="listitem"], [class*="ChatItem"], [class*="conversation-"]') || scroller; } catch (e) { target = scroller; }
        if (!target) target = scroller || document.body;
        var rect;
        try { rect = target.getBoundingClientRect ? target.getBoundingClientRect() : null; } catch (e) { rect = null; }
        var cx = rect ? (rect.left + rect.width / 2) : MOUSE_X;
        var cy = rect ? (rect.top + Math.min(rect.height / 2, MOUSE_Y)) : MOUSE_Y;
        var absDelta = Math.abs(deltaY || 0);
        var sign = deltaY < 0 ? -1 : 1;
        try { target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy })); } catch (ignored) {}
        try { target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, view: window, deltaX: 0, deltaY: sign * absDelta, clientX: cx, clientY: cy })); } catch (ignored) {}
        try {
          // scrollTop 赋值触发 scroll 事件兜底
          var next = before + sign * absDelta;
          if (next < 0) next = 0;
          var maxTop = (scroller.scrollHeight || 0) - (scroller.clientHeight || 0);
          if (next > maxTop) next = maxTop;
          scroller.scrollTop = next;
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        } catch (ignored) {}
        // 等待一小会儿让 DOM 真的滚到位（同步读 scrollTop）
        try {
          var after = scroller.scrollTop || 0;
          result.scrollTopAfter = after;
          result.deltaMoved = after - before; // 向下应为正，向上为负
        } catch (ignored) {}
      } catch (e) {
        error('scroll_once', String(e && e.stack ? e.stack : e));
      }
      return result;
    }

    /** 把当前 scroller 滚回最顶部（用于双程扫描第二程），返回 true 表示真的发生了滚动 */
    function scrollBackToTop() {
      try {
        var scroller = findChatListScroller();
        if (!scroller) return false;
        var before = scroller.scrollTop || 0;
        if (before <= 1) return false;
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        return true;
      } catch (e) {
        error('scroll_back_top', String(e && e.stack ? e.stack : e));
        return false;
      }
    }

    function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

    /** 单程扫描：方向 deltaY(+下 / -上)，最多 maxSteps 次；return { endedReason: 'max_steps'|'stable'|'scroll_stuck', stepsDone, passAdded, stableCount, scrollStableCount } */
    function oneDirectionalPass(deltaYSign, maxSteps, tag) {
      // deltaYSign: +1 向下, -1 向上
      var startLen = all.length;
      var steps = 0;
      var stable = 0;     // 连续"无新增条目"次数
      var scrolled = 0;   // 连续"scrollTop 没真正移动"次数
      function step() {
        if (steps >= maxSteps) {
          return Promise.resolve({ endedReason: 'max_steps', stepsDone: steps, passAdded: all.length - startLen, stableCount: stable, scrollStableCount: scrolled });
        }
        var absDelta = randInt(MIN_WHEEL, MAX_WHEEL);
        var realDelta = deltaYSign * absDelta;
        var sr = scrollOnce(realDelta);
        var waitMs = randInt(MIN_WAIT, MAX_WAIT);
        return sleep(waitMs).then(function () {
          var added = collectOnce();
          steps++;
          var movedAbs = Math.abs(sr.deltaMoved || 0);
          var movedEnough = movedAbs >= absDelta * 0.25; // 实际滚动量≥目标 25% 就算"真的滚了"
          if (added > 0) stable = 0; else stable++;
          if (!movedEnough) scrolled++; else scrolled = 0;
          log('info', '[scroll][' + tag + '] 第 ' + steps + '/' + maxSteps + ' 次: delta=' + realDelta + 'px(实际' + (sr.deltaMoved || 0) + ') 新增=' + added + ' 累计=' + all.length + ' stable=' + stable + '/' + STABLE_BREAK + ' stuck=' + scrolled + '/' + STABLE_SCROLL_BREAK);
          // 1) 稳定无新增 且 滚动真的卡住 → 立即判定到底/到顶
          if (stable >= STABLE_BREAK && scrolled >= STABLE_SCROLL_BREAK) {
            return Promise.resolve({ endedReason: 'both_stable', stepsDone: steps, passAdded: all.length - startLen, stableCount: stable, scrollStableCount: scrolled });
          }
          // 2) 纯稳定无新增：给接口回包时间，不立即退，但超过 STABLE_BREAK*2 就退
          if (stable >= STABLE_BREAK * 2) {
            return Promise.resolve({ endedReason: 'stable', stepsDone: steps, passAdded: all.length - startLen, stableCount: stable, scrollStableCount: scrolled });
          }
          // 3) 纯滚动卡死：DOM 不滚了但虚拟列表可能还有机会，到 STABLE_SCROLL_BREAK*2 就退
          if (scrolled >= STABLE_SCROLL_BREAK * 2) {
            return Promise.resolve({ endedReason: 'scroll_stuck', stepsDone: steps, passAdded: all.length - startLen, stableCount: stable, scrollStableCount: scrolled });
          }
          return step();
        });
      }
      return step();
    }

    function doOneRound() {
      // 1. 等待会话列表标题/条目出现
      return waitOne(SEEN_TITLE_SEL, WAIT_LIST_READY_MS).then(function (ready) {
        if (!ready) log('warn', '[scroll] 本轮等待联系人列表条目超时，仍尝试继续');
        // 2. 先收集一次初始内容
        var pass0Added = collectOnce();
        log('info', '[scroll] 首轮收集(滚动之前先读一次DOM): 新增 ' + pass0Added + ' 条，累计 ' + all.length);
        // 3. 第一程：向下一直滚到底
        return oneDirectionalPass(+1, MAX_SCROLL_PER_ROUND, 'PASS1向下').then(function (pass1) {
          log('info', '[scroll] PASS1向下 结束: reason=' + pass1.endedReason + ' steps=' + pass1.stepsDone + ' 本程新增=' + pass1.passAdded + ' 累计=' + all.length);
          if (!DO_TWO_PASS) return all.length > 0;
          // 4. 第二程兜底：滚回顶部 → 再向下滚一遍（虚拟列表丢屏补收）
          var didBack = scrollBackToTop();
          log('info', '[scroll] PASS1后回顶: didBack=' + didBack + ' 等待 ' + PASS_BACK_DELAY + 'ms 让顶部 DOM 重新渲染 ...');
          return sleep(PASS_BACK_DELAY).then(function () {
            var backFill = collectOnce(); // 回顶之后顶部附近 DOM 也可能是 PASS1 没遇到的中间屏
            log('info', '[scroll] PASS2向下 开始前(回顶后即时收): 新增 ' + backFill + ' 条，累计 ' + all.length);
            return oneDirectionalPass(+1, MAX_SCROLL_PER_ROUND, 'PASS2向下').then(function (pass2) {
              log('info', '[scroll] PASS2向下 结束: reason=' + pass2.endedReason + ' steps=' + pass2.stepsDone + ' 本程新增=' + pass2.passAdded + ' 累计=' + all.length);
              // 5. 额外小兜底：第三程轻量向上扫（防止 PASS2 最底部 DOM 因为复用又跳丢了少量尾部）
              return oneDirectionalPass(-1, Math.floor(MAX_SCROLL_PER_ROUND / 3), 'PASS3向上轻扫').then(function (pass3) {
                log('info', '[scroll] PASS3向上轻扫 结束: reason=' + pass3.endedReason + ' steps=' + pass3.stepsDone + ' 本程新增=' + pass3.passAdded + ' 累计=' + all.length);
                return all.length > 0;
              });
            });
          });
        });
      });
    }

    /** 空结果后的重试准备。严禁刷新整页（reload）—— 刷新会销毁整个 JS 上下文，
     *  本 Promise 链（含已收集的 all 与后续 attempt+1）随之全部丢失，parseFriendList 永不 resolve，
     *  「刷新重试」这条路径实际从未生效过。改为回滚到顶部 + 等待虚拟列表重新渲染后原地重扫。 */
    function prepareRescan() {
      log('info', '[scroll] 本轮未收集到联系人，回滚到顶部等待后原地重试 ...');
      try { scrollBackToTop(); } catch (ignored) {}
      return sleep(AFTER_RELOAD_WAIT_MS);
    }

    // 主循环：最多 MAX_ATTEMPTS 轮
    function attemptsLoop(attempt) {
      if (attempt >= MAX_ATTEMPTS) {
        log('warn', '[scroll] 已达最大重试次数 ' + MAX_ATTEMPTS + ' 次，结束。累计收集 ' + all.length + ' 条');
        return Promise.resolve(all);
      }
      log('info', '[scroll] ======= 第 ' + (attempt + 1) + '/' + MAX_ATTEMPTS + ' 轮滚动提取联系人开始 =======');
      return doOneRound().then(function (hasAny) {
        if (hasAny) {
          log('info', '[scroll] 本轮成功。累计收集 ' + all.length + ' 条，不再刷新重试。');
          return all;
        }
        if (attempt + 1 >= MAX_ATTEMPTS) {
          log('warn', '[scroll] 最后一轮仍空。结束。累计收集 ' + all.length + ' 条');
          return all;
        }
        return prepareRescan().then(function () {
          return attemptsLoop(attempt + 1);
        });
      });
    }

    return attemptsLoop(0);
  }

  /** 找到消息列表的滚动容器 —— v1.1 兜底加更：优先从会话列表壳层出发定位 */
  function findChatListScroller() {
    try {
      // 第 1 优先：直接定位到会话列表最外层壳 conversationConversationListWrapper，它的最近一个"可滚动的祖先"就是目标 scroller
      var wrapper = document.querySelector('[class*="conversationConversationListWrapper"]') ||
                    document.querySelector('[class*="chatListWrapper"]') ||
                    document.querySelector('[class*="conversation-list"]') ||
                    document.querySelector('[class*="ChatList"]');
      if (wrapper) {
        var cur = wrapper;
        var safety = 0;
        while (cur && cur.parentElement && safety++ < 20) {
          var p = cur.parentElement;
          try {
            var isScrollable =
              (p.scrollHeight > p.clientHeight + 40) &&
              ((p.offsetHeight || 0) >= 200) &&
              ((p.clientHeight || 0) >= 200);
            if (isScrollable) return p;
          } catch (ignored) {}
          cur = p;
        }
        // 直接把 wrapper 本身当成 scroller（它自己就是 overflow:auto）也尝试
        try {
          if ((wrapper.scrollHeight || 0) > (wrapper.clientHeight || 0) + 40) return wrapper;
        } catch (ignored) {}
      }
      // 第 2 优先：定位到第一个会话项，向上追溯最多 10 层找"含最多 listitem 的可滚动容器"
      var firstItem = document.querySelector('div[role="listitem"], li[role="listitem"], [class*="ChatItem"], [class*="conversationConversationItem"]');
      if (firstItem) {
        var best = null, bestScore = -1;
        var c2 = firstItem;
        for (var d = 0; d < 12 && c2 && c2.parentElement; d++) {
          var p2 = c2.parentElement;
          try {
            var inside2 = p2.querySelectorAll('div[role="listitem"], li[role="listitem"], [class*="ChatItem"], [class*="conversationConversationItem"]');
            var items2 = inside2 ? inside2.length : 0;
            var isScroll = (p2.scrollHeight > p2.clientHeight + 40) && ((p2.offsetHeight || 0) >= 200) && ((p2.clientHeight || 0) >= 200);
            if (items2 >= 2) {
              var score = items2 + (isScroll ? 1000 : 0);
              if (score > bestScore) { bestScore = score; best = p2; }
            }
          } catch (ignored) {}
          c2 = p2;
        }
        if (best) return best;
      }
      // 最后兜底：旧启发式
      var pool = [];
      var all = document.querySelectorAll('div, section, aside, ul, main');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.scrollHeight > el.clientHeight + 40 &&
            (el.offsetHeight || 0) >= 200 &&
            (el.clientHeight || 0) >= 200) {
          var inside = el.querySelectorAll('div[role="listitem"], [class*="item"], a[href*="/messages/"]');
          if (inside && inside.length >= 2) {
            pool.push({ el: el, items: inside.length });
          }
        }
      }
      if (pool.length > 0) {
        pool.sort(function (a, b) { return b.items - a.items; });
        return pool[0].el;
      }
    } catch (e) {
      error('find_scroller', String(e && e.stack ? e.stack : e));
    }
    return document.documentElement || document.body;
  }

  // ===================== 登录状态轮询 & 二维码刷新 =====================

  var loginCheckerTimer = null;
  var lastLoginState = null;
  function dumpFingerprint() {
    try {
      var dp = window.devicePixelRatio || 1;
      var uad = null;
      try { uad = navigator.userAgentData; } catch (e) {}
      var brands = '';
      if (uad && uad.brands) { brands = uad.brands.map(function (b) { return b.brand + '/v' + b.version; }).join(','); }
      var glR = '';
      try {
        var cvs = document.createElement('canvas');
        var gl = cvs.getContext('webgl') || cvs.getContext('experimental-webgl');
        if (gl) {
          var ext = gl.getExtension('WEBGL_debug_renderer_info');
          glR = String((ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || '').slice(0, 60);
        } else { glR = 'NO-WEBGL'; }
      } catch (e) { glR = 'gl-err'; }
      var fp = {
        ua: (navigator.userAgent || '').slice(0, 160),   // 100 → 160（原来的截断看不到 UA 尾部，无法确认是否还残留应用名/Electron 段）
        platform: navigator.platform,
        maxTouch: navigator.maxTouchPoints,
        uadMt: uad ? uad.mobile : 'n/a',
        uadPlat: uad ? uad.platform : 'n/a',
        brands: brands,
        chromeRt: (typeof window.chrome === 'object' && window.chrome) ? typeof window.chrome.runtime : 'no-chrome',
        glR: glR,
        plugins: navigator.plugins ? navigator.plugins.length : 0,
        dpr: dp,
        scr: screen.width + 'x' + screen.height,
        avail: screen.availWidth + 'x' + screen.availHeight,
        innerW: window.innerWidth, innerH: window.innerHeight,
        outerW: window.outerWidth, outerH: window.outerHeight,
        htmlClientW: document.documentElement.clientWidth,
        bodyW: document.body ? document.body.clientWidth : 0,
        onLine: navigator.onLine
      };
      log('warn', 'FINGERPRINT: ' + JSON.stringify(fp));
    } catch (e) { log('warn', 'fingerprint err ' + e); }
  }
  function startLoginChecker(intervalMs) {
    stopLoginChecker();
    intervalMs = intervalMs || 3000; // 1500 → 3000（定频越快越像机器；二维码靠提取去重推送）
    dumpFingerprint();
    loginCheckerTimer = setInterval(function () {
      var st = detectLoginState();
      if (st === 'pending') return; // 页面加载初期宽限，不比较/不上报/不做未登录处理，避免 !!st 被误报成已登录
      if (st !== lastLoginState) {
        lastLoginState = st;
        try { if (hasBridge()) B.onLoginStateChanged(!!st); } catch (ignored) {}
      }
      if (!st) {
        // chat 页：未登录（无会话数据）时不需要在这里弹登录窗，由原生层跳回首页处理
        if (isChatUrl()) {
          return;
        }
        // 这里**不再自动点击登录 UI**。此前每个 tick 都执行 trySelectScanTab()，且前 5 次还会
        // 调 clickLoginButton（内部 4 tick × 600ms 连点）——实测单次未登录会话产生 25 次
        // 「已点击登录按钮」+ 6 次「已点击扫码登录入口」，其中 6 秒内连点 16 次。用户在「验证码登录」
        // 面板手工操作时会被反复切走/抢点击（可能代提交半填表单），定频点击本身也是行为风控特征。
        // 现在轮询只做只读事：提取二维码（内容未变不重复回推）+ 采集登录页可见报错文案（节流）。
        // 「弹出登录窗」改为用户显式操作触发的一次性动作：openLoginModalOnce()，由主进程在
        // extractQr / ensureLogin（点「刷新二维码 / 打开抖音页」）时调用，且带次数上限。
        extractQrCode();
        reportPageErrorText();
      }
    }, intervalMs);
    log('debug', '登录状态检测已启动, interval=' + intervalMs);
  }

  function stopLoginChecker() {
    if (loginCheckerTimer) { clearInterval(loginCheckerTimer); loginCheckerTimer = null; }
  }

  /** 用户显式触发时尝试弹出登录弹窗：一次性、有次数上限，绝不在轮询里自动调用。
   *  调用方：主进程的 extractQr / ensureLogin（用户点「刷新二维码 / 打开抖音页」）。
   *  5 秒防连点：界面上「打开抖音页」后紧接一次「刷新二维码」，两个入口会连着触发本函数。
   *  **防连点只覆盖"成功"的尝试**：若这次点完页面仍没有登录窗/二维码（页面还没渲染好、点了没命中
   *  等），立即解除防连点——否则用户再点「刷新二维码」会被静默吞掉 5 秒，表现成"点了没反应"甚至
   *  "无法登录"。弹窗已在页面上时本函数在上一行就早返回，所以解除后也不会造成连点。
   *  返回 Promise<boolean>（找到二维码或成功点出登录入口 = true）。 */
  var OPEN_MODAL_MIN_GAP_MS = 5000;
  var lastOpenModalAt = 0;
  function openLoginModalOnce() {
    return Promise.resolve().then(function () {
      try {
        if (!hasBridge()) return false;
        if (findQrImage()) return true; // 二维码已在页面上：无需任何点击
        var now = Date.now();
        if (now - lastOpenModalAt < OPEN_MODAL_MIN_GAP_MS) return false; // 刚尝试过：不再连点
        lastOpenModalAt = now;
        trySelectScanTab();             // 登录窗默认停在验证码/密码页时，先切到扫码
        return clickLoginButton(3).then(function (ok) {     // 只点弹窗外的登录入口；弹窗已打开时内部会跳过提交按钮
          if (!ok && !findQrImage() && !findLoginCard()) lastOpenModalAt = 0; // 没换来登录窗：解除防连点，允许用户立刻重试
          return ok;
        });
      } catch (e) {
        lastOpenModalAt = 0;
        log('warn', 'openLoginModalOnce err ' + e);
        return false;
      }
    });
  }

  // ===================== 初始化 & 对外 API =====================

  function init(url) {
    try {
      log('info', 'DouyinAuto.init, url=' + (url || location.href));
      // 通知页面就绪
      try { if (hasBridge()) B.onPageReady(location.href, document.title || ''); } catch (ignored) {}
      // 启动登录检测（只读轮询，3s 一次，见 startLoginChecker 内注释）
      startLoginChecker(3000);
    } catch (e) {
      error('init_error', String(e && e.stack ? e.stack : e));
    }
  }

  var api = {
    init: init,
    detectLoginState: detectLoginState,
    detectConversationLogin: detectLoginByConversation,
    countConversation: countConversationItems,
    extractQrCode: extractQrCode,
    parseFriendList: function (optsJson) {
      var obj = {};
      try { obj = (typeof optsJson === 'string') ? JSON.parse(optsJson) : (optsJson || {}); } catch (ignored) {}
      return parseFriendList(obj.scrollCount || 0, obj.scrollDelayMs || 800);
    },
    startLoginChecker: startLoginChecker,
    stopLoginChecker: stopLoginChecker,
    openLoginModalOnce: openLoginModalOnce,
    /** 同一 JS 上下文被重复注入时由新实例调用的清理钩子：停掉旧实例的 loginCheckerTimer，
     *  避免双 interval 造成 loginState/qr 事件双份（当前 Electron 流程每次注入都是新上下文，属防御性兜底） */
    __onReplaced: function () { try { stopLoginChecker(); } catch (ignored) {} }
  };

  // 暴露到 window
  if (typeof window !== 'undefined') {
    // 兼容重复注入
    var prev = window.DouyinAuto;
    window.DouyinAuto = api;
    try {
      if (prev && typeof prev.__onReplaced === 'function') prev.__onReplaced();
    } catch (ignored) {}
    log('debug', 'window.DouyinAuto installed, v=1.0');
  }

  // 如果已经在页面就绪（比如脚本注入晚于 load），主动触发一次 init 简化流程
  if (document && (document.readyState === 'complete' || document.readyState === 'interactive')) {
    setTimeout(function () { init(location.href); }, 200);
  }

  return api;
})();
