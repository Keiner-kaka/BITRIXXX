import test from 'node:test';
import assert from 'node:assert/strict';
import { BitrixAdapter, fingerprintRows } from '../src/bitrix.js';

function sdkMock(routes, placement = { placement: 'CRM_DEAL_DETAIL_TAB', options: { ID: '12' } }) {
  const calls = [];
  const sdk = {
    calls,
    init(callback) { queueMicrotask(callback); },
    placement: { info: () => placement },
    callMethod(method, params, callback) {
      calls.push({ method, params });
      const deliver = (page = 0, consumer = callback) => {
        const route = routes[method];
        const result = typeof route === 'function' ? route(params, page) : route;
        const outcome = result ?? { error: 'ERROR_METHOD_NOT_FOUND' };
        queueMicrotask(() => consumer({
          error: () => outcome.error ? { status: 400, ex: { error: outcome.error, error_description: outcome.description ?? '' } } : false,
          error_description: () => outcome.description ?? '',
          data: () => outcome.pages ? outcome.pages[page] : outcome.data,
          more: () => Boolean(outcome.pages && page + 1 < outcome.pages.length),
          next: (nextConsumer = consumer) => deliver(page + 1, nextConsumer),
        }));
      };
      deliver();
    },
  };
  return sdk;
}

async function adapter(routes, options = {}, placement) {
  const sdk = sdkMock(routes, placement);
  const api = new BitrixAdapter({ sdk, ...options });
  await api.init();
  return { api, sdk };
}

const priceType = { data: { priceTypes: [{ id: 1, name: 'BASE', base: 'Y', xmlId: 'BASE' }] } };
function productRoutes() {
  return {
    'catalog.product.get': params => ({ data: { product: { id: params.id, name: `Товар ${params.id}`, type: 1 } } }),
    'catalog.priceType.list': priceType,
    'catalog.price.list': params => ({ data: { prices: params.filter['@productId'].map(productId => ({
      id: productId, productId, catalogGroupId: 1, price: 38600, currency: 'RUB', quantityFrom: null, quantityTo: null,
    })) } }),
  };
}

function snapshot(extra = {}) {
  return { dealId: '12', variantId: 'variant-a', snapshotId: 'snapshot-1', version: 1,
    currency: 'RUB', total: 220, valid: true, createdAt: '2026-10-08T10:00:00Z',
    rows: [{ productId: '101', productName: 'Товар 101', quantity: 2, unitPrice: 110, currency: 'RUB' }], ...extra };
}

function dealRoutes() {
  let rows = [{ ID: '77', PRODUCT_ID: 101, PRODUCT_NAME: 'Согласованное имя', PRICE: 200, QUANTITY: 1, SORT: 10, TAX_RATE: 0, TAX_INCLUDED: 'Y' }];
  const routes = {
    ...productRoutes(),
    'crm.deal.get': { data: { ID: '12', TITLE: 'Пилотная сделка', COMPANY_ID: 0, CURRENCY_ID: 'RUB' } },
    'crm.deal.productrows.get': () => ({ data: rows }),
    'crm.item.productrow.set': params => {
      rows = params.productRows.map((row, index) => ({ ID: String(100 + index), PRODUCT_ID: row.productId,
        PRODUCT_NAME: row.productName, PRICE: row.price, QUANTITY: row.quantity, SORT: row.sort,
        TAX_RATE: row.taxRate, TAX_INCLUDED: row.taxIncluded }));
      return { data: true };
    },
  };
  return { routes, getRows: () => rows, setRows: value => { rows = value; } };
}

test('SDK init reads deal placement and has no registration/write side effects', async () => {
  const { api, sdk } = await adapter({});
  assert.equal(api.connected, true);
  assert.equal(api.dealId, '12');
  assert.deepEqual(sdk.calls, []);
});

test('outside portal init returns false promptly and server deal context is supported', async () => {
  const absent = await new BitrixAdapter({ sdk: {} }).init();
  assert.deepEqual(absent, { connected: false, dealId: null });
  const hanging = await new BitrixAdapter({ sdk: { init() {}, callMethod() {} }, initTimeoutMs: 5 }).init();
  assert.deepEqual(hanging, { connected: false, dealId: null });
  const { api } = await adapter({}, { placementContext: { dealId: '55' } }, { placement: 'DEFAULT', options: {} });
  assert.equal(api.dealId, '55');
});

