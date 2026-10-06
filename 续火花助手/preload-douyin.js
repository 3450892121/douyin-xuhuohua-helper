'use strict';
// 抖音窗口 preload：把「AndroidBridge 页面回调」转发到主进程（fire-and-forget）
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dsxHost', {
  send: function (payload) {
    try { ipcRenderer.send('dsx:bridge', payload); } catch (e) {}
  }
});