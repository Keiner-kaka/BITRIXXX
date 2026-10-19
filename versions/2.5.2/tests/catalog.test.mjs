import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BitrixAdapter} from '../src/bitrix.js';
import {filterCatalogEntries} from '../src/catalog.js';
import {calculateQuote, validateConfig} from '../src/calculator.js';
import {newRow} from '../src/demo.js';
import {readFile} from 'node:fs/promises';

const parents = [{id: 10, iblockId: 1, name: 'Опора гранёная НФГ-6,0-02', type: 3, active: 'Y'}];
const offers = [
  {id: 11, iblockId: 2, name: 'Цинк 6 метров', type: 4, active: 'Y', parentId: {value: 10}},
  {id: 12, iblockId: 2, name: 'Порошковая окраска', type: 4, active: 'N', parentId: 10},
];
const goods = [{id: 20, iblockId: 1, name: 'Монтаж', type: 2, active: 'Y'},
  ...Array.from({length: 620}, (_, i) => ({id: 100 + i, iblockId: 1, name: `Деталь ${i}`, type: 1, active: 'Y'}))];
const price = {id: 1, productId: 11, catalogGroupId: 1, price: '1234.50', currency: 'RUB'};
function makeAdapter({priceError = false, prices = [price], legacyOnly = false, direct, getError = false} = {}) {
  const calls = [];
  const missing = () => ({error: 'ERROR_METHOD_NOT_FOUND'});
  const handler = (method, params) => {
    if (legacyOnly && method.startsWith('catalog.')) return missing();
    if (method === 'catalog.catalog.list') return {catalogs: [{id: 1, iblockId: 1, productIblockId: 0}, {id: 2, iblockId: 2, productIblockId: 1}]};
    if (method === 'catalog.product.list') return {products: goods};
    if (method === 'catalog.product.sku.list') return {products: parents};
    // Exercise the alternate REST response key too.
    if (method === 'catalog.product.offer.list') return {products: offers};
    if (method === 'catalog.priceType.list') return priceError ? {error: 'ACCESS_DENIED'} : {priceTypes: [{id: 1, base: 'Y'}]};
    if (method === 'catalog.price.list') return priceError ? {error: 'ACCESS_DENIED'} : {prices: prices.filter(p => params.filter['@productId'].includes(p.productId))};
    if (method.endsWith('.get') && method.startsWith('catalog.product.')) {
      if (getError) return missing();
      const product = [...parents, ...offers, ...goods].find(p => p.id === params.id);
      return product ? {product: {...product, ...direct}} : {error: 'NOT_FOUND'};
    }
    if (method === 'crm.catalog.list') return [{ID: 1}];
    if (method === 'crm.product.list') return [{ID: 900, NAME: 'Товар старого каталога', PRICE: '2 345,67', CURRENCY_ID: 'RUB'}];
    if (method === 'crm.product.get') return legacyOnly ? {ID: params.id, NAME: 'Товар старого каталога', PRICE: '2 345,67', CURRENCY_ID: 'RUB'} : missing();
    return missing();
  };
  const sdk = {callMethod(method, params, callback) {
    calls.push({method, params});
    const data = handler(method, params);
    if (data.error) return callback({error: () => data.error, answer: {error: data.error}});
    const key = Array.isArray(data) ? null : Object.keys(data).find(k => Array.isArray(data[k]));
    const list = key ? data[key] : Array.isArray(data) ? data : null;
    const deliver = offset => {
      const page = list?.slice(offset, offset + 50);
      callbackResult(offset, page, cb => deliverTo(offset + 50, cb), callback);
    };
    const callbackResult = (offset, page, next, cb) => cb({error: () => false,
      data: () => list ? (key ? {[key]: page} : page) : data,
      more: () => list && offset + 50 < list.length, total: () => list?.length,
      answer: {next: offset + 50}, next});
    const deliverTo = (offset, cb) => callbackResult(offset, list?.slice(offset, offset + 50), nextCb => deliverTo(offset + 50, nextCb), cb);
    deliver(params.start ?? 0);
  }};
  const adapter = new BitrixAdapter({sdk}); adapter.connected = true;
  return {adapter, calls};
}

