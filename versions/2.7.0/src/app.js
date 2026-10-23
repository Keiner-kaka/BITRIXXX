import {calculateQuote, formatMoney, validateConfig as normalizeConfig, withCoatingOptions, coatingSupportsRal, formatCoating, parseNumber, formatExecutionTerm, isCustomRow} from './calculator.js';
import {BitrixAdapter} from './bitrix.js';
import {CatalogSearchIndex, navigationLabels} from './catalog.js';
import {VirtualList} from './virtual-list.js';
import {normalizeStoredDraft} from './draft-store.js';
import {signatureSourceText, managerValues} from './manager.js';
import {products as demoProducts, initialRows, newRow, newCustomRow} from './demo.js';

import {assignFasteners} from './fasteners.js';
import {IntegrationSettings, PARAMETERS, displayValue, validateMappings} from './integration-config.js';
import {loadPrimaryData} from './deal-primary.js';
import {DiskTexts, validateTextTemplates, appliedTexts} from './text-templates.js';
import {QuoteSaver} from './quote-save.js';
import {verifySnapshot, calculateMetrics} from './quote-snapshot.js';

const $ = id => document.getElementById(id);
const clone = value => structuredClone(value);
const uid = () => crypto.randomUUID();
const validateConfig = raw => withCoatingOptions(normalizeConfig(raw));
const adapter = new BitrixAdapter();
const integrationSettings = new IntegrationSettings(adapter);
const diskTexts = new DiskTexts(adapter);
let integrationConfig, dealFields, textConfig, primaryData = null, integrationReady = false;
let integrationMessage = '';
const saver = new QuoteSaver(adapter, integrationSettings, {scope: window.location.host, notify: message => status(message)});
const STORE = 'yuzm-kp-prototype-v1';
let builtinConfig, config, calculation, state, connected = false, busy = false, chosenRow = null;
let connecting = false, connectionCode = 'NOT_STARTED';
const priceEdits = new Map();
let catalogPriceState = {values: new Map(), pending: new Set(), inFlight: new Set(), scheduled: false, loading: false};
let templates = [], templatesLoaded = false;
let sharedTemplate = {id: '', loaded: false, loading: false, error: ''};
let managerProfile = null, managerLoading = false, managerRequest = 0, managerMessage = '';
let catalogIndex = null, catalogLoad = null, catalogGeneration = 0, catalogRequest = 0, catalogFilterTimer;
let catalogList;
let generatedDocuments = [], documentsLoading = false, documentsError = '', documentsRequest = 0;
let previewData = null, previewCreatedDocument = null;
const managerFields = ['YuzmManagerPosition', 'YuzmManagerName', 'YuzmManagerPhone', 'YuzmManagerEmail'];
let defaultDocumentFields = {YuzmManagerPosition: '', YuzmManagerName: '', YuzmManagerPhone: '', YuzmManagerEmail: ''};
function migrateDocumentFields(fields) { return fields; }
function useTextConfig(value) {
  textConfig = value;
  defaultDocumentFields = {...Object.fromEntries(Object.values(value.templates).map(category => [category.field,
    category.presets.find(preset => preset.id === category.defaultPresetId).text])),
    YuzmManagerPosition: '', YuzmManagerName: '', YuzmManagerPhone: '', YuzmManagerEmail: ''};
}
async function reloadIntegration() {
  integrationReady = false;
  integrationMessage = 'Проверка настроек интеграции…';
  const [settings, fields] = await Promise.all([integrationSettings.load(), integrationSettings.fields()]);
  integrationConfig = settings; dealFields = fields;
  validateMappings(settings, fields);
  const texts = await diskTexts.read(settings.resources.textFileId, settings.resources.diskProxyPath);
  useTextConfig(texts); adapter.managerFieldCode = settings.fields.manager.code;
  integrationReady = true;
  integrationMessage = 'Настройки интеграции и тексты КП загружены.';
}
const defaultSettings = {dealId: '', rounding: 'line'};
const draft = () => state.draft;

function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key === 'checked') node.checked = Boolean(value);
    else if (key === 'value') node.value = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children) node.append(child);
  return node;
}
function option(value, text) { return element('option', {value, text}); }
function select(options, value, attrs = {}) {
  const node = element('select', attrs, options.map(x => option(x.value, x.text)));
  node.value = value;
  return node;
}
function input(value, field, label, attrs = {}) {
  return element('input', {value, 'data-field': field, 'aria-label': label, ...attrs});
}
function cell(className, children) { return element('div', {class: className}, children); }
function status(message, kind = 'info') {
  $('status').textContent = message;
  $('status').className = 'status status-' + kind;
  $('status').hidden = false;
}
function settingsMessage(message) {
  $('settingsError').textContent = message;
  $('settingsError').hidden = !message;
}
function openDialog(id) { $(id).showModal(); }
function closeDialog(id) { $(id).close(); }
function blankDraft(rows = []) {
  return {companyName: 'ООО «КраснодарЭлектро»', rows, currency: 'RUB', documentFields: clone(defaultDocumentFields), managerOverrides: {}};
}
function freshState() {
  return {schemaVersion: 3, scope: 'demo', activeDealId: null, settings: clone(defaultSettings), draft: blankDraft(clone(initialRows))};
}
function remember() {
  try {
    delete state.settings.historyFolderId;
    localStorage.setItem(STORE + '-' + state.scope, JSON.stringify({state, config}));
    localStorage.setItem(STORE + '-settings', JSON.stringify(state.settings));
  } catch { status('Браузер не сохранил текущий черновик. При необходимости скачайте расчёт JSON.', 'error'); }
}
function readStored(scope) {
  try {
    const normalized = normalizeStoredDraft(JSON.parse(localStorage.getItem(STORE + '-' + scope)), scope);
    if (!normalized) return null;
    const rawConfig = normalized.config;
    normalized.config = validateConfig({...builtinConfig, currency: rawConfig?.currency || 'RUB', rounding: rawConfig?.rounding || 'line'});
    normalized.state.draft.rows = migrateRows(normalized.state.draft.rows, rawConfig);
    normalized.state.draft.documentFields = migrateDocumentFields({...clone(defaultDocumentFields), ...normalized.state.draft.documentFields});
    ensureManagerOverrides(normalized.state.draft);
    return normalized;
  } catch { return null; }
}
function migrateStoredDrafts() {
  // Upgrade only this app's saved data, retaining the selected editable draft.
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(STORE + '-') || key === STORE + '-settings') continue;
      const scope = key.slice(STORE.length + 1), value = readStored(scope);
      if (value) localStorage.setItem(key, JSON.stringify(value));
    }
  } catch { /* Storage may be unavailable; the current in-memory draft still works. */ }
}
function restore(value) {
  state = value.state; config = value.config;
  state.settings = {...clone(defaultSettings), ...state.settings};
  for (const key of ['historyFolderId', 'relationsFileId', 'documentFields', 'defaultDocumentTemplateId', 'pricesFileId', 'metalPricesFileId', 'formulaMode']) delete state.settings[key];

}
function formulaText() {
  return 'Цена = (цена каталога + выбранные метизы) × К1 × К2 × К3. Покрытие — название для КП.';
}
function renderCustomer() { $('companyName').value = draft().companyName || ''; }
function renderTerms() {
  draft().documentFields ||= clone(defaultDocumentFields);
  const nodes = Object.entries(textConfig.templates).map(([key, category]) => {
    const field = category.field, value = draft().documentFields[field] ?? '';
    const picker = select([...(category.allowCustom ? [{value: '', text: 'Свой текст'}] : [{value: '', text: 'Выберите вариант'}]),
      ...category.presets.map(preset => ({value: preset.id, text: preset.label}))],
      category.presets.find(preset => preset.text === value)?.id || '', {'aria-label': category.label});
    const textarea = element('textarea', {id: field, rows: '3', 'aria-label': category.label, value});
    textarea.readOnly = !category.allowCustom;
    picker.addEventListener('change', () => {
      const preset = category.presets.find(item => item.id === picker.value);
      if (preset) { draft().documentFields[field] = preset.text; textarea.value = preset.text; remember(); }
    });
    textarea.addEventListener('input', () => {
      draft().documentFields[field] = textarea.value;
      picker.value = category.presets.find(item => item.text === textarea.value)?.id || ''; remember();
    });
    return element('div', {class: 'field'}, [element('label', {for: field, text: category.label}), picker, textarea]);
  });
  $('quoteTextFields').replaceChildren(...nodes);
  for (const key of managerFields) $(key).value = draft().documentFields[key] || '';
  $('textConfigVersion').textContent = 'Редакция текстов: ' + textConfig.version;
  $('managerSignatureSource').value = signatureSourceText(draft().managerSignatureReference);
  renderManagerControls();
}
function renderPrimary() {
  $('primaryFields').replaceChildren(...Object.entries(primaryData?.values || {}).flatMap(([key, value]) => [
    element('dt', {text: PARAMETERS[key].label}), element('dd', {text: displayValue(value) || '—'})]));
}

