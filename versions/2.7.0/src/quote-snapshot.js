import {calculateQuote, parseNumber} from './calculator.js';
export const SNAPSHOT_SCHEMA = 1;
export const ALGORITHM_VERSION = '2.7.0-catalog-fasteners-v1';
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
export async function sha256(value) {
  const bytes = new TextEncoder().encode(canonical(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const finite = (value, label) => {
  const number = parseNumber(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label}: укажите неотрицательное число (включая явный 0).`);
  return number;
};
export function calculateMetrics(quote, coefficientKeys) {
  if (!Array.isArray(coefficientKeys)) throw new Error('Не настроены коэффициенты доставки.');
  let weight = 0, separateDelivery = 0;
  const withoutDeliveryRows = [];
  for (const row of quote.rows) {
    if (row.deliveryRole === 'separate') { separateDelivery += row.lineTotal; continue; }
    weight += finite(row.unitWeight, 'Масса единицы «' + row.productName + '»') * parseNumber(row.quantity);
    withoutDeliveryRows.push({...row, ...Object.fromEntries(coefficientKeys.map(key => [key, '1']))});
  }
  const withoutDelivery = withoutDeliveryRows.length ? calculateQuote(withoutDeliveryRows, quote.config) : {valid: true, total: 0};
  if (!withoutDelivery.valid) throw new Error('Не удалось выделить доставку штатным калькулятором.');
  const embeddedDelivery = Math.round((quote.total - separateDelivery - withoutDelivery.total) * 100) / 100;
  if (embeddedDelivery < -0.001) throw new Error('Коэффициенты доставки дают отрицательную надбавку; проверьте назначение коэффициентов.');
  return {total: quote.total, weight: Math.round(weight * 1000000) / 1000000,
    delivery: Math.round((embeddedDelivery + separateDelivery) * 100) / 100, embeddedDelivery, separateDelivery};
}
export async function createSnapshot(quote, document, metrics, operationId) {
  if (quote.managerSignatureReference?.kind === 'url') {
    const url = new URL(quote.managerSignatureReference.url);
    if (url.search || url.username || url.password) throw new Error('Для сохранения подписи назначьте ID файла Диска вместо ссылки с параметрами авторизации.');
  }
  const copy = JSON.parse(JSON.stringify(quote)); // Exclude undefined before hashing and storing.
  const snapshot = {schemaVersion: SNAPSHOT_SCHEMA, algorithmVersion: ALGORITHM_VERSION,
    dealId: String(quote.dealId), operationId, status: 'generated', document: {id: String(document.id), number: String(document.number || ''), templateId: String(document.templateId || quote.documentTemplateId)},
    generatedAt: document.createdAt || new Date().toISOString(),
    items: copy.rows, sourcePrices: copy.rows.map(row => ({rowId: row.id, basePrice: row.basePrice, priceSource: row.priceSource || row.source})),
    quantities: copy.rows.map(row => ({rowId: row.id, quantity: row.quantity})),
    coefficients: copy.rows.map(row => ({rowId: row.id, k1: row.k1, k2: row.k2, k3: row.k3})),
    fasteners: copy.rows.map(row => ({rowId: row.id, enabled: row.fastenersEnabled === true, price: row.fasteners || 0, propertyPrice: row.fastenersPropertyPrice ?? null})),
    delivery: {coefficientKeys: copy.deliveryCoefficientKeys || [], embedded: metrics.embeddedDelivery, separate: metrics.separateDelivery, primary: copy.primary || {}},
    weight: metrics.weight, conditions: copy.documentFields, appliedTexts: copy.appliedTexts || {}, totals: metrics,
    quote: copy};
  const clean = JSON.parse(JSON.stringify(snapshot));
  return {...clean, integrity: {algorithm: 'SHA-256', digest: await sha256(clean)}};
}
export function checkSnapshotSize(snapshot, maxBytes, field) {
  const encoded = JSON.stringify(snapshot);
  if (new TextEncoder().encode(encoded).length > maxBytes || (field.maxLength > 0 && encoded.length > field.maxLength)) throw new Error('JSON расчёта превышает лимит настроенного поля; запись не начата. Увеличьте допустимый лимит или сократите расчёт.');
  return encoded;
}
export async function verifySnapshot(raw, dealId) {
  let snapshot;
  try { snapshot = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw); } catch { throw new Error('Поле последнего расчёта не содержит корректный JSON.'); }
  if (!snapshot || snapshot.schemaVersion !== SNAPSHOT_SCHEMA || snapshot.algorithmVersion !== ALGORITHM_VERSION) throw new Error('Версия схемы или алгоритма расчёта не поддерживается.');
  if (snapshot.dealId !== String(dealId) || String(snapshot.quote?.dealId) !== String(dealId)) throw new Error('JSON относится к другой сделке.');
  if (!snapshot.document || !/^[1-9]\d*$/.test(snapshot.document.id) || !snapshot.generatedAt || !snapshot.operationId || snapshot.status !== 'generated' || !snapshot.quote?.config || !Array.isArray(snapshot.items) || !snapshot.items.length) throw new Error('JSON расчёта имеет неполную структуру.');
  const {integrity, ...body} = snapshot;
  if (integrity?.algorithm !== 'SHA-256' || integrity.digest !== await sha256(body)) throw new Error('Контрольная сумма JSON не совпадает; восстановление отменено.');
  if (canonical(snapshot.items) !== canonical(snapshot.quote.rows) || canonical(snapshot.conditions) !== canonical(snapshot.quote.documentFields)) throw new Error('Товарные позиции или тексты внутри JSON расходятся.');
  const calculated = calculateQuote(snapshot.quote.rows, snapshot.quote.config);
  if (!calculated.valid || calculated.total !== snapshot.totals?.total || calculated.total !== snapshot.quote.total) throw new Error('Повторный расчёт JSON не совпал с сохранёнными суммами.');
  if (canonical(calculated.rows) !== canonical(snapshot.quote.rows)) throw new Error('Результаты товарных строк JSON не совпали с повторным расчётом.');
  if (canonical(snapshot.appliedTexts) !== canonical(snapshot.quote.appliedTexts || {}) || Object.values(snapshot.appliedTexts).some(item => item.text !== snapshot.conditions[item.field])) throw new Error('Фактические тексты JSON расходятся с условиями КП.');
  const metrics = calculateMetrics({...snapshot.quote, ...calculated}, snapshot.delivery.coefficientKeys);
  if (canonical(metrics) !== canonical(snapshot.totals) || snapshot.weight !== metrics.weight) throw new Error('Масса или доставка JSON не совпадают с повторным расчётом.');
  return {snapshot, quote: {...snapshot.quote, ...calculated}};
}
