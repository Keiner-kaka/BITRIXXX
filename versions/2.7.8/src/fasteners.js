/** Section IDs refer to the product iblock, not to names or model prefixes. */
export const SUPPORT_SECTION_IDS = [44];
export function catalogSectionId(raw) {
  const value = raw.iblockSectionId ?? raw.IBLOCK_SECTION_ID ?? raw.SECTION_ID ?? raw.sectionId;
  const result = value && typeof value === 'object' ? value.value ?? value.VALUE : value;
  return Number.isSafeInteger(Number(result)) && Number(result) > 0 ? String(Number(result)) : '';
}
export function assignFasteners(row, product) {
  const price = product.fastenerUnitPrice;
  const known = typeof price === 'number' && Number.isFinite(price) && price >= 0;
  Object.assign(row, {
    fastenersEnabled: product.isSupportSection === true,
    fasteners: known ? String(price) : '',
    fastenersPropertyPrice: known ? price : null,
    fastenersSource: 'property116',
    fastenersNote: product.fastenersNote || (known ? '' : 'Цена метизов не указана в свойстве 116.'),
  });
  delete row.fastenersMatched;
}