test('all pages, SKU parents, inactive variations and services remain searchable', async () => {
  const {adapter, calls} = makeAdapter();
  const entries = await adapter.listCatalogEntries();
  assert.equal(entries.length, 624);
  assert.ok(entries.some(p => p.id === '10'));
  assert.ok(entries.some(p => p.id === '20'));
  assert.equal(entries.find(p => p.id === '12').active, 'N');
  assert.equal(entries.find(p => p.id === '11').parentProductName, parents[0].name);
  assert.deepEqual(filterCatalogEntries(entries, 'НФГ 6.0 02', 'name').map(p => p.id).sort(), ['10', '11', '12']);
  assert.deepEqual(filterCatalogEntries(entries, '10', 'id').map(p => p.id).sort(), ['10', '11', '12']);
  assert.equal(filterCatalogEntries(entries, 'окраска', 'name')[0].id, '12');
  assert.equal(filterCatalogEntries(entries, 'граненая опора', 'name').length, 3);
  assert.ok(!calls.some(c => c.method === 'catalog.price.list'));
});

test('selected variation uses its own price; missing sibling price never inherits parent price', async () => {
  const {adapter} = makeAdapter({prices: [price, {...price, id: 2, productId: 10, price: '9999'}]});
  assert.equal((await adapter.getProduct(11)).basePrice, 1234.5);
  const missing = await adapter.getProduct(12);
  assert.equal(missing.basePrice, 0);
  assert.equal(missing.priceMissing, true);
  assert.match(missing.priceNote, /Цена не указана/);
  assert.equal((await adapter.getProduct(10)).basePrice, 9999);
});

test('price API failures still allow a verified product with a marked zero in quote currency', async () => {
  const {adapter} = makeAdapter({priceError: true});
  const p = await adapter.getProduct(11, {currency: 'EUR'});
  assert.equal(p.verified, true); assert.equal(p.basePrice, 0);
  assert.equal(p.currency, 'EUR'); assert.equal(p.priceMissing, true);
});

test('returned zero is a real price; direct prices survive unavailable price methods', async () => {
  for (const [value, expected] of [['0', 0], ['9 876,54', 9876.54]]) {
    const {adapter, calls} = makeAdapter({priceError: true, direct: {price: value, currency: 'RUB'}});
    const p = await adapter.getProduct(11);
    assert.equal(p.basePrice, expected); assert.equal(p.priceMissing, false);
    assert.ok(!calls.some(c => c.method === 'catalog.price.list'));
  }
});

test('invalid, ambiguous and quantity-dependent prices become a marked zero', async () => {
  for (const prices of [[{...price, price: 'broken'}], [{...price, price: -1}], [price, {...price, id: 2}], [{...price, quantityFrom: 10}]]) {
    const {adapter} = makeAdapter({prices});
    const p = await adapter.getProduct(11);
    assert.equal(p.basePrice, 0); assert.equal(p.priceMissing, true);
  }
});

test('legacy catalog discovery and direct CRM price work without modern methods', async () => {
  const {adapter} = makeAdapter({legacyOnly: true});
  assert.equal((await adapter.listCatalogEntries())[0].id, '900');
  const p = await adapter.getProduct(900);
  assert.equal(p.basePrice, 2345.67); assert.equal(p.priceMissing, false);
});

test('a supported list can supply a variation when get methods are unavailable', async () => {
  const {adapter} = makeAdapter({getError: true});
  await adapter.listCatalogEntries();
  const p = await adapter.getProduct(11);
  assert.equal(p.id, '11'); assert.equal(p.isVariation, true); assert.equal(p.basePrice, 1234.5);
});

test('name search has no 500-result cutoff and preserves per-item missing-price state', async () => {
  const {adapter} = makeAdapter();
  const found = await adapter.searchProducts('Деталь', {by: 'name'});
  assert.equal(found.length, 620);
  assert.ok(found.every(p => p.priceMissing && p.basePrice === 0));
  const variation = await adapter.searchProducts('НФГ', {by: 'name'});
  assert.equal(variation.find(p => p.id === '11').basePrice, 1234.5);
  assert.equal(variation.find(p => p.id === '12').basePrice, 0);
});

test('zero price is calculable and a manager-entered price recalculates totals', async () => {
  const config = validateConfig(JSON.parse(await readFile(new URL('../data/coatings.example.json', import.meta.url))));
  const {adapter} = makeAdapter({priceError: true});
  const row = newRow(await adapter.getProduct(11));
  row.quantity = '3';
  assert.equal(calculateQuote([row], config).total, 0);
  row.basePrice = '1 250,50';
  assert.equal(calculateQuote([row], config).total, 3751.5);
});
