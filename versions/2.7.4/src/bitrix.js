import {calculationVersion, jsonBase64} from './calculation-version.js';
import {DELIVERY_MODE_FIELD, deliveryModeIds} from './delivery-mode.js';
import {PAYMENT_FIELD, paymentIds} from './payment-terms.js';
import {DELIVERY_ADDRESS_FIELD, deliveryAddressText} from './delivery-address.js';
/* Bitrix24 application transport. No webhook URLs or application secrets are stored here. */
import { parseNumber, formatCoating, formatExecutionTerm, isCustomRow } from './calculator.js';
import { filterCatalogEntries, catalogNavigation, navigationFields, NAVIGATION_IBLOCK_ID, isInactiveCatalogEntry, hasCatalogProperty } from './catalog.js';
import {SUPPORT_SECTION_IDS, catalogSectionId} from './fasteners.js';
import {signatureReference} from './manager.js';

const ALLOWED_METHODS = new Set([
  'app.info', 'app.option.get', 'app.option.set', 'user.get',
  'crm.deal.get', 'crm.deal.fields', 'crm.deal.update', 'crm.deal.productrows.get',
  'crm.item.productrow.set', 'crm.company.get', 'crm.contact.get',
  'crm.catalog.list', 'crm.product.list', 'crm.product.get',
  'catalog.catalog.list', 'catalog.product.list', 'catalog.product.get',
  'catalog.product.offer.list', 'catalog.product.offer.get',
  'catalog.product.sku.list', 'catalog.product.sku.get',
  'catalog.priceType.list', 'catalog.price.list',
  'crm.documentgenerator.template.list', 'crm.documentgenerator.template.get',
  'crm.documentgenerator.document.add', 'crm.documentgenerator.document.get', 'crm.documentgenerator.document.list',
  'disk.file.get', 'disk.folder.uploadfile', 'disk.folder.getchildren', 'disk.file.uploadVersion', 'disk.file.rename',
  'placement.bind', 'placement.get',
]);
const QUOTE_TEMPLATE_OPTION = 'yuzmQuoteTemplateId';
const DOCUMENT_FIELDS = [
  'YuzmPaymentTerms', 'YuzmFastenerTerms', 'YuzmDocumentsTerms', 'YuzmDeliveryTerms',
  'YuzmValidityTerms', 'YuzmManagerPosition', 'YuzmManagerName', 'YuzmManagerPhone', 'YuzmManagerEmail',
];
const DOCUMENT_ITEM_FIELDS = {
  ProductsIndex: 'KpItems.INDEX',
  ProductsProductName: 'KpItems.Item.Name',
  YuzmCoating: 'KpItems.Item.Coating',
  ProductsProductQuantity: 'KpItems.Item.Quantity',
  ProductsProductPriceBrutto: 'KpItems.Item.Price',
  ProductsProductPriceBruttoSum: 'KpItems.Item.Total',
  YuzmDeliveryPeriod: 'KpItems.Item.ExecutionTerm',
};
const DOCUMENT_MONEY = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

function id(value, label = 'ID') {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) <= 0) {
    throw new Error(`${label}: требуется положительное целое число.`);
  }
  return String(Number(text));
}

function number(value, label) {
  const text = String(value ?? '').trim().replace(',', '.');
  const result = Number(text);
  if (!text || !Number.isFinite(result)) throw new Error(`${label}: требуется конечное число.`);
  return result;
}

function currency(value) {
  const result = String(value ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(result)) throw new Error('API не вернул корректную валюту.');
  return result;
}

function documentText(value, label, required = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`${label}: требуется текст.`);
  }
  if (value.length > 10000) throw new Error(`${label}: текст превышает 10 000 символов.`);
  if (required && !value.trim()) throw new Error(`${label}: заполните поле.`);
  // Commercial text is transferred as entered, including intentional spacing
  // and line breaks. Treat whitespace-only optional fields as empty.
  return value.trim() ? value : '';
}

function documentMoney(value, label) {
  if (!['string', 'number'].includes(typeof value)) throw new Error(`${label}: требуется конечное число.`);
  const result = number(value, label);
  if (result < 0) throw new Error(`${label}: отрицательные суммы нельзя передать в документ.`);
  if (!Number.isSafeInteger(Math.round(result * 100))) throw new Error(`${label}: сумма превышает допустимый диапазон.`);
  return result;
}

function documentTemplate(raw, categoryId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Bitrix24 вернул некорректный шаблон документа.');
  const templateId = id(raw.id, 'ID шаблона');
  const name = documentText(raw.name, 'Название шаблона', true);
  const bindings = Array.isArray(raw.entityTypeId) ? raw.entityTypeId.map(String) : [];
  const available = raw.active === 'Y' && raw.isDeleted !== 'Y'
    && bindings.some(binding => binding === '2' || binding === `2_category_${categoryId}`);
  return { id: templateId, name, available };
}

function apiError(method, result) {
  // API descriptions can include request URLs, auth parameters or arbitrary server HTML.
  // Show only a constrained error code; never propagate those descriptions to the UI.
  const sdkError = result.error();
  const details = sdkError?.getError?.() ?? sdkError?.ex;
  const raw = details?.error ?? result.answer?.error
    ?? (typeof sdkError === 'string' || typeof sdkError === 'number' ? sdkError : 'API_ERROR');
  let code = /^[A-Za-z_\d.-]{1,80}$/.test(String(raw)) ? String(raw) : 'API_ERROR';
  const description = details?.error_description ?? result.answer?.error_description ?? result.error_description?.();
  // Empty/zero codes also represent fatal failures. Recognize only known missing-product
  // messages, and replace them with our own text rather than exposing server content.
  const productMethod = /^catalog\.product\.(?:(?:offer|sku)\.)?get$/.test(method) || method === 'crm.product.get';
  const missingProduct = /^(?:(?:product(?: offer)?|offer|sku) does not exist\.?|product (?:is )?not found\.?)$/i;
  if (productMethod && ['NOT_FOUND', 'ERROR_NOT_FOUND'].includes(String(raw))) code = 'PRODUCT_NOT_FOUND';
  if (productMethod && [raw, description].some(value => typeof value === 'string' && missingProduct.test(value.trim()))) {
    if (['', '0', 'NOT_FOUND', 'ERROR_NOT_FOUND', 'API_ERROR'].includes(String(raw)) || missingProduct.test(String(raw).trim())) {
      code = 'PRODUCT_NOT_FOUND';
    }
  }
  const hints = {
    PRODUCT_NOT_FOUND: 'Товар с указанным ID не найден на этом портале.',
    '200040300010': 'У сотрудника нет права на просмотр торгового каталога.',
    '200040300040': 'У сотрудника нет права на чтение этого товара или его инфоблока.',
    '200040300000': 'Инфоблок товара не найден на этом портале.',
    insufficient_scope: 'Проверьте разрешения установленного приложения; после изменения прав переустановите его.',
    QUERY_LIMIT_EXCEEDED: 'Превышен лимит запросов Bitrix24. Подождите и повторите поиск.',
    OPERATION_TIME_LIMIT: 'Bitrix24 временно заблокировал метод из-за нагрузки. Повторите запрос позже.',
    OVERLOAD_LIMIT: 'REST API портала заблокирован из-за нагрузки. Обратитесь в поддержку Bitrix24.',
    INTERNAL_SERVER_ERROR: 'Внутренняя ошибка Bitrix24. Повторите запрос позже.',
    ERROR_UNEXPECTED_ANSWER: 'Bitrix24 вернул неожиданный ответ. Повторите запрос позже.',
    API_ERROR: 'Bitrix24 не вернул распознаваемый код ошибки. Проверьте запрос и доступ сотрудника к каталогу.',
  };
  const error = new Error(`Bitrix24: ${method} — ${code}. ${hints[code] ?? 'Проверьте права приложения и пользователя.'}`);
  error.code = code;
  error.method = method;
  return error;
}

function unavailable(error) {
  return ['ERROR_METHOD_NOT_FOUND', 'METHOD_NOT_FOUND', 'ERROR_UNKNOWN_METHOD'].includes(error?.code);
}

function broadSearchError() {
  const error = new Error('Слишком много совпадений в каталоге. Уточните название или введите ID товара или вариации.');
  error.code = 'CATALOG_SEARCH_TOO_BROAD';
  return error;
}

function variationParent(raw) {
  const parent = raw.parentId ?? raw.PARENT_ID;
  const value = parent && typeof parent === 'object' ? parent.value : parent;
  if (value === undefined || value === null || value === '' || String(value) === '0') return '';
  // This relationship is optional metadata. Never invent a parent from an
  // unfamiliar property shape; the offer's own ID/name/price remain authoritative.
  try { return id(value, 'ID основного товара вариации'); }
  catch { return ''; }
}

function pick(row, upper, lower, fallback = '') {
  return row[upper] ?? row[lower] ?? fallback;
}

