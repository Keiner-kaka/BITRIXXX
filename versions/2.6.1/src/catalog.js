/** Navigation-only properties of this portal's product iblock. No pricing fields. */
export const NAVIGATION_IBLOCK_ID = 24;
export const NAVIGATION_PROPERTIES = [
  {id: 108, code: 'DIAMETRMM_FMZJ0M', key: 'diameter', label: 'Диаметр', unit: 'мм'},
  {id: 110, code: 'TOLSHCHINA_STENKIMM_HYFNS6', key: 'wallThickness', label: 'Стенка', unit: 'мм'},
  {id: 112, code: 'VESKG_YW0GYI', key: 'weight', label: 'Вес', unit: 'кг'},
];
export function navigationFields(modern = true) {
  return NAVIGATION_PROPERTIES.map(p => modern ? `property${p.id}` : `PROPERTY_${p.id}`);
}
function propertyNumber(value) {
  if (Array.isArray(value)) return value.length === 1 ? propertyNumber(value[0]) : null;
  if (value && typeof value === 'object') return propertyNumber(value.value ?? value.VALUE);
  if (!['string', 'number'].includes(typeof value) || !String(value).trim()) return null;
  const text = String(value).trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
export function catalogNavigation(raw) {
  // Never interpret the same property IDs from another iblock as these fields.
  const iblock = raw.iblockId ?? raw.IBLOCK_ID ?? raw.CATALOG_ID;
  if (Number(iblock) !== NAVIGATION_IBLOCK_ID) return {};
  const result = {};
  for (const p of NAVIGATION_PROPERTIES) {
    const number = propertyNumber(raw[`property${p.id}`] ?? raw[`PROPERTY_${p.id}`] ?? raw[p.code]);
    if (number !== null) result[p.key] = number;
  }
  return result;
}
export function navigationLabels(navigation = {}) {
  return [NAVIGATION_PROPERTIES[1], NAVIGATION_PROPERTIES[0], NAVIGATION_PROPERTIES[2]]
    .filter(p => Number.isFinite(navigation[p.key]))
    .map(p => `${p.label}: ${navigation[p.key].toLocaleString('ru-RU', {maximumFractionDigits: 12})} ${p.unit}`);
}
function searchableCatalogText(entry) {
  return `${entry.name} ${entry.parentProductName || ''} ${navigationLabels(entry.navigation).join(' ')}`;
}

/** Qualified numeric searches avoid matching dimensions embedded in the product name. */
function navigationQuery(raw) {
  const filters = [];
  const text = raw.replace(/(^|\s)(диаметр|стенка|толщина(?:\s+стенки)?|вес)\s*:?\s*(\d+(?:[.,]\d+)?)(?:\s*(?:мм|кг))?(?=\s|$)/gi,
    (_, space, label, value) => {
      const key = /^диаметр$/i.test(label) ? 'diameter' : /^вес$/i.test(label) ? 'weight' : 'wallThickness';
      filters.push({key, value: Number(value.replace(',', '.'))}); return space;
    }).trim();
  return {text, matches: entry => filters.every(f => entry.navigation?.[f.key] === f.value)};
}

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
    const name = searchableCatalogText(entry);
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
    this.names = entries.map(entry => normalizeSearchText(searchableCatalogText(entry)));
  }
  get(id) { return this.byId.get(String(id)); }
  search(query = '') {
    const raw = String(query).trim();
    if (!raw) return this.entries;
    const explicit = /^(?:#|id\s*:)\s*(\d+)$/i.exec(raw);
    if (explicit) return filterCatalogEntries(this.entries, explicit[1], 'id');
    const qualified = navigationQuery(raw), text = qualified.text;
    const exactId = /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? String(Number(text)) : '';
    const words = normalizeSearchText(text).split(' ').filter(Boolean);
    const exact = [], names = [];
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (!qualified.matches(entry)) continue;
      if (!text) {names.push(entry); continue;}
      if (exactId && (String(entry.id) === exactId || String(entry.parentProductId) === exactId)) exact.push(entry);
      else if (words.length ? words.every(word => this.names[i].includes(word))
        : searchableCatalogText(entry).toLocaleLowerCase('ru').includes(raw.toLocaleLowerCase('ru'))) names.push(entry);
    }
    return [...exact, ...names];
  }
}
