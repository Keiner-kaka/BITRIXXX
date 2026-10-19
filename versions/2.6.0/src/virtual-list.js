export function visibleRange(count, scrollTop, height, stride = 108, overscan = 4) {
  if (!count) return {start: 0, end: 0};
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, count * stride - height)));
  return {start: Math.max(0, Math.floor(top / stride) - overscan),
    end: Math.min(count, Math.ceil((top + height) / stride) + overscan)};
}

/** Fixed-height rows keep DOM size independent of the catalog's total size. */
export class VirtualList {
  constructor(viewport, renderItem, {stride = 108, overscan = 4} = {}) {
    this.viewport = viewport; this.renderItem = renderItem; this.stride = stride; this.overscan = overscan;
    this.items = []; this.rangeKey = ''; this.frame = null;
    this.content = document.createElement('div'); this.content.className = 'virtual-list-content';
    viewport.replaceChildren(this.content);
    this.onScroll = () => {
      if (this.frame !== null) return;
      this.frame = requestAnimationFrame(() => {this.frame = null; this.render();});
    };
    this.onKeyDown = event => {
      if (!['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(event.key) || !this.items.length) return;
      const row = event.target.closest('[data-virtual-index]');
      const current = row ? Number(row.dataset.virtualIndex) : Math.floor(viewport.scrollTop / this.stride);
      const page = Math.max(1, Math.floor(viewport.clientHeight / this.stride));
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? this.items.length - 1 :
        current + ({ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page}[event.key]);
      const index = Math.max(0, Math.min(this.items.length - 1, next));
      event.preventDefault(); viewport.scrollTop = index * this.stride; this.render();
      this.content.querySelector(`[data-virtual-index="${index}"] button`)?.focus({preventScroll: true});
    };
    viewport.addEventListener('scroll', this.onScroll, {passive: true});
    viewport.addEventListener('keydown', this.onKeyDown);
    this.observer = new ResizeObserver(() => this.render()); this.observer.observe(viewport);
  }
  setItems(items, {resetScroll = true} = {}) {
    this.items = items;
    if (resetScroll) this.viewport.scrollTop = 0;
    this.content.style.height = `${items.length * this.stride}px`;
    this.rangeKey = ''; this.render();
  }
  render() {
    const {start, end} = visibleRange(this.items.length, this.viewport.scrollTop,
      this.viewport.clientHeight || 480, this.stride, this.overscan);
    const key = `${start}:${end}`;
    if (key === this.rangeKey) return;
    this.rangeKey = key;
    const nodes = [];
    for (let index = start; index < end; index++) {
      const row = document.createElement('div'); row.className = 'virtual-list-row';
      row.dataset.virtualIndex = index;
      row.setAttribute('role', 'listitem'); row.setAttribute('aria-posinset', index + 1); row.setAttribute('aria-setsize', this.items.length);
      row.style.top = `${index * this.stride}px`; row.style.height = `${this.stride - 8}px`;
      row.append(this.renderItem(this.items[index])); nodes.push(row);
    }
    this.content.replaceChildren(...nodes);
  }
  destroy() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.viewport.removeEventListener('scroll', this.onScroll); this.viewport.removeEventListener('keydown', this.onKeyDown);
    this.observer.disconnect();
  }
}