/** Exact, deterministic comparison of rows shown in the replacement preview. */
export function fingerprintRows(rows = []) {
  return JSON.stringify(rows.map(item => {
    const row = item.raw ?? item;
    return {
      id: String(pick(row, 'ID', 'id')),
      productId: String(pick(row, 'PRODUCT_ID', 'productId', 0)),
      name: String(pick(row, 'PRODUCT_NAME', 'productName')),
      description: String(pick(row, 'PRODUCT_DESCRIPTION', 'productDescription')),
      price: Number(pick(row, 'PRICE', 'unitPrice', row.price ?? row.basePrice ?? 0)),
      quantity: Number(pick(row, 'QUANTITY', 'quantity', 1)),
      discountType: Number(pick(row, 'DISCOUNT_TYPE_ID', 'discountTypeId', 2)),
      discountRate: Number(pick(row, 'DISCOUNT_RATE', 'discountRate', 0)),
      discountSum: Number(pick(row, 'DISCOUNT_SUM', 'discountSum', 0)),
      taxRate: Number(pick(row, 'TAX_RATE', 'taxRate', 0)),
      taxIncluded: String(pick(row, 'TAX_INCLUDED', 'taxIncluded', 'N')),
      measure: String(pick(row, 'MEASURE_CODE', 'measureCode')),
      sort: Number(pick(row, 'SORT', 'sort', 0)),
      store: String(pick(row, 'STORE_ID', 'storeId', 0)),
      reserve: Number(pick(row, 'RESERVE_QUANTITY', 'reserveQuantity', 0)),
      reserveEnd: String(pick(row, 'DATE_RESERVE_END', 'dateReserveEnd')),
    };
  }));
}

export class BitrixAdapter {
  constructor(options = {}) {
    this.sdk = options.sdk ?? globalThis.BX24;
    this.location = options.location ?? globalThis.location;
    this.handlerUrl = options.handlerUrl ?? null;
    this.placementContext = options.placementContext ?? globalThis.B24_PLACEMENT_CONTEXT;
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.initTimeoutMs = options.initTimeoutMs ?? 15000;
    this.connected = false;
    this.connectionError = null;
    this.dealId = null;
    this._catalogs = null;
    this._basePriceType = null;
    this._requests = [];
    this._catalogEntries = null;
    this._catalogEntryLoad = null;
    this._catalogRaw = new Map();
    this.catalogWarnings = [];
  }

  /** Only method names, counters, timing and safe codes; never request/response bodies. */
  diagnostics() {
    return this._requests.map(({startedAt, ...entry}) => ({...entry,
      elapsed_ms: entry.elapsed_ms ?? Math.max(0, Date.now() - startedAt)}));
  }

  _trace(method) {
    const entry = {method, state: 'pending', pages: 0, items: 0, startedAt: Date.now()};
    this._requests.push(entry);
    if (this._requests.length > 20) this._requests.shift();
    return entry;
  }

  _finishTrace(entry, error) {
    entry.state = error ? 'error' : 'success';
    entry.elapsed_ms = Math.max(0, Date.now() - entry.startedAt);
    if (error) entry.code = error.code ?? 'CLIENT_ERROR';
  }

