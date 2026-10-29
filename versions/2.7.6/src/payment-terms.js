export const PAYMENT_FIELD = 'UF_CRM_1793090584810';
export const DEFAULT_PAYMENT_MAPPING = {
  '100': {id:'44', label:'100% предоплата', text:'100% предоплата.'},
  '50_50': {id:'46', label:'50% / 50%', text:'50% предоплата + 50% доплата по уведомлению о готовности к отгрузке.'},
  '40_60': {id:'48', label:'40% / 60%', text:'40% предоплата + 60% доплата по уведомлению о готовности к отгрузке.'},
  '30_70': {id:'50', label:'30% / 70%', text:'30% предоплата + 70% доплата по уведомлению о готовности к отгрузке.'},
  other: {id:'52', label:'Иной вариант', text:'Иной(согласован с руководителем,указать в коментарии)'}
};
export function validatePaymentMapping(mapping) {
  const ids=new Set(), result={};
  for (const [key, base] of Object.entries(DEFAULT_PAYMENT_MAPPING)) {
    const entry=mapping?.[key];
    if (!entry || !/^[1-9]\d*$/.test(entry.id) || !Number.isSafeInteger(Number(entry.id)) || ids.has(entry.id)) throw new Error('ID вариантов оплаты должны быть положительными целыми числами без повторов.');
    if (typeof entry.text!=='string' || !entry.text.trim() || entry.text.length>2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(entry.text)) throw new Error('Заполните формулировки оплаты: не более 2000 символов каждая.');
    ids.add(entry.id);result[key]={...base,id:entry.id,text:entry.text.trim()};
  }
  return result;
}
export function paymentIds(value) {
  const values=Array.isArray(value)?value:[value];
  return [...new Set(values.filter(v=>typeof v==='string'||typeof v==='number').map(String).map(v=>v.trim()).filter(v=>v&&v!=='0'))];
}
export function mappedPaymentTerms(ids, mapping) {
  const byId=new Map(Object.values(mapping).map(e=>[e.id,e.text]));
  const selected=paymentIds(ids);
  return {text:selected.length === 1 ? (byId.get(selected[0]) || '') : '', multiple:selected.length > 1, unknown:selected.filter(id=>!byId.has(id))};
}
export function applyDealPaymentTerms(draft, ids, mapping) {
  const result=mappedPaymentTerms(ids,mapping);
  draft.documentFields ||= {};
  const current=draft.documentFields.YuzmPaymentTerms;
  const knownDefaults=[...Object.values(DEFAULT_PAYMENT_MAPPING).map(e=>e.text),
    '50% предоплата + 50% по факту готовности к отгрузке.', '40% предоплата + 60% по факту готовности к отгрузке.'];
  if (draft.paymentAuto === undefined && !draft.paymentSourceText && current && !knownDefaults.includes(current)) draft.paymentAuto=false;
  if (draft.paymentAuto!==false && (!draft.paymentSourceText || current===draft.paymentSourceText)) {
    // Unknown options must not silently become a partially mapped payment condition.
    draft.documentFields.YuzmPaymentTerms=result.unknown.length?'':result.text;
    draft.paymentSourceText=draft.documentFields.YuzmPaymentTerms;
    draft.paymentAuto=true;
  }
  draft.paymentIds=paymentIds(ids);draft.paymentUnmappedIds=result.unknown;draft.paymentMultiple=result.multiple;
}
