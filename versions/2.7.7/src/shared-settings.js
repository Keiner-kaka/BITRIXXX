import {normalizeDeliveryProductIds} from './delivery-products.js';
import {validatePaymentMapping} from './payment-terms.js';
import {validateDeliveryModeIds} from './delivery-mode.js';
import {validateTermTemplates} from './term-templates.js';

export const SHARED_SETTINGS_OPTION = 'yuzmQuoteConstructorSettings';
export const SHARED_SETTING_FIELDS = ['historyFolderId', 'deliveryProductId', 'deliveryAddressFieldCode',
  'deliveryFieldCode', 'paymentFieldCode', 'deliveryModeFieldCode', 'paymentMapping', 'deliveryModeMapping', 'termTemplates', 'rounding'];

export function normalizeSharedSettings(value, defaults) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректные общие настройки конструктора.');
  const result = Object.fromEntries(SHARED_SETTING_FIELDS.map(key => [key, structuredClone(value[key] ?? defaults[key])]));
  for (const key of ['historyFolderId']) {
    result[key] = String(result[key] ?? '').trim();
    if (result[key] && (!/^[1-9]\d*$/.test(result[key]) || !Number.isSafeInteger(Number(result[key])))) throw new Error('Некорректный ID в общих настройках: ' + key + '.');
  }
  result.deliveryProductId = normalizeDeliveryProductIds(result.deliveryProductId);
  for (const key of ['deliveryAddressFieldCode', 'deliveryFieldCode', 'paymentFieldCode', 'deliveryModeFieldCode']) {
    result[key] = String(result[key] ?? '').trim().toUpperCase();
    if (result[key] && !/^UF_CRM_[A-Z0-9_]+$/.test(result[key])) throw new Error('Некорректный код поля в общих настройках: ' + key + '.');
  }
  if (!['line', 'unit'].includes(result.rounding)) throw new Error('Некорректное округление в общих настройках.');
  result.paymentMapping = validatePaymentMapping(result.paymentMapping);
  result.deliveryModeMapping = validateDeliveryModeIds(result.deliveryModeMapping);
  result.termTemplates = validateTermTemplates(result.termTemplates);
  return result;
}

export class SharedSettingsStore {
  constructor(adapter, defaults) { this.adapter = adapter; this.defaults = defaults; }
  async read() {
    const raw = await this.adapter.getApplicationOption(SHARED_SETTINGS_OPTION);
    if (raw === null || raw === '') return null;
    let value;
    try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { throw new Error('Общие настройки конструктора содержат некорректный JSON.'); }
    if (!value || value.schemaVersion !== 1 || typeof value.revision !== 'string' || !value.revision) throw new Error('Неизвестный формат общих настроек конструктора.');
    return {schemaVersion: 1, revision: value.revision, settings: normalizeSharedSettings(value.settings, this.defaults)};
  }
  async save(settings, {expectedRevision = null, templateId} = {}) {
    if (!this.adapter.canManageSettings()) throw new Error('Общие настройки может изменить только администратор приложения.');
    const normalized = normalizeSharedSettings(settings, this.defaults);
    if (templateId !== undefined && !/^[1-9]\d*$/.test(String(templateId))) throw new Error('Выберите корректный ID общего шаблона КП.');
    const current = await this.read();
    if ((current?.revision ?? null) !== expectedRevision) throw new Error('Общие настройки изменены другим администратором. Перечитайте настройки перед сохранением.');
    const value = {schemaVersion: 1, revision: crypto.randomUUID(), settings: normalized};
    const options = {[SHARED_SETTINGS_OPTION]: JSON.stringify(value)};
    if (templateId !== undefined) options.yuzmQuoteTemplateId = String(templateId);
    const saved = await this.adapter.call('app.option.set', {options});
    if (saved !== true) throw new Error('Битрикс24 не подтвердил отправку общих настроек.');
    try {
      const actual = await this.read();
      if (JSON.stringify(actual) !== JSON.stringify(value)) throw new Error('Общие настройки изменились при контрольном чтении.');
      if (templateId !== undefined && await this.adapter.getQuoteTemplateId() !== String(templateId)) throw new Error('Шаблон КП не подтверждён при контрольном чтении.');
      return actual;
    } catch (error) {
      const unconfirmed = new Error('Запись отправлена, подтверждение сохранения не получено. ' + error.message);
      unconfirmed.settingsSent = true;
      throw unconfirmed;
    }
  }
}
