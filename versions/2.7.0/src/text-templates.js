export const TEXT_FIELDS = {payment: 'YuzmPaymentTerms', fasteners: 'YuzmFastenerTerms', documents: 'YuzmDocumentsTerms', delivery: 'YuzmDeliveryTerms', validity: 'YuzmValidityTerms'};
export const MAX_TEXT_BYTES = 1000000;
export function validateTextTemplates(raw) {
  if (!raw || raw.schemaVersion !== 1 || !raw.templates || typeof raw.templates !== 'object' || Array.isArray(raw.templates)) throw new Error('Тексты КП: ожидаются schemaVersion: 1 и объект templates.');
  const result = {schemaVersion: 1, version: String(raw.version ?? '1'), templates: {}};
  const placeholders = new Set();
  for (const [key, category] of Object.entries(raw.templates)) {
    if (!/^[a-zA-Z][\w-]{0,49}$/.test(key) || !category || !Array.isArray(category.presets) || !category.presets.length) throw new Error('Тексты КП: некорректная категория или пустой список вариантов.');
    const field = TEXT_FIELDS[key] || category.field;
    if (!/^Yuzm[A-Za-z0-9]{1,60}Terms$/.test(field || '') || placeholders.has(field)) throw new Error('Тексты КП: задайте уникальное поле Yuzm…Terms для категории.');
    placeholders.add(field);
    const ids = new Set();
    const presets = category.presets.map(item => {
      if (!item || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id || '') || ids.has(item.id) || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 250 || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 10000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item.text)) throw new Error(`Тексты КП: некорректный вариант в ${key}.`);
      ids.add(item.id); return {id: item.id, label: item.label, text: item.text};
    });
    if (!ids.has(category.defaultPresetId)) throw new Error(`Тексты КП: defaultPresetId категории ${key} не найден.`);
    result.templates[key] = {field, label: String(category.label || key), defaultPresetId: category.defaultPresetId, allowCustom: category.allowCustom !== false, presets};
  }
  for (const key of Object.keys(TEXT_FIELDS)) if (!result.templates[key]) throw new Error(`Тексты КП: отсутствует категория ${key}.`);
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_TEXT_BYTES) throw new Error('Тексты КП превышают 1 МБ.');
  return result;
}
export function appliedTexts(documentFields, templates) {
  return Object.fromEntries(Object.entries(templates.templates).map(([key, category]) => {
    const text = documentFields[category.field] ?? '';
    const selected = category.presets.find(preset => preset.text === text);
    if (!selected && !category.allowCustom) throw new Error(`${category.label}: выберите готовый вариант.`);
    return [key, {field: category.field, presetId: selected?.id || null, text, configVersion: templates.version}];
  }));
}
function fileId(value) {
  if (!/^[1-9]\d*$/.test(String(value))) throw new Error('Диск: требуется положительный ID файла.');
  return Number(value);
}
export class DiskTexts {
  constructor(adapter, {fetcher = globalThis.fetch, origin = globalThis.location?.origin} = {}) {
    this.adapter = adapter; this.fetcher = fetcher.bind(globalThis); this.origin = origin;
  }
  async metadata(value, extension = 'json') {
    const result = await this.adapter.call('disk.file.get', {id: fileId(value)});
    if (String(result?.ID) !== String(value) || !String(result.NAME).toLowerCase().endsWith('.' + extension)) throw new Error(`Диск: файл #${value} недоступен либо имеет неверный тип ${extension}.`);
    if (Number(result.SIZE) > MAX_TEXT_BYTES && extension === 'json') throw new Error('JSON Диска превышает 1 МБ.');
    return result;
  }
  async read(value, proxyPath = '') {
    const metadata = await this.metadata(value);
    let response;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      if (proxyPath) {
        const endpoint = new URL(proxyPath, this.origin);
        if (endpoint.origin !== this.origin || endpoint.protocol !== 'https:') throw new Error('Прокси Диска должен работать на текущем HTTPS-хосте.');
        const auth = this.adapter.sdk?.getAuth?.();
        const domain = this.adapter.sdk?.getDomain?.();
        if (!auth?.access_token || !domain) throw new Error('SDK не предоставил авторизацию для чтения Диска.');
        response = await this.fetcher(endpoint.href, {method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({fileId: fileId(value), domain, accessToken: auth.access_token}), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal});
      } else {
        let url;
        try { url = new URL(metadata.DOWNLOAD_URL); } catch { throw new Error('Диск не вернул URL чтения файла.'); }
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Диск вернул недопустимый URL чтения файла.');
        response = await this.fetcher(url.href, {mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal});
      }
      if (!response.ok || response.type === 'opaque') throw new Error('Диск не разрешил чтение содержимого.');
      if (Number(response.headers?.get('content-length')) > MAX_TEXT_BYTES) throw new Error('JSON Диска превышает 1 МБ.');
      const content = await response.text();
      if (new TextEncoder().encode(content).length > MAX_TEXT_BYTES) throw new Error('JSON Диска превышает 1 МБ.');
      return validateTextTemplates(JSON.parse(content));
    } catch {
      // Fetch/JSON errors can contain URLs with authorization. Never propagate them.
      throw new Error('Не удалось прочитать JSON текстов с Диска: проверьте структуру, доступ и CORS. При запрете CORS настройте поставляемый серверный прокси на HTTPS-хосте приложения.');
    } finally { clearTimeout(timer); }
  }
  async publish(value, raw, proxyPath = '') {
    if (!this.adapter.canManageSettings()) throw new Error('Публиковать тексты может только администратор Bitrix24.');
    const templates = validateTextTemplates(raw);
    await this.metadata(value);
    const bytes = new TextEncoder().encode(JSON.stringify(templates, null, 2));
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    const result = await this.adapter.call('disk.file.uploadVersion', {id: fileId(value), fileContent: ['yuzm-quote-texts.json', btoa(binary)]});
    if (result !== true && String(result?.ID) !== String(value)) throw new Error('Диск не подтвердил публикацию новой версии файла.');
    const actual = await this.read(value, proxyPath);
    if (JSON.stringify(actual) !== JSON.stringify(templates)) throw new Error('Опубликованный файл отличается от отправленного; перечитайте конфигурацию.');
    return actual;
  }
}
