import { loadGraph } from './data/loadGraph.js';
import { runForceLayout } from './graph/layout.js';
import { GraphRenderer } from './graph/renderer.js';
import { LabelOverlay } from './graph/labels.js';
import { Tooltip } from './ui/tooltip.js';
import { Sidebar } from './ui/sidebar.js';
import { Search } from './ui/search.js';
import { Filters, applyFilters } from './ui/filters.js';
import { Drawer } from './ui/drawer.js';
import { SyncPanel } from './ui/sync.js';
import { SettingsPanel } from './ui/settings.js';
import { findMatches } from './match/findMatches.js';

const REHEAT_JITTER = 200;
const DESKTOP_ONLY_TOOLTIP = 'Desktop-only feature — download the app to use this';

function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing DOM element: #${id}`);
  return node;
}

function showError(message) {
  const banner = document.getElementById('error-banner');
  banner.textContent = message;
  banner.classList.remove('hidden');
}

function buildAdjacency(edges) {
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, []);
    adjacency.get(edge.source).push(edge);
    adjacency.get(edge.target).push(edge);
  }
  return adjacency;
}

function buildLinkedNeighbors(edges) {
  const linkedNeighbors = new Map();
  for (const edge of edges) {
    if (edge.type !== 'vdj_link' && edge.type !== 'history') continue;
    if (!linkedNeighbors.has(edge.source)) linkedNeighbors.set(edge.source, new Set());
    if (!linkedNeighbors.has(edge.target)) linkedNeighbors.set(edge.target, new Set());
    linkedNeighbors.get(edge.source).add(edge.target);
    linkedNeighbors.get(edge.target).add(edge.source);
  }
  return linkedNeighbors;
}

function neighborsOf(node, adjacency, nodesById) {
  const related = [];
  const history = [];
  const edges = adjacency.get(node.id) ?? [];
  for (const edge of edges) {
    const otherId = edge.source === node.id ? edge.target : edge.source;
    const other = nodesById.get(otherId);
    if (!other) continue;
    if (edge.type === 'vdj_link') related.push({ node: other, edge });
    else if (edge.type === 'history') history.push({ node: other, edge });
  }
  history.sort((a, b) => (b.edge.weight ?? 0) - (a.edge.weight ?? 0));
  related.sort((a, b) => (a.node.bpm ?? 0) - (b.node.bpm ?? 0));
  return { related, history };
}

function renderMetaSummary(meta) {
  const totals = meta?.totals ?? {};
  const edgeStats = meta?.edges ?? {};
  return `
    <div>${totals.songs ?? 0} songs · ${edgeStats.vdjLink ?? 0} related · ${edgeStats.history ?? 0} history</div>
    <div>${totals.inRelatedTrackPairs ?? 0} in linked pairs · ${totals.everPlayed ?? 0} ever played</div>
  `;
}

function countEdgesByType(edges) {
  const counts = { all: edges.length, related: 0, history: 0 };
  for (const edge of edges) {
    if (edge.type === 'vdj_link') counts.related += 1;
    else if (edge.type === 'history') counts.history += 1;
  }
  return counts;
}

function viewNoticeMessage(view, counts) {
  if (view === 'related' && counts.related === 0) {
    return `
      <strong>No related tracks yet.</strong>
      VirtualDJ stores manually linked tracks in <code>extra.db</code> → <code>related_tracks</code>.
      To create one, right-click a track in VirtualDJ → <em>Linked tracks</em> → add another track.
      After saving, run <code>npm run parse</code> to refresh the graph.
    `;
  }
  if (view === 'history' && counts.history === 0) {
    return `
      <strong>No history transitions found.</strong>
      Make sure VirtualDJ is writing session logs to <code>~/Library/Application Support/VirtualDJ/History/</code>,
      then re-run <code>npm run parse</code>.
    `;
  }
  return null;
}

