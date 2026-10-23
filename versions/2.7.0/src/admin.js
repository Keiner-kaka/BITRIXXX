import {BitrixAdapter} from './bitrix.js';
import {IntegrationSettings, PARAMETERS, normalizeIntegrationConfig} from './integration-config.js';
import {DiskTexts, validateTextTemplates, MAX_TEXT_BYTES} from './text-templates.js';
import {diagnoseIntegration} from './integration-diagnostics.js';
import {formatActionError} from './rest-errors.js';
const $ = id => document.getElementById(id);
const adapter = new BitrixAdapter(), settings = new IntegrationSettings(adapter), disk = new DiskTexts(adapter);
let fields, current, stagedTexts = null, busy = false, ready = false;
let recordExists = false, baseline = '', dirty = false, confirmationPending = false;
const configControls = '[id^="map-"], [id^="required-"], [id^="delivery-"], #textFileId, #textFolderId, #diskProxyPath, #referenceFileIds, #snapshotMaxBytes';
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
    if (current.fields[key].code && !fields[current.fields[key].code]) select.append(option(current.fields[key].code, 'Недоступное поле [' + current.fields[key].code + ']'));
    select.value = current.fields[key].code;
    const meta = node('p', detail(fields[select.value])); meta.className = 'hint';
    select.addEventListener('change', () => {meta.textContent = detail(fields[select.value]);});
    const required = node('input'); required.type = 'checkbox'; required.id = `required-${key}`; required.checked = current.fields[key].required; required.dataset.alwaysDisabled = String(Boolean(parameter.required));
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
}
function formValues() {
  return {...current,
    fields: Object.fromEntries(Object.keys(PARAMETERS).map(key => [key, {code: $(`map-${key}`).value, required: $(`required-${key}`).checked}])),
    resources: {...current.resources, textFileId: $('textFileId').value.trim(), textFolderId: $('textFolderId').value.trim(), diskProxyPath: $('diskProxyPath').value.trim(),
      referenceFileIds: $('referenceFileIds').value.split(',').map(value => value.trim()).filter(Boolean)},
    snapshotMaxBytes: $('snapshotMaxBytes').value,
    deliveryCoefficientKeys: ['k1','k2','k3'].filter(key => $(`delivery-${key}`).checked)};
}
function form() { return normalizeIntegrationConfig(formValues()); }
function revisionLabel() {
  const revision = current?.revision;
  if (!revision) return 'не указана';
  const date = /^\d{4}-\d\d-\d\dT/.test(revision) ? new Date(revision) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString('ru-RU', {timeZone:'Europe/Moscow', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', fractionalSecondDigits:3}) + ' (Москва), ' + revision : revision;
}
function showPersistenceStatus() {
  $('settingsSaveStatus').textContent = [
    dirty ? 'Есть несохранённые изменения.' : '',
    confirmationPending ? 'Запись отправлена, подтверждение сохранения не получено.' :
      !recordExists ? 'Общие настройки ещё не сохранены.' : !dirty ? 'Настройки сохранены.' : '',
  ].filter(Boolean).join(' ');
  $('configRevision').textContent = recordExists ? 'Последняя подтверждённая редакция: ' + revisionLabel() : 'Сохранённая редакция отсутствует.';
}
function markChanged() {
  if (!ready) return;
  dirty = JSON.stringify(formValues()) !== baseline;
  showPersistenceStatus();
}
function updateAccess() {
  const admin = adapter.canManageSettings();
  $('adminControls').disabled = busy || !ready;
  for (const input of document.querySelectorAll(configControls)) input.disabled = !admin || input.dataset.alwaysDisabled === 'true';
  for (const id of ['saveConfig','publishTexts','createTextFile','saveSignature','textUpload','diskFilePicker','signatureFile']) $(id).disabled = !admin;
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
async function reload() {
  const [record, freshFields] = await Promise.all([settings.loadRecord(), settings.fields()]);
  current = record.config; fields = freshFields; recordExists = record.exists;
  render(); baseline = JSON.stringify(formValues()); dirty = confirmationPending = false; ready = true;
  showPersistenceStatus(); updateAccess();
}
async function check() {
  $('diagnosticResults').replaceChildren();
  const results = await diagnoseIntegration(adapter, settings, disk, formValues(), result => {
    const row = node('li'); row.dataset.component = result.key; row.dataset.state = result.state;
    row.append(node('strong', result.label + ': '), document.createTextNode((result.state === 'ok' ? 'Проверка пройдена. ' : '') + result.message));
    $('diagnosticResults').append(row);
  });
  const errors = results.filter(result => result.state === 'error').length;
  const saved = recordExists && !dirty && !confirmationPending ? 'Настройки сохранены. ' : '';
  status(saved + (errors ? `Диагностика: ошибок ${errors}; подробности по компонентам ниже.` : 'Диагностика чтения завершена.') + ' Настройки не изменялись. Права записи не проверялись.');
}
function action(id, callback) { $(id).addEventListener('click', () => run(callback)); }
async function run(callback, actionName = document.activeElement?.textContent?.trim() || 'Действие') {
  if (busy) return;
  busy = true; updateAccess();
  status(actionName + '…');
  try { await callback(); }
  catch (error) {
    if (error.writeSubmitted) {confirmationPending = true; showPersistenceStatus();}
    status(formatActionError(actionName, error));
  }
  finally {busy = false; updateAccess();}
}
action('reloadConfig', async () => {
  if ((dirty || confirmationPending) && !window.confirm('Перечитать сохранённые настройки? Введённые соответствия и другие несохранённые изменения формы будут заменены.')) {
    status('Перечитывание отменено. Введённые значения остались в форме.'); return;
  }
  await reload(); status('Настройки перечитаны из app.option.');
});
action('checkConfig', check);
action('saveConfig', async () => {
  if (!adapter.canManageSettings()) throw new Error('Настройки интеграции может сохранять только администратор Bitrix24.');
  const value = form(), freshFields = await settings.fields();
  const saved = await settings.save(value, freshFields);
  current = saved; fields = freshFields; recordExists = true; render();
  baseline = JSON.stringify(formValues()); dirty = confirmationPending = false;
  showPersistenceStatus(); status('Настройки сохранены. Редакция: ' + revisionLabel());
});
action('reloadTextConfig', async () => {const value = form(); preview(await disk.read(value.resources.textFileId, value.resources.diskProxyPath)); status('Действующая конфигурация текстов загружена.');});
action('listTextFiles', async () => {
  const value = form(); if (!value.resources.textFolderId) throw new Error('Укажите ID папки текстов.');
  const files = await adapter._list('disk.folder.getchildren', {id: Number(value.resources.textFolderId), filter: {TYPE: 'file'}});
  $('diskFilePicker').replaceChildren(option('', 'Выберите существующий файл'), ...files.filter(file => /\.json$/i.test(file.NAME)).map(file => option(String(file.ID), file.NAME + ' #' + file.ID)));
  status('Список JSON-файлов папки загружен.');
});
$('diskFilePicker').addEventListener('change', () => {if ($('diskFilePicker').value) {$('textFileId').value = $('diskFilePicker').value; markChanged();}});
for (const event of ['input', 'change']) $('adminControls').addEventListener(event, e => {if (e.target.matches(configControls)) markChanged();});
$('textUpload').addEventListener('change', () => run(async () => {
  const file = $('textUpload').files[0];
  if (!file || file.size > MAX_TEXT_BYTES) throw new Error('Выберите JSON-файл размером не более 1 МБ.');
  preview(JSON.parse(await file.text())); status('Структура нового JSON проверена; файл ещё не опубликован.');
}, 'Проверка нового JSON'));
action('publishTexts', async () => {
  if (!stagedTexts) throw new Error('Сначала откройте и проверьте JSON.');
  const value = form(); preview(await disk.publish(value.resources.textFileId, stagedTexts, value.resources.diskProxyPath));
  status('Новая версия опубликована и прочитана с Диска. ID файла сохранён. Ранее сформированные документы и JSON расчётов сохраняют свои тексты.');
});
action('createTextFile', async () => {
  if (!adapter.canManageSettings()) throw new Error('Загружать новый файл может только администратор Bitrix24.');
  if (!stagedTexts) throw new Error('Сначала откройте и проверьте JSON.');
  const value = form(); if (!value.resources.textFolderId) throw new Error('Укажите ID папки текстов.');
  let binary = ''; for (const byte of new TextEncoder().encode(JSON.stringify(stagedTexts, null, 2))) binary += String.fromCharCode(byte);
  const result = await adapter.call('disk.folder.uploadfile', {id: Number(value.resources.textFolderId), data: {NAME: 'yuzm-quote-texts.json'}, generateUniqueName: true, fileContent: ['yuzm-quote-texts.json', btoa(binary)]});
  if (!/^[1-9]\d*$/.test(String(result?.ID))) throw new Error('Диск не вернул ID загруженного файла.');
  $('textFileId').value = result.ID; markChanged();
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
    await reload();
    status(adapter.canManageSettings() ? 'Подключено к той же интеграции. Сохранение настроек и диагностика выполняются отдельно.' : 'Общие настройки доступны для чтения. Изменять их может только администратор Bitrix24.');
  } catch (error) {status(formatActionError('Загрузка настроек', error));}
}
boot();
