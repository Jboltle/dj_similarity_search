#!/usr/bin/env node
/**
 * Validates public/graph.json before the renderer consumes it.
 * Exits with non-zero status if the graph is structurally invalid.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const graphPath = path.join(projectRoot, 'public', 'graph.json');

function fail(message) {
  console.error(`[validate] ✗ ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`[validate] ✓ ${message}`);
}

function main() {
  if (!fs.existsSync(graphPath)) {
    fail(`graph.json not found at ${graphPath}. Run: npm run parse`);
    return;
  }
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));

  if (!Array.isArray(graph.nodes)) return fail('graph.nodes is not an array');
  if (!Array.isArray(graph.edges)) return fail('graph.edges is not an array');
  ok(`Loaded ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

  const ids = new Set();
  for (const node of graph.nodes) {
    if (!node.id) fail(`Node missing id: ${JSON.stringify(node).slice(0, 200)}`);
    if (ids.has(node.id)) fail(`Duplicate node id: ${node.id}`);
    ids.add(node.id);
  }
  ok(`All ${ids.size} node ids are unique`);

  let danglingEdges = 0;
  let selfEdges = 0;
  const edgeIds = new Set();
  let duplicateEdges = 0;

  for (const edge of graph.edges) {
    if (!edge.id || !edge.source || !edge.target) {
      fail(`Edge missing id/source/target: ${JSON.stringify(edge).slice(0, 200)}`);
      continue;
    }
    if (edge.source === edge.target) selfEdges += 1;
    if (!ids.has(edge.source) || !ids.has(edge.target)) danglingEdges += 1;
    if (edgeIds.has(edge.id)) duplicateEdges += 1;
    edgeIds.add(edge.id);
  }

  if (danglingEdges) fail(`${danglingEdges} edges reference unknown node ids`);
  else ok('No dangling edges');

  if (selfEdges) fail(`${selfEdges} self-referential edges`);
  else ok('No self-edges');

  if (duplicateEdges) fail(`${duplicateEdges} duplicate edge ids`);
  else ok('No duplicate edge ids');

  const meta = graph.meta ?? {};
  console.log('[validate] Meta:', JSON.stringify(meta.totals ?? {}, null, 2));
  console.log('[validate] Edges:', JSON.stringify(meta.edges ?? {}, null, 2));
}

main();
