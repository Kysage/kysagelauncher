'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const { Store, dataRoot } = require('./store');
const { launchGame, listVersions, stageVanillaClientForLoader } = require('./minecraft');
const { findJava, probeJava, requiredJavaMajorForMinecraft } = require('./java');
const { sanitizeNickname, offlineUuid } = require('./auth');
const loaderApi = require('./loaders');
const modsApi = require('./mods');
const modrinthApi = require('./modrinth');
const curseforgeApi = require('./curseforge');
const { curseforgeApiKey } = require('./config');
const skinsApi = require('./skins');
const offlineSkinPackApi = require('./offline-skin-pack');

app.setAppUserModelId('com.obsidian.launcher');
app.setName('OBSIDIAN Launcher');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null;
let accountsWin = null;
let store = null;
let devWatcher = null;
let devReloadTimer = null;
const downloadOperations = new Map();

const state = {
  starting: false,
  abort: null,
  child: null,
  logs: []
};

const args = process.argv.slice(1);
const screenshotIndex = args.indexOf('--screenshot');
const screenshotInline = args.find((item) => item.startsWith('--screenshot='));
const viewArg = args.find((item) => item.startsWith('--view='));
const waitArg = args.find((item) => item.startsWith('--wait='));
const devMode = args.includes('--dev');
const electronCachePath = path.join(
  app.getPath('appData'),
  'OBSIDIAN Launcher',
  devMode ? 'Cache-dev' : 'Cache'
);
try {
  fs.mkdirSync(electronCachePath, { recursive: true });
  app.setPath('cache', electronCachePath);
} catch (error) {
  console.warn('Не удалось настроить кэш Electron:', error.message);
}
const screenshotDelay = waitArg ? Math.max(200, Number(waitArg.split('=')[1]) || 2000) : 2000;

function parseScreenshotPath() {
  if (screenshotIndex === -1 && !screenshotInline) return null;
  if (screenshotInline) return path.resolve(screenshotInline.split('=')[1] || 'shots/preview.png');
  const next = args[screenshotIndex + 1];
  return path.resolve(next && !next.startsWith('--') ? next : 'shots/preview.png');
}

function rootDir() {
  return dataRoot();
}

function publicSettings(settings) {
  const nickname = settings.nickname || 'Steve';
  return {
    ...settings,
    accounts: (settings.accounts || []).map((account) => ({
      id: account.id,
      provider: 'offline',
      nickname: account.nickname || '',
      uuid: offlineUuid(account.nickname || 'Steve')
    })),
    auth: {
      provider: 'offline',
      username: '',
      uuid: offlineUuid(nickname),
      nickname
    }
  };
}

function gameDir(settings) {
  return settings.gameDir?.trim() || path.join(dataRoot(), 'game');
}

function selectedGameDir() {
  const instance = store?.getSelectedInstance();
  if (!instance) throw new Error('Сначала создайте или выберите сборку.');
  return instance.gameDir;
}

function profileSkinPath() {
  return path.join(rootDir(), 'profile-skin.png');
}

async function loadProfileSkin() {
  let buffer;
  try {
    buffer = await fs.promises.readFile(profileSkinPath());
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
  const dimensions = skinsApi.inspectSkinPng(buffer);
  if (nativeImage.createFromBuffer(buffer).isEmpty()) {
    throw new Error('Сохранённый PNG-скин не удалось прочитать.');
  }
  return { dataUrl: skinsApi.skinDataUrl(buffer), ...dimensions };
}

async function syncOfflineSkinPack(instance, gameVersion = instance?.versionId) {
  if (!instance) return;
  let buffer;
  try {
    buffer = await fs.promises.readFile(profileSkinPath());
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await offlineSkinPackApi.removeOfflineSkinPack(instance.gameDir);
    return;
  }
  await offlineSkinPackApi.applyOfflineSkinPack({
    gameDir: instance.gameDir,
    gameVersion,
    skinBuffer: buffer
  });
}

async function saveProfileSkin(sourcePath) {
  const buffer = await fs.promises.readFile(sourcePath);
  const dimensions = skinsApi.inspectSkinPng(buffer);
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) throw new Error('Не удалось декодировать PNG-скин.');
  const decodedSize = image.getSize();
  if (decodedSize.width !== dimensions.width || decodedSize.height !== dimensions.height) {
    throw new Error('Размер изображения скина прочитан некорректно.');
  }

  const destination = profileSkinPath();
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.promises.writeFile(temporary, buffer, { flag: 'wx' });
    await fs.promises.rename(temporary, destination);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { dataUrl: skinsApi.skinDataUrl(buffer), ...dimensions };
}

