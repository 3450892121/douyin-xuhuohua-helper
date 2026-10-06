(function () {
  'use strict';
  // 在抖音页注入的桥接 shim：把 douyin_auto.js / send_msg.js 要调用的 window.AndroidBridge
  // 转发到桌面宿主（preload 暴露的 dsxHost），回调 -> 主进程 -> 主界面。
  if (window.AndroidBridge) return; // 已注入过
  var host = (window.dsxHost && typeof window.dsxHost.send === 'function') ? window.dsxHost : null;
  function post(name, args) {
    if (host) { try { host.send({ name: name, args: args }); } catch (e) {} }
  }
  window.AndroidBridge = {
    log: function (level, msg) { post('log', [String(level), String(msg)]); },
    onError: function (code, msg) { post('error', [code, String(msg)]); },
    onQrCodeReady: function (b64, text) { post('qr', [String(b64 || ''), String(text || '')]); },
    onQrCodeFailed: function (reason) { post('qrFailed', [String(reason || '')]); },
    onLoginStateChanged: function (loggedIn) { post('loginState', [!!loggedIn]); },
    onPageReady: function (url, title) { post('pageReady', [String(url || ''), String(title || '')]); },
    onFriendListParsed: function (json) { post('friendList', [String(json || '[]')]); },
    onEnterChatResult: function (ok, nickname, message) { post('enterChat', [!!ok, String(nickname || ''), String(message || '')]); },
    onSendMessageResult: function (ok, nickname, text) { post('sendResult', [!!ok, String(nickname || ''), String(text || '')]); },
    onBackToListResult: function (ok, message) { post('backList', [!!ok, String(message || '')]); },
    onProgress: function (index, total, nickname, stage) { post('progress', [index, total, String(nickname || ''), String(stage || '')]); },
    onSendResult: function (ok, detail, attemptId, retryable) { post('sendResult2', [!!ok, String(detail || ''), String(attemptId || ''), retryable === true]); },
    onChatData: function (json) { post('chatData', [String(json || '')]); },
    onChatDataAppend: function (json) { post('chatDataAppend', [String(json || '')]); },
    onChatDataSupplement: function (json) { post('chatDataSupplement', [String(json || '')]); }
  };
})();