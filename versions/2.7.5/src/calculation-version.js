/** Persist only the values used by this quote, never catalog caches or results. */
export function calculationVersion(snapshot, {event, deal, deliveryProductId = '', templateId = ''}) {
  return {
    schemaVersion: 1,
    version: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    event,
    quoteId: snapshot.quoteId,
    deal: {id: String(snapshot.dealId), title: String(deal.TITLE ?? ''), companyName: snapshot.companyName},
    ...(templateId ? {documentTemplateId: String(templateId)} : {}),
    parameters: {
      currency: snapshot.currency,
      rounding: snapshot.config.rounding,
      ...(deliveryProductId ? {deliveryProductId: String(deliveryProductId)} : {}),
      rows: snapshot.rows.map(row => ({
        ...(row.productId ? {productId: String(row.productId)} : {}),
        ...(row.rowType ? {rowType: row.rowType} : {}),
        productName: row.productName,
        basePrice: row.basePrice,
        quantity: row.quantity,
        k1: row.k1, k2: row.k2, k3: row.k3,
        coatingCode: row.coatingCode,
        coatingName: row.coatingName,
        ...(row.ralColor ? {ralColor: row.ralColor} : {}),
        ...(row.customCoating ? {customCoating: row.customCoating} : {}),
        executionTerm: row.executionTerm,
        fastenersEnabled: row.fastenersEnabled === true,
        ...(row.fastenersEnabled === true ? {fasteners: row.fasteners} : {}),
      })),
    },
  };
}

export function jsonBase64(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Build a new draft from trusted fields only; the caller commits it after validation. */
export function restoreCalculationVersion(value, dealId, config) {
  if (!value || value.schemaVersion !== 1 || !value.version || String(value.deal?.id) !== String(dealId)) {
    throw new Error('JSON не является версией расчёта текущей сделки.');
  }
  const p = value.parameters;
  if (!p || !Array.isArray(p.rows) || !p.rows.length || p.rows.length > 5000
    || !/^[A-Z]{3}$/.test(p.currency) || !['line', 'unit'].includes(p.rounding)) {
    throw new Error('Некорректные параметры расчёта JSON.');
  }
  const text = (v, label, max = 250) => {
    if (typeof v !== 'string' || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) throw new Error('Некорректное поле JSON: ' + label + '.');
    return v;
  };
  const numeric = (v, label) => {
    if (!['string', 'number'].includes(typeof v) || String(v).length > 100) throw new Error('Некорректное число JSON: ' + label + '.');
    return v;
  };
  const deliveryProductId = p.deliveryProductId ?? '';
  if (deliveryProductId && !/^[1-9]\d*$/.test(String(deliveryProductId))) throw new Error('Некорректный ID товара доставки в JSON.');
  const rows = p.rows.map(row => {
    if (!row || typeof row !== 'object') throw new Error('Некорректная строка JSON.');
    const custom = row.rowType === 'custom' || !row.productId;
    if (!custom && (!/^[1-9]\d*$/.test(String(row.productId)) || !Number.isSafeInteger(Number(row.productId)))) throw new Error('Некорректный ID товара в JSON.');
    let coatingCode = text(row.coatingCode ?? 'none', 'покрытие');
    let customCoating = text(row.customCoating ?? '', 'свой текст покрытия');
    let ralColor = text(row.ralColor ?? '', 'RAL');
    if (!config.coatings.some(c => c.code === coatingCode)) {
      customCoating = text(row.coatingName || coatingCode, 'название покрытия');
      coatingCode = 'custom'; ralColor = '';
    }
    return {
      id: crypto.randomUUID(), rowType: custom ? 'custom' : 'catalog',
      productId: custom ? '' : String(row.productId),
      productName: text(row.productName, 'наименование'),
      basePrice: numeric(row.basePrice, 'базовая цена'), quantity: numeric(row.quantity, 'количество'),
      k1: numeric(row.k1, 'К1'), k2: numeric(row.k2, 'К2'), k3: numeric(row.k3, 'К3'),
      currency: p.currency, coatingCode, customCoating, ralColor,
      executionTerm: text(row.executionTerm ?? '', 'срок исполнения'),
      fastenersEnabled: row.fastenersEnabled === true,
      fasteners: row.fastenersEnabled === true ? numeric(row.fasteners, 'метизы') : '',
      fastenersPropertyPrice: null, fastenersSource: 'manual',
      source: custom ? 'custom' : 'catalog', priceSource: 'manual', needsCatalogPrice: false,
    };
  });
  return {rows, companyName: text(value.deal.companyName, 'компания', 1000), currency: p.currency,
    rounding: p.rounding, deliveryProductId: String(deliveryProductId)};
}
