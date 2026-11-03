/** Properties of product iblock 24. Only property 116 is also used for calculation. */
export const NAVIGATION_IBLOCK_ID = 24;
export const NAVIGATION_PROPERTIES = [
  {id: 108, code: 'DIAMETRMM_FMZJ0M', aliases: ['DIAMETRMM_FMZJ0'], key: 'diameter', label: 'Диаметр', unit: 'мм', type: 'number'},
  {id: 110, code: 'TOLSHCHINA_STENKIMM_HYFNS6', key: 'wallThickness', label: 'Стенка', unit: 'мм', type: 'number'},
  {id: 112, code: 'VESKG_YW0GYI', key: 'weight', label: 'Вес', unit: 'кг', type: 'number'},
  {id: 116, code: 'TSENA_MK_RUB_3RS0SE', key: 'fastenerPrice', label: 'Цена МК', unit: '₽', type: 'number'},
  {id: 118, code: 'RAZMER_OPORNOGO_FLANTSA_YUA0LC', key: 'flangeSize', label: 'Размер опорного фланца', compactLabel: 'Фланец', unit: '', type: 'text'},
  {id: 120, code: 'MEZHTSENTROVOE_RASSTOYANIE_FXDVSZ', key: 'centerDistance', label: 'Межцентровое расстояние', compactLabel: 'Межцентр.', unit: '', type: 'text'},
  {id: 122, code: 'MESTO_KRONSHTEYNA_UWPZIY', key: 'bracketPosition', label: 'Место кронштейна', unit: '', type: 'text'},
  {id: 124, code: 'SREZ_VERKHNIYNIZHNIY_EBGTQC', key: 'cutDimensions', label: 'Срез верхний/нижний', compactLabel: 'Срез верх./ниж.', unit: '', type: 'text'},
];
export function navigationFields(modern = true) {
  return NAVIGATION_PROPERTIES.map(p => modern ? `property${p.id}` : `PROPERTY_${p.id}`);
}
export function hasCatalogProperty(raw, propertyId) {
  const p = NAVIGATION_PROPERTIES.find(item => item.id === propertyId);
  return p && [`property${p.id}`, `PROPERTY_${p.id}`, p.code, ...(p.aliases ?? [])].some(key => Object.hasOwn(raw, key));
}
function propertyValue(raw, p) {
  for (const key of [`property${p.id}`, `PROPERTY_${p.id}`, p.code, ...(p.aliases ?? [])]) {
    if (Object.hasOwn(raw, key)) return raw[key];
  }
}
export function propertyNumber(value) {
  if (Array.isArray(value)) return value.length === 1 ? propertyNumber(value[0]) : null;
  if (value && typeof value === 'object') return propertyNumber(value.value ?? value.VALUE);
  if (!['string', 'number'].includes(typeof value) || !String(value).trim()) return null;
  const text = String(value).trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function propertyText(value, enumeration) {
  if (Array.isArray(value)) return value.map(item => propertyText(item, enumeration)).filter(Boolean).join(', ');
  if (value && typeof value === 'object') return propertyText(value.valueEnum ?? value.VALUE_ENUM ?? value.value ?? value.VALUE, enumeration);
  if (!['string', 'number'].includes(typeof value)) return '';
  const text = String(value).trim();
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) return '';
  return enumeration ? enumeration[String(value)] ?? '' : text;
}
export function catalogNavigation(raw, enumerations = {}) {
  const iblock = raw.iblockId ?? raw.IBLOCK_ID ?? raw.CATALOG_ID;
  if (Number(iblock) !== NAVIGATION_IBLOCK_ID) return {};
  const result = {};
  for (const p of NAVIGATION_PROPERTIES) {
    const value = p.type === 'number' ? propertyNumber(propertyValue(raw, p)) : propertyText(propertyValue(raw, p), enumerations[p.id]);
    if (p.type === 'number' ? value !== null : value !== '') result[p.key] = value;
  }
  return result;
}
const propertyNumberFormat = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 12});
const propertyMoneyFormat = new Intl.NumberFormat('ru-RU', {minimumFractionDigits: 2, maximumFractionDigits: 2});
export function navigationLabels(navigation = {}, {compact = false} = {}) {
  const order = [NAVIGATION_PROPERTIES[1], NAVIGATION_PROPERTIES[0], ...NAVIGATION_PROPERTIES.slice(2)];
  return order.filter(p => p.type === 'number' ? Number.isFinite(navigation[p.key]) : Boolean(navigation[p.key]))
    .map(p => {
      const value = p.type === 'number' ? (p.id === 116 ? propertyMoneyFormat : propertyNumberFormat).format(navigation[p.key]) : navigation[p.key];
      return `${compact ? p.compactLabel || p.label : p.label}: ${value}${p.unit ? ' ' + p.unit : ''}`;
    });
}
function searchableCatalogText(entry) {
  const aliases = NAVIGATION_PROPERTIES.filter(p => p.compactLabel && entry.navigation?.[p.key] !== undefined).map(p => p.compactLabel).join(' ');
  return `${entry.name} ${entry.parentProductName || ''} ${navigationLabels(entry.navigation).join(' ')} ${aliases}`;
}

/** Both REST families use ACTIVE/active. Missing flags are not a deactivation. */
export function isInactiveCatalogEntry(entry) {
  return ['active', 'ACTIVE'].some(key => {
    const value = entry?.[key];
    return value === false || value === 0 ||
      (typeof value === 'string' && ['N', 'FALSE', '0'].includes(value.trim().toUpperCase()));
  });
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
    .replace(/ё/g, 'е').replace(/(\d)\s*[xх×]\s*(?=\d)/gi, '$1 ').replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
}

export function filterCatalogEntries(entries, query = '', by = 'auto') {
  if (!['auto', 'name', 'id'].includes(by)) throw new Error('Выберите поиск по названию или ID товара.');
  entries = entries.filter(entry => !isInactiveCatalogEntry(entry));
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
    this.entries = entries.filter(entry => !isInactiveCatalogEntry(entry));
    this.byId = new Map(this.entries.map(entry => [String(entry.id), entry]));
    this.names = this.entries.map(entry => normalizeSearchText(searchableCatalogText(entry)));
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
