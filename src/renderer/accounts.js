/* OBSIDIAN Launcher — окно управления локальными профилями */
(() => {
  'use strict';

  const api = window.accounts;
  const art = window.LauncherArt;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const state = {
    settings: null,
    skin: null,
    editing: null,
    busy: false
  };

  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[character]);

  function errorMessage(error) {
    return String(error?.message || error || 'Неизвестная ошибка')
      .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
  }

  function showError(error) {
    const element = $('#accountsError');
    element.textContent = errorMessage(error);
    element.hidden = false;
  }

  function clearError() {
    $('#accountsError').hidden = true;
  }

  function renderFace(container, nickname, size = 38) {
    if (!container) return;
    if (!state.skin?.dataUrl) {
      container.innerHTML = art ? art.avatar(nickname, size) : esc((nickname || '?').slice(0, 1));
      return;
    }

    container.innerHTML = '<span class="skin-face"></span>';
    const face = container.firstElementChild;
    const hasOverlay = state.skin.height !== 32;
    const layerSize = `${size * 8}px ${size * (hasOverlay ? 8 : 4)}px`;
    face.style.backgroundImage = hasOverlay
      ? `url("${state.skin.dataUrl}"), url("${state.skin.dataUrl}")`
      : `url("${state.skin.dataUrl}")`;
    face.style.backgroundSize = hasOverlay ? `${layerSize}, ${layerSize}` : layerSize;
    face.style.backgroundPosition = hasOverlay
      ? `-${size}px -${size}px, -${size}px -${size}px`
      : `-${size}px -${size}px`;
    face.style.backgroundRepeat = hasOverlay ? 'no-repeat, no-repeat' : 'no-repeat';
    face.style.imageRendering = 'pixelated';
  }

  function render() {
    const accounts = state.settings?.accounts || [];
    const activeId = state.settings?.activeAccountId || '';
    const list = $('#accountsList');

    if (!accounts.length) {
      list.innerHTML = '<div class="empty-state">Нет ни одного профиля. Добавьте первый локальный аккаунт.</div>';
    } else {
      list.innerHTML = accounts.map((account) => {
        const active = account.id === activeId;
        const editing = state.editing === account.id;
        return `<article class="account${active ? ' is-active' : ''}" data-id="${esc(account.id)}">
          <span class="account-face"></span>
          <div class="account-body">
            ${editing
              ? `<form class="edit-row" data-edit-form>
                   <input data-edit-input maxlength="16" value="${esc(account.nickname)}" autocomplete="off" spellcheck="false" />
                   <button class="mini-btn" type="submit">OK</button>
                   <button class="mini-btn" type="button" data-cancel-edit>Отмена</button>
                 </form>`
              : `<strong>${esc(account.nickname)}</strong><span>${esc(account.uuid || '')}</span>`}
          </div>
          ${active ? '<span class="badge">Активен</span>' : ''}
          <div class="account-actions">
            ${active ? '' : `<button class="mini-btn" type="button" data-select="${esc(account.id)}">Выбрать</button>`}
            <button class="mini-btn" type="button" data-edit="${esc(account.id)}">Изменить</button>
            <button class="mini-btn is-danger" type="button" data-delete="${esc(account.id)}" ${accounts.length <= 1 ? 'disabled title="Нельзя удалить последний профиль"' : ''}>Удалить</button>
          </div>
        </article>`;
      }).join('');

      for (const row of $$('.account', list)) {
        const account = accounts.find((item) => item.id === row.dataset.id);
        if (account) renderFace($('.account-face', row), account.nickname);
      }
    }

    const hasSkin = Boolean(state.skin?.dataUrl);
    const image = $('#skinTexture');
    if (hasSkin) image.src = state.skin.dataUrl;
    else image.removeAttribute('src');
    $('#skinEmpty').hidden = hasSkin;
    $('#removeSkin').hidden = !hasSkin;
    $('#pickSkin').disabled = state.busy;
    $('#removeSkin').disabled = state.busy;

    const editInput = $('[data-edit-input]');
    if (editInput) {
      editInput.focus();
      editInput.select();
    }
  }

  function apply(data) {
    if (data?.settings) state.settings = data.settings;
    if (data && 'skin' in data) state.skin = data.skin || null;
    render();
  }

  async function run(task) {
    if (state.busy) return;
    state.busy = true;
    clearError();
    try {
      const result = await task();
      if (result && (result.settings || 'skin' in result)) {
        if (result.settings) state.settings = result.settings;
        if ('skin' in result) state.skin = result.skin || null;
        render();
      }
    } catch (error) {
      showError(error);
    } finally {
      state.busy = false;
      render();
    }
  }

  function bind() {
    $('#closeAccounts').addEventListener('click', () => api.close());

    $('#createAccountForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const input = $('#newAccountName');
      const name = input.value.trim();
      if (!name) {
        showError('Введите ник аккаунта.');
        return;
      }
      run(async () => {
        const result = await api.create(name);
        input.value = '';
        return result;
      });
    });

    $('#accountsList').addEventListener('click', (event) => {
      const selectButton = event.target.closest('[data-select]');
      if (selectButton) {
        run(() => api.select(selectButton.dataset.select));
        return;
      }

      const editButton = event.target.closest('[data-edit]');
      if (editButton) {
        state.editing = editButton.dataset.edit;
        render();
        return;
      }

      const cancelButton = event.target.closest('[data-cancel-edit]');
      if (cancelButton) {
        state.editing = null;
        render();
        return;
      }

      const deleteButton = event.target.closest('[data-delete]');
      if (deleteButton) {
        const account = (state.settings?.accounts || []).find((item) => item.id === deleteButton.dataset.delete);
        if (!account) return;
        if (!window.confirm(`Удалить профиль «${account.nickname}»?`)) return;
        run(() => api.remove(account.id));
      }
    });

    $('#accountsList').addEventListener('submit', (event) => {
      const form = event.target.closest('[data-edit-form]');
      if (!form) return;
      event.preventDefault();
      const row = form.closest('[data-id]');
      const input = $('[data-edit-input]', form);
      const name = input.value.trim();
      if (!name) {
        showError('Введите ник аккаунта.');
        return;
      }
      run(async () => {
        const result = await api.update(row.dataset.id, name);
        state.editing = null;
        return result;
      });
    });

    $('#newAccountName').addEventListener('input', (event) => {
      const value = event.target.value.replace(/[^\wа-яА-ЯёЁ]/g, '').slice(0, 16);
      event.target.value = value;
    });

    $('#accountsList').addEventListener('input', (event) => {
      if (!event.target.matches('[data-edit-input]')) return;
      const value = event.target.value.replace(/[^\wа-яА-ЯёЁ]/g, '').slice(0, 16);
      event.target.value = value;
    });

    $('#pickSkin').addEventListener('click', () => {
      run(async () => {
        const skin = await api.pickSkin();
        if (!skin) return null;
        return { skin };
      });
    });

    $('#removeSkin').addEventListener('click', () => {
      run(async () => {
        await api.removeSkin();
        return { skin: null };
      });
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (state.editing) {
        state.editing = null;
        render();
      } else {
        api.close();
      }
    });
  }

  async function start() {
    bind();
    render();
    try {
      apply(await api.init());
    } catch (error) {
      showError(error);
    }
  }

  start();
})();