  async init() {
    this.connected = false;
    this.dealId = null;
    this.connectionError = null;
    this.sdk ??= globalThis.BX24;
    if (!this.sdk?.init || !this.sdk?.callMethod) {
      this.connectionError = {code: 'SDK_UNAVAILABLE', message: 'Библиотека BX24 недоступна. Проверьте диагностику подключения в настройках.'};
      return { connected: false, dealId: null };
    }
    return new Promise(resolve => {
      let settled = false;
      const timer = setTimeout(() => finish(false, 'INIT_TIMEOUT'), this.initTimeoutMs);
      const finish = (connected, code = 'INIT_FAILED') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connected = connected;
        if (!connected) this.connectionError = {
          code,
          message: code === 'INIT_TIMEOUT'
            ? `Библиотека BX24 загружена, но портал не ответил на запрос контекста за ${Math.ceil(this.initTimeoutMs / 1000)} секунд. Повторите подключение; при повторной ошибке скопируйте диагностику из настроек.`
            : 'Не удалось инициализировать BX24. Проверьте диагностику подключения в настройках.',
        };
        if (connected) {
          try {
            const placement = this.sdk.placement?.info?.();
            const options = typeof placement?.options === 'string'
              ? JSON.parse(placement.options) : placement?.options;
            if (placement?.placement === 'CRM_DEAL_DETAIL_TAB' && options?.ID) {
              this.dealId = id(options.ID, 'ID сделки');
            }
          } catch { this.dealId = null; }
          if (!this.dealId && this.placementContext?.dealId) {
            try { this.dealId = id(this.placementContext.dealId, 'ID сделки'); }
            catch { this.dealId = null; }
          }
        }
        resolve({ connected: this.connected, dealId: this.dealId });
      };
      try { this.sdk.init(() => finish(true)); } catch { finish(false); }
    });
  }

  _guard(method) {
    if (!ALLOWED_METHODS.has(method)) throw new Error(`Метод ${method} не разрешён в прототипе. Каталог доступен только для чтения.`);
    if (!this.connected || !this.sdk?.callMethod) {
      throw new Error(this.connectionError?.message || 'Нет соединения с Битрикс24. Проверьте диагностику подключения в настройках.');
    }
  }

  async call(method, params = {}) {
    this._guard(method);
    const trace = this._trace(method);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, data) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._finishTrace(trace, error);
        error ? reject(error) : resolve(data);
      };
      const timer = setTimeout(() => {
        const error = new Error(`Bitrix24: ${method} — время ожидания истекло. Повторите запрос; при повторном сбое скопируйте диагностику из настроек.`);
        error.code = 'REQUEST_TIMEOUT';
        finish(error);
      }, this.timeoutMs);
      try {
        this.sdk.callMethod(method, params, result => {
          try {
            if (result.error()) finish(apiError(method, result));
            else finish(null, result.data());
          } catch { finish(new Error(`Bitrix24: ${method} — некорректный ответ SDK.`)); }
        });
      } catch { finish(new Error(`Bitrix24: ${method} — ошибка транспорта SDK.`)); }
    });
  }

  canManageSettings() {
    try { return this.connected && this.sdk?.isAdmin?.() === true; }
    catch { return false; }
  }

  async getQuoteTemplateId() {
    const value = await this.call('app.option.get', {option: QUOTE_TEMPLATE_OPTION});
    if (value === null || value === '') return '';
    if (!['string', 'number'].includes(typeof value)) throw new Error('Битрикс24 вернул некорректный общий шаблон КП.');
    return id(value, 'ID общего шаблона КП');
  }

  async setQuoteTemplateId(value) {
    const templateId = id(value, 'ID общего шаблона КП');
    if (!this.canManageSettings()) throw new Error('Общий шаблон КП может изменить администратор приложения.');
    const saved = await this.call('app.option.set', {options: {[QUOTE_TEMPLATE_OPTION]: templateId}});
    if (saved !== true) throw new Error('Битрикс24 не подтвердил сохранение общего шаблона КП.');
    const actual = await this.getQuoteTemplateId();
    if (actual !== templateId) throw new Error('Общий шаблон КП изменился при сохранении. Обновите настройки и повторите выбор.');
    return actual;
  }

  async saveCalculationVersion(folderValue, snapshot, options) {
    const folderId = id(folderValue, 'ID папки версий расчёта');
    const dealId = id(snapshot.dealId, 'ID сделки');
    const deal = await this.call('crm.deal.get', {id: Number(dealId)});
    if (String(deal?.ID) !== dealId) throw new Error('Не подтверждена сделка для сохранения расчёта.');
    const version = calculationVersion(snapshot, {...options, deal});
    const name = `yuzm-kp-deal-${dealId}-${version.createdAt.replace(/[:.]/g, '-')}-${version.version}.json`;
    const file = await this.call('disk.folder.uploadfile', {
      id: Number(folderId), data: {NAME: name}, fileContent: [name, jsonBase64(version)],
      generateUniqueName: true,
    });
    if (!file?.ID || file.NAME !== name) throw new Error('Битрикс24 не подтвердил сохранение JSON версии расчёта. Проверьте папку Диска.');
    return {version: version.version, fileId: String(file.ID), name, data: version};
  }

  async linkCalculationVersion(saved, documentValue) {
    const documentId = id(documentValue, 'ID документа');
    const fileId = id(saved.fileId, 'ID JSON');
    const data = {...saved.data, documentId};
    const name = saved.name.replace(/\.json$/i, `-document-${documentId}.json`);
    const updated = await this.call('disk.file.uploadVersion', {id: Number(fileId), fileContent: [name, jsonBase64(data)]});
    if (String(updated?.ID) !== fileId) throw new Error('Не подтверждена запись ID документа в JSON.');
    const renamed = await this.call('disk.file.rename', {id: Number(fileId), newName: name});
    if (String(renamed?.ID) !== fileId || renamed.NAME !== name) throw new Error('Не подтверждена привязка JSON к документу.');
    return {fileId, documentId, name};
  }

  async listCalculationVersions(folderValue, dealValue) {
    const folderId = id(folderValue, 'ID папки версий расчёта');
    const dealId = id(dealValue, 'ID сделки');
    const files = await this._list('disk.folder.getchildren', {id: Number(folderId), filter: {TYPE: 'file'}});
    return files.filter(file => file.TYPE === 'file' && String(file.NAME).startsWith(`yuzm-kp-deal-${dealId}-`)
      && /\.json$/i.test(file.NAME)).map(file => ({id: id(file.ID, 'ID JSON'), name: String(file.NAME)}))
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  async loadCalculationVersion(folderValue, fileValue) {
    const folderId = id(folderValue, 'ID папки версий расчёта');
    const fileId = id(fileValue, 'ID JSON');
    const file = await this.call('disk.file.get', {id: Number(fileId)});
    if (String(file?.ID) !== fileId || String(file.PARENT_ID) !== folderId || file.TYPE !== 'file'
      || !/\.json$/i.test(file.NAME) || !file.DOWNLOAD_URL) throw new Error('JSON не найден в выбранной папке Диска.');
    if (Number(file.SIZE) > 5 * 1024 * 1024) throw new Error('JSON превышает 5 МБ.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this._documentUrl(file.DOWNLOAD_URL), {credentials: 'omit', signal: controller.signal});
      if (!response.ok) throw new Error('Не удалось прочитать JSON с Диска. Проверьте доступ к файлу.');
      const body = await response.text();
      if (new TextEncoder().encode(body).length > 5 * 1024 * 1024) throw new Error('JSON превышает 5 МБ.');
      try { return JSON.parse(body); }
      catch { throw new Error('Файл Диска не содержит корректный JSON.'); }
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Время загрузки JSON истекло.');
      if (error instanceof TypeError) throw new Error('Не удалось прочитать JSON с Диска. Проверьте доступ и CORS портала.');
      throw error;
    } finally { clearTimeout(timer); }
  }

  /** SDK Result.more()/next() preserve next offsets for every supported list method. */
  async _list(method, params = {}, key = null, {maxItems = Infinity, onPage} = {}) {
    this._guard(method);
    const trace = this._trace(method);
    return new Promise((resolve, reject) => {
      const items = [];
      let pages = 0;
      let lastOffset = Number(params.start ?? 0);
      let settled = false;
      let timer;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._finishTrace(trace, error);
        error ? reject(error) : resolve(items);
      };
      const armTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const error = new Error(`Bitrix24: ${method} — время ожидания страницы истекло. Скопируйте диагностику из настроек.`);
          error.code = 'REQUEST_TIMEOUT';
          finish(error);
        }, this.timeoutMs);
      };
      const consume = result => {
        if (settled) return;
        try {
          if (result.error()) return finish(apiError(method, result));
          const data = result.data();
          let page = key ? data?.[key] : data;
          // Product endpoints use different collection keys across REST versions.
          if (!Array.isArray(page) && /^catalog\.product\.(?:(?:offer|sku)\.)?list$/.test(method)) {
            page = ['products', 'offers', 'skus', 'units'].map(name => data?.[name]).find(Array.isArray);
          }
          // CRM template.list returns templates keyed by ID rather than an array.
          // Keep every other list method's response validation strict.
          if (['crm.documentgenerator.template.list', 'crm.documentgenerator.document.list'].includes(method)
            && page && typeof page === 'object' && !Array.isArray(page)) {
            page = Object.values(page);
          }
          if (!Array.isArray(page)) return finish(new Error(`Bitrix24: ${method} — нет массива ${key ?? 'result'}.`));
          items.push(...page);
          pages += 1;
          trace.pages = pages;
          trace.items = items.length;
          onPage?.(page.length);
          const total = typeof result.total === 'function' ? result.total() : undefined;
          if (Number.isSafeInteger(total) && total >= 0) trace.total_items = total;
          if (items.length > maxItems) {
            return finish(broadSearchError());
          }
          const more = typeof result.more === 'function' ? result.more() : false;
          if (!more) return finish();
          if (!page.length) return finish(new Error(`Bitrix24: ${method} — пустая страница с продолжением.`));
          // The official SDK exposes the server cursor in answer.next. A repeated
          // offset means pagination stalled, not that there are more matching items.
          if (result.answer?.next !== undefined) {
            const offset = Number(result.answer.next);
            if (!Number.isSafeInteger(offset) || offset <= lastOffset) {
              const error = new Error(`Bitrix24: ${method} — повторяется страница списка. Скопируйте диагностику из настроек.`);
              error.code = 'PAGINATION_STALLED';
              return finish(error);
            }
            lastOffset = offset;
            trace.next_offset = offset;
          }
          armTimer();
          if (typeof result.next === 'function') result.next(consume);
          else this.sdk.callMethod(method, { ...params, start: pages * 50 }, consume);
        } catch { finish(new Error(`Bitrix24: ${method} — ошибка чтения страницы SDK.`)); }
      };
      armTimer();
      // BX24.next() adds its own start. A data.start=0 remains in the official
      // SDK's cloned query and overrides that cursor (start=50&start=0).
      // Let the server use its default zero offset on the initial request.
      const firstParams = {...params};
      if (firstParams.start === undefined || Number(firstParams.start) === 0) delete firstParams.start;
      try { this.sdk.callMethod(method, firstParams, consume); }
      catch { finish(new Error(`Bitrix24: ${method} — ошибка транспорта SDK.`)); }
    });
  }

  async _getCatalogs() {
    if (!this._catalogs) {
      this._catalogs = await this._list('catalog.catalog.list', {
        select: ['id', 'iblockId', 'productIblockId', 'skuPropertyId'],
        order: { id: 'ASC' },
      }, 'catalogs');
    }
    return this._catalogs;
  }

  async _getBasePriceType() {
    if (!this._basePriceType) {
      const types = await this._list('catalog.priceType.list', {
        select: ['id', 'name', 'xmlId', 'base'], filter: { base: 'Y' },
      }, 'priceTypes');
      const base = types.filter(type => type.base === 'Y' || type.name === 'BASE' || type.xmlId === 'BASE');
      if (base.length !== 1) throw new Error('Не найден единственный базовый тип цены (base=Y / BASE). Проверьте каталог.');
      this._basePriceType = { ...base[0], id: id(base[0].id, 'ID типа цены') };
    }
    return this._basePriceType;
  }

  _directPrice(raw) {
    const value = raw.price ?? raw.PRICE ?? raw.basePrice;
    if (!['number', 'string'].includes(typeof value) || !String(value).trim()) return null;
    const basePrice = parseNumber(value);
    if (!Number.isFinite(basePrice) || basePrice < 0) return null;
    const code = String(raw.currency ?? raw.CURRENCY_ID ?? raw.currencyId ?? '').toUpperCase();
    return {basePrice, currency: /^[A-Z]{3}$/.test(code) ? code : null, priceMissing: false, priceNote: ''};
  }

  async _prices(productIds) {
    const result = new Map();
    if (!productIds.length) return result;
    // Price permissions and availability must never hide a catalog item.
    let type;
    try { type = await this._getBasePriceType(); } catch { /* Try accessible prices without a type filter. */ }
    let prices;
    try {
      prices = await this._list('catalog.price.list', {
        select: ['id', 'productId', 'catalogGroupId', 'price', 'currency', 'quantityFrom', 'quantityTo'],
        filter: {'@productId': productIds.map(Number), ...(type ? {catalogGroupId: Number(type.id)} : {})},
        order: {id: 'ASC'},
      }, 'prices');
    } catch { return result; }
    for (const productId of productIds) {
      const found = prices.filter(price => String(price.productId ?? price.PRODUCT_ID) === String(productId)
        && (!type || String(price.catalogGroupId ?? price.CATALOG_GROUP_ID) === type.id)
        && !Number(price.quantityFrom ?? price.QUANTITY_FROM) && !Number(price.quantityTo ?? price.QUANTITY_TO));
      // Quantity-dependent or ambiguous prices require the manager's choice.
      if (found.length !== 1) continue;
      const price = this._directPrice(found[0]);
      if (price) result.set(String(productId), price);
    }
    return result;
  }

  _product(raw, price, source, fallbackCurrency = 'RUB') {
    const productId = id(raw.id ?? raw.ID, 'ID товара');
    const name = String(raw.name ?? raw.NAME ?? '').trim() || `Товар #${productId}`;
    const indexed = this._catalogRaw.get(productId);
    const type = Number(raw.type ?? raw.TYPE ?? indexed?.raw?.type ?? indexed?.raw?.TYPE);
    const variation = [4, 5].includes(type) || source.startsWith('catalog.product.offer.')
      || indexed?.source === 'catalog.product.offer.list';
    const actualPrice = this._directPrice(raw) ?? price ?? {};
    const priceMissing = actualPrice.basePrice === undefined;
    return {id: productId, name, basePrice: actualPrice.basePrice ?? 0,
      currency: actualPrice.currency || currency(fallbackCurrency), priceMissing,
      priceNote: priceMissing ? 'Цена не указана — менеджер введёт её самостоятельно.' : '',
      verified: true, source, ...(raw.active ?? raw.ACTIVE ? {active: raw.active ?? raw.ACTIVE} : {}),
      ...([3, 6].includes(type) ? {isParent: true} : {}),
      ...(variation ? {isVariation: true, parentProductId: variationParent(raw) || variationParent(indexed?.raw ?? {})} : {})};
  }

  _assertActiveProduct(raw) {
    if (!isInactiveCatalogEntry(raw)) return;
    const productId = id(raw.id ?? raw.ID, 'ID товара');
    const error = new Error(`Товар #${productId} деактивирован в каталоге. Выберите активный товар и обновите каталог.`);
    error.code = 'PRODUCT_INACTIVE'; throw error;
  }

  /** If get methods are unavailable, verify this ID through a fresh active-only list. */
  async _listedActiveProduct(productId, {includeCatalogDetails = false} = {}) {
    const cached = this._catalogRaw.get(productId);
    if (!cached) throw new Error(`Товар #${productId} не подтверждён активным каталогом. Обновите каталог.`);
    const {raw, source} = cached;
    const iblock = Number(raw.iblockId ?? raw.IBLOCK_ID ?? raw.CATALOG_ID);
    let rows;
    if (/^catalog\.product\.(?:(?:offer|sku)\.)?list$/.test(source)) {
      const key = source.includes('.offer.') ? 'offers' : 'products';
      try {
        const params = {
          select: ['id', 'iblockId', 'iblockSectionId', 'name', 'type', 'active', ...(source.includes('.offer.') ? ['parentId'] : []), ...(includeCatalogDetails && iblock === NAVIGATION_IBLOCK_ID ? navigationFields() : [])],
          filter: {id: Number(productId), active: 'Y', ...(iblock > 0 ? {iblockId: iblock} : {})},
        };
        try {rows = await this._list(source, params, key);}
        catch (error) {
          if (!params.select.some(field => field.startsWith('property'))) throw error;
          rows = await this._list(source, {...params, select: params.select.filter(field => !field.startsWith('property'))}, key);
        }
      } catch (error) {if (!unavailable(error)) throw error;}
      if (rows) {
        const found = rows.find(item => String(item.id ?? item.ID) === productId);
        if (found) {this._assertActiveProduct(found); return {raw: found, source};}
        throw Object.assign(new Error(`Товар #${productId} не найден среди активных. Обновите каталог и выберите другой товар.`), {code: 'PRODUCT_UNAVAILABLE'});
      }
    }
    rows = await this._list('crm.product.list', {
      select: ['ID', 'NAME', 'PRICE', 'CURRENCY_ID', 'CATALOG_ID', 'SECTION_ID', 'ACTIVE', ...(includeCatalogDetails && iblock === NAVIGATION_IBLOCK_ID ? navigationFields(false) : [])],
      filter: {ID: Number(productId), ACTIVE: 'Y', ...(iblock > 0 ? {CATALOG_ID: iblock} : {})},
    });
    const found = rows.find(item => String(item.ID ?? item.id) === productId);
    if (!found) throw Object.assign(new Error(`Товар #${productId} не найден среди активных. Обновите каталог и выберите другой товар.`), {code: 'PRODUCT_UNAVAILABLE'});
    this._assertActiveProduct(found);
    return {raw: found, source: 'crm.product.list'};
  }

  async _legacyProduct(productId, fallbackCurrency = 'RUB', includeCatalogDetails = false) {
    const raw = await this.call('crm.product.get', {id: Number(productId)});
    if (String(raw?.ID ?? raw?.id) !== productId) throw new Error('CRM API вернул другой ID товара.');
    this._assertActiveProduct(raw);
    const price = this._directPrice(raw) ?? (await this._prices([productId])).get(productId);
    const product = this._product(raw, price, 'crm.product.get', fallbackCurrency);
    return includeCatalogDetails ? this._withFastenersMetadata(product, raw, 'crm.product.get') : product;
  }

  async _readProduct(productId) {
    let missing = false;
    for (const [method, key] of [
      ['catalog.product.get', 'product'],
      ['catalog.product.offer.get', 'offer'],
      ['catalog.product.sku.get', 'sku'],
    ]) {
      try {
        const data = await this.call(method, { id: Number(productId) });
        const raw = data?.[key] ?? data?.product ?? data?.offer ?? data?.sku;
        if (String(raw?.id ?? raw?.ID) !== productId) {
          throw new Error(`Bitrix24: ${method} — API не подтвердил ID запрошенного товара.`);
        }
        return {raw, source: method};
      } catch (error) {
        if (error.code === 'PRODUCT_NOT_FOUND') missing = true;
        else if (!unavailable(error)) throw error;
      }
    }
    if (missing) {
      const error = new Error(`Товар #${productId} не найден на этом портале. Проверьте ID товара или вариации.`);
      error.code = 'PRODUCT_NOT_FOUND';
      throw error;
    }
    // Let the caller try CRM when modern methods are unavailable.
    return null;
  }

  async getProduct(value, {currency: fallbackCurrency = 'RUB', includeCatalogDetails = false} = {}) {
    const productId = id(value, 'ID товара');
    let found, readError;
    try { found = await this._readProduct(productId); } catch (error) { readError = error; }
    if (!found) {
      try { return await this._legacyProduct(productId, fallbackCurrency, includeCatalogDetails); }
      catch (error) {
        // Some portals implement list but not get for all types. Cached activity
        // may be stale: recheck this ID through a fresh active-only list.
        const recoverable = e => !e || unavailable(e) || ['PRODUCT_NOT_FOUND', 'ACCESS_DENIED',
          'ERROR_ACCESS_DENIED', 'insufficient_scope', '200040300040'].includes(e.code);
        if (['PRODUCT_INACTIVE', 'PRODUCT_UNAVAILABLE'].includes(error.code)) throw error;
        if (!recoverable(readError) || !recoverable(error) || !this._catalogRaw.has(productId)) throw readError ?? error;
        found = await this._listedActiveProduct(productId, {includeCatalogDetails});
      }
    }
    const {raw, source} = found;
    this._assertActiveProduct(raw);
    let price = this._directPrice(raw) ?? (await this._prices([productId])).get(productId);
    if (!price && source !== 'crm.product.get') {
      try {
        const legacy = await this.call('crm.product.get', {id: Number(productId)});
        if (String(legacy?.ID ?? legacy?.id) === productId) {this._assertActiveProduct(legacy); price = this._directPrice(legacy);}
      } catch (error) {if (error.code === 'PRODUCT_INACTIVE') throw error; /* Missing price becomes a marked zero. */ }
    }
    const product = this._product(raw, price, source, fallbackCurrency);
    return includeCatalogDetails ? this._withFastenersMetadata(product, raw, source) : product;
  }

  /** Only selection reads calculation metadata; general verification stays lightweight. */
  async _withFastenersMetadata(product, raw, source) {
    const cached = this._catalogRaw.get(product.id)?.raw;
    const iblock = Number(raw.iblockId ?? raw.IBLOCK_ID ?? raw.CATALOG_ID ?? cached?.iblockId ?? cached?.IBLOCK_ID ?? cached?.CATALOG_ID);
    const hasSection = value => ['iblockSectionId', 'IBLOCK_SECTION_ID', 'SECTION_ID', 'sectionId'].some(key => Object.hasOwn(value, key));
    let details = {...raw, iblockId: iblock}, note = '';
    // Modern get may omit custom properties on older portals. Recheck only the selected ID.
    if (source.startsWith('catalog.') && source.endsWith('.get') && (!hasSection(raw) || (iblock === NAVIGATION_IBLOCK_ID && !hasCatalogProperty(raw, 116)))) {
      try {
        const fresh = cached ? await this._listedActiveProduct(product.id, {includeCatalogDetails: true}) : {raw: await this.call('crm.product.get', {id: Number(product.id)})};
        if (String(fresh.raw?.id ?? fresh.raw?.ID) !== product.id) throw new Error('API не подтвердил ID товара при чтении метизов.');
        this._assertActiveProduct(fresh.raw);
        details = {...fresh.raw, iblockId: fresh.raw.iblockId ?? fresh.raw.IBLOCK_ID ?? fresh.raw.CATALOG_ID ?? iblock};
        if (!hasCatalogProperty(details, 116) && hasCatalogProperty(raw, 116)) {
          details.property116 = {value: catalogNavigation({...raw, iblockId: iblock}).fastenerPrice ?? null};
        }
        if (!hasSection(details) && hasSection(raw)) details.iblockSectionId = catalogSectionId(raw) || 0;
      } catch (error) {
        if (['PRODUCT_INACTIVE', 'PRODUCT_UNAVAILABLE'].includes(error.code)) throw error;
        note = 'Не удалось обновить часть свойств товара. Проверьте стоимость метиз.';
      }
    }
    if (iblock === NAVIGATION_IBLOCK_ID && !hasCatalogProperty(details, 116) && Number.isFinite(catalogNavigation({...cached, iblockId: iblock}).fastenerPrice)) {
      try {
        const rows = await this._list('crm.product.list', {
          select: ['ID', 'CATALOG_ID', 'SECTION_ID', 'ACTIVE', 'PROPERTY_116'],
          filter: {ID: Number(product.id), CATALOG_ID: iblock, ACTIVE: 'Y'},
        });
        const fresh = rows.find(row => String(row.ID ?? row.id) === product.id);
        if (fresh) {
          this._assertActiveProduct(fresh);
          details.property116 = {value: catalogNavigation({...fresh, iblockId: iblock}).fastenerPrice ?? null};
          if (!hasSection(details) && hasSection(fresh)) details.iblockSectionId = catalogSectionId(fresh) || 0;
        }
      } catch (error) {if (error.code === 'PRODUCT_INACTIVE') throw error;}
    }
    const sectionId = catalogSectionId(details) || (!hasSection(details) && cached ? catalogSectionId(cached) : '');
    let support = Number(details.iblockId) === NAVIGATION_IBLOCK_ID && SUPPORT_SECTION_IDS.includes(Number(sectionId));
    // Offers without an own section can use the confirmed parent's section, never its price.
    if (!sectionId && product.isVariation && product.parentProductId) {
      const parent = this._catalogRaw.get(product.parentProductId)?.raw;
      if (parent && Number(parent.iblockId ?? parent.IBLOCK_ID ?? parent.CATALOG_ID) === NAVIGATION_IBLOCK_ID) {
        support = SUPPORT_SECTION_IDS.includes(Number(catalogSectionId(parent)));
      }
    }
    if (!hasSection(details) && !support) note ||= 'Раздел товара не получен: метизы по умолчанию выключены. При необходимости включите их вручную.';
    const value = catalogNavigation(details).fastenerPrice;
    const price = Number.isFinite(value) && product.currency === 'RUB' ? value : null;
    if (Number.isFinite(value) && product.currency !== 'RUB') note = 'Свойство 116 указано в рублях. Укажите стоимость метиз в валюте КП; автоматической конвертации нет.';
    return {...product, sectionId, isSupportSection: support, fastenerUnitPrice: price, fastenersNote: note};
  }

  /** Full metadata index; prices are verified separately for the selected ID. */
  async listCatalogEntries({refresh = false, onProgress} = {}) {
    if (refresh && !this._catalogEntryLoad) {
      this._catalogEntries = null; this._catalogs = null; this._basePriceType = null; this._catalogRaw.clear();
    }
    if (this._catalogEntries) return this._catalogEntries.map(entry => ({...entry}));
    if (!this._catalogEntryLoad) {
      this._catalogEntryLoad = this._readCatalogEntries(onProgress);
    }
    const pending = this._catalogEntryLoad;
    try {
      this._catalogEntries = await pending;
      return this._catalogEntries.map(entry => ({...entry}));
    } finally {
      if (this._catalogEntryLoad === pending) this._catalogEntryLoad = null;
    }
  }

  async _readCatalogEntries(onProgress) {
    const products = new Map(), parents = new Map(), failures = [];
    this.catalogWarnings = [];
    let count = 0, successfulLists = 0;
    const onPage = size => {count += size; onProgress?.(count);};
    const collect = (rows, source) => {
      for (const raw of rows) {
        const productId = id(raw.id ?? raw.ID, 'ID товара');
        if (isInactiveCatalogEntry(raw)) {
          products.delete(productId); parents.delete(productId); this._catalogRaw.delete(productId); continue;
        }
        if ([3, 6].includes(Number(raw.type ?? raw.TYPE)) || source === 'catalog.product.sku.list') parents.set(productId, raw);
        this._catalogRaw.set(productId, {raw, source});
        products.set(productId, {...this._product(raw, null, source), navigation: catalogNavigation(raw), verified: false});
      }
    };
    const propertyFallbacks = new Set();
    const read = async (method, params, key) => {
      try {
        const rows = await this._list(method, params, key, {onPage});
        collect(rows, method); successfulLists++;
        return true;
      } catch (error) {
        // An older portal may reject custom fields in modern select. Keep products visible.
        if (params.select.some(field => field.startsWith('property'))) {
          try {
            collect(await this._list(method, {...params, select: params.select.filter(field => !field.startsWith('property'))}, key, {onPage}), method);
            propertyFallbacks.add(NAVIGATION_IBLOCK_ID); successfulLists++; return true;
          } catch (basicError) {failures.push(basicError); return false;}
        }
        failures.push(error); return false;
      }
    };
    let catalogs = [];
    try { catalogs = await this._getCatalogs(); } catch (error) {failures.push(error);}
    for (const catalog of catalogs) {
      const iblockId = Number(id(catalog.iblockId ?? catalog.id, 'ID инфоблока'));
      const params = {select: ['id', 'iblockId', 'iblockSectionId', 'name', 'type', 'active', ...(iblockId === NAVIGATION_IBLOCK_ID ? navigationFields() : [])],
        filter: {iblockId, active: 'Y'}, order: {name: 'ASC', id: 'ASC'}};
      // Request active goods, services, SKU parents and offers only.
      if (Number(catalog.productIblockId) > 0) {
        const ok = await read('catalog.product.offer.list', {...params, select: [...params.select, 'parentId']}, 'offers');
        if (!ok) await read('catalog.product.list', params, 'products');
      } else {
        await read('catalog.product.list', params, 'products');
        await read('catalog.product.sku.list', params, 'products');
      }
    }
    const navigationRows = [...this._catalogRaw.values()].map(item => item.raw)
      .filter(raw => Number(raw.iblockId ?? raw.IBLOCK_ID) === NAVIGATION_IBLOCK_ID);
    if (navigationRows.length && !navigationRows.some(raw =>
      [...navigationFields(), ...navigationFields(false)].some(field => Object.hasOwn(raw, field)))) {
      propertyFallbacks.add(NAVIGATION_IBLOCK_ID);
    }
    // Use the CRM catalog interface when modern endpoints are incomplete or unavailable.
    if (!products.size || failures.length || propertyFallbacks.size) {
      let legacyCatalogs = [];
      try { legacyCatalogs = await this._list('crm.catalog.list'); } catch (error) {failures.push(error);}
      for (const catalog of legacyCatalogs) {
        const legacyId = Number(id(catalog.ID ?? catalog.id, 'ID каталога'));
        if (products.size && !failures.length && propertyFallbacks.size && !propertyFallbacks.has(legacyId)) continue;
        try {
          const rows = await this._list('crm.product.list', {
            select: ['ID', 'NAME', 'PRICE', 'CURRENCY_ID', 'CATALOG_ID', 'SECTION_ID', 'ACTIVE', ...(legacyId === NAVIGATION_IBLOCK_ID ? navigationFields(false) : [])],
            filter: {CATALOG_ID: Number(id(catalog.ID ?? catalog.id, 'ID каталога')), ACTIVE: 'Y'},
            order: {NAME: 'ASC', ID: 'ASC'},
          }, null, {onPage});
          successfulLists++;
          // Preserve richer modern metadata for duplicates; retain a returned CRM price.
          for (const raw of rows) {
            const productId = id(raw.ID ?? raw.id, 'ID товара');
            const previous = this._catalogRaw.get(productId);
            const merged = previous ? {...raw, ...previous.raw} : raw;
            merged.CATALOG_ID ??= legacyId;
            collect([merged], previous?.source ?? 'crm.product.list');
          }
        } catch (error) {failures.push(error);}
      }
    }
    if (!products.size && failures.length && !successfulLists) throw failures[0];
    if (failures.some(error => !unavailable(error))) {
      this.catalogWarnings.push('Часть методов каталога недоступна. Показаны полученные товары; проверьте права приложения и сотрудника, если нужной позиции нет.');
    }
    if (propertyFallbacks.size && ![...products.values()].some(entry => Object.keys(entry.navigation).length)) {
      this.catalogWarnings.push('Характеристики каталога 24 не получены: проверьте заполнение свойств 108–124 и права чтения каталога.');
    }
    for (const entry of products.values()) {
      const parent = parents.get(entry.parentProductId);
      if (parent) entry.parentProductName = String(parent.name ?? parent.NAME ?? '');
    }
    return [...products.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru') || Number(a.id) - Number(b.id));
  }

  /** Display prices for visible catalog rows in one batch; selection still verifies get. */
  async getCatalogPrices(values, {currency: fallbackCurrency = 'RUB'} = {}) {
    const ids = [...new Set(values.map(value => id(value, 'ID товара')))];
    if (ids.length > 50) throw new Error('За один запрос допускается до 50 цен.');
    const missing = ids.filter(value => !this._directPrice(this._catalogRaw.get(value)?.raw ?? {}));
    const prices = await this._prices(missing);
    return ids.map(value => {
      const found = this._catalogRaw.get(value);
      if (!found) return {id: value, basePrice: 0, currency: currency(fallbackCurrency), priceMissing: true};
      const product = this._product(found.raw, prices.get(value), found.source, fallbackCurrency);
      return {id: value, basePrice: product.basePrice, currency: product.currency, priceMissing: product.priceMissing};
    });
  }

  async searchProducts(query = '', {by = 'auto', currency: fallbackCurrency = 'RUB'} = {}) {
    const entries = await this.listCatalogEntries();
    const matches = filterCatalogEntries(entries, query, by);
    const output = [];
    for (let offset = 0; offset < matches.length; offset += 50) {
      const chunk = matches.slice(offset, offset + 50);
      const prices = await this._prices(chunk.map(entry => entry.id));
      for (const entry of chunk) {
        const found = this._catalogRaw.get(entry.id);
        output.push({...entry, ...this._product(found.raw, prices.get(entry.id), found.source, fallbackCurrency)});
      }
    }
    return output;
  }

  /** Write only the configured delivery field; never change product rows here. */
  async saveDeliveryCost(dealValue, fieldCode, amount, quoteCurrency) {
    const dealId = id(dealValue, 'ID сделки');
    if (typeof fieldCode !== 'string' || !/^UF_CRM_[A-Z0-9_]+$/.test(fieldCode)) {
      throw new Error('Укажите код пользовательского поля сделки вида UF_CRM_1793088425948.');
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER / 100) {
      throw new Error('Стоимость доставки должна быть неотрицательным числом в допустимом диапазоне.');
    }
    const cost = Math.round(amount * 100) / 100;
    const fields = await this.call('crm.deal.fields');
    const field = fields?.[fieldCode];
    const enabled = value => [true, 1, '1', 'Y', 'true'].includes(value);
    if (!field || field.type !== 'double' || enabled(field.isReadOnly) || enabled(field.isImmutable) || enabled(field.isMultiple)) {
      throw new Error('Поле доставки не найдено или недоступно для записи. Нужно одиночное числовое поле типа double.');
    }
    const before = await this.call('crm.deal.get', {id: Number(dealId)});
    if (String(before?.ID) !== dealId || currency(before.CURRENCY_ID) !== currency(quoteCurrency)) {
      throw new Error('Не подтверждены сделка или соответствие валюты расчёта валюте сделки.');
    }
    try {
      const saved = await this.call('crm.deal.update', {id: Number(dealId), fields: {[fieldCode]: cost}});
      if (saved !== true) throw new Error('Bitrix24 не подтвердил запись поля доставки.');
    } catch (error) {
      if (error.code === 'REQUEST_TIMEOUT') {
        throw new Error('Ответ на запись доставки не получен. Поле могло обновиться: проверьте сделку перед повтором. Автоматического повтора нет.');
      }
      throw error;
    }
    let after;
    try { after = await this.call('crm.deal.get', {id: Number(dealId)}); }
    catch { throw new Error('Запись доставки подтверждена, но повторное чтение не удалось. Проверьте поле сделки перед повтором.'); }
    const actual = after?.[fieldCode];
    if (String(after?.ID) !== dealId || currency(after.CURRENCY_ID) !== currency(quoteCurrency)
      || !['number', 'string'].includes(typeof actual) || !String(actual).trim()
      || !Number.isFinite(parseNumber(actual)) || Math.abs(parseNumber(actual) - cost) > 0.000001) {
      throw new Error('Поле записано, но значение при повторном чтении отличается. Проверьте поле и автоматизацию сделки; повторная запись не выполнялась.');
    }
    return {dealId, fieldCode, cost, verified: true};
  }

  async loadDeal(value, {deliveryAddressFieldCode = DELIVERY_ADDRESS_FIELD, paymentFieldCode = PAYMENT_FIELD, deliveryModeFieldCode = DELIVERY_MODE_FIELD} = {}) {
    const dealId = id(value, 'ID сделки');
    if (deliveryAddressFieldCode && (typeof deliveryAddressFieldCode !== 'string' || !/^UF_CRM_[A-Z0-9_]+$/.test(deliveryAddressFieldCode))) throw new Error('Укажите код поля адреса вида UF_CRM_1793089347287.');
    if (paymentFieldCode && (typeof paymentFieldCode !== 'string' || !/^UF_CRM_[A-Z0-9_]+$/.test(paymentFieldCode))) throw new Error('Укажите код поля варианта оплаты вида UF_CRM_1793090584810.');
    if (deliveryModeFieldCode && (typeof deliveryModeFieldCode !== 'string' || !/^UF_CRM_[A-Z0-9_]+$/.test(deliveryModeFieldCode))) throw new Error('Укажите код поля вида доставки вида UF_CRM_1793093018394.');
    const [deal, rawRows] = await Promise.all([
      this.call('crm.deal.get', { id: Number(dealId) }),
      this.call('crm.deal.productrows.get', { id: Number(dealId) }),
    ]);
    if (String(deal?.ID) !== dealId || !Array.isArray(rawRows)) throw new Error('API вернул некорректную сделку или её товары.');
    const dealCurrency = currency(deal.CURRENCY_ID);
    let companyName = '';
    if (Number(deal.COMPANY_ID) > 0) {
      const company = await this.call('crm.company.get', { id: Number(deal.COMPANY_ID) });
      companyName = String(company.TITLE ?? '');
    } else if (Number(deal.CONTACT_ID) > 0) {
      const contact = await this.call('crm.contact.get', { id: Number(deal.CONTACT_ID) });
      companyName = [contact.LAST_NAME, contact.NAME, contact.SECOND_NAME].filter(Boolean).join(' ');
    }
    const rows = [...rawRows].sort((a, b) => Number(a.SORT ?? 0) - Number(b.SORT ?? 0)).map(row => ({
      id: String(row.ID ?? ''), productId: String(row.PRODUCT_ID ?? '0'),
      productName: String(row.PRODUCT_NAME ?? ''), basePrice: number(row.PRICE, 'Цена позиции сделки'),
      unitPrice: number(row.PRICE, 'Цена позиции сделки'), quantity: number(row.QUANTITY, 'Количество позиции сделки'),
      taxRate: number(row.TAX_RATE ?? 0, 'Ставка НДС позиции сделки'), taxIncluded: String(row.TAX_INCLUDED ?? 'Y'),
      currency: dealCurrency, source: 'deal', raw: { ...row },
    }));
    return { id: dealId, title: String(deal.TITLE ?? ''), companyName, currency: dealCurrency, rows, deliveryModeIds: deliveryModeFieldCode ? deliveryModeIds(deal[deliveryModeFieldCode]) : [], paymentIds: paymentFieldCode ? paymentIds(deal[paymentFieldCode]) : [], deliveryAddress: deliveryAddressFieldCode ? deliveryAddressText(deal[deliveryAddressFieldCode]) : '' };
  }

  async _documentDeal(value) {
    const dealId = id(value, 'ID сделки');
    const deal = await this.call('crm.deal.get', { id: Number(dealId) });
    // The document generator itself does not verify that its source deal exists.
    if (String(deal?.ID) !== dealId) throw new Error('Bitrix24 не подтвердил существование выбранной сделки.');
    const categoryText = String(deal.CATEGORY_ID ?? '').trim();
    const categoryId = Number(categoryText);
    if (!/^\d+$/.test(categoryText) || !Number.isSafeInteger(categoryId) || categoryId < 0) {
      throw new Error('Bitrix24 не вернул корректное направление сделки для выбора шаблона.');
    }
    return { id: dealId, categoryId: String(categoryId), currency: currency(deal.CURRENCY_ID) };
  }

  /** Read only the current deal owner's signature; never use the creator or mobile phone. */
  async getResponsibleManager(value) {
    const dealId = id(value, 'ID сделки');
    const deal = await this.call('crm.deal.get', {id: Number(dealId)});
    if (String(deal?.ID) !== dealId) throw new Error('Bitrix24 не подтвердил выбранную сделку.');
    const userId = id(deal.ASSIGNED_BY_ID, 'ID ответственного за сделку');
    const users = await this.call('user.get', {
      FILTER: {ID: Number(userId)}, select: ['ID', 'NAME', 'SECOND_NAME', 'LAST_NAME', 'WORK_POSITION', 'WORK_PHONE', 'EMAIL'],
    });
    if (!Array.isArray(users) || users.length !== 1 || String(users[0]?.ID) !== userId) {
      throw new Error('Bitrix24 не вернул профиль ответственного за сделку. Заполните подпись вручную.');
    }
    const user = users[0];
    const text = key => documentText(user[key], `Профиль сотрудника: ${key}`).trim();
    const profile = {dealId, userId, name: [text('LAST_NAME'), text('NAME'), text('SECOND_NAME')].filter(Boolean).join(' '),
      position: text('WORK_POSITION'), workPhone: text('WORK_PHONE'), email: text('EMAIL'),
      phoneAvailable: Object.hasOwn(user, 'WORK_PHONE'), signatureReference: null, signatureUrl: '', signatureError: ''};
    try {
      profile.signatureReference = await this.getManagerSignature(userId);
      profile.signatureUrl = await this.resolveManagerSignature(profile.signatureReference);
    } catch { profile.signatureError = 'Не удалось загрузить изображение подписи. Проверьте настройку и доступ к файлу.'; }
    return profile;
  }

  async getManagerSignature(userValue) {
    const userId = id(userValue, 'ID сотрудника');
    const value = await this.call('app.option.get', {option: `yuzmManagerSignature_${userId}`});
    if (value === null || value === undefined || value === '') return null;
    let reference;
    try { reference = typeof value === 'string' ? JSON.parse(value) : value; }
    catch { throw new Error('Некорректная настройка подписи сотрудника.'); }
    return signatureReference(reference);
  }

  async setManagerSignature(userValue, value) {
    if (!this.canManageSettings()) throw new Error('Общую подпись сотрудника может настроить администратор приложения.');
    const userId = id(userValue, 'ID сотрудника');
    const reference = signatureReference(value);
    if (reference && reference.kind !== 'disk') throw new Error('Для подписи укажите ID изображения на Диске Битрикс24.');
    // Resolve before saving so an inaccessible Disk ID cannot replace a working setting.
    if (reference) await this.resolveManagerSignature(reference);
    const encoded = reference ? JSON.stringify(reference) : '';
    const saved = await this.call('app.option.set', {options: {[`yuzmManagerSignature_${userId}`]: encoded}});
    if (saved !== true) throw new Error('Битрикс24 не подтвердил сохранение подписи.');
    const actual = await this.getManagerSignature(userId);
    if (JSON.stringify(actual) !== JSON.stringify(reference)) throw new Error('Настройка подписи изменилась при сохранении. Обновите данные ответственного.');
    return actual;
  }

  async resolveManagerSignature(value) {
    const reference = signatureReference(value);
    if (!reference) return '';
    if (reference.kind === 'url') return reference.url;
    const file = await this.call('disk.file.get', {id: Number(reference.fileId)});
    if (String(file?.ID) !== reference.fileId || (file.TYPE && file.TYPE !== 'file')) throw new Error('Не подтверждён файл подписи на Диске.');
    if (!/\.(png|jpe?g)$/i.test(String(file.NAME ?? ''))) throw new Error('Подпись должна быть изображением PNG или JPEG.');
    if (Number(file.SIZE) > 2 * 1024 * 1024) throw new Error('Изображение подписи превышает 2 МБ.');
    if (!file.DOWNLOAD_URL) throw new Error('Диск не вернул ссылку на изображение подписи.');
    // Request a current download URL instead of storing expiring Disk URLs in options.
    return signatureReference(this._documentUrl(file.DOWNLOAD_URL)).url;
  }

  async listDocumentTemplates(dealValue) {
    const deal = await this._documentDeal(dealValue);
    const templates = await this._list('crm.documentgenerator.template.list', {
      select: ['id', 'name', 'active', 'isDeleted', 'entityTypeId'],
      filter: { active: 'Y', isDeleted: 'N', entityTypeId: ['2', `2_category_${deal.categoryId}`] },
      order: { name: 'ASC', id: 'ASC' },
    }, 'templates');
    const available = templates.map(raw => documentTemplate(raw, deal.categoryId)).filter(template => template.available);
    return [...new Map(available.map(({ id, name }) => [id, { id, name }])).values()];
  }

  _documentUrl(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string') throw new Error('Bitrix24 вернул некорректную ссылку документа.');
    let portalBase;
    try {
      const domain = this.sdk?.getDomain?.();
      if (typeof domain === 'string' && domain) portalBase = /^https?:\/\//i.test(domain) ? domain : `https://${domain}/`;
    } catch { /* Absolute URLs do not need the portal domain. */ }
    let url;
    try { url = new URL(value, portalBase ?? this.location?.href); }
    catch { throw new Error('Bitrix24 вернул некорректную ссылку документа.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Bitrix24 вернул недопустимую ссылку документа.');
    }
    return url.href;
  }

  _document(raw, expected = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Bitrix24 не вернул созданный документ.');
    const documentId = id(raw.id, 'ID документа');
    if (expected.id && documentId !== expected.id) throw new Error('Bitrix24 вернул другой ID документа.');
    for (const field of ['templateId', 'entityId', 'entityTypeId']) {
      if (expected[field] !== undefined && raw[field] !== undefined && String(raw[field]) !== String(expected[field])) {
        throw new Error('Bitrix24 вернул документ другого шаблона или сделки.');
      }
    }
    return {
      id: documentId,
      title: documentText(raw.title, 'Название документа'),
      templateId: String(raw.templateId ?? ''), createdAt: String(raw.createTime ?? ''), number: String(raw.number ?? ''),
      downloadUrl: this._documentUrl(raw.downloadUrl),
      pdfUrl: this._documentUrl(raw.pdfUrl),
      publicUrl: this._documentUrl(raw.publicUrl),
      conversionError: [true, 1, '1', 'Y'].includes(raw.isTransformationError),
    };
  }

  async createQuoteDocument(dealValue, templateValue, snapshot, expectedFingerprint, {onProgress = () => {}} = {}) {
    onProgress('Проверяю данные КП, ответственного и доступность шаблона…');
    const dealId = id(dealValue, 'ID сделки');
    const templateId = id(templateValue, 'ID шаблона');
    if (!snapshot || String(snapshot.dealId) !== dealId) throw new Error('Расчёт КП относится к другой сделке.');
    if (snapshot.valid === false || (Array.isArray(snapshot.errors) && snapshot.errors.length)
      || !Array.isArray(snapshot.rows) || !snapshot.rows.length) {
      throw new Error('Нет корректных позиций для создания документа.');
    }
    const quoteCurrency = currency(snapshot.currency ?? snapshot.config?.currency);
    const companyName = documentText(snapshot.companyName, 'Наименование компании', true);
    const total = documentMoney(snapshot.total, 'Итого КП');
    let rowCents = 0;
    const items = snapshot.rows.map((row, index) => {
      if (!row || typeof row !== 'object' || row.valid === false || (Array.isArray(row.errors) && row.errors.length)) {
        throw new Error(`Позиция ${index + 1}: исправьте ошибки расчёта.`);
      }
      if (currency(row.currency ?? quoteCurrency) !== quoteCurrency) throw new Error('В КП смешаны валюты.');
      const quantity = parseNumber(row.quantity);
      if (!Number.isFinite(quantity)) throw new Error('Количество: требуется конечное число.');
      if (quantity <= 0) throw new Error('Количество должно быть положительным.');
      const price = documentMoney(row.unitPrice, 'Цена единицы');
      const lineTotal = documentMoney(row.lineTotal, 'Сумма строки');
      rowCents += Math.round(lineTotal * 100);
      if (!Number.isSafeInteger(rowCents)) throw new Error('Итого КП превышает допустимый диапазон.');
      const coating = snapshot.config?.coatings?.find(entry => entry.code === row.coatingCode);
      return {
        Name: documentText(row.productName, `Наименование позиции ${index + 1}`, true),
        Coating: documentText(formatCoating(coating || {code: row.coatingCode, name: row.coatingName || row.coatingCode || ''}, row.ralColor, row.customCoating), 'Покрытие'),
        Quantity: String(quantity).replace('.', ','),
        Price: DOCUMENT_MONEY.format(price),
        Total: DOCUMENT_MONEY.format(lineTotal),
        ExecutionTerm: documentText(formatExecutionTerm(row.executionTerm), 'Срок исполнения'),
      };
    });
    if (rowCents !== Math.round(total * 100)) throw new Error('Итого КП отличается от суммы товарных строк.');
    const fields = {
      KpItems: {
        PROVIDER: 'Bitrix\\DocumentGenerator\\DataProvider\\ArrayDataProvider',
        OPTIONS: { ITEM_NAME: 'Item', ITEM_PROVIDER: 'Bitrix\\DocumentGenerator\\DataProvider\\HashDataProvider' },
      },
    };
    // Replace standard CRM descriptors too: their Money/provider metadata must
    // not format these iterator chains before the DOCX table is expanded.
    for (const [placeholder, chain] of Object.entries(DOCUMENT_ITEM_FIELDS)) fields[placeholder] = { VALUE: chain };
    fields.RequisiteRqCompanyName = { VALUE: companyName };
    fields.TotalSum = { VALUE: DOCUMENT_MONEY.format(total) };
    for (const placeholder of DOCUMENT_FIELDS) {
      fields[placeholder] = { VALUE: documentText(snapshot.documentFields?.[placeholder], placeholder) };
    }
    // The supplied DOCX places position and name directly next to each other.
    // Keep saved text unchanged and separate the two values in the document.
    if (fields.YuzmManagerPosition.VALUE.trim() && fields.YuzmManagerName.VALUE.trim()
      && !/\s$/.test(fields.YuzmManagerPosition.VALUE)) fields.YuzmManagerPosition.VALUE += ' ';
    const deal = await this._documentDeal(dealId);
    if (deal.currency !== quoteCurrency) throw new Error('Валюта сделки отличается от валюты КП.');
    let signatureUrl = '';
    if (snapshot.managerSignatureReference && !snapshot.managerUserId) throw new Error('Подпись не привязана к ответственному. Подставьте данные ответственного и заново откройте предпросмотр КП.');
    if (snapshot.managerUserId) {
      const current = await this.call('crm.deal.get', {id: Number(dealId)});
      if (String(current?.ID) !== dealId || String(current.ASSIGNED_BY_ID) !== id(snapshot.managerUserId, 'ID менеджера расчёта')) {
        throw new Error('Ответственный за сделку изменился. Подставьте его данные и заново откройте предпросмотр КП перед созданием документа.');
      }
      signatureUrl = await this.resolveManagerSignature(snapshot.managerSignatureReference);
    }
    fields.YuzmManagerSignature = {TYPE: 'STAMP'};
    const response = await this.call('crm.documentgenerator.template.get', { id: Number(templateId) });
    const template = documentTemplate(response?.template, deal.categoryId);
    if (template.id !== templateId || !template.available) throw new Error('Выбранный шаблон удалён, неактивен или недоступен для направления этой сделки.');
    // Validate the complete document and template before changing CRM. The
    // document and the mandatory replacement use the very same saved version.
    await this.applyToDeal(dealId, snapshot, expectedFingerprint, {onProgress});
    const goodsTransferred = true;
    let created;
    try {
      onProgress('Товары и доставка сохранены. Отправляю запрос на создание документа в Битрикс24…');
      created = await this.call('crm.documentgenerator.document.add', {
        templateId: Number(templateId), entityTypeId: 2, entityId: Number(dealId),
        values: { KpItems: items, YuzmManagerSignature: signatureUrl }, fields, stampsEnabled: 1,
      });
    } catch (error) {
      error.goodsTransferred = goodsTransferred;
      throw error;
    }
    try {
      return this._document(created?.document, { templateId, entityId: dealId, entityTypeId: '2' });
    } catch (error) {
      let documentId;
      try { documentId = id(created?.document?.id, 'ID документа'); } catch { error.goodsTransferred = goodsTransferred; throw error; }
      const unverified = new Error(`Bitrix24 вернул документ #${documentId}, но его данные или ссылки не подтверждены. Проверьте документ перед повторным созданием.`);
      unverified.code = 'DOCUMENT_RESPONSE_UNVERIFIED';
      unverified.documentId = documentId;
      throw unverified;
    }
  }

  async listQuoteDocuments(value) {
    const dealId = id(value, 'ID сделки');
    const rows = await this._list('crm.documentgenerator.document.list', {
      select: ['*'], filter: {entityTypeId: 2, entityId: Number(dealId)}, order: {id: 'DESC'},
    }, 'documents');
    const result = new Map();
    for (const raw of rows) {
      if (String(raw.entityId) !== dealId || (raw.entityTypeId !== undefined && String(raw.entityTypeId) !== '2')) continue;
      const doc = this._document(raw, {entityId: dealId, entityTypeId: '2'});
      result.set(doc.id, doc);
    }
    return [...result.values()].sort((a, b) => Number(b.id) - Number(a.id));
  }

  async getQuoteDocument(value, {dealId} = {}) {
    const documentId = id(value, 'ID документа');
    const response = await this.call('crm.documentgenerator.document.get', {id: Number(documentId)});
    return this._document(response?.document, {id: documentId,
      ...(dealId ? {entityId: id(dealId, 'ID сделки'), entityTypeId: '2'} : {})});
  }

  async registerPlacement(title = 'Конструктор КП') {
    let handler;
    try { handler = new URL(this.handlerUrl ?? `${this.location.origin}${this.location.pathname}`); }
    catch { throw new Error('Задайте HTTPS-адрес обработчика вкладки.'); }
    if (handler.protocol !== 'https:' || !handler.hostname.includes('.') || handler.username || handler.password) {
      throw new Error('Обработчик вкладки должен иметь HTTPS-адрес с доменным именем.');
    }
    handler.search = ''; handler.hash = '';
    const bindings = await this.call('placement.get');
    if (!Array.isArray(bindings)) throw new Error('API не вернул список зарегистрированных вкладок.');
    if (bindings.some(binding => binding.placement === 'CRM_DEAL_DETAIL_TAB' && binding.handler === handler.href)) {
      return { registered: true, existing: true, handler: handler.href };
    }
    return this.call('placement.bind', {
      PLACEMENT: 'CRM_DEAL_DETAIL_TAB', HANDLER: handler.href,
      TITLE: String(title), LANG_ALL: { ru: { TITLE: String(title) } },
    });
  }

  async applyToDeal(dealValue, snapshot, expectedFingerprint, {onProgress = () => {}} = {}) {
    const dealId = id(dealValue, 'ID сделки');
    if (String(snapshot.dealId) !== dealId) throw new Error('Расчёт относится к другой сделке.');
    if (!Array.isArray(snapshot.rows) || !snapshot.rows.length || snapshot.valid === false) throw new Error('Нет корректных позиций для применения.');
    const quoteCurrency = currency(snapshot.currency ?? snapshot.config?.currency);
    if (snapshot.deliveryFieldCode && (!/^UF_CRM_[A-Z0-9_]+$/.test(snapshot.deliveryFieldCode)
      || typeof snapshot.deliveryTotal !== 'number' || !Number.isFinite(snapshot.deliveryTotal)
      || snapshot.deliveryTotal < 0 || snapshot.deliveryTotal > Number.MAX_SAFE_INTEGER / 100)) {
      throw new Error('Некорректны код поля или сумма доставки. Обновите настройки и предпросмотр КП.');
    }
    const requested = snapshot.rows.map((row, index) => {
      const custom = isCustomRow(row);
      const productId = custom ? null : id(row.productId, 'ID товара');
      const productName = String(row.productName ?? '');
      if (custom && (!productName.trim() || productName.length > 250 || /[\u0000-\u001f\u007f]/.test(productName))) throw new Error('Введите наименование произвольной позиции до 250 символов.');
      const price = number(row.unitPrice, 'Цена единицы');
      const quantity = parseNumber(row.quantity);
      if (!Number.isFinite(quantity)) throw new Error('Количество: требуется конечное число.');
      const taxRate = number(row.taxRate ?? row.raw?.TAX_RATE ?? 0, 'Ставка НДС');
      const taxIncluded = String(row.taxIncluded ?? row.raw?.TAX_INCLUDED ?? 'Y');
      if (taxRate < 0 || taxRate > 100 || !['Y', 'N'].includes(taxIncluded)) throw new Error('Некорректная ставка НДС или признак включения налога в цену.');
      if (price < 0) throw new Error('Отрицательная цена допустима в модели, но не для записи в CRM.');
      if (quantity <= 0) throw new Error('Количество должно быть положительным.');
      if (currency(row.currency ?? quoteCurrency) !== quoteCurrency) throw new Error('В КП смешаны валюты.');
      return { ...(custom ? {} : {productId: Number(productId)}), productName, price, quantity,
        discountTypeId: 2, discountRate: 0, discountSum: 0, taxRate, taxIncluded, sort: (index + 1) * 10 };
    });
    const unitTotal = Math.round(requested.reduce((sum, row) => sum + Math.round(row.price * row.quantity * 100) / 100, 0) * 100) / 100;
    if (snapshot.total !== undefined && Math.abs(number(snapshot.total, 'Итого товаров') - unitTotal) > 0.010001) {
      throw new Error('Итого КП отличается от суммы цен единиц × количество. Для переноса в сделку выберите округление цены единицы.');
    }
    onProgress('Проверяю товары каталога и соответствие итоговой суммы…');
    // Verify IDs against the actual catalog; do not rely on demo IDs or a UI flag.
    for (const productId of new Set(requested.filter(row => row.productId !== undefined).map(row => String(row.productId)))) {
      const product = await this.getProduct(productId, {currency: quoteCurrency});
      if (!product.verified || product.currency !== quoteCurrency) throw new Error(`Товар #${productId}: не подтверждены ID или валюта каталога.`);
    }
    // Read immediately before replacing. This catches edits after the confirmation preview.
    // REST has no conditional/transactional comparison API, so a final server-side race remains possible.
    const current = await this.loadDeal(dealId);
    if (current.currency !== quoteCurrency) throw new Error('Валюта сделки отличается от валюты КП. Автоконвертация не выполняется.');
    if (expectedFingerprint === undefined && current.rows.length) throw new Error('Перед заменой существующих товаров нужен предварительный просмотр и подтверждение состава сделки.');
    if (expectedFingerprint !== undefined && expectedFingerprint !== fingerprintRows(current.rows)) {
      throw new Error('Товары сделки изменились после предварительного просмотра. Обновите данные и подтвердите замену ещё раз.');
    }
    onProgress('Сохраняю товарные позиции в сделке…');
    const method = 'crm.item.productrow.set';
    await this.call(method, { ownerType: 'D', ownerId: Number(dealId), productRows: requested });
    onProgress('Товары записаны. Перечитываю и проверяю состав сделки…');
    const saved = await this.loadDeal(dealId);
    const verified = saved.currency === quoteCurrency && saved.rows.length === requested.length
      && saved.rows.every((row, index) => (requested[index].productId === undefined
        ? ['', '0'].includes(String(row.productId ?? '')) && row.productName === requested[index].productName
        : row.productId === String(requested[index].productId))
        && Math.abs(row.unitPrice - requested[index].price) < 0.000001
        && Math.abs(row.quantity - requested[index].quantity) < 0.000001
        && Math.abs(row.taxRate - requested[index].taxRate) < 0.000001
        && row.taxIncluded === requested[index].taxIncluded);
    if (!verified) {
      const error = new Error('Запись выполнена, но состав или цены при повторном чтении отличаются. Проверьте сделку и автоматизацию CRM; повторная запись не выполнялась.');
      error.code = 'WRITE_UNVERIFIED'; throw error;
    }
    if (snapshot.deliveryFieldCode) {
      try {
        onProgress('Товары проверены. Записываю и проверяю общую доставку в поле ' + snapshot.deliveryFieldCode + '…');
        await this.saveDeliveryCost(dealId, snapshot.deliveryFieldCode, snapshot.deliveryTotal, quoteCurrency);
      } catch (error) {
        error.goodsTransferred = true;
        error.message = 'Товары уже сохранены, перенос доставки не подтверждён. ' + error.message;
        throw error;
      }
    }
    return { verified: true, method, dealId, rows: saved.rows, total: unitTotal };
  }
}
