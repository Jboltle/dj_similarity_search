const GRAPH_URL = '/graph.json';

async function loadGraphViaApi() {
  const data = await window.vdjApi.getGraph();
  return normalizeGraph(data, 'vdjApi.getGraph');
}

async function loadGraphViaFetch() {
  const response = await fetch(GRAPH_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(
      `Failed to load ${GRAPH_URL} (${response.status}). Run: npm run parse`
    );
  }
  const data = await response.json();
  return normalizeGraph(data, GRAPH_URL);
}

function normalizeGraph(data, source) {
  if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
    throw new Error(`Graph from ${source} is malformed: missing nodes or edges`);
  }
  return data;
}

export async function loadGraph() {
  if (typeof window !== 'undefined' && window.vdjApi?.getGraph) {
    return loadGraphViaApi();
  }
  return loadGraphViaFetch();
}
