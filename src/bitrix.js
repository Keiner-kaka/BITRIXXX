/* Bitrix24 application transport. No webhook URLs or application secrets are stored here. */
import { parseNumber, formatCoating } from './calculator.js';

const ALLOWED_METHODS = new Set([
  'app.info', 'app.option.get', 'app.option.set', 'user.get',
  'crm.deal.get', 'crm.deal.productrows.get', 'crm.deal.productrows.set',
  'crm.item.productrow.set', 'crm.company.get', 'crm.contact.get',
  'crm.catalog.list', 'crm.product.list', 'crm.product.get',
  'catalog.catalog.list', 'catalog.product.list', 'catalog.product.get',
  'catalog.product.offer.list', 'catalog.product.offer.get',
  'catalog.product.sku.list', 'catalog.product.sku.get',
  'catalog.priceType.list', 'catalog.price.list',
  'crm.documentgenerator.template.list', 'crm.documentgenerator.template.get',
  'crm.documentgenerator.document.add', 'crm.documentgenerator.document.get',
  'disk.file.get', 'disk.folder.getChildren', 'disk.folder.uploadFile',
  'placement.bind', 'placement.get',
]);
// An explicit allowlist prevents retries of writes, document creation or uploads.
const READ_METHODS = new Set([
  'app.info', 'app.option.get', 'user.get',
  'crm.deal.get', 'crm.deal.productrows.get', 'crm.company.get', 'crm.contact.get',
  'crm.catalog.list', 'crm.product.list', 'crm.product.get',
  'catalog.catalog.list', 'catalog.product.list', 'catalog.product.get',
  'catalog.product.offer.list', 'catalog.product.offer.get',
  'catalog.product.sku.list', 'catalog.product.sku.get',
  'catalog.priceType.list', 'catalog.price.list',
  'crm.documentgenerator.template.list', 'crm.documentgenerator.template.get',
  'crm.documentgenerator.document.get', 'disk.file.get', 'disk.folder.getChildren', 'placement.get',
]);
const RETRYABLE_READ_ERRORS = new Set([
  'REQUEST_TIMEOUT', 'NETWORK_ERROR', 'INVALID_RESPONSE', 'QUERY_LIMIT_EXCEEDED',
  'INTERNAL_SERVER_ERROR', 'ERROR_UNEXPECTED_ANSWER', 'HTTP_429',
  'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504',
]);
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const QUOTE_TEMPLATE_OPTION = 'yuzmQuoteTemplateId';
const MAX_SEARCH_ITEMS = 500;
const DOCUMENT_FIELDS = [
  'YuzmPaymentTerms', 'YuzmFastenerTerms', 'YuzmDocumentsTerms', 'YuzmDeliveryTerms',
  'YuzmValidityTerms', 'YuzmManagerPosition', 'YuzmManagerName', 'YuzmManagerPhone',
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
    QUERY_LIMIT_EXCEEDED: 'Превышен лимит запросов Bitrix24. Подождите и повторите запрос.',
    OPERATION_TIME_LIMIT: 'Bitrix24 временно заблокировал метод из-за нагрузки. Повторите запрос позже.',
    OVERLOAD_LIMIT: 'REST API портала заблокирован из-за нагрузки. Обратитесь в поддержку Bitrix24.',
    INTERNAL_SERVER_ERROR: 'Внутренняя ошибка Bitrix24. Повторите запрос позже.',
    ERROR_UNEXPECTED_ANSWER: 'Bitrix24 вернул неожиданный ответ. Повторите запрос позже.',
    expired_token: 'Сессия приложения истекла. Откройте приложение заново внутри Битрикс24.',
    LICENSE_ERROR: 'Битрикс24 ограничил доступ к REST API по лицензии. Проверьте доступность REST на портале.',
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

function transportError(method, code, httpStatus) {
  const hints = {
    REQUEST_TIMEOUT: 'Портал не ответил за отведённое время. Повторите запрос; при повторном сбое скопируйте диагностику из настроек.',
    NETWORK_ERROR: 'Браузер не получил ответ портала. Проверьте соединение и доступ к порталу, затем повторите запрос.',
    INVALID_RESPONSE: 'Портал вернул некорректный ответ. Повторите запрос; при повторном сбое скопируйте диагностику из настроек.',
    AUTH_REFRESH_TIMEOUT: 'Портал не подтвердил обновление сессии. Откройте приложение заново внутри Битрикс24.',
    AUTH_UNAVAILABLE: 'Не удалось получить сессию приложения. Откройте приложение заново внутри Битрикс24.',
    SDK_REQUEST_FAILED: 'Ошибка транспорта SDK. Скопируйте диагностику из настроек.',
  };
  const error = new Error(`Bitrix24: ${method} — ${code}. ${hints[code] ?? 'Портал вернул ошибку HTTP. Повторите запрос; при повторном сбое скопируйте диагностику из настроек.'}`);
  error.code = code;
  error.method = method;
  if (httpStatus) error.httpStatus = httpStatus;
  return error;
}

function restResult(answer) {
  return {
    answer,
    error: () => Object.hasOwn(answer, 'error') ? {getError: () => answer} : false,
    data: () => answer.result,
    total: () => answer.total === undefined ? undefined : Number(answer.total),
    more: () => answer.next !== undefined && answer.next !== null,
  };
}

function appendParams(body, value, prefix) {
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      appendParams(body, item, prefix ? `${prefix}[${key}]` : key);
    }
  } else if (value !== undefined) body.append(prefix, value === null ? '' : String(value));
}

