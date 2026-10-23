import {readPrimary, displayValue} from './integration-config.js';
export async function loadPrimaryData(adapter, dealId, config, fields) {
  const raw = await adapter.call('crm.deal.get', {id: Number(dealId)});
  if (String(raw?.ID) !== String(dealId)) throw new Error('CRM вернула первичные данные другой сделки.');
  const values = readPrimary(raw, config, fields);
  const clientField = fields[config.fields.client.code];
  const clients = Array.isArray(values.client) ? values.client : [values.client];
  const names = [];
  for (const value of clients) {
    let type = clientField.type;
    let clientId = value;
    if (type === 'crm') {
      const match = /^([CO])_(\d+)$/.exec(String(value));
      if (!match) throw new Error('Клиент: поддерживаются ссылки CRM на компанию или контакт.');
      type = match[1] === 'C' ? 'crm_contact' : 'crm_company'; clientId = match[2];
    }
    if (['crm_company','crm_contact'].includes(type)) {
      if (!Number(clientId)) throw new Error('В настроенном поле клиента не выбран контрагент.');
      const result = await adapter.call(type === 'crm_company' ? 'crm.company.get' : 'crm.contact.get', {id: Number(clientId)});
      if (String(result?.ID) !== String(clientId)) throw new Error('CRM не подтвердила клиента сделки.');
      names.push(type === 'crm_company' ? result.TITLE : [result.LAST_NAME,result.NAME,result.SECOND_NAME].filter(Boolean).join(' '));
    } else names.push(displayValue(value));
  }
  adapter.managerFieldCode = config.fields.manager.code;
  return {values, companyName: names.join(', ')};
}