async function installLoader(loader, versionId, loaderVersion, targetGameDir, settings, signal) {
  if (loader === 'vanilla') return;
  if (loader === 'fabric') {
    const installed = await loaderApi.installFabric(rootDir(), versionId, loaderVersion, signal);
    return { ...installed, loaderVersion };
  }
  if (loader === 'quilt') {
    const installed = await loaderApi.installQuilt(rootDir(), versionId, loaderVersion, signal);
    return { ...installed, loaderVersion };
  }

  const requiredMajor = requiredJavaMajorForMinecraft(versionId);
  const java = findJava({ customPath: settings.javaPath, requiredMajor });
  if (!java || !java.compatible) {
    throw new Error(
      `Для Minecraft ${versionId} требуется Java ${requiredMajor} или новее. ` +
      'Установите подходящую Java или выберите её путь в настройках.'
    );
  }
  await stageVanillaClientForLoader({
    root: rootDir(),
    gameDir: targetGameDir,
    versionId,
    signal
  });
  if (loader === 'forge') {
    return loaderApi.installForge({
      root: rootDir(),
      gameDir: targetGameDir,
      gameVersion: versionId,
      forgeVersion: loaderVersion,
      javaPath: java.path,
      signal
    });
  }
  if (loader === 'neoforge') {
    return loaderApi.installNeoForge({
      root: rootDir(),
      gameDir: targetGameDir,
      gameVersion: versionId,
      neoForgeVersion: loaderVersion,
      javaPath: java.path,
      signal
    });
  }
  throw new Error('Неизвестный загрузчик игры');
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function configureAutoUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.setFeedURL({ provider: 'github', owner: 'Kysage', repo: 'kysagelauncher' });
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (error) => send('updates:event', { type: 'error', message: error.message }));
  autoUpdater.on('checking-for-update', () => send('updates:event', { type: 'checking' }));
  autoUpdater.on('update-available', (info) => send('updates:event', { type: 'available', version: info.version }));
  autoUpdater.on('update-not-available', (info) => send('updates:event', { type: 'not-available', version: info.version }));
  autoUpdater.on('download-progress', (progress) => send('updates:event', { type: 'progress', percent: Math.round(progress.percent) }));
  autoUpdater.on('update-downloaded', (info) => send('updates:event', { type: 'downloaded', version: info.version }));
  autoUpdater.checkForUpdates().catch((error) => send('updates:event', { type: 'error', message: error.message }));
}

