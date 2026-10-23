/** Shared, non-secret settings in the existing application's option namespace. */
export const CONFIG_OPTION = 'yuzmIntegrationConfig';
export const PARAMETERS = {
  createdAt: {label: 'Дата создания заказа', direction: 'in', types: ['date', 'datetime'], default: 'DATE_CREATE', required: true},
  client: {label: 'Клиент', direction: 'in', types: ['string', 'crm_company', 'crm_contact', 'crm'], default: 'COMPANY_ID', required: true},
  manager: {label: 'Ответственный менеджер', direction: 'in', types: ['employee', 'user'], default: 'ASSIGNED_BY_ID', required: true},
  payment: {label: 'Вид оплаты', direction: 'in', types: ['string', 'enumeration']},
  deliveryType: {label: 'Вид доставки', direction: 'in', types: ['string', 'enumeration']},
  deliveryAddress: {label: 'Адрес доставки', direction: 'in', types: ['string', 'address']},
  deliveryDate: {label: 'Дата доставки', direction: 'in', types: ['date', 'datetime']},
  total: {label: 'Итоговая стоимость заказа', direction: 'out', types: ['double', 'integer', 'money'], required: true},
  delivery: {label: 'Расчётная стоимость доставки', direction: 'out', types: ['double', 'integer', 'money'], required: true},
  weight: {label: 'Общий вес изделий', direction: 'out', types: ['double', 'integer'], required: true},
  snapshot: {label: 'JSON последнего расчёта', direction: 'out', types: ['string'], required: true},
};
const yes = value => [true, 'Y', '1', 1].includes(value);
export function positiveId(value, label = 'ID') {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error(`${label}: требуется положительный ID.`);
  return String(value);
}
export function normalizeFields(raw, userFields = []) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('CRM не вернула описание полей сделки.');
  return Object.fromEntries(Object.entries(raw).map(([code, value]) => {
    const custom = userFields.find(item => item.FIELD_NAME === code) || {};
    const items = value.items ?? custom.LIST ?? [];
    return [code, {code, label: value.formLabel || value.listLabel || value.title || code,
      type: value.type || custom.USER_TYPE_ID, multiple: yes(value.isMultiple ?? custom.MULTIPLE),
      readOnly: yes(value.isReadOnly), required: yes(value.isRequired ?? custom.MANDATORY),
      maxLength: Number(value.settings?.MAX_LENGTH || custom.SETTINGS?.MAX_LENGTH || 0),
      items: Object.values(items).map(item => ({id: String(item.ID ?? item.id), label: String(item.VALUE ?? item.value ?? '')}))}];
  }));
}
export function normalizeIntegrationConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw.schemaVersion !== undefined && raw.schemaVersion !== 1)) throw new Error('Неизвестная версия настроек интеграции.');
  for (const key of ['fields', 'resources']) if (raw[key] !== undefined && (!raw[key] || typeof raw[key] !== 'object' || Array.isArray(raw[key]))) throw new Error(`${key}: ожидается объект настроек.`);
  for (const [key, mapping] of Object.entries(raw.fields || {})) {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || mapping.code !== undefined && typeof mapping.code !== 'string' || mapping.required !== undefined && typeof mapping.required !== 'boolean') throw new Error(`${key}: некорректное назначение поля.`);
  }
  const fields = Object.fromEntries(Object.entries(PARAMETERS).map(([key, param]) => [key, {
    code: raw.fields?.[key]?.code ?? param.default ?? '', required: param.required || Boolean(raw.fields?.[key]?.required),
  }]));
  const resources = {textFileId: '', textFolderId: '', diskProxyPath: '', referenceFileIds: [], ...raw.resources};
  for (const key of ['textFileId', 'textFolderId']) resources[key] = resources[key] === '' || resources[key] === null || resources[key] === undefined ? '' : positiveId(resources[key], key);
  if (!Array.isArray(resources.referenceFileIds)) throw new Error('ID справочных файлов должны быть массивом.');
  resources.referenceFileIds = resources.referenceFileIds.map(value => positiveId(value, 'Справочный файл'));
  if (resources.diskProxyPath && (!/^\/(?!\/)[a-zA-Z0-9_./-]+$/.test(resources.diskProxyPath) || resources.diskProxyPath.includes('..'))) throw new Error('Прокси Диска должен быть путём на текущем HTTPS-хосте.');
  const snapshotMaxBytes = Number(raw.snapshotMaxBytes ?? 60000);
  if (!Number.isSafeInteger(snapshotMaxBytes) || snapshotMaxBytes < 1024 || snapshotMaxBytes > 2000000) throw new Error('Лимит JSON должен быть от 1024 до 2000000 байт.');
  const deliveryCoefficientKeys = raw.deliveryCoefficientKeys ?? ['k2'];
  if (deliveryCoefficientKeys !== null && (!Array.isArray(deliveryCoefficientKeys) || deliveryCoefficientKeys.some(key => !['k1', 'k2', 'k3'].includes(key)) || new Set(deliveryCoefficientKeys).size !== deliveryCoefficientKeys.length)) throw new Error('Недопустимые коэффициенты доставки.');
  return {schemaVersion: 1, revision: String(raw.revision || ''), fields, resources, snapshotMaxBytes, deliveryCoefficientKeys};
}
export function validateFieldMappings(config, fields) {
  const used = new Set();
  for (const [key, param] of Object.entries(PARAMETERS)) {
    const map = config.fields[key], field = fields[map.code];
    if (!map.code && !map.required) continue;
    if (!field) throw new Error(`${param.label}: выберите доступное поле в админке (${map.code || 'не настроено'}).`);
    if (!param.types.includes(field.type)) throw new Error(`${param.label}: несовместимый тип ${field.type}.`);
    if (used.has(map.code)) throw new Error(`${field.label}: одно поле нельзя назначить нескольким параметрам.`);
    used.add(map.code);
    if (param.direction === 'out' && field.readOnly) throw new Error(`${field.label}: поле доступно только для чтения.`);
  }
  return true;
}
export function validateMappings(config, fields) {
  validateFieldMappings(config, fields);
  if (!config.resources.textFileId) throw new Error('В админке не выбран JSON-файл текстов КП на Диске.');
  if (config.deliveryCoefficientKeys === null) throw new Error('В админке укажите коэффициенты доставки либо явно выберите «нет».');
  return true;
}
export function decodeField(value, field) {
  const convert = item => {
    if (field.type === 'enumeration') {
      const found = field.items.find(option => option.id === String(item));
      if (!found && item !== '' && item !== null && item !== undefined) throw new Error(`${field.label}: неизвестный ID значения списка.`);
      return {id: String(item ?? ''), label: found?.label || ''};
    }
    return item ?? '';
  };
  return field.multiple ? (value === null || value === undefined || value === '' ? [] : Array.isArray(value) ? value : [value]).map(convert) : convert(value);
}
export function displayValue(value) {
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join(', ');
  if (value && typeof value === 'object') return value.label ?? '';
  return String(value ?? '');
}
export function readPrimary(deal, config, fields) {
  const output = {};
  for (const [key, param] of Object.entries(PARAMETERS)) {
    if (param.direction !== 'in') continue; // Never feed result fields into the calculator.
    const map = config.fields[key];
    if (!map.code && !map.required) continue;
    const field = fields[map.code];
    if (!field || !param.types.includes(field.type)) throw new Error(`${param.label}: поле не настроено или имеет несовместимый тип.`);
    output[key] = decodeField(deal[map.code], field);
    if (map.required && !displayValue(output[key]).trim()) throw new Error(`${param.label}: обязательное поле сделки не заполнено.`);
  }
  return output;
}
export function encodeResult(value, field, currency) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field.label}: результат должен быть неотрицательным числом.`);
  if (field.type === 'integer' && !Number.isInteger(value)) throw new Error(`${field.label}: дробный результат нельзя записать в целочисленное поле.`);
  const scalar = field.type === 'money' ? `${value}|${currency}` : value;
  return field.multiple ? [scalar] : scalar;
}
export class IntegrationSettings {
  constructor(adapter, {now = () => Date.now()} = {}) { this.adapter = adapter; this.now = now; this.lastRevision = ''; }
  async loadRecord() {
    const raw = await this.adapter.call('app.option.get', {option: CONFIG_OPTION});
    const exists = raw !== null && raw !== undefined && raw !== '';
    const config = normalizeIntegrationConfig(exists ? typeof raw === 'string' ? JSON.parse(raw) : raw : {});
    if (exists && (!this.lastRevision || Date.parse(config.revision) > Date.parse(this.lastRevision))) this.lastRevision = config.revision;
    return {config, exists};
  }
  async load() { return (await this.loadRecord()).config; }
  async fields() {
    const [raw, custom] = await Promise.all([
      this.adapter.call('crm.deal.fields'), this.adapter._list('crm.deal.userfield.list'),
    ]);
    return normalizeFields(raw, custom);
  }
  async save(value, fields) {
    if (!this.adapter.canManageSettings()) throw new Error('Настройки интеграции может сохранять только администратор Bitrix24.');
    const config = normalizeIntegrationConfig(value);
    validateMappings(config, fields);
    const previous = Math.max(Date.parse(config.revision) || 0, Date.parse(this.lastRevision) || 0);
    config.revision = new Date(Math.max(this.now(), previous + 1)).toISOString();
    const encoded = JSON.stringify(config);
    this.lastRevision = config.revision;
    try {
      if (await this.adapter.call('app.option.set', {options: {[CONFIG_OPTION]: encoded}}) !== true) throw new Error('Bitrix24 не подтвердил запись настроек.');
    } catch (cause) {
      if (!['REQUEST_TIMEOUT', 'CLIENT_ERROR', 'SDK_TRANSPORT_ERROR', 'SDK_RESPONSE_ERROR'].includes(cause.code)) throw cause;
      const error = new Error('Запись отправлена, подтверждение сохранения не получено.', {cause});
      error.writeSubmitted = true; error.submittedRevision = config.revision; throw error;
    }
    try {
      const actual = await this.loadRecord();
      if (!actual.exists || JSON.stringify(actual.config) !== encoded) {
        const error = new Error('Контрольное чтение не совпало с отправленной конфигурацией.');
        error.method = 'app.option.get'; error.code = 'CONFIG_MISMATCH'; throw error;
      }
    } catch (cause) {
      const error = new Error('Запись отправлена, подтверждение сохранения не получено.', {cause});
      error.writeSubmitted = true; error.submittedRevision = config.revision;
      throw error;
    }
    return config;
  }
}
