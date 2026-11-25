'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('accounts', {
  init: () => ipcRenderer.invoke('accounts:init'),
  select: (id) => ipcRenderer.invoke('accounts:select', id),
  create: (nickname) => ipcRenderer.invoke('accounts:create', nickname),
  update: (id, nickname) => ipcRenderer.invoke('accounts:update', id, nickname),
  remove: (id) => ipcRenderer.invoke('accounts:delete', id),
  pickSkin: () => ipcRenderer.invoke('profile:skin:pick'),
  removeSkin: () => ipcRenderer.invoke('profile:skin:remove'),
  close: () => ipcRenderer.invoke('accounts:close')
});