function broadcast(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

async function accountsState() {
  return {
    settings: publicSettings(store.get()),
    skin: await loadProfileSkin().catch(() => null)
  };
}

async function notifyAccountsChanged() {
  const payload = await accountsState();
  broadcast('accounts:changed', payload);
  return payload;
}

function openAccountsWindow() {
  if (accountsWin && !accountsWin.isDestroyed()) {
    if (accountsWin.isMinimized()) accountsWin.restore();
    accountsWin.focus();
    return;
  }

  accountsWin = new BrowserWindow({
    width: 520,
    height: 720,
    minWidth: 440,
    minHeight: 560,
    parent: win && !win.isDestroyed() ? win : undefined,
    modal: false,
    frame: false,
    show: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#07080c',
    title: 'Учётные записи',
    webPreferences: {
      preload: path.join(__dirname, 'accounts-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  accountsWin.loadFile(path.join(__dirname, '..', 'renderer', 'accounts.html'));
  accountsWin.once('ready-to-show', () => accountsWin.show());
  accountsWin.on('closed', () => {
    accountsWin = null;
  });
}

function pushLog(payload) {
  state.logs.push(payload);
  if (state.logs.length > 3000) state.logs.shift();
  send('launch:event', { type: 'log', ...payload });
}

function startDownloadOperation(operationId) {
  const id = String(operationId || '');
  if (!/^[\w.-]{1,80}$/.test(id)) throw new Error('Некорректный идентификатор операции.');
  if (downloadOperations.has(id)) throw new Error('Операция загрузки с таким идентификатором уже выполняется.');
  const controller = new AbortController();
  downloadOperations.set(id, controller);
  return {
    signal: controller.signal,
    progress: (payload) => send('mods:progress', { operationId: id, ...payload }),
    finish: () => downloadOperations.delete(id)
  };
}

function validateModrinthOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Некорректные параметры Modrinth.');
  }
}

function validateCurseForgeOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Некорректные параметры CurseForge.');
  }
}

async function runModrinthOperation(operationId, task) {
  const operation = startDownloadOperation(operationId);
  try {
    const service = new modrinthApi.ModrinthService();
    return await task({ ...operation, service });
  } finally {
    operation.finish();
  }
}

async function runCurseForgeOperation(operationId, task) {
  const operation = startDownloadOperation(operationId);
  try {
    const apiKey = curseforgeApiKey();
    const service = new curseforgeApi.CurseForgeService(apiKey);
    return await task({ ...operation, service, apiKey });
  } catch (error) {
    if (operation.signal.aborted && error?.name === 'AbortError') return { cancelled: true };
    throw error;
  } finally {
    operation.finish();
  }
}

async function openCurseForgeFallback({ fileName, pageUrl, reason = '', fileLength, hashes }) {
  send('mods:fallback', { fileName, pageUrl, reason, fileLength, hashes });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    title: 'OBSIDIAN Launcher',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  Menu.setApplicationMenu(null);
  const query = {};
  if (args.includes('--demo')) {
    query.demo = '1';
    if (args.includes('--autoplay')) query.autoplay = '1';
  }
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), Object.keys(query).length ? { query } : undefined);
  if (devMode) {
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'r') {
        win.webContents.reloadIgnoringCache();
      }
    });
    const watchedFiles = [
      path.join(__dirname, '..', 'renderer', 'index.html'),
      path.join(__dirname, '..', 'renderer', 'styles.css'),
      path.join(__dirname, '..', 'renderer', 'app.js'),
      path.join(__dirname, '..', 'renderer', 'art.js')
    ];
    const reload = () => {
      clearTimeout(devReloadTimer);
      devReloadTimer = setTimeout(() => {
        if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
      }, 120);
    };
    devWatcher = fs.watchFile(watchedFiles[0], { interval: 250 }, reload);
    for (const file of watchedFiles.slice(1)) fs.watchFile(file, { interval: 250 }, reload);
    win.on('closed', () => {
      for (const file of watchedFiles) fs.unwatchFile(file, reload);
      clearTimeout(devReloadTimer);
      devWatcher = null;
    });
  }

  win.once('ready-to-show', () => {
    win.show();
    if (viewArg) {
      const view = viewArg.split('=')[1];
      setTimeout(() => {
        win.webContents
          .executeJavaScript(
            `document.querySelector('[data-view="${view}"]')?.click(); document.querySelector('[data-view-panel="${view}"]')?.scrollTo(0,0);`
          )
          .catch(() => {});
      }, 700);
    }
  });

  win.on('maximize', () => send('window:state', { maximized: true }));
  win.on('unmaximize', () => send('window:state', { maximized: false }));

  win.webContents.on('did-finish-load', () => {
    const target = parseScreenshotPath();
    if (!target) return;
    setTimeout(async () => {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const image = await win.webContents.capturePage();
        fs.writeFileSync(target, image.toPNG());
        console.log(`Screenshot saved: ${target}`);
      } catch (err) {
        console.error('Screenshot failed:', err);
      }
      app.quit();
    }, screenshotDelay);
  });

  win.on('closed', () => {
    win = null;
  });

  if (args.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach' });
}

/* ─────────────────────────── IPC ─────────────────────────── */

