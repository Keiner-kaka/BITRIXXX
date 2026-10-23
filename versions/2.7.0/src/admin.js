import {BitrixAdapter} from './bitrix.js';
import {IntegrationSettings, PARAMETERS, normalizeIntegrationConfig, validateMappings} from './integration-config.js';
import {DiskTexts, validateTextTemplates, MAX_TEXT_BYTES} from './text-templates.js';
const $ = id => document.getElementById(id);
const adapter = new BitrixAdapter(), settings = new IntegrationSettings(adapter), disk = new DiskTexts(adapter);
let fields, current, stagedTexts = null, busy = false;
const status = text => { $('adminStatus').textContent = text; };
function node(tag, text = '') {const element = document.createElement(tag); element.textContent = text; return element;}
function option(value, label) {const element = node('option', label); element.value = value; return element;}
function detail(field) {
  return field ? `${field.label} · ${field.code} · тип: ${field.type} · множественное: ${field.multiple ? 'да' : 'нет'}${field.readOnly ? ' · только чтение' : ''}${field.items.length ? ' · значения: ' + field.items.map(item => item.id + ' = ' + item.label).join('; ') : ''}` : 'Поле не выбрано';
}
function render() {
  $('fieldMappings').replaceChildren(...Object.entries(PARAMETERS).map(([key, parameter]) => {
    const row = node('div'); row.className = 'mapping-row';
    const label = node('label', parameter.label + (parameter.direction === 'in' ? ' ← сделка' : ' → сделка')); label.htmlFor = `map-${key}`;
    const select = node('select'); select.id = `map-${key}`;
    select.append(option('', 'Не настроено'), ...Object.values(fields).map(field => option(field.code, `${field.label} [${field.code}] — ${field.type}${parameter.types.includes(field.type) ? '' : ' (несовместим)'}`)));
    select.value = current.fields[key].code;
    const meta = node('p', detail(fields[select.value])); meta.className = 'hint';
    select.addEventListener('change', () => {meta.textContent = detail(fields[select.value]);});
    const required = node('input'); required.type = 'checkbox'; required.id = `required-${key}`; required.checked = current.fields[key].required; required.disabled = Boolean(parameter.required);
    const requiredLabel = node('label'); requiredLabel.append(required, document.createTextNode(' Обязательное поле'));
    row.append(label, select, requiredLabel, meta); return row;
  }));
  $('deliveryCoefficients').replaceChildren(...['k1','k2','k3'].map(key => {
    const label = node('label'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.id = `delivery-${key}`; checkbox.checked = current.deliveryCoefficientKeys?.includes(key);
    label.append(checkbox, document.createTextNode(' ' + key.toUpperCase() + ' ')); return label;
  }));
  for (const key of ['textFileId','textFolderId','diskProxyPath']) $(key).value = current.resources[key];
  $('referenceFileIds').value = current.resources.referenceFileIds.join(', ');
  $('snapshotMaxBytes').value = current.snapshotMaxBytes;
  $('configRevision').textContent = 'Редакция настроек: ' + (current.revision || 'ещё не сохранены');
}
function form() {
  return normalizeIntegrationConfig({...current,
    fields: Object.fromEntries(Object.keys(PARAMETERS).map(key => [key, {code: $(`map-${key}`).value, required: $(`required-${key}`).checked}])),
    resources: {textFileId: $('textFileId').value.trim(), textFolderId: $('textFolderId').value.trim(), diskProxyPath: $('diskProxyPath').value.trim(),
      referenceFileIds: $('referenceFileIds').value.split(',').map(value => value.trim()).filter(Boolean)},
    snapshotMaxBytes: $('snapshotMaxBytes').value,
    deliveryCoefficientKeys: ['k1','k2','k3'].filter(key => $(`delivery-${key}`).checked)});
}
function preview(value) {
  stagedTexts = validateTextTemplates(value);
  $('textVersion').textContent = 'Версия JSON: ' + stagedTexts.version + ', схема: ' + stagedTexts.schemaVersion;
  $('textPreview').replaceChildren(...Object.values(stagedTexts.templates).map(category => {
    const block = node('section'); block.append(node('h3', category.label + ' → ' + category.field));
    for (const preset of category.presets) block.append(node('strong', preset.label + ' [' + preset.id + ']'), node('p', preset.text));
    return block;
  }));
}
async function reload() { [current, fields] = await Promise.all([settings.load(), settings.fields()]); render(); }
async function check() {
  const value = form(); validateMappings(value, fields);
  const methods = await adapter.call('methods');
  if (!Array.isArray(methods)) throw new Error('Bitrix24 не вернул список доступных REST-методов.');
  const required = ['app.option.get','app.option.set','crm.deal.fields','crm.deal.userfield.list','crm.deal.get','crm.deal.update','crm.deal.productrows.get',
    'crm.documentgenerator.document.add','crm.documentgenerator.document.get','crm.documentgenerator.document.list','crm.documentgenerator.template.get','crm.documentgenerator.template.list','disk.file.get','disk.file.uploadVersion','user.get'];
  const missing = required.filter(method => !methods.includes(method));
  if (!methods.includes('crm.item.productrow.set') && !methods.includes('crm.deal.productrows.set')) missing.push('crm.item.productrow.set / crm.deal.productrows.set');
  if (missing.length) throw new Error('Недоступные REST-методы: ' + missing.join(', '));
  const texts = await disk.read(value.resources.textFileId, value.resources.diskProxyPath); if (!stagedTexts) preview(texts);
  if (value.resources.textFolderId) {
    const folder = await adapter.call('disk.folder.get', {id: Number(value.resources.textFolderId)});
    if (String(folder?.ID) !== value.resources.textFolderId) throw new Error('Не подтверждена папка текстов на Диске.');
    await adapter._list('disk.folder.getchildren', {id: Number(value.resources.textFolderId)});
  }
  for (const id of value.resources.referenceFileIds) {
    const file = await adapter.call('disk.file.get', {id: Number(id)});
    if (String(file?.ID) !== id || file.TYPE && file.TYPE !== 'file') throw new Error('Не подтверждён справочный файл #' + id);
  }
  return value;
}
function action(id, callback) { $(id).addEventListener('click', () => run(callback)); }
async function run(callback) {
  if (busy) return;
  busy = true; $('adminControls').disabled = true;
  try { await callback(); }
  catch (error) {status(String(error.message).replace(/https?:\/\/[^\s"'<>]+/g, '[адрес скрыт]'));}
  finally {busy = false; $('adminControls').disabled = !adapter.canManageSettings();}
}
action('reloadConfig', async () => {await reload(); status('Настройки перечитаны.');});
action('checkConfig', async () => {await check(); status('Поля, чтение JSON, файлы и наличие REST-методов проверены. Права записи проверяются ответом при сохранении; выполните приёмку на тестовой сделке.');});
action('saveConfig', async () => {const value = await check(); current = await settings.save(value, fields); render(); status('Общие настройки сохранены и повторно прочитаны.');});
action('reloadTextConfig', async () => {const value = form(); preview(await disk.read(value.resources.textFileId, value.resources.diskProxyPath)); status('Действующая конфигурация текстов загружена.');});
action('listTextFiles', async () => {
  const value = form(); if (!value.resources.textFolderId) throw new Error('Укажите ID папки текстов.');
  const files = await adapter._list('disk.folder.getchildren', {id: Number(value.resources.textFolderId), filter: {TYPE: 'file'}});
  $('diskFilePicker').replaceChildren(option('', 'Выберите существующий файл'), ...files.filter(file => /\.json$/i.test(file.NAME)).map(file => option(String(file.ID), file.NAME + ' #' + file.ID)));
  status('Список JSON-файлов папки загружен.');
});
$('diskFilePicker').addEventListener('change', () => {if ($('diskFilePicker').value) $('textFileId').value = $('diskFilePicker').value;});
$('textUpload').addEventListener('change', () => run(async () => {
  const file = $('textUpload').files[0];
  if (!file || file.size > MAX_TEXT_BYTES) throw new Error('Выберите JSON-файл размером не более 1 МБ.');
  preview(JSON.parse(await file.text())); status('Структура нового JSON проверена; файл ещё не опубликован.');
}));
action('publishTexts', async () => {
  if (!stagedTexts) throw new Error('Сначала откройте и проверьте JSON.');
  const value = form(); preview(await disk.publish(value.resources.textFileId, stagedTexts, value.resources.diskProxyPath));
  status('Новая версия опубликована и прочитана с Диска. ID файла сохранён. Ранее сформированные документы и JSON расчётов сохраняют свои тексты.');
});
action('createTextFile', async () => {
  if (!stagedTexts) throw new Error('Сначала откройте и проверьте JSON.');
  const value = form(); if (!value.resources.textFolderId) throw new Error('Укажите ID папки текстов.');
  let binary = ''; for (const byte of new TextEncoder().encode(JSON.stringify(stagedTexts, null, 2))) binary += String.fromCharCode(byte);
  const result = await adapter.call('disk.folder.uploadfile', {id: Number(value.resources.textFolderId), data: {NAME: 'yuzm-quote-texts.json'}, generateUniqueName: true, fileContent: ['yuzm-quote-texts.json', btoa(binary)]});
  if (!/^[1-9]\d*$/.test(String(result?.ID))) throw new Error('Диск не вернул ID загруженного файла.');
  $('textFileId').value = result.ID;
  preview(await disk.read(String(result.ID), value.resources.diskProxyPath));
  status('Файл #' + result.ID + ' создан. Сохраните общие настройки, чтобы подключить его к конструктору.');
});
action('readSignature', async () => {
  const reference = await adapter.getManagerSignature($('signatureUser').value.trim());
  if (reference) await adapter.resolveManagerSignature(reference);
  $('signatureFile').value = reference?.fileId || ''; status(reference ? 'Подпись сотрудника доступна.' : 'Подпись сотрудника не назначена.');
});
action('saveSignature', async () => {await adapter.setManagerSignature($('signatureUser').value.trim(), $('signatureFile').value.trim()); status('Привязка подписи сохранена и проверена.');});
async function boot() {
  try {
    const library = await window.YUZM_BX24.load();
    if (!library.sdk) throw new Error(library.message);
    adapter.sdk = library.sdk;
    if (!(await adapter.init()).connected) throw new Error(adapter.connectionError.message);
    if (!adapter.canManageSettings()) throw new Error('Изменение общих настроек доступно только администратору Bitrix24.');
    await reload(); $('adminControls').disabled = false; status('Подключено к той же интеграции. Выберите поля и ресурсы, проверьте и сохраните настройки.');
  } catch (error) {status(error.message);}
}
boot();
