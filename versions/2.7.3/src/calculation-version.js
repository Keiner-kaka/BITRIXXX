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
