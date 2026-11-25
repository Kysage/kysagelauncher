'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  init: () => ipcRenderer.invoke('app:init'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  onUpdateEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updates:event', listener);
    return () => ipcRenderer.removeListener('updates:event', listener);
  },
  versions: (force = false) => ipcRenderer.invoke('versions:list', force),
  instances: () => ipcRenderer.invoke('instances:list'),
  createInstance: (options) => ipcRenderer.invoke('instances:create', options),
  selectInstance: (instanceId) => ipcRenderer.invoke('instances:select', instanceId),
  updateInstance: (instanceId, patch) => ipcRenderer.invoke('instances:update', instanceId, patch),
  deleteInstance: (instanceId) => ipcRenderer.invoke('instances:delete', instanceId),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  openAccounts: () => ipcRenderer.invoke('accounts:open-window'),
  onAccountsChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('accounts:changed', listener);
    return () => ipcRenderer.removeListener('accounts:changed', listener);
  },
  probeJava: (javaPath) => ipcRenderer.invoke('java:probe', javaPath),
  loaderVersions: (loader, versionId) => ipcRenderer.invoke('loader:versions', loader, versionId),
  installLoader: (loader, versionId, loaderVersion) => ipcRenderer.invoke('loader:install', loader, versionId, loaderVersion),
  modsList: () => ipcRenderer.invoke('mods:list'),
  checkManualDownloads: (entries) => ipcRenderer.invoke('mods:manual-status', entries),
  importManualDownloads: (entries) => ipcRenderer.invoke('mods:manual-import', entries),
  addLocalMod: () => ipcRenderer.invoke('mods:add-local'),
  removeMod: (name) => ipcRenderer.invoke('mods:remove', name),
  browseCurseForge: () => ipcRenderer.invoke('curseforge:browse'),
  curseForgeSearch: (options) => ipcRenderer.invoke('curseforge:search', options),
  curseForgeFiles: (modId, options) => ipcRenderer.invoke('curseforge:files', modId, options),
  installCurseForgeFile: (fileId, options) => ipcRenderer.invoke('curseforge:install', fileId, options),
  openCurseForgeFilePage: (pageUrl) => ipcRenderer.invoke('curseforge:open-file-page', pageUrl),
  modrinthSearch: (options) => ipcRenderer.invoke('modrinth:search', options),
  modrinthVersions: (projectId, options) => ipcRenderer.invoke('modrinth:versions', projectId, options),
  installModrinthVersion: (versionId, options) => ipcRenderer.invoke('modrinth:install', versionId, options),
  cancelModOperation: (operationId) => ipcRenderer.invoke('mods:cancel', operationId),
  launch: (versionId) => ipcRenderer.invoke('game:launch', versionId),
  stop: () => ipcRenderer.invoke('game:stop'),
  pickJava: () => ipcRenderer.invoke('dialog:pick-java'),
  pickDir: () => ipcRenderer.invoke('dialog:pick-dir'),
  openPath: (target) => ipcRenderer.invoke('shell:open', target),
  windowAction: (action) => ipcRenderer.invoke('win:action', action),
  onLaunch: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('launch:event', listener);
    return () => ipcRenderer.removeListener('launch:event', listener);
  },
  onWindowState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('window:state', listener);
    return () => ipcRenderer.removeListener('window:state', listener);
  },
  onModsProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('mods:progress', listener);
    return () => ipcRenderer.removeListener('mods:progress', listener);
  },
  onModsFallback: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('mods:fallback', listener);
    return () => ipcRenderer.removeListener('mods:fallback', listener);
  },
  onModsFallbackError: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('mods:fallback-error', listener);
    return () => ipcRenderer.removeListener('mods:fallback-error', listener);
  }
});
