export const DEFAULT_TERM_TEMPLATES = {
  validity: 'КП действительно в течение трех рабочих дней.',
  documents: 'На продукцию выдается паспорт, сертификат соответствия ТРТС.',
  bolts: 'В стоимость включен крепеж на базе болтов (гальваническое покрытие).',
  excluded: 'Крепеж в комплект не входит.',
  studs: 'В стоимость включен крепеж на базе шпилек (гальваническое покрытие).'
};
export function termTemplates(settings) {
  return {...DEFAULT_TERM_TEMPLATES, ...settings?.termTemplates};
}
export function validateTermTemplates(value) {
  const result={};
  for (const key of Object.keys(DEFAULT_TERM_TEMPLATES)) {
    const text=value?.[key];
    if (typeof text!=='string' || !text.trim() || text.length>10000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new Error('Заполните типовые формулировки: от 1 до 10 000 символов без служебных знаков.');
    }
    result[key]=text.trim();
  }
  return result;
}
export function fastenerTemplates(settings) {
  const {bolts,excluded,studs}=termTemplates(settings);
  return {bolts,excluded,studs};
}
export function documentTermDefaults(defaults, settings) {
  const templates=termTemplates(settings);
  return {...defaults,YuzmValidityTerms:templates.validity,YuzmDocumentsTerms:templates.documents,YuzmFastenerTerms:templates.bolts};
}
