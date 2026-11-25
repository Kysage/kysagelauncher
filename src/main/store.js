'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const DEFAULT_ACCOUNT = {
  id: 'offline-steve',
  provider: 'offline',
  nickname: 'Steve',
  username: '',
  uuid: ''
};

const DEFAULTS = {
  nickname: 'Steve',
  auth: { provider: 'offline', username: '', uuid: '' },
  accounts: [{ ...DEFAULT_ACCOUNT }],
  activeAccountId: DEFAULT_ACCOUNT.id,
  memory: 4096,
  javaPath: '',
  gameDir: '',
  versionId: '',
  loader: 'vanilla',
  loaderVersion: '',
  instances: [],
  selectedInstanceId: '',
  showConsole: true,
  closeOnLaunch: false,
  reduceMotion: false
};

function dataRoot() {
  return path.join(app.getPath('appData'), '.obsidian-launcher');
}

function defaultGameDir() {
  return path.join(dataRoot(), 'game');
}

class Store {
  constructor() {
    this.file = path.join(dataRoot(), 'settings.json');
    this.data = { ...DEFAULTS, instances: [] };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = {
        ...DEFAULTS,
        ...raw,
        auth: {
          ...DEFAULTS.auth,
          ...(raw.auth && typeof raw.auth === 'object' ? raw.auth : {})
        },
        accounts: this.loadAccounts(raw),
        activeAccountId: raw.activeAccountId || 'offline-steve',
        instances: Array.isArray(raw.instances)
          ? raw.instances.filter((instance) =>
              instance && typeof instance.id === 'string' && typeof instance.gameDir === 'string'
            ).map((instance) => ({
              ...instance,
              memory: Number.isFinite(instance.memory) ? instance.memory : raw.memory || DEFAULTS.memory
            }))
          : []
      };
      if (this.data.instances.length === 0 && raw.versionId) {
        const legacyInstance = {
          id: 'legacy',
          name: 'Моя сборка',
          versionId: raw.versionId,
          loader: raw.loader || 'vanilla',
          loaderVersion: raw.loaderVersion || '',
          gameDir: String(raw.gameDir || '').trim() || defaultGameDir(),
          createdAt: new Date().toISOString()
        };
        this.data.instances.push(legacyInstance);
        this.data.selectedInstanceId = legacyInstance.id;
      }

      const selected = this.data.instances.find((instance) => instance.id === this.data.selectedInstanceId);
      if (!selected && this.data.instances.length) this.data.selectedInstanceId = this.data.instances[0].id;
      const active = this.data.accounts.find((account) => account.id === this.data.activeAccountId) || this.data.accounts[0];
      if (active) {
        this.data.activeAccountId = active.id;
        this.data.auth = this.accountAuth(active);
        this.data.nickname = active.nickname;
      }
      if (this.data.selectedInstanceId) this.syncSelectedInstance();
    } catch {
      /* first run */
    }
    return this.data;
  }

  loadAccounts(raw) {
    const legacy = raw?.auth && typeof raw.auth === 'object' ? raw.auth : {};
    const source = Array.isArray(raw?.accounts) ? raw.accounts : [];
    const accounts = [];
    const seenIds = new Set();
    const seenNames = new Set();

    for (const entry of source) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.provider && entry.provider !== 'offline') continue;
      const nickname = String(entry.nickname || '').trim();
      if (!nickname) continue;
      const key = nickname.toLowerCase();
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      let id = typeof entry.id === 'string' && entry.id ? entry.id : `offline-${crypto.randomUUID()}`;
      while (seenIds.has(id)) id = `offline-${crypto.randomUUID()}`;
      seenIds.add(id);
      accounts.push({
        id,
        provider: 'offline',
        nickname,
        username: '',
        uuid: ''
      });
    }

    if (!accounts.length) {
      const fallbackName = legacy.provider !== 'ely.by' && raw?.nickname
        ? String(raw.nickname).trim()
        : DEFAULT_ACCOUNT.nickname;
      accounts.push({
        ...DEFAULT_ACCOUNT,
        nickname: fallbackName || DEFAULT_ACCOUNT.nickname
      });
    }

    return accounts;
  }

  accountAuth(account) {
    return {
      provider: 'offline',
      username: '',
      uuid: '',
      nickname: account?.nickname || 'Steve'
    };
  }

  get() {
    return this.data;
  }

  save(patch = {}) {
    this.data = { ...this.data, ...patch };
    if (this.data.selectedInstanceId && ['versionId', 'loader', 'loaderVersion', 'gameDir', 'memory'].some((key) => key in patch)) {
      const instance = this.data.instances.find((item) => item.id === this.data.selectedInstanceId);
      if (instance) {
        for (const key of ['versionId', 'loader', 'loaderVersion', 'gameDir', 'memory']) {
          if (key in patch) instance[key] = this.data[key];
        }
      }
    }
    try {
      this.write();
    } catch (err) {
      console.error('Не удалось сохранить настройки:', err.message);
    }
    return this.data;
  }

  write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  setActiveAccount(id) {
    const account = this.data.accounts.find((item) => item.id === String(id || ''));
    if (!account) throw new Error('Аккаунт не найден.');
    this.data.activeAccountId = account.id;
    this.data.auth = this.accountAuth(account);
    this.data.nickname = account.nickname;
    this.write();
    return { ...account };
  }

  createAccount(nickname) {
    const name = String(nickname || '').trim();
    if (!name) throw new Error('Введите ник аккаунта.');
    if (this.data.accounts.some((item) => item.nickname.toLowerCase() === name.toLowerCase())) {
      throw new Error('Аккаунт с таким ником уже существует.');
    }
    const account = {
      id: `offline-${crypto.randomUUID()}`,
      provider: 'offline',
      nickname: name,
      username: '',
      uuid: ''
    };
    this.data.accounts.push(account);
    this.data.activeAccountId = account.id;
    this.data.auth = this.accountAuth(account);
    this.data.nickname = account.nickname;
    this.write();
    return { ...account };
  }

  updateAccount(id, nickname) {
    const account = this.data.accounts.find((item) => item.id === String(id || ''));
    if (!account) throw new Error('Аккаунт не найден.');
    const name = String(nickname || '').trim();
    if (!name) throw new Error('Введите ник аккаунта.');
    if (this.data.accounts.some((item) => item.id !== account.id && item.nickname.toLowerCase() === name.toLowerCase())) {
      throw new Error('Аккаунт с таким ником уже существует.');
    }
    account.nickname = name;
    if (this.data.activeAccountId === account.id) {
      this.data.nickname = name;
      this.data.auth = this.accountAuth(account);
    }
    this.write();
    return { ...account };
  }

  removeAccount(id) {
    if (this.data.accounts.length <= 1) throw new Error('Нельзя удалить последний аккаунт.');
    const index = this.data.accounts.findIndex((item) => item.id === String(id || ''));
    if (index < 0) throw new Error('Аккаунт не найден.');
    this.data.accounts.splice(index, 1);
    if (this.data.activeAccountId === id) this.setActiveAccount(this.data.accounts[0].id);
    else this.write();
    return this.data.accounts.map((item) => ({ ...item }));
  }

  getInstances() {
    return this.data.instances.map((instance) => ({ ...instance }));
  }

  getSelectedInstance() {
    const instance = this.data.instances.find((item) => item.id === this.data.selectedInstanceId);
    return instance ? { ...instance } : null;
  }

  createInstance(instance) {
    if (this.data.instances.some((item) => item.id === instance.id)) {
      throw new Error('Сборка с таким идентификатором уже существует.');
    }
    const previousSelectedId = this.data.selectedInstanceId;
    this.data.instances.push({ ...instance });
    this.data.selectedInstanceId = instance.id;
    this.syncSelectedInstance();
    try {
      this.write();
    } catch (error) {
      this.data.instances.pop();
      this.data.selectedInstanceId = previousSelectedId;
      this.syncSelectedInstance();
      throw error;
    }
    return this.getSelectedInstance();
  }

  selectInstance(id) {
    const instance = this.data.instances.find((item) => item.id === id);
    if (!instance) throw new Error('Сборка не найдена.');
    const previousSelectedId = this.data.selectedInstanceId;
    this.data.selectedInstanceId = instance.id;
    this.syncSelectedInstance();
    try {
      this.write();
    } catch (error) {
      this.data.selectedInstanceId = previousSelectedId;
      this.syncSelectedInstance();
      throw error;
    }
    return this.getSelectedInstance();
  }

  deleteInstance(id) {
    const index = this.data.instances.findIndex((item) => item.id === id);
    if (index < 0) throw new Error('Сборка не найдена.');
    const [removed] = this.data.instances.splice(index, 1);
    if (this.data.selectedInstanceId === id) {
      this.data.selectedInstanceId = this.data.instances[0]?.id || '';
      this.syncSelectedInstance();
    }
    this.write();
    return { removed: { ...removed }, instances: this.getInstances(), selected: this.getSelectedInstance() };
  }

  updateInstance(id, patch) {
    const instance = this.data.instances.find((item) => item.id === id);
    if (!instance) throw new Error('Сборка не найдена.');
    const previous = { ...instance };
    Object.assign(instance, patch);
    if (instance.id === this.data.selectedInstanceId) this.syncSelectedInstance();
    try {
      this.write();
    } catch (error) {
      Object.assign(instance, previous);
      if (instance.id === this.data.selectedInstanceId) this.syncSelectedInstance();
      throw error;
    }
    return { ...instance };
  }

  syncSelectedInstance() {
    const instance = this.data.instances.find((item) => item.id === this.data.selectedInstanceId);
    if (!instance) return;
    this.data.versionId = instance.versionId;
    this.data.loader = instance.loader;
    this.data.loaderVersion = instance.loaderVersion;
    this.data.gameDir = instance.gameDir;
    if (!Number.isFinite(instance.memory)) instance.memory = this.data.memory;
    this.data.memory = instance.memory;
  }
}

module.exports = { Store, dataRoot, defaultGameDir, DEFAULTS };
