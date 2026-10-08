import {calculateQuote, formatMoney, normalizeRelations, resolveRelations, validateConfig} from './calculator.js';
import {BitrixAdapter, fingerprintRows} from './bitrix.js';
import {products as demoProducts, initialRows, newRow, demoFile} from './demo.js';

const $ = id => document.getElementById(id);
const clone = value => structuredClone(value);
const uid = () => crypto.randomUUID();
const adapter = new BitrixAdapter();
const STORE = 'yuzm-kp-prototype-v1';
let config, relations, calculation, state, connected = false, busy = false, chosenRow = null;
let catalogProducts = clone(demoProducts), relationMeta = {source: 'demo'}, priceMeta = {source: 'demo'};
let previewFingerprint = null;
const defaultSettings = {dealId: '', relationsFileId: '', pricesFileId: '', historyFolderId: '', formulaMode: 'catalog', rounding: 'line'};
const draft = () => currentVariant().draft;
const currentVariant = () => state.variants.find(v => v.id === state.selectedVariantId);

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
  return {companyName: 'ООО «КраснодарЭлектро»', shipmentDate: '', rows, currency: 'RUB'};
}
function makeVariant(name, draftValue) { return {id: uid(), name, draft: draftValue, versions: []}; }
function freshState() {
  const variant = makeVariant('Основной вариант', blankDraft(clone(initialRows)));
  return {schemaVersion: 1, scope: 'demo', activeDealId: null, settings: clone(defaultSettings), variants: [variant], selectedVariantId: variant.id};
}
function remember() {
  try {
    currentVariant().context = {config: clone(config), relations: clone(relations), relationMeta: clone(relationMeta), priceMeta: clone(priceMeta)};
    localStorage.setItem(STORE + '-' + state.scope, JSON.stringify({state, config, relations, relationMeta, priceMeta}));
    localStorage.setItem(STORE + '-settings', JSON.stringify(state.settings));
  } catch {
    status('Браузер не сохранил черновик. Скачайте JSON расчёта или сохраните версию на Диск.', 'error');
  }
}
function readStored(scope) {
  try {
    const value = JSON.parse(localStorage.getItem(STORE + '-' + scope));
    if (!value || value.state?.schemaVersion !== 1 || value.state.scope !== scope || !Array.isArray(value.state.variants) || !value.state.variants.length) return null;
    const safeConfig = validateConfig(value.config);
    const safeRelations = normalizeRelations(value.relations);
    for (const variant of value.state.variants) {
      if (!variant.id || typeof variant.name !== 'string' || !Array.isArray(variant.draft?.rows) || !Array.isArray(variant.versions)) return null;
    }
    if (!value.state.variants.some(v => v.id === value.state.selectedVariantId)) return null;
    return {...value, config: safeConfig, relations: safeRelations};
  } catch { return null; }
}
function restore(value) {
  state = value.state; config = value.config; relations = value.relations;
  relationMeta = value.relationMeta || {}; priceMeta = value.priceMeta || {};
}
function activateVariant(id) {
  remember();
  state.selectedVariantId = id;
  const context = currentVariant().context;
  if (context) {
    config = validateConfig(context.config); relations = normalizeRelations(context.relations);
    relationMeta = clone(context.relationMeta || {}); priceMeta = clone(context.priceMeta || {});
    state.settings.formulaMode = config.formulaMode; state.settings.rounding = config.rounding;
  }
  render();
}
function formulaText() {
  return config.formulaMode === 'excel'
    ? 'Цена = (базовая цена + крепёж + доп. покрытие + доставка) × К1 × К2. Вес исключён.'
    : 'Цена = базовая цена × коэффициент покрытия × К1 × К2.';
}
function renderVariants() {
  $('variantSelect').replaceChildren(...state.variants.map(v => option(v.id, v.name)));
  $('variantSelect').value = state.selectedVariantId;
  $('variantName').value = currentVariant().name;
  $('companyName').value = draft().companyName || '';
  $('shipmentDate').value = draft().shipmentDate || '';
}
function drawOptions(row) {
  if (!row.productId) return [];
  return resolveRelations(row.productId, relations).drawings;
}
function renderRows() {
  const nodes = draft().rows.map(row => {
    const nameOptions = catalogProducts.map(p => ({value: String(p.id), text: p.name}));
    if (!nameOptions.some(p => p.value === String(row.productId))) nameOptions.unshift({value: String(row.productId), text: row.productName || 'Товар не выбран'});
    const productSelect = select(nameOptions, String(row.productId), {'data-field': 'productId', 'aria-label': 'Товар позиции'});
    const baseText = element('span', {class: 'base-price', text: formatMoney(row.basePrice, row.currency || config.currency)});
    const searchButton = element('button', {type: 'button', class: 'row-search', 'data-action': 'choose-product', text: 'Выбрать из каталога', 'aria-label': 'Найти товар в каталоге'});
    const draws = drawOptions(row);
    const drawSelect = select(
      [{value: '', text: draws.length ? 'Выберите чертёж' : 'Связь не задана'}, ...draws.map(d => ({value: d.id, text: d.name}))],
      row.drawingId || '',
      {'data-field': 'drawingId', 'aria-label': 'Чертёж позиции'}
    );
    const found = draws.find(d => d.id === row.drawingId);
    const kitText = found ? found.kits.map(k => k.name).join('; ') : (draws.length > 1 ? 'Несколько чертежей — выберите вариант' : 'Нет выбранного комплекта КД');
    const node = element('div', {class: 'item-row', 'data-row-id': row.id}, [
      cell('item-name', [
        productSelect,
        element('div', {class: 'hint'}, [element('span', {text: (row.priceSource === 'deal' ? 'Цена сделки: ' : 'Базовая цена: ')}), baseText]),
        searchButton
      ]),
      cell('item-coating', [
        select(config.coatings.map(c => ({value: c.code, text: c.name})), row.coatingCode, {'data-field': 'coatingCode', 'aria-label': 'Покрытие позиции'}),
        element('div', {class: 'hint coating-factor', 'data-factor': row.id})
      ]),
      cell('item-quantity', [input(row.quantity, 'quantity', 'Количество позиции', {inputmode: 'decimal'})]),
      cell('item-coefficients', [element('div', {class: 'coef-grid'}, [
        element('label', {class: 'mini-label', text: 'КП-1'}, [input(row.k1, 'k1', 'Коэффициент КП-1', {inputmode: 'decimal'})]),
        element('span', {class: 'coef-times', text: '×'}),
        element('label', {class: 'mini-label', text: 'КП-2'}, [input(row.k2, 'k2', 'Коэффициент КП-2', {inputmode: 'decimal'})])
      ])]),
      cell('item-drawing', [drawSelect, element('div', {class: 'hint', text: kitText})]),
      cell('item-conditions', [element('label', {class: 'check-label'}, [
        input('', 'nonstandard', 'Нестандартная позиция', {type: 'checkbox', checked: row.nonstandard}),
        element('span', {text: 'Нестандарт'})
      ])]),
      cell('item-remove', [element('button', {type: 'button', class: 'icon-button', 'data-action': 'remove', text: '×', 'aria-label': 'Удалить позицию'})]),
      element('div', {class: 'item-summary', 'data-summary': row.id})
    ]);
    if (config.formulaMode === 'excel') {
      node.append(element('div', {class: 'item-extras'}, ['fasteners', 'extraCoating', 'delivery'].map((key, index) =>
        element('label', {class: 'mini-label', text: ['Крепёж / покупные, ₽ за ед.', 'Доп. покрытие, ₽ за ед.', 'Доставка, ₽ за ед.'][index]}, [
          input(row[key] ?? '0', key, ['Крепёж', 'Дополнительное покрытие', 'Доставка'][index], {inputmode: 'decimal'})
        ])
      )));
    }
    return node;
  });
  $('itemsBody').replaceChildren(...nodes);
  recalc();
}
function recalc() {
  calculation = calculateQuote(draft().rows, config);
  $('grandTotal').textContent = calculation.valid ? formatMoney(calculation.total, config.currency) : 'Проверьте позиции';
  $('quantityTotal').textContent = String(calculation.quantity || 0) + ' ед.';
  $('formulaHint').textContent = formulaText();
  for (const row of calculation.rows) {
    const summary = [...document.querySelectorAll('[data-summary]')].find(n => n.dataset.summary === row.id);
    if (summary) {
      summary.textContent = row.valid
        ? 'Цена за единицу: ' + formatMoney(row.unitPrice, config.currency) + ' · Сумма: ' + formatMoney(row.lineTotal, config.currency)
        : row.errors.join(' · ');
      summary.classList.toggle('invalid', !row.valid);
    }
    const factor = [...document.querySelectorAll('[data-factor]')].find(n => n.dataset.factor === row.id);
    if (factor) factor.textContent = config.formulaMode === 'excel' ? 'Доплата задаётся суммой ниже' : '× ' + (row.coatingFactor ?? '—');
  }
  $('saveBtn').disabled = busy || !calculation.valid;
  $('createQuoteBtn').disabled = !calculation.valid;
  $('applyDealBtn').disabled = !connected || !calculation.valid || busy;
  remember();
}
function selectedDocuments(rows = draft().rows, sourceRelations = relations) {
  const files = new Map();
  for (const row of rows) {
    if (!row.productId) continue;
    const drawing = resolveRelations(row.productId, sourceRelations).drawings.find(d => d.id === row.drawingId);
    if (!drawing) continue;
    if (drawing.fileId) files.set(String(drawing.fileId), {id: drawing.fileId, name: drawing.name, type: 'Чертёж', product: row.productName});
    for (const kit of drawing.kits) {
      for (const file of kit.files) files.set(String(file.id), {id: file.id, name: file.name, type: kit.name, product: row.productName});
    }
  }
  return [...files.values()];
}
function renderDocuments() {
  const docs = selectedDocuments();
  $('docsBody').replaceChildren(...docs.map(file =>
    element('div', {class: 'document-row'}, [
      element('span', {class: 'file-icon', text: '▤', 'aria-hidden': 'true'}),
      element('div', {class: 'document-info'}, [
        element('strong', {text: file.name}),
        element('div', {class: 'hint', text: file.type + ' · ' + file.product})
      ]),
      element('span', {class: 'document-state', text: relationMeta.source === 'demo' ? 'Пример' : 'Связан'}),
      element('button', {type: 'button', class: 'text-button', 'data-file-id': file.id, text: 'Открыть →'})
    ])
  ));
  if (!docs.length) $('docsBody').append(element('p', {class: 'empty-state', text: 'Выберите чертёж позиции — связанные файлы появятся здесь.'}));
}
function renderRelations() {
  const count = relations.product_drawings.length;
  $('relationsSummary').textContent = count + ' связей товаров · версия ' + (relations.version || 'без версии') + (relationMeta.source === 'demo' ? ' · демонстрация' : '');
  $('relationsBody').replaceChildren(...relations.product_drawings.map(link => {
    const drawing = resolveRelations(link.product_id, relations).drawings.find(d => d.id === link.drawing_id);
    return element('div', {class: 'relation-row'}, [
      element('strong', {text: (link.product_name || 'Товар #' + link.product_id)}),
      element('span', {text: '→ ' + (drawing?.name || link.drawing_id)}),
      element('span', {class: 'hint', text: '→ ' + (drawing?.kits.map(k => k.name).join(', ') || 'Комплект КД не задан')})
    ]);
  }));
}
function render() {
  $('dealBadge').textContent = state.scope === 'demo' ? 'ПИЛОТ' : 'Сделка #' + state.activeDealId;
  $('connectionBadge').textContent = connected ? 'Bitrix24 подключён' : 'Демонстрационный режим';
  $('connectionBadge').classList.toggle('connected', connected);
  renderVariants(); renderRows(); renderDocuments(); renderRelations();
}
function ensureValid() {
  calculation = calculateQuote(draft().rows, config);
  if (!calculation.valid) throw new Error('Исправьте данные расчёта: ' + calculation.errors.join('; '));
  if (!draft().rows.length) throw new Error('Добавьте хотя бы одну позицию.');
  if (!String(draft().companyName || '').trim()) throw new Error('Укажите наименование компании.');
  for (const row of draft().rows) {
    const draws = drawOptions(row);
    if (row.drawingId && !draws.some(d => d.id === row.drawingId)) throw new Error('Обновите чертёж для позиции «' + row.productName + '»: связь изменена.');
    if (draws.length > 1 && !row.drawingId) throw new Error('Выберите чертёж для позиции «' + row.productName + '».');
  }
}
function buildSnapshot() {
  ensureValid();
  const variant = currentVariant();
  const version = Math.max(0, ...variant.versions.map(v => Number(v.version) || 0)) + 1;
  return {
    schemaVersion: 1, snapshotId: uid(), dealId: state.scope === 'demo' ? null : String(state.activeDealId),
    variantId: variant.id, variantName: variant.name, version, createdAt: new Date().toISOString(),
    companyName: draft().companyName, shipmentDate: draft().shipmentDate, currency: config.currency,
    rows: clone(calculation.rows), total: calculation.total, quantity: calculation.quantity,
    config: clone(config), relations: clone(relations), relationMeta: clone(relationMeta), priceMeta: clone(priceMeta),
    documents: selectedDocuments(), storage: 'local'
  };
}
async function saveVersion() {
  if (busy) return;
  busy = true; recalc();
  try {
    const snapshot = buildSnapshot();
    const variant = currentVariant();
    variant.versions.push(snapshot);
    remember();
    if (connected && state.scope !== 'demo' && state.settings.historyFolderId) {
      status('Сохраняю неизменяемую версию КП на Диск…');
      try {
        const saved = await adapter.saveSnapshot(state.settings.historyFolderId, snapshot);
        snapshot.storage = 'disk'; snapshot.diskFileId = saved.fileId;
      } catch (error) {
        snapshot.storageWarning = safeError(error);
        if (error.fileId) snapshot.unverifiedDiskFileId = error.fileId;
        remember();
        status('Версия сохранена в этом браузере. Общая запись на Диск не подтверждена: ' + snapshot.storageWarning, 'error');
        return snapshot;
      }
    }
    remember();
    status('Сохранена версия ' + snapshot.version + ' варианта «' + snapshot.variantName + '»' +
      (snapshot.storage === 'disk' ? ' на Диске Bitrix24.' : ' в этом браузере. Для общей истории укажите папку Диска в настройках.'), 'success');
    return snapshot;
  } catch (error) { status(safeError(error), 'error'); return null; }
  finally { busy = false; recalc(); }
}
function safeError(error) {
  return String(error?.message || error).replace(/https?:\/\/[^\s"'<>]+/g, '[адрес скрыт]');
}
function downloadJson(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type: 'application/json'}));
  const a = element('a', {href: url, download: name});
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function renderHistory() {
  const versions = [...currentVariant().versions].sort((a, b) => b.version - a.version);
  $('historyBody').replaceChildren(...versions.map(snapshot =>
    element('div', {class: 'history-row'}, [
      element('div', {}, [
        element('strong', {text: 'Версия ' + snapshot.version + ' · ' + formatMoney(snapshot.total, snapshot.currency)}),
        element('div', {class: 'hint', text: new Date(snapshot.createdAt).toLocaleString('ru-RU', {timeZone: 'Europe/Moscow'}) + ' · ' + (snapshot.storage === 'disk' ? 'Диск Bitrix24' : 'Этот браузер')})
      ]),
      element('button', {type: 'button', class: 'secondary-button', 'data-view-version': snapshot.snapshotId, text: 'Просмотреть'}),
      element('button', {type: 'button', class: 'secondary-button', 'data-restore-version': snapshot.snapshotId, text: 'В черновик'})
    ])
  ));
  if (!versions.length) $('historyBody').append(element('p', {class: 'empty-state', text: 'Сохранённых версий пока нет. Кнопка «Сохранить» создаёт первую версию.'}));
}
function showQuote(snapshot) {
  const table = element('table', {class: 'quote-table'});
  table.append(element('thead', {}, [element('tr', {}, ['Наименование', 'Покрытие', 'Кол-во', 'Цена, ₽', 'Сумма, ₽'].map(x => element('th', {text: x})))]));
  const tbody = element('tbody');
  for (const row of snapshot.rows) {
    const coating = snapshot.config.coatings.find(c => c.code === row.coatingCode);
    tbody.append(element('tr', {}, [
      row.productName, coating?.name || row.coatingCode, String(row.quantity),
      formatMoney(row.unitPrice, snapshot.currency), formatMoney(row.lineTotal, snapshot.currency)
    ].map(text => element('td', {text}))));
  }
  table.append(tbody);
  $('quotePreview').replaceChildren(
    element('div', {class: 'quote-heading', text: 'ЮЗМ · Коммерческое предложение'}),
    element('p', {text: snapshot.companyName}),
    element('p', {class: 'hint', text: snapshot.variantName + ' · версия ' + snapshot.version + ' · ' + new Date(snapshot.createdAt).toLocaleDateString('ru-RU', {timeZone: 'Europe/Moscow'})}),
    table,
    element('p', {class: 'quote-total', text: 'Итого: ' + formatMoney(snapshot.total, snapshot.currency)}),
    element('p', {class: 'hint', text: 'Пилотный расчёт. Коммерческие условия и трактовку НДС необходимо настроить перед рабочим применением.'})
  );
  $('quoteDialog').dataset.snapshotId = snapshot.snapshotId;
  openDialog('quoteDialog');
}
function settingsToForm() {
  const s = state.settings;
  for (const key of ['dealId', 'relationsFileId', 'pricesFileId', 'historyFolderId']) $(key === 'dealId' ? 'dealIdInput' : key).value = s[key] || '';
  $('formulaMode').value = config.formulaMode;
  $('roundingMode').value = config.rounding;
  settingsMessage('');
}
function readSettingsForm() {
  const result = {...state.settings};
  for (const key of ['dealId', 'relationsFileId', 'pricesFileId', 'historyFolderId']) {
    const value = $(key === 'dealId' ? 'dealIdInput' : key).value.trim();
    if (value && !/^[1-9]\d*$/.test(value)) throw new Error('ID сделки, файлов и папки должны быть положительными целыми числами.');
    result[key] = value;
  }
  result.formulaMode = $('formulaMode').value; result.rounding = $('roundingMode').value;
  return result;
}
function keepSettings() {
  const next = readSettingsForm();
  config = validateConfig({...config, formulaMode: next.formulaMode, rounding: next.rounding});
  state.settings = next; remember();
}
function applyRelations(raw, metadata) {
  const normalized = normalizeRelations(raw);
  relations = normalized; relationMeta = metadata;
  for (const variant of [currentVariant()]) {
    for (const row of variant.draft.rows) {
      const drawings = drawOptions(row);
      if (!drawings.some(d => d.id === row.drawingId)) row.drawingId = drawings.length === 1 ? drawings[0].id : '';
    }
  }
}
function applyPrices(raw, metadata) {
  config = validateConfig({...raw, formulaMode: state.settings.formulaMode, rounding: state.settings.rounding});
  priceMeta = metadata;
  const codes = new Set(config.coatings.map(c => c.code));
  for (const row of draft().rows) if (!codes.has(row.coatingCode)) row.coatingCode = config.coatings[0].code;
}
async function loadRemote() {
  try {
    keepSettings();
    const s = state.settings;
    if (!s.relationsFileId && !s.pricesFileId) throw new Error('Укажите ID файла связей или покрытий.');
    const files = await Promise.all([
      s.relationsFileId ? adapter.loadDiskJson(s.relationsFileId) : null,
      s.pricesFileId ? adapter.loadDiskJson(s.pricesFileId) : null
    ]);
    // Validate both files before making any state changes.
    if (files[0]) normalizeRelations(files[0].data);
    if (files[1]) validateConfig(files[1].data);
    if (files[0]) applyRelations(files[0].data, {source: 'disk', fileId: files[0].fileId, version: files[0].version});
    if (files[1]) applyPrices(files[1].data, {source: 'disk', fileId: files[1].fileId, version: files[1].version});
    render(); settingsToForm();
    settingsMessage('Справочники загружены и проверены.');
    status('Справочники с Диска применены к текущему черновику. Сохранённые версии не изменены.', 'success');
  } catch (error) { settingsMessage(safeError(error) + ' При ограничениях браузера загрузите скачанный JSON вручную.'); }
}
async function importFile(event, type) {
  try {
    const file = event.target.files?.[0]; if (!file) return;
    if (file.size > 2 * 1024 * 1024) throw new Error('Для пилота размер JSON ограничен 2 МБ.');
    const json = JSON.parse(await file.text());
    if (type === 'relations') applyRelations(json, {source: 'local-file', name: file.name});
    else applyPrices(json, {source: 'local-file', name: file.name});
    render(); settingsToForm();
    settingsMessage('Загружен файл «' + file.name + '».');
    status('Справочник «' + file.name + '» загружен. Старые версии КП сохраняют прежние данные.', 'success');
  } catch (error) { settingsMessage(safeError(error)); }
  finally { event.target.value = ''; }
}
async function openDocument(id) {
  try {
    const example = relationMeta.source === 'demo' ? demoFile(id) : null;
    if (example) { window.open(example, '_blank', 'noopener'); return; }
    if (!connected) throw new Error('Для открытия файла Диска запустите приложение в Bitrix24.');
    const file = await adapter.call('disk.file.get', {id: Number(id)});
    const url = file.DETAIL_URL;
    if (!url) throw new Error('Bitrix24 не вернул ссылку на документ.');
    const parsed = new URL(url, window.location.href);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Недопустимая ссылка на документ.');
    window.open(parsed.href, '_blank', 'noopener');
  } catch (error) { status(safeError(error), 'error'); }
}
async function searchProducts(query, target) {
  $(target).textContent = 'Поиск…';
  try {
    const matches = connected
      ? (/^[1-9]\d*$/.test(query) ? [await adapter.getProduct(query)] : await adapter.searchProducts(query))
      : demoProducts.filter(p => p.id === query || p.name.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')));
    $(target).replaceChildren(...matches.map(product => element('button', {
      type: 'button', class: 'catalog-result', 'data-product': JSON.stringify(product),
      text: product.name + ' · ' + formatMoney(product.basePrice, product.currency) + ' · #' + product.id
    })));
    if (!matches.length) $(target).append(element('p', {class: 'empty-state', text: 'Товары не найдены. Можно искать по точному ID.'}));
  } catch (error) { $(target).textContent = safeError(error); }
}
function chooseProduct(product) {
  if (product.currency !== config.currency) throw new Error('Валюта товара не совпадает с валютой КП. Автоматическая конвертация не выполняется.');
  product.source = connected ? 'catalog' : 'demo';
  if (!catalogProducts.some(p => String(p.id) === String(product.id))) catalogProducts.push(product);
  if (chosenRow) {
    const row = draft().rows.find(r => r.id === chosenRow);
    if (!row) throw new Error('Позиция уже удалена.');
    Object.assign(row, {productId: String(product.id), productName: product.name, basePrice: product.basePrice, currency: product.currency, source: product.source, priceSource: 'catalog'});
    const drawings = drawOptions(row); row.drawingId = drawings.length === 1 ? drawings[0].id : '';
  } else {
    const row = newRow(product); const drawings = drawOptions(row);
    row.drawingId = drawings.length === 1 ? drawings[0].id : ''; draft().rows.push(row);
  }
  renderRows(); renderDocuments();
  if ($('productDialog').open) closeDialog('productDialog');
  status('Товар добавлен в черновик КП. Каталог и сделка не изменены.', 'success');
}
async function connectDeal(id) {
  if (!connected) throw new Error('Откройте приложение внутри Bitrix24.');
  if (!/^[1-9]\d*$/.test(String(id))) throw new Error('Укажите ID сделки.');
  const deal = await adapter.loadDeal(id);
  const scope = 'bitrix-' + (window.BX24?.getDomain?.() || window.location.host) + '-deal-' + id;
  const savedSettings = {...state.settings, dealId: String(id)};
  const stored = readStored(scope);
  if (stored) restore(stored);
  else {
    const rows = (deal.rows || []).map(row => ({
      ...newRow({id: String(row.productId || ''), name: row.productName, basePrice: row.price ?? row.unitPrice ?? 0, currency: deal.currency, source: 'deal'}),
      quantity: String(row.quantity), priceSource: 'deal', taxRate: row.taxRate ?? 0, taxIncluded: row.taxIncluded ?? 'Y'
    }));
    const v = makeVariant('Основной вариант', {companyName: deal.companyName || deal.title, shipmentDate: '', rows, currency: deal.currency});
    state = {schemaVersion: 1, scope, activeDealId: String(id), settings: savedSettings, variants: [v], selectedVariantId: v.id};
    config = validateConfig({...config, currency: deal.currency});
    // Demo IDs and documents must never be used as real portal bindings.
    if (relationMeta.source === 'demo') { relations = normalizeRelations({version: 'empty', product_drawings: [], drawing_kd: []}); relationMeta = {source: 'unconfigured'}; }
  }
  state.activeDealId = String(id);
  state.settings = {...state.settings, ...savedSettings};
  catalogProducts = state.variants.flatMap(v => v.draft.rows).map(r => ({id: r.productId, name: r.productName, basePrice: r.basePrice, currency: r.currency, source: r.source}));
  if (state.settings.historyFolderId) {
    try {
      const snapshots = await adapter.loadHistory(state.settings.historyFolderId, id);
      for (const snapshot of snapshots) {
        if (snapshot.schemaVersion !== 1 || !snapshot.snapshotId || !snapshot.variantId || !Array.isArray(snapshot.rows)) continue;
        validateConfig(snapshot.config); normalizeRelations(snapshot.relations);
        let v = state.variants.find(v => v.id === snapshot.variantId);
        if (!v) {
          v = {id: snapshot.variantId, name: snapshot.variantName || 'Вариант', draft: {companyName: snapshot.companyName, shipmentDate: snapshot.shipmentDate, rows: clone(snapshot.rows), currency: snapshot.currency}, versions: [],
            context: {config: clone(snapshot.config), relations: clone(snapshot.relations), relationMeta: clone(snapshot.relationMeta || {}), priceMeta: clone(snapshot.priceMeta || {})}};
          state.variants.push(v);
        }
        if (!v.versions.some(x => x.snapshotId === snapshot.snapshotId)) v.versions.push({...snapshot, storage: 'disk'});
      }
    } catch (error) { status('Сделка загружена, общая история недоступна: ' + safeError(error), 'error'); render(); return; }
  }
  render(); settingsToForm();
  status('Сделка #' + id + ' загружена. Существующие строки используют цену сделки; для базовой цены выберите товар из каталога.', 'success');
}
async function applyToDeal() {
  if (busy) return;
  try {
    ensureValid();
    if (state.scope === 'demo') throw new Error('Демонстрационные позиции нельзя записать в реальную сделку. Подключите сделку и выберите товары её каталога.');
    if (draft().rows.some(r => r.source === 'demo' || !r.productId)) throw new Error('Замените демонстрационные и свободные позиции товарами каталога.');
    if (calculation.rows.some(r => r.unitPrice < 0)) throw new Error('Отрицательные коэффициенты допустимы в модели, но отрицательные цены не отправляются в CRM.');
    const crmCalculation = calculateQuote(draft().rows, {...config, rounding: 'unit'});
    if (Math.abs(crmCalculation.total - calculation.total) > 0.01) throw new Error('Для переноса в товары сделки выберите в настройках округление «Сначала цена единицы»: CRM хранит цену каждой единицы.');
    if (String(state.settings.dealId) !== String(state.activeDealId)) throw new Error('ID в настройках изменён. Сначала откройте данные этой сделки.');
    const dealId = state.activeDealId;
    const before = await adapter.loadDeal(dealId);
    previewFingerprint = fingerprintRows(before.rows);
    const warning = 'Заменить ВСЕ ' + before.rows.length + ' товарных позиций сделки #' + dealId +
      ' выбранным КП (' + draft().rows.length + ' позиций, ' + formatMoney(calculation.total, config.currency) + ')?';
    if (!window.confirm(warning)) return;
    const snapshot = await saveVersion();
    if (!snapshot) return;
    if (state.settings.historyFolderId && snapshot.storage !== 'disk') throw new Error('Версия сохранена локально, но запись на Диск не подтверждена. Товары сделки не изменены.');
    busy = true; recalc(); status('Проверяю сделку и записываю выбранный вариант…');
    const result = await adapter.applyToDeal(dealId, snapshot, previewFingerprint);
    status('Выбранный вариант записан в сделку #' + dealId + '. ' + (result?.message || 'Товарные позиции повторно прочитаны и проверены.'), 'success');
  } catch (error) { status(safeError(error), 'error'); }
  finally { busy = false; recalc(); }
}
function bindEvents() {
  $('companyName').addEventListener('input', e => { draft().companyName = e.target.value; remember(); });
  $('shipmentDate').addEventListener('input', e => { draft().shipmentDate = e.target.value; remember(); });
  $('variantName').addEventListener('input', e => { currentVariant().name = e.target.value.trim() || 'Без названия'; remember(); });
  $('variantName').addEventListener('change', renderVariants);
  $('variantSelect').addEventListener('change', e => activateVariant(e.target.value));
  $('newVariantBtn').addEventListener('click', () => {
    const v = makeVariant('Вариант ' + (state.variants.length + 1), {...blankDraft([]), companyName: draft().companyName, currency: config.currency});
    state.variants.push(v); state.selectedVariantId = v.id; render();
  });
  $('duplicateVariantBtn').addEventListener('click', () => {
    const v = makeVariant(currentVariant().name + ' — копия', clone(draft()));
    state.variants.push(v); state.selectedVariantId = v.id; render();
  });
  $('itemsBody').addEventListener('input', e => {
    const field = e.target.dataset.field;
    if (!field || e.target.tagName === 'SELECT') return;
    const row = draft().rows.find(r => r.id === e.target.closest('[data-row-id]')?.dataset.rowId);
    if (!row) return;
    row[field] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    recalc();
  });
  $('itemsBody').addEventListener('change', e => {
    const field = e.target.dataset.field; if (!field || e.target.tagName !== 'SELECT') return;
    const row = draft().rows.find(r => r.id === e.target.closest('[data-row-id]')?.dataset.rowId); if (!row) return;
    if (field === 'productId') {
      const product = catalogProducts.find(p => String(p.id) === e.target.value); if (!product) return;
      Object.assign(row, {productId: String(product.id), productName: product.name, basePrice: product.basePrice, currency: product.currency, source: product.source || 'catalog'});
      const drawings = drawOptions(row); row.drawingId = drawings.length === 1 ? drawings[0].id : '';
    } else row[field] = e.target.value;
    renderRows(); renderDocuments();
  });
  $('itemsBody').addEventListener('click', e => {
    const action = e.target.closest('[data-action]')?.dataset.action; if (!action) return;
    const rowId = e.target.closest('[data-row-id]')?.dataset.rowId;
    if (action === 'remove') { draft().rows = draft().rows.filter(r => r.id !== rowId); renderRows(); renderDocuments(); }
    if (action === 'choose-product') { chosenRow = rowId; openDialog('productDialog'); searchProducts('', 'productResults'); }
  });
  $('addItemBtn').addEventListener('click', () => { chosenRow = null; openDialog('productDialog'); searchProducts('', 'productResults'); });
  $('productSearchBtn').addEventListener('click', () => searchProducts($('productQuery').value.trim(), 'productResults'));
  $('productQuery').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); searchProducts(e.target.value.trim(), 'productResults'); } });
  for (const id of ['productResults', 'catalogResults']) $(id).addEventListener('click', e => {
    const raw = e.target.closest('[data-product]')?.dataset.product;
    if (raw) try { chooseProduct(JSON.parse(raw)); } catch (error) { status(safeError(error), 'error'); }
  });
  $('searchCatalogBtn').addEventListener('click', () => { chosenRow = null; searchProducts($('catalogQuery').value.trim(), 'catalogResults'); });
  $('saveBtn').addEventListener('click', saveVersion);
  $('createQuoteBtn').addEventListener('click', async () => { const snapshot = await saveVersion(); if (snapshot) showQuote(snapshot); });
  $('applyDealBtn').addEventListener('click', applyToDeal);
  $('downloadBtn').addEventListener('click', () => {
    try { downloadJson(buildSnapshot(), 'yuzm-kp-' + currentVariant().id + '.json'); }
    catch (error) { status(safeError(error), 'error'); }
  });
  $('historyBtn').addEventListener('click', () => { renderHistory(); openDialog('historyDialog'); });
  $('historyBody').addEventListener('click', e => {
    const view = e.target.dataset.viewVersion, restoreId = e.target.dataset.restoreVersion;
    const snapshot = currentVariant().versions.find(s => s.snapshotId === (view || restoreId)); if (!snapshot) return;
    if (view) { closeDialog('historyDialog'); showQuote(snapshot); }
    else {
      currentVariant().draft = {companyName: snapshot.companyName, shipmentDate: snapshot.shipmentDate, currency: snapshot.currency, rows: clone(snapshot.rows)};
      config = validateConfig(snapshot.config); relations = normalizeRelations(snapshot.relations);
      relationMeta = clone(snapshot.relationMeta || {}); priceMeta = clone(snapshot.priceMeta || {});
      state.settings.formulaMode = config.formulaMode; state.settings.rounding = config.rounding;
      closeDialog('historyDialog'); render(); status('Версия ' + snapshot.version + ' скопирована в черновик. История сохранена.', 'success');
    }
  });
  $('settingsBtn').addEventListener('click', () => { settingsToForm(); openDialog('settingsDialog'); });
  $('settingsForm').addEventListener('submit', e => {
    e.preventDefault();
    try { keepSettings(); closeDialog('settingsDialog'); render(); status('Настройки сохранены.', 'success'); }
    catch (error) { settingsMessage(safeError(error)); }
  });
  $('loadRemoteBtn').addEventListener('click', loadRemote);
  $('localRelationsInput').addEventListener('change', e => importFile(e, 'relations'));
  $('localPricesInput').addEventListener('change', e => importFile(e, 'prices'));
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
    state = freshState(); config = validateConfig(await (await fetch('data/coatings.example.json')).json());
    relations = normalizeRelations(await (await fetch('data/relations.example.json')).json());
    relationMeta = {source: 'demo'}; priceMeta = {source: 'demo'}; catalogProducts = clone(demoProducts);
    closeDialog('settingsDialog'); render(); status('Открыты демонстрационные данные. Запись в реальную сделку заблокирована.', 'info');
  });
  $('toggleRelationsBtn').addEventListener('click', () => {
    $('relationsBody').hidden = !$('relationsBody').hidden;
    $('toggleRelationsBtn').setAttribute('aria-expanded', String(!$('relationsBody').hidden));
  });
  $('docsBody').addEventListener('click', e => { const id = e.target.closest('[data-file-id]')?.dataset.fileId; if (id) openDocument(id); });
  for (const name of ['Settings', 'History', 'Product', 'Quote']) $('close' + name + 'Btn').addEventListener('click', () => closeDialog(name.toLowerCase() + 'Dialog'));
  $('printBtn').addEventListener('click', () => window.print());
}
async function boot() {
  try {
    const [prices, links] = await Promise.all([fetch('data/coatings.example.json').then(r => r.json()), fetch('data/relations.example.json').then(r => r.json())]);
    config = validateConfig(prices); relations = normalizeRelations(links); state = freshState();
    const stored = readStored('demo'); if (stored) restore(stored);
    try { const settings = JSON.parse(localStorage.getItem(STORE + '-settings')); if (settings) state.settings = {...state.settings, ...settings}; } catch {}
    bindEvents(); render();
    const connection = await adapter.init();
    connected = connection.connected;
    if (connected) {
      $('connectionBadge').textContent = 'Bitrix24 подключён'; $('connectionBadge').classList.add('connected');
      const dealId = connection.dealId || state.settings.dealId;
      if (dealId) try { await connectDeal(String(dealId)); } catch (error) { status(safeError(error), 'error'); }
      else status('Bitrix24 подключён. Откройте вкладку сделки или укажите её ID в настройках.');
    }
  } catch (error) {
    status('Не удалось запустить калькулятор: ' + safeError(error) + '. Запускайте приложение через HTTP-сервер, а не двойным кликом по HTML.', 'error');
  }
}
boot();
