function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function row(label, value, { mono = false } = {}) {
  if (value == null || value === '') return '';
  return `<dt>${escape(label)}</dt><dd${mono ? ' class="mono"' : ''}>${escape(value)}</dd>`;
}

const DEFAULTS = {
  bpmTolerance: 3,
  allowHalfDouble: false,
  keyOnly: false,
  genreOnly: false,
};

function trackSummary(node) {
  if (!node) return '';
  const parts = [];
  if (node.artist) parts.push(node.artist);
  if (node.bpm != null) parts.push(`${node.bpm} BPM`);
  const keyLabel = node.camelotKey || node.key;
  if (keyLabel) parts.push(keyLabel);
  if (node.genre) parts.push(node.genre);
  return parts.join(' · ');
}

function neighborSubtitle(neighbor) {
  const parts = [];
  if (neighbor.bpm != null) parts.push(`${neighbor.bpm} BPM`);
  const keyLabel = neighbor.camelotKey || neighbor.key;
  if (keyLabel) parts.push(keyLabel);
  if (neighbor.genre) parts.push(neighbor.genre);
  return parts.join(' · ') || '—';
}

export class Sidebar {
  constructor({ root, title, subtitle, body, closeButton, onSelectNeighbor, findMatches }) {
    this.root = root;
    this.title = title;
    this.subtitle = subtitle;
    this.body = body;
    this.onSelectNeighbor = onSelectNeighbor;
    this.findMatches = findMatches;
    this.matchOptions = { ...DEFAULTS };
    this.currentNode = null;
    this.currentNeighbors = null;
    closeButton.addEventListener('click', () => this.hide());
  }

  hide() {
    this.root.classList.add('hidden');
    this.root.setAttribute('aria-hidden', 'true');
    this.currentNode = null;
  }

  show(node, neighbors) {
    if (!node) return this.hide();
    this.root.classList.remove('hidden');
    this.root.setAttribute('aria-hidden', 'false');
    this.currentNode = node;
    this.currentNeighbors = neighbors;
    this.title.textContent = node.displayName || '(untitled)';
    if (this.subtitle) this.subtitle.textContent = trackSummary(node);
    this.render();
  }