test('API errors cannot disclose auth URLs or descriptions; catalog mutations are forbidden', async () => {
  const { api, sdk } = await adapter({ 'crm.deal.get': { error: 'ACCESS_DENIED', description: 'https://portal/rest/1/private-token/?auth=secret' } });
  await assert.rejects(api.call('crm.deal.get', { id: 12 }), error => error.message.includes('ACCESS_DENIED') && !/secret|private-token/.test(error.message));
  await assert.rejects(api.call('catalog.product.update', { id: 101 }), /только для чтения/);
  assert.equal(sdk.calls.length, 1);
});

test('search discovers catalog IDs, paginates products/offers/prices and uses the explicit BASE group', async () => {
  const routes = {
    ...productRoutes(),
    'catalog.catalog.list': { pages: [
      { catalogs: [{ id: 7, iblockId: 7, productIblockId: 0 }] },
      { catalogs: [{ id: 8, iblockId: 8, productIblockId: 7 }] },
    ] },
    'catalog.product.list': { pages: [
      { products: [{ id: 101, iblockId: 7, name: 'Опора А', type: 1 }] },
      { products: [{ id: 102, iblockId: 7, name: 'Опора Б', type: 1 }] },
    ] },
    'catalog.product.offer.list': { data: { offers: [{ id: 103, iblockId: 8, name: 'Опора В — вариация', type: 4 }] } },
    'catalog.price.list': { pages: [
      { prices: [{ id: 1, productId: 101, catalogGroupId: 1, price: 100, currency: 'RUB' }] },
      { prices: [{ id: 2, productId: 102, catalogGroupId: 1, price: 200, currency: 'RUB' }, { id: 3, productId: 103, catalogGroupId: 1, price: 300, currency: 'RUB' }] },
    ] },
  };
  const { api, sdk } = await adapter(routes);
  const products = await api.searchProducts('Опора');
  assert.deepEqual(products.map(product => [product.id, product.basePrice, product.verified]), [['101', 100, true], ['102', 200, true], ['103', 300, true]]);
  assert.equal(sdk.calls.find(call => call.method === 'catalog.product.list').params.filter.iblockId, 7);
  assert.equal(sdk.calls.find(call => call.method === 'catalog.product.offer.list').params.filter.iblockId, 8);
  assert.deepEqual(sdk.calls.find(call => call.method === 'catalog.priceType.list').params.filter, { base: 'Y' });
  assert.deepEqual(sdk.calls.find(call => call.method === 'catalog.price.list').params.filter, { '@productId': [101, 102, 103], catalogGroupId: 1 });
});

test('modern offer ID lookup validates the returned ID and obtains actual base price/currency', async () => {
  const routes = productRoutes();
  routes['catalog.product.get'] = { error: 'ERROR_NOT_FOUND' };
  routes['catalog.product.offer.get'] = { data: { offer: { id: 101, name: 'Вариация А', type: 4 } } };
  const { api } = await adapter(routes);
  assert.deepEqual(await api.getProduct('101'), { id: '101', name: 'Вариация А', basePrice: 38600, currency: 'RUB', verified: true, source: 'catalog.product.offer.get' });
});

test('SKU parent, missing price, tier prices and missing currency never become verified zero-price products', async () => {
  const parent = productRoutes();
  parent['catalog.product.get'] = { data: { product: { id: 101, name: 'Головной товар', type: 3 } } };
  await assert.rejects((await adapter(parent)).api.getProduct(101), /торговое предложение/);
  for (const prices of [[], [{ productId: 101, catalogGroupId: 1, price: 1, currency: 'RUB', quantityFrom: 10 }], [{ productId: 101, catalogGroupId: 1, price: 10 }]]) {
    const routes = productRoutes();
    routes['catalog.price.list'] = { data: { prices } };
    await assert.rejects((await adapter(routes)).api.getProduct(101), /базовая цена|валюту/);
  }
});

test('legacy fallback validates exact ID, price and CURRENCY_ID when modern price API is unavailable', async () => {
  const routes = { 'crm.product.get': { data: { ID: '101', NAME: 'Старый каталог', PRICE: '50.25', CURRENCY_ID: 'RUB' } } };
  const { api } = await adapter(routes);
  assert.equal((await api.getProduct(101)).basePrice, 50.25);
  routes['crm.product.get'] = { data: { ID: '102', NAME: 'Другой товар', PRICE: 50, CURRENCY_ID: 'RUB' } };
  await assert.rejects(api.getProduct(101), /другой ID/);
});

