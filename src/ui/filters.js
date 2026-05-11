function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
}

function uniqueCamelot(values) {
  const set = new Set(values.filter(Boolean));
  return [...set].sort((a, b) => {
    const [, an, al] = /^([1-9]|1[0-2])([AB])$/.exec(a) ?? [, 99, 'Z'];
    const [, bn, bl] = /^([1-9]|1[0-2])([AB])$/.exec(b) ?? [, 99, 'Z'];
    if (Number(an) !== Number(bn)) return Number(an) - Number(bn);
    return String(al).localeCompare(String(bl));
  });
}

// Each tab has a primary edge type that is always on. Overlays let the user
// additively layer the *other* type on top of the focused tab without
// switching the view. The "all" tab has both primary types on, so overlays
// have no effect there.
const VIEW_PRESETS = {
  all:     { vdj: true,  history: true  },
  related: { vdj: true,  history: false },
  history: { vdj: false, history: true  },
};

const DEFAULT_VIEW = 'related';

// Edge type keys used in graph.json — kept here as constants so the rest of
// the module never repeats the magic strings.
const EDGE_VDJ = 'vdj_link';
const EDGE_HISTORY = 'history';

export class Filters {
  constructor({ elements, onChange }) {
    this.elements = elements;
    this.onChange = onChange;
    this.view = DEFAULT_VIEW;
    // Set of edge type strings that should be layered on top of the active
    // view. Cleared on every view switch so each tab starts "clean".
    this.overlays = new Set();
    this.state = this.read();
    this.bind();
  }

  bind() {
    const trigger = () => {
      this.state = this.read();
      this.onChange(this.state);
    };
    ['bpmMin', 'bpmMax'].forEach((k) => this.elements[k].addEventListener('input', trigger));
    ['key', 'genre'].forEach((k) => this.elements[k].addEventListener('change', trigger));
    this.elements.hideIsolated.addEventListener('change', trigger);
    this.elements.reset.addEventListener('click', () => this.reset());
  }

  populate(nodes) {
    const keys = uniqueCamelot(nodes.map((n) => n.camelotKey));
    const genres = uniqueSorted(nodes.map((n) => n.genre));
    this.elements.key.innerHTML =
      '<option value="">Any</option>' +
      keys.map((k) => `<option value="${k}">${k}</option>`).join('');
    this.elements.genre.innerHTML =
      '<option value="">Any</option>' +
      genres.map((g) => `<option value="${g}">${g}</option>`).join('');
  }

  setView(view) {
    if (!VIEW_PRESETS[view]) return;
    if (view === this.view) return;
    this.view = view;
    // Switching tabs is treated as a fresh focus — drop any overlays from the
    // previous view so the new tab starts in its primary-only state.
    this.overlays.clear();
    this.state = this.read();
    this.onChange(this.state);
  }

  /**
   * Toggle an additive layer on top of the active view. Has no effect when the
   * type is already implied by the active view's preset (e.g. toggling
   * "history" on the History tab is a no-op).
   */
  toggleOverlay(edgeType) {
    if (edgeType !== EDGE_VDJ && edgeType !== EDGE_HISTORY) return;
    const preset = VIEW_PRESETS[this.view] ?? VIEW_PRESETS[DEFAULT_VIEW];
    const presetIncludes = edgeType === EDGE_VDJ ? preset.vdj : preset.history;
    if (presetIncludes) return;
    if (this.overlays.has(edgeType)) {
      this.overlays.delete(edgeType);
    } else {
      this.overlays.add(edgeType);
    }
    this.state = this.read();
    this.onChange(this.state);
  }

  read() {
    const preset = VIEW_PRESETS[this.view] ?? VIEW_PRESETS[DEFAULT_VIEW];
    const showVdj = preset.vdj || this.overlays.has(EDGE_VDJ);
    const showHistory = preset.history || this.overlays.has(EDGE_HISTORY);
    return {
      view: this.view,
      overlays: new Set(this.overlays),
      bpmMin: this.elements.bpmMin.value === '' ? null : Number(this.elements.bpmMin.value),
      bpmMax: this.elements.bpmMax.value === '' ? null : Number(this.elements.bpmMax.value),
      key: this.elements.key.value || null,
      genre: this.elements.genre.value || null,
      hideIsolated: this.elements.hideIsolated.checked,
      showVdj,
      showHistory,
    };
  }

  reset() {
    this.elements.bpmMin.value = '';
    this.elements.bpmMax.value = '';
    this.elements.key.value = '';
    this.elements.genre.value = '';
    this.elements.hideIsolated.checked = false;
    this.view = DEFAULT_VIEW;
    this.overlays.clear();
    this.state = this.read();
    this.onChange(this.state);
  }
}

export function applyFilters(state, nodes, edges) {
  const visibleEdgeTypes = new Set();
  if (state.showVdj) visibleEdgeTypes.add('vdj_link');
  if (state.showHistory) visibleEdgeTypes.add('history');

  const visibleByMetadata = new Set();
  for (const node of nodes) {
    if (state.bpmMin != null && (node.bpm == null || node.bpm < state.bpmMin)) continue;
    if (state.bpmMax != null && (node.bpm == null || node.bpm > state.bpmMax)) continue;
    if (state.key && node.camelotKey !== state.key) continue;
    if (state.genre && (node.genre ?? '') !== state.genre) continue;
    visibleByMetadata.add(node.id);
  }

  // Non-"all" tabs implicitly hide nodes that don't participate in any edge of
  // the active type. The "all" tab only collapses isolated nodes when the user
  // explicitly opts in via the checkbox.
  const restrictToConnected = state.hideIsolated || state.view !== 'all';
  if (!restrictToConnected) {
    return { visibleNodeIds: visibleByMetadata, visibleEdgeTypes };
  }

  const connected = new Set();
  for (const edge of edges) {
    if (!visibleEdgeTypes.has(edge.type)) continue;
    if (visibleByMetadata.has(edge.source) && visibleByMetadata.has(edge.target)) {
      connected.add(edge.source);
      connected.add(edge.target);
    }
  }
  return { visibleNodeIds: connected, visibleEdgeTypes };
}
