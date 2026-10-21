import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeStoredDraft} from '../src/draft-store.js';
import {CatalogSearchIndex} from '../src/catalog.js';
import {visibleRange} from '../src/virtual-list.js';
import {BitrixAdapter} from '../src/bitrix.js';

test('migration keeps selected draft and its settings but drops all versions, variants and document caches', () => {
  const source = {state: {schemaVersion: 2, scope: 'deal-55', activeDealId: '55', selectedVariantId: 'b',
    settings: {dealId: '55', historyFolderId: '123', formulaMode: 'catalog'}, variants: [
      {id: 'a', draft: {companyName: 'Other', rows: []}, versions: [{secret: 'old'}]},
      {id: 'b', draft: {companyName: 'Selected', rows: [{id: 'row'}], managerSignatureReference: {kind: 'disk', fileId: '9'}},
        context: {config: {currency: 'EUR'}, metalPrices: null}, versions: [{snapshotId: 's'}], documents: [{id: '77'}]},
    ]}, config: {currency: 'RUB'}};
  const result = normalizeStoredDraft(source, 'deal-55');
  assert.equal(result.state.schemaVersion, 3); assert.equal(result.state.draft.companyName, 'Selected');
  assert.equal(result.config.currency, 'EUR'); assert.equal(result.state.draft.rows.length, 1);
  for (const key of ['variants', 'versions', 'documents', 'snapshotId', 'historyFolderId']) assert.ok(!JSON.stringify(result).includes('"' + key + '"'));
  assert.equal(source.state.variants[1].versions.length, 1); // Pure migration; persistence commits separately.
  assert.equal(normalizeStoredDraft(source, 'another-deal'), null);
});

test('single draft storage survives normalization without creating a history', () => {
  const result = normalizeStoredDraft({state: {schemaVersion: 3, scope: 'demo', settings: {}, draft: {companyName: 'A', rows: []}}, config: {currency: 'RUB'}}, 'demo');
  assert.equal(result.state.draft.companyName, 'A'); assert.ok(!('versions' in result.state));
});

test('virtual ranges stay bounded for 50,000 rows, handle last row and an empty filter', () => {
  for (const top of [0, 108, 2000000, 5400000, 99999999]) {
    const {start, end} = visibleRange(50000, top, 480);
    assert.ok(start >= 0 && end <= 50000 && end - start <= 14);
  }
  assert.equal(visibleRange(50000, 5400000, 480).end, 50000);
  assert.deepEqual(visibleRange(0, 0, 480), {start: 0, end: 0});
  assert.deepEqual(visibleRange(2, 0, 480), {start: 0, end: 2});
});

test('one search field finds parent names, variations, IDs and numeric names without a select', () => {
  const entries = [{id: '10', name: 'Опора НФГ-6,0'}, {id: '11', name: 'Цинк', parentProductId: '10', parentProductName: 'Опора НФГ-6,0'},
    {id: '22', name: '10'}, {id: '23', name: 'Монтаж'}];
  const index = new CatalogSearchIndex(entries);
  assert.equal(index.search('').length, 4);
  assert.deepEqual(index.search('нфг 6.0').map(p => p.id), ['10', '11']);
  assert.deepEqual(index.search('10').map(p => p.id), ['10', '11', '22']);
  assert.deepEqual(index.search('#10').map(p => p.id), ['10', '11']);
  assert.equal(index.get(23).name, 'Монтаж'); assert.equal(index.search('нет совпадений').length, 0);
});

function documentAdapter({fail = false} = {}) {
  const requests = [];
  const docs = [{id: 77, entityId: 55, entityTypeId: 2, templateId: 3, title: 'КП', createTime: '2026-10-19T12:00:00Z', downloadUrl: 'https://portal.example/doc.docx'},
    {id: 78, entityId: 99, entityTypeId: 2, title: 'Другая сделка'}, {id: 79, entityId: 55, entityTypeId: 1, title: 'Лид'},
    {id: 80, entityId: 55, entityTypeId: 2, title: 'Второй документ'}, {id: 77, entityId: 55, entityTypeId: 2, title: 'КП'}];
  const sdk = {callMethod(method, params, callback) {
    requests.push({method, params});
    const result = offset => ({error: () => fail ? 'ACCESS_DENIED' : false, answer: {error: fail ? 'ACCESS_DENIED' : undefined, next: offset + 2},
      data: () => ({documents: Object.fromEntries(docs.slice(offset, offset + 2).map((doc, i) => [i, doc]))}),
      more: () => offset + 2 < docs.length, next: next => next(result(offset + 2))});
    callback(result(0));
  }};
  const adapter = new BitrixAdapter({sdk}); adapter.connected = true;
  return {adapter, requests};
}

test('history reads native documents from every page, filters by deal and excludes non-deal documents', async () => {
  const {adapter, requests} = documentAdapter();
  const docs = await adapter.listQuoteDocuments(55);
  assert.deepEqual(docs.map(d => d.id), ['80', '77']);
  assert.equal(requests[0].method, 'crm.documentgenerator.document.list');
  assert.deepEqual(requests[0].params.filter, {entityTypeId: 2, entityId: 55});
  assert.deepEqual(requests[0].params.select, ['*']);
});

test('failed history fetch is reported and cannot become a fabricated empty or local history', async () => {
  const {adapter} = documentAdapter({fail: true});
  await assert.rejects(adapter.listQuoteDocuments(55), /ACCESS_DENIED/);
});

test('retrieving a generated document rejects a different deal', async () => {
  const adapter = new BitrixAdapter();
  adapter.call = async () => ({document: {id: 77, title: 'КП', entityId: 99, entityTypeId: 2}});
  await assert.rejects(adapter.getQuoteDocument(77, {dealId: 55}), /другого шаблона или сделки/);
});