function broadSearchError() {
  const error = new Error('Слишком много совпадений в каталоге. Уточните название или введите ID товара или вариации.');
  error.code = 'CATALOG_SEARCH_TOO_BROAD';
  return error;
}

function variationParent(raw) {
  const value = raw.parentId && typeof raw.parentId === 'object' ? raw.parentId.value : raw.parentId;
  if (value === undefined || value === null || value === '' || String(value) === '0') return '';
  // This relationship is optional metadata. Never invent a parent from an
  // unfamiliar property shape; the offer's own ID/name/price remain authoritative.
  try { return id(value, 'ID основного товара вариации'); }
  catch { return ''; }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
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

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function snapshotName(snapshot) {
  const dealId = id(snapshot.dealId, 'ID сделки снимка');
  const version = id(snapshot.version, 'Версия снимка');
  const variantId = String(snapshot.variantId ?? '');
  const snapshotId = String(snapshot.snapshotId ?? snapshot.id ?? '');
  if (![variantId, snapshotId].every(value => /^[a-zA-Z0-9_-]{1,80}$/.test(value))) {
    throw new Error('Снимок должен содержать безопасные уникальные variantId и snapshotId.');
  }
  return `yuzm-kp-deal-${dealId}-${variantId}-v${version}-${snapshotId}.json`;
}

export class BitrixAdapter {
  constructor(options = {}) {
    this.sdk = options.sdk ?? globalThis.BX24;
    this.fetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    this.location = options.location ?? globalThis.location;
    this.handlerUrl = options.handlerUrl ?? null;
    this.placementContext = options.placementContext ?? globalThis.B24_PLACEMENT_CONTEXT;
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.initTimeoutMs = options.initTimeoutMs ?? 15000;
    this.readSpacingMs = options.readSpacingMs ?? 550;
    this.readRetryDelayMs = options.readRetryDelayMs ?? 1000;
    this._readPace = Promise.resolve();
    this._nextReadAt = 0;
    this._authRefresh = null;
    this.connected = false;
    this.connectionError = null;
    this.dealId = null;
    this._catalogs = null;
    this._basePriceType = null;
    this._requests = [];
    this._catalogEntries = null;
    this._catalogEntryLoad = null;
    this._catalogOffers = new Map();
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
    delete entry.phase;
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
    try {
      const result = await this._requestResult(method, params, trace);
      let data;
      try {
        if (result.error()) throw apiError(method, result);
        data = result.data();
      } catch (error) {
        throw error?.method === method ? error : transportError(method, 'INVALID_RESPONSE');
      }
      this._finishTrace(trace);
      return data;
    } catch (error) {
      this._finishTrace(trace, error);
      throw error;
    }
  }

  async _paceRead(trace, start) {
    trace.phase = 'queued';
    const pending = this._readPace.then(async () => {
      const delay = this._nextReadAt - Date.now();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      const result = start();
      this._nextReadAt = Date.now() + this.readSpacingMs;
      // Queue request starts, not their completion: a stalled read must not
      // prevent another screen from reading an unrelated resource.
      return {result};
    });
    this._readPace = pending.catch(() => {});
    return (await pending).result;
  }

  async _refreshReadAuth(method) {
    if (!this._authRefresh) {
      const pending = new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, auth) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          error ? reject(error) : resolve(auth);
        };
        const timer = setTimeout(() => finish(transportError(method, 'AUTH_REFRESH_TIMEOUT')), this.initTimeoutMs);
        try {
          if (typeof this.sdk.refreshAuth !== 'function') return finish(transportError(method, 'AUTH_UNAVAILABLE'));
          this.sdk.refreshAuth(auth => finish(auth?.access_token ? null : transportError(method, 'AUTH_UNAVAILABLE'), auth));
        } catch { finish(transportError(method, 'AUTH_UNAVAILABLE')); }
      });
      this._authRefresh = pending;
      pending.finally(() => { if (this._authRefresh === pending) this._authRefresh = null; }).catch(() => {});
    }
    try { return await this._authRefresh; }
    catch (error) { throw transportError(method, error.code); }
  }

  async _fetchRead(method, params, trace) {
    let retries = 0, refreshed = false;
    for (;;) {
      trace.transport = 'rest';
      trace.phase = 'session';
      let auth;
      try { auth = this.sdk.getAuth(); } catch { throw transportError(method, 'AUTH_UNAVAILABLE'); }
      if (!auth?.access_token) {
        if (refreshed) throw transportError(method, 'AUTH_UNAVAILABLE');
        auth = await this._refreshReadAuth(method);
        refreshed = true;
      }
      // Tokens remain in the POST body, only in memory, and only go to the SDK's portal.
      if (typeof auth.access_token !== 'string' || !/^[a-z\d.-]+(?::\d{1,5})?$/i.test(auth.domain ?? '')) {
        throw transportError(method, 'AUTH_UNAVAILABLE');
      }
      const protocol = this.location?.protocol === 'http:' ? 'http:' : 'https:';
      const url = `${protocol}//${auth.domain}/rest/${method}.json`;
      const body = new URLSearchParams({auth: auth.access_token});
      if (Object.hasOwn(params, 'auth')) throw transportError(method, 'AUTH_UNAVAILABLE');
      appendParams(body, params, '');
      const controller = new AbortController();
      let timer;
      let active = true;
      try {
        const result = await this._paceRead(trace, () => {
          trace.attempts = (trace.attempts ?? 0) + 1;
          delete trace.http_status;
          trace.phase = 'response';
          return Promise.race([
            (async () => {
              let response, text;
              try {
                response = await this.fetch(url, {method: 'POST', body,
                  headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                  signal: controller.signal, credentials: 'omit', redirect: 'error',
                  cache: 'no-store', referrerPolicy: 'no-referrer'});
                if (active) trace.http_status = response.status;
                text = await response.text();
              } catch { throw transportError(method, 'NETWORK_ERROR', response?.status); }
              let answer;
              try { answer = JSON.parse(text); } catch { /* classify without exposing the response */ }
              const object = answer && typeof answer === 'object' && !Array.isArray(answer);
              let error;
              if (object && Object.hasOwn(answer, 'error')) {
                error = apiError(method, restResult(answer));
                error.httpStatus = response.status;
              } else if (!response.ok) error = transportError(method, `HTTP_${response.status}`, response.status);
              else if (!object || !Object.hasOwn(answer, 'result')) error = transportError(method, 'INVALID_RESPONSE', response.status);
              if (error) {
                const retryAfter = response.headers?.get('Retry-After');
                if (retryAfter) {
                  const delay = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
                  if (Number.isFinite(delay)) error.retryAfterMs = Math.max(0, delay);
                }
                throw error;
              }
              return restResult(answer);
            })(),
            new Promise((resolve, reject) => {
              timer = setTimeout(() => {
                active = false;
                reject(transportError(method, 'REQUEST_TIMEOUT', trace.http_status));
                controller.abort();
              }, this.timeoutMs);
            }),
          ]);
        });
        return result;
      } catch (error) {
        active = false;
        clearTimeout(timer);
        if (error.code === 'expired_token' && !refreshed) {
          trace.last_error_code = error.code;
          trace.phase = 'session';
          let current;
          try { current = this.sdk.getAuth(); } catch { /* request a fresh session */ }
          if (!current?.access_token || current.access_token === auth.access_token) await this._refreshReadAuth(method);
          refreshed = true;
          continue;
        }
        if (retries < 1 && RETRYABLE_READ_ERRORS.has(error.code) && !(error.retryAfterMs > 5000)) {
          retries++;
          trace.last_error_code = error.code;
          trace.phase = 'retry_wait';
          await new Promise(resolve => setTimeout(resolve, Math.max(this.readRetryDelayMs, error.retryAfterMs ?? 0)));
          continue;
        }
        throw error;
      } finally { active = false; clearTimeout(timer); }
    }
  }

  async _requestResult(method, params, trace, previous) {
    // BX24's XHR transport can throw on 5xx/network/HTML without calling back.
    // Read through REST using the SDK's current session, without patching the SDK.
    if (READ_METHODS.has(method) && typeof this.sdk.getAuth === 'function' && this.fetch) {
      return this._fetchRead(method, params, trace);
    }
    trace.transport = 'sdk';
    trace.attempts = (trace.attempts ?? 0) + 1;
    trace.phase = 'response';
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(result);
      };
      const timer = setTimeout(() => finish(transportError(method, 'REQUEST_TIMEOUT')), this.timeoutMs);
      try {
        if (typeof previous?.next === 'function') previous.next(result => finish(null, result));
        else this.sdk.callMethod(method, params, result => finish(null, result));
      } catch { finish(transportError(method, 'SDK_REQUEST_FAILED')); }
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

  /** Read each page once; retry only the failed offset, preserving collected rows. */
  async _list(method, params = {}, key = null, {maxItems = Infinity, onPage} = {}) {
    this._guard(method);
    const trace = this._trace(method);
    const items = [];
    let pages = 0;
    let lastOffset = Number(params.start ?? 0);
    let previous;
    const firstParams = {...params};
    // Never send duplicate zero offsets through the SDK's Result.next().
    if (firstParams.start === undefined || Number(firstParams.start) === 0) delete firstParams.start;
    let pageParams = firstParams;
    try {
      for (;;) {
        const result = await this._requestResult(method, pageParams, trace, previous);
        let data;
        try {
          if (result.error()) throw apiError(method, result);
          data = result.data();
        } catch (error) {
          throw error?.method === method ? error : transportError(method, 'INVALID_RESPONSE');
        }
        let page = key ? data?.[key] : data;
        // CRM template.list returns templates keyed by ID rather than an array.
        if (method === 'crm.documentgenerator.template.list' && key === 'templates'
          && page && typeof page === 'object' && !Array.isArray(page)) page = Object.values(page);
        if (!Array.isArray(page)) throw new Error(`Bitrix24: ${method} — нет массива ${key ?? 'result'}.`);
        items.push(...page);
        pages += 1;
        trace.pages = pages;
        trace.items = items.length;
        onPage?.(page.length);
        const total = typeof result.total === 'function' ? result.total() : undefined;
        if (Number.isSafeInteger(total) && total >= 0) trace.total_items = total;
        if (items.length > maxItems) throw broadSearchError();
        if (pages > 2000) throw new Error('Превышен лимит страниц. Уточните поиск в каталоге.');
        if (!(typeof result.more === 'function' && result.more())) break;
        if (!page.length) throw new Error(`Bitrix24: ${method} — пустая страница с продолжением.`);
        const offset = result.answer?.next === undefined ? pages * 50 : Number(result.answer.next);
        if (!Number.isSafeInteger(offset) || offset <= lastOffset) {
          const error = new Error(`Bitrix24: ${method} — повторяется страница списка. Скопируйте диагностику из настроек.`);
          error.code = 'PAGINATION_STALLED';
          throw error;
        }
        lastOffset = offset;
        trace.next_offset = offset;
        pageParams = {...params, start: offset};
        previous = result;
      }
      this._finishTrace(trace);
      return items;
    } catch (error) {
      this._finishTrace(trace, error);
      throw error;
    }
  }

  async _getCatalogs() {
    if (!this._catalogs) {
      this._catalogs = await this._list('catalog.catalog.list', {
        select: ['id', 'iblockId', 'name', 'productIblockId', 'skuPropertyId'],
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

  async _prices(productIds) {
    const type = await this._getBasePriceType();
    const prices = await this._list('catalog.price.list', {
      select: ['id', 'productId', 'catalogGroupId', 'price', 'currency', 'quantityFrom', 'quantityTo'],
      filter: { '@productId': productIds.map(Number), catalogGroupId: Number(type.id) },
      order: { id: 'ASC' },
    }, 'prices');
    const result = new Map();
    for (const productId of productIds) {
      const found = prices.filter(price => String(price.productId) === String(productId)
        && String(price.catalogGroupId) === type.id);
      const unrestricted = found.filter(price => !Number(price.quantityFrom) && !Number(price.quantityTo));
      if (unrestricted.length !== 1) {
        throw new Error(`Товар #${productId}: базовая цена отсутствует, неоднозначна или зависит от количества. Выберите товар с одной базовой ценой.`);
      }
      const basePrice = number(unrestricted[0].price, `Базовая цена товара #${productId}`);
      if (basePrice < 0) throw new Error(`Товар #${productId}: отрицательная базовая цена.`);
      result.set(String(productId), { basePrice, currency: currency(unrestricted[0].currency) });
    }
    return result;
  }

  _product(raw, price, source) {
    const productId = id(raw.id ?? raw.ID, 'ID товара');
    const name = String(raw.name ?? raw.NAME ?? '').trim();
    if (!name) throw new Error(`Товар #${productId}: API не вернул торговое наименование.`);
    const type = Number(raw.type ?? raw.TYPE);
    if ([3, 6].includes(type)) throw new Error(`Товар #${productId} — головной товар SKU. Выберите конкретное торговое предложение.`);
    const variation = [4, 5].includes(type) || source.startsWith('catalog.product.offer.');
    return { id: productId, name, ...price, verified: true, source,
      ...(variation ? {isVariation: true, parentProductId: variationParent(raw)} : {}) };
  }

  async _legacyProduct(productId) {
    const raw = await this.call('crm.product.get', { id: Number(productId) });
    if (String(raw?.ID) !== productId) throw new Error('CRM API вернул другой ID товара.');
    let price;
    try { price = (await this._prices([productId])).get(productId); }
    catch (error) {
      if (!unavailable(error)) throw error;
      const basePrice = number(raw.PRICE, `Базовая цена товара #${productId}`);
      if (basePrice < 0) throw new Error('CRM API вернул отрицательную базовую цену.');
      price = { basePrice, currency: currency(raw.CURRENCY_ID) };
    }
    return this._product(raw, price, 'crm.product.get');
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
        if (String(data?.[key]?.id) !== productId) {
          throw new Error(`Bitrix24: ${method} — API не подтвердил ID запрошенного товара.`);
        }
        return {raw: data[key], source: method};
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
    // Legacy lookup is appropriate only when every modern get method is unavailable.
    return null;
  }

  async getProduct(value) {
    const productId = id(value, 'ID товара');
    const found = await this._readProduct(productId);
    if (!found) return this._legacyProduct(productId);
    const {raw, source} = found;
    if ([3, 6].includes(Number(raw.type))) {
      throw new Error(`Товар #${productId} — головной товар SKU. Выберите конкретное торговое предложение.`);
    }
    const prices = await this._prices([productId]);
    return this._product(raw, prices.get(productId), source);
  }

  async _allOffers(catalog, onPage) {
    const iblockId = id(catalog.iblockId ?? catalog.id, 'ID инфоблока вариаций');
    if (!this._catalogOffers.has(iblockId)) {
      const pending = this._list('catalog.product.offer.list', {
        select: ['id', 'iblockId', 'name', 'type', 'active', 'parentId'],
        filter: {iblockId: Number(iblockId), active: 'Y'},
        order: {name: 'ASC', id: 'ASC'},
      }, 'offers', {onPage});
      this._catalogOffers.set(iblockId, pending);
      pending.catch(() => { if (this._catalogOffers.get(iblockId) === pending) this._catalogOffers.delete(iblockId); });
    }
    return this._catalogOffers.get(iblockId);
  }

  async _offersForParents(catalog, parents) {
    const expected = new Set(parents.map(parent => id(parent.id, 'ID основного товара')));
    // Read the offer block once and group by its actual relationship data
    // rather than relying on server-side parent filters.
    return (await this._allOffers(catalog)).filter(offer => offer.active !== 'N'
      && ![3, 6].includes(Number(offer.type)) && expected.has(variationParent(offer)));
  }

  /** Full metadata index; prices are verified separately for the selected ID. */
  async listCatalogEntries({refresh = false, onProgress} = {}) {
    if (refresh && !this._catalogEntryLoad) {
      this._catalogEntries = null; this._catalogs = null; this._basePriceType = null; this._catalogOffers.clear();
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
    const products = new Map(), parents = new Map();
    let count = 0;
    const onPage = size => { count += size; onProgress?.(count); };
    const collect = (rows, source) => {
      for (const raw of rows) {
        if ((raw.active ?? raw.ACTIVE) === 'N') continue;
        const productId = id(raw.id ?? raw.ID, 'ID товара');
        if ([3, 6].includes(Number(raw.type ?? raw.TYPE))) { parents.set(productId, raw); continue; }
        products.set(productId, {...this._product(raw, {}, source), verified: false});
      }
    };
    let catalogs;
    try { catalogs = await this._getCatalogs(); }
    catch (error) {
      if (!unavailable(error)) throw error;
      for (const catalog of await this._list('crm.catalog.list')) {
        collect(await this._list('crm.product.list', {
          select: ['ID', 'NAME', 'CATALOG_ID', 'ACTIVE'],
          filter: {CATALOG_ID: Number(id(catalog.ID, 'ID каталога')), ACTIVE: 'Y'},
          order: {NAME: 'ASC', ID: 'ASC'},
        }, null, {onPage}), 'crm.product.list');
      }
      return [...products.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru') || Number(a.id) - Number(b.id));
    }
    for (const catalog of catalogs) {
      if (Number(catalog.productIblockId) > 0) {
        collect(await this._allOffers(catalog, onPage), 'catalog.product.offer.list');
        continue;
      }
      const iblockId = Number(id(catalog.iblockId ?? catalog.id, 'ID инфоблока'));
      collect(await this._list('catalog.product.list', {
        select: ['id', 'iblockId', 'name', 'type', 'active'],
        filter: {iblockId, active: 'Y'}, order: {name: 'ASC', id: 'ASC'},
      }, 'products', {onPage}), 'catalog.product.list');
      if (catalogs.some(other => String(other.productIblockId) === String(iblockId))) {
        try {
          const heads = await this._list('catalog.product.sku.list', {
            select: ['id', 'iblockId', 'name', 'type', 'active'],
            filter: {iblockId, active: 'Y'}, order: {name: 'ASC', id: 'ASC'},
          }, 'units', {onPage});
          for (const head of heads) if (head.active !== 'N') parents.set(id(head.id, 'ID основного товара'), head);
        } catch (error) { if (!unavailable(error)) throw error; }
      }
    }
    for (const entry of products.values()) {
      const parent = parents.get(entry.parentProductId);
      if (parent) entry.parentProductName = String(parent.name ?? parent.NAME ?? '');
    }
    return [...products.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru') || Number(a.id) - Number(b.id));
  }

  async _pricedProducts(products, parents = new Map()) {
    if (products.size > MAX_SEARCH_ITEMS) throw broadSearchError();
    const output = [], allIds = [...products.keys()];
    for (let offset = 0; offset < allIds.length; offset += 50) {
      const chunk = allIds.slice(offset, offset + 50);
      const prices = await this._prices(chunk);
      for (const productId of chunk) {
        const found = products.get(productId);
        const product = this._product(found.raw, prices.get(productId), found.source);
        const parent = parents.get(product.parentProductId);
        if (parent) product.parentProductName = String(parent.name);
        output.push(product);
      }
    }
    return output.sort((a, b) => a.name.localeCompare(b.name, 'ru') || Number(a.id) - Number(b.id));
  }

  async searchProducts(query = '', {by = 'auto'} = {}) {
    const text = String(query).trim();
    if (!['auto', 'name', 'id'].includes(by)) throw new Error('Выберите поиск по названию или ID товара.');
    // A parent ID expands into its offers; a concrete product ID stays exact.
    if (by === 'id' || (by === 'auto' && /^[1-9]\d*$/.test(text))) {
      const productId = id(text, 'ID товара');
      let found;
      try { found = await this._readProduct(productId); }
      catch (error) {
        if (error.code === 'PRODUCT_NOT_FOUND') return [];
        throw error;
      }
      if (!found) return [await this._legacyProduct(productId)];
      if (![3, 6].includes(Number(found.raw.type))) {
        return this._pricedProducts(new Map([[productId, found]]));
      }
      const parent = found.raw;
      const iblockId = id(parent.iblockId, 'ID инфоблока основного товара');
      const catalogs = (await this._getCatalogs()).filter(catalog => String(catalog.productIblockId) === iblockId);
      const products = new Map();
      for (const catalog of catalogs) {
        for (const raw of await this._offersForParents(catalog, [parent])) {
          products.set(id(raw.id, 'ID вариации'), {raw, source: 'catalog.product.offer.list'});
        }
      }
      return this._pricedProducts(products, new Map([[productId, parent]]));
    }
    let catalogs;
    try { catalogs = await this._getCatalogs(); }
    catch (error) {
      if (!unavailable(error)) throw error;
      const legacyCatalogs = await this._list('crm.catalog.list');
      const products = [];
      for (const catalog of legacyCatalogs) {
        const rows = await this._list('crm.product.list', {
          select: ['ID', 'NAME', 'PRICE', 'CURRENCY_ID', 'CATALOG_ID'],
          filter: { CATALOG_ID: Number(id(catalog.ID, 'ID каталога')), ACTIVE: 'Y', ...(text ? { '%NAME': text } : {}) },
          order: { NAME: 'ASC', ID: 'ASC' },
        }, null, {maxItems: MAX_SEARCH_ITEMS});
        if (products.length + rows.length > MAX_SEARCH_ITEMS) throw broadSearchError();
        for (const product of rows) products.push(await this._legacyProduct(id(product.ID, 'ID товара')));
      }
      return [...new Map(products.map(product => [product.id, product])).values()];
    }
    const products = new Map(), parents = new Map();
    for (const catalog of catalogs) {
      const offers = Number(catalog.productIblockId) > 0;
      const method = offers ? 'catalog.product.offer.list' : 'catalog.product.list';
      const key = offers ? 'offers' : 'products';
      const rows = await this._list(method, {
        select: ['id', 'iblockId', 'name', 'type', 'active', ...(offers ? ['parentId'] : [])],
        filter: { iblockId: Number(id(catalog.iblockId ?? catalog.id, 'ID инфоблока')), active: 'Y', ...(text ? { '=%name': `%${text}%` } : {}) },
        order: { name: 'ASC', id: 'ASC' },
      }, key, {maxItems: MAX_SEARCH_ITEMS});
      for (const row of rows) {
        if (row.active === 'N') continue;
        if ([3, 6].includes(Number(row.type))) { parents.set(id(row.id, 'ID основного товара'), row); continue; }
        products.set(id(row.id, 'ID товара'), { raw: row, source: method });
      }
      if (!offers && catalogs.some(other => String(other.productIblockId) === String(catalog.iblockId ?? catalog.id))) {
        try {
          const heads = await this._list('catalog.product.sku.list', {
            select: ['id', 'iblockId', 'name', 'type', 'active'],
            filter: {iblockId: Number(id(catalog.iblockId ?? catalog.id, 'ID инфоблока')), active: 'Y', ...(text ? {'=%name': `%${text}%`} : {})},
            order: {name: 'ASC', id: 'ASC'},
          }, 'units', {maxItems: MAX_SEARCH_ITEMS});
          for (const head of heads) if (head.active !== 'N') parents.set(id(head.id, 'ID основного товара'), head);
        } catch (error) { if (!unavailable(error)) throw error; }
      }
    }
    // Offer names can differ from the parent name. Include the matching parent's offers too.
    if (text) for (const catalog of catalogs.filter(catalog => Number(catalog.productIblockId) > 0)) {
      const heads = [...parents.values()].filter(parent => String(parent.iblockId) === String(catalog.productIblockId));
      for (let offset = 0; offset < heads.length; offset += 50) {
        for (const raw of await this._offersForParents(catalog, heads.slice(offset, offset + 50))) {
          products.set(id(raw.id, 'ID вариации'), {raw, source: 'catalog.product.offer.list'});
        }
      }
    }
    return this._pricedProducts(products, parents);
  }

  async loadDeal(value) {
    const dealId = id(value, 'ID сделки');
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
    return { id: dealId, title: String(deal.TITLE ?? ''), companyName, currency: dealCurrency, rows };
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
      FILTER: {ID: Number(userId)}, select: ['ID', 'NAME', 'LAST_NAME', 'WORK_POSITION', 'WORK_PHONE'],
    });
    if (!Array.isArray(users) || users.length !== 1 || String(users[0]?.ID) !== userId) {
      throw new Error('Bitrix24 не вернул профиль ответственного за сделку. Заполните подпись вручную.');
    }
    const user = users[0];
    const text = key => documentText(user[key], `Профиль сотрудника: ${key}`).trim();
    return {dealId, userId, name: [text('NAME'), text('LAST_NAME')].filter(Boolean).join(' '),
      position: text('WORK_POSITION'), workPhone: text('WORK_PHONE'),
      phoneAvailable: Object.hasOwn(user, 'WORK_PHONE')};
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
      downloadUrl: this._documentUrl(raw.downloadUrl),
      pdfUrl: this._documentUrl(raw.pdfUrl),
      publicUrl: this._documentUrl(raw.publicUrl),
      conversionError: [true, 1, '1', 'Y'].includes(raw.isTransformationError),
    };
  }

  async createQuoteDocument(dealValue, templateValue, snapshot) {
    const dealId = id(dealValue, 'ID сделки');
    const templateId = id(templateValue, 'ID шаблона');
    if (!snapshot || String(snapshot.dealId) !== dealId) throw new Error('Снимок КП относится к другой сделке.');
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
        Coating: documentText(formatCoating(coating || {code: row.coatingCode, name: row.coatingName || row.coatingCode || ''}, row.ralColor), 'Покрытие'),
        Quantity: String(quantity).replace('.', ','),
        Price: DOCUMENT_MONEY.format(price),
        Total: DOCUMENT_MONEY.format(lineTotal),
        ExecutionTerm: documentText(row.executionTerm, 'Срок исполнения'),
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
    const response = await this.call('crm.documentgenerator.template.get', { id: Number(templateId) });
    const template = documentTemplate(response?.template, deal.categoryId);
    if (template.id !== templateId || !template.available) throw new Error('Выбранный шаблон удалён, неактивен или недоступен для направления этой сделки.');
    // Validate the complete document and template before changing CRM. The
    // document and the mandatory replacement use the very same saved version.
    const before = await this.loadDeal(dealId);
    await this.applyToDeal(dealId, snapshot, fingerprintRows(before.rows));
    let created;
    try {
      created = await this.call('crm.documentgenerator.document.add', {
        templateId: Number(templateId), entityTypeId: 2, entityId: Number(dealId),
        values: { KpItems: items }, fields,
      });
    } catch (error) {
      error.goodsTransferred = true;
      throw error;
    }
    try {
      return this._document(created?.document, { templateId, entityId: dealId, entityTypeId: '2' });
    } catch (error) {
      let documentId;
      try { documentId = id(created?.document?.id, 'ID документа'); } catch { error.goodsTransferred = true; throw error; }
      const unverified = new Error(`Bitrix24 вернул документ #${documentId}, но его данные или ссылки не подтверждены. Проверьте документ перед повторным созданием.`);
      unverified.code = 'DOCUMENT_RESPONSE_UNVERIFIED';
      unverified.documentId = documentId;
      throw unverified;
    }
  }

  async getQuoteDocument(value) {
    const documentId = id(value, 'ID документа');
    const response = await this.call('crm.documentgenerator.document.get', { id: Number(documentId) });
    return this._document(response?.document, { id: documentId });
  }

  async loadDiskJson(value) {
    const fileId = id(value, 'ID файла на Диске');
    const metadata = await this.call('disk.file.get', { id: Number(fileId) });
    if (String(metadata?.ID) !== fileId || (metadata.TYPE && metadata.TYPE !== 'file')) {
      throw new Error('Диск вернул другой ID или объект не является файлом.');
    }
    if (!metadata.DOWNLOAD_URL) throw new Error('Диск не вернул ссылку скачивания. Скачайте JSON вручную и выберите локальный файл.');
    if (Number(metadata.SIZE) > MAX_JSON_BYTES) throw new Error('JSON-файл превышает лимит 5 МБ.');
    let url;
    try { url = new URL(metadata.DOWNLOAD_URL, this.location?.href); }
    catch { throw new Error('Диск вернул некорректную ссылку скачивания.'); }
    const localHttp = url.protocol === 'http:' && url.origin === this.location?.origin;
    if (url.protocol !== 'https:' && !localHttp) throw new Error('Для чтения Диска требуется HTTPS.');
    if (!this.fetch) throw new Error('Браузер не поддерживает загрузку файла. Выберите JSON вручную.');
    let response;
    try { response = await this.fetch(url.href, { credentials: 'include', mode: 'cors', cache: 'no-store' }); }
    catch { throw new Error('Не удалось прочитать Диск: CORS, сеть или авторизация. Разрешите origin приложения на сервере либо скачайте JSON и выберите его вручную.'); }
    if (!response.ok) throw new Error(`Диск: HTTP ${response.status}. Проверьте права и авторизацию либо выберите JSON вручную.`);
    let data;
    try {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) throw new Error('size');
      data = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('shape');
    } catch { throw new Error('Файл Диска не содержит корректный JSON-объект до 5 МБ. Возможно, сервер вернул страницу авторизации. Выберите JSON вручную.'); }
    return { data, fileId, version: String(metadata.GLOBAL_CONTENT_VERSION ?? data.version ?? ''), name: String(metadata.NAME ?? '') };
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

  async loadHistory(folderValue, dealValue) {
    const folderId = id(folderValue, 'ID папки истории');
    const dealId = id(dealValue, 'ID сделки');
    const children = await this._list('disk.folder.getChildren', {
      id: Number(folderId), filter: { TYPE: 'file' }, order: { NAME: 'ASC' },
    });
    const history = [];
    for (const file of children) {
      if (file.TYPE !== 'file' || Number(file.DELETED_TYPE ?? 0) !== 0
        || !String(file.NAME ?? '').startsWith(`yuzm-kp-deal-${dealId}-`) || !String(file.NAME).endsWith('.json')) continue;
      const loaded = await this.loadDiskJson(file.ID);
      const snapshot = loaded.data;
      if (String(snapshot.dealId) !== dealId || snapshotName(snapshot) !== loaded.name || !Array.isArray(snapshot.rows)) {
        throw new Error(`Файл истории #${loaded.fileId} не соответствует сделке или структуре снимка.`);
      }
      history.push({ ...snapshot, fileId: loaded.fileId, fileName: loaded.name, storage: 'disk' });
    }
    return history.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || Number(b.version) - Number(a.version));
  }

  async saveSnapshot(folderValue, snapshot) {
    const folderId = id(folderValue, 'ID папки истории');
    const name = snapshotName(snapshot);
    if (!Array.isArray(snapshot.rows) || !snapshot.rows.length) throw new Error('Нельзя сохранить пустой снимок КП.');
    const content = JSON.stringify(snapshot, null, 2);
    if (new TextEncoder().encode(content).byteLength > MAX_JSON_BYTES) throw new Error('Снимок превышает лимит 5 МБ.');
    const uploaded = await this.call('disk.folder.uploadFile', {
      id: Number(folderId), data: { NAME: name }, fileContent: [name, encodeBase64(content)], generateUniqueName: false,
    });
    const fileId = id(uploaded?.ID, 'ID загруженного снимка');
    if (uploaded.NAME !== name) throw new Error('Диск изменил имя снимка. Проверьте загруженный файл перед продолжением.');
    try {
      const loaded = await this.loadDiskJson(fileId);
      if (JSON.stringify(stable(loaded.data)) !== JSON.stringify(stable(snapshot))) throw new Error('mismatch');
    } catch {
      const error = new Error(`Снимок загружен на Диск (#${fileId}), но чтение и целостность не подтверждены. Проверьте CORS и доступ к файлу; локальная история остаётся доступной.`);
      error.code = 'UPLOAD_UNVERIFIED'; error.fileId = fileId;
      throw error;
    }
    return { fileId, name };
  }

  async applyToDeal(dealValue, snapshot, expectedFingerprint) {
    const dealId = id(dealValue, 'ID сделки');
    if (String(snapshot.dealId) !== dealId) throw new Error('Снимок относится к другой сделке.');
    if (!Array.isArray(snapshot.rows) || !snapshot.rows.length || snapshot.valid === false) throw new Error('Нет корректных позиций для применения.');
    const quoteCurrency = currency(snapshot.currency ?? snapshot.config?.currency);
    const requested = snapshot.rows.map((row, index) => {
      const productId = id(row.productId, 'ID товара');
      const price = number(row.unitPrice, 'Цена единицы');
      const quantity = parseNumber(row.quantity);
      if (!Number.isFinite(quantity)) throw new Error('Количество: требуется конечное число.');
      const taxRate = number(row.taxRate ?? row.raw?.TAX_RATE ?? 0, 'Ставка НДС');
      const taxIncluded = String(row.taxIncluded ?? row.raw?.TAX_INCLUDED ?? 'Y');
      if (taxRate < 0 || taxRate > 100 || !['Y', 'N'].includes(taxIncluded)) throw new Error('Некорректная ставка НДС или признак включения налога в цену.');
      if (price < 0) throw new Error('Отрицательная цена допустима в модели, но не для записи в CRM.');
      if (quantity <= 0) throw new Error('Количество должно быть положительным.');
      if (currency(row.currency ?? quoteCurrency) !== quoteCurrency) throw new Error('В КП смешаны валюты.');
      return { productId: Number(productId), productName: String(row.productName ?? ''), price, quantity,
        discountTypeId: 2, discountRate: 0, discountSum: 0, taxRate, taxIncluded, sort: (index + 1) * 10 };
    });
    const unitTotal = Math.round(requested.reduce((sum, row) => sum + Math.round(row.price * row.quantity * 100) / 100, 0) * 100) / 100;
    if (snapshot.total !== undefined && Math.abs(number(snapshot.total, 'Итого КП') - unitTotal) > 0.010001) {
      throw new Error('Итого КП отличается от суммы цен единиц × количество. Для переноса в сделку выберите округление цены единицы.');
    }
    // Verify IDs against the actual catalog; do not rely on demo IDs or a UI flag.
    for (const productId of new Set(requested.map(row => String(row.productId)))) {
      const product = await this.getProduct(productId);
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
    let method = 'crm.item.productrow.set';
    try { await this.call(method, { ownerType: 'D', ownerId: Number(dealId), productRows: requested }); }
    catch (error) {
      if (!unavailable(error)) throw error;
      method = 'crm.deal.productrows.set';
      const rows = requested.map(row => ({ PRODUCT_ID: row.productId, PRODUCT_NAME: row.productName,
        PRICE: row.price, QUANTITY: row.quantity, DISCOUNT_TYPE_ID: 2, DISCOUNT_RATE: 0, DISCOUNT_SUM: 0,
        TAX_RATE: row.taxRate, TAX_INCLUDED: row.taxIncluded, SORT: row.sort }));
      await this.call(method, { id: Number(dealId), rows });
    }
    const saved = await this.loadDeal(dealId);
    const verified = saved.currency === quoteCurrency && saved.rows.length === requested.length
      && saved.rows.every((row, index) => row.productId === String(requested[index].productId)
        && Math.abs(row.unitPrice - requested[index].price) < 0.000001
        && Math.abs(row.quantity - requested[index].quantity) < 0.000001
        && Math.abs(row.taxRate - requested[index].taxRate) < 0.000001
        && row.taxIncluded === requested[index].taxIncluded);
    if (!verified) {
      const error = new Error('Запись выполнена, но состав или цены при повторном чтении отличаются. Проверьте сделку и автоматизацию CRM; повторная запись не выполнялась.');
      error.code = 'WRITE_UNVERIFIED'; throw error;
    }
    return { verified: true, method, dealId, rows: saved.rows, total: unitTotal };
  }
}
