/* OBSIDIAN Launcher — интерфейс и взаимодействие */
(() => {
  'use strict';

  const art = window.LauncherArt;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const params = new URLSearchParams(window.location.search);
  const api = params.has('demo') ? null : window.launcher || null;

  const state = {
    bridge: null,
    settings: null,
    instances: [],
    activeInstance: null,
    versions: [],
    selected: '',
    view: 'home',
    loadingVersions: true,
    versionError: '',
    versionQuery: '',
    versionFilter: {
      remote: true,
      modifications: true,
      alpha: false,
      experimental: false,
      installedOnly: false,
      snapshot: false,
      beta: false,
      launcher: false,
      legacy: true
    },
    busy: false,
    running: false,
    progressPercent: 0,
    java: null,
    paths: null,
    logs: [],
    mods: [],
    skin: null,
    loaderCategory: 'vanilla',
    instanceLoaderRequestId: 0,
    modOperationId: '',
    modDownloadIsPack: false,
    modDownloadOverallPercent: 0,
    modSearchRequestId: 0,
    modIndex: 0,
    curseforgeContext: 'mods',
    curseforgeConfigured: false,
    manualDownloads: [],
    manualStatus: {},
    manualInstanceId: '',
    manualPollTimer: null
  };

  const ICONS = {
    play: '<svg viewBox="0 0 18 18" fill="currentColor"><path d="M5.4 3.1c0-.6.6-.9 1.1-.6l7.7 5.2c.4.3.4.9 0 1.2l-7.7 5.2c-.5.3-1.1 0-1.1-.6V3.1Z"/></svg>',
    stop: '<svg viewBox="0 0 18 18" fill="currentColor"><rect x="4.5" y="4.5" width="9" height="9" rx="2"/></svg>',
    refresh: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2v3.5H9.5"/></svg>',
    check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.1"><path d="m3.6 8.4 2.8 2.8 6-6.4"/></svg>',
    arrow: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 8h9M8.5 3.8 12.7 8l-4.2 4.2"/></svg>',
    spinner:
      '<svg class="spin" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 2.2a6.8 6.8 0 1 0 6.8 6.8"/></svg>'
  };

  const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const LOADER_NAMES = { vanilla: 'Vanilla', forge: 'Forge', fabric: 'Fabric', quilt: 'Quilt', neoforge: 'NeoForge' };
  const LOADER_TYPES = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };

  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

  const formatDate = (iso) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
  };

  const typeLabel = (type) =>
    ({ release: 'Релиз', snapshot: 'Снапшот', old_beta: 'Бета', old_alpha: 'Альфа' })[type] || 'Версия';

  const formatMemory = (mb) => {
    if (mb < 1024) return `${mb} МБ`;
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} ГБ`;
  };

  const cleanError = (error) => {
    const message = String(error?.message || error || 'Неизвестная ошибка');
    return message.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '');
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* ─────────────────────────── инициализация ─────────────────────────── */

  document.addEventListener('DOMContentLoaded', () => {
    mountArt();
    state.bridge = api || createDemoBridge();
    if (!api) $('#demoChip').hidden = false;
    bindEvents();
    start();
  });

  function mountArt() {
    $('#brandMark').innerHTML = art.logo(32);
    $('#heroArt').innerHTML = art.scene();
    $('#playIcon').innerHTML = ICONS.play;
    $('#stopBtn .btn-icon').innerHTML = ICONS.stop;
    $('#saveSettings .btn-icon').innerHTML = ICONS.check;
    $('#heroParticles').innerHTML = Array.from({ length: 12 }, (_, index) => {
      const left = 8 + Math.random() * 76;
      const top = 20 + Math.random() * 62;
      const duration = 7 + Math.random() * 8;
      const delay = -Math.random() * 12;
      return `<i style="left:${left.toFixed(1)}%;top:${top.toFixed(1)}%;animation-duration:${duration.toFixed(1)}s;animation-delay:${delay.toFixed(1)}s"></i>`;
    }).join('');
  }

  async function start() {
    try {
      const info = await state.bridge.init();
      state.settings = info.settings;
      state.instances = info.instances || [];
      state.activeInstance = info.instance || null;
      state.loaderCategory = state.activeInstance?.loader || state.settings.loader || 'vanilla';
      state.java = info.system?.java || null;
      state.paths = info.paths || null;
      state.selected = state.activeInstance?.versionId || state.settings.versionId || '';
      state.skin = info.skin || null;
      state.curseforgeConfigured = Boolean(info.curseforgeConfigured);
      $('#curseforgeKeyHint').textContent = state.curseforgeConfigured
        ? 'Ключ CurseForge подключён автоматически. Для установки модов нужна сборка с Forge, Fabric, Quilt или NeoForge.'
        : 'Ключ CurseForge не найден. Добавьте CURSEFORGE_API_KEY в .env или окружение и перезапустите лаунчер.';
      $('#heroLoader').textContent = LOADER_NAMES[state.loaderCategory] || 'Vanilla';
      state.running = Boolean(info.running);
      state.logs = info.logs || [];

      updateProfile();
      syncSettingsForm();
      updateJavaUI();
      updatePathsUI();
      setMemory(state.settings.memory, { persist: false });
      renderPlay();
      if (state.running) {
        setStatus('idle', 'Minecraft уже запущен');
        state.busy = false;
      }

      if (state.bridge.onUpdateEvent) state.bridge.onUpdateEvent(handleUpdateEvent);
      $('#updateLater').addEventListener('click', () => { $('#updateModal').hidden = true; });
      $('#updateAction').addEventListener('click', handleUpdateAction);
      $('#checkUpdates').addEventListener('click', checkForNotifications);
      if (state.bridge.onLaunch) {
        state.bridge.onLaunch(handleLaunchEvent);
      }
      if (state.bridge.onModsProgress) {
        state.bridge.onModsProgress(handleModsProgress);
      }
      if (state.bridge.onModsFallback) {
        state.bridge.onModsFallback((item) => {
          mergeManualDownloads([item]);
          openManualDownloads();
        });
      }
      if (state.bridge.onModsFallbackError) {
        state.bridge.onModsFallbackError(({ fileName, message }) => showError(`Ошибка ручной загрузки ${fileName}`, message));
      }
      if (state.bridge.onAccountsChanged) {
        state.bridge.onAccountsChanged((payload) => {
          if (!payload?.settings) return;
          state.settings = payload.settings;
          state.skin = payload.skin || null;
          updateProfile();
          syncSettingsForm();
        });
      }
      if (api) {
        api.onWindowState(({ maximized }) => $('#app').classList.toggle('is-max', Boolean(maximized)));
      }

      await loadVersions(false);
      if (state.bridge.checkForUpdates) {
        state.bridge.checkForUpdates().catch((error) => console.warn('Update check failed:', error));
      }
      setLoaderCategory(state.loaderCategory);
      syncCurseForgeFilters();
      if (params.has('autoplay')) {
        setTimeout(() => {
          if (!state.busy && !state.running) play();
        }, 700);
      }
    } catch (error) {
      state.loadingVersions = false;
      showError('Не удалось запустить лаунчер', cleanError(error));
      renderVersions();
    }
  }

  /* ─────────────────────────── версии ─────────────────────────── */

  async function loadVersions(force) {
    state.loadingVersions = true;
    state.versionError = '';

    try {
      const data = await state.bridge.versions(force);
      state.versions = data.versions || [];
    } catch (error) {
      state.versionError = cleanError(error);
      showError('Не удалось загрузить список версий', state.versionError);
    } finally {
      state.loadingVersions = false;
      updateInstanceVersionOptions();
      renderVersions();
    }
  }

  function renderVersions() {
    renderInstanceList();
    renderHomeInstances();
    renderHero();
  }

  function renderInstanceList() {
    const container = $('#instanceList');
    if (!container) return;
    container.innerHTML = state.instances.length
      ? instanceCardsMarkup(state.instances)
      : `<div class="instance-empty">
          <span>${art.cube(44)}</span>
          <strong>Пока нет сборок</strong>
          <p>Создай отдельный профиль Vanilla, Forge, Fabric, Quilt или NeoForge.</p>
          <button class="btn btn--play" data-create-instance>Создать сборку</button>
        </div>`;
  }

  function renderHomeInstances() {
    const container = $('#homeInstances');
    if (!container) return;
    container.innerHTML = state.instances.length
      ? instanceCardsMarkup(state.instances.slice(0, 3), true)
      : '<div class="instance-empty instance-empty--compact"><strong>Сборок пока нет</strong><button class="btn btn--soft" data-create-instance>Создать первую</button></div>';
  }

  function instanceCardsMarkup(instances, compact = false) {
    return instances.map((instance) => {
      const active = instance.id === state.activeInstance?.id;
      const loaderName = LOADER_NAMES[instance.loader] || instance.loader;
      const loaderClass = `loader-${String(instance.loader || 'vanilla').toLowerCase()}`;
      return `<article class="instance-card${active ? ' is-active' : ''}${compact ? ' is-compact' : ''}">
        <div class="instance-card-main">
          <span class="instance-icon ${loaderClass}">${art.cube(compact ? 30 : 38)}</span>
          <div class="instance-info">
            <div class="instance-title-line"><strong>${esc(instance.name)}</strong>${active ? '<span class="instance-active-badge">АКТИВНАЯ</span>' : ''}</div>
            <span>Minecraft ${esc(instance.versionId)} <i></i> ${esc(loaderName)}${instance.loaderVersion ? ` ${esc(instance.loaderVersion)}` : ''}</span>
            ${compact ? '' : `<small>${esc(instance.gameDir || '')}</small>`}
          </div>
          <button class="btn ${active ? 'btn--play' : 'btn--soft'} btn--sm instance-select" data-select-instance="${esc(instance.id)}">${active ? 'Выбрана' : 'Выбрать'}</button>
        </div>
        ${compact ? '' : `<div class="instance-card-actions"><span>${active ? 'Сейчас выбрана для запуска' : 'Профиль готов к запуску'}</span><div><button class="btn btn--soft btn--sm" data-configure-instance="${esc(instance.id)}">Настроить</button><button class="btn btn--danger btn--sm" data-delete-instance="${esc(instance.id)}">Удалить</button></div></div>`}
      </article>`;
    }).join('');
  }

  function renderHero() {
    const memory = state.settings?.memory || 4096;
    const javaMajor = state.java?.major;

    $('#heroVersion').textContent = state.activeInstance?.name || 'Создать';
    $('#heroVersion').title = state.activeInstance?.name || 'Создать сборку';
    $('#heroLoader').textContent = LOADER_NAMES[state.activeInstance?.loader || 'vanilla'];
    $('#statVersion').textContent = state.activeInstance?.versionId || '—';
    $('#heroType').textContent = state.activeInstance?.versionId || 'Нет сборки';
    $('#heroJava').textContent = javaMajor ? `Java ${javaMajor}` : 'Java —';
    $('#statMemory').textContent = formatMemory(memory);
    $('#statJava').textContent = javaMajor ? String(javaMajor) : '—';
    $('#memBadge').textContent = formatMemory(memory);
  }

  function updateInstanceVersionOptions() {
    const select = $('#instanceGameVersion');
    if (!select) return;
    const selectedVersion = select.value || state.activeInstance?.versionId || state.versions.find((item) => item.type === 'release')?.id;
    const query = state.versionQuery.trim().toLowerCase();
    const filters = state.versionFilter;
    const filtered = state.versions.filter((version) => {
      const id = String(version.id || '');
      const type = String(version.type || '').toLowerCase();
      const installed = Boolean(version.installed || version.local || version.isInstalled);
      const legacy = /^1\\.(?:[0-5]\\.|6\\.(?:[0-4])(?:\\.|$)|7\\.(?:0|1)(?:\\.|$))/.test(id);
      if (query && !id.toLowerCase().includes(query)) return false;
      if (!filters.remote) return false;
      if (filters.installedOnly && !installed) return false;
      if (type === 'release' && legacy && !filters.legacy) return false;
      if (type === 'release' && !filters.modifications) return false;
      if (type === 'snapshot' && !filters.snapshot) return false;
      if ((type === 'old_beta' || type === 'beta') && !filters.beta) return false;
      if ((type === 'old_alpha' || type === 'alpha') && !filters.alpha) return false;
      if (type === 'launcher' && !filters.launcher) return false;
      if ((version.experimental || /experimental/i.test(id)) && !filters.experimental) return false;
      return true;
    });
    select.innerHTML = filtered.length
      ? filtered.map((version) =>
          `<option value="${esc(version.id)}"${version.id === selectedVersion ? ' selected' : ''}>${esc(version.id)} · ${esc(typeLabel(version.type))}</option>`
        ).join('')
      : `<option value="">${state.loadingVersions ? 'Загружаем версии…' : 'Нет версий по выбранным фильтрам'}</option>`;
    select.disabled = !filtered.length;
    if (filtered.length && !filtered.some((version) => version.id === selectedVersion)) {
      select.value = filtered.find((version) => version.type === 'release')?.id || filtered[0].id;
    }
    const count = $('#instanceVersionCount');
    if (count) count.textContent = `${filtered.length} / ${state.versions.length}`;
    if (select.value) loadInstanceLoaderVersions();
  }

  function openInstanceModal() {
    const modal = $('#instanceModal');
    setInstanceCreateMode('manual', { search: false });
    modal.hidden = false;
    $('#instanceName').value = '';
    updateInstanceVersionOptions();
    $('#instanceLoader').value = 'vanilla';
    updateInstanceLoaderField();
    $('#instanceName').focus();
  }

  function closeInstanceModal() {
    setInstanceCreateMode('manual', { search: false });
    $('#instanceModal').hidden = true;
  }

  function setInstanceCreateMode(mode, { search = true } = {}) {
    const browsePacks = mode === 'curseforge';
    state.curseforgeContext = browsePacks ? 'packs' : 'mods';
    const catalog = $('#curseforgeCatalog');
    const target = $(browsePacks ? '#instancePackBrowserHost' : '#curseforgeCatalogHome');
    $('#curseforgeCatalogHome').hidden = browsePacks;
    if (catalog && target && catalog.parentElement !== target) target.append(catalog);

    $('#instanceForm').hidden = browsePacks;
    $('#instancePackBrowser').hidden = !browsePacks;
    $('#instanceManualTab').classList.toggle('is-active', !browsePacks);
    $('#instanceManualTab').setAttribute('aria-selected', String(!browsePacks));
    $('#instanceCurseForgeTab').classList.toggle('is-active', browsePacks);
    $('#instanceCurseForgeTab').setAttribute('aria-selected', String(browsePacks));
    $('#instanceModalTitle').textContent = browsePacks ? 'Готовые сборки CurseForge' : 'Создать сборку';
    $('#instanceModalTitle').nextElementSibling.textContent = browsePacks
      ? 'Выбери сборку и версию файла, затем установи её в отдельный профиль.'
      : 'Выбери имя, версию Minecraft и загрузчик.';

    const category = $('#curseforgeClass');
    const version = $('#curseforgeVersion');
    const loader = $('#curseforgeLoader');
    const filtersLocked = Boolean(state.activeInstance && ['forge', 'fabric', 'quilt', 'neoforge'].includes(state.activeInstance.loader));
    category.disabled = state.curseforgeContext === 'packs' || filtersLocked;
    version.disabled = browsePacks || filtersLocked;
    loader.disabled = browsePacks || filtersLocked;
    category.value = browsePacks ? '4471' : '6';
    if (!browsePacks && state.activeInstance) {
      version.value = state.activeInstance.versionId;
      loader.value = String(LOADER_TYPES[state.activeInstance.loader] || '');
    }
    $('#curseforgeSearch').placeholder = browsePacks
      ? 'Например, популярная сборка или модпак'
      : 'Например, JourneyMap или сборка';
    $('#curseforgeSearch').parentElement.parentElement.querySelector('label').textContent = browsePacks
      ? 'Поиск готовых сборок'
      : 'Поиск модов и модпаков';

    if (browsePacks && search) {
      state.modIndex = 0;
      $('#curseforgeResults').replaceChildren();
      searchCurseForge();
    }
  }

  function openInstanceConfig(instance) {
    if (!instance) return;
    $('#instanceConfigTitle').textContent = `Настройки: ${instance.name}`;
    $('#instanceConfigDescription').textContent = `Minecraft ${instance.versionId} · ${LOADER_NAMES[instance.loader] || instance.loader}${instance.loaderVersion ? ` ${instance.loaderVersion}` : ''}`;
    $('#instanceConfigName').value = instance.name;
    $('#instanceConfigMemory').value = String(instance.memory || state.settings?.memory || 4096);
    $('#instanceConfigMemoryValue').textContent = formatMemory(Number($('#instanceConfigMemory').value));
    $('#instanceConfigMeta').textContent = instance.gameDir || '';
    $('#instanceConfigModal').hidden = false;
    $('#instanceConfigName').focus();
  }

  function closeInstanceConfig() {
    $('#instanceConfigModal').hidden = true;
  }

  function updateInstanceLoaderField() {
    const loader = $('#instanceLoader').value;
    const field = $('#instanceLoaderVersionField');
    field.hidden = loader === 'vanilla';
    $('#instanceLoaderHint').textContent = loader === 'vanilla'
      ? 'Для сборки будет создана отдельная папка игры.'
      : `Сначала будут установлены Minecraft и загрузчик ${LOADER_NAMES[loader] || loader}.`;
    loadInstanceLoaderVersions();
  }

  async function loadInstanceLoaderVersions() {
    const loader = $('#instanceLoader').value;
    const gameVersion = $('#instanceGameVersion').value;
    const select = $('#instanceLoaderVersion');
    const requestId = ++state.instanceLoaderRequestId;
    if (loader === 'vanilla') {
      select.disabled = true;
      select.innerHTML = '<option value="">Не требуется для Vanilla</option>';
      return;
    }
    if (!gameVersion) {
      select.disabled = true;
      select.innerHTML = '<option value="">Сначала выбери версию Minecraft</option>';
      return;
    }
    select.disabled = true;
    select.innerHTML = '<option value="">Загружаем версии загрузчика…</option>';
    try {
      const response = await state.bridge.loaderVersions(loader, gameVersion);
      if (requestId !== state.instanceLoaderRequestId || loader !== $('#instanceLoader').value) return;
      if (!response?.ok) throw new Error(response?.error || 'Не удалось получить версии загрузчика.');
      const versions = response.versions || [];
      select.innerHTML = versions.length
        ? versions.map((version, index) => `<option value="${esc(version)}"${index === 0 ? ' selected' : ''}>${esc(version)}</option>`).join('')
        : '<option value="">Совместимых версий не найдено</option>';
      select.disabled = !versions.length;
    } catch (error) {
      if (requestId !== state.instanceLoaderRequestId) return;
      select.innerHTML = `<option value="">${esc(cleanError(error))}</option>`;
      select.disabled = true;
    }
  }

  async function selectInstance(instanceId) {
    try {
      const result = await state.bridge.selectInstance(instanceId);
      if (!result?.instance || result.ok === false) throw new Error(result?.error || 'Сборка не найдена в списке профилей.');
      state.instances = result.instances || [];
      state.activeInstance = result.instance;
      state.settings = result.settings;
      state.paths = result.paths || state.paths;
      state.selected = result.instance.versionId;
      state.loaderCategory = result.instance.loader;
      renderVersions();
      updateProfile();
      updatePathsUI();
      setLoaderCategory(result.instance.loader);
      syncCurseForgeFilters();
      if (state.view === 'mods') {
        $('#modsInstanceLabel').textContent = `${result.instance.name} · Minecraft ${result.instance.versionId} · ${LOADER_NAMES[result.instance.loader] || result.instance.loader}`;
        $('#curseforgeVersion').value = result.instance.versionId;
        $('#curseforgeVersion').disabled = true;
        $('#curseforgeLoader').value = String(LOADER_TYPES[result.instance.loader] || '');
        $('#curseforgeLoader').disabled = true;
        $('#curseforgeClass').value = '6';
        $('#curseforgeClass').disabled = true;
        loadMods();
      }
      toast('Сборка выбрана', result.instance.name, 'success', 2600);
      return true;
    } catch (error) {
      showError('Не удалось выбрать сборку', cleanError(error));
      return false;
    }
  }

  async function deleteInstance(instanceId) {
    const instance = state.instances.find((item) => item.id === instanceId);
    if (!instance) return;
    if (!window.confirm(`Удалить сборку «${instance.name}» вместе со всеми файлами?`)) return;
    try {
      const result = await state.bridge.deleteInstance(instanceId);
      state.instances = result.instances || [];
      state.activeInstance = result.instance || null;
      state.settings = result.settings || state.settings;
      renderVersions();
      renderPlay();
      if ($('#modsInstanceLabel')) {
        $('#modsInstanceLabel').textContent = state.activeInstance
          ? `${state.activeInstance.name} · Minecraft ${state.activeInstance.versionId} · ${LOADER_NAMES[state.activeInstance.loader] || state.activeInstance.loader}`
          : 'Установленные JAR-файлы и каталог CurseForge.';
      }
      toast('Сборка удалена', instance.name, 'success');
    } catch (error) {
      showError('Не удалось удалить сборку', cleanError(error));
    }
  }

  async function configureInstance(instanceId) {
    if (state.activeInstance?.id !== instanceId && !(await selectInstance(instanceId))) return;
    openInstanceConfig(state.activeInstance);
  }

  async function saveInstanceConfig(event) {
    event.preventDefault();
    const instance = state.activeInstance;
    if (!instance) return;
    const button = $('#saveInstanceConfig');
    button.disabled = true;
    try {
      const result = await state.bridge.updateInstance(instance.id, {
        name: $('#instanceConfigName').value.trim(),
        memory: Number($('#instanceConfigMemory').value)
      });
      state.activeInstance = result.instance;
      state.instances = result.instances || [];
      state.settings = result.settings;
      state.paths = result.paths || state.paths;
      closeInstanceConfig();
      renderVersions();
      updateProfile();
      updatePathsUI();
      toast('Сборка настроена', result.instance.name, 'success');
    } catch (error) {
      showError('Не удалось сохранить сборку', cleanError(error));
    } finally {
      button.disabled = false;
    }
  }

  async function createInstance(event) {
    event.preventDefault();
    const button = $('#submitInstanceCreate');
    const loader = $('#instanceLoader').value;
    const options = {
      name: $('#instanceName').value.trim(),
      versionId: $('#instanceGameVersion').value,
      loader,
      loaderVersion: loader === 'vanilla' ? '' : $('#instanceLoaderVersion').value
    };
    button.disabled = true;
    button.textContent = loader === 'vanilla' ? 'Создаём…' : 'Устанавливаем…';
    try {
      const result = await state.bridge.createInstance(options);
      state.instances = result.instances || [];
      state.activeInstance = result.instance;
      state.settings = result.settings;
      state.paths = result.paths || state.paths;
      state.selected = result.instance.versionId;
      state.loaderCategory = result.instance.loader;
      closeInstanceModal();
      renderVersions();
      updateProfile();
      updatePathsUI();
      setLoaderCategory(result.instance.loader);
      setView('versions');
      openInstanceConfig(result.instance);
      toast('Сборка создана', `${result.instance.name} · Minecraft ${result.instance.versionId}`, 'success');
    } catch (error) {
      showError('Не удалось создать сборку', cleanError(error));
    } finally {
      button.disabled = false;
      button.textContent = 'Создать сборку';
    }
  }

  /* ─────────────────────────── профиль и настройки ─────────────────────────── */

  function setAvatar(element, nickname, size) {
    if (!element) return;
    if (state.skin?.dataUrl) {
      element.classList.add('avatar--skin');
      element.innerHTML = '<span class="skin-face"></span>';
      const face = $('.skin-face', element);
      const textureHeight = state.skin.height === 32 ? 4 : 8;
      const layerSize = `${size * 8}px ${size * textureHeight}px`;
      face.style.backgroundImage = textureHeight === 8
        ? `url("${state.skin.dataUrl}"), url("${state.skin.dataUrl}")`
        : `url("${state.skin.dataUrl}")`;
      face.style.backgroundSize = textureHeight === 8 ? `${layerSize}, ${layerSize}` : layerSize;
      const pixelScale = size / 8;
      face.style.backgroundPosition = textureHeight === 8
        ? `-${8 * pixelScale}px -${8 * pixelScale}px, -${8 * pixelScale}px -${8 * pixelScale}px`
        : `-${8 * pixelScale}px -${8 * pixelScale}px`;
      face.style.backgroundRepeat = textureHeight === 8 ? 'no-repeat, no-repeat' : 'no-repeat';
      return;
    }
    element.classList.remove('avatar--skin');
    element.innerHTML = art.avatar(nickname, size);
  }

  function openAccounts() {
    if (state.bridge.openAccounts) state.bridge.openAccounts();
  }

  function updateProfile() {
    const nick = state.settings?.nickname || 'Steve';
    $('#accountName').textContent = nick;
    $('#sideName').textContent = nick;
    $('#settingsAccountName').textContent = nick;
    $('#memCardValue').textContent = formatMemory(state.settings?.memory || 4096);
    setAvatar($('#accountAvatar'), nick, 28);
    setAvatar($('#sideAvatar'), nick, 48);
    setAvatar($('#settingsAccountAvatar'), nick, 40);
    renderHero();
  }

  function syncSettingsForm() {
    if (!state.settings) return;
    $('#javaInput').value = state.settings.javaPath || '';
    $('#gameDirInput').value = state.settings.gameDir || '';
    setMemory(state.settings.memory, { persist: false });
    toggleSwitch($('#closeOnLaunch'), Boolean(state.settings.closeOnLaunch));
    toggleSwitch($('#showConsole'), state.settings.showConsole !== false);
    updateJavaUI();
    updatePathsUI();
  }

  function setLoaderCategory(loader) {
    state.loaderCategory = loader;
    const select = $('#curseforgeLoader');
    select.value = LOADER_TYPES[loader] ? String(LOADER_TYPES[loader]) : '';
    renderHero();
  }

  function syncCurseForgeFilters({ keepVersion = false } = {}) {
    const versionInput = $('#curseforgeVersion');
    if (versionInput && !keepVersion) versionInput.value = state.activeInstance?.versionId || '';
    const loaderSelect = $('#curseforgeLoader');
    if (loaderSelect) {
      loaderSelect.value = LOADER_TYPES[state.activeInstance?.loader]
        ? String(LOADER_TYPES[state.activeInstance.loader])
        : '';
    }
    const locked = Boolean(state.activeInstance && ['forge', 'fabric', 'quilt', 'neoforge'].includes(state.activeInstance.loader));
    if (state.curseforgeContext === 'packs') $('#curseforgeClass').value = '4471';
    else if (state.activeInstance && locked) $('#curseforgeClass').value = '6';
    if (versionInput) versionInput.disabled = locked || state.curseforgeContext === 'packs';
    if (loaderSelect) loaderSelect.disabled = locked || state.curseforgeContext === 'packs';
    const categorySelect = $('#curseforgeClass');
    if (categorySelect) categorySelect.disabled = locked || state.curseforgeContext === 'packs';
  }

  function setMemory(value, { persist: shouldPersist = true } = {}) {
    if (!state.settings) return;
    const max = Number($('#memRange').max) || 16384;
    const min = Number($('#memRange').min) || 1024;
    const memory = Math.min(max, Math.max(min, Number(value) || 4096));
    const percent = ((memory - min) / (max - min)) * 100;

    for (const id of ['#memRange', '#settingsMemory']) {
      const range = $(id);
      if (!range) continue;
      range.value = String(memory);
      range.style.setProperty('--fill', `${Math.min(100, Math.max(0, percent))}%`);
    }

    state.settings.memory = memory;
    const text = formatMemory(memory);
    $('#memCardValue').textContent = text;
    $('#settingsMemoryValue').textContent = text;
    $('#memBadge').textContent = text;
    $('#statMemory').textContent = text;

    const hint =
      memory >= 10240
        ? 'Много памяти: подходит для тяжёлых сборок с модами.'
        : memory < 2560
          ? 'Мало памяти: игра может подтормаживать. Рекомендуем хотя бы 4 ГБ.'
          : 'Рекомендуем 4–8 ГБ для комфортной игры.';
    $('#memCardHint').textContent = hint;
    $('#settingsMemoryHint').textContent = hint;

    if (shouldPersist) scheduleMemorySave();
  }

  let memoryTimer = null;
  function scheduleMemorySave() {
    clearTimeout(memoryTimer);
    memoryTimer = setTimeout(() => {
      persist({ memory: state.settings.memory }).catch(() => {});
    }, 450);
  }

  function updateJavaUI() {
    const java = state.java;
    $('#javaBadge').textContent = java?.major ? `Java ${java.major}` : 'Java —';
    $('#javaVersionText').textContent = java?.major ? `Java ${java.major}` : 'Java не найдена';
    $('#javaPathText').textContent = java?.path || 'Укажите путь вручную';
    $('#javaPathText').title = java?.path || '';
    const badge = $('#javaState');
    badge.textContent = java?.major ? (java.compatible === false ? 'старая' : 'готова') : 'нет';
    badge.classList.toggle('state--accent', Boolean(java?.major) && java.compatible !== false);
  }

  function updatePathsUI() {
    const gamePath = state.paths?.game || '';
    $('#gameDirPath').textContent = gamePath || 'По умолчанию';
    $('#gameDirPath').title = gamePath;
    $('#gameDirText').textContent = state.activeInstance ? 'Папка сборки' : 'Папка игры';
  }

  function toggleSwitch(element, enabled) {
    if (!element) return;
    element.classList.toggle('is-on', enabled);
    element.setAttribute('aria-checked', String(enabled));
  }

  async function persist(patch) {
    try {
      const result = await state.bridge.saveSettings(patch);
      state.settings = result.settings;
      if (state.activeInstance) {
        state.activeInstance = {
          ...state.activeInstance,
          versionId: result.settings.versionId,
          loader: result.settings.loader,
          loaderVersion: result.settings.loaderVersion,
          gameDir: result.settings.gameDir,
          memory: result.settings.memory
        };
        state.instances = state.instances.map((instance) =>
          instance.id === state.activeInstance.id ? { ...state.activeInstance } : instance
        );
      }
      if (result.paths) state.paths = { ...state.paths, ...result.paths };
      updateProfile();
      updatePathsUI();
      return result;
    } catch (error) {
      showError('Не удалось сохранить настройки', cleanError(error));
      throw error;
    }
  }

  async function loadMods() {
    if (!state.bridge.modsList) return;
    try {
      state.mods = await state.bridge.modsList();
      renderMods();
    } catch (error) {
      showError('Не удалось прочитать папку модов', cleanError(error));
    }
  }

  async function searchCurseForge() {
    const isPackBrowser = state.curseforgeContext === 'packs';
    const activeModLoader = Boolean(state.activeInstance && ['forge', 'fabric', 'quilt', 'neoforge'].includes(state.activeInstance.loader));
    if (isPackBrowser) {
      $('#curseforgeClass').value = '4471';
      $('#curseforgeClass').disabled = true;
      $('#curseforgeVersion').disabled = true;
      $('#curseforgeLoader').disabled = true;
    } else if (activeModLoader) {
      $('#curseforgeClass').value = '6';
      $('#curseforgeClass').disabled = true;
      $('#curseforgeVersion').value = state.activeInstance.versionId;
      $('#curseforgeVersion').disabled = true;
      $('#curseforgeLoader').value = String(LOADER_TYPES[state.activeInstance.loader] || '');
      $('#curseforgeLoader').disabled = true;
    } else {
      $('#curseforgeClass').disabled = false;
      $('#curseforgeVersion').disabled = false;
      $('#curseforgeLoader').disabled = false;
    }
    const container = $('#curseforgeResults');
    const button = $('#searchCurseForge');
    const requestId = ++state.modSearchRequestId;
    const classId = state.curseforgeContext === 'packs' ? 4471 : Number($('#curseforgeClass').value);
    if (classId !== Number($('#curseforgeClass').value)) $('#curseforgeClass').value = String(classId);
    const isModpack = classId === 4471;
    const modLoaderType = $('#curseforgeLoader').value;
    const gameVersion = isModpack ? '' : $('#curseforgeVersion').value.trim();
    button.disabled = true;
    container.innerHTML = `<div class="mods-empty">Ищем ${isModpack ? 'готовые сборки' : 'моды'} на CurseForge…</div>`;
    try {
      const results = await state.bridge.curseForgeSearch({
        query: $('#curseforgeSearch').value,
        classId,
        gameVersion,
        modLoaderType: !isModpack && modLoaderType ? Number(modLoaderType) : undefined,
        sortField: Number($('#curseforgeSort').value.split(':')[0]),
        sortOrder: $('#curseforgeSort').value.split(':')[1],
        index: state.modIndex,
        pageSize: 24
      });
      if (requestId !== state.modSearchRequestId) return;
      const entries = results.data || [];
      const totalCount = Number(results.pagination?.totalCount) || 0;
      container.innerHTML = entries.length
        ? `${entries.map((mod) => {
            const logo = mod.logo?.thumbnailUrl || mod.logo?.url || '';
            const initials = String(mod.name || '?').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?';
            return `
            <article class="catalog-result">
              <span class="mod-icon mod-icon--logo">
                <span>${esc(initials)}</span>
                ${logo ? `<img src="${esc(logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''}
              </span>
              <div class="mod-info"><strong>${esc(mod.name)}</strong><span>${esc(mod.summary || '')}</span></div>
              <span class="catalog-downloads">${Number(mod.downloadCount || 0).toLocaleString('ru-RU')} загрузок</span>
              <button class="btn btn--soft btn--sm" data-cf-files="${esc(mod.id)}" data-cf-class="${classId}" data-cf-name="${esc(mod.name || '')}">Выбрать файл</button>
              <div class="catalog-files" data-cf-file-list="${esc(mod.id)}" hidden></div>
            </article>`;
          }).join('')}
            <div class="catalog-pagination">
              <button class="btn btn--soft btn--sm" data-cf-page="prev" ${state.modIndex <= 0 ? 'disabled' : ''}>Назад</button>
              <span>${state.modIndex + 1}–${state.modIndex + entries.length}${totalCount ? ` из ${totalCount}` : ''}</span>
              <button class="btn btn--soft btn--sm" data-cf-page="next" ${entries.length < 24 || (totalCount && state.modIndex + entries.length >= totalCount) ? 'disabled' : ''}>Далее</button>
            </div>`
        : `<div class="mods-empty">Ничего не найдено в категории «${isModpack ? 'Готовые сборки' : 'Моды'}»${gameVersion ? ` для Minecraft ${esc(gameVersion)}` : ''}.</div>`;
    } catch (error) {
      if (requestId !== state.modSearchRequestId) return;
      container.innerHTML = `<div class="mods-empty">${esc(cleanError(error))}</div>`;
    } finally {
      if (requestId === state.modSearchRequestId) button.disabled = false;
    }
  }

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} Б`;
    const units = ['КБ', 'МБ', 'ГБ'];
    let size = bytes / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${size.toFixed(1)} ${units[unit]}`;
  }

  async function loadCurseForgeFiles(button) {
    const modId = button.dataset.cfFiles;
    const classId = Number(button.dataset.cfClass);
    const packName = button.dataset.cfName || '';
    const panel = $(`[data-cf-file-list="${modId}"]`);
    if (!panel) return;
    panel.hidden = false;
    panel.innerHTML = '<div class="mods-empty">Загружаем файлы…</div>';
    button.disabled = true;
    try {
      const isModpack = classId === 4471;
      const searchVersion = $('#curseforgeVersion').value.trim();
      const loaderValue = $('#curseforgeLoader').value;
      const files = await state.bridge.curseForgeFiles(modId, {
        gameVersion: isModpack ? undefined : searchVersion,
        modLoaderType: !isModpack && loaderValue ? Number(loaderValue) : undefined,
        pageSize: 50
      });
      const instance = state.activeInstance;
      const instanceLoaderType = LOADER_TYPES[instance?.loader] || 0;
      const versionMatches = !searchVersion || !instance || searchVersion === instance.versionId;
      const loaderMatches = !loaderValue || Number(loaderValue) === instanceLoaderType;
      const canInstallMod = Boolean(instance && instanceLoaderType && versionMatches && loaderMatches);
      const unavailableReason = !instance
        ? 'Сначала создайте сборку модов.'
        : !instanceLoaderType
          ? 'Для модов нужна сборка с Forge, Fabric, Quilt или NeoForge.'
          : !versionMatches
            ? `Версия поиска не совпадает с версией сборки (${instance.versionId}).`
            : !loaderMatches
              ? 'Фильтр загрузчика не совпадает с загрузчиком сборки.'
              : '';
      panel.innerHTML = files.data?.length
        ? files.data.map((file) => {
          const versions = (file.gameVersions || []).join(' · ');
          return `
            <div class="catalog-file-row">
              <div class="catalog-file-info">
                <strong>${esc(file.displayName || file.fileName || `Файл ${file.id}`)}</strong>
                <span>${esc(versions || 'Версия игры не указана')} · ${esc(formatDate(file.fileDate))}${file.fileLength ? ` · ${esc(formatBytes(file.fileLength))}` : ''}</span>
              </div>
              ${isModpack
                ? `<button class="btn btn--play btn--sm" data-cf-install="${esc(file.id)}" data-cf-install-class="4471" data-cf-pack-name="${esc(packName)}">Скачать сборку</button>`
                : canInstallMod
                  ? `<button class="btn btn--play btn--sm" data-cf-install="${esc(file.id)}" data-cf-install-class="6">Установить</button>`
                  : `<span class="catalog-not-supported">${esc(unavailableReason)}</span>`}
            </div>`;
        }).join('')
        : '<div class="mods-empty">Файлы для этой версии не найдены.</div>';
    } catch (error) {
      panel.innerHTML = `<div class="mods-empty">${esc(cleanError(error))}</div>`;
    } finally {
      button.disabled = false;
    }
  }

  function setModDownloadProgress(payload) {
    const progress = $('#modDownloadProgress');
    progress.hidden = false;
    const percent = Number.isFinite(payload.percent) ? payload.percent : null;
    const filePercent = percent === null ? 0 : percent;
    const calculatedOverall = state.modDownloadIsPack && payload.totalFiles
      ? Math.max(state.modDownloadOverallPercent, ((Number(payload.completedFiles) || 0) + filePercent / 100) / Number(payload.totalFiles) * 100)
      : percent;
    const overallPercent = Number.isFinite(payload.overallPercent) ? payload.overallPercent : calculatedOverall;
    if (Number.isFinite(overallPercent)) state.modDownloadOverallPercent = overallPercent;
    progress.classList.toggle('is-indeterminate', overallPercent === null);
    $('#modDownloadPercent').textContent = overallPercent === null ? '—' : `${Math.round(overallPercent)}%`;
    $('#modDownloadFill').style.width = `${overallPercent === null ? 0 : overallPercent}%`;
    const label = payload.message || (state.modDownloadIsPack
      ? payload.phase === 'pack-download'
        ? 'Скачиваем архив сборки…'
        : payload.phase === 'mod-download'
          ? 'Скачиваем файлы сборки…'
          : payload.phase === 'file-complete'
            ? 'Файлы сборки загружены'
            : 'Подготавливаем сборку…'
      : payload.phase === 'file-complete'
        ? `Готово: ${payload.fileName || 'файл'}`
        : payload.fileName
          ? `Скачиваем ${payload.fileName}`
          : 'Подготавливаем установку…');
    $('#modDownloadLabel').textContent = label;
    const bytes = payload.totalBytes
      ? `${formatBytes(payload.bytesReceived)} / ${formatBytes(payload.totalBytes)}`
      : payload.bytesReceived
        ? `${formatBytes(payload.bytesReceived)} загружено`
        : '';
    const count = payload.totalFiles
      ? ` · файлов ${payload.completedFiles || 0}/${payload.totalFiles}`
      : '';
    $('#modDownloadDetail').textContent = state.modDownloadIsPack ? '' : `${bytes}${count}`;
    if (state.modDownloadIsPack) $('#modDownloadFiles').hidden = true;
  }

  function handleModsProgress(payload) {
    if (!payload || payload.operationId !== state.modOperationId) return;
    setModDownloadProgress(payload);
  }

  async function checkForNotifications() {
    const button = $('#checkUpdates');
    if (!state.bridge.checkForUpdates) {
      toast('Проверка недоступна', 'Не удалось подключиться к службе обновлений.', 'warn');
      return;
    }
    button.disabled = true;
    button.textContent = 'Проверяем…';
    try {
      const result = await state.bridge.checkForUpdates();
      if (result?.ok === false) {
        const reason = result.reason === 'dev' ? 'Проверка доступна в установленной версии лаунчера.' : result.error;
        throw new Error(reason || 'Не удалось проверить уведомления.');
      }
      toast('Проверка начата', 'Ищем новые версии и уведомления.', 'success');
    } catch (error) {
      toast('Не удалось проверить уведомления', cleanError(error), 'warn');
    } finally {
      button.disabled = false;
      button.textContent = 'Проверить уведомления';
    }
  }

  function handleUpdateEvent(event) {
    if (!event) return;
    const modal = $('#updateModal');
    const message = $('#updateMessage');
    const action = $('#updateAction');
    if (event.type === 'available') {
      const checkButton = $('#checkUpdates');
      checkButton.disabled = false;
      checkButton.textContent = 'Проверить уведомления';
      state.updateVersion = event.version || '';
      message.textContent = `Доступна версия ${state.updateVersion}. Скачать и установить её?`;
      action.textContent = 'Скачать обновление';
      action.disabled = false;
      modal.hidden = false;
    } else if (event.type === 'checking') {
      const button = $('#checkUpdates');
      button.disabled = true;
      button.textContent = 'Проверяем…';
    } else if (event.type === 'not-available') {
      toast('Уведомлений нет', 'Новых версий лаунчера пока нет.', 'success');
      const button = $('#checkUpdates');
      button.disabled = false;
      button.textContent = 'Проверить уведомления';
    } else if (event.type === 'progress') {
      message.textContent = `Загружаем обновление: ${event.percent}%`;
      action.disabled = true;
    } else if (event.type === 'downloaded') {
      const checkButton = $('#checkUpdates');
      checkButton.disabled = false;
      checkButton.textContent = 'Проверить уведомления';
      message.textContent = `Версия ${event.version || state.updateVersion} загружена и готова к установке.`;
      action.textContent = 'Перезапустить и установить';
      action.disabled = false;
      modal.hidden = false;
    } else if (event.type === 'error') {
      const checkButton = $('#checkUpdates');
      checkButton.disabled = false;
      checkButton.textContent = 'Проверить уведомления';
      toast('Проверка уведомлений не удалась', event.message || 'Проверьте подключение к интернету.', 'warn');
    }
  }

  async function handleUpdateAction() {
    const action = $('#updateAction');
    action.disabled = true;
    try {
      if (action.textContent.includes('Перезапустить')) {
        await state.bridge.installUpdate();
        return;
      }
      const result = await state.bridge.downloadUpdate();
      if (!result?.ok) throw new Error(result?.error || 'Не удалось скачать обновление.');
      $('#updateMessage').textContent = 'Начинаем загрузку обновления…';
    } catch (error) {
      action.disabled = false;
      showError('Не удалось установить обновление', cleanError(error));
    }
  }

  async function installCurseForgeFile(button) {
    if (state.modOperationId) {
      toast('Загрузка уже выполняется', 'Дождитесь её завершения или отмените текущую.', 'warn');
      return;
    }
    const instance = state.activeInstance;
    const fileId = button.dataset.cfInstall;
    const classId = Number(button.dataset.cfInstallClass);
    const isModpack = classId === 4471;
    if (!isModpack && !instance) {
      toast('Сначала создайте сборку', 'Моды устанавливаются в папку mods выбранной сборки.', 'warn');
      return;
    }
    const operationId = `mod-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    state.modOperationId = operationId;
    state.modDownloadIsPack = isModpack;
    state.manualInstanceId = '';
    state.modDownloadOverallPercent = 0;
    $('#modDownloadProgress').hidden = false;
    $('#modDownloadLabel').textContent = isModpack ? 'Скачиваем готовую сборку…' : 'Подготавливаем мод…';
    $('#modDownloadPercent').textContent = '0%';
    $('#modDownloadProgress').classList.remove('is-indeterminate');
    $('#modDownloadFill').style.width = '0%';
    $('#modDownloadDetail').textContent = '';
    $('#modDownloadFiles').hidden = isModpack;
    $('#modDownloadFiles').replaceChildren();
    $('#cancelModDownload').disabled = false;
    button.disabled = true;
    try {
      const result = await state.bridge.installCurseForgeFile(fileId, {
        classId,
        operationId,
        gameVersion: isModpack ? '' : instance.versionId,
        modLoaderType: isModpack ? '' : String(LOADER_TYPES[instance.loader] || ''),
        packName: button.dataset.cfPackName || ''
      });
      if (result?.cancelled) {
        toast('Загрузка отменена', 'Временные файлы удалены.', 'warn');
        setModDownloadProgress({ phase: 'cancelled', message: 'Загрузка отменена', percent: null });
        return;
      }
      if (result.instance) {
        state.manualInstanceId = result.instance.id || '';
        state.activeInstance = result.instance;
        state.instances = result.instances || state.instances;
        state.settings = result.settings || state.settings;
        state.selected = result.instance.versionId;
        setLoaderCategory(result.instance.loader);
        syncCurseForgeFilters();
        updateProfile();
        updatePathsUI();
        renderVersions();
        renderInstanceList();
        renderHomeInstances();
        $('#modsInstanceLabel').textContent =
          `${result.instance.name} · Minecraft ${result.instance.versionId} · ${LOADER_NAMES[result.instance.loader] || result.instance.loader}`;
      }
      await loadMods();
      const blockingEntries = result.blocked || [];
      const blockedCount = blockingEntries.length;
      const packSaved = isModpack && Boolean(result.instance);
      if (blockedCount) {
        toast(
          isModpack ? 'Сборка скачана не полностью' : 'Мод установлен не полностью',
          `Загружено файлов: ${result.installed}. Для ${blockedCount} файла(ов) открыта страница CurseForge.`,
          'warn'
        );
      } else if (packSaved) {
        toast(
          'Сборка скачана',
          `${result.instance.name} · Minecraft ${result.instance.versionId} · файлов: ${result.installed}`,
          'success',
          4800
        );
      } else {
        toast('Мод установлен', `Загружено файлов: ${result.installed}`, 'success');
      }
      if (packSaved) {
        closeInstanceModal();
        setView('versions');
      }
      if (blockingEntries.length) {
        mergeManualDownloads(blockingEntries);
        openManualDownloads();
      }
      setModDownloadProgress({ phase: 'file-complete', percent: 100, overallPercent: 100, fileName: 'Установка завершена' });
    } catch (error) {
      const message = cleanError(error);
      state.modDownloadIsPack = false;
      if (/отменена|cancelled|aborted/i.test(message)) {
        toast('Загрузка отменена', 'Временные файлы удалены.', 'warn');
      } else {
        showError(isModpack ? 'Не удалось скачать сборку' : 'Не удалось установить мод', message);
      }
      $('#modDownloadLabel').textContent = message;
      $('#modDownloadPercent').textContent = '—';
      $('#modDownloadFill').style.width = '0%';
      $('#modDownloadProgress').classList.remove('is-indeterminate');
    } finally {
      state.modOperationId = '';
      state.modDownloadIsPack = false;
      $('#cancelModDownload').disabled = true;
      button.disabled = false;
    }
  }

  function renderManualDownloads() {
    const panel = $('#manualDownloads');
    const list = $('#manualDownloadList');
    const entries = state.manualDownloads || [];
    panel.hidden = !entries.length;
    list.innerHTML = entries.map((item) => {
      const status = state.manualStatus[item.fileName];
      const text = status?.present ? 'Файл найден, импортируем…' : 'Положите файл в папку «Загрузки». Лаунчер проверит его и продолжит установку.';
      return `<div class="manual-download-row ${status?.present ? 'is-ready' : ''}">
        <div class="mod-info"><strong>${esc(item.fileName)}</strong><span>${text}</span></div>
        <button class="btn btn--soft btn--sm" data-manual-url="${esc(item.pageUrl || '')}">Открыть источник</button>
      </div>`;
    }).join('');
  }

  function mergeManualDownloads(entries) {
    const list = state.manualDownloads || (state.manualDownloads = []);
    for (const item of entries || []) {
      if (item?.fileName && !list.some((entry) => entry.fileName === item.fileName)) list.push(item);
    }
    renderManualDownloads();
  }

  function openManualDownloads() {
    if (!state.manualDownloads.length) return;
    $('#manualDownloadsModal').hidden = false;
    renderManualDownloads();
    if (!state.manualPollTimer) state.manualPollTimer = setInterval(checkManualDownloads, 1500);
    checkManualDownloads();
  }

  function closeManualDownloads() {
    $('#manualDownloadsModal').hidden = true;
    if (state.manualPollTimer) clearInterval(state.manualPollTimer);
    state.manualPollTimer = null;
  }

  async function checkManualDownloads() {
    if (!state.manualDownloads.length || state.modOperationId) return;
    try {
      const checks = state.manualDownloads.map((item) => ({ ...item, instanceId: state.manualInstanceId }));
      const result = await state.bridge.checkManualDownloads(checks);
      const ready = (result || []).filter((item) => item.ready);
      state.manualStatus = Object.fromEntries((result || []).map((item) => [item.fileName, { present: item.ready }]));
      renderManualDownloads();
      if (!ready.length) return;
      const entries = ready.map((item) => ({ ...item, instanceId: state.manualInstanceId }));
      const imported = await state.bridge.importManualDownloads(entries);
      const importedNames = new Set((imported?.imported || []).map((item) => item.fileName));
      state.manualDownloads = state.manualDownloads.filter((item) => !importedNames.has(item.fileName));
      renderManualDownloads();
      if (!state.manualDownloads.length) {
        closeManualDownloads();
        await loadMods();
        toast('Ручные файлы импортированы', 'Недостающие файлы добавлены в сборку.', 'success');
      }
    } catch (error) {
      showError('Не удалось проверить ручные загрузки', cleanError(error));
    }
  }

  async function cancelManualDownloads() {
    const instanceId = state.manualInstanceId;
    const button = $('#cancelManualDownloads');
    button.disabled = true;
    try {
      if (instanceId && state.bridge.deleteInstance) {
        const result = await state.bridge.deleteInstance(instanceId);
        state.instances = result.instances || [];
        state.activeInstance = result.instance || null;
        state.settings = result.settings || state.settings;
        renderVersions();
        renderPlay();
        updatePathsUI();
      }
      state.manualDownloads = [];
      state.manualStatus = {};
      state.manualInstanceId = '';
      renderManualDownloads();
      closeManualDownloads();
      toast('Загрузка отменена', instanceId ? 'Недоделанная сборка удалена.' : 'Недостающие файлы не добавлены.', 'warn');
    } catch (error) {
      showError('Не удалось отменить загрузку', cleanError(error));
    } finally {
      button.disabled = false;
    }
  }

  function renderMods() {
    $('#modsCount').textContent = String(state.mods.length);
    $('#modsList').innerHTML = state.mods.length
      ? state.mods.map((mod) => {
          const initials = String(mod.name || '?').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || 'M';
          return `
          <div class="mod-row">
            <span class="mod-icon mod-icon--logo">
              <span>${esc(initials)}</span>
              ${mod.icon ? `<img src="${mod.icon}" alt="" loading="lazy" />` : ''}
            </span>
            <div class="mod-info">
              <strong>${esc(mod.name)}</strong>
              <span>${mod.size ? `${formatBytes(mod.size)} · ` : ''}JAR-файл в папке mods</span>
            </div>
            <button class="btn btn--ghost btn--sm" data-remove-mod="${esc(mod.name)}">Удалить</button>
          </div>`;
        }).join('')
      : '<div class="mods-empty">Папка модов пока пуста</div>';
  }

  async function saveSettings() {
    if (!state.settings) return;
    const button = $('#saveSettings');
    button.disabled = true;

    try {
      const result = await persist({
        memory: Number($('#settingsMemory').value),
        javaPath: $('#javaInput').value.trim(),
        gameDir: $('#gameDirInput').value.trim(),
        closeOnLaunch: $('#closeOnLaunch').classList.contains('is-on'),
        showConsole: $('#showConsole').classList.contains('is-on')
      });
      setMemory(result.settings.memory, { persist: false });
      updateProfile();
      syncSettingsForm();
      const saved = $('#settingsSaved');
      saved.hidden = false;
      clearTimeout(saved._timer);
      saved._timer = setTimeout(() => (saved.hidden = true), 2400);
      toast('Настройки сохранены', formatMemory(result.settings.memory), 'success', 2600);
    } catch {
      /* уже показали ошибку */
    } finally {
      button.disabled = false;
    }
  }

  async function checkJava(pathValue) {
    const hint = $('#javaHint');
    hint.textContent = 'Проверяем Java…';
    hint.style.color = '';
    try {
      const result = await state.bridge.probeJava(pathValue);
      if (result?.ok) {
        state.java = result;
        updateJavaUI();
        hint.textContent = `Найдена Java ${result.major} (${result.version}).`;
        hint.style.color = 'var(--accent)';
        toast('Java найдена', `${result.version} · ${result.path}`, 'success', 3200);
      } else {
        hint.textContent = result?.message || 'Java не найдена по этому пути.';
        hint.style.color = 'var(--danger)';
        toast('Java не найдена', 'Укажите путь к java.exe или установите Java.', 'error');
      }
    } catch (error) {
      hint.textContent = cleanError(error);
      hint.style.color = 'var(--danger)';
    }
  }

  /* ─────────────────────────── запуск игры ─────────────────────────── */

  async function play() {
    if (state.busy) return;
    if (state.running) return stopGame();
    if (!state.activeInstance) {
      toast('Сначала создай сборку', 'Выбери имя, версию Minecraft и загрузчик.', 'warn');
      setView('versions');
      openInstanceModal();
      return;
    }
    state.selected = state.activeInstance.versionId;

    state.busy = true;
    state.progressPercent = 0;
    renderPlay();
    showProgress({ message: 'Подготовка к запуску', percent: 0, detail: state.selected });
    setStatus('busy', `Подготовка ${state.selected}…`);

    if (state.settings?.showConsole !== false) openConsole(true);
    appendLog({ stream: 'out', line: `Подготовка Minecraft ${state.selected}` });

    try {
      const result = await state.bridge.launch(state.selected);
      if (!result?.ok) throw new Error(result?.error || 'Не удалось начать запуск');
    } catch (error) {
      failLaunch(cleanError(error));
    }
  }

  async function stopGame() {
    try {
      await state.bridge.stop();
      state.busy = false;
      state.running = false;
      renderPlay();
      setStatus('busy', 'Останавливаем игру…');
      appendLog({ stream: 'warn', line: 'Запрошена остановка игры' });
      toast('Останавливаем…', 'Завершаем процесс Minecraft.', 'warn', 2600);
    } catch (error) {
      showError('Не удалось остановить игру', cleanError(error));
    }
  }

  function handleLaunchEvent(event) {
    if (!event) return;

    if (event.type === 'log') {
      appendLog(event);
      return;
    }

    if (event.type === 'error') {
      failLaunch(event.message, event.hint);
      return;
    }

    if (event.type === 'exit') {
      state.busy = false;
      state.running = false;
      state.progressPercent = 0;
      renderPlay();
      hideProgress(1200);
      setStatus(event.code === 0 ? 'idle' : 'error', event.message || 'Игра закрыта');
      appendLog({
        stream: event.code === 0 ? 'ok' : 'error',
        line: event.message || `Игра завершилась с кодом ${event.code}`
      });
      if (event.code === 0) toast('Игра закрыта', 'До встречи в следующем запуске!', 'success', 3600);
      else toast('Игра завершилась', event.message || `код ${event.code}`, 'warn', 5000);
      return;
    }

    if (event.type !== 'state') return;

    if (event.phase === 'running') {
      state.busy = false;
      state.running = true;
      state.progressPercent = 100;
      renderPlay();
      updateProgress({ message: 'Minecraft запущен', percent: 100, detail: event.detail || '' });
      setTimeout(() => hideProgress(400), 1200);
      setStatus('idle', 'Minecraft запущен');
      if (state.settings?.showConsole === false) closeConsole();
      toast('Minecraft запущен', `${state.selected} · хорошей игры!`, 'success', 3600);
      return;
    }

    if (event.phase === 'idle') {
      state.busy = false;
      state.running = false;
      renderPlay();
      hideProgress(300);
      setStatus('idle', event.message || 'Готов к запуску');
      return;
    }

    if (event.phase === 'error') {
      failLaunch(event.message, event.hint);
      return;
    }

    state.busy = true;
    state.progressPercent = Number(event.percent) || 0;
    renderPlay();
    updateProgress({
      message: event.message || 'Загрузка…',
      percent: state.progressPercent,
      detail: event.detail || ''
    });
    setStatus('busy', event.message || 'Загрузка…');
  }

  function failLaunch(message, hint) {
    state.busy = false;
    state.running = false;
    state.progressPercent = 0;
    renderPlay();
    hideProgress(0);
    setStatus('error', message || 'Ошибка запуска');
    appendLog({ stream: 'error', line: [message, hint].filter(Boolean).join(' — ') });
    openConsole();
    showError('Не удалось запустить игру', [message, hint].filter(Boolean).join(' '));
  }

  function renderPlay() {
    const button = $('#playBtn');
    const stop = $('#stopBtn');
    const label = $('#playLabel');
    const icon = $('#playIcon');

    const active = state.running || state.busy;
    button.hidden = active;
    stop.hidden = !active;
    $('#stopLabel').textContent = state.running ? 'Остановить' : 'Отменить';
    button.disabled = state.busy;
    button.classList.toggle('is-busy', state.busy);
    icon.innerHTML = state.busy ? ICONS.spinner : ICONS.play;
    label.textContent = !state.activeInstance
      ? 'Создать сборку'
      : state.busy
      ? state.progressPercent > 0
        ? `Загрузка ${state.progressPercent}%`
        : 'Подготовка…'
      : 'Играть';
  }

  function showProgress({ message, percent = 0, detail = '' }) {
    $('#launchProgress').hidden = false;
    updateProgress({ message, percent, detail });
  }

  function updateProgress({ message, percent = 0, detail = '' }) {
    $('#progressMsg').textContent = message || '';
    $('#progressPct').textContent = `${Math.round(percent)}%`;
    $('#progressFill').style.width = `${Math.min(100, Math.max(0, percent))}%`;
    $('#progressDetail').textContent = detail || '';
  }

  function hideProgress(delay = 0) {
    clearTimeout(hideProgress._timer);
    hideProgress._timer = setTimeout(() => {
      $('#launchProgress').hidden = true;
      $('#progressFill').style.width = '0%';
    }, delay);
  }

  /* ─────────────────────────── журнал ─────────────────────────── */

  function appendLog({ stream = 'out', line = '' } = {}) {
    if (!line) return;
    state.logs.push({ stream, line });
    if (state.logs.length > 1200) state.logs.shift();

    const body = $('#consoleBody');
    const element = document.createElement('span');
    element.className = `log-line ${stream === 'error' ? 'is-error' : stream === 'warn' ? 'is-warn' : stream === 'ok' ? 'is-ok' : ''}`;
    const time = new Date().toLocaleTimeString('ru-RU', { hour12: false });
    element.innerHTML = `<span class="log-time">${time}</span>  ${esc(line)}`;
    body.appendChild(element);

    while (body.childElementCount > 700) body.removeChild(body.firstElementChild);

    const pinned = body.scrollTop + body.clientHeight >= body.scrollHeight - 40;
    if (pinned || !$('#console').classList.contains('is-open')) {
      body.scrollTop = body.scrollHeight;
    }
  }

  function openConsole(expand = false) {
    if (expand) $('#console').style.height = '';
    $('#console').classList.add('is-open');
    $('#console').setAttribute('aria-hidden', 'false');
    $('#consoleToggle').classList.add('is-active');
    const body = $('#consoleBody');
    body.scrollTop = body.scrollHeight;
  }

  function closeConsole() {
    $('#console').classList.remove('is-open');
    $('#console').setAttribute('aria-hidden', 'true');
    $('#consoleToggle').classList.remove('is-active');
  }

  function toggleConsole() {
    if ($('#console').classList.contains('is-open')) closeConsole();
    else openConsole();
  }

  /* ─────────────────────────── уведомления и статус ─────────────────────────── */

  function toast(title, message = '', kind = 'success', ttl = 4200) {
    const container = $('#toasts');
    const element = document.createElement('div');
    element.className = `toast is-${kind}`;
    element.innerHTML = `<span class="toast-dot"></span><div><strong>${esc(title)}</strong>${message ? esc(message) : ''}</div>`;
    container.appendChild(element);

    while (container.childElementCount > 3) container.removeChild(container.firstElementChild);

    setTimeout(() => {
      element.classList.add('is-out');
      setTimeout(() => element.remove(), 260);
    }, ttl);
  }

  function showError(title, message) {
    toast(title, message, 'error', 6500);
  }

  function setStatus(kind, message) {
    const dot = $('#statusDot');
    dot.classList.toggle('is-busy', kind === 'busy');
    dot.classList.toggle('is-error', kind === 'error');
    $('#statusText').textContent = message;
    $('#statusText').title = message;
  }

  /* ─────────────────────────── навигация ─────────────────────────── */

  function setView(view) {
    state.view = view;
    $$('.nav-item').forEach((item) => item.classList.toggle('is-active', item.dataset.view === view));
    $$('[data-view-panel]').forEach((panel) => panel.classList.toggle('is-active', panel.dataset.viewPanel === view));
    $('#mainCol').scrollTop = 0;

    if (view === 'settings') syncSettingsForm();
    if (view === 'versions') renderInstanceList();
    if (view === 'mods') {
      const instance = state.activeInstance;
      $('#modsInstanceLabel').textContent = instance
        ? `${instance.name} · Minecraft ${instance.versionId} · ${LOADER_NAMES[instance.loader] || instance.loader}`
        : 'Текущей сборки нет: можно скачать готовую сборку из каталога или создать свою.';
      syncCurseForgeFilters();
      if (instance) loadMods();
      else {
        state.mods = [];
        renderMods();
      }
      if (!$('#curseforgeResults').childElementCount) searchCurseForge();
    }
  }

  /* ─────────────────────────── события ─────────────────────────── */

  function bindEvents() {
    $$('.nav-item').forEach((item) => item.addEventListener('click', () => setView(item.dataset.view)));

    $$('[data-view]').forEach((item) => {
      if (item.classList.contains('nav-item')) return;
      item.addEventListener('click', () => setView(item.dataset.view));
    });

    $('#playBtn').addEventListener('click', play);
    $('#stopBtn').addEventListener('click', stopGame);

    $('#versionPick').addEventListener('click', () => {
      setView('versions');
      if (!state.activeInstance) openInstanceModal();
    });
    $('#heroSettings').addEventListener('click', () => {
      setView('settings');
      setTimeout(() => $('#javaInput').focus(), 60);
    });
    $('#accountChip').addEventListener('click', openAccounts);
    $('#editProfile').addEventListener('click', openAccounts);
    $('#settingsManageAccounts').addEventListener('click', openAccounts);
    $('#systemSettings').addEventListener('click', () => {
      setView('settings');
      setTimeout(() => $('#javaInput').focus(), 60);
    });

    $('#createInstance').addEventListener('click', openInstanceModal);
    $('#instanceList').addEventListener('click', (event) => {
      if (event.target.closest('[data-create-instance]')) {
        openInstanceModal();
        return;
      }
      const deleteButton = event.target.closest('[data-delete-instance]');
      if (deleteButton) {
        deleteInstance(deleteButton.dataset.deleteInstance);
        return;
      }
      const button = event.target.closest('[data-select-instance]');
      if (button) selectInstance(button.dataset.selectInstance);
      const configureButton = event.target.closest('[data-configure-instance]');
      if (configureButton) configureInstance(configureButton.dataset.configureInstance);
    });
    $('#homeInstances').addEventListener('click', (event) => {
      if (event.target.closest('[data-create-instance]')) {
        setView('versions');
        openInstanceModal();
        return;
      }
      const button = event.target.closest('[data-select-instance]');
      if (button) selectInstance(button.dataset.selectInstance);
    });
    $('#instanceConfigForm').addEventListener('submit', saveInstanceConfig);
    $('#closeInstanceConfig').addEventListener('click', closeInstanceConfig);
    $('#instanceConfigModal').addEventListener('click', (event) => {
      if (event.target === event.currentTarget) closeInstanceConfig();
    });
    $('#instanceConfigMemory').addEventListener('input', (event) => {
      $('#instanceConfigMemoryValue').textContent = formatMemory(Number(event.target.value));
    });
    $('#openInstanceFolder').addEventListener('click', async () => {
      try {
        await state.bridge.openPath('game');
      } catch (error) {
        showError('Не удалось открыть папку сборки', cleanError(error));
      }
    });
    $('#openInstanceMods').addEventListener('click', () => {
      closeInstanceConfig();
      setView('mods');
    });
    $('#deleteInstanceConfig').addEventListener('click', () => {
      if (state.activeInstance) deleteInstance(state.activeInstance.id);
      closeInstanceConfig();
    });
    $('#instanceForm').addEventListener('submit', createInstance);
    $('#instanceVersionSearch').addEventListener('input', (event) => {
      state.versionQuery = event.target.value;
      updateInstanceVersionOptions();
    });
    $('#instanceVersionFilters').addEventListener('change', (event) => {
      const checkbox = event.target.closest('[data-version-filter]');
      if (!checkbox) return;
      state.versionFilter[checkbox.dataset.versionFilter] = checkbox.checked;
      updateInstanceVersionOptions();
    });
    $('.version-filter-chips--right').addEventListener('change', (event) => {
      const checkbox = event.target.closest('[data-version-filter]');
      if (!checkbox) return;
      state.versionFilter[checkbox.dataset.versionFilter] = checkbox.checked;
      updateInstanceVersionOptions();
    });
    $('#versionExperimental').addEventListener('change', (event) => {
      state.versionFilter.experimental = event.target.checked;
      updateInstanceVersionOptions();
    });
    $('#refreshInstanceVersions').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await loadVersions(true);
      } finally {
        button.disabled = false;
      }
    });
    $('#instanceLoader').addEventListener('change', updateInstanceLoaderField);
    $('#instanceGameVersion').addEventListener('change', loadInstanceLoaderVersions);
    $('#cancelInstanceCreate').addEventListener('click', closeInstanceModal);
    $('#closeInstanceModal').addEventListener('click', closeInstanceModal);
    $('#instanceManualTab').addEventListener('click', () => setInstanceCreateMode('manual', { search: false }));
    $('#instanceCurseForgeTab').addEventListener('click', () => setInstanceCreateMode('curseforge'));
    $('#instanceModal').addEventListener('click', (event) => {
      if (event.target === event.currentTarget) closeInstanceModal();
    });

    $('#searchCurseForge').addEventListener('click', searchCurseForge);
    $('#resetCurseForgeFilters').addEventListener('click', () => {
      $('#curseforgeSearch').value = '';
      $('#curseforgeVersion').value = state.activeInstance?.versionId || '';
      $('#curseforgeLoader').value = state.activeInstance ? String(LOADER_TYPES[state.activeInstance.loader] || '') : '';
      $('#curseforgeClass').value = state.curseforgeContext === 'packs' ? '4471' : '6';
      syncCurseForgeFilters();
      state.modIndex = 0;
      searchCurseForge();
    });
    $('#curseforgeClass').addEventListener('change', () => {
      if (state.curseforgeContext === 'packs') {
        $('#curseforgeClass').value = '4471';
        return;
      }
      if (state.activeInstance && ['forge', 'fabric', 'quilt', 'neoforge'].includes(state.activeInstance.loader)) {
        $('#curseforgeClass').value = '6';
        return;
      }
      state.modIndex = 0;
      const isModpack = $('#curseforgeClass').value === '4471';
      $('#curseforgeLoader').disabled = isModpack;
      $('#curseforgeVersion').disabled = isModpack;
      if (isModpack) $('#curseforgeLoader').value = '';
      else setLoaderCategory(state.activeInstance?.loader || 'vanilla');
      searchCurseForge();
    });
    $('#curseforgeLoader').addEventListener('change', () => {
      state.modIndex = 0;
      searchCurseForge();
    });
    $('#curseforgeSort').addEventListener('change', () => {
      state.modIndex = 0;
      searchCurseForge();
    });
    $('#curseforgeSearch').addEventListener('input', () => {
      state.modIndex = 0;
    });
    $('#curseforgeVersion').addEventListener('input', () => {
      if (state.activeInstance) return;
    });
    $('#curseforgeVersion').addEventListener('change', () => {
      state.modIndex = 0;
      searchCurseForge();
    });
    $('#curseforgeVersion').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        state.modIndex = 0;
        searchCurseForge();
      }
    });
    $('#curseforgeResults').addEventListener('error', (event) => {
      if (event.target instanceof HTMLImageElement) event.target.remove();
    }, true);
    $('#curseforgeSearch').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        state.modIndex = 0;
        searchCurseForge();
      }
    });
    $('#curseforgeResults').addEventListener('click', (event) => {
      const pageButton = event.target.closest('[data-cf-page]');
      if (pageButton && !pageButton.disabled) {
        state.modIndex = Math.max(0, state.modIndex + (pageButton.dataset.cfPage === 'next' ? 24 : -24));
        searchCurseForge();
        return;
      }
      const filesButton = event.target.closest('[data-cf-files]');
      if (filesButton) {
        loadCurseForgeFiles(filesButton);
        return;
      }
      const installButton = event.target.closest('[data-cf-install]');
      if (installButton) installCurseForgeFile(installButton);
    });
    $('#manualDownloadList').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-manual-url]');
      if (!button) return;
      try {
        await state.bridge.openCurseForgeFilePage(button.dataset.manualUrl);
      } catch (error) {
        showError('Не удалось открыть источник файла', cleanError(error));
      }
    });
    $('#closeManualDownloads').addEventListener('click', closeManualDownloads);
    $('#cancelManualDownloads').addEventListener('click', cancelManualDownloads);
    $('#closeManualDownloadsFooter').addEventListener('click', checkManualDownloads);
    $('#copyManualDownloads').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(state.manualDownloads.map((item) => item.fileName).join('\n'));
        toast('Список скопирован', 'Имена файлов скопированы.', 'success');
      } catch (error) {
        showError('Не удалось скопировать список', cleanError(error));
      }
    });
    $('#manualDownloadsModal').addEventListener('click', (event) => {
      if (event.target === event.currentTarget) closeManualDownloads();
    });
    $('#cancelModDownload').addEventListener('click', async () => {
      if (!state.modOperationId) return;
      $('#cancelModDownload').disabled = true;
      try {
        await state.bridge.cancelModOperation(state.modOperationId);
      } catch (error) {
        showError('Не удалось отменить загрузку', cleanError(error));
        $('#cancelModDownload').disabled = false;
      }
    });

    $('#addLocalMod').addEventListener('click', async () => {
      try {
        const result = await state.bridge.addLocalMod();
        if (result) {
          await loadMods();
          toast('Мод добавлен', result.name, 'success');
        }
      } catch (error) {
        showError('Не удалось добавить мод', cleanError(error));
      }
    });

    $('#modsList').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-remove-mod]');
      if (!button || !window.confirm(`Удалить мод ${button.dataset.removeMod}?`)) return;
      try {
        await state.bridge.removeMod(button.dataset.removeMod);
        await loadMods();
      } catch (error) {
        showError('Не удалось удалить мод', cleanError(error));
      }
    });

    $('#memRange').addEventListener('input', (event) => setMemory(event.target.value));
    $('#settingsMemory').addEventListener('input', (event) => setMemory(event.target.value, { persist: false }));

    $('#closeOnLaunch').addEventListener('click', (event) => {
      const element = event.currentTarget;
      toggleSwitch(element, !element.classList.contains('is-on'));
    });

    $('#showConsole').addEventListener('click', (event) => {
      const element = event.currentTarget;
      toggleSwitch(element, !element.classList.contains('is-on'));
    });

    $('#saveSettings').addEventListener('click', saveSettings);
    $('#resetSettings').addEventListener('click', () => {
      syncSettingsForm();
      toast('Изменения отменены', 'Вернули последние сохранённые настройки.', 'warn', 2600);
    });

    $('#javaBrowse').addEventListener('click', async () => {
      const picked = await state.bridge.pickJava();
      if (picked) {
        $('#javaInput').value = picked;
        await checkJava(picked);
      }
    });
    $('#javaCheck').addEventListener('click', () => checkJava($('#javaInput').value.trim()));

    $('#gameDirBrowse').addEventListener('click', async () => {
      const picked = await state.bridge.pickDir();
      if (picked) $('#gameDirInput').value = picked;
    });
    $('#gameDirOpen').addEventListener('click', async () => {
      try {
        await persist({ gameDir: $('#gameDirInput').value.trim() });
        await state.bridge.openPath('game');
      } catch (error) {
        showError('Не удалось открыть папку', cleanError(error));
      }
    });

    $('#consoleToggle').addEventListener('click', toggleConsole);
    $('#consoleClose').addEventListener('click', closeConsole);
    $('#consoleClear').addEventListener('click', () => {
      $('#consoleBody').innerHTML = '';
      state.logs = [];
    });

    $('#openFolder').addEventListener('click', async () => {
      try {
        await state.bridge.openPath('game');
      } catch (error) {
        showError('Не удалось открыть папку', cleanError(error));
      }
    });

    $$('.win-btn').forEach((button) => {
      button.addEventListener('click', () => state.bridge.windowAction(button.dataset.win));
    });

    $('#titlebar').addEventListener('dblclick', (event) => {
      if (event.target.closest('button, nav')) return;
      state.bridge.windowAction('maximize');
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeConsole();
        closeInstanceModal();
        closeInstanceConfig();
      }
      if (event.key === ',' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        setView('settings');
      }
    });

    const hero = $('.hero');
    if (hero) {
      hero.addEventListener('pointermove', (event) => {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const rect = hero.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width - 0.5;
        const y = (event.clientY - rect.top) / rect.height - 0.5;
        const layers = [
          ['.art-stars', 2],
          ['.art-far', 4],
          ['.art-mid', 7],
          ['.art-float', 11],
          ['.art-hills', 6],
          ['.art-front', 14]
        ];
        for (const [selector, strength] of layers) {
          const layer = $(selector);
          if (layer) layer.style.transform = `translate3d(${(x * strength).toFixed(2)}px, ${(y * strength).toFixed(2)}px, 0)`;
        }
      });
      hero.addEventListener('pointerleave', () => {
        $$('.art-stars, .art-far, .art-mid, .art-float, .art-hills, .art-front').forEach((layer) => {
          layer.style.transform = '';
        });
      });
    }
  }

  /* ─────────────────────────── демо-режим ─────────────────────────── */

  function createDemoBridge() {
    const demoMods = [];
    let settings = {
      nickname: 'Steve',
      memory: 6144,
      javaPath: '',
      gameDir: '',
      versionId: '26.3',
      showConsole: true,
      closeOnLaunch: false
    };

    const versionList = [
      ['26.4-snapshot-10', 'snapshot', '2026-11-17T16:02:02+00:00'],
      ['26.4-snapshot-9', 'snapshot', '2026-11-17T12:58:45+00:00'],
      ['26.4-snapshot-8', 'snapshot', '2026-11-10T14:20:05+00:00'],
      ['26.3', 'release', '2026-09-15T11:23:02+00:00'],
      ['26.2', 'release', '2026-06-16T12:03:33+00:00'],
      ['26.1.2', 'release', '2026-04-09T10:12:23+00:00'],
      ['26.1.1', 'release', '2026-04-01T09:06:36+00:00'],
      ['26.1', 'release', '2026-03-24T12:11:04+00:00'],
      ['1.21.11', 'release', '2025-12-09T12:23:30+00:00'],
      ['1.21.10', 'release', '2025-10-07T09:17:23+00:00'],
      ['1.21.9', 'release', '2025-09-30T11:58:43+00:00']
    ].map(([id, type, releaseTime]) => ({
      id,
      type,
      releaseTime,
      url: '',
      installed: id === '26.3',
      experimental: type === 'snapshot' && /experimental/i.test(id)
    }));

    const paths = {
      root: 'C:\\Users\\you\\.obsidian-launcher',
      game: 'C:\\Users\\you\\.obsidian-launcher\\game',
      versions: 'C:\\Users\\you\\.obsidian-launcher\\versions'
    };
    let instances = [{
      id: 'demo-vanilla',
      name: 'Vanilla 26.3',
      versionId: '26.3',
      loader: 'vanilla',
      loaderVersion: '',
      gameDir: paths.game,
      memory: settings.memory
    }];
    let activeInstance = instances[0];
    const demoLogo = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1c2a18"/><path d="M18 40 32 18l14 22-14 8z" fill="#8bf26b"/></svg>'
    )}`;

    const listeners = new Set();
    const timers = new Set();
    let running = false;

    const emit = (payload) => listeners.forEach((listener) => listener(payload));
    const later = (fn, ms) => {
      const id = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
    };

    return {
      async init() {
        await sleep(250);
        return {
          settings: { ...settings },
          instances: instances.map((instance) => ({ ...instance })),
          instance: { ...activeInstance },
          system: {
            platform: 'win32',
            totalMemoryMb: 16384,
            java: {
              major: 25,
              version: '25.0.5',
              path: 'C:\\Program Files\\Java\\jdk-25\\bin\\java.exe',
              compatible: true
            }
          },
          paths: { ...paths },
          running: false,
          curseforgeConfigured: true,
          skin: null,
          logs: []
        };
      },
      async versions() {
        await sleep(500);
        return {
          latest: { release: '26.3', snapshot: '26.4-snapshot-10' },
          versions: versionList
        };
      },
      async instances() {
        return { instances: instances.map((instance) => ({ ...instance })), selectedId: activeInstance?.id || '' };
      },
      async createInstance(options) {
        await sleep(350);
        const instance = {
          ...options,
          id: `demo-${Date.now()}`,
          gameDir: `C:\\Users\\you\\.obsidian-launcher\\instances\\${Date.now()}`,
          memory: settings.memory
        };
        instances.push(instance);
        activeInstance = instance;
        settings = { ...settings, versionId: instance.versionId, loader: instance.loader, loaderVersion: instance.loaderVersion, gameDir: instance.gameDir };
        paths.game = instance.gameDir;
        return { instance: { ...instance }, instances: instances.map((item) => ({ ...item })), settings: { ...settings }, paths: { ...paths } };
      },
      async selectInstance(id) {
        activeInstance = instances.find((instance) => instance.id === id);
        settings = { ...settings, versionId: activeInstance.versionId, loader: activeInstance.loader, loaderVersion: activeInstance.loaderVersion, gameDir: activeInstance.gameDir, memory: activeInstance.memory || settings.memory };
        paths.game = activeInstance.gameDir;
        return { instance: { ...activeInstance }, instances: instances.map((item) => ({ ...item })), settings: { ...settings }, paths: { ...paths } };
      },
      async updateInstance(id, patch) {
        const instance = instances.find((item) => item.id === id);
        Object.assign(instance, patch);
        if (instance.id === activeInstance.id) settings = { ...settings, memory: instance.memory };
        return { instance: { ...instance }, instances: instances.map((item) => ({ ...item })), settings: { ...settings }, paths: { ...paths } };
      },
      async saveSettings(patch) {
        settings = { ...settings, ...patch };
        if (activeInstance && 'memory' in patch) activeInstance.memory = settings.memory;
        return { settings: { ...settings }, paths: { ...paths } };
      },
      async pickProfileSkin() {
        return {
          dataUrl: demoLogo,
          width: 64,
          height: 64
        };
      },
      async removeProfileSkin() {
        return { removed: true };
      },
      async openAccounts() {
        return { ok: true };
      },
      async probeJava(pathValue) {
        await sleep(350);
        if (pathValue && !/java/i.test(pathValue)) return { ok: false, message: 'По этому пути Java не найдена' };
        return {
          ok: true,
          major: 25,
          version: '25.0.5',
          path: pathValue || 'C:\\Program Files\\Java\\jdk-25\\bin\\java.exe'
        };
      },
      async loaderVersions(loader) {
        await sleep(250);
        return {
          ok: true,
          versions: loader === 'forge'
            ? ['52.0.0', '51.0.33']
            : loader === 'neoforge'
              ? ['21.1.217', '21.1.216']
              : ['0.18.4', '0.18.3']
        };
      },
      async installLoader(loader, versionId, loaderVersion) {
        settings = { ...settings, loader, versionId, loaderVersion };
        return { ok: true };
      },
      async modsList() {
        return demoMods.map((mod) => ({ ...mod }));
      },
      async addLocalMod() {
        return null;
      },
      async removeMod() {
        return { ok: true };
      },
      async curseForgeSearch(options) {
        await sleep(250);
        const isModpack = Number(options.classId) === 4471;
        const name = options.query.trim() || (isModpack ? 'Модпак' : 'JourneyMap');
        return {
          data: [{
            id: isModpack ? 500 : 100,
            name,
            summary: isModpack ? 'Демонстрационная сборка CurseForge' : 'Карта и точки интереса в Minecraft',
            downloadCount: 123456,
            slug: isModpack ? 'demo-pack' : 'journeymap',
            logo: { url: demoLogo, thumbnailUrl: demoLogo }
          }],
          pagination: { index: options.index, pageSize: options.pageSize, totalCount: 1 }
        };
      },
      async curseForgeFiles(modId) {
        await sleep(150);
        const isModpack = Number(modId) === 500;
        return {
          data: [{
            id: isModpack ? 5001 : 1001,
            modId,
            displayName: isModpack ? 'Demo Pack 1.20.1' : 'JourneyMap 1.20.1',
            fileName: isModpack ? 'demo-pack.zip' : 'journeymap.jar',
            fileDate: '2026-10-10T12:00:00Z',
            gameVersions: ['1.20.1', isModpack ? 'Fabric' : 'Fabric'],
            fileLength: 1250000
          }]
        };
      },
      async installCurseForgeFile(fileId, options) {
        await sleep(300);
        if (Number(options.classId) === 4471) {
          const instance = {
            id: `demo-${Date.now()}`,
            name: options.packName || 'Готовая сборка',
            versionId: '1.20.1',
            loader: 'fabric',
            loaderVersion: '0.15.11',
            gameDir: `C:\\Users\\you\\.obsidian-launcher\\instances\\${Date.now()}`,
            memory: settings.memory
          };
          instances.push(instance);
          activeInstance = instance;
          settings = { ...settings, versionId: instance.versionId, loader: instance.loader, loaderVersion: instance.loaderVersion, gameDir: instance.gameDir };
          paths.game = instance.gameDir;
          demoMods.push({ name: `pack-mod-${fileId}.jar`, enabled: true, size: 1250000 });
          return {
            installed: 1,
            blocked: [],
            instance: { ...instance },
            instances: instances.map((item) => ({ ...item })),
            settings: { ...settings }
          };
        }
        demoMods.push({ name: `curseforge-${fileId}.jar`, enabled: true, size: 1250000 });
        return { installed: 1, blocked: [] };
      },
      async modrinthSearch(options) {
        await sleep(250);
        const title = options.query.trim() || 'Sodium';
        return {
          hits: [{
            project_id: 'demo-sodium',
            title,
            description: 'Оптимизация производительности Minecraft',
            downloads: 123456,
            slug: 'sodium'
          }],
          total_hits: 1
        };
      },
      async modrinthVersions() {
        await sleep(150);
        return [{
          id: 'demo-version',
          name: 'Sodium 0.6.13',
          version_number: '0.6.13',
          date_published: '2026-10-10T12:00:00Z',
          game_versions: [activeInstance.versionId],
          loaders: [activeInstance.loader],
          files: [{ filename: 'sodium-0.6.13.jar', size: 1250000, primary: true }]
        }];
      },
      async installModrinthVersion() {
        await sleep(300);
        demoMods.push({ name: 'sodium-0.6.13.jar', enabled: true, size: 1250000 });
        return { installed: 1 };
      },
      async cancelModOperation() {
        return { ok: true };
      },
      async browseMods() {
        return { ok: true };
      },
      async browseCurseForge() {
        return { ok: true };
      },
      async launch() {
        if (running) return { ok: false, error: 'Игра уже запущена' };
        running = true;
        emit({ type: 'state', phase: 'preparing', message: 'Читаем манифест версий', percent: 0, detail: settings.versionId });
        const steps = [
          [10, 'Скачиваем: Библиотеки', '12 из 118 файлов'],
          [26, 'Скачиваем: Клиент игры', '119 из 132 файлов'],
          [48, 'Скачиваем: Ресурсы игры', '820 из 2980 файлов'],
          [71, 'Скачиваем: Ресурсы игры', '2104 из 2980 файлов'],
          [92, 'Скачиваем: Ресурсы игры', '2740 из 2980 файлов'],
          [100, 'Запускаем Minecraft', 'Java 25']
        ];
        steps.forEach(([percent, message, detail], index) => {
          later(() => {
            if (!running) return;
            emit({ type: 'state', phase: 'downloading', message, percent, detail });
            emit({ type: 'log', stream: 'out', line: `${message} — ${detail}` });
          }, 700 + index * 900);
        });
        later(() => {
          if (!running) return;
          emit({ type: 'log', stream: 'out', line: 'Setting user: Steve' });
          emit({ type: 'log', stream: 'out', line: 'Backend library: LWJGL version 3.4.3+33' });
          emit({ type: 'state', phase: 'running', message: 'Minecraft запущен', percent: 100, detail: 'Java 25 · PID 8124' });
        }, 700 + steps.length * 900);
        return { ok: true };
      },
      async stop() {
        running = false;
        timers.forEach((id) => clearTimeout(id));
        timers.clear();
        emit({ type: 'state', phase: 'idle', message: 'Запуск отменён', percent: 0 });
        return { ok: true };
      },
      async pickJava() {
        return 'C:\\Program Files\\Java\\jdk-25\\bin\\java.exe';
      },
      async pickDir() {
        return 'D:\\Games\\Minecraft';
      },
      async openPath() {
        return 'demo';
      },
      async windowAction() {
        return { maximized: false };
      },
      onLaunch(callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      onWindowState() {
        return () => {};
      },
      async checkManualDownloads() {
        return [];
      },
      async importManualDownloads() {
        return { imported: [], pending: [] };
      },
      async deleteInstance() {
        return { instances: [], instance: null, settings };
      },
      async checkForUpdates() {
        return { ok: true };
      },
      async downloadUpdate() {
        return { ok: true };
      },
      async installUpdate() {
        return true;
      },
      onUpdateEvent() {
        return () => {};
      },
      onModsProgress(callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      onModsFallback() {
        return () => {};
      },
      onModsFallbackError() {
        return () => {};
      }
    };
  }
})();
