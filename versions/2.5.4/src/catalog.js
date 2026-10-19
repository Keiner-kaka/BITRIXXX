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
