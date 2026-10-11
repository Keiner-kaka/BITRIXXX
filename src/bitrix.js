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
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const QUOTE_TEMPLATE_OPTION = 'yuzmQuoteTemplateId';
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
  const raw = sdkError?.ex?.error ?? result.answer?.error
    ?? (typeof sdkError === 'string' || typeof sdkError === 'number' ? sdkError : 'API_ERROR');
  const code = /^[A-Za-z_\d.-]{1,80}$/.test(String(raw)) ? String(raw) : 'API_ERROR';
  const error = new Error(`Bitrix24: ${method} — ${code}. Проверьте права приложения и пользователя.`);
  error.code = code;
  return error;
}

function unavailable(error) {
  return ['ERROR_METHOD_NOT_FOUND', 'METHOD_NOT_FOUND', 'ERROR_UNKNOWN_METHOD'].includes(error?.code);
}

function variationParent(raw) {
  const value = raw.parentId && typeof raw.parentId === 'object' ? raw.parentId.value : raw.parentId;
  if (value === undefined || value === null || value === '' || String(value) === '0') return '';
  return id(value, 'ID основного товара вариации');
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
    this.connected = false;
    this.connectionError = null;
    this.dealId = null;
    this._catalogs = null;
    this._basePriceType = null;
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
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, data) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(data);
      };
      const timer = setTimeout(() => finish(new Error(`Bitrix24: ${method} — время ожидания истекло.`)), this.timeoutMs);
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

  /** SDK Result.more()/next() preserve next offsets for every supported list method. */
  async _list(method, params = {}, key = null) {
    this._guard(method);
    return new Promise((resolve, reject) => {
      const items = [];
      let pages = 0;
      let settled = false;
      let timer;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(items);
      };
      const armTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error(`Bitrix24: ${method} — время ожидания страницы истекло.`)), this.timeoutMs);
      };
      const consume = result => {
        if (settled) return;
        try {
          if (result.error()) return finish(apiError(method, result));
          const data = result.data();
          let page = key ? data?.[key] : data;
          // CRM template.list returns templates keyed by ID rather than an array.
          // Keep every other list method's response validation strict.
          if (method === 'crm.documentgenerator.template.list' && key === 'templates'
            && page && typeof page === 'object' && !Array.isArray(page)) {
            page = Object.values(page);
          }
          if (!Array.isArray(page)) return finish(new Error(`Bitrix24: ${method} — нет массива ${key ?? 'result'}.`));
          items.push(...page);
          pages += 1;
          if (pages > 2000) return finish(new Error('Превышен лимит страниц. Уточните поиск в каталоге.'));
          const more = typeof result.more === 'function' ? result.more() : false;
          if (!more) return finish();
          if (!page.length) return finish(new Error(`Bitrix24: ${method} — пустая страница с продолжением.`));
          armTimer();
          if (typeof result.next === 'function') result.next(consume);
          else this.sdk.callMethod(method, { ...params, start: pages * 50 }, consume);
        } catch { finish(new Error(`Bitrix24: ${method} — ошибка чтения страницы SDK.`)); }
      };
      armTimer();
      try { this.sdk.callMethod(method, { ...params, start: params.start ?? 0 }, consume); }
      catch { finish(new Error(`Bitrix24: ${method} — ошибка транспорта SDK.`)); }
    });
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
    for (const [method, key] of [
      ['catalog.product.get', 'product'],
      ['catalog.product.offer.get', 'offer'],
      ['catalog.product.sku.get', 'sku'],
    ]) {
      try {
        const data = await this.call(method, { id: Number(productId) });
        if (String(data?.[key]?.id) !== productId) continue;
        return {raw: data[key], source: method};
      } catch { /* A different product kind may own this ID; validate each response. */ }
    }
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

  async _offersForParents(catalog, parents) {
    const parentIds = parents.map(parent => id(parent.id, 'ID основного товара'));
    const expected = new Set(parentIds);
    const offers = await this._list('catalog.product.offer.list', {
      select: ['id', 'iblockId', 'name', 'type', 'active', 'parentId'],
      filter: {iblockId: Number(id(catalog.iblockId ?? catalog.id, 'ID инфоблока вариаций')), active: 'Y',
        ...(parentIds.length === 1 ? {parentId: Number(parentIds[0])} : {'@parentId': parentIds.map(Number)})},
      order: {name: 'ASC', id: 'ASC'},
    }, 'offers');
    for (const offer of offers) {
      if (!expected.has(variationParent(offer)) || [3, 6].includes(Number(offer.type))) {
        throw new Error('Битрикс24 вернул вариацию другого основного товара. Уточните поиск.');
      }
    }
    return offers.filter(offer => offer.active !== 'N');
  }

  async _pricedProducts(products, parents = new Map()) {
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

  async searchProducts(query = '') {
    const text = String(query).trim();
    // A parent ID expands into its offers; a concrete product ID stays exact.
    if (/^[1-9]\d*$/.test(text)) {
      const productId = id(text, 'ID товара');
      const found = await this._readProduct(productId);
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
        });
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
        filter: { iblockId: Number(id(catalog.iblockId ?? catalog.id, 'ID инфоблока')), active: 'Y', ...(text ? { '%name': text } : {}) },
        order: { name: 'ASC', id: 'ASC' },
      }, key);
      for (const row of rows) {
        if (row.active === 'N') continue;
        if ([3, 6].includes(Number(row.type))) { parents.set(id(row.id, 'ID основного товара'), row); continue; }
        products.set(id(row.id, 'ID товара'), { raw: row, source: method });
      }
      if (!offers && catalogs.some(other => String(other.productIblockId) === String(catalog.iblockId ?? catalog.id))) {
        try {
          const heads = await this._list('catalog.product.sku.list', {
            select: ['id', 'iblockId', 'name', 'type', 'active'],
            filter: {iblockId: Number(id(catalog.iblockId ?? catalog.id, 'ID инфоблока')), active: 'Y', ...(text ? {'%name': text} : {})},
            order: {name: 'ASC', id: 'ASC'},
          }, 'units');
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
