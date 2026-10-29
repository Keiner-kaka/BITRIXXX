import {deliveryAddressText, supplierDeliveryTerms, applyDealDeliveryAddress, EMPTY_SUPPLIER_TERMS} from './delivery-address.js';
export const DELIVERY_MODE_FIELD = 'UF_CRM_1793093018394';
export const DEFAULT_DELIVERY_MODE_IDS = {pickup:'54', supplier:'56', custom:'58'};
export const PICKUP_TERMS = 'Самовывоз со склада поставщика по адресу : пос. Дорожный, индустриальный парк Краснодар. 45.123173, 39.368309.';
export function validateDeliveryModeIds(value) {
  const result={}, ids=new Set();
  for(const key of Object.keys(DEFAULT_DELIVERY_MODE_IDS)) {
    const id=value?.[key];
    if(typeof id!=='string'|| !/^[1-9]\d*$/.test(id)||!Number.isSafeInteger(Number(id))||ids.has(id)) throw new Error('ID видов доставки должны быть положительными целыми числами без повторов.');
    result[key]=id;ids.add(id);
  }
  return result;
}
export function deliveryModeIds(value) {
  return [...new Set((Array.isArray(value)?value:[value]).filter(v=>typeof v==='string'||typeof v==='number').map(v=>String(v).trim()).filter(v=>v&&v!=='0'))];
}
export function applyDealDeliveryData(draft,address,values,mapping=DEFAULT_DELIVERY_MODE_IDS,enabled=true,{force=false}={}) {
  if(!enabled) {applyDealDeliveryAddress(draft,address);draft.deliveryModeWarning='';return;}
  draft.documentFields ||= {};
  const current=draft.documentFields.YuzmDeliveryTerms;
  const known=[EMPTY_SUPPLIER_TERMS,supplierDeliveryTerms(draft.deliveryAddress),PICKUP_TERMS,draft.deliverySourceText];
  if(draft.deliveryAuto===undefined && current && !known.includes(current)) draft.deliveryAuto=false;
  const canApply=force || (draft.deliveryAuto!==false && (!current||known.includes(current)));
  draft.deliveryAddress=deliveryAddressText(address);
  const ids=deliveryModeIds(values);
  draft.deliveryModeIds=ids;
  const mode=ids.length===1?Object.keys(mapping).find(key=>mapping[key]===ids[0]):null;
  draft.deliveryModeWarning=ids.length>1?'В поле сделки выбрано несколько видов доставки. Выберите один вариант в конструкторе.':ids.length===1&&!mode?'Не настроен вид доставки для ID '+ids[0]+'. Проверьте настройки или выберите вариант вручную.':'';
  if(canApply) {
    draft.deliveryMode=mode || 'custom';
    draft.documentFields.YuzmDeliveryTerms=mode==='supplier'?supplierDeliveryTerms(draft.deliveryAddress):mode==='pickup'?PICKUP_TERMS:'';
    draft.deliverySourceText=draft.documentFields.YuzmDeliveryTerms;
    draft.deliveryAuto=true;
  }
}