function ensureManagerOverrides(target) {
  // Existing nonempty signatures predate auto-fill and are treated as manual.
  if (!target.managerOverrides || typeof target.managerOverrides !== 'object' || Array.isArray(target.managerOverrides)) {
    target.managerOverrides = Object.fromEntries(managerFields.map(key => [key, Boolean(target.documentFields?.[key])]));
  }
  return target.managerOverrides;
}
function applyManagerProfile(force = false) {
  if (!managerProfile || managerProfile.dealId !== String(state.activeDealId) || state.scope === 'demo') return;
  const target = draft(), values = managerValues(managerProfile);
  const changedOwner = target.managerUserId && target.managerUserId !== managerProfile.userId;
  const overrides = ensureManagerOverrides(target);
  target.managerUserId = managerProfile.userId;
  target.managerSignatureReference = clone(managerProfile.signatureReference);
  for (const key of managerFields) {
    if (!force && !changedOwner && overrides[key]) continue;
    target.documentFields[key] = values[key]; overrides[key] = false;
  }
}
function renderManagerControls() {
  const inDeal = connected && state.scope !== 'demo' && state.activeDealId;
  $('fillManagerBtn').disabled = !inDeal || busy || managerLoading;
  $('managerSummary').textContent = managerLoading ? 'Загрузка профиля…'
    : draft().documentFields?.YuzmManagerName || 'Можно заполнить вручную';
  let message = inDeal ? managerMessage : 'ФИО, должность, почта, телефон и изображение подписи подставляются по ответственному за сделку.';
  if (inDeal && managerProfile && !draft().documentFields.YuzmManagerPhone) {
    message += managerProfile.phoneAvailable
      ? ' Рабочий телефон в профиле не указан — заполните его вручную.'
      : ' Для чтения рабочего телефона добавьте разрешение «Пользователи (базовый) — user_basic» или заполните его вручную.';
  }
  $('managerProfileHint').textContent = message;
  const canEdit = inDeal && managerProfile && adapter.canManageSettings() && !busy && !managerLoading;
  $('managerSignatureSource').readOnly = !canEdit;
  $('saveManagerSignatureBtn').disabled = !canEdit;
  $('managerSignatureHint').textContent = managerProfile?.signatureError || (inDeal && managerProfile
    ? (draft().managerSignatureReference ? 'Подпись привязана к сотруднику #' + managerProfile.userId + '. ' : 'Изображение подписи для этого сотрудника не задано. ')
      + (adapter.canManageSettings() ? 'Сохранённая настройка доступна всем менеджерам приложения.' : 'Настройку изображения выполняет администратор приложения.')
    : 'Подключите сделку, чтобы настроить подпись её ответственного.');
  const imageUrl = inDeal && managerProfile && managerProfile.userId === draft().managerUserId
    && JSON.stringify(managerProfile.signatureReference) === JSON.stringify(draft().managerSignatureReference) ? managerProfile.signatureUrl : '';
  $('managerSignaturePreview').replaceChildren(managerBlock(draft().documentFields, imageUrl));
}

function managerBlock(fields = {}, imageUrl = '') {
  const contacts = [element('p', {text: 'С уважением,'}), element('p', {text: fields.YuzmManagerPosition || ''})];
  const email = String(fields.YuzmManagerEmail || '').trim();
  if (email) contacts.push(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)
    ? element('a', {href: 'mailto:' + email, text: email}) : element('p', {text: email}));
  if (fields.YuzmManagerPhone) contacts.push(element('p', {text: 'Тел. ' + fields.YuzmManagerPhone}));
  const image = element('div', {class: 'manager-block-image'});
  if (imageUrl) {
    try {
      const url = new URL(imageUrl);
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
        const img = element('img', {src: url.href, alt: 'Подпись менеджера', referrerpolicy: 'no-referrer'});
        img.addEventListener('error', () => { image.replaceChildren(element('span', {class: 'hint', text: 'Изображение подписи недоступно'})); });
        image.append(img);
      }
    } catch { /* Invalid legacy image URLs are never rendered. */ }
  } else image.append(element('span', {class: 'hint', text: 'Изображение подписи не задано'}));
  return element('div', {class: 'manager-block'}, [element('div', {class: 'manager-block-contacts'}, contacts), image,
    element('div', {class: 'manager-block-name', text: fields.YuzmManagerName || ''})]);
}