test('legacy fallback does not bypass modern price access denial', async () => {
  const routes = { 'crm.product.get': { data: { ID: '101', NAME: 'Товар', PRICE: 50, CURRENCY_ID: 'RUB' } },
    'catalog.priceType.list': { error: 'ACCESS_DENIED' } };
  await assert.rejects((await adapter(routes)).api.getProduct(101), /ACCESS_DENIED/);
});

test('legacy catalog search paginates and validates each result with crm.product.get', async () => {
  const routes = {
    'crm.catalog.list': { data: [{ ID: '3' }] },
    'crm.product.list': { pages: [[{ ID: '101' }], [{ ID: '102' }]] },
    'crm.product.get': params => ({ data: { ID: String(params.id), NAME: `Товар ${params.id}`, PRICE: 50, CURRENCY_ID: 'RUB' } }),
  };
  const { api, sdk } = await adapter(routes);
  assert.equal((await api.searchProducts('Товар')).length, 2);
  assert.deepEqual(sdk.calls.find(call => call.method === 'crm.product.list').params.filter, { CATALOG_ID: 3, ACTIVE: 'Y', '%NAME': 'Товар' });
  assert.equal(sdk.calls.filter(call => call.method === 'crm.product.get').length, 2);
});

test('loadDeal retains negotiated prices and all original metadata for a replacement fingerprint', async () => {
  const server = dealRoutes();
  server.routes['crm.deal.get'] = { data: { ID: '12', TITLE: 'Пилот', COMPANY_ID: '5', CURRENCY_ID: 'RUB' } };
  server.routes['crm.company.get'] = { data: { ID: '5', TITLE: 'ООО «Пилот»' } };
  const { api } = await adapter(server.routes);
  const deal = await api.loadDeal(12);
  assert.equal(deal.companyName, 'ООО «Пилот»');
  assert.equal(deal.rows[0].unitPrice, 200);
  assert.equal(deal.rows[0].raw.ID, '77');
  const changed = structuredClone(deal.rows);
  changed[0].raw.QUANTITY = 2;
  assert.notEqual(fingerprintRows(changed), fingerprintRows(deal.rows));
});

test('Disk reader uses credentials and content version; network/CORS errors never leak download tokens', async () => {
  let request;
  const routes = { 'disk.file.get': { data: { ID: '9', NAME: 'relations.json', TYPE: 'file', GLOBAL_CONTENT_VERSION: '4', DOWNLOAD_URL: 'https://portal.example/rest/download?auth=secret' } } };
  const { api } = await adapter(routes, { fetch: async (url, options) => { request = { url, options }; return { ok: true, text: async () => '{"version":1}' }; } });
  assert.deepEqual(await api.loadDiskJson(9), { data: { version: 1 }, fileId: '9', version: '4', name: 'relations.json' });
  assert.equal(request.options.credentials, 'include');
  api.fetch = async () => { throw new Error('https://portal.example/?auth=secret'); };
  await assert.rejects(api.loadDiskJson(9), error => /CORS/.test(error.message) && !/secret/.test(error.message));
});

test('Disk reader rejects unsafe URLs, wrong IDs and HTML login response', async () => {
  const routes = { 'disk.file.get': { data: { ID: '9', DOWNLOAD_URL: 'javascript:alert(1)' } } };
  const { api } = await adapter(routes, { fetch: async () => ({ ok: true, text: async () => '<html>login</html>' }) });
  await assert.rejects(api.loadDiskJson(9), /HTTPS/);
  routes['disk.file.get'] = { data: { ID: '10', DOWNLOAD_URL: 'https://portal.example/file' } };
  await assert.rejects(api.loadDiskJson(9), /другой ID/);
  routes['disk.file.get'] = { data: { ID: '9', DOWNLOAD_URL: 'https://portal.example/file' } };
  await assert.rejects(api.loadDiskJson(9), /страницу авторизации/);
});

