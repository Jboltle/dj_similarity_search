/**
 * Cluster-packed layout.
 *
 *   1. Build adjacency from edges.
 *   2. Find connected components via BFS.
 *   3. Run a local force simulation inside each component.
 *   4. Compute each component's bounding circle.
 *   5. Pack the components into a grid sized by area.
 *
 * This avoids the "everything floats apart" look you get when a force sim
 * runs across many small disconnected pairs. Each pair gets its own little
 * island, and the islands are arranged by size for readability.
 */

const TICKS = 220;
const REPULSION = 1500;
const SPRING_LENGTH = 55;
const SPRING_STRENGTH = 0.06;
const CENTER_STRENGTH = 0.04;
const VELOCITY_DECAY = 0.78;
const MAX_VELOCITY = 8;
const COLLISION_RADIUS = 9;

const ISOLATED_RADIUS = 18;
const CLUSTER_PADDING = 60;

function jitter() {
  return (Math.random() - 0.5) * 1e-3;
}

function buildAdjacency(nodes, edges) {
  const adjacency = new Map();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    if (adjacency.has(edge.source)) adjacency.get(edge.source).push(edge.target);
    if (adjacency.has(edge.target)) adjacency.get(edge.target).push(edge.source);
  }
  return adjacency;
}

function findComponents(nodes, adjacency) {
  const visited = new Set();
  const components = [];
  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    const queue = [node.id];
    const component = [];
    visited.add(node.id);
    while (queue.length) {
      const id = queue.shift();
      component.push(id);
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    components.push(component);
  }
  return components;
}

function localForceSim(componentNodes, componentEdges, ticks) {
  if (componentNodes.length === 1) {
    componentNodes[0].x = 0;
    componentNodes[0].y = 0;
    return;
  }
  if (componentNodes.length === 2) {
    componentNodes[0].x = -SPRING_LENGTH / 2;
    componentNodes[0].y = 0;
    componentNodes[1].x = SPRING_LENGTH / 2;
    componentNodes[1].y = 0;
    return;
  }

  const radius = Math.sqrt(componentNodes.length) * 18;
  for (const node of componentNodes) {
    if (node.x == null || node.y == null) {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      node.x = Math.cos(angle) * r;
      node.y = Math.sin(angle) * r;
    } else {
      // Reset to a small random scatter to escape any earlier layout.
      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      node.x = Math.cos(angle) * r;
      node.y = Math.sin(angle) * r;
    }
    node.vx = 0;
    node.vy = 0;
  }

  for (let t = 0; t < ticks; t += 1) {
    // Repulsion (n^2 within component, fine for small components).
    for (let i = 0; i < componentNodes.length; i += 1) {
      const a = componentNodes[i];
      for (let j = i + 1; j < componentNodes.length; j += 1) {
        const b = componentNodes[j];
        const dx = a.x - b.x + jitter();
        const dy = a.y - b.y + jitter();
        const distSq = dx * dx + dy * dy || 1;
        const force = REPULSION / distSq;
        const dist = Math.sqrt(distSq);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;

        if (dist < COLLISION_RADIUS * 2) {
          const overlap = COLLISION_RADIUS * 2 - dist;
          const ox = (dx / dist) * overlap * 0.5;
          const oy = (dy / dist) * overlap * 0.5;
          a.x += ox;
          a.y += oy;
          b.x -= ox;
          b.y -= oy;
        }
      }
    }

    // Springs.
    for (const edge of componentEdges) {
      const a = edge.a;
      const b = edge.b;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const strength = edge.type === 'vdj_link' ? SPRING_STRENGTH * 1.4 : SPRING_STRENGTH;
      const offset = (dist - SPRING_LENGTH) * strength;
      const fx = (dx / dist) * offset;
      const fy = (dy / dist) * offset;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    // Centering toward (0,0) so the component doesn't drift away.
    for (const node of componentNodes) {
      node.vx -= node.x * CENTER_STRENGTH;
      node.vy -= node.y * CENTER_STRENGTH;
      node.vx *= VELOCITY_DECAY;
      node.vy *= VELOCITY_DECAY;
      node.vx = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, node.vx));
      node.vy = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, node.vy));
      node.x += node.vx;
      node.y += node.vy;
    }
  }
}