function updateSyncBadge(badgeEl, counts) {
  if (!badgeEl) return;
  if (!counts || !counts.ready || (counts.up === 0 && counts.down === 0)) {
    badgeEl.hidden = true;
    badgeEl.textContent = '';
    return;
  }
  badgeEl.hidden = false;
  badgeEl.textContent = `↑${counts.up} ↓${counts.down}`;
}

function configureDesktopOnlyButton(button) {
  button.disabled = true;
  button.classList.add('is-disabled');
  button.title = DESKTOP_ONLY_TOOLTIP;
}

async function main() {
  const api = (typeof window !== 'undefined' && window.vdjApi) || null;

  const canvas = el('canvas');
  const tooltipEl = el('tooltip');
  const sidebarRoot = el('sidebar');
  const sidebarTitle = el('sidebar-title');
  const sidebarBody = el('sidebar-body');
  const sidebarClose = el('sidebar-close');
  const metaSummary = el('meta-summary');

  let graph;
  try {
    graph = await loadGraph();
  } catch (error) {
    showError(error.message);
    return;
  }

  const state = {
    nodes: graph.nodes,
    edges: graph.edges,
    nodesById: new Map(graph.nodes.map((n) => [n.id, n])),
    adjacency: buildAdjacency(graph.edges),
    linkedNeighbors: buildLinkedNeighbors(graph.edges),
    edgeCounts: countEdgesByType(graph.edges),
    meta: graph.meta,
  };

  metaSummary.innerHTML = renderMetaSummary(state.meta);

  await new Promise((resolve) => requestAnimationFrame(resolve));
  runForceLayout(state.nodes, state.edges);

  function matchesForAnchor(anchor, options) {
    const exclude = state.linkedNeighbors.get(anchor.id) ?? new Set();
    return findMatches(anchor, state.nodes, exclude, options);
  }

  const tooltip = new Tooltip(tooltipEl);
  const sidebar = new Sidebar({
    root: sidebarRoot,
    title: sidebarTitle,
    body: sidebarBody,
    closeButton: sidebarClose,
    onSelectNeighbor: (id) => selectNode(id, { recenter: false }),
    findMatches: matchesForAnchor,
  });

  const labelOverlay = new LabelOverlay(el('labels'));
  labelOverlay.setData(state.nodes);

  const renderer = new GraphRenderer(canvas, {
    onHover: (node, position) => {
      if (!node) {
        tooltip.hide();
        labelOverlay.setHovered(null);
      } else {
        tooltip.show(node, position);
        labelOverlay.setHovered(node.id);
      }
    },
    onClick: (node) => selectNode(node.id, { recenter: false }),
    onBackgroundClick: () => {
      sidebar.hide();
      renderer.setSelected(null);
      renderer.setHighlight(null);
      labelOverlay.setSelected(null);
      labelOverlay.setHighlight(null);
    },
    onCameraChange: () => labelOverlay.update(renderer.camera, canvas),
  });
  renderer.setData(state.nodes, state.edges);
  renderer.start();

  const tabButtons = [...document.querySelectorAll('#tabs .tab')];
  const viewNotice = el('view-notice');

  function refreshTabCounts() {
    for (const tab of tabButtons) {
      const view = tab.dataset.view;
      const count = state.edgeCounts[view] ?? 0;
      const countNode = tab.querySelector('.tab-count');
      if (countNode) countNode.textContent = count.toLocaleString();
      tab.dataset.empty = view !== 'all' && count === 0 ? 'true' : 'false';
    }
  }
  refreshTabCounts();

  const VIEW_PRIMARY_TYPE = { related: 'vdj_link', history: 'history' };
  const overlayControls = el('overlay-controls');
  const overlayChips = [...overlayControls.querySelectorAll('.overlay-chip')];

  function applyView(view, overlays) {
    for (const tab of tabButtons) {
      const isActive = tab.dataset.view === view;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
    labelOverlay.setMode(view === 'all' ? 'auto' : 'all');

    const primary = VIEW_PRIMARY_TYPE[view];
    if (primary) {
      overlayControls.classList.remove('hidden');
      for (const chip of overlayChips) {
        const type = chip.dataset.overlay;
        const isOther = type !== primary;
        chip.hidden = !isOther;
        const pressed = overlays ? overlays.has(type) : false;
        chip.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      }
    } else {
      overlayControls.classList.add('hidden');
    }

    const message = viewNoticeMessage(view, state.edgeCounts);
    if (message) {
      viewNotice.innerHTML = message;
      viewNotice.classList.remove('hidden');
    } else {
      viewNotice.classList.add('hidden');
    }
  }

  const filters = new Filters({
    elements: {
      bpmMin: el('bpm-min'),
      bpmMax: el('bpm-max'),
      key: el('key-filter'),
      genre: el('genre-filter'),
      hideIsolated: el('hide-isolated'),
      reset: el('reset-filters'),
    },
    onChange: (nextState) => {
      const visibility = applyFilters(nextState, state.nodes, state.edges);
      renderer.setVisibility(visibility);
      labelOverlay.setVisibility(visibility.visibleNodeIds);
      applyView(nextState.view, nextState.overlays);
      renderer.recenterCamera();
    },
  });
  filters.populate(state.nodes);
  applyView(filters.state.view, filters.state.overlays);
  const initialVisibility = applyFilters(filters.state, state.nodes, state.edges);
  renderer.setVisibility(initialVisibility);
  labelOverlay.setVisibility(initialVisibility.visibleNodeIds);
  renderer.recenterCamera();

  for (const tab of tabButtons) {
    tab.addEventListener('click', () => filters.setView(tab.dataset.view));
  }
  for (const chip of overlayChips) {
    chip.addEventListener('click', () => filters.toggleOverlay(chip.dataset.overlay));
  }

  const search = new Search({
    input: el('search'),
    results: el('search-results'),
    onSelect: (id) => selectNode(id, { recenter: true }),
  });
  search.setNodes(state.nodes);

  const colorSegs = document.querySelectorAll('.segmented .seg[data-color]');
  function applyColorMode(mode, { persist }) {
    if (!mode) return;
    let matched = null;
    colorSegs.forEach((b) => {
      const isActive = b.dataset.color === mode;
      b.classList.toggle('active', isActive);
      if (isActive) matched = b;
    });
    if (!matched) return;
    renderer.setColorMode(mode);
    if (persist && api?.saveSettings) {
      api.saveSettings({ colorMode: mode }).catch(() => {});
    }
  }
  colorSegs.forEach((btn) => {
    btn.addEventListener('click', () => applyColorMode(btn.dataset.color, { persist: true }));
  });

  el('recenter').addEventListener('click', () => renderer.recenterCamera());
  el('reheat').addEventListener('click', () => {
    for (const node of state.nodes) {
      node.x = (Math.random() - 0.5) * REHEAT_JITTER;
      node.y = (Math.random() - 0.5) * REHEAT_JITTER;
    }
    runForceLayout(state.nodes, state.edges);
    renderer.setData(state.nodes, state.edges, { colorMode: renderer.colorMode });
    const v = applyFilters(filters.state, state.nodes, state.edges);
    renderer.setVisibility(v);
    labelOverlay.setVisibility(v.visibleNodeIds);
  });

  function selectNode(id, { recenter }) {
    const node = state.nodesById.get(id);
    if (!node) return;
    renderer.setSelected(id);
    labelOverlay.setSelected(id);
    const { related, history } = neighborsOf(node, state.adjacency, state.nodesById);
    const highlightIds = new Set([
      id,
      ...related.map((n) => n.node.id),
      ...history.map((n) => n.node.id),
    ]);
    renderer.setHighlight(highlightIds);
    labelOverlay.setHighlight(highlightIds);
    sidebar.show(node, { related, history });
    el('hint-banner').classList.add('hidden');
    if (recenter) {
      renderer.flyTo(node.x, node.y, Math.max(renderer.targetZoom, 1.4));
    }
  }

  async function rebuildFromGraph(nextGraph) {
    state.nodes = nextGraph.nodes;
    state.edges = nextGraph.edges;
    state.nodesById = new Map(state.nodes.map((n) => [n.id, n]));
    state.adjacency = buildAdjacency(state.edges);
    state.linkedNeighbors = buildLinkedNeighbors(state.edges);
    state.edgeCounts = countEdgesByType(state.edges);
    state.meta = nextGraph.meta;

    metaSummary.innerHTML = renderMetaSummary(state.meta);
    labelOverlay.setData(state.nodes);
    search.setNodes(state.nodes);
    filters.populate(state.nodes);
    runForceLayout(state.nodes, state.edges);
    renderer.setData(state.nodes, state.edges, { colorMode: renderer.colorMode });
    refreshTabCounts();

    const visibility = applyFilters(filters.state, state.nodes, state.edges);
    renderer.setVisibility(visibility);
    labelOverlay.setVisibility(visibility.visibleNodeIds);
    applyView(filters.state.view, filters.state.overlays);
    renderer.recenterCamera();
    sidebar.hide();
  }

  wireDrawerAndPanels({ api, rebuildFromGraph, applyColorMode });
}

function wireDrawerAndPanels({ api, rebuildFromGraph, applyColorMode }) {
  const drawerRoot = el('drawer');
  const drawerTitle = el('drawer-title');
  const drawerBody = el('drawer-body');
  const drawerClose = el('drawer-close');
  const btnSync = el('btn-sync');
  const btnSettings = el('btn-settings');
  const syncBadge = document.getElementById('sync-badge');
  const refreshBtn = el('refresh-library');

  if (!api) {
    configureDesktopOnlyButton(btnSync);
    configureDesktopOnlyButton(btnSettings);
    refreshBtn.hidden = true;
    return;
  }

  const drawer = new Drawer({
    root: drawerRoot,
    titleEl: drawerTitle,
    bodyEl: drawerBody,
    closeButton: drawerClose,
  });

  const settingsPanel = new SettingsPanel({
    api,
    drawer,
    onSettingsChanged: (settings) => applySettingsToUi(settings, { applyColorMode }),
  });

  const syncPanel = new SyncPanel({
    api,
    drawer,
    onSyncBadgeUpdate: (counts) => updateSyncBadge(syncBadge, counts),
    onOpenSettings: () => settingsPanel.open(),
    refreshSettings: () => settingsPanel.load(),
  });
  syncPanel.attach();

  btnSync.addEventListener('click', () => {
    if (drawer.isPanelOpen('sync')) drawer.close();
    else syncPanel.open();
  });
  btnSettings.addEventListener('click', () => {
    if (drawer.isPanelOpen('settings')) drawer.close();
    else settingsPanel.open();
  });

  refreshBtn.hidden = false;
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    const prevLabel = refreshBtn.textContent;
    refreshBtn.textContent = 'Refreshing…';
    try {
      const result = await api.refreshLibrary();
      if (!result?.ok) {
        showError(result?.error || 'Refresh failed');
        return;
      }
      const nextGraph = await loadGraph();
      await rebuildFromGraph(nextGraph);
    } catch (error) {
      showError(error?.message || String(error));
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = prevLabel;
    }
  });

  api.getSettings().then((settings) => applySettingsToUi(settings, { applyColorMode })).catch(() => {});
}

function applySettingsToUi(settings, { applyColorMode }) {
  if (!settings) return;
  if (settings.colorMode) {
    applyColorMode?.(settings.colorMode, { persist: false });
  }
}

main().catch((error) => {
  console.error(error);
  showError(error.message ?? String(error));
});