function registerIpc() {
  ipcMain.handle('updates:check', async () => {
    if (!app.isPackaged) return { ok: false, reason: 'dev' };
    try {
      autoUpdater.checkForUpdates().catch((error) => send('updates:event', { type: 'error', message: error.message }));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message || 'Не удалось проверить обновления.' };
    }
  });

  ipcMain.handle('updates:download', async () => {
    if (!app.isPackaged) return { ok: false, reason: 'dev' };
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message || 'Не удалось скачать обновление.' };
    }
  });

  ipcMain.handle('updates:install', () => {
    if (!app.isPackaged) return false;
    autoUpdater.quitAndInstall();
    return true;
  });

  ipcMain.handle('app:init', async () => {
    const settings = store.get();
    const instance = store.getSelectedInstance();
    const java = findJava({
      customPath: settings.javaPath,
      requiredMajor: requiredJavaMajorForMinecraft(instance?.versionId || settings.versionId)
    });
    return {
      settings: publicSettings(settings),
      instance,
      instances: store.getInstances(),
      system: {
        platform: process.platform,
        totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
        java
      },
      paths: {
        root: rootDir(),
        game: gameDir(settings),
        versions: path.join(rootDir(), 'versions')
      },
      curseforgeConfigured: Boolean(curseforgeApiKey()),
      skin: await loadProfileSkin(),
      running: Boolean(state.child),
      logs: state.logs.slice(-400)
    };
  });

  ipcMain.handle('versions:list', async (_event, force) => {
    return listVersions(rootDir(), { force: Boolean(force) });
  });

  ipcMain.handle('instances:list', async () => ({
    instances: store.getInstances(),
    selectedId: store.getSelectedInstance()?.id || ''
  }));

  ipcMain.handle('instances:create', async (_event, options = {}) => {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('Некорректные параметры сборки.');
    }
    const name = String(options.name || '').trim();
    const versionId = String(options.versionId || '');
    const loader = String(options.loader || 'vanilla');
    const loaderVersion = String(options.loaderVersion || '');
    if (!name || name.length > 40) throw new Error('Название сборки должно содержать от 1 до 40 символов.');
    if (!/^[\w.-]{1,64}$/.test(versionId)) throw new Error('Выберите корректную версию Minecraft.');
    if (!['vanilla', 'forge', 'fabric', 'quilt', 'neoforge'].includes(loader)) {
      throw new Error('Неизвестный загрузчик игры.');
    }
    if (loader !== 'vanilla' && !/^[\w.+-]{1,64}$/.test(loaderVersion)) {
      throw new Error('Выберите корректную версию загрузчика.');
    }

    const id = crypto.randomUUID();
    const targetGameDir = path.join(rootDir(), 'instances', id);
    await installLoader(loader, versionId, loaderVersion, targetGameDir, store.get());
    const instance = store.createInstance({
      id,
      name,
      versionId,
      loader,
      loaderVersion: loader === 'vanilla' ? '' : loaderVersion,
      gameDir: targetGameDir,
      memory: store.get().memory,
      createdAt: new Date().toISOString()
    });
    const settings = store.get();
    return {
      instance,
      instances: store.getInstances(),
      settings: publicSettings(settings),
      paths: { root: rootDir(), game: gameDir(settings) }
    };
  });

  ipcMain.handle('instances:select', async (_event, instanceId) => {
    if (state.child || state.starting) {
      throw new Error('Нельзя переключить сборку во время запуска или работы Minecraft.');
    }
    const instance = store.selectInstance(String(instanceId || ''));
    const settings = store.get();
    return {
      instance,
      instances: store.getInstances(),
      settings: publicSettings(settings),
      paths: { root: rootDir(), game: gameDir(settings) }
    };
  });

  ipcMain.handle('instances:delete', async (_event, instanceId) => {
    if (state.child || state.starting) throw new Error('Нельзя удалить сборку во время запуска или работы Minecraft.');
    const id = String(instanceId || '');
    const instance = store.getInstances().find((item) => item.id === id);
    if (!instance) throw new Error('Сборка не найдена.');
    if (instance.id === 'legacy' && store.getInstances().length === 1) {
      throw new Error('Нельзя удалить единственную основную сборку.');
    }
    const result = store.deleteInstance(id);
    await fs.promises.rm(instance.gameDir, { recursive: true, force: true });
    return {
      removed: result.removed,
      instance: result.selected,
      instances: result.instances,
      settings: publicSettings(store.get()),
      paths: { root: rootDir(), game: gameDir(store.get()) }
    };
  });

  ipcMain.handle('instances:update', async (_event, instanceId, patch = {}) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('Некорректные параметры сборки.');
    }
    const clean = {};
    if ('name' in patch) {
      clean.name = String(patch.name || '').trim();
      if (!clean.name || clean.name.length > 40) {
        throw new Error('Название сборки должно содержать от 1 до 40 символов.');
      }
    }
    if ('memory' in patch) {
      const value = Math.round(Number(patch.memory) / 512) * 512;
      clean.memory = Math.min(32768, Math.max(1024, Number.isFinite(value) ? value : 4096));
    }
    if (!Object.keys(clean).length) throw new Error('Нет параметров для сохранения.');
    const instance = store.updateInstance(String(instanceId || ''), clean);
    return {
      instance,
      instances: store.getInstances(),
      settings: publicSettings(store.get()),
      paths: { root: rootDir(), game: gameDir(store.get()) }
    };
  });

  ipcMain.handle('accounts:init', async () => accountsState());

  ipcMain.handle('accounts:open-window', async () => {
    openAccountsWindow();
    return { ok: true };
  });

  ipcMain.handle('accounts:close', async (event) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (target && !target.isDestroyed()) target.close();
    return { ok: true };
  });

  ipcMain.handle('accounts:select', async (_event, id) => {
    store.setActiveAccount(id);
    return notifyAccountsChanged();
  });

  ipcMain.handle('accounts:create', async (_event, nickname) => {
    const raw = String(nickname || '').trim();
    if (!raw) throw new Error('Введите ник аккаунта.');
    store.createAccount(sanitizeNickname(raw));
    return notifyAccountsChanged();
  });

  ipcMain.handle('accounts:update', async (_event, id, nickname) => {
    const raw = String(nickname || '').trim();
    if (!raw) throw new Error('Введите ник аккаунта.');
    store.updateAccount(id, sanitizeNickname(raw));
    return notifyAccountsChanged();
  });

  ipcMain.handle('accounts:delete', async (_event, id) => {
    store.removeAccount(id);
    return notifyAccountsChanged();
  });

  ipcMain.handle('settings:save', async (_event, patch = {}) => {
    const clean = { ...patch };
    if ('loader' in clean && !['vanilla', 'forge', 'fabric', 'quilt', 'neoforge'].includes(clean.loader)) {
      throw new Error('Неизвестный загрузчик игры');
    }
    if ('loaderVersion' in clean) {
      clean.loaderVersion = String(clean.loaderVersion || '');
      if (clean.loaderVersion && !/^[\w.+-]{1,64}$/.test(clean.loaderVersion)) {
        throw new Error('Некорректная версия загрузчика');
      }
    }
    if ('versionId' in clean && clean.versionId) {
      clean.versionId = String(clean.versionId);
      if (!/^[\w.-]{1,64}$/.test(clean.versionId)) throw new Error('Некорректная версия Minecraft');
    }
    // Ник аккаунта меняется только через окно учётных записей.
    delete clean.nickname;
    if ('memory' in clean) {
      const value = Math.round(Number(clean.memory) / 512) * 512;
      clean.memory = Math.min(32768, Math.max(1024, Number.isFinite(value) ? value : 4096));
    }
    if ('gameDir' in clean) clean.gameDir = String(clean.gameDir || '').trim();
    if ('javaPath' in clean) clean.javaPath = String(clean.javaPath || '').trim();
    const settings = store.save(clean);
    return { settings: publicSettings(settings), paths: { root: rootDir(), game: gameDir(settings) } };
  });

  ipcMain.handle('profile:skin:pick', async () => {
    const result = await dialog.showOpenDialog(accountsWin && !accountsWin.isDestroyed() ? accountsWin : win, {
      title: 'Выберите PNG-скин Minecraft',
      properties: ['openFile'],
      filters: [{ name: 'PNG-скин Minecraft', extensions: ['png'] }]
    });
    if (result.canceled || !result.filePaths.length) return null;
    const skin = await saveProfileSkin(result.filePaths[0]);
    await syncOfflineSkinPack(store.getSelectedInstance());
    await notifyAccountsChanged();
    return skin;
  });

  ipcMain.handle('profile:skin:remove', async () => {
    await fs.promises.rm(profileSkinPath(), { force: true });
    await Promise.all(store.getInstances().map((instance) =>
      offlineSkinPackApi.removeOfflineSkinPack(instance.gameDir)
    ));
    await notifyAccountsChanged();
    return { removed: true };
  });

  ipcMain.handle('java:probe', async (_event, javaPath) => {
    const settings = store.get();
    const instance = store.getSelectedInstance();
    const requiredMajor = requiredJavaMajorForMinecraft(instance?.versionId || settings.versionId);
    const result = probeJava(String(javaPath || '').trim()) ||
      findJava({ customPath: javaPath, requiredMajor });
    if (!result) return { ok: false, message: 'Java не найдена по этому пути' };
    return {
      ok: true,
      ...result,
      required: requiredMajor,
      compatible: result.major >= requiredMajor
    };
  });

  ipcMain.handle('loader:versions', async (_event, loader, versionId) => {
    if (!['fabric', 'forge', 'quilt', 'neoforge'].includes(loader)) {
      throw new Error('Неизвестный загрузчик игры');
    }
    if (!/^[\w.-]{1,64}$/.test(String(versionId || ''))) throw new Error('Сначала выберите корректную версию Minecraft');
    try {
      return { ok: true, ...(await loaderApi.listLoaderVersions(loader, versionId, rootDir())) };
    } catch (error) {
      return { ok: false, error: error.message || 'Не удалось получить версии загрузчика' };
    }
  });

  ipcMain.handle('loader:install', async (_event, loader, versionId, loaderVersion) => {
    if (!['fabric', 'forge', 'quilt', 'neoforge'].includes(loader)) throw new Error('Неизвестный загрузчик');
    if (!/^[\w.-]{1,64}$/.test(String(versionId || '')) || !/^[\w.+-]{1,64}$/.test(String(loaderVersion || ''))) {
      throw new Error('Некорректная версия загрузчика');
    }
    if (!loaderVersion) throw new Error('Сначала выберите загрузчик');
    const settings = store.get();
    await installLoader(loader, versionId, loaderVersion, gameDir(settings), settings);
    store.save({ loader, loaderVersion, versionId });
    return { ok: true };
  });

  ipcMain.handle('mods:list', async () => modsApi.listMods(selectedGameDir()));
  ipcMain.handle('mods:manual-status', async (_event, entries) => {
    if (!Array.isArray(entries) || entries.length > 300) throw new Error('Некорректный список ручных загрузок.');
    const instanceId = entries[0]?.instanceId;
    const instance = instanceId ? store.getInstances().find((item) => item.id === instanceId) : null;
    if (instanceId && !instance) return entries.map((entry) => ({ fileName: entry.fileName, ready: false, status: 'instance-missing' }));
    const gameDir = instance?.gameDir || selectedGameDir();
    return modsApi.inspectManualDownloads(entries, gameDir);
  });
  ipcMain.handle('mods:manual-import', async (_event, entries) => {
    if (!Array.isArray(entries) || entries.length > 300) throw new Error('Некорректный список ручных загрузок.');
    const instanceId = entries[0]?.instanceId;
    const instance = instanceId ? store.getInstances().find((item) => item.id === instanceId) : null;
    if (instanceId && !instance) throw new Error('Сборка для ручной загрузки больше не существует.');
    const targetDir = instance?.gameDir || selectedGameDir();
    return modsApi.importManualDownloads(targetDir, entries);
  });

  ipcMain.handle('mods:add-local', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Выберите файл мода',
      properties: ['openFile'],
      filters: [{ name: 'Моды Minecraft', extensions: ['jar'] }]
    });
    if (result.canceled) return null;
    return modsApi.addLocalMod(selectedGameDir(), result.filePaths[0]);
  });

  ipcMain.handle('mods:remove', async (_event, name) => {
    await modsApi.removeMod(selectedGameDir(), String(name || ''));
    return { ok: true };
  });

  ipcMain.handle('curseforge:browse', async () => {
    await shell.openExternal('https://www.curseforge.com/minecraft/mc-mods');
    return { ok: true };
  });

  const cancelDownload = (_event, operationId) => {
    const controller = downloadOperations.get(String(operationId || ''));
    if (controller) controller.abort();
    return { ok: true, cancelled: Boolean(controller) };
  };
  ipcMain.handle('mods:cancel', cancelDownload);
  ipcMain.handle('curseforge:search', async (_event, options = {}) => {
    validateCurseForgeOptions(options);
    const service = new curseforgeApi.CurseForgeService(curseforgeApiKey());
    return service.search({
      query: String(options.query || ''),
      classId: Number(options.classId || 6),
      gameVersion: String(options.gameVersion || ''),
      modLoaderType: options.modLoaderType === '' || options.modLoaderType == null
        ? undefined
        : Number(options.modLoaderType),
      sortField: Number(options.sortField || 2),
      sortOrder: String(options.sortOrder || 'desc'),
      index: Number(options.index || 0),
      pageSize: Number(options.pageSize || 24)
    });
  });

  ipcMain.handle('curseforge:files', async (_event, modId, options = {}) => {
    validateCurseForgeOptions(options);
    const service = new curseforgeApi.CurseForgeService(curseforgeApiKey());
    return service.listFiles(modId, {
      gameVersion: String(options.gameVersion || ''),
      modLoaderType: options.modLoaderType === '' || options.modLoaderType == null
        ? undefined
        : Number(options.modLoaderType),
      index: Number(options.index || 0),
      pageSize: Number(options.pageSize || 50)
    });
  });

  ipcMain.handle('curseforge:install', async (_event, fileId, options = {}) => {
    validateCurseForgeOptions(options);
    const classId = Number(options.classId);
    if (![6, 4471].includes(classId)) throw new Error('Неподдерживаемая категория CurseForge.');
    const instance = store.getSelectedInstance();
    const gameVersion = String(options.gameVersion || '');
    const loaderTypes = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
    const instanceLoaderType = loaderTypes[instance?.loader] || undefined;
    let modLoaderType = options.modLoaderType === '' || options.modLoaderType == null
      ? undefined
      : Number(options.modLoaderType);

    if (classId === 6) {
      if (!instance) throw new Error('Сначала создайте или выберите сборку.');
      if (!/^[\w.-]{1,64}$/.test(gameVersion)) throw new Error('Некорректная версия Minecraft.');
      if (!instanceLoaderType) {
        throw new Error('Для установки модов выберите сборку с Forge, Fabric, Quilt или NeoForge.');
      }
      if (modLoaderType === undefined) modLoaderType = instanceLoaderType;
      if (modLoaderType !== instanceLoaderType) {
        throw new Error('Фильтр загрузчика не совпадает с загрузчиком выбранной сборки.');
      }
    }

    const packName = String(options.packName || '')
      .replace(/[\u0000-\u001F<>:"/\\|?*]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);

    return runCurseForgeOperation(options.operationId, async ({ service, apiKey, signal, progress }) => {
      const common = {
        service,
        apiKey,
        gameDir: instance?.gameDir || '',
        fileId,
        signal,
        onProgress: progress,
        onFallback: openCurseForgeFallback,
        waitForManual: false
      };
      if (classId === 6) {
        return modsApi.installSelectedFile({
          ...common,
          gameVersion,
          modLoaderType
        });
      }

      let pendingInstance = null;
      try {
        const result = await modsApi.installModpack({
          ...common,
          packName,
          createTarget: ({ gameVersion: packVersion, loader, packFile }) => {
            const id = crypto.randomUUID();
            const targetGameDir = path.join(rootDir(), 'instances', id);
            const baseName = (packName || packFile.displayName || `Сборка CurseForge ${packFile.id}`)
              .replace(/[\u0000-\u001F<>:"/\\|?*]/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 40) || `Сборка CurseForge ${packFile.id}`;
            const taken = new Set(store.getInstances().map((item) => item.name.toLowerCase()));
            let name = baseName;
            for (let index = 2; taken.has(name.toLowerCase()); index += 1) {
              name = `${baseName.slice(0, 36)} ${index}`;
            }
            pendingInstance = {
              id,
              name,
              versionId: packVersion,
              loader: loader.loader,
              loaderVersion: loader.loaderVersion,
              gameDir: targetGameDir,
              memory: store.get().memory,
              createdAt: new Date().toISOString()
            };
            return { gameDir: targetGameDir, instance: pendingInstance };
          },
          installLoader: ({ loader, loaderVersion, gameVersion: packVersion, gameDir: targetDir, signal: installSignal }) =>
            installLoader(loader, packVersion, loaderVersion, targetDir, store.get(), installSignal)
        });

        if (pendingInstance) {
          const saved = store.createInstance(pendingInstance);
          result.instance = saved;
          result.instances = store.getInstances();
          result.settings = store.get();
          result.paths = { root: rootDir(), game: gameDir(result.settings) };
        }
        return result;
      } catch (error) {
        if (pendingInstance) {
          await fs.promises.rm(pendingInstance.gameDir, { recursive: true, force: true }).catch(() => {});
        }
        throw error;
      }
    });
  });

  ipcMain.handle('modrinth:search', async (_event, options = {}) => {
    validateModrinthOptions(options);
    const service = new modrinthApi.ModrinthService();
    return service.search(options);
  });

  ipcMain.handle('modrinth:versions', async (_event, projectId, options = {}) => {
    validateModrinthOptions(options);
    const service = new modrinthApi.ModrinthService();
    return service.listVersions(projectId, options);
  });

  ipcMain.handle('modrinth:install', async (_event, versionId, options = {}) => {
    validateModrinthOptions(options);
    const gameVersion = String(options.gameVersion || '');
    const loader = String(options.loader || '');
    if (!/^[\w.-]{1,64}$/.test(gameVersion)) throw new Error('Некорректная версия Minecraft.');
    if (!['forge', 'fabric', 'quilt', 'neoforge'].includes(loader)) {
      throw new Error('Для установки модов выберите Forge, Fabric, Quilt или NeoForge.');
    }
    return runModrinthOperation(options.operationId, async ({ service, signal, progress }) =>
      modsApi.installModrinthVersion({
        service,
        gameDir: selectedGameDir(),
        versionId,
        gameVersion,
        loader,
        signal,
        onProgress: progress
      })
    );
  });

  ipcMain.handle('game:launch', async (_event, requestedVersion) => {
    if (state.child) return { ok: false, error: 'Игра уже запущена.' };
    if (state.starting) return { ok: false, error: 'Подготовка уже идёт.' };

    const settings = store.get();
    if (!store.getSelectedInstance()) {
      return { ok: false, error: 'Сначала создайте сборку в разделе «Сборки».' };
    }
    const versionId = requestedVersion || settings.versionId;
    if (!versionId) return { ok: false, error: 'Сначала выберите версию игры.' };
    if (versionId !== settings.versionId) store.save({ versionId });

    state.starting = true;
    state.abort = new AbortController();
    state.logs = [];

    send('launch:event', {
      type: 'state',
      phase: 'preparing',
      message: 'Подготовка к запуску',
      percent: 0,
      detail: versionId
    });

    (async () => {
      try {
        await syncOfflineSkinPack(store.getSelectedInstance(), versionId);
        const { child, meta, java } = await launchGame({
          root: rootDir(),
          gameDir: gameDir(settings),
          settings,
          versionId,
          signal: state.abort.signal,
          onStatus: (payload) => send('launch:event', { type: 'state', ...payload }),
          onLog: (payload) => pushLog(payload)
        });

        state.starting = false;
        state.child = child;
        state.pid = child.pid;
        state.abort = null;

        send('launch:event', {
          type: 'state',
          phase: 'running',
          message: 'Minecraft запущен',
          percent: 100,
          detail: `Java ${java.major} · PID ${child.pid}`,
          versionId: meta.id
        });

        child.on('exit', (code, signalName) => {
          state.child = null;
          state.pid = null;
          send('launch:event', {
            type: 'exit',
            phase: 'idle',
            message: code === 0 ? 'Игра закрыта' : `Игра завершилась с кодом ${code ?? signalName}`,
            code,
            percent: 0
          });
        });

        if (settings.closeOnLaunch) {
          setTimeout(() => app.quit(), 1500);
        }
      } catch (err) {
        state.starting = false;
        const aborted = state.abort?.signal.aborted;
        if (!aborted) {
          const message = err?.message || 'Неизвестная ошибка';
          pushLog({ stream: 'error', line: err?.stack || message });
          send('launch:event', {
            type: 'error',
            phase: 'error',
            message,
            hint: err?.hint || ''
          });
        } else {
          send('launch:event', {
            type: 'state',
            phase: 'idle',
            message: 'Запуск отменён',
            percent: 0
          });
        }
      } finally {
        if (!state.child) state.abort = null;
      }
    })();

    return { ok: true };
  });

  ipcMain.handle('game:stop', async () => {
    const wasActive = Boolean(state.child || state.starting);
    state.abort?.abort();
    if (state.child) {
      try {
        state.child.kill();
      } catch {
        /* ignore */
      }
    }
    return { ok: true, stopped: wasActive };
  });

  ipcMain.handle('dialog:pick-java', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Выберите java.exe',
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'Java', extensions: ['exe'] }]
          : [{ name: 'Все файлы', extensions: ['*'] }]
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:pick-dir', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Выберите папку',
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('curseforge:open-file-page', async (_event, pageUrl) => {
    const url = String(pageUrl || '');
    if (!/^https:\/\/(?:www\.)?curseforge\.com\//i.test(url)) throw new Error('Недопустимый адрес CurseForge.');
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('shell:open', async (_event, target) => {
    const settings = store.get();
    const map = {
      game: gameDir(settings),
      root: rootDir(),
      versions: path.join(rootDir(), 'versions')
    };
    const dir = map[target] || map.game;
    fs.mkdirSync(dir, { recursive: true });
    const error = await shell.openPath(dir);
    return error || null;
  });

  ipcMain.handle('win:action', async (_event, action) => {
    if (!win) return null;
    if (action === 'minimize') win.minimize();
    if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
    if (action === 'close') win.close();
    return { maximized: win.isMaximized() };
  });
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  if (accountsWin && !accountsWin.isDestroyed()) accountsWin.focus();
});

app.whenReady().then(() => {
  store = new Store();
  registerIpc();
  createWindow();
  configureAutoUpdates();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  state.abort?.abort();
  for (const controller of downloadOperations.values()) controller.abort();
  // Игра — отдельный процесс: закрытие лаунчера не должно её завершать.
});
