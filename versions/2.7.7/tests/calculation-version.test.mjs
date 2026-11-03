import assert from 'node:assert/strict';
import {BitrixAdapter} from '../src/bitrix.js';
import {normalizeStoredDraft} from '../src/draft-store.js';
const uploads = [];
let rejectUpload = false;
const sdk = {callMethod(method, params, callback) {
  let data;
  if (method === 'crm.deal.get') data = {ID: '42', TITLE: 'Сделка «Опоры»'};
  else {
    assert.equal(method, 'disk.folder.uploadfile');
    if (rejectUpload) return callback({error: () => 'ACCESS_DENIED'});
    assert.equal(params.id, 77);
    uploads.push({name: params.data.NAME, json: JSON.parse(Buffer.from(params.fileContent[1], 'base64').toString('utf8'))});
    data = {ID: String(uploads.length), NAME: params.data.NAME};
  }
  callback({error: () => null, data: () => data});
}};
const adapter = new BitrixAdapter({sdk}); adapter.connected = true;
const snapshot = {dealId:'42', quoteId:'preview', companyName:'ООО «Тест»', currency:'RUB', config:{rounding:'unit', coatings:[{unused:'exclude'}]},
 rows:[{productId:'9', productName:'Опора', basePrice:'10,50', quantity:'2', k1:'1,2', k2:'1', k3:'1', fastenersEnabled:false, fasteners:'999', raw:{secret:'exclude'}, unitPrice:12.6, lineTotal:25.2},
 {rowType:'custom', productName:'Монтаж', basePrice:'20', quantity:'1', k1:'1', k2:'1', k3:'1', fastenersEnabled:true, fasteners:'5'}]};
const original = structuredClone(snapshot);
await adapter.saveCalculationVersion('77', snapshot, {event:'transfer'});
await adapter.saveCalculationVersion('77', snapshot, {event:'generation',templateId:'3'});
assert.notEqual(uploads[0].name, uploads[1].name);
assert.notEqual(uploads[0].json.version, uploads[1].json.version);
assert.equal(uploads[0].json.deal.title, 'Сделка «Опоры»');
assert.equal(uploads[0].json.parameters.rows[0].k1, '1,2');
assert.equal(uploads[1].json.documentTemplateId, '3');
assert.equal(uploads[1].json.parameters.rows[1].fasteners, '5');
for (const field of ['raw','unitPrice','lineTotal','fasteners']) assert.equal(field in uploads[0].json.parameters.rows[0], false);
assert.equal('coatings' in uploads[0].json.parameters, false);
assert.deepEqual(snapshot, original);
await assert.rejects(adapter.saveCalculationVersion('', snapshot, {event:'generation'}), /ID папки/);
rejectUpload = true;
await assert.rejects(adapter.saveCalculationVersion('77', snapshot, {event:'generation'}), /ACCESS_DENIED/);
assert.equal(uploads.length,2);
const stored = normalizeStoredDraft({state:{schemaVersion:3, scope:'deal-42', settings:{historyFolderId:'77'}, draft:{rows:[]}}}, 'deal-42');
assert.equal(stored.state.settings.historyFolderId, '77');
console.log('PASS: unique versions, UTF-8 JSON, input-only fields, frozen inputs, Disk upload, failure handling, folder persistence');

const {readFile} = await import('node:fs/promises');
const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const preview = app.split('async function prepareQuote() {')[1].split('function safeError')[0];
assert.ok(!preview.includes('saveCalculationVersion'));
assert.equal(app.match(/await adapter\.saveCalculationVersion\(/g).length, 2);
const transfer = app.split('async function applyToDeal() {')[1].split('function bindEvents')[0];
assert.ok(transfer.indexOf('if (!window.confirm(warning)) return;') < transfer.indexOf('saveCalculationVersion'));
assert.ok(transfer.indexOf('saveCalculationVersion') < transfer.indexOf('await adapter.applyToDeal'));
assert.ok(transfer.includes("event: 'transfer'"));
const generation = app.split('async function generateDocument() {')[1].split('async function refreshDocument')[0];
assert.ok(generation.includes("event: 'generation'"));
assert.ok(generation.indexOf('saveCalculationVersion') < generation.indexOf('await adapter.createQuoteDocument'));
console.log('PASS: preview never saves; generation and confirmed transfer save exactly once');