test('placement registration is explicit, removes auth query, and skips an existing binding', async () => {
  const routes = { 'placement.get': { data: [] }, 'placement.bind': { data: true } };
  const { api, sdk } = await adapter(routes, { location: { origin: 'https://calc.example', pathname: '/index.php', href: 'https://calc.example/index.php?AUTH_ID=secret' } });
  await api.registerPlacement('Конструктор КП');
  assert.deepEqual(sdk.calls.at(-1).params, { PLACEMENT: 'CRM_DEAL_DETAIL_TAB', HANDLER: 'https://calc.example/index.php', TITLE: 'Конструктор КП', LANG_ALL: { ru: { TITLE: 'Конструктор КП' } } });
  routes['placement.get'] = { data: [{ placement: 'CRM_DEAL_DETAIL_TAB', handler: 'https://calc.example/index.php' }] };
  assert.equal((await api.registerPlacement()).existing, true);
  assert.equal(sdk.calls.filter(call => call.method === 'placement.bind').length, 1);
});

test('immutable snapshot upload uses documented fileContent tuple, UTF-8 and verifies readback', async () => {
  let stored;
  const name = 'yuzm-kp-deal-12-variant-a-v1-snapshot-1.json';
  const routes = {
    'disk.folder.uploadFile': params => { stored = JSON.parse(Buffer.from(params.fileContent[1], 'base64').toString('utf8')); return { data: { ID: '44', NAME: params.data.NAME } }; },
    'disk.file.get': { data: { ID: '44', NAME: name, DOWNLOAD_URL: 'https://portal.example/file' } },
  };
  const { api, sdk } = await adapter(routes, { fetch: async () => ({ ok: true, text: async () => JSON.stringify(stored) }) });
  const result = await api.saveSnapshot(10, snapshot());
  assert.deepEqual(result, { fileId: '44', name });
  const uploaded = sdk.calls.find(call => call.method === 'disk.folder.uploadFile').params;
  assert.equal(uploaded.generateUniqueName, false);
  assert.equal(uploaded.fileContent[0], name);
  assert.equal(stored.rows[0].productName, 'Товар 101');
  assert.equal('fileData' in uploaded, false);
  assert.equal(sdk.calls.some(call => /update|delete/i.test(call.method)), false);
});

test('uploaded snapshot with unsupported reading is reported unverified, not shared-history success', async () => {
  const name = 'yuzm-kp-deal-12-variant-a-v1-snapshot-1.json';
  const routes = { 'disk.folder.uploadFile': { data: { ID: '44', NAME: name } },
    'disk.file.get': { data: { ID: '44', NAME: name, DOWNLOAD_URL: 'https://portal.example/file?auth=secret' } } };
  const { api } = await adapter(routes, { fetch: async () => { throw new Error('auth=secret'); } });
  await assert.rejects(api.saveSnapshot(10, snapshot()), error => error.code === 'UPLOAD_UNVERIFIED' && error.fileId === '44' && !error.message.includes('secret'));
});

test('history loads all pages, only current deal files and fails on corrupt matching snapshots', async () => {
  const first = snapshot();
  const second = snapshot({ version: 2, snapshotId: 'snapshot-2', createdAt: '2026-10-08T11:00:00Z' });
  const names = ['yuzm-kp-deal-12-variant-a-v1-snapshot-1.json', 'yuzm-kp-deal-12-variant-a-v2-snapshot-2.json'];
  const routes = {
    'disk.folder.getChildren': { pages: [
      [{ ID: '41', NAME: names[0], TYPE: 'file' }, { ID: '99', NAME: 'yuzm-kp-deal-999-other.json', TYPE: 'file' }],
      [{ ID: '42', NAME: names[1], TYPE: 'file' }],
    ] },
    'disk.file.get': params => ({ data: { ID: String(params.id), NAME: names[params.id - 41], DOWNLOAD_URL: `https://portal.example/${params.id}` } }),
  };
  const { api, sdk } = await adapter(routes, { fetch: async url => ({ ok: true, text: async () => JSON.stringify(url.endsWith('/41') ? first : second) }) });
  assert.deepEqual((await api.loadHistory(10, 12)).map(item => item.version), [2, 1]);
  assert.equal(sdk.calls.some(call => call.method === 'disk.file.get' && call.params.id === 99), false);
  api.fetch = async () => ({ ok: true, text: async () => '{"dealId":"999","rows":[]}' });
  await assert.rejects(api.loadHistory(10, 12), /структуре снимка/);
});

