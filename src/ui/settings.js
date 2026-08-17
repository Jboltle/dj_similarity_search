const DEFAULT_LINKED_FOLDER_NAME = 'Linked Tracks';
const SYNC_MODES = [
  { value: 'none', label: 'None' },
  { value: 'git', label: 'Git' },
  { value: 'local-folder', label: 'Local folder' },
];
const MACHINE_MODES = [
  { value: '__auto__', label: 'Auto' },
  { value: 'mac', label: 'Mac' },
  { value: 'windows', label: 'Windows' },
];

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function segmentedMarkup(id, options, currentValue) {
  const buttons = options
    .map(
      (opt) => `
        <button type="button" class="seg${opt.value === currentValue ? ' active' : ''}"
                data-value="${escape(opt.value)}">${escape(opt.label)}</button>
      `
    )
    .join('');
  return `<div class="segmented" id="${escape(id)}">${buttons}</div>`;
}

function statusDotMarkup(ok) {
  return `<span class="status-dot ${ok ? 'ok' : 'err'}" title="${ok ? 'Detected' : 'Not found'}">${ok ? '✓' : '×'}</span>`;
}

export class SettingsPanel {
  constructor({ api, drawer, onSettingsChanged }) {
    this.api = api;
    this.drawer = drawer;
    this.onSettingsChanged = onSettingsChanged;
    this.settings = null;
    this.folderInfo = null;
    this.busy = false;
    this.showingBackups = false;
    this.backups = null;
  }

  async open() {
    this.drawer.open({ name: 'settings', title: 'Settings' });
    await this.load();
    this.render();
  }

  async load() {
    const [settings, folderInfo] = await Promise.all([
      this.api.getSettings(),
      this.safeDetectFolder(),
    ]);
    this.settings = settings;
    this.folderInfo = folderInfo;
  }

  async safeDetectFolder() {
    try {
      return await this.api.detectVdjFolder();
    } catch {
      return null;
    }
  }

  async persist(patch) {
    try {
      this.settings = await this.api.saveSettings(patch);
      this.drawer.showToast('Saved');
      this.onSettingsChanged?.(this.settings);
    } catch (error) {
      this.drawer.showToast(error?.message || 'Save failed', { kind: 'err' });
    }
  }

  render() {
    if (this.showingBackups) return this.renderBackups();
    const s = this.settings || {};
    const info = this.folderInfo;
    const folderOk = Boolean(info?.exists?.databaseXml && info?.exists?.extraDb);
    const folderValue = s.vdjFolder || info?.folder || '';
    const machineValue = s.machineId ?? '__auto__';
    const linkedName = s.linkedFolderName || DEFAULT_LINKED_FOLDER_NAME;

    const body = this.drawer.getBody();
    body.innerHTML = `
      <div class="settings-panel">
        <section class="form-row">
          <label for="settings-vdj-folder">
            VirtualDJ folder
            ${statusDotMarkup(folderOk)}
          </label>
          <div class="input-with-button">
            <input type="text" id="settings-vdj-folder" value="${escape(folderValue)}"
                   placeholder="/path/to/VirtualDJ" spellcheck="false" />
            <button type="button" id="settings-vdj-browse" class="ghost-btn">Browse…</button>
          </div>
          <p class="form-hint">Contains <code>database.xml</code>, <code>extra.db</code>, and <code>History/</code>.</p>
        </section>

        <section class="form-row">
          <label>Sync mode</label>
          ${segmentedMarkup('settings-sync-mode', SYNC_MODES, s.syncMode || 'none')}
        </section>

        <section class="form-row" id="settings-git-block" ${s.syncMode === 'git' ? '' : 'hidden'}>
          <label for="settings-git-remote">Sync repo URL</label>
          <div class="input-with-button">
            <input type="text" id="settings-git-remote"
                   value="${escape(s.syncGitRemote || '')}"
                   placeholder="git@github.com:you/vdj-sync.git" spellcheck="false" />
            <button type="button" id="settings-git-init" class="ghost-btn">Initialize / Clone</button>
          </div>
        </section>

        <section class="form-row" id="settings-local-block" ${s.syncMode === 'local-folder' ? '' : 'hidden'}>
          <label for="settings-local-folder">Sync folder</label>
          <div class="input-with-button">
            <input type="text" id="settings-local-folder"
                   value="${escape(s.syncLocalFolder || '')}"
                   placeholder="/path/to/shared/folder" spellcheck="false" />
            <button type="button" id="settings-local-browse" class="ghost-btn">Browse…</button>
          </div>
        </section>

        <section class="form-row">
          <label>Machine identity</label>
          ${segmentedMarkup('settings-machine', MACHINE_MODES, machineValue)}
          <p class="form-hint">Overrides the auto-detected OS label used inside the shared library.</p>
        </section>

        <section class="form-row">
          <label for="settings-linked-name">Linked Tracks folder name</label>
          <input type="text" id="settings-linked-name" value="${escape(linkedName)}"
                 placeholder="${DEFAULT_LINKED_FOLDER_NAME}" spellcheck="false" />
        </section>

        <section class="form-row">
          <label class="checkbox">
            <input type="checkbox" id="settings-auto-refresh" ${s.autoRefreshOnStartup ? 'checked' : ''} />
            <span>Auto-refresh library on startup</span>
          </label>
        </section>

        <section class="form-row">
          <label>Backups</label>
          <button type="button" id="settings-open-backups" class="ghost-btn">Restore from backup…</button>
        </section>
      </div>
    `;

    this.wireEvents();
  }

