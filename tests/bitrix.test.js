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

test('manager signature reads the current responsible user and selects only work contact fields', async () => {
  const profile = {ID: '27', NAME: 'Иван', LAST_NAME: 'Петров', WORK_POSITION: 'Менеджер', WORK_PHONE: '+7 495 123-45-67', PERSONAL_MOBILE: 'Do not use this'};
  const {api, sdk} = await adapter({
    'crm.deal.get': {data: {ID: '12', ASSIGNED_BY_ID: '27', CREATED_BY_ID: '99'}},
    'user.get': {data: [profile]},
  });
  assert.deepEqual(await api.getResponsibleManager(12), {dealId: '12', userId: '27', name: 'Иван Петров', position: 'Менеджер', workPhone: '+7 495 123-45-67', phoneAvailable: true});
  assert.deepEqual(sdk.calls.at(-1).params, {FILTER: {ID: 27}, select: ['ID', 'NAME', 'LAST_NAME', 'WORK_POSITION', 'WORK_PHONE']});
  assert.deepEqual(sdk.calls.map(call => call.method), ['crm.deal.get', 'user.get']);
});

test('missing work phone never falls back to mobile, and omitted scope fields are distinguished', async () => {
  for (const phone of ['', null, undefined]) {
    const profile = {ID: 27, NAME: 'Иван', LAST_NAME: 'Петров', PERSONAL_MOBILE: '+7 900 999-99-99'};
    if (phone !== undefined) profile.WORK_PHONE = phone;
    const {api} = await adapter({
      'crm.deal.get': {data: {ID: 12, ASSIGNED_BY_ID: 27}}, 'user.get': {data: [profile]},
    });
    const manager = await api.getResponsibleManager(12);
    assert.equal(manager.workPhone, '');
    assert.equal(manager.phoneAvailable, phone !== undefined);
    assert.equal(manager.position, '');
  }
});

