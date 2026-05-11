import { loadGraph } from './data/loadGraph.js';
import { runForceLayout } from './graph/layout.js';
import { GraphRenderer } from './graph/renderer.js';
import { LabelOverlay } from './graph/labels.js';
import { Tooltip } from './ui/tooltip.js';
import { Sidebar } from './ui/sidebar.js';
import { Search } from './ui/search.js';
import { Filters, applyFilters } from './ui/filters.js';
import { findMatches } from './match/findMatches.js';

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

async function main() {
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

  const nodes = graph.nodes;
  const edges = graph.edges;
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const adjacency = buildAdjacency(edges);

  metaSummary.innerHTML = renderMetaSummary(graph.meta);

  await new Promise((resolve) => requestAnimationFrame(resolve));
  runForceLayout(nodes, edges);

  // Build the per-node "already linked" exclusion set so the match finder only
  // surfaces *new* candidates the user hasn't yet linked or played alongside.
  const linkedNeighbors = new Map();
  for (const edge of edges) {
    if (edge.type !== 'vdj_link' && edge.type !== 'history') continue;
    if (!linkedNeighbors.has(edge.source)) linkedNeighbors.set(edge.source, new Set());
    if (!linkedNeighbors.has(edge.target)) linkedNeighbors.set(edge.target, new Set());
    linkedNeighbors.get(edge.source).add(edge.target);
    linkedNeighbors.get(edge.target).add(edge.source);
  }

  function matchesForAnchor(anchor, options) {
    const exclude = linkedNeighbors.get(anchor.id) ?? new Set();
    return findMatches(anchor, nodes, exclude, options);
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
  labelOverlay.setData(nodes);

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
  renderer.setData(nodes, edges);
  renderer.start();

  const edgeCounts = countEdgesByType(edges);
  const tabButtons = [...document.querySelectorAll('#tabs .tab')];
  const viewNotice = el('view-notice');

  for (const tab of tabButtons) {
    const view = tab.dataset.view;
    const count = edgeCounts[view] ?? 0;
    const countNode = tab.querySelector('.tab-count');
    if (countNode) countNode.textContent = count.toLocaleString();
    tab.dataset.empty = view !== 'all' && count === 0 ? 'true' : 'false';
  }

  // Map of tab view → which edge type is its "primary" type. Overlay chips for
  // the *other* type are only meaningful on tabs whose primary doesn't already
  // include that type.
  const VIEW_PRIMARY_TYPE = { related: 'vdj_link', history: 'history' };
  const overlayControls = el('overlay-controls');
  const overlayChips = [...overlayControls.querySelectorAll('.overlay-chip')];

  function applyView(view, overlays) {
    for (const tab of tabButtons) {
      const isActive = tab.dataset.view === view;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
    // Show all node labels in sparse views; auto-show only on hover/select for dense views.
    labelOverlay.setMode(view === 'all' ? 'auto' : 'all');

    // Overlay chips are only relevant on the focused single-type tabs. On
    // "all" everything is already visible, so the chips would be no-ops.
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

    const message = viewNoticeMessage(view, edgeCounts);
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
    onChange: (state) => {
      const visibility = applyFilters(state, nodes, edges);
      renderer.setVisibility(visibility);
      labelOverlay.setVisibility(visibility.visibleNodeIds);
      applyView(state.view, state.overlays);
      renderer.recenterCamera();
    },
  });
  filters.populate(nodes);
  applyView(filters.state.view, filters.state.overlays);
  const initialVisibility = applyFilters(filters.state, nodes, edges);
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
  search.setNodes(nodes);

  document.querySelectorAll('.segmented .seg').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.segmented .seg').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderer.setColorMode(btn.dataset.color);
    });
  });

  el('recenter').addEventListener('click', () => renderer.recenterCamera());
  el('reheat').addEventListener('click', () => {
    for (const node of nodes) {
      node.x = (Math.random() - 0.5) * 200;
      node.y = (Math.random() - 0.5) * 200;
    }
    runForceLayout(nodes, edges);
    renderer.setData(nodes, edges, { colorMode: renderer.colorMode });
    const v = applyFilters(filters.state, nodes, edges);
    renderer.setVisibility(v);
    labelOverlay.setVisibility(v.visibleNodeIds);
  });

  function selectNode(id, { recenter }) {
    const node = nodesById.get(id);
    if (!node) return;
    renderer.setSelected(id);
    labelOverlay.setSelected(id);
    const { related, history } = neighborsOf(node, adjacency, nodesById);
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
}

main().catch((error) => {
  console.error(error);
  showError(error.message ?? String(error));
});
