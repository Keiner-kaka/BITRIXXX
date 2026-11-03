/** Comma-separated product IDs; the existing single-ID setting remains compatible. */
export function deliveryProductIds(value = '') {
  if (value === null || value === '') return [];
  if (!['string', 'number'].includes(typeof value)) throw new Error('Укажите ID товаров доставки через запятую.');
  const text = String(value).trim();
  if (!text) return [];
  const ids = text.split(',').map(id => id.trim());
  if (ids.some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    throw new Error('ID товаров доставки должны быть положительными целыми числами через запятую.');
  }
  return [...new Set(ids)];
}
export function normalizeDeliveryProductIds(value) { return deliveryProductIds(value).join(', '); }
