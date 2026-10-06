// 二维码轮询（对齐原 App dex 内置逻辑：canvas/img 方块 >100px，轮询抓取经桥回调）
(function () {
  'use strict';
  if (!window.AndroidBridge) return;
  if (window.__dsxQrPollBusy) return;
  window.__dsxQrPollBusy = true;
  window.__dsxQrSent = '';

  function find() {
    var cvs = document.querySelectorAll('canvas');
    for (var j = 0; j < cvs.length; j++) {
      var c = cvs[j];
      var r = c.getBoundingClientRect();
      if (r.width > 100 && r.width < 520 && Math.abs(r.width - r.height) < 40) {
        try { var d = c.toDataURL('image/png'); if (d && d.length > 100) return d; } catch (e) {}
      }
    }
    var imgs = document.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i];
      var rr = im.getBoundingClientRect();
      if (rr.width > 100 && rr.width < 520 && Math.abs(rr.width - rr.height) < 40) {
        var s = String(im.src || im.currentSrc || '');
        var hit = s.indexOf('data:image') === 0;
        if (!hit && s.indexOf('http') === 0 && /qrcode|qr-code|login|scan/i.test(s)) hit = true;
        if (hit) return s;
      }
    }
    return null;
  }

  function post() {
    try {
      var d = find();
      if (d && window.__dsxQrSent !== d) {
        window.__dsxQrSent = d;
        window.AndroidBridge.onQrCodeReady(d, '');
      }
    } catch (e) {}
  }
  setTimeout(post, 400);
  setTimeout(post, 1200);
  setTimeout(post, 2600);
  // 轮询设上限（约 30 分钟）+ 登录即停
  var pollCount = 0;
  var MAX_POLL = 2000;
  var pollIv = setInterval(function () {
    post();
    pollCount++;
    // 此前注释写着「登录成功后不再永久空转」，实现里却没有任何登录检测——已登录时仍每 900ms
    // 全 DOM 扫 canvas+img 并对命中的 canvas 调 toDataURL，白跑约 30 分钟。现在每轮先问三态登录判定，
    // 明确 true 才停（'pending'/false 继续轮询，避免页面加载初期误停）；停时复位 busy 标志，
    // 页面重载重新注入本脚本时才能再次启动（登出后主进程会导航回首页 → 重新注入 → 轮询自动恢复）。
    try {
      if (window.DouyinAuto && window.DouyinAuto.detectLoginState() === true) {
        clearInterval(pollIv);
        window.__dsxQrPollBusy = false;
        return;
      }
    } catch (e) {}
    if (pollCount > MAX_POLL) {
      clearInterval(pollIv);
      // 复位 busy 标志：否则到点停摆后再次注入本脚本会因 busy 守卫静默 no-op，二维码通道无法重启
      window.__dsxQrPollBusy = false;
    }
  }, 900);
})();