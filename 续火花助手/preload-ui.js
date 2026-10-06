'use strict';
// 主界面 preload：向页面暴露 dsx.invoke（调主进程）和 dsx.onEvent(收事件)
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dsx', {
  invoke: function (method, args) { return ipcRenderer.invoke('dsx:ui-invoke', method, args || {}); },
  onEvent: function (cb) {
    ipcRenderer.on('dsx:ui', function (ev, obj) { try { cb(obj); } catch (e) {} });
  }
});