async function saveManagerSignature() {
  if (busy || managerLoading || !managerProfile || !adapter.canManageSettings()) return;
  const userId = managerProfile.userId, scope = state.scope, dealId = String(state.activeDealId);
  try {
    busy = true; recalc();
    const current = await adapter.getResponsibleManager(dealId);
    if (current.userId !== userId) throw new Error('Ответственный изменился. Обновите данные ответственного перед настройкой подписи.');
    await adapter.setManagerSignature(userId, $('managerSignatureSource').value);
    status('Подпись сотрудника #' + userId + ' сохранена.', 'success');
  } catch (error) { status(safeError(error), 'error'); }
  finally {
    busy = false;
    if (state.scope === scope && String(state.activeDealId) === dealId) await refreshManagerProfile();
    recalc();
  }
}
async function refreshManagerProfile(force = false) {
  if (!connected || state.scope === 'demo' || !state.activeDealId || busy || managerLoading) return;
  const dealId = String(state.activeDealId), scope = state.scope;
  const request = ++managerRequest;
  managerLoading = true;
  managerMessage = 'Получаю данные ответственного за сделку…';
  recalc(); renderManagerControls();
  try {
    const profile = await adapter.getResponsibleManager(dealId);
    if (request !== managerRequest || state.scope !== scope || String(state.activeDealId) !== dealId) return;
    managerProfile = profile;
    applyManagerProfile(force);
    managerMessage = 'Ответственный: ' + (profile.name || 'сотрудник #' + profile.userId) + '. Поля подписи можно изменить вручную.';
    renderTerms(); remember();
  } catch (error) {
    if (request !== managerRequest || state.scope !== scope) return;
    managerProfile = null;
    managerMessage = 'Автозаполнение недоступно. Проверьте разрешение «Пользователи (базовый) — user_basic» и доступ к профилю или заполните подпись вручную. ' + safeError(error);
    renderManagerControls();
  } finally {
    if (request === managerRequest && state.scope === scope) {
      managerLoading = false;
      recalc(); renderManagerControls();
    }
  }
}
function withoutRetiredFields(rows) {
  return rows.map(row => {
    const clean = {...row};
    for (const field of ['drawingId', 'coatingFactor', 'extraCoating', 'delivery', 'nonstandard']) delete clean[field];
    return clean;
  });
}
function migrateRows(rows, rawConfig) {
  return withoutRetiredFields(rows).map(row => {
    if (row.k3 === undefined) {
      const legacyFactor = rawConfig?.calculationVersion !== 2 && rawConfig?.formulaMode !== 'excel'
        ? rawConfig?.coatings?.find(c => c.code === row.coatingCode)?.coefficient : undefined;
      row.k3 = legacyFactor === undefined ? '1' : String(legacyFactor);
    }
    if (rawConfig?.formulaMode === 'excel' && !isCustomRow(row)) row.needsCatalogPrice = true;
    row.fastenersEnabled ??= false; row.fasteners ??= '';
    row.fastenersPropertyPrice ??= null;
    delete row.fastenersMatched;
    row.customCoating ??= '';
    if (!builtinConfig.coatings.some(c => c.code === row.coatingCode)) {
      const previous = rawConfig?.coatings?.find(c => c.code === row.coatingCode);
      row.customCoating = previous ? formatCoating(previous, row.ralColor, row.customCoating) : row.coatingCode || '';
      row.coatingCode = 'custom'; row.ralColor = '';
    }
    delete row.pricePerKg; delete row.weight;
    row.executionTerm ??= ''; row.ralColor ??= '';
    return row;
  });
}
function productLabel(product) {
  return product.name + (product.isVariation ? ' · вариация #' + product.id : '')
    + (product.isParent ? ' · основной товар' : '') + (product.active === 'N' ? ' · неактивен' : '');
}
function assignProduct(row, product) {
  Object.assign(row, {productId: String(product.id), productName: product.name, basePrice: product.basePrice,
    currency: product.currency, source: product.source || 'catalog', priceSource: product.source === 'deal' ? 'deal' : 'catalog',
    priceMissing: Boolean(product.priceMissing), priceNote: product.priceNote || '',
    rowType: 'catalog', needsCatalogPrice: false});
  row.unitWeight = Number.isFinite(product.navigation?.weight) ? String(product.navigation.weight) : '';
  assignFasteners(row, product);
  delete row.isVariation; delete row.parentProductId; delete row.parentProductName;
  if (product.isVariation) Object.assign(row, {isVariation: true, parentProductId: product.parentProductId || '', parentProductName: product.parentProductName || ''});
}
function priceLine(row) {
  const custom = isCustomRow(row), editing = custom || priceEdits.has(row.id);
  const label = row.priceSource === 'manual' ? 'Цена менеджера: ' : row.priceSource === 'deal' ? 'Цена сделки: ' : 'Цена каталога: ';
  return element('div', {class: 'price-line', 'data-price-line': row.id}, editing ? [
    element('label', {class: 'mini-label', text: custom ? 'Цена за единицу — обязательно' : 'Цена за единицу'}, [
      input(row.basePrice, 'basePrice', 'Цена за единицу позиции', {inputmode: 'decimal', ...(custom ? {required: 'required', placeholder: 'Введите цену'} : {})})])
  ] : [element('span', {text: label}), element('span', {class: 'base-price editable-price', text: formatMoney(row.basePrice, row.currency || config.currency),
    tabindex: '0', role: 'button', 'data-edit-price': row.id, title: 'Двойное нажатие или Enter — изменить цену', 'aria-label': 'Изменить цену за единицу'}),
    element('button', {type: 'button', class: 'price-edit-button', 'data-action': 'edit-price', text: '✎', 'aria-label': 'Изменить цену за единицу'})]);
}
function startPriceEdit(row) {
  if (busy || isCustomRow(row)) return;
  if (!priceEdits.has(row.id)) priceEdits.set(row.id, {basePrice: row.basePrice, priceSource: row.priceSource, priceMissing: row.priceMissing, priceNote: row.priceNote, needsCatalogPrice: row.needsCatalogPrice});
  document.querySelector(`[data-price-line="${row.id}"]`)?.replaceWith(priceLine(row));
  const input = document.querySelector(`[data-row-id="${row.id}"] [data-field="basePrice"]`); input?.focus(); input?.select();
}
function finishPriceEdit(row, cancel = false) {
  if (!priceEdits.has(row.id)) return;
  const previous = priceEdits.get(row.id); priceEdits.delete(row.id);
  if (cancel) Object.assign(row, previous);
  document.querySelector(`[data-price-line="${row.id}"]`)?.replaceWith(priceLine(row)); recalc();
}
function renderRows() {
  const nodes = draft().rows.map(row => {
    const custom = isCustomRow(row);
    const nameControl = custom ? input(row.productName, 'productName', 'Наименование произвольной строки', {placeholder: 'Введите наименование', maxlength: '250', required: 'required', class: 'custom-row-name'}) :
      element('button', {type: 'button', class: 'row-product-button', 'data-action': 'choose-product', 'aria-label': 'Найти или заменить товар «' + row.productName + '»'}, [
        element('strong', {text: row.productName || 'Выберите товар'}), element('span', {text: (row.isVariation ? 'Вариация · ' : '') + '#' + row.productId})]);
    const hardware = [];
    {
      hardware.push(element('label', {class: 'fasteners-toggle'}, [element('input', {type: 'checkbox', 'data-field': 'fastenersEnabled', checked: row.fastenersEnabled === true}),
        element('span', {text: 'Метизы'})]));
      if (row.fastenersEnabled === true) {
        if (Number.isFinite(row.fastenersPropertyPrice)) hardware.push(element('small', {class: 'fasteners-property-price', text: 'Цена МК: ' + formatMoney(row.fastenersPropertyPrice, row.currency) + ' / изделие · из каталога'}));
        else hardware.push(element('label', {class: 'mini-label fasteners-manual-field', text: 'Укажите стоимость метиз.'}, [input(row.fasteners, 'fasteners', 'Стоимость метизов на одно изделие', {inputmode: 'decimal', required: 'required', placeholder: 'Цена на одно изделие, ' + row.currency})]));
      }
      if (row.fastenersNote && row.fastenersEnabled === true) hardware.push(element('small', {class: 'hint', text: row.fastenersNote}));
    }
    return element('div', {class: 'item-row' + (custom ? ' custom-item-row' : ''), 'data-row-id': row.id}, [
      cell('item-name', [nameControl, ...(custom ? [element('small', {class: 'hint', text: 'Произвольная строка · КП и сделка'})] : []), priceLine(row),
        element('p', {class: 'price-note', 'data-price-note': row.id, role: 'status', text: row.priceMissing ? row.priceNote : ''}), ...hardware]),
      cell('item-coating', [
        select(config.coatings.map(c => ({value: c.code, text: c.name})), row.coatingCode, {'data-field': 'coatingCode', 'aria-label': 'Покрытие позиции'}),
        ...(row.coatingCode === 'custom' ? [element('label', {class: 'mini-label', text: 'Свой вариант покрытия'}, [input(row.customCoating || '', 'customCoating', 'Нестандартное покрытие', {placeholder: 'Введите покрытие', maxlength: '250', required: 'required'})])] : []),
        ...(coatingSupportsRal(config.coatings.find(c => c.code === row.coatingCode)) ? [element('label', {class: 'mini-label ral-field', text: 'Номер RAL'}, [input(row.ralColor || '', 'ralColor', 'Номер цвета RAL', {placeholder: '9005', maxlength: '100'})])] : [])
      ]),
      cell('item-quantity', [input(row.quantity, 'quantity', 'Количество позиции', {inputmode: 'decimal'}),
        element('label', {class: 'mini-label', text: 'Масса единицы, кг'}, [input(row.unitWeight ?? '', 'unitWeight', 'Масса единицы, кг', {inputmode: 'decimal', placeholder: 'Включая явный 0'})]),
        ...(custom ? [element('label', {class: 'mini-label'}, [element('input', {type: 'checkbox', 'data-field': 'separateDelivery', checked: row.deliveryRole === 'separate'}), element('span', {text: 'Отдельная доставка'})])] : [])]),
      cell('item-coefficients', [element('div', {class: 'coef-grid coeffs-three'}, [
        element('label', {class: 'mini-label', text: 'К1 · скидка'}, [input(row.k1, 'k1', 'К1 — скидка', {inputmode: 'decimal'})]), element('span', {class: 'coef-times', text: '×'}),
        element('label', {class: 'mini-label', text: 'К2 · доставка'}, [input(row.k2, 'k2', 'К2 — доставка', {inputmode: 'decimal'})]),
        element('label', {class: 'mini-label', text: 'К3 · покрытие / краска'}, [input(row.k3, 'k3', 'К3 — покрытие или краска', {inputmode: 'decimal'})])])]),
      cell('item-execution', [input(row.executionTerm ?? '', 'executionTerm', 'Срок исполнения: число рабочих дней или текст', {placeholder: '15 или Отгрузка с СГП', maxlength: '250', list: 'executionTermOptions'}), element('small', {class: 'execution-preview', 'data-execution-preview': row.id})]),
      cell('item-remove', [element('button', {type: 'button', class: 'icon-button', 'data-action': 'remove', text: '×', 'aria-label': 'Удалить позицию'})]),
      element('div', {class: 'item-summary', 'data-summary': row.id})
    ]);
  });
  $('itemsBody').replaceChildren(...nodes); recalc();
}
function recalc() {
  calculation = calculateQuote(draft().rows, config);
  $('grandTotal').textContent = calculation.valid ? formatMoney(calculation.total, config.currency) : 'Проверьте позиции';
  $('quantityTotal').textContent = String(calculation.quantity || 0) + ' ед.';
  $('integrationConfigStatus').textContent = connected ? integrationMessage : '';
  try {
    const metrics = calculateMetrics({...calculation, config}, integrationConfig?.deliveryCoefficientKeys || ['k2']);
    $('calculationMetrics').textContent = `Масса изделий: ${metrics.weight} кг · Доставка в составе КП: ${formatMoney(metrics.delivery, config.currency)}`;
  } catch { $('calculationMetrics').textContent = 'Для сохранения КП укажите массу каждой позиции, включая явный 0 для работ. Отдельная доставка включается в итог отдельной строкой.'; }
  $('formulaHint').textContent = formulaText();
  for (const row of calculation.rows) {
    const summary = [...document.querySelectorAll('[data-summary]')].find(n => n.dataset.summary === row.id);
    const executionPreview = [...document.querySelectorAll('[data-execution-preview]')].find(n => n.dataset.executionPreview === row.id);
    if (executionPreview) executionPreview.textContent = row.executionTermText ? 'В КП: ' + row.executionTermText : '';
    const priceNote = [...document.querySelectorAll('[data-price-note]')].find(n => n.dataset.priceNote === row.id);
    if (priceNote) priceNote.textContent = row.priceMissing ? (row.priceNote || 'Цена не указана — менеджер введёт её самостоятельно.') : '';
    const baseText = [...document.querySelectorAll('[data-row-id]')].find(n => n.dataset.rowId === row.id)?.querySelector('.base-price');
    if (baseText) {
      baseText.textContent = formatMoney(row.basePrice, row.currency || config.currency);
      if (baseText.previousElementSibling) baseText.previousElementSibling.textContent = row.priceSource === 'manual' ? 'Цена менеджера: ' : row.priceSource === 'deal' ? 'Цена сделки: ' : 'Цена каталога: ';
    }
    if (summary) {
      summary.textContent = row.valid
        ? 'Цена за единицу: ' + formatMoney(row.unitPrice, config.currency) + ' · Сумма: ' + formatMoney(row.lineTotal, config.currency)
        : row.errors.join(' · ');
      summary.classList.toggle('invalid', !row.valid);
    }

  }
  $('createQuoteBtn').disabled = busy || managerLoading || !calculation.valid;
  $('applyDealBtn').disabled = !connected || !calculation.valid || busy || managerLoading;
  $('downloadBtn').disabled = busy || managerLoading;
  $('restoreCalculationBtn').disabled = busy || !connected || !state.activeDealId || !integrationReady;
  $('resumeSaveBtn').disabled = busy || !connected || !integrationReady;
  $('recoverDocumentBtn').disabled = busy || !connected;
  try { const pending = state.activeDealId && saver.pending(state.activeDealId); $('saveOperationStatus').textContent = pending && pending.stage !== 'done' ? 'Есть незавершённое сохранение: ' + pending.stage + '. ' + (pending.document ? 'Документ #' + pending.document.id : 'Проверьте историю документов.') : ''; } catch (error) { $('saveOperationStatus').textContent = safeError(error); }
  for (const button of document.querySelectorAll('[data-choose-product]')) {
    button.disabled = busy;
  }
  for (const id of ['connectDealBtn', 'resetDemoBtn', 'addItemBtn', 'addCustomBtn']) $(id).disabled = busy;
  renderDocumentControls();
  renderManagerControls();
  remember();
}
function renderDocuments() {
  $('refreshDocumentsBtn').disabled = !connected || !state.activeDealId || busy || documentsLoading;
  $('docsBody').replaceChildren();
  if (documentsLoading) $('docsBody').append(element('p', {class: 'hint', text: 'Загрузка документов сделки…'}));
  if (documentsError) $('docsBody').append(element('p', {class: 'inline-error', role: 'status', text: documentsError}));
  for (const record of generatedDocuments) {
    const date = new Date(record.createdAt);
    const details = ['#' + record.id, Number.isFinite(date.getTime()) ? date.toLocaleString('ru-RU', {timeZone: 'Europe/Moscow'}) : '',
      record.templateId ? 'Шаблон #' + record.templateId : ''].filter(Boolean).join(' · ');
    const button = element('button', {type: 'button', class: 'button secondary small', 'data-refresh-document': record.id,
      text: record.pdfUrl ? 'Обновить' : 'Получить DOCX / PDF'});
    button.disabled = busy;
    $('docsBody').append(element('div', {class: 'document-row', 'data-document-id': record.id}, [
      element('span', {class: 'file-icon', text: '▤', 'aria-hidden': 'true'}),
      element('div', {class: 'document-info'}, [element('strong', {text: record.title || 'Документ #' + record.id}), element('div', {class: 'hint', text: details})]),
      ...documentLinks(record), button
    ]));
  }
  if (!generatedDocuments.length && !documentsLoading && !documentsError) $('docsBody').append(element('p', {class: 'empty-state',
    text: connected && state.activeDealId ? 'В этой сделке ещё нет созданных документов.' : 'Подключите сделку, чтобы увидеть созданные в Битрикс24 документы.'}));
}
async function refreshDocuments() {
  if (!connected || !state.activeDealId || state.scope === 'demo') return;
  const scope = state.scope, dealId = String(state.activeDealId), request = ++documentsRequest;
  documentsLoading = true; documentsError = ''; renderDocuments();
  try {
    const documents = await adapter.listQuoteDocuments(dealId);
    if (scope !== state.scope || dealId !== String(state.activeDealId) || request !== documentsRequest) return;
    generatedDocuments = documents;
  } catch (error) {
    if (scope === state.scope && request === documentsRequest) documentsError = 'Не удалось загрузить документы сделки: ' + safeError(error);
  } finally {
    if (scope === state.scope && request === documentsRequest) {documentsLoading = false; renderDocuments();}
  }
}
function upsertDocument(record) {
  const index = generatedDocuments.findIndex(item => item.id === record.id);
  if (index < 0) generatedDocuments.unshift(record); else Object.assign(generatedDocuments[index], record);
  renderDocuments();
}
function selectedTemplateId() {
  return sharedTemplate.loaded ? sharedTemplate.id : '';
}
function renderTemplates() {
  const selected = $('settingsDialog').open ? $('defaultDocumentTemplateId').value : selectedTemplateId();
  const options = [option('', connected ? 'Выберите зарегистрированный шаблон' : 'Подключите сделку Битрикс24')];
  const ids = new Set([selected, selectedTemplateId()].filter(Boolean));
  for (const id of ids) if (!templates.some(t => String(t.id) === id)) options.push(option(id, 'Шаблон #' + id + ' · недоступен для этой сделки'));
  options.push(...templates.map(t => option(String(t.id), t.name + ' · #' + t.id)));
  $('defaultDocumentTemplateId').replaceChildren(...options);
  $('defaultDocumentTemplateId').value = selected;
  $('defaultDocumentTemplateId').disabled = !connected || !state.activeDealId || !adapter.canManageSettings() || busy || sharedTemplate.loading || !sharedTemplate.loaded;
  $('refreshTemplatesBtn').disabled = !connected || !state.activeDealId || busy || sharedTemplate.loading;
  const activeTemplate = templates.find(t => String(t.id) === selectedTemplateId());
  $('templateSummary').textContent = sharedTemplate.loading ? 'Загружаю общий шаблон КП…'
    : sharedTemplate.error ? 'Общий шаблон КП недоступен: ' + sharedTemplate.error
    : selectedTemplateId() ? 'Общий шаблон КП: ' + (activeTemplate ? activeTemplate.name + ' · #' + activeTemplate.id : '#' + selectedTemplateId())
    : 'Общий шаблон КП не выбран. Администратор может задать его в настройках.';
  $('templatesHint').textContent = sharedTemplate.error || (!connected ? 'Шаблоны загружаются из генератора документов Битрикс24 после подключения сделки.'
    : templatesLoaded ? (templates.length ? (adapter.canManageSettings() ? 'Выберите шаблон и нажмите «Сохранить настройки». Он будет общим для всех менеджеров приложения.' : 'Используется общий шаблон. Для его изменения обратитесь к администратору.') : 'Для этой сделки нет доступных активных шаблонов.')
      : 'Обновите список шаблонов для этой сделки.');
  renderDocumentControls();
}
async function refreshSharedTemplate() {
  sharedTemplate.loading = true; renderTemplates();
  try {
    const id = await adapter.getQuoteTemplateId();
    sharedTemplate = {id, loaded: true, loading: false, error: ''};
  } catch (error) {
    sharedTemplate = {id: '', loaded: false, loading: false, error: safeError(error)};
    throw error;
  } finally { renderTemplates(); }
}
async function refreshTemplates() {
  if (!connected || !state.activeDealId) return;
  $('refreshTemplatesBtn').disabled = true;
  $('templatesHint').textContent = 'Загружаю зарегистрированные шаблоны…';
  try {
    templates = await adapter.listDocumentTemplates(state.activeDealId);
    templatesLoaded = true;
    renderTemplates();
  } catch (error) {
    templates = []; templatesLoaded = false;
    renderTemplates();
    $('templatesHint').textContent = safeError(error);
  } finally { $('refreshTemplatesBtn').disabled = busy; }
}
function previewSnapshot() { return previewData; }
function previewDocument() { return previewCreatedDocument; }
function documentLinks(record) {
  const links = [];
  for (const [key, label] of [['downloadUrl', 'Скачать DOCX'], ['pdfUrl', 'Скачать PDF'], ['publicUrl', 'Открыть документ']]) {
    if (!record[key]) continue;
    try {
      const url = new URL(record[key]);
      if (['http:', 'https:'].includes(url.protocol)) links.push(element('a', {href: url.href, target: '_blank', rel: 'noopener noreferrer', class: 'button secondary small', text: label}));
    } catch { /* Invalid links are not rendered. */ }
  }
  return links;
}
function renderDocumentControls() {
  const snapshot = previewSnapshot(), record = previewDocument(snapshot);
  const canCreate = integrationReady && connected && sharedTemplate.loaded && state.scope !== 'demo' && snapshot && String(snapshot.dealId) === String(state.activeDealId) && selectedTemplateId();
  $('generateDocumentBtn').disabled = busy || sharedTemplate.loading || !sharedTemplate.loaded || !canCreate || Boolean(record);
  $('refreshDocumentBtn').disabled = busy || !record || !connected;
  $('documentResult').hidden = !snapshot;
  $('documentResult').replaceChildren();
  if (record) {
    $('documentResult').append(element('p', {text: 'Документ #' + record.id + (record.conversionError ? ' создан, но Битрикс24 сообщил об ошибке преобразования PDF.' : record.pdfUrl ? ' готов.' : ' создан. PDF ещё формируется — обновите его готовность.')}), ...documentLinks(record));
  } else if (snapshot) {
    $('documentResult').textContent = canCreate ? 'После подтверждения полный состав КП, включая произвольные позиции, заменит товары сделки. Будут сохранены результаты и JSON расчёта. Шаблон документа #' + selectedTemplateId() + '.'
      : 'Для генерации документа подключите сделку. Общий шаблон выбирается администратором в настройках.';
  }
}
async function generateDocument() {
  if (busy) return;
  const payload = previewSnapshot();
  try {
    if (!payload || !connected || state.scope === 'demo') throw new Error('Подключите сделку и выберите общий шаблон КП в настройках.');
    busy = true; recalc(); renderDocuments();
    await refreshSharedTemplate();
    const templateId = selectedTemplateId();
    if (!templateId) throw new Error('Администратор должен выбрать общий шаблон КП в настройках.');
    if (previewDocument()) return;
    if (!integrationReady) throw new Error('Завершите настройку интеграции в административной панели.');
    status('Проверяю данные перед сохранением КП…');
    const result = await saver.save(payload, integrationConfig, dealFields);
    if (!result) return;
    previewCreatedDocument = result.document;
    await refreshDocuments(); upsertDocument(result.document);
    status('КП сохранено: документ #' + result.document.id + ', полный состав товаров, суммы и JSON проверены. Это последнее сформированное КП; согласование клиентом не установлено.', 'success');
  } catch (error) { status(safeError(error), 'error'); }
  finally {busy = false; recalc(); renderDocuments();}
}
async function refreshDocument(value = previewDocument()?.id) {
  if (busy || !value) return;
  try {
    busy = true; recalc(); renderDocuments();
    const result = await adapter.getQuoteDocument(value, {dealId: state.activeDealId});
    upsertDocument(result);
    if (previewCreatedDocument?.id === result.id) previewCreatedDocument = {...previewCreatedDocument, ...result};
    status(result.conversionError ? 'Битрикс24 сообщил об ошибке преобразования PDF документа #' + result.id + '.' : result.pdfUrl ? 'PDF документа #' + result.id + ' готов.' : 'PDF ещё формируется. Обновите готовность позже.', result.conversionError ? 'error' : result.pdfUrl ? 'success' : 'info');
  } catch (error) {status(safeError(error), 'error');}
  finally {busy = false; recalc(); renderDocuments();}
}
function render() {
  $('dealBadge').textContent = state.scope === 'demo' ? 'ПИЛОТ' : 'Сделка #' + state.activeDealId;
  $('connectionBadge').textContent = connected ? 'Bitrix24 подключён' : 'Демонстрационный режим';
  $('connectionBadge').classList.toggle('connected', connected);
  renderCustomer(); renderPrimary(); renderRows(); renderDocuments(); renderTemplates(); renderTerms();
}
function ensureValid() {
  calculation = calculateQuote(draft().rows, config);
  if (!calculation.valid) throw new Error('Исправьте данные расчёта: ' + calculation.errors.join('; '));
  if (!draft().rows.length) throw new Error('Добавьте хотя бы одну позицию.');
  if (!String(draft().companyName || '').trim()) throw new Error('Укажите наименование компании.');
  if (draft().rows.some(row => typeof row.executionTerm !== 'string' || row.executionTerm.length > 250 || /[\u0000-\u001f\u007f]/.test(row.executionTerm))) throw new Error('Срок исполнения должен быть текстом длиной до 250 символов.');
}
function buildQuoteData() {
  ensureValid();
  return {schemaVersion: 3, quoteId: uid(), dealId: state.scope === 'demo' ? null : String(state.activeDealId), createdAt: new Date().toISOString(),
    companyName: draft().companyName, currency: config.currency, primary: clone(primaryData?.values || {}),
    deliveryCoefficientKeys: integrationConfig?.deliveryCoefficientKeys || ['k2'], appliedTexts: appliedTexts(draft().documentFields, textConfig),
    rows: withoutRetiredFields(clone(calculation.rows)), total: calculation.total, quantity: calculation.quantity,
    config: clone(config),
    documentTemplateId: selectedTemplateId(), documentFields: clone(draft().documentFields || {}),
    managerUserId: draft().managerUserId || '', managerSignatureReference: clone(draft().managerSignatureReference || null)};
}
async function prepareQuote() {
  if (busy || managerLoading) return null;
  busy = true; recalc();
  try {
    if (connected && state.scope !== 'demo' && state.activeDealId) {
      managerProfile = await adapter.getResponsibleManager(state.activeDealId);
      applyManagerProfile(); renderTerms();
    }
    return buildQuoteData();
  } catch (error) {status(safeError(error), 'error'); return null;}
  finally {busy = false; recalc();}
}
function safeError(error) {
  return String(error?.message || error).replace(/https?:\/\/[^\s"'<>]+/g, '[адрес скрыт]');
}
function downloadJson(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type: 'application/json'}));
  const a = element('a', {href: url, download: name});
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function showQuote(snapshot) {
  previewData = snapshot; previewCreatedDocument = null;
  const table = element('table', {class: 'quote-table'});
  table.append(element('thead', {}, [element('tr', {}, ['Наименование', 'Покрытие', 'Кол-во', 'Цена, ₽', 'Сумма, ₽', 'Срок исполнения'].map(x => element('th', {text: x})))]));
  const tbody = element('tbody');
  for (const row of snapshot.rows) {
    const coating = snapshot.config.coatings.find(c => c.code === row.coatingCode);
    tbody.append(element('tr', {}, [
      row.productName, formatCoating(coating || {code: row.coatingCode, name: row.coatingName || row.coatingCode}, row.ralColor, row.customCoating), String(row.quantity),
      formatMoney(row.unitPrice, snapshot.currency), formatMoney(row.lineTotal, snapshot.currency), formatExecutionTerm(row.executionTerm) || '—'
    ].map(text => element('td', {text}))));
  }
  table.append(tbody);
  $('quotePreview').replaceChildren(
    element('div', {class: 'quote-heading', text: 'ЮЗМ · Коммерческое предложение'}),
    element('p', {text: snapshot.companyName}),
    element('p', {class: 'hint', text: 'Расчёт от ' + new Date(snapshot.createdAt).toLocaleDateString('ru-RU', {timeZone: 'Europe/Moscow'})}),
    table,
    element('p', {class: 'quote-total', text: 'Итого: ' + formatMoney(snapshot.total, snapshot.currency)})
  );
  for (const key of Object.keys(snapshot.documentFields || {}).filter(key => !managerFields.includes(key))) {
    if (snapshot.documentFields?.[key]) $('quotePreview').append(element('p', {text: (key === 'YuzmPaymentTerms' ? 'Условия оплаты: ' : '') + snapshot.documentFields[key]}));
  }
  const signatureContainer = element('div', {class: 'quote-manager-signature'}, [managerBlock(snapshot.documentFields)]);
  $('quotePreview').append(signatureContainer);
  if (snapshot.managerSignatureReference && connected) adapter.resolveManagerSignature(snapshot.managerSignatureReference).then(url => {
    if ($('quoteDialog').dataset.quoteId === snapshot.quoteId) signatureContainer.replaceChildren(managerBlock(snapshot.documentFields, url));
  }).catch(() => { signatureContainer.replaceChildren(managerBlock(snapshot.documentFields)); });
  $('quoteDialog').dataset.quoteId = snapshot.quoteId;
  renderDocumentControls();
  openDialog('quoteDialog');
}
function settingsToForm(resetTemplate = !$('settingsDialog').open) {
  updateConnectionDiagnostics();
  const s = state.settings;
  for (const key of ['dealId']) $(key === 'dealId' ? 'dealIdInput' : key).value = s[key] || '';
  renderTemplates();
  if (resetTemplate) $('defaultDocumentTemplateId').value = selectedTemplateId();
  $('roundingMode').value = config.rounding;
  settingsMessage('');
}
function readSettingsForm() {
  const result = {...state.settings};
  for (const key of ['dealId']) {
    const value = $(key === 'dealId' ? 'dealIdInput' : key).value.trim();
    if (value && !/^[1-9]\d*$/.test(value)) throw new Error('ID сделки должен быть положительным целым числом.');
    result[key] = value;
  }
  result.rounding = $('roundingMode').value;
  return result;
}
function keepSettings() {
  const next = readSettingsForm();
  config = validateConfig({...config, rounding: next.rounding});
  state.settings = next; remember();
}
function invalidateCatalog() {
  catalogGeneration++; catalogRequest++; catalogIndex = null; catalogLoad = null; resetCatalogPrices();
  if ($('productDialog').open) closeDialog('productDialog');
}
async function loadCatalog(refresh = false) {
  if (refresh) resetCatalogPrices();
  if (catalogIndex && !refresh) return catalogIndex;
  if (catalogLoad) return catalogLoad;
  const generation = catalogGeneration;
  const pending = (async () => {
    const entries = connected ? await adapter.listCatalogEntries({refresh, onProgress: count => {
      if ($('productDialog').open) $('catalogResultCount').textContent = 'Загрузка каталога: ' + count + ' записей…';
    }}) : clone(demoProducts);
    const index = new CatalogSearchIndex(entries);
    if (generation === catalogGeneration) catalogIndex = index;
    return index;
  })();
  catalogLoad = pending;
  try { return await pending; } finally {if (catalogLoad === pending) catalogLoad = null;}
}
function resetCatalogPrices() {
  catalogPriceState = {values: new Map(), pending: new Set(), inFlight: new Set(), scheduled: false, loading: false};
}
function catalogPriceLabel(id) {
  const price = catalogPriceState.values.get(String(id));
  return !price ? 'Загрузка цены…' : price.priceMissing ? formatMoney(0, price.currency) + ' · цена не указана' : formatMoney(price.basePrice, price.currency);
}
function queueCatalogPrice(product) {
  const state = catalogPriceState;
  if (!state.values.has(product.id) && !state.inFlight.has(product.id)) state.pending.add(product.id);
  if (state.scheduled || state.loading || !state.pending.size) return;
  state.scheduled = true;
  setTimeout(() => flushCatalogPrices(state), 0);
}
async function flushCatalogPrices(priceState) {
  if (priceState !== catalogPriceState) return;
  priceState.scheduled = false; priceState.loading = true;
  const visible = new Set([...document.querySelectorAll('#productDialog[open] [data-catalog-price], #productDetailsDialog[open] [data-catalog-price]')].map(node => node.dataset.catalogPrice));
  for (const id of priceState.pending) if (!visible.has(id)) priceState.pending.delete(id);
  const ids = [...priceState.pending].slice(0, 50);
  if (!ids.length) {priceState.loading = false; return;}
  ids.forEach(id => {priceState.pending.delete(id); priceState.inFlight.add(id);});
  try {
    const prices = connected ? await adapter.getCatalogPrices(ids, {currency: config.currency}) : ids.map(id => {
      const p = catalogIndex?.get(id); return {id, basePrice: p?.basePrice ?? 0, currency: p?.currency || config.currency, priceMissing: Boolean(p?.priceMissing)};
    });
    if (priceState !== catalogPriceState) return;
    for (const price of prices) priceState.values.set(price.id, price);
  } catch {
    if (priceState !== catalogPriceState) return;
    for (const id of ids) priceState.values.set(id, {id, basePrice: 0, currency: config.currency, priceMissing: true});
  } finally {
    if (priceState === catalogPriceState) {
      priceState.loading = false; ids.forEach(id => priceState.inFlight.delete(id));
      for (const node of document.querySelectorAll('[data-catalog-price]')) node.textContent = catalogPriceLabel(node.dataset.catalogPrice);
      if (priceState.pending.size) {priceState.scheduled = true; setTimeout(() => flushCatalogPrices(priceState), 0);}
    }
  }
}
function renderCatalogItem(product) {
  const action = chosenRow ? 'Выбрать' : 'Добавить';
  const button = element('button', {type: 'button', class: 'button primary small', 'data-choose-product': product.id,
    text: action, 'aria-label': action + ' «' + product.name + '»'});
  button.disabled = busy;
  const labels = navigationLabels(product.navigation, {compact: true});
  queueCatalogPrice(product);
  return element('div', {class: 'catalog-entry', 'data-product-id': product.id}, [
    element('div', {class: 'catalog-entry-heading'}, [element('strong', {class: 'catalog-entry-name', text: productLabel(product), title: productLabel(product)}), element('span', {class: 'catalog-entry-price', 'data-catalog-price': product.id, text: catalogPriceLabel(product.id)})]),
    element('div', {class: 'catalog-characteristics', text: labels.join(' · ') || 'Характеристики не указаны', title: navigationLabels(product.navigation).join(' · ')}),
    element('div', {class: 'catalog-entry-actions'}, [element('button', {type: 'button', class: 'catalog-details-button',
      'data-product-details': product.id, text: '▸ Подробнее', 'aria-label': 'Подробнее о «' + product.name + '»'}), button])]);
}
function showProductDetails(product) {
  $('productDetailsTitle').textContent = product.name;
  $('productDetailsBody').replaceChildren(...[
    'ID товара: ' + product.id, ...navigationLabels(product.navigation),
    ...(product.parentProductName ? ['Основной товар: ' + product.parentProductName] : []),
    ...(!navigationLabels(product.navigation).length ? ['Характеристики не указаны'] : []),
  ].map(text => element('p', {text})));
  $('productDetailsBody').append(element('p', {'data-catalog-price': product.id, class: 'catalog-entry-price', text: catalogPriceLabel(product.id)}));
  queueCatalogPrice(product); openDialog('productDetailsDialog');
}
async function searchProducts(refresh = false) {
  clearTimeout(catalogFilterTimer);
  if (!$('productDialog').open) return;
  const request = ++catalogRequest, scope = state.scope, wasConnected = connected, generation = catalogGeneration;
  const current = () => request === catalogRequest && generation === catalogGeneration && scope === state.scope && wasConnected === connected && $('productDialog').open;
  $('catalogMessage').textContent = '';
  if (!catalogIndex || refresh) $('catalogResultCount').textContent = 'Загрузка каталога…';
  $('refreshCatalogBtn').disabled = true;
  try {
    const index = await loadCatalog(refresh);
    if (!current()) return;
    const matches = index.search($('productQuery').value);
    catalogList.setItems(matches);
    $('catalogResultCount').textContent = 'Найдено ' + matches.length + ' из ' + index.entries.length;
    $('catalogEmpty').hidden = Boolean(matches.length);
    $('catalogMessage').textContent = connected ? adapter.catalogWarnings.join(' ') : '';
  } catch (error) {
    if (current()) {catalogList.setItems([]); $('catalogResultCount').textContent = ''; $('catalogMessage').textContent = safeError(error);}
  } finally {if (current()) $('refreshCatalogBtn').disabled = false; updateConnectionDiagnostics();}
}
function openCatalog(rowId = null) {
  if (busy) return;
  chosenRow = rowId;
  $('productTitle').textContent = rowId ? 'Заменить товар' : 'Добавить товар';
  $('productQuery').value = ''; $('catalogEmpty').hidden = true;
  openDialog('productDialog'); $('productQuery').focus(); searchProducts();
}
async function chooseProduct(entry) {
  if (busy) return;
  const scope = state.scope, targetDraft = draft(), targetRow = chosenRow;
  const message = $('catalogMessage');
  try {
    busy = true; recalc();
    if (message) { message.className = 'hint'; message.textContent = 'Загрузка цены выбранной позиции…'; }
    const product = connected ? await adapter.getProduct(entry.id, {currency: config.currency, includeCatalogDetails: true}) : {...entry};
    if (state.scope !== scope || draft() !== targetDraft) return;
    if (product.parentProductId === entry.parentProductId && entry.parentProductName) product.parentProductName = entry.parentProductName;
    if (product.currency !== config.currency) throw new Error('Валюта товара не совпадает с валютой КП. Автоматическая конвертация не выполняется.');
    product.source = connected ? 'catalog' : 'demo';
    if (targetRow) {
      const row = draft().rows.find(r => r.id === targetRow);
      if (!row) throw new Error('Позиция уже удалена.');
      assignProduct(row, product);
    } else {
      const row = newRow(product); assignProduct(row, product); draft().rows.push(row);
    }
    renderRows(); renderDocuments();
    if ($('productDialog').open) closeDialog('productDialog');
    status(product.priceMissing ? 'Товар добавлен с ценой 0. Цена не указана — введите её в поле «Базовая цена».'
      : 'Товар добавлен в черновик КП. Каталог и сделка не изменены.', product.priceMissing ? 'warning' : 'success');
    if (message) message.textContent = 'Позиция добавлена в расчёт.';
  } catch (error) {
    if (state.scope !== scope || draft() !== targetDraft) return;
    renderRows(); status(safeError(error), 'error');
    if (message) { message.className = 'inline-error'; message.textContent = safeError(error); }
  }
  finally { busy = false; recalc(); }
}
async function connectDeal(id) {
  if (!connected) throw new Error(adapter.connectionError?.message || 'Соединение с Битрикс24 не установлено. Проверьте диагностику подключения в настройках.');
  if (!/^[1-9]\d*$/.test(String(id))) throw new Error('Укажите ID сделки.');
  managerRequest++; managerProfile = null; managerLoading = false; managerMessage = '';
  documentsRequest++; generatedDocuments = []; documentsError = ''; documentsLoading = false; previewData = null; previewCreatedDocument = null;
  catalogRequest++; resetCatalogPrices(); priceEdits.clear(); if ($('productDialog').open) closeDialog('productDialog');
  const deal = await adapter.loadDeal(id);
  let loadedPrimary = null;
  if (integrationConfig && dealFields) loadedPrimary = await loadPrimaryData(adapter, id, integrationConfig, dealFields);
  primaryData = loadedPrimary;
  const scope = 'bitrix-' + (window.BX24?.getDomain?.() || window.location.host) + '-deal-' + id;
  const savedSettings = {...state.settings, dealId: String(id)};
  const stored = readStored(scope);
  if (stored) restore(stored);
  else {
    const rows = (deal.rows || []).map(row => ({
      ...newRow({id: String(row.productId || ''), name: row.productName, basePrice: row.price ?? row.unitPrice ?? 0, currency: deal.currency, source: 'deal'}),
      quantity: String(row.quantity), rowType: Number(row.productId) > 0 ? 'catalog' : 'custom', unitWeight: '', priceSource: 'deal', taxRate: row.taxRate ?? 0, taxIncluded: row.taxIncluded ?? 'Y'
    }));
    state = {schemaVersion: 3, scope, activeDealId: String(id), settings: savedSettings, draft: {...blankDraft(rows), companyName: loadedPrimary?.companyName || deal.companyName || deal.title, currency: deal.currency}};
    config = validateConfig({...config, currency: deal.currency});
  }
  if (loadedPrimary) draft().companyName = loadedPrimary.companyName;
  state.activeDealId = String(id);
  state.settings = {...state.settings, ...savedSettings};
  templates = []; templatesLoaded = false;
  render(); settingsToForm();
  await Promise.allSettled([refreshTemplates(), refreshManagerProfile(), refreshDocuments()]);
  status('Сделка #' + id + ' загружена. Существующие строки используют цену сделки; для базовой цены выберите товар из каталога.', 'success');
}
async function applyToDeal() {
  const snapshot = await prepareQuote();
  if (snapshot) showQuote(snapshot);
}
async function restoreCalculation() {
  if (busy || !integrationReady || !state.activeDealId) return;
  busy = true; recalc();
  try {
    const dealId = String(state.activeDealId), code = integrationConfig.fields.snapshot.code;
    const deal = await adapter.call('crm.deal.get', {id: Number(dealId)});
    if (String(deal?.ID) !== dealId) throw new Error('CRM вернула другую сделку.');
    if (Array.isArray(deal[code]) && deal[code].length !== 1) throw new Error('Поле JSON должно содержать ровно один последний расчёт.');
    const raw = Array.isArray(deal[code]) ? deal[code][0] : deal[code];
    const {quote, snapshot} = await verifySnapshot(raw, dealId);
    await adapter.getQuoteDocument(snapshot.document.id, {dealId, templateId: snapshot.document.templateId});
    if (!window.confirm('Заменить текущий локальный черновик последним расчётом из сделки #' + dealId + ' (документ #' + snapshot.document.id + ')? Несохранённые изменения будут заменены.')) return;
    state.draft = {...blankDraft(), companyName: quote.companyName, rows: clone(quote.rows), currency: quote.currency,
      documentFields: clone(quote.documentFields), managerUserId: quote.managerUserId, managerSignatureReference: quote.managerSignatureReference,
      managerOverrides: Object.fromEntries(managerFields.map(key => [key, true]))};
    config = validateConfig(quote.config); previewData = null; previewCreatedDocument = null;
    render(); remember();
    status('Расчёт восстановлен из JSON документа #' + snapshot.document.id + ' и заново вычислен штатным калькулятором. Тексты сохранённого КП сохранены.', 'success');
  } catch (error) {status(safeError(error), 'error');}
  finally {busy = false; recalc();}
}

