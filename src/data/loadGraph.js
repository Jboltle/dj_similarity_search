export async function loadGraph() {
  const response = await fetch('/graph.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(
      `Failed to load /graph.json (${response.status}). Run: npm run parse`
    );
  }
  const data = await response.json();
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
    throw new Error('graph.json is malformed: missing nodes or edges');
  }
  return data;
}
