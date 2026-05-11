/**
 * HTML label overlay that follows nodes in screen space.
 *
 * One <div> per node. Per frame we only iterate the labels that should
 * actually be visible (`visibleSet`), not all 500+ nodes.
 *
 * Visibility policy:
 *   - mode 'auto' : labels appear only for selected/hovered/highlighted nodes
 *                   (default for dense views like "All edges")
 *   - mode 'all'  : every visible node gets a label, capped at MAX_ALL_LABELS
 *                   so a dense graph doesn't shower the screen with text
 *
 * Performance notes:
 *   - `visibleSet` is recomputed only on state changes (filter, selection,
 *     highlight, mode). Per-frame work is O(|visibleSet|), not O(|nodes|).
 *   - Class toggles for selection/highlight are applied incrementally on
 *     state change, never inside the per-frame loop.
 *   - We cache the last transform string per label and skip the DOM write
 *     when the value is unchanged (very common at low-zoom rest).
 */
const MAX_ALL_LABELS = 80;
const TRUNCATE_AT = 28;

function truncate(text) {
  if (!text) return '';
  if (text.length <= TRUNCATE_AT) return text;
  return text.slice(0, TRUNCATE_AT - 1) + '…';
}

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

export class LabelOverlay {
  constructor(container) {
    this.container = container;
    this.labels = new Map();           // node.id -> HTMLDivElement
    this.lastTransforms = new Map();   // node.id -> last transform string
    this.visibleSet = new Set();       // ids whose labels are currently shown
    this.mode = 'auto';
    this.nodes = [];
    this.nodesById = new Map();
    this.visibleIds = null;
    this.highlightedIds = null;
    this.selectedId = null;
    this.hoveredId = null;
  }

  setData(nodes) {
    this.nodes = nodes;
    this.nodesById = new Map(nodes.map((n) => [n.id, n]));
    this.rebuild();
    this.recomputeVisibleSet();
  }

  rebuild() {
    this.container.innerHTML = '';
    this.labels.clear();
    this.lastTransforms.clear();
    for (const node of this.nodes) {
      const el = document.createElement('div');
      el.className = 'graph-label';
      el.dataset.id = node.id;
      el.style.display = 'none';
      el.innerHTML = `
        <span class="label-text">${escape(truncate(node.displayName))}</span>
        <span class="label-meta">${node.bpm ?? '—'}${node.camelotKey ? ' · ' + escape(node.camelotKey) : ''}</span>
      `;
      this.container.appendChild(el);
      this.labels.set(node.id, el);
    }
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.recomputeVisibleSet();
  }

  setVisibility(visibleIds) {
    this.visibleIds = visibleIds;
    this.recomputeVisibleSet();
  }

  setHighlight(ids) {
    const prev = this.highlightedIds;
    this.highlightedIds = ids ? new Set(ids) : null;

    // Visibility may change in 'auto' mode (highlights become visible).
    this.recomputeVisibleSet();

    // Apply class changes only to ids whose state actually flipped.
    const changed = new Set();
    if (prev) for (const id of prev) changed.add(id);
    if (this.highlightedIds) for (const id of this.highlightedIds) changed.add(id);
    for (const id of changed) this.applyClasses(id);
  }

  setSelected(id) {
    if (id === this.selectedId) return;
    const prev = this.selectedId;
    this.selectedId = id;
    this.recomputeVisibleSet();
    if (prev) this.applyClasses(prev);
    if (id) this.applyClasses(id);
  }

  setHovered(id) {
    if (id === this.hoveredId) return;
    const prev = this.hoveredId;
    this.hoveredId = id;
    // Hover only affects 'auto' mode visibility.
    if (this.mode === 'auto') this.recomputeVisibleSet();
  }

  shouldShow(node) {
    const visible = this.visibleIds == null || this.visibleIds.has(node.id);
    if (!visible) return false;
    if (node.id === this.selectedId) return true;
    if (node.id === this.hoveredId) return true;
    if (this.highlightedIds && this.highlightedIds.has(node.id)) return true;
    if (this.mode === 'all') {
      const visibleCount = this.visibleIds ? this.visibleIds.size : this.nodes.length;
      if (visibleCount > MAX_ALL_LABELS) return false;
      return true;
    }
    return false;
  }

  recomputeVisibleSet() {
    const next = new Set();
    for (const node of this.nodes) {
      if (this.shouldShow(node)) next.add(node.id);
    }
    // Hide labels that left the visible set.
    for (const id of this.visibleSet) {
      if (next.has(id)) continue;
      const el = this.labels.get(id);
      if (!el) continue;
      el.style.display = 'none';
      // Drop the cached transform so re-show forces a fresh write.
      this.lastTransforms.delete(id);
    }
    // Show labels that entered the visible set.
    for (const id of next) {
      if (this.visibleSet.has(id)) continue;
      const el = this.labels.get(id);
      if (el) el.style.display = '';
    }
    this.visibleSet = next;
  }

  applyClasses(id) {
    const el = this.labels.get(id);
    if (!el) return;
    const isSelected = id === this.selectedId;
    const isHighlighted = this.highlightedIds ? this.highlightedIds.has(id) : false;
    el.classList.toggle('label-selected', isSelected);
    el.classList.toggle('label-highlighted', isHighlighted);
  }

  update(camera, canvas) {
    if (this.visibleSet.size === 0) return;
    const halfWidth = canvas.clientWidth / 2;
    const halfHeight = canvas.clientHeight / 2;
    // Hoist matrix elements out of the per-node loop.
    const e = camera.matrixWorldInverse.elements;
    const p = camera.projectionMatrix.elements;

    for (const id of this.visibleSet) {
      const node = this.nodesById.get(id);
      const el = this.labels.get(id);
      if (!node || !el) continue;

      // Manual projection: world → view → clip → ndc → screen.
      // z is always 0 in our 2D layout, so those terms drop out.
      const x = node.x;
      const y = node.y;
      const vx = e[0] * x + e[4] * y + e[12];
      const vy = e[1] * x + e[5] * y + e[13];
      const vz = e[2] * x + e[6] * y + e[14];
      const vw = e[3] * x + e[7] * y + e[15] || 1;

      const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12] * vw;
      const cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13] * vw;
      const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15] * vw || 1;

      // Round to integer pixels: dedupe sub-pixel transform writes when the
      // camera is essentially at rest and avoid blurry text.
      const screenX = Math.round((cx / cw) * halfWidth + halfWidth);
      const screenY = Math.round(-(cy / cw) * halfHeight + halfHeight);
      const transform = `translate(${screenX}px, ${screenY}px) translate(-50%, 0)`;

      if (this.lastTransforms.get(id) !== transform) {
        el.style.transform = transform;
        this.lastTransforms.set(id, transform);
      }
    }
  }
}
