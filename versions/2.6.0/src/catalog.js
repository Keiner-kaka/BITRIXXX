/** Match catalog names as users type them: words, dimensions and punctuation. */
export function normalizeSearchText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('ru')
    .replace(/ё/g, 'е').replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
}

export function filterCatalogEntries(entries, query = '', by = 'auto') {
  if (!['auto', 'name', 'id'].includes(by)) throw new Error('Выберите поиск по названию или ID товара.');
  const text = String(query).trim();
  if (!text) return entries.slice();
  if (by === 'id' || (by === 'auto' && /^[1-9]\d*$/.test(text))) {
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) <= 0) {
      throw new Error('ID товара: требуется положительное целое число.');
    }
    const searchId = String(Number(text));
    return entries.filter(entry => String(entry.id) === searchId || String(entry.parentProductId) === searchId);
  }
  const words = normalizeSearchText(text).split(' ').filter(Boolean);
  // Punctuation-only names still have an exact substring search.
  return entries.filter(entry => {
    const name = `${entry.name}\n${entry.parentProductName || ''}`;
    const normalized = normalizeSearchText(name);
    return words.length ? words.every(word => normalized.includes(word))
      : name.toLocaleLowerCase('ru').includes(text.toLocaleLowerCase('ru'));
  });
}

/** Cache normalized names once; search by name and ID in one dialog. */
export class CatalogSearchIndex {
  constructor(entries = []) {
    this.entries = entries;
    this.byId = new Map(entries.map(entry => [String(entry.id), entry]));
    this.names = entries.map(entry => normalizeSearchText(`${entry.name} ${entry.parentProductName || ''}`));
  }
  get(id) { return this.byId.get(String(id)); }
  search(query = '') {
    const raw = String(query).trim();
    if (!raw) return this.entries;
    const explicit = /^(?:#|id\s*:)\s*(\d+)$/i.exec(raw);
    if (explicit) return filterCatalogEntries(this.entries, explicit[1], 'id');
    const exactId = /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? String(Number(raw)) : '';
    const words = normalizeSearchText(raw).split(' ').filter(Boolean);
    const exact = [], names = [];
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (exactId && (String(entry.id) === exactId || String(entry.parentProductId) === exactId)) exact.push(entry);
      else if (words.length ? words.every(word => this.names[i].includes(word))
        : `${entry.name} ${entry.parentProductName || ''}`.toLocaleLowerCase('ru').includes(raw.toLocaleLowerCase('ru'))) names.push(entry);
    }
    return [...exact, ...names];
  }
}
