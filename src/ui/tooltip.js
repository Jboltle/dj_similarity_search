function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

export class Tooltip {
  constructor(element) {
    this.el = element;
  }

  show(node, position) {
    if (!node) {
      this.hide();
      return;
    }
    const lines = [
      `<strong>${escape(node.displayName)}</strong>`,
      node.bpm != null ? `BPM · ${escape(node.bpm)}` : 'BPM · —',
      node.key ? `Key · ${escape(node.key)}${node.camelotKey ? ` (${escape(node.camelotKey)})` : ''}` : 'Key · —',
      node.genre ? `Genre · ${escape(node.genre)}` : null,
      `Linked tracks · ${escape(node.linkedCount ?? 0)}`,
    ].filter(Boolean);
    const path = node.filePath
      ? `<div class="tooltip-path">${escape(node.filePath)}</div>`
      : '';
    this.el.innerHTML = lines.join('<br />') + path;
    this.el.classList.remove('hidden');
    this.el.style.left = `${position.x}px`;
    this.el.style.top = `${position.y}px`;
  }

  hide() {
    this.el.classList.add('hidden');
  }
}
