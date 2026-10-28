import {newRow} from './demo.js';

/** Keep CRM prices and quantities; loading never adds catalog coefficients. */
export function dealRows(deal) {
  return (deal.rows || []).map(row => ({
    ...newRow({id: String(row.productId || ''), name: row.productName,
      basePrice: row.price ?? row.unitPrice ?? row.basePrice ?? 0, currency: deal.currency, source: 'deal'}),
    ...(Number(row.productId || 0) === 0 ? {rowType: 'custom'} : {}),
    quantity: String(row.quantity), priceSource: 'deal',
    taxRate: row.taxRate ?? 0, taxIncluded: row.taxIncluded ?? 'Y'
  }));
}

/** Restore missing delivery lines without replacing edits in the current draft. */
export function includeDeliveryRows(rows, deal, productId) {
  if (!/^[1-9]\d*$/.test(String(productId))) return rows;
  const matches = row => row.rowType !== 'custom' && String(row.productId) === String(productId);
  const existing = rows.filter(matches).length;
  const missing = dealRows({...deal, rows: (deal.rows || []).filter(matches)}).slice(existing);
  return missing.length ? [...rows, ...missing] : rows;
}
