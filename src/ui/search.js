function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

const MAX_RESULTS = 25;

export class Search {
  constructor({ input, results, onSelect }) {
    this.input = input;
    this.results = results;
    this.onSelect = onSelect;
    this.nodes = [];
    this.activeIndex = -1;

    this.input.addEventListener('input', () => this.update());
    this.input.addEventListener('focus', () => this.update());
    this.input.addEventListener('blur', () => setTimeout(() => this.hide(), 120));
    this.input.addEventListener('keydown', (e) => this.onKeyDown(e));
  }

  setNodes(nodes) {
    this.nodes = nodes;
  }

  update() {
    const query = this.input.value.trim().toLowerCase();
    if (!query) return this.hide();
    const matches = [];
    for (const node of this.nodes) {
      if (matches.length >= MAX_RESULTS) break;
      const haystack = `${node.artist} ${node.title} ${node.fileName}`.toLowerCase();
      if (haystack.includes(query)) matches.push(node);
    }
    if (!matches.length) {
      this.results.hidden = true;
      this.results.innerHTML = '';
      return;
    }
    this.results.hidden = false;
    this.results.innerHTML = matches
      .map(
        (node, i) => `
          <li data-id="${escape(node.id)}" class="${i === 0 ? 'active' : ''}">
            ${escape(node.displayName)}
            <span class="meta">${escape(node.bpm ?? '—')} BPM</span>
          </li>
        `
      )
      .join('');
    this.activeIndex = 0;
    this.results.querySelectorAll('li').forEach((li) => {
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.select(li.getAttribute('data-id'));
      });
    });
  }

  select(id) {
    if (!id) return;
    this.input.value = '';
    this.hide();
    if (this.onSelect) this.onSelect(id);
  }

  hide() {
    this.results.hidden = true;
    this.results.innerHTML = '';
    this.activeIndex = -1;
  }

  onKeyDown(e) {
    const items = [...this.results.querySelectorAll('li')];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!items.length) return;
      this.activeIndex = (this.activeIndex + 1) % items.length;
      this.refreshActive(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      this.activeIndex = (this.activeIndex - 1 + items.length) % items.length;
      this.refreshActive(items);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const active = items[this.activeIndex];
      if (active) this.select(active.getAttribute('data-id'));
    } else if (e.key === 'Escape') {
      this.hide();
      this.input.blur();
    }
  }

  refreshActive(items) {
    items.forEach((li, i) => li.classList.toggle('active', i === this.activeIndex));
    items[this.activeIndex]?.scrollIntoView({ block: 'nearest' });
  }
}
