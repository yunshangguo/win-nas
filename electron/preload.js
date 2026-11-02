'use strict';
// 设置窗口与渲染进程之间的安全桥：仅暴露两个方法，不暴露 Node 能力。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nmSettings', {
  get: () => ipcRenderer.invoke('get-settings'),
  save: (data) => ipcRenderer.invoke('save-settings', data)
});
