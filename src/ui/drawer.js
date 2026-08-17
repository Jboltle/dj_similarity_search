const TOAST_DURATION_MS = 2200;
const TOAST_FADE_MS = 300;

export class Drawer {
  constructor({ root, titleEl, bodyEl, closeButton }) {
    this.root = root;
    this.titleEl = titleEl;
    this.bodyEl = bodyEl;
    this.closeButton = closeButton;
    this.activePanel = null;
    this.onCloseHandlers = new Set();

    closeButton.addEventListener('click', () => this.close());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.isOpen()) this.close();
    });
  }

  isOpen() {
    return !this.root.classList.contains('hidden');
  }

  isPanelOpen(name) {
    return this.isOpen() && this.activePanel === name;
  }

  onClose(handler) {
    this.onCloseHandlers.add(handler);
    return () => this.onCloseHandlers.delete(handler);
  }

  open({ name, title }) {
    this.activePanel = name;
    this.titleEl.textContent = title;
    this.root.classList.remove('hidden');
    this.root.dataset.panel = name;
  }

  close() {
    if (!this.isOpen()) return;
    this.root.classList.add('hidden');
    const previous = this.activePanel;
    this.activePanel = null;
    delete this.root.dataset.panel;
    for (const handler of this.onCloseHandlers) handler(previous);
  }

  setTitle(title) {
    this.titleEl.textContent = title;
  }

  getBody() {
    return this.bodyEl;
  }

  clearBody() {
    this.bodyEl.innerHTML = '';
  }

  showToast(message, { kind = 'ok' } = {}) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${kind}`;
    toast.textContent = message;
    this.root.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), TOAST_FADE_MS);
    }, TOAST_DURATION_MS);
  }
}