  render() {
    const node = this.currentNode;
    const neighbors = this.currentNeighbors;
    if (!node) return;

    const meta = `
      <dl class="kv">
        ${row('Artist', node.artist)}
        ${row('Title', node.title)}
        ${row('BPM', node.bpm)}
        ${row('Key', [node.key, node.camelotKey].filter(Boolean).join(' / '))}
        ${row('Genre', node.genre)}
        ${row('Remix', node.remix)}
        ${row('Year', node.year)}
        ${row('Length', node.songLength ? `${Math.round(node.songLength)} s` : null)}
        ${row('Linked', node.linkedCount)}
        ${row('History plays', node.historyPlayCount || null)}
        ${row('Source', node.netSearchRef ? `NetSearch (${node.netSearchRef})` : node.filePath, { mono: !node.netSearchRef })}
      </dl>
    `;

    const relatedList = neighbors.related
      .map(
        ({ node: n }) => `
          <li class="vdj" data-id="${escape(n.id)}">
            <div>
              <div class="item-body-title">${escape(n.displayName)}</div>
              <div class="item-body-sub">${escape(neighborSubtitle(n))}</div>
            </div>
            <div class="pill-badge">linked</div>
          </li>
        `
      )
      .join('');

    const historyList = neighbors.history
      .slice(0, 12)
      .map(
        ({ node: n, edge }) => `
          <li class="history" data-id="${escape(n.id)}">
            <div>
              <div class="item-body-title">${escape(n.displayName)}</div>
              <div class="item-body-sub">${escape(neighborSubtitle(n))}</div>
            </div>
            <div class="pill-badge">×${escape(edge.weight ?? 1)}</div>
          </li>
        `
      )
      .join('');

    const matches = this.computeMatches();
    const matchList = matches
      .map(
        ({ node: n, score, reasons }) => `
          <li class="match" data-id="${escape(n.id)}">
            <div>
              <div class="item-body-title">${escape(n.displayName)}</div>
              <div class="item-body-sub">${reasons.map(escape).join(' · ')}</div>
            </div>
            <div class="pill-badge">${escape(score)}</div>
          </li>
        `
      )
      .join('');

    const o = this.matchOptions;
    const matchControls = node.bpm == null
      ? `<p class="muted-note">Anchor track has no BPM, so compatible matches can't be ranked.</p>`
      : `
        <div class="match-controls">
          <label>BPM tolerance <strong id="match-tol-label">±${o.bpmTolerance.toFixed(1)}</strong>
            <input id="match-tol" type="range" min="0" max="15" step="0.5" value="${o.bpmTolerance}" />
          </label>
          <div class="match-toggles">
            <label class="checkbox"><input id="match-half" type="checkbox" ${o.allowHalfDouble ? 'checked' : ''}/> <span>Allow half/double-time</span></label>
            <label class="checkbox"><input id="match-key" type="checkbox" ${o.keyOnly ? 'checked' : ''}/> <span>Compatible key only</span></label>
            <label class="checkbox"><input id="match-genre" type="checkbox" ${o.genreOnly ? 'checked' : ''}/> <span>Same genre only</span></label>
          </div>
          <div class="match-anchor">Anchor · ${escape(node.bpm)} BPM${node.camelotKey ? ' · ' + escape(node.camelotKey) : ''}${node.genre ? ' · ' + escape(node.genre) : ''}</div>
        </div>
      `;

    this.body.innerHTML = `
      ${meta}

      <h3 class="section-heading" data-kind="vdj">Related Tracks (${neighbors.related.length})</h3>
      ${neighbors.related.length
        ? `<ul class="item-list">${relatedList}</ul>`
        : `<p class="muted-note">Not linked to any other track in <code>extra.db</code>.</p>`}

      <h3 class="section-heading" data-kind="history">Played around this (${neighbors.history.length})</h3>
      ${neighbors.history.length
        ? `<ul class="item-list">${historyList}</ul>${neighbors.history.length > 12 ? `<p class="more-note">+${neighbors.history.length - 12} more</p>` : ''}`
        : `<p class="muted-note">No history transitions recorded.</p>`}

      <h3 class="section-heading" data-kind="match">Find compatible matches</h3>
      ${matchControls}
      ${matches.length
        ? `<ul class="item-list">${matchList}</ul>`
        : `<p class="muted-note">No candidates match the current filters. Widen the BPM tolerance or relax the key/genre toggles.</p>`}
    `;

    this.body.querySelectorAll('li[data-id]').forEach((li) => {
      li.addEventListener('click', () => {
        const id = li.getAttribute('data-id');
        if (id && this.onSelectNeighbor) this.onSelectNeighbor(id);
      });
    });

    const tol = this.body.querySelector('#match-tol');
    if (tol) {
      tol.addEventListener('input', (e) => {
        this.matchOptions.bpmTolerance = Number(e.target.value);
        const label = this.body.querySelector('#match-tol-label');
        if (label) label.textContent = `±${this.matchOptions.bpmTolerance.toFixed(1)}`;
        this.refreshMatches();
      });
    }
    const halfToggle = this.body.querySelector('#match-half');
    if (halfToggle) halfToggle.addEventListener('change', (e) => {
      this.matchOptions.allowHalfDouble = e.target.checked;
      this.refreshMatches();
    });
    const keyToggle = this.body.querySelector('#match-key');
    if (keyToggle) keyToggle.addEventListener('change', (e) => {
      this.matchOptions.keyOnly = e.target.checked;
      this.refreshMatches();
    });
    const genreToggle = this.body.querySelector('#match-genre');
    if (genreToggle) genreToggle.addEventListener('change', (e) => {
      this.matchOptions.genreOnly = e.target.checked;
      this.refreshMatches();
    });
  }

  computeMatches() {
    if (!this.currentNode || !this.findMatches) return [];
    return this.findMatches(this.currentNode, this.matchOptions);
  }

  /**
   * Fast partial re-render: swap out just the match list so the BPM slider
   * keeps focus and the sidebar doesn't scroll to the top on every change.
   */
  refreshMatches() {
    const matches = this.computeMatches();
    const controls = this.body.querySelector('.match-controls');
    if (!controls) return;
    let next = controls.nextElementSibling;
    while (next && next.tagName !== 'UL' && next.tagName !== 'P') next = next.nextElementSibling;
    if (next) next.remove();

    if (matches.length === 0) {
      const p = document.createElement('p');
      p.className = 'muted-note';
      p.textContent = 'No candidates match the current filters. Widen the BPM tolerance or relax the key/genre toggles.';
      controls.parentElement.appendChild(p);
      return;
    }

    const ul = document.createElement('ul');
    ul.className = 'item-list';
    ul.innerHTML = matches
      .map(
        ({ node: n, score, reasons }) => `
          <li class="match" data-id="${escape(n.id)}">
            <div>
              <div class="item-body-title">${escape(n.displayName)}</div>
              <div class="item-body-sub">${reasons.map(escape).join(' · ')}</div>
            </div>
            <div class="pill-badge">${escape(score)}</div>
          </li>
        `
      )
      .join('');
    ul.querySelectorAll('li[data-id]').forEach((li) => {
      li.addEventListener('click', () => {
        const id = li.getAttribute('data-id');
        if (id && this.onSelectNeighbor) this.onSelectNeighbor(id);
      });
    });
    controls.parentElement.appendChild(ul);
  }
}