function componentBounds(componentNodes) {
  if (componentNodes.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
  if (componentNodes.length === 1) {
    return { minX: -ISOLATED_RADIUS, minY: -ISOLATED_RADIUS, maxX: ISOLATED_RADIUS, maxY: ISOLATED_RADIUS, w: ISOLATED_RADIUS * 2, h: ISOLATED_RADIUS * 2 };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of componentNodes) {
    if (node.x < minX) minX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.x > maxX) maxX = node.x;
    if (node.y > maxY) maxY = node.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function packComponents(components, nodesById, edgesById) {
  // Sort components by node count desc; pack into a roughly square grid.
  const layouts = components
    .map((ids) => {
      const nodes = ids.map((id) => nodesById.get(id)).filter(Boolean);
      const edges = [];
      const idSet = new Set(ids);
      for (const edge of edgesById.values()) {
        if (idSet.has(edge.source) && idSet.has(edge.target)) {
          edges.push({ a: nodesById.get(edge.source), b: nodesById.get(edge.target), type: edge.type });
        }
      }
      return { nodes, edges };
    })
    .filter((c) => c.nodes.length > 0);

  // Run sim per component.
  for (const c of layouts) {
    localForceSim(c.nodes, c.edges, c.nodes.length > 30 ? TICKS : Math.max(120, TICKS));
    const bounds = componentBounds(c.nodes);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    for (const node of c.nodes) {
      node.x -= cx;
      node.y -= cy;
    }
    c.bounds = componentBounds(c.nodes);
  }

  // Sort: largest component first (will go top-left).
  layouts.sort((a, b) => b.nodes.length - a.nodes.length);

  // Pack: largest component anchors origin, others arrange in a roughly square grid.
  if (layouts.length === 0) return;
  if (layouts.length === 1) {
    return;
  }

  // First: keep the giant component at origin if it's significantly larger than others.
  const biggest = layouts[0];
  const rest = layouts.slice(1);
  const isolatedFirst = rest.findIndex((c) => c.nodes.length === 1);
  const pairs = rest.filter((c) => c.nodes.length === 2);
  const largeRest = rest.filter((c) => c.nodes.length > 2);
  const isolated = rest.filter((c) => c.nodes.length === 1);

  // Position the giant component at origin.
  // Position pairs and small clusters around it in concentric rings.
  const giantBounds = biggest.bounds;
  const giantHalfW = giantBounds.w / 2;
  const giantHalfH = giantBounds.h / 2;
  const giantR = Math.max(giantHalfW, giantHalfH) + CLUSTER_PADDING;

  // Pairs go in a horizontal band below the giant.
  const ringY = giantR + 80;
  const pairSpacing = SPRING_LENGTH * 1.6;
  const pairsPerRow = Math.max(1, Math.ceil(Math.sqrt(pairs.length)));
  pairs.forEach((c, i) => {
    const row = Math.floor(i / pairsPerRow);
    const col = i % pairsPerRow;
    const offsetX = (col - (pairsPerRow - 1) / 2) * pairSpacing * 2;
    const offsetY = ringY + row * pairSpacing * 1.6;
    for (const node of c.nodes) {
      node.x += offsetX;
      node.y += offsetY;
    }
  });

  // Larger non-giant clusters stack to the right of the giant.
  let nextX = giantR + CLUSTER_PADDING;
  let nextY = -giantR;
  const colWidth = 200;
  let colHeight = 0;
  largeRest.forEach((c) => {
    const halfW = c.bounds.w / 2;
    const halfH = c.bounds.h / 2;
    if (colHeight + halfH * 2 + CLUSTER_PADDING > giantR * 2) {
      nextX += colWidth;
      nextY = -giantR;
      colHeight = 0;
    }
    for (const node of c.nodes) {
      node.x += nextX + halfW;
      node.y += nextY + halfH;
    }
    nextY += halfH * 2 + CLUSTER_PADDING;
    colHeight += halfH * 2 + CLUSTER_PADDING;
  });

  // Isolated nodes go in a quiet corner — top-right of the canvas.
  const isolatedSpacing = ISOLATED_RADIUS * 2 + 8;
  const isolatedPerRow = Math.max(4, Math.ceil(Math.sqrt(isolated.length)));
  const isolatedStartX = -giantR;
  const isolatedStartY = -giantR - 120;
  isolated.forEach((c, i) => {
    const row = Math.floor(i / isolatedPerRow);
    const col = i % isolatedPerRow;
    c.nodes[0].x = isolatedStartX + col * isolatedSpacing;
    c.nodes[0].y = isolatedStartY - row * isolatedSpacing;
  });
}

export function runForceLayout(nodes, edges) {
  if (nodes.length === 0) return;

  const adjacency = buildAdjacency(nodes, edges);
  const components = findComponents(nodes, adjacency);

  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const edgesById = new Map();
  for (const edge of edges) edgesById.set(edge.id, edge);

  packComponents(components, nodesById, edgesById);

  // Recenter the whole thing on origin so the camera fit is tight.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of nodes) {
    if (node.x < minX) minX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.x > maxX) maxX = node.x;
    if (node.y > maxY) maxY = node.y;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  for (const node of nodes) {
    node.x -= cx;
    node.y -= cy;
  }
}