function bindEvents() {
  $('itemsBody').addEventListener('change', e => {
    if (e.target.dataset.field !== 'separateDelivery') return;
    const row = draft().rows.find(item => item.id === e.target.closest('[data-row-id]')?.dataset.rowId);
    if (!row) return;
    row.deliveryRole = e.target.checked ? 'separate' : '';
    if (e.target.checked) row.unitWeight = '0';
    recalc();
  });
  for (const key of managerFields) $(key).addEventListener('input', e => {
    draft().documentFields[key] = e.target.value;
    if (managerFields.includes(key)) { ensureManagerOverrides(draft())[key] = true; renderManagerControls(); }
    remember();
  });
  $('restoreCalculationBtn').addEventListener('click', restoreCalculation);
  $('reloadTextsBtn').addEventListener('click', async () => {
    if (busy) return;
    try { await reloadIntegration(); renderTerms(); recalc(); status('Тексты и настройки перечитаны. Введённые формулировки черновика сохранены; новые варианты доступны для выбора.'); }
    catch (error) {integrationMessage = safeError(error); status(integrationMessage, 'error'); recalc();}
  });
  $('resumeSaveBtn').addEventListener('click', () => {
    try {
      const pending = saver.pending(state.activeDealId);
      if (!pending || pending.stage === 'done') throw new Error('Незавершённых сохранений нет.');
      showQuote(clone(pending.quote));
    } catch (error) {status(safeError(error), 'error');}
  });
  $('recoverDocumentBtn').addEventListener('click', async () => {
    const id = window.prompt('ID документа из истории незавершённого сохранения:');
    if (!id) return;
    try {await saver.recoverDocument(state.activeDealId, id); status('Документ проверен. Нажмите «Продолжить сохранение КП».'); recalc();}
    catch (error) {status(safeError(error), 'error');}
  });
  $('companyName').addEventListener('input', e => { draft().companyName = e.target.value; remember(); });
  $('refreshTemplatesBtn').addEventListener('click', async () => {
    try { await refreshSharedTemplate(); await refreshTemplates(); $('defaultDocumentTemplateId').value = selectedTemplateId(); }
    catch (error) { settingsMessage(safeError(error)); }
  });
  $('generateDocumentBtn').addEventListener('click', generateDocument);
  $('refreshDocumentBtn').addEventListener('click', () => refreshDocument());
  $('fillManagerBtn').addEventListener('click', () => refreshManagerProfile(true));
  $('saveManagerSignatureBtn').addEventListener('click', saveManagerSignature);
  $('itemsBody').addEventListener('input', e => {
    const field = e.target.dataset.field;
    if (!field || e.target.tagName === 'SELECT') return;
    const row = draft().rows.find(r => r.id === e.target.closest('[data-row-id]')?.dataset.rowId);
    if (!row) return;
    row[field] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (field === 'fastenersEnabled' && row.fastenersEnabled) {
      if (Number.isFinite(row.fastenersPropertyPrice)) {row.fasteners = String(row.fastenersPropertyPrice); row.fastenersSource = 'property116';}
      else if (!row.fastenersSource && (!String(row.fasteners ?? '').trim() || parseNumber(row.fasteners) === 0)) {row.fasteners = ''; row.fastenersSource = 'manual';}
    }
    if (field === 'fasteners') row.fastenersSource = 'manual';
    if (field === 'basePrice') {
      row.needsCatalogPrice = false;
      const value = parseNumber(row.basePrice);
      if (Number.isFinite(value) && value >= 0) {
        row.priceMissing = false; row.priceNote = ''; row.priceSource = 'manual';
      }
    }
    if (field === 'fastenersEnabled') renderRows(); else recalc();
  });
  $('itemsBody').addEventListener('change', async e => {
    const field = e.target.dataset.field; if (!field || e.target.tagName !== 'SELECT') return;
    const row = draft().rows.find(r => r.id === e.target.closest('[data-row-id]')?.dataset.rowId); if (!row) return;
    row[field] = e.target.value;
    renderRows(); renderDocuments();
  });
  $('itemsBody').addEventListener('click', e => {
    const action = e.target.closest('[data-action]')?.dataset.action; if (!action) return;
    const rowId = e.target.closest('[data-row-id]')?.dataset.rowId;
    if (action === 'remove') { draft().rows = draft().rows.filter(r => r.id !== rowId); renderRows(); renderDocuments(); }
    if (action === 'choose-product') openCatalog(rowId);
    if (action === 'edit-price') {const row = draft().rows.find(row => row.id === rowId); if (row) startPriceEdit(row);}
  });
  $('itemsBody').addEventListener('dblclick', event => {
    const id = event.target.closest('[data-edit-price]')?.dataset.editPrice;
    const row = draft().rows.find(row => row.id === id); if (row) startPriceEdit(row);
  });
  $('itemsBody').addEventListener('keydown', event => {
    const row = draft().rows.find(row => row.id === event.target.closest('[data-row-id]')?.dataset.rowId); if (!row) return;
    if (event.target.dataset.editPrice && ['Enter', ' '].includes(event.key)) {event.preventDefault(); startPriceEdit(row);}
    if (event.target.dataset.field === 'basePrice' && !isCustomRow(row) && ['Enter', 'Escape'].includes(event.key)) {event.preventDefault(); finishPriceEdit(row, event.key === 'Escape');}
  });
  $('itemsBody').addEventListener('focusout', event => {
    if (event.target.dataset.field !== 'basePrice') return;
    const row = draft().rows.find(row => row.id === event.target.closest('[data-row-id]')?.dataset.rowId); if (row) finishPriceEdit(row);
  });
  $('addItemBtn').addEventListener('click', () => openCatalog());
  $('addCustomBtn').addEventListener('click', () => {
    if (busy) return; const row = newCustomRow(config.currency); draft().rows.push(row); renderRows();
    document.querySelector(`[data-row-id="${row.id}"] [data-field="productName"]`)?.focus();
  });
  $('openCatalogSettingsBtn').addEventListener('click', () => {closeDialog('settingsDialog'); openCatalog();});
  catalogList = new VirtualList($('catalogViewport'), renderCatalogItem, {stride: 212});
  $('productQuery').addEventListener('input', () => {clearTimeout(catalogFilterTimer); catalogFilterTimer = setTimeout(() => searchProducts(), 100);});
  $('productQuery').addEventListener('keydown', e => {if (e.key === 'Enter') {e.preventDefault(); searchProducts();}});
  $('refreshCatalogBtn').addEventListener('click', () => searchProducts(true));
  $('closeProductDetailsBtn').addEventListener('click', () => closeDialog('productDetailsDialog'));
  $('catalogViewport').addEventListener('click', e => {
    const detailId = e.target.closest('[data-product-details]')?.dataset.productDetails;
    if (detailId) {const product = catalogIndex?.get(detailId); if (product) showProductDetails(product); return;}
    const id = e.target.closest('[data-choose-product]')?.dataset.chooseProduct;
    const product = id && catalogIndex?.get(id); if (product) chooseProduct(product);
  });
  $('productDialog').addEventListener('close', () => {catalogRequest++; clearTimeout(catalogFilterTimer); catalogList.setItems([]);});
  $('quoteDialog').addEventListener('close', () => {previewData = null; previewCreatedDocument = null;});
  $('refreshDocumentsBtn').addEventListener('click', refreshDocuments);
  $('createQuoteBtn').addEventListener('click', async () => { const snapshot = await prepareQuote(); if (snapshot) showQuote(snapshot); });
  $('applyDealBtn').addEventListener('click', applyToDeal);
  $('downloadBtn').addEventListener('click', () => {
    try { downloadJson(buildQuoteData(), 'yuzm-kp-' + (state.activeDealId || 'draft') + '.json'); }
    catch (error) { status(safeError(error), 'error'); }
  });
  $('settingsBtn').addEventListener('click', () => { settingsToForm(); openDialog('settingsDialog'); });
  $('retryConnectionBtn').addEventListener('click', () => connectPortal());
  $('checkConnectionBtn').addEventListener('click', () => connectPortal());
  $('copyConnectionDiagnosticsBtn').addEventListener('click', async () => {
    updateConnectionDiagnostics();
    try {
      await navigator.clipboard.writeText($('connectionDiagnostics').value);
      settingsMessage('Диагностика скопирована. Токены и ключи в неё не включены.');
    } catch {
      $('connectionDiagnostics').focus(); $('connectionDiagnostics').select();
      settingsMessage('Диагностика выделена. Нажмите Ctrl+C для копирования.');
    }
  });
  $('settingsForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (busy || sharedTemplate.loading) return;
    try {
      const next = readSettingsForm();
      const nextConfig = validateConfig({...config, rounding: next.rounding});
      const templateId = $('defaultDocumentTemplateId').value;
      if (templateId !== selectedTemplateId()) {
        if (!connected || !state.activeDealId || !sharedTemplate.loaded) throw new Error('Подключите сделку и загрузите общий шаблон КП.');
        if (!templates.some(template => String(template.id) === templateId)) throw new Error('Выберите доступный зарегистрированный шаблон КП.');
        busy = true; renderTemplates();
        sharedTemplate.id = await adapter.setQuoteTemplateId(templateId);
      }
      config = nextConfig; state.settings = next; remember();
      closeDialog('settingsDialog'); render(); status('Настройки сохранены.', 'success');
    }
    catch (error) { settingsMessage(safeError(error)); }
    finally { busy = false; recalc(); renderTemplates(); }
  });
  $('registerPlacementBtn').addEventListener('click', async () => {
    try { await adapter.registerPlacement('Конструктор КП'); settingsMessage('Вкладка зарегистрирована. Перезагрузите карточку сделки.'); }
    catch (error) { settingsMessage(safeError(error)); }
  });
  $('connectDealBtn').addEventListener('click', async () => {
    try { keepSettings(); await connectDeal(state.settings.dealId); }
    catch (error) { settingsMessage(safeError(error)); }
  });
  $('resetDemoBtn').addEventListener('click', async () => {
    if (!window.confirm('Открыть новый демонстрационный черновик? Сохранённые данные сделки останутся в браузере.')) return;
    managerRequest++; managerProfile = null; managerLoading = false; managerMessage = '';
    state = freshState(); config = clone(builtinConfig);
    generatedDocuments = []; documentsError = ''; documentsLoading = false; previewData = null; previewCreatedDocument = null; documentsRequest++; invalidateCatalog();
    closeDialog('settingsDialog'); render(); status('Открыты демонстрационные данные. Запись в реальную сделку заблокирована.', 'info');
  });
  $('docsBody').addEventListener('click', e => {
    const id = e.target.closest('[data-refresh-document]')?.dataset.refreshDocument; if (id) refreshDocument(id);
  });
  for (const name of ['Settings', 'Product', 'Quote']) $('close' + name + 'Btn').addEventListener('click', () => closeDialog(name.toLowerCase() + 'Dialog'));
}
function updateConnectionDiagnostics() {
  const diagnostics = window.YUZM_BX24?.diagnostics?.() || {sdk_available: Boolean(window.BX24?.init)};
  $('connectionDiagnostics').value = JSON.stringify({
    app_version: document.querySelector('meta[name="application-version"]')?.content || 'unknown',
    ...diagnostics,
    connection_code: connectionCode,
    connected,
    rest_requests: adapter.diagnostics(),
  }, null, 2);
}
function connectionMessage(message, waiting = false) {
  $('connectionPanel').hidden = connected;
  $('connectionMessage').textContent = message;
  $('connectionSummary').textContent = message;
  $('retryConnectionBtn').disabled = waiting;
  $('checkConnectionBtn').disabled = waiting;
  updateConnectionDiagnostics();
}
async function connectPortal() {
  if (connecting) return;
  connecting = true;
  connectionCode = 'CONNECTING';
  connectionMessage('Подключение к Битрикс24…', true);
  try {
    const library = window.YUZM_BX24 ? await window.YUZM_BX24.load() : {sdk: window.BX24};
    if (!library.sdk) {
      adapter.connected = connected = false;
      adapter.connectionError = {code: library.code || 'SDK_UNAVAILABLE', message: library.message || 'Библиотека BX24 недоступна. Проверьте диагностику подключения в настройках.'};
      connectionCode = adapter.connectionError.code;
      render(); connectionMessage(adapter.connectionError.message);
      return;
    }
    // The SDK may finish loading after this adapter was constructed.
    adapter.sdk = library.sdk;
    const connection = await adapter.init();
    if (!connection.connected) {
      connected = false;
      connectionCode = adapter.connectionError.code;
      render(); connectionMessage(adapter.connectionError.message);
      return;
    }
    connectionCode = 'CHECKING_REST';
    const info = await adapter.call('app.info');
    if (![true, 'Y'].includes(info?.INSTALLED)) {
      const error = new Error('Битрикс24 не подтвердил завершение установки. Проверьте карточку приложения и выполните «Переустановить».');
      error.code = info?.INSTALLED === false || info?.INSTALLED === 'N' ? 'INSTALL_NOT_FINISHED' : 'INVALID_APP_INFO';
      throw error;
    }
    connected = true; invalidateCatalog();
    saver.scope = adapter.sdk.getDomain?.() || window.location.host;
    try { await reloadIntegration(); }
    catch (error) { integrationMessage = 'Настройка интеграции: ' + safeError(error); status(integrationMessage, 'error'); }
    connectionCode = 'CONNECTED';
    render(); connectionMessage('Bitrix24 подключён. Доступ к REST API подтверждён.');
    try { await refreshSharedTemplate(); }
    catch (error) { status('Не удалось загрузить общий шаблон КП: ' + safeError(error), 'error'); }
    const dealId = connection.dealId || state.settings.dealId;
    if (dealId && (state.scope === 'demo' || String(state.activeDealId) !== String(dealId))) {
      try { await connectDeal(String(dealId)); } catch (error) { status(safeError(error), 'error'); }
    } else if (!dealId) status('Bitrix24 подключён. Откройте вкладку сделки или укажите её ID в настройках.');
    renderTemplates();
  } catch (error) {
    adapter.connected = connected = false;
    connectionCode = error.code || 'CONNECTION_FAILED';
    adapter.connectionError = {code: connectionCode, message: safeError(error)};
    render(); connectionMessage(adapter.connectionError.message);
  } finally {
    connecting = false;
    $('retryConnectionBtn').disabled = false;
    $('checkConnectionBtn').disabled = false;
    updateConnectionDiagnostics();
  }
}
async function boot() {
  try {
    const prices = await fetch('data/coatings.example.json').then(r => r.json());
    builtinConfig = validateConfig(prices); config = clone(builtinConfig);
    useTextConfig(validateTextTemplates(await fetch('data/yuzm-quote-texts.json').then(r => r.json())));
    migrateStoredDrafts();
    state = freshState();
    const stored = readStored('demo'); if (stored) restore(stored);
    try { const settings = JSON.parse(localStorage.getItem(STORE + '-settings')); if (settings) state.settings = {...state.settings, ...settings}; } catch {}
    for (const key of ['historyFolderId', 'documentFields', 'relationsFileId', 'defaultDocumentTemplateId', 'pricesFileId', 'metalPricesFileId', 'formulaMode']) delete state.settings[key];
    bindEvents(); render();
    await connectPortal();
  } catch (error) {
    status('Не удалось запустить калькулятор: ' + safeError(error) + '. Запускайте приложение через HTTP-сервер, а не двойным кликом по HTML.', 'error');
  }
}
boot();