test('apply replaces complete rows, checks preview fingerprint and verifies negotiated prices by readback', async () => {
  const server = dealRoutes();
  const { api, sdk } = await adapter(server.routes);
  const preview = await api.loadDeal(12);
  const result = await api.applyToDeal(12, snapshot(), fingerprintRows(preview.rows));
  assert.equal(result.verified, true);
  assert.equal(server.getRows().length, 1);
  assert.equal(server.getRows()[0].PRICE, 110);
  const replacement = sdk.calls.find(call => call.method === 'crm.item.productrow.set');
  assert.equal(replacement.params.ownerType, 'D');
  assert.equal(replacement.params.ownerId, 12);
  assert.equal(replacement.params.productRows.length, 1);
  assert.equal(sdk.calls.some(call => call.method.includes('.add')), false);
});

test('concurrent changes and missing preview prevent replacing any deal rows', async () => {
  const server = dealRoutes();
  const { api, sdk } = await adapter(server.routes);
  const preview = await api.loadDeal(12);
  server.setRows([{ ...server.getRows()[0], QUANTITY: 3 }]);
  await assert.rejects(api.applyToDeal(12, snapshot(), fingerprintRows(preview.rows)), /изменились/);
  await assert.rejects(api.applyToDeal(12, snapshot()), /подтверждение/);
  assert.equal(sdk.calls.some(call => call.method.endsWith('.set')), false);
});

test('CRM fallback happens only on missing modern method, without append, and readback mismatch is visible', async () => {
  const server = dealRoutes();
  server.routes['crm.item.productrow.set'] = { error: 'ERROR_METHOD_NOT_FOUND' };
  server.routes['crm.deal.productrows.set'] = params => { server.setRows(params.rows.map((row, index) => ({ ID: String(10 + index), ...row }))); return { data: true }; };
  const { api } = await adapter(server.routes);
  const preview = await api.loadDeal(12);
  assert.equal((await api.applyToDeal(12, snapshot(), fingerprintRows(preview.rows))).method, 'crm.deal.productrows.set');
  server.routes['crm.deal.productrows.set'] = () => ({ data: true });
  const latest = await api.loadDeal(12);
  await assert.rejects(api.applyToDeal(12, snapshot({ rows: [{ productId: '101', productName: 'Товар', quantity: 2, unitPrice: 120, currency: 'RUB' }], total: 240 }), fingerprintRows(latest.rows)), error => error.code === 'WRITE_UNVERIFIED');
});

test('currency mismatch, negative modeled price and incompatible rounding prevent writing', async () => {
  const server = dealRoutes();
  const { api, sdk } = await adapter(server.routes);
  const preview = await api.loadDeal(12);
  const fingerprint = fingerprintRows(preview.rows);
  await assert.rejects(api.applyToDeal(12, snapshot({ currency: 'USD' }), fingerprint), /валюты/);
  await assert.rejects(api.applyToDeal(12, snapshot({ rows: [{ productId: '101', quantity: 1, unitPrice: -10, currency: 'RUB' }], total: -10 }), fingerprint), /Отрицательная цена/);
  await assert.rejects(api.applyToDeal(12, snapshot({ total: 220.04 }), fingerprint), /округление/);
  assert.equal(sdk.calls.some(call => call.method.endsWith('.set')), false);
});

test('existing VAT metadata is normalized and preserved during full deal replacement', async () => {
  const server = dealRoutes();
  server.setRows([{ ...server.getRows()[0], TAX_RATE: '20', TAX_INCLUDED: 'Y' }]);
  const { api, sdk } = await adapter(server.routes);
  const preview = await api.loadDeal(12);
  assert.equal(preview.rows[0].taxRate, 20);
  assert.equal(preview.rows[0].taxIncluded, 'Y');
  const quote = snapshot({ rows: [{ ...snapshot().rows[0], taxRate: 20, taxIncluded: 'Y' }] });
  const result = await api.applyToDeal(12, quote, fingerprintRows(preview.rows));
  assert.equal(result.rows[0].taxRate, 20);
  const params = sdk.calls.find(call => call.method === 'crm.item.productrow.set').params;
  assert.equal(params.productRows[0].taxRate, 20);
  assert.equal(params.productRows[0].taxIncluded, 'Y');
});
