export const DELIVERY_ADDRESS_FIELD = 'UF_CRM_1793089347287';
export const EMPTY_SUPPLIER_TERMS = 'Доставка в __________________________ производится силами поставщика.';

/** Bitrix address fields may append a location/coordinates after a pipe. */
export function deliveryAddressText(value) {
  if (Array.isArray(value)) return value.length === 1 ? deliveryAddressText(value[0]) : '';
  if (value && typeof value === 'object') return deliveryAddressText(value.VALUE ?? value.value ?? value.address ?? value.ADDRESS);
  if (typeof value !== 'string') return '';
  return value.split('|')[0].replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}
export function supplierDeliveryTerms(address) {
  const text = deliveryAddressText(address);
  return text ? `Доставка в: ${text} производится силами поставщика.` : EMPTY_SUPPLIER_TERMS;
}

/** Update generated text only; retain pickup and the manager's custom conditions. */
export function applyDealDeliveryAddress(draft, value) {
  const address = deliveryAddressText(value);
  draft.documentFields ||= {};
  const terms = draft.documentFields.YuzmDeliveryTerms;
  if (!terms || terms === EMPTY_SUPPLIER_TERMS || terms === supplierDeliveryTerms(draft.deliveryAddress)) {
    draft.documentFields.YuzmDeliveryTerms = supplierDeliveryTerms(address);
  }
  draft.deliveryAddress = address;
}