  wireEvents() {
    const body = this.drawer.getBody();

    const folderInput = body.querySelector('#settings-vdj-folder');
    folderInput.addEventListener('change', () => this.persist({ vdjFolder: folderInput.value.trim() || null }));
    body.querySelector('#settings-vdj-browse').addEventListener('click', async () => {
      const picked = await this.api.pickFolder('vdj');
      if (picked) {
        folderInput.value = picked;
        await this.persist({ vdjFolder: picked });
        this.folderInfo = await this.safeDetectFolder();
        this.render();
      }
    });

    this.wireSegmented('#settings-sync-mode', async (value) => {
      await this.persist({ syncMode: value });
      this.render();
    });

    const gitRemote = body.querySelector('#settings-git-remote');
    if (gitRemote) {
      gitRemote.addEventListener('change', () => this.persist({ syncGitRemote: gitRemote.value.trim() || null }));
    }
    const gitInit = body.querySelector('#settings-git-init');
    if (gitInit) {
      gitInit.addEventListener('click', async () => {
        const remoteUrl = gitRemote?.value.trim();
        if (!remoteUrl) {
          this.drawer.showToast('Enter a repo URL first', { kind: 'err' });
          return;
        }
        gitInit.disabled = true;
        gitInit.textContent = 'Working…';
        try {
          const result = await this.api.initializeSyncRepo({ mode: 'git', remoteUrl });
          if (result?.ok) {
            this.drawer.showToast('Sync repo ready');
            await this.load();
            this.render();
          } else {
            this.drawer.showToast(result?.error || 'Initialize failed', { kind: 'err' });
          }
        } finally {
          gitInit.disabled = false;
          gitInit.textContent = 'Initialize / Clone';
        }
      });
    }

    const localFolder = body.querySelector('#settings-local-folder');
    if (localFolder) {
      localFolder.addEventListener('change', async () => {
        const folder = localFolder.value.trim();
        await this.persist({ syncLocalFolder: folder || null });
      });
    }
    const localBrowse = body.querySelector('#settings-local-browse');
    if (localBrowse) {
      localBrowse.addEventListener('click', async () => {
        const picked = await this.api.pickFolder('sync');
        if (!picked) return;
        localFolder.value = picked;
        const result = await this.api.initializeSyncRepo({ mode: 'local-folder', folder: picked });
        if (result?.ok) {
          await this.persist({ syncLocalFolder: picked });
        } else {
          this.drawer.showToast(result?.error || 'Initialize failed', { kind: 'err' });
        }
      });
    }

    this.wireSegmented('#settings-machine', async (value) => {
      const machineId = value === '__auto__' ? null : value;
      await this.persist({ machineId });
    });

    const linkedName = body.querySelector('#settings-linked-name');
    linkedName.addEventListener('change', () => {
      const value = linkedName.value.trim() || DEFAULT_LINKED_FOLDER_NAME;
      this.persist({ linkedFolderName: value });
    });

    const autoRefresh = body.querySelector('#settings-auto-refresh');
    autoRefresh.addEventListener('change', () => this.persist({ autoRefreshOnStartup: autoRefresh.checked }));

    body.querySelector('#settings-open-backups').addEventListener('click', () => this.openBackups());
  }

  wireSegmented(selector, onChange) {
    const group = this.drawer.getBody().querySelector(selector);
    if (!group) return;
    group.querySelectorAll('.seg').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (btn.classList.contains('active')) return;
        group.querySelectorAll('.seg').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        await onChange(btn.dataset.value);
      });
    });
  }

  async openBackups() {
    this.showingBackups = true;
    this.drawer.setTitle('Restore from backup');
    const body = this.drawer.getBody();
    body.innerHTML = `<div class="settings-panel"><p class="form-hint">Loading backups…</p></div>`;
    try {
      this.backups = await this.api.listBackups();
    } catch (error) {
      this.backups = [];
      this.drawer.showToast(error?.message || 'Failed to list backups', { kind: 'err' });
    }
    this.renderBackups();
  }

  renderBackups() {
    const body = this.drawer.getBody();
    const items = this.backups || [];
    body.innerHTML = `
      <div class="settings-panel">
        <button type="button" id="backups-back" class="ghost-btn back-btn">← Settings</button>
        ${items.length === 0
          ? `<p class="form-hint">No backups found yet. They will appear after your first push or pull.</p>`
          : `<ul class="backup-list">${items.map((b) => this.renderBackupRow(b)).join('')}</ul>`
        }
      </div>
    `;
    body.querySelector('#backups-back').addEventListener('click', () => {
      this.showingBackups = false;
      this.drawer.setTitle('Settings');
      this.render();
    });
    body.querySelectorAll('.backup-restore').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const stamp = btn.dataset.stamp;
        if (!stamp) return;
        const ok = window.confirm(
          `Restore backup ${stamp}?\n\nThis will overwrite the matching files inside your VirtualDJ folder.`
        );
        if (!ok) return;
        btn.disabled = true;
        btn.textContent = 'Restoring…';
        try {
          const result = await this.api.restoreBackup(stamp);
          if (result?.ok) {
            this.drawer.showToast('Restored');
            this.onSettingsChanged?.(this.settings);
          } else {
            this.drawer.showToast(result?.error || 'Restore failed', { kind: 'err' });
          }
        } finally {
          btn.disabled = false;
          btn.textContent = 'Restore';
        }
      });
    });
  }

  renderBackupRow(backup) {
    return `
      <li class="backup-row">
        <div class="backup-row-body">
          <div class="backup-row-title">${escape(backup.stamp)}</div>
          <div class="backup-row-sub">${escape(backup.kind || 'backup')} · ${escape(formatBytes(backup.sizeBytes))}</div>
          <div class="backup-row-path">${escape(backup.folder)}</div>
        </div>
        <button type="button" class="backup-restore ghost-btn" data-stamp="${escape(backup.stamp)}">Restore</button>
      </li>
    `;
  }
}
