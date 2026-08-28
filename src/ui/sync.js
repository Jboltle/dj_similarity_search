const LOG_MAX_LINES = 500;
const REFRESH_HINT_DELAY_MS = 250;

const REASON_LABELS = {
  new_locally: { label: 'new here', tone: 'ok' },
  from_remote: { label: 'from shared', tone: 'info' },
  poi_diff: { label: 'POIs', tone: 'warn' },
  bpm_diff: { label: 'BPM', tone: 'warn' },
  meta_diff: { label: 'metadata', tone: 'info' },
  lastmodified_only: { label: 'timestamp only', tone: 'muted' },
};

const CHANGED_FIELD_LABELS = {
  pois: 'POIs',
  bpm: 'BPM',
  key: 'Key',
  genre: 'Genre',
  album: 'Album',
  year: 'Year',
  artist: 'Artist',
  title: 'Title',
};

const FRESHNESS_TIERS = [
  { maxDays: 1, tone: 'ok', label: 'fresh' },
  { maxDays: 7, tone: 'ok', label: 'recent' },
  { maxDays: 30, tone: 'warn', label: 'aging' },
  { maxDays: Infinity, tone: 'err', label: 'stale' },
];

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function displayName(song) {
  const artist = (song.artist || '').trim();
  const title = (song.title || '').trim();
  if (artist && title) return `${artist} — ${title}`;
  if (title) return title;
  if (artist) return artist;
  return song.filePath || '(unknown song)';
}

function pairName(pair) {
  const left = displayName({ artist: pair.song1?.artist, title: pair.song1?.title, filePath: pair.song1?.filePath });
  const right = displayName({ artist: pair.song2?.artist, title: pair.song2?.title, filePath: pair.song2?.filePath });
  return `${left}  ↔  ${right}`;
}

function formatTimestamp(epoch) {
  if (!epoch) return '—';
  try {
    return new Date(Number(epoch)).toLocaleString();
  } catch {
    return String(epoch);
  }
}