test('manager lookup refuses a different user, malformed profiles and missing deal owner', async () => {
  for (const data of [[], {}, [{ID: 99, NAME: 'Создатель'}], [{ID: 27}, {ID: 28}], [{ID: 27, NAME: {}}]]) {
    const {api} = await adapter({
      'crm.deal.get': {data: {ID: 12, ASSIGNED_BY_ID: 27}}, 'user.get': {data},
    });
    await assert.rejects(api.getResponsibleManager(12));
  }
  for (const deal of [{ID: 99, ASSIGNED_BY_ID: 27}, {ID: 12, CREATED_BY_ID: 99}]) {
    const {api, sdk} = await adapter({'crm.deal.get': {data: deal}});
    await assert.rejects(api.getResponsibleManager(12));
    assert.equal(sdk.calls.some(call => call.method === 'user.get'), false);
  }
  const {api} = await adapter({
    'crm.deal.get': {data: {ID: 12, ASSIGNED_BY_ID: 27}},
    'user.get': {error: 'insufficient_scope', description: 'token=private'},
  });
  await assert.rejects(api.getResponsibleManager(12), error => error.code === 'insufficient_scope' && !error.message.includes('private'));
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

test('SDK arriving after adapter construction is picked up during init', async () => {
  const previous = globalThis.BX24;
  try {
    delete globalThis.BX24;
    const api = new BitrixAdapter();
    globalThis.BX24 = sdkMock({});
    assert.deepEqual(await api.init(), {connected: true, dealId: '12'});
  } finally {
    if (previous === undefined) delete globalThis.BX24;
    else globalThis.BX24 = previous;
  }
});

test('init timeout is recoverable and a stale callback cannot override retry', async () => {
  let first;
  const sdk = sdkMock({});
  sdk.init = callback => { first = callback; };
  const api = new BitrixAdapter({sdk, initTimeoutMs: 5});
  assert.deepEqual(await api.init(), {connected: false, dealId: null});
  assert.equal(api.connectionError.code, 'INIT_TIMEOUT');
  sdk.init = callback => queueMicrotask(callback);
  assert.deepEqual(await api.init(), {connected: true, dealId: '12'});
  first();
  assert.equal(api.connected, true);
  assert.equal(api.connectionError, null);
  assert.deepEqual(sdk.calls, []);
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
  assert.deepEqual(await api.getProduct('101'), { id: '101', name: 'Вариация А', basePrice: 38600, currency: 'RUB', verified: true, source: 'catalog.product.offer.get', isVariation: true, parentProductId: '' });
});

function variationRoutes() {
  const heads = [
    {id: 401, iblockId: 7, name: 'Опора семейство', type: 3, active: 'Y'},
    {id: 402, iblockId: 7, name: 'Пустое семейство', type: 6, active: 'Y'},
  ];
  const offers = [
    {id: 411, iblockId: 8, name: 'Исполнение 100', type: 4, active: 'Y', parentId: {value: '401', valueId: '901'}},
    {id: 412, iblockId: 8, name: 'Исполнение 200', type: 4, active: 'Y', parentId: 401},
    {id: 413, iblockId: 8, name: 'Архивное исполнение', type: 4, active: 'N', parentId: 401},
  ];
  const matches = (row, filter) => (!filter['%name'] || row.name.includes(filter['%name'])) && row.active !== 'N';
  return {
    ...productRoutes(),
    'catalog.catalog.list': {data: {catalogs: [{id:7, iblockId:7, productIblockId:0}, {id:8, iblockId:8, productIblockId:7, skuPropertyId:21}]}},
    'catalog.product.list': {data: {products: []}},
    'catalog.product.sku.list': params => ({data: {units: heads.filter(row => matches(row, params.filter))}}),
    'catalog.product.get': {error:'ERROR_NOT_FOUND'},
    'catalog.product.sku.get': params => ({data: {sku: heads.find(row => row.id === params.id)}}),
    'catalog.product.offer.get': params => ({data: {offer: offers.find(row => row.id === params.id)}}),
    'catalog.product.offer.list': params => ({data: {offers: offers.filter(row => {
      const parentIds = params.filter['@parentId'] || (params.filter.parentId ? [params.filter.parentId] : null);
      return matches(row, params.filter) && (!parentIds || parentIds.includes(Number(variationParentValue(row))));
    })}}),
    'catalog.price.list': params => ({data: {prices: params.filter['@productId'].map(productId => ({
      id:productId, productId, catalogGroupId:1, price: productId === 411 ? 133 : productId === 412 ? 233 : 999, currency:'RUB',
    }))}}),
  };
}

function variationParentValue(row) { return row.parentId?.value ?? row.parentId; }

test('parent name and ID expand to active variations with their own IDs, names and prices', async () => {
  const {api, sdk} = await adapter(variationRoutes());
  for (const query of ['Опора семейство', '401']) {
    const found = await api.searchProducts(query);
    assert.deepEqual(found.map(row => [row.id, row.name, row.basePrice, row.parentProductId, row.parentProductName, row.isVariation]), [
      ['411','Исполнение 100',133,'401','Опора семейство',true],
      ['412','Исполнение 200',233,'401','Опора семейство',true],
    ]);
  }
  const priceIds = sdk.calls.filter(call => call.method === 'catalog.price.list').flatMap(call => call.params.filter['@productId']);
  assert.ok(priceIds.every(productId => [411,412].includes(productId)));
  assert.equal(sdk.calls.find(call => call.method === 'catalog.product.offer.list' && call.params.filter.parentId).params.filter.iblockId, 8);
  await assert.rejects(api.getProduct(401), /торговое предложение/);
  assert.deepEqual(await api.searchProducts('402'), []);
});

test('search by variation name or ID remains exact and normalizes the API parent-link object', async () => {
  const {api} = await adapter(variationRoutes());
  for (const query of ['Исполнение 100', '411']) {
    const found = await api.searchProducts(query);
    assert.deepEqual(found.map(row => [row.id, row.basePrice, row.parentProductId]), [['411',133,'401']]);
  }
  assert.equal((await api.getProduct(411)).id, '411');
});

test('parent and offer pages are complete and duplicate variation matches appear once', async () => {
  const routes = variationRoutes();
  routes['catalog.product.sku.list'] = {pages: [
    {units:[{id:401,iblockId:7,name:'Семейство',type:3,active:'Y'}]},
    {units:[{id:404,iblockId:7,name:'Семейство 2',type:3,active:'Y'}]},
  ]};
  routes['catalog.product.offer.list'] = {pages: [
    {offers:[{id:411,iblockId:8,name:'Семейство 100',type:4,active:'Y',parentId:{value:'401'}}]},
    {offers:[{id:412,iblockId:8,name:'Семейство 200',type:4,active:'Y',parentId:{value:'404'}}]},
  ]};
  const {api,sdk} = await adapter(routes);
  const found = await api.searchProducts('Семейство');
  assert.deepEqual(found.map(row => row.id), ['411','412']);
  assert.deepEqual(sdk.calls.find(call => call.method === 'catalog.product.offer.list' && call.params.filter['@parentId']).params.filter['@parentId'], [401,404]);
});

test('variation search rejects incorrect parent bindings and never substitutes a parent price', async () => {
  const wrong = variationRoutes();
  wrong['catalog.product.offer.list'] = {data:{offers:[{id:411,iblockId:8,name:'Чужая вариация',type:4,parentId:{value:'999'}}]}};
  await assert.rejects((await adapter(wrong)).api.searchProducts('401'), /другого основного товара/);
  const missing = variationRoutes();
  missing['catalog.price.list'] = {data:{prices:[]}};
  await assert.rejects((await adapter(missing)).api.searchProducts('401'), /базовая цена отсутствует/);
  const denied = variationRoutes();
  denied['catalog.product.sku.list'] = {error:'ACCESS_DENIED'};
  await assert.rejects((await adapter(denied)).api.searchProducts('Опора'), /ACCESS_DENIED/);
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

function documentRoutes(overrides = {}) {
  return {
    ...dealRoutes().routes,
    'crm.deal.get': { data: { ID: '12', CATEGORY_ID: '3', CURRENCY_ID: 'RUB', TITLE: 'Текущая сделка' } },
    'crm.documentgenerator.template.get': { data: { template: {
      id: '39', name: 'КП ЮЗМ', active: 'Y', isDeleted: 'N', entityTypeId: ['2_category_3'],
    } } },
    'crm.documentgenerator.document.add': { data: { document: {
      id: 61, title: 'КП ЮЗМ 1', templateId: '39', entityTypeId: '2', entityId: '12',
      downloadUrl: 'https://portal.example/bitrix/document?id=61',
    } } },
    ...overrides,
  };
}

function documentSnapshot(overrides = {}) {
  return snapshot({
    companyName: 'ООО «Клиент из версии КП»', total: 221.06,
    config: { currency: 'RUB', coatings: [
      { code: 'zinc', name: 'Цинкование' }, { code: 'paint', name: 'Окраска RAL 9005' },
    ] },
    documentFields: { YuzmPaymentTerms: 'Аванс 50%', YuzmManagerName: 'Иван Петров' },
    rows: [
      { productId: '101', productName: 'Изделие версии А', coatingCode: 'zinc',
        quantity: 2, unitPrice: 100.25, lineTotal: 200.5, currency: 'RUB', executionTerm: '10 рабочих дней', valid: true },
      { productId: '102', productName: 'Изделие версии Б', coatingCode: 'paint',
        quantity: 3, unitPrice: 6.85, lineTotal: 20.56, currency: 'RUB', executionTerm: '25 рабочих дней', valid: true },
    ],
    ...overrides,
  });
}

test('registered templates accept object pages and filter inactive, deleted and other deal categories', async () => {
  const { api, sdk } = await adapter(documentRoutes({
    'crm.documentgenerator.template.list': { pages: [
      { templates: {
        39: { id: '39', name: 'Все сделки', active: 'Y', isDeleted: 'N', entityTypeId: ['2'] },
        40: { id: '40', name: 'Другое направление', active: 'Y', entityTypeId: ['2_category_7'] },
      } },
      { templates: {
        41: { id: '41', name: 'Направление 3', active: 'Y', entityTypeId: ['2_category_3'] },
        42: { id: '42', name: 'Неактивный', active: 'N', entityTypeId: ['2'] },
        43: { id: '43', name: 'Удалённый', active: 'Y', isDeleted: 'Y', entityTypeId: ['2'] },
      } },
    ] },
  }));
  assert.deepEqual(await api.listDocumentTemplates(12), [
    { id: '39', name: 'Все сделки' }, { id: '41', name: 'Направление 3' },
  ]);
  const request = sdk.calls.find(call => call.method === 'crm.documentgenerator.template.list');
  assert.deepEqual(request.params.filter.entityTypeId, ['2', '2_category_3']);
  assert.equal(request.params.filter.active, 'Y');
  assert.equal(sdk.calls.some(call => call.method.endsWith('.add') || call.method.endsWith('.set')), false);
});

test('template arrays remain supported and object-shaped catalog pages remain invalid', async () => {
  const { api } = await adapter(documentRoutes({
    'crm.documentgenerator.template.list': { data: { templates: [
      { id: '39', name: 'КП', active: 'Y', entityTypeId: ['2'] },
    ] } },
    'catalog.catalog.list': { data: { catalogs: { 7: { id: 7 } } } },
  }));
  assert.deepEqual(await api.listDocumentTemplates(12), [{ id: '39', name: 'КП' }]);
  await assert.rejects(api.searchProducts(), /нет массива catalogs/);
});

test('template listing keeps access errors and never exposes auth descriptions', async () => {
  const { api } = await adapter(documentRoutes({
    'crm.documentgenerator.template.list': { error: 'DOCGEN_ACCESS_ERROR', description: 'https://portal.example/?auth=secret' },
  }));
  await assert.rejects(api.listDocumentTemplates(12), error => error.code === 'DOCGEN_ACCESS_ERROR'
    && !error.message.includes('secret'));
});

test('document creation transfers the saved KP rows before creating a document with matching fields', async () => {
  const { api, sdk } = await adapter(documentRoutes());
  const quote = documentSnapshot({ documentFields: {
    YuzmPaymentTerms: 'Аванс 50%', YuzmManagerName: 'Иван Петров',
    DocumentNumber: 'Do not override native numbering', arbitrary: 'Not an allowed template field',
  } });
  const original = structuredClone(quote);
  assert.deepEqual(await api.createQuoteDocument(12, 39, quote), {
    id: '61', title: 'КП ЮЗМ 1', downloadUrl: 'https://portal.example/bitrix/document?id=61',
    pdfUrl: '', publicUrl: '', conversionError: false,
  });
  assert.deepEqual(quote, original);
  const request = sdk.calls.find(call => call.method === 'crm.documentgenerator.document.add').params;
  assert.equal(request.templateId, 39);
  assert.equal(request.entityTypeId, 2);
  assert.equal(request.entityId, 12);
  assert.deepEqual(request.values.KpItems, [
    { Name: 'Изделие версии А', Coating: 'Цинкование', Quantity: '2', Price: '100,25', Total: '200,50', ExecutionTerm: '10 рабочих дней' },
    { Name: 'Изделие версии Б', Coating: 'Окраска RAL 9005', Quantity: '3', Price: '6,85', Total: '20,56', ExecutionTerm: '25 рабочих дней' },
  ]);
  assert.deepEqual(request.fields.KpItems, {
    PROVIDER: 'Bitrix\\DocumentGenerator\\DataProvider\\ArrayDataProvider',
    OPTIONS: { ITEM_NAME: 'Item', ITEM_PROVIDER: 'Bitrix\\DocumentGenerator\\DataProvider\\HashDataProvider' },
  });
  assert.deepEqual(request.fields.ProductsIndex, { VALUE: 'KpItems.INDEX' });
  assert.deepEqual(request.fields.ProductsProductName, { VALUE: 'KpItems.Item.Name' });
  assert.deepEqual(request.fields.YuzmCoating, { VALUE: 'KpItems.Item.Coating' });
  assert.deepEqual(request.fields.ProductsProductQuantity, { VALUE: 'KpItems.Item.Quantity' });
  assert.deepEqual(request.fields.ProductsProductPriceBrutto, { VALUE: 'KpItems.Item.Price' });
  assert.deepEqual(request.fields.ProductsProductPriceBruttoSum, { VALUE: 'KpItems.Item.Total' });
  assert.deepEqual(request.fields.YuzmDeliveryPeriod, { VALUE: 'KpItems.Item.ExecutionTerm' });
  assert.deepEqual(request.fields.RequisiteRqCompanyName, { VALUE: quote.companyName });
  assert.deepEqual(request.fields.TotalSum, { VALUE: '221,06' });
  assert.deepEqual(request.fields.YuzmPaymentTerms, { VALUE: 'Аванс 50%' });
  assert.deepEqual(request.fields.YuzmDeliveryTerms, { VALUE: '' });
  assert.deepEqual(request.fields.YuzmManagerName, { VALUE: 'Иван Петров' });
  assert.equal('DocumentNumber' in request.fields, false);
  assert.equal('DocumentCreateTime' in request.fields, false);
  assert.equal('arbitrary' in request.fields, false);
  const writeIndex = sdk.calls.findIndex(call => call.method === 'crm.item.productrow.set');
  const readbackIndex = sdk.calls.findLastIndex(call => call.method === 'crm.deal.productrows.get');
  const addIndex = sdk.calls.findIndex(call => call.method === 'crm.documentgenerator.document.add');
  assert.ok(writeIndex > 0 && readbackIndex > writeIndex && addIndex > readbackIndex);
  assert.deepEqual(sdk.calls[writeIndex].params.productRows.map(row => [row.productId, row.price, row.quantity]), [[101, 100.25, 2], [102, 6.85, 3]]);
});

test('document quantity accepts calculator numeric syntax and preserves entered commercial text', async () => {
  const { api, sdk } = await adapter(documentRoutes());
  const quote = documentSnapshot({
    total: 1000.5,
    documentFields: { YuzmPaymentTerms: '  Аванс 50%\nОстаток перед отгрузкой  ' },
    rows: [{ ...documentSnapshot().rows[0], quantity: '1 000,5', unitPrice: 1,
      lineTotal: 1000.5, executionTerm: '  10–15 рабочих дней\nпосле оплаты  ' }],
  });
  await api.createQuoteDocument(12, 39, quote);
  const request = sdk.calls.find(call => call.method === 'crm.documentgenerator.document.add').params;
  assert.equal(request.values.KpItems[0].Quantity, '1000,5');
  assert.equal(request.values.KpItems[0].ExecutionTerm, quote.rows[0].executionTerm);
  assert.deepEqual(request.fields.YuzmPaymentTerms, { VALUE: quote.documentFields.YuzmPaymentTerms });
  for (const quantity of ['1\u00a0000,5', '1\u202f000,5']) {
    await api.createQuoteDocument(12, 39, { ...quote, rows: [{ ...quote.rows[0], quantity }] });
    assert.equal(sdk.calls.at(-1).params.values.KpItems[0].Quantity, '1000,5');
  }
  for (const quantity of ['10 00,5', '1 000  ,5']) {
    await assert.rejects(api.createQuoteDocument(12, 39, { ...quote, rows: [{ ...quote.rows[0], quantity }] }), /Количество/);
  }
});

test('document text rejects whitespace-only required fields, controls and excessive length before add', async () => {
  const { api, sdk } = await adapter(documentRoutes());
  const quote = documentSnapshot();
  for (const overrides of [
    { companyName: '   ' },
    { documentFields: { YuzmPaymentTerms: 'Недопустимый\u0000текст' } },
    { documentFields: { YuzmPaymentTerms: 'А'.repeat(10001) } },
    { rows: [{ ...quote.rows[0], productName: '   ' }] },
    { rows: [{ ...quote.rows[0], executionTerm: 'Срок\u0007' }] },
  ]) {
    await assert.rejects(api.createQuoteDocument(12, 39, documentSnapshot(overrides)));
  }
  assert.equal(sdk.calls.some(call => call.method.endsWith('.add')), false);
});

test('document creation rejects missing, deactivated, deleted and wrong-category templates before add', async () => {
  for (const template of [undefined,
    { id: '39', name: 'КП', active: 'N', entityTypeId: ['2'] },
    { id: '39', name: 'КП', active: 'Y', isDeleted: 'Y', entityTypeId: ['2'] },
    { id: '39', name: 'КП', active: 'Y', entityTypeId: ['2_category_7'] },
    { id: '40', name: 'КП', active: 'Y', entityTypeId: ['2'] },
  ]) {
    const { api, sdk } = await adapter(documentRoutes({
      'crm.documentgenerator.template.get': { data: { template } },
    }));
    await assert.rejects(api.createQuoteDocument(12, 39, documentSnapshot()), /шаблон/i);
    assert.equal(sdk.calls.some(call => call.method.endsWith('.add')), false);
    assert.equal(sdk.calls.some(call => call.method.endsWith('.set')), false);
  }
});

test('nonexistent deals and missing or invalid categories never consume a document number', async () => {
  for (const deal of [null, { ID: '99', CATEGORY_ID: 3, CURRENCY_ID: 'RUB' },
    { ID: '12', CURRENCY_ID: 'RUB' }, { ID: '12', CATEGORY_ID: -1, CURRENCY_ID: 'RUB' }]) {
    const { api, sdk } = await adapter(documentRoutes({ 'crm.deal.get': { data: deal } }));
    await assert.rejects(api.createQuoteDocument(12, 39, documentSnapshot()), /сделк/);
    assert.equal(sdk.calls.length, 1);
  }
});

test('wrong snapshot scope, invalid money or totals and mixed currencies cannot reach document.add', async () => {
  const quote = documentSnapshot();
  for (const overrides of [
    { dealId: '99' }, { total: 300 }, { total: Infinity }, { valid: false }, { companyName: '' },
    { rows: [] }, { rows: [{ ...quote.rows[0], unitPrice: -1 }] },
    { rows: [{ ...quote.rows[0], lineTotal: -1 }] },
    { rows: [{ ...quote.rows[0], unitPrice: NaN }] },
    { rows: [{ ...quote.rows[0], quantity: 0 }] },
    { rows: [{ ...quote.rows[0], quantity: [1] }] },
    { rows: [{ ...quote.rows[0], currency: 'USD' }] },
    { rows: [{ ...quote.rows[0], valid: false }] },
  ]) {
    const { api, sdk } = await adapter(documentRoutes());
    await assert.rejects(api.createQuoteDocument(12, 39, documentSnapshot(overrides)));
    assert.equal(sdk.calls.some(call => call.method.endsWith('.add')), false);
  }
  const { api, sdk } = await adapter(documentRoutes({
    'crm.deal.get': { data: { ID: '12', CATEGORY_ID: 3, CURRENCY_ID: 'USD' } },
  }));
  await assert.rejects(api.createQuoteDocument(12, 39, quote), /Валюта сделки/);
  assert.equal(sdk.calls.some(call => call.method.endsWith('.add')), false);
});

test('failed or malformed creation cannot become successful or automatically retry add', async () => {
  for (const result of [
    { error: 'DOCGEN_LIMIT_ERROR', description: 'https://portal.example/?auth=secret' },
    { data: {} }, { data: { document: {} } },
    { data: { document: { id: 61, templateId: '99' } } },
  ]) {
    const { api, sdk } = await adapter(documentRoutes({ 'crm.documentgenerator.document.add': result }));
    await assert.rejects(api.createQuoteDocument(12, 39, documentSnapshot()), error => !error.message.includes('secret'));
    assert.equal(sdk.calls.filter(call => call.method.endsWith('.add')).length, 1);
  }
  const { api } = await adapter(documentRoutes({
    'crm.documentgenerator.document.add': { data: { document: {
      id: '61', downloadUrl: 'javascript:alert("secret")',
    } } },
  }));
  await assert.rejects(api.createQuoteDocument(12, 39, documentSnapshot()), error =>
    error.code === 'DOCUMENT_RESPONSE_UNVERIFIED' && error.documentId === '61' && !error.message.includes('secret'));
});

test('document refresh obtains asynchronous PDF with portal-relative URLs without creating another document', async () => {
  const routes = documentRoutes({
    'crm.documentgenerator.document.get': { data: { document: {
      id: '61', title: 'КП ЮЗМ 1', downloadUrl: '/bitrix/document?id=61', pdfUrl: '/bitrix/pdf?id=61', publicUrl: null,
    } } },
  });
  const { api, sdk } = await adapter(routes, { location: { href: 'https://app.example/index.php' } });
  sdk.getDomain = () => 'portal.example';
  await api.createQuoteDocument(12, 39, documentSnapshot());
  const refreshed = await api.getQuoteDocument(61);
  assert.equal(refreshed.downloadUrl, 'https://portal.example/bitrix/document?id=61');
  assert.equal(refreshed.pdfUrl, 'https://portal.example/bitrix/pdf?id=61');
  assert.equal(sdk.calls.filter(call => call.method.endsWith('.add')).length, 1);
  assert.equal(sdk.calls.at(-1).method, 'crm.documentgenerator.document.get');
  assert.deepEqual(sdk.calls.at(-1).params, { id: 61 });
});

test('RAL is transferred to the document from the saved row and leaves catalog names intact', async () => {
  const { api, sdk } = await adapter(documentRoutes());
  const quote = documentSnapshot();
  quote.config.coatings[1] = {code: 'paint', name: 'Окраска', supportsRal: true};
  quote.rows[1].ralColor = '9005 матовый';
  await api.createQuoteDocument(12, 39, quote);
  const document = sdk.calls.find(call => call.method === 'crm.documentgenerator.document.add').params;
  const transfer = sdk.calls.find(call => call.method === 'crm.item.productrow.set').params;
  assert.equal(document.values.KpItems[1].Coating, 'Окраска RAL 9005 матовый');
  assert.equal(transfer.productRows[1].productName, 'Изделие версии Б');
  assert.equal(transfer.productRows[1].price, 6.85);
});

test('adjacent manager placeholders receive a separator without changing the saved signature text', async () => {
  for (const position of ['Менеджер', 'Менеджер ', 'Менеджер\n', '']) {
    const {api, sdk} = await adapter(documentRoutes());
    const quote = documentSnapshot({documentFields: {YuzmManagerPosition: position, YuzmManagerName: 'Иван Петров', YuzmManagerPhone: '+7 495 111-22-33'}});
    const original = structuredClone(quote);
    await api.createQuoteDocument(12, 39, quote);
    const fields = sdk.calls.find(call => call.method === 'crm.documentgenerator.document.add').params.fields;
    assert.equal(fields.YuzmManagerPosition.VALUE, position === 'Менеджер' ? 'Менеджер ' : position);
    assert.equal(fields.YuzmManagerName.VALUE, 'Иван Петров');
    assert.equal(fields.YuzmManagerPhone.VALUE, '+7 495 111-22-33');
    assert.deepEqual(quote, original);
  }
});

test('transfer errors, unverified readback and concurrent edits prevent document creation', async () => {
  for (const mode of ['denied', 'readback', 'conflict']) {
    const routes = documentRoutes();
    if (mode === 'denied') routes['crm.item.productrow.set'] = {error: 'ACCESS_DENIED'};
    if (mode === 'readback') routes['crm.item.productrow.set'] = () => ({data: true});
    if (mode === 'conflict') {
      const original = routes['catalog.product.get'];
      routes['catalog.product.get'] = params => {
        routes['crm.deal.productrows.get'] = () => ({data: [{PRODUCT_ID: 101, PRICE: 200, QUANTITY: 999}]});
        return original(params);
      };
    }
    const {api, sdk} = await adapter(routes);
    await assert.rejects(api.createQuoteDocument(12, 39, documentSnapshot()));
    assert.equal(sdk.calls.some(call => call.method === 'crm.documentgenerator.document.add'), false);
    if (mode === 'conflict') assert.equal(sdk.calls.some(call => call.method.endsWith('.set')), false);
  }
});

test('document responses reject unsafe links and different IDs without revealing returned URL contents', async () => {
  for (const document of [
    { id: '61', downloadUrl: 'javascript:alert(1)' },
    { id: '61', pdfUrl: 'https://user:secret@portal.example/document' },
    { id: '62', downloadUrl: 'https://portal.example/?auth=secret' },
  ]) {
    const { api } = await adapter(documentRoutes({
      'crm.documentgenerator.document.get': { data: { document } },
    }));
    await assert.rejects(api.getQuoteDocument(61), error => !/secret|javascript/.test(error.message));
  }
  const { api } = await adapter(documentRoutes({
    'crm.documentgenerator.document.get': { data: { document: {
      id: '61', downloadUrl: 'https://portal.example/file', isTransformationError: true,
      transformationErrorMessage: 'https://portal.example/?auth=secret',
    } } },
  }));
  assert.deepEqual(await api.getQuoteDocument(61), {
    id: '61', title: '', downloadUrl: 'https://portal.example/file', pdfUrl: '', publicUrl: '', conversionError: true,
  });
});


test('shared quote template is read from portal application settings, with strict ID validation', async () => {
  let value = '7';
  const {api, sdk} = await adapter({'app.option.get': () => ({data: value})});
  assert.equal(await api.getQuoteTemplateId(), '7');
  assert.deepEqual(sdk.calls.at(-1), {method:'app.option.get', params:{option:'yuzmQuoteTemplateId'}});
  for (const empty of [null, '']) {
    value = empty;
    assert.equal(await api.getQuoteTemplateId(), '');
  }
  for (const invalid of [true, [], {}, '0', 'abc', -1]) {
    value = invalid;
    await assert.rejects(api.getQuoteTemplateId());
  }
});

test('only an app administrator can save a shared quote template and read-back must confirm it', async () => {
  let value = '7', confirm = true;
  const {api, sdk} = await adapter({
    'app.option.set': params => { if (confirm) value = params.options.yuzmQuoteTemplateId; return {data:true}; },
    'app.option.get': () => ({data:value}),
  });
  await assert.rejects(api.setQuoteTemplateId('8'), /администратор/);
  assert.equal(sdk.calls.length, 0);
  sdk.isAdmin = () => true;
  await assert.rejects(api.setQuoteTemplateId('invalid'));
  assert.equal(sdk.calls.length, 0);
  assert.equal(await api.setQuoteTemplateId('8'), '8');
  assert.deepEqual(sdk.calls[0], {method:'app.option.set', params:{options:{yuzmQuoteTemplateId:'8'}}});
  confirm = false;
  await assert.rejects(api.setQuoteTemplateId('7'), /изменился при сохранении/);
});