function formatRelative(isoOrMs) {
  if (!isoOrMs) return 'never';
  const t = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  if (Number.isNaN(t)) return String(isoOrMs);
  const diff = Date.now() - t;
  const seconds = Math.round(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

function freshnessOf(lastPushAt) {
  if (!lastPushAt) return { tone: 'muted', label: 'never pushed' };
  const days = (Date.now() - Number(lastPushAt)) / (24 * 60 * 60 * 1000);
  return FRESHNESS_TIERS.find((t) => days <= t.maxDays);
}

function reasonChip(reason) {
  const meta = REASON_LABELS[reason] ?? { label: reason || 'change', tone: 'muted' };
  return `<span class="diff-chip diff-chip-${meta.tone}">${escape(meta.label)}</span>`;
}

function changedFieldChips(fields) {
  if (!fields?.length) return '';
  return fields
    .map((f) => `<span class="diff-chip diff-chip-muted">${escape(CHANGED_FIELD_LABELS[f] || f)}</span>`)
    .join(' ');
}

function matchesSearch(song, needle) {
  if (!needle) return true;
  const n = needle.toLowerCase();
  return (
    (song.artist ?? '').toLowerCase().includes(n) ||
    (song.title ?? '').toLowerCase().includes(n) ||
    (song.filePath ?? '').toLowerCase().includes(n) ||
    (song.folder ?? '').toLowerCase().includes(n)
  );
}

function songRow(song, { section, checked, checkboxName }) {
  const name = displayName(song);
  const poi = Number(song.poiCount || 0) > 0
    ? `<span class="poi-badge" title="POIs, cues, loops, beat grid">POIs: ${escape(song.poiCount)}</span>`
    : '';
  return `
    <li class="diff-row" data-file="${escape(song.filePath)}" data-section="${escape(section)}">
      <label class="diff-check">
        <input type="checkbox" name="${escape(checkboxName)}" value="${escape(song.filePath)}" ${checked ? 'checked' : ''} />
      </label>
      <div class="diff-row-body">
        <div class="diff-row-title">${escape(name)} ${reasonChip(song.reason)}</div>
        <div class="diff-row-sub">${escape(song.filePath || '')}</div>
      </div>
      ${poi}
    </li>
  `;
}

function pairRow(pair) {
  return `
    <li class="diff-row diff-row-pair">
      <label class="diff-check">
        <input type="checkbox" checked disabled title="Linked pairs follow their songs" />
      </label>
      <div class="diff-row-body">
        <div class="diff-row-title">${escape(pairName(pair))}</div>
      </div>
    </li>
  `;
}

function historyRow(fileName) {
  return `
    <li class="diff-row diff-row-history">
      <label class="diff-check">
        <input type="checkbox" checked disabled title="History files auto-merge" />
      </label>
      <div class="diff-row-body">
        <div class="diff-row-title">${escape(fileName)}</div>
      </div>
    </li>
  `;
}

function conflictRow(conflict, { resolution, machines }) {
  const machineFor = (m) => machines.find((x) => x.id === m);
  const remoteMachine = conflict.remoteMachine ? machineFor(conflict.remoteMachine) : null;
  const remoteLabel = remoteMachine?.displayName || conflict.remoteMachine || 'shared library';
  const winner = resolution
    ? (resolution === 'local' ? 'You chose: keep local' : `You chose: keep from ${remoteLabel}`)
    : (conflict.winnerIfMerged === 'local' ? 'auto: this machine wins' : `auto: ${remoteLabel} wins`);
  return `
    <li class="diff-row diff-row-conflict" data-file="${escape(conflict.filePath)}">
      <div class="diff-row-body">
        <div class="diff-row-title">
          ${escape(displayName(conflict))}
          ${reasonChip(conflict.reason)}
          ${changedFieldChips(conflict.changedFields)}
        </div>
        <div class="diff-row-sub">${escape(conflict.filePath || '')}</div>
        <div class="diff-row-conflict-times">
          <span>Local: ${escape(formatTimestamp(conflict.localLastModified))}</span>
          <span>${escape(remoteLabel)}: ${escape(formatTimestamp(conflict.remoteLastModified))}</span>
          <span class="diff-conflict-winner">${escape(winner)}</span>
        </div>
      </div>
      <div class="diff-row-actions">
        <button type="button" class="ghost-btn diff-resolve-local ${resolution === 'local' ? 'active' : ''}" data-file="${escape(conflict.filePath)}">Keep local</button>
        <button type="button" class="ghost-btn diff-resolve-remote ${resolution === 'remote' ? 'active' : ''}" data-file="${escape(conflict.filePath)}">Keep ${escape(remoteLabel)}</button>
        ${resolution ? `<button type="button" class="ghost-btn diff-resolve-clear" data-file="${escape(conflict.filePath)}">Reset</button>` : ''}
      </div>
    </li>
  `;
}

function sectionHeader({ title, songs, pairs, history, sectionKey }) {
  const parts = [`${songs} songs`];
  if (pairs != null) parts.push(`${pairs} linked pairs`);
  if (history != null) parts.push(`${history} history files`);
  return `
    <div class="diff-section-header">
      <h3>${escape(title)}</h3>
      <span class="diff-section-meta">${escape(parts.join(' · '))}</span>
      ${sectionKey ? `<input type="search" class="diff-search" data-section="${escape(sectionKey)}" placeholder="Search…" />` : ''}
    </div>
  `;
}

function emptyState({ reason, onOpenSettings }) {
  const div = document.createElement('div');
  div.className = 'sync-empty';
  div.innerHTML = `
    <span class="sync-empty-illustration" aria-hidden="true">
      <svg><use href="#icon-empty"></use></svg>
    </span>
    <div class="sync-empty-title">Sync isn't set up yet</div>
    <p>${escape(reason || 'Configure a sync target in Settings to start pushing and pulling changes.')}</p>
    <button type="button" class="ghost-btn sync-empty-cta">Set up sync in Settings</button>
  `;
  div.querySelector('.sync-empty-cta').addEventListener('click', onOpenSettings);
  return div;
}

export class SyncPanel {
  constructor({ api, drawer, onSyncBadgeUpdate, onOpenSettings, refreshSettings }) {
    this.api = api;
    this.drawer = drawer;
    this.onSyncBadgeUpdate = onSyncBadgeUpdate;
    this.onOpenSettings = onOpenSettings;
    this.refreshSettings = refreshSettings;
    this.currentDiff = null;
    this.lastSettings = null;
    this.knownMachines = [];
    this.resolutions = {};
    this.logLines = [];
    this.unsubscribeLog = null;
    this.rendered = false;
    this.busy = false;
    this.filters = { push: '', pull: '', conflicts: '' };
  }

  attach() {
    if (!this.api?.onLog) return;
    this.unsubscribeLog = this.api.onLog((line) => this.appendLog(line));
  }

  detach() {
    if (this.unsubscribeLog) this.unsubscribeLog();
    this.unsubscribeLog = null;
  }

  async open() {
    this.drawer.open({ name: 'sync', title: 'Sync' });
    this.renderShell();
    this.rendered = true;
    await this.refresh();
  }

  renderShell() {
    const body = this.drawer.getBody();
    body.innerHTML = `
      <div class="sync-panel">
        <div class="sync-status">
          <div class="sync-status-line">Last synced: <strong id="sync-last-synced">—</strong></div>
          <div class="sync-status-line sync-status-mode" id="sync-mode-line"></div>
        </div>
        <div id="sync-machines"></div>
        <div id="sync-content"></div>
        <div class="sync-actions">
          <button type="button" id="sync-refresh" class="ghost-btn">Refresh diff</button>
          <button type="button" id="sync-pull" class="ghost-btn">Pull</button>
          <button type="button" id="sync-push" class="accent-btn primary">Push</button>
        </div>
        <details class="sync-log-wrap">
          <summary>Activity log</summary>
          <pre id="sync-log" class="log-pre" aria-live="polite"></pre>
        </details>
      </div>
    `;
    body.querySelector('#sync-refresh').addEventListener('click', () => this.refresh());
    body.querySelector('#sync-push').addEventListener('click', () => this.runPush());
    body.querySelector('#sync-pull').addEventListener('click', () => this.runPull());
    this.repaintLog();
  }

  async refresh() {
    if (this.busy) return;
    this.busy = true;
    this.setActionsBusy(true, 'Refreshing…');
    try {
      const [settings, diff, machines, resolutions] = await Promise.all([
        this.api.getSettings(),
        this.api.computeSyncDiff(),
        this.api.sync?.listKnownMachines?.() ?? Promise.resolve([]),
        this.api.sync?.listConflictResolutions?.() ?? Promise.resolve({}),
      ]);
      this.lastSettings = settings;
      this.currentDiff = diff;
      this.knownMachines = Array.isArray(machines) ? machines : [];
      this.resolutions = resolutions || {};
      this.renderStatus();
      this.renderMachines();
      this.renderContent();
      this.updateBadge();
    } catch (error) {
      this.renderError(error);
    } finally {
      this.busy = false;
      this.setActionsBusy(false);
    }
  }

  renderStatus() {
    const settings = this.lastSettings || {};
    const body = this.drawer.getBody();
    const last = body.querySelector('#sync-last-synced');
    if (last) last.textContent = formatRelative(settings.lastRefreshedAt);
    const mode = body.querySelector('#sync-mode-line');
    if (mode) {
      const label = settings.syncMode === 'git'
        ? `Git · ${settings.syncGitRemote || 'no remote configured'}`
        : settings.syncMode === 'local-folder'
          ? `Local folder · ${settings.syncLocalFolder || 'no folder configured'}`
          : 'Sync disabled';
      mode.textContent = label;
    }
  }

  renderMachines() {
    const container = this.drawer.getBody().querySelector('#sync-machines');
    if (!container) return;
    if (!this.knownMachines.length) {
      container.innerHTML = '';
      return;
    }
    const rows = this.knownMachines
      .map((m) => {
        const freshness = freshnessOf(m.lastPushAt);
        const platform = m.platform === 'darwin' ? 'macOS' : m.platform === 'win32' ? 'Windows' : m.platform || 'unknown';
        const selfBadge = m.isSelf ? '<span class="diff-chip diff-chip-info">this machine</span>' : '';
        const forget = m.isSelf ? '' : `<button type="button" class="ghost-btn machine-forget" data-id="${escape(m.id)}">Forget</button>`;
        return `
          <li class="machine-row">
            <span class="freshness-dot freshness-${freshness.tone}" title="${escape(freshness.label)}"></span>
            <div class="machine-row-body">
              <div class="machine-row-title">${escape(m.displayName || m.id)} ${selfBadge}</div>
              <div class="machine-row-sub">${escape(platform)}${m.hostname ? ` · ${escape(m.hostname)}` : ''} · last push ${escape(formatRelative(m.lastPushAt))}</div>
            </div>
            ${forget}
          </li>
        `;
      })
      .join('');
    container.innerHTML = `
      <section class="machines-section">
        <h3 class="section-title">Known machines</h3>
        <ul class="machine-list">${rows}</ul>
      </section>
    `;
    container.querySelectorAll('.machine-forget').forEach((btn) => {
      btn.addEventListener('click', () => this.forgetMachine(btn.dataset.id));
    });
  }

  async forgetMachine(id) {
    if (!id) return;
    if (!window.confirm(`Forget machine "${id}"? Its snapshot will be removed from the shared library on next push.`)) {
      return;
    }
    const res = await this.api.sync?.forgetMachine?.(id);
    if (res?.ok) {
      this.drawer.showToast('Machine forgotten');
      await this.refresh();
    } else {
      this.drawer.showToast(res?.error || 'Forget failed', { kind: 'err' });
    }
  }

  renderContent() {
    const container = this.drawer.getBody().querySelector('#sync-content');
    if (!container) return;
    container.innerHTML = '';

    if (!this.currentDiff?.ready) {
      container.appendChild(emptyState({
        reason: this.currentDiff?.reason,
        onOpenSettings: () => this.onOpenSettings?.(),
      }));
      this.setActionEnabled('sync-push', false);
      this.setActionEnabled('sync-pull', false);
      return;
    }

    const { songs, linkedPairs, history } = this.currentDiff;
    const machines = this.currentDiff.machines ?? this.knownMachines ?? [];

    const pushSongs = songs.localOnly.filter((s) => matchesSearch(s, this.filters.push));
    const pullSongs = songs.remoteOnly.filter((s) => matchesSearch(s, this.filters.pull));
    const conflictSongs = songs.conflicts.filter((s) => matchesSearch(s, this.filters.conflicts));

    container.innerHTML = `
      <section class="diff-section" data-section="push">
        ${sectionHeader({
          title: 'New here → shared library',
          songs: songs.localOnly.length,
          pairs: linkedPairs.localOnly.length,
          history: history.localOnly.length,
          sectionKey: 'push',
        })}
        ${this.renderSongList(pushSongs, { section: 'push', checkboxName: 'push-song' })}
        ${this.renderPairList(linkedPairs.localOnly)}
        ${this.renderHistoryList(history.localOnly)}
      </section>

      <section class="diff-section" data-section="pull">
        ${sectionHeader({
          title: 'New on shared library → this machine',
          songs: songs.remoteOnly.length,
          pairs: linkedPairs.remoteOnly.length,
          history: history.remoteOnly.length,
          sectionKey: 'pull',
        })}
        ${this.renderSongList(pullSongs, { section: 'pull', checkboxName: 'pull-song' })}
        ${this.renderPairList(linkedPairs.remoteOnly)}
        ${this.renderHistoryList(history.remoteOnly)}
      </section>

      <section class="diff-section" data-section="conflicts">
        ${sectionHeader({
          title: `Conflicts`,
          songs: songs.conflicts.length,
          sectionKey: 'conflicts',
        })}
        ${this.renderConflictList(conflictSongs, machines)}
      </section>
    `;

    this.wireSectionEvents();

    const canPush = songs.localOnly.length > 0 || linkedPairs.localOnly.length > 0;
    const canPull = songs.remoteOnly.length > 0 || linkedPairs.remoteOnly.length > 0 || history.remoteOnly.length > 0;
    this.setActionEnabled('sync-push', canPush);
    this.setActionEnabled('sync-pull', canPull);
  }

  renderSongList(songs, { section, checkboxName }) {
    if (!songs?.length) {
      return `<p class="diff-empty">No songs.</p>`;
    }
    return `<ul class="diff-list">${songs.map((s) => songRow(s, { section, checked: true, checkboxName })).join('')}</ul>`;
  }

  renderPairList(pairs) {
    if (!pairs?.length) return '';
    return `
      <div class="diff-subhead">Linked pairs</div>
      <ul class="diff-list">${pairs.map(pairRow).join('')}</ul>
    `;
  }

  renderHistoryList(files) {
    if (!files?.length) return '';
    return `
      <div class="diff-subhead">History files</div>
      <ul class="diff-list">${files.map(historyRow).join('')}</ul>
    `;
  }

  renderConflictList(conflicts, machines) {
    if (!conflicts?.length) {
      return `<p class="diff-empty">No conflicts. Newest edit will win automatically.</p>`;
    }
    return `<ul class="diff-list">${conflicts.map((c) => conflictRow(c, { resolution: this.resolutions[c.filePath] ?? null, machines })).join('')}</ul>`;
  }

  wireSectionEvents() {
    const body = this.drawer.getBody();
    body.querySelectorAll('.diff-search').forEach((input) => {
      input.value = this.filters[input.dataset.section] || '';
      input.addEventListener('input', () => {
        this.filters[input.dataset.section] = input.value;
        this.renderContent();
      });
    });

    body.querySelectorAll('.diff-resolve-local').forEach((btn) => {
      btn.addEventListener('click', () => this.setResolution(btn.dataset.file, 'local'));
    });
    body.querySelectorAll('.diff-resolve-remote').forEach((btn) => {
      btn.addEventListener('click', () => this.setResolution(btn.dataset.file, 'remote'));
    });
    body.querySelectorAll('.diff-resolve-clear').forEach((btn) => {
      btn.addEventListener('click', () => this.setResolution(btn.dataset.file, 'unset'));
    });
  }

  async setResolution(filePath, choice) {
    if (!filePath) return;
    const res = await this.api.sync?.setConflictResolution?.(filePath, choice);
    if (res?.ok !== false) {
      if (choice === 'unset') delete this.resolutions[filePath];
      else this.resolutions[filePath] = choice;
      this.renderContent();
    }
  }

  getSelectedFilePaths(section) {
    const body = this.drawer.getBody();
    const boxes = body.querySelectorAll(`.diff-section[data-section="${section}"] input[type="checkbox"]:not(:disabled)`);
    const out = [];
    boxes.forEach((b) => { if (b.checked && b.value) out.push(b.value); });
    return out;
  }

  renderError(error) {
    const container = this.drawer.getBody().querySelector('#sync-content');
    if (container) {
      container.innerHTML = `<div class="sync-error">${escape(error?.message || String(error))}</div>`;
    }
    this.setActionEnabled('sync-push', false);
    this.setActionEnabled('sync-pull', false);
  }

  setActionEnabled(id, enabled) {
    const btn = this.drawer.getBody().querySelector(`#${id}`);
    if (btn) btn.disabled = !enabled;
  }

  setActionsBusy(busy, label) {
    const body = this.drawer.getBody();
    for (const id of ['sync-refresh', 'sync-push', 'sync-pull']) {
      const btn = body.querySelector(`#${id}`);
      if (!btn) continue;
      if (busy) {
        btn.dataset.prevLabel = btn.dataset.prevLabel || btn.textContent;
        if (id === 'sync-refresh' && label) btn.textContent = label;
        btn.disabled = true;
      } else if (btn.dataset.prevLabel) {
        btn.textContent = btn.dataset.prevLabel;
        delete btn.dataset.prevLabel;
      }
    }
  }

  async runPush() {
    if (this.busy) return;
    this.busy = true;
    this.setActionsBusy(true);
    try {
      const filePaths = this.getSelectedFilePaths('push');
      const result = await this.api.syncPush({ filePaths: filePaths.length ? filePaths : undefined });
      if (!result?.ok) {
        this.drawer.showToast(result?.error || 'Push failed', { kind: 'err' });
      } else {
        this.drawer.showToast('Pushed to shared library');
      }
      await this.refreshSettings?.();
      setTimeout(() => this.refresh(), REFRESH_HINT_DELAY_MS);
    } catch (error) {
      this.drawer.showToast(error?.message || String(error), { kind: 'err' });
    } finally {
      this.busy = false;
      this.setActionsBusy(false);
    }
  }

  async runPull() {
    if (this.busy) return;
    this.busy = true;
    this.setActionsBusy(true);
    try {
      const filePaths = this.getSelectedFilePaths('pull');
      const result = await this.api.syncPull({ filePaths: filePaths.length ? filePaths : undefined });
      if (!result?.ok) {
        this.drawer.showToast(result?.error || 'Pull failed', { kind: 'err' });
      } else {
        this.drawer.showToast('Pulled from shared library');
      }
      await this.refreshSettings?.();
      setTimeout(() => this.refresh(), REFRESH_HINT_DELAY_MS);
    } catch (error) {
      this.drawer.showToast(error?.message || String(error), { kind: 'err' });
    } finally {
      this.busy = false;
      this.setActionsBusy(false);
    }
  }

  updateBadge() {
    if (!this.onSyncBadgeUpdate) return;
    if (!this.currentDiff?.ready) {
      this.onSyncBadgeUpdate({ up: 0, down: 0, ready: false });
      return;
    }
    const { songs, linkedPairs, history } = this.currentDiff;
    const up = songs.localOnly.length + linkedPairs.localOnly.length;
    const down = songs.remoteOnly.length + linkedPairs.remoteOnly.length + history.remoteOnly.length;
    this.onSyncBadgeUpdate({ up, down, ready: true });
  }

  appendLog(line) {
    if (!line) return;
    const timestamp = line.timestamp ? new Date(line.timestamp).toLocaleTimeString() : '';
    const source = line.source ? `[${line.source}]` : '';
    const level = (line.level || 'info').toUpperCase();
    const formatted = `${timestamp} ${level.padEnd(5)} ${source} ${line.msg || ''}`.trim();
    this.logLines.push(formatted);
    if (this.logLines.length > LOG_MAX_LINES) {
      this.logLines.splice(0, this.logLines.length - LOG_MAX_LINES);
    }
    if (this.rendered) this.repaintLog();
  }

  repaintLog() {
    const pre = this.drawer.getBody().querySelector('#sync-log');
    if (!pre) return;
    pre.textContent = this.logLines.join('\n');
    pre.scrollTop = pre.scrollHeight;
  }
}
