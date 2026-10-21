import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BitrixAdapter} from '../src/bitrix.js';
import {signatureReference, managerValues} from '../src/manager.js';

function fixture({owner = '7', file = {}, admin = true, reference = {kind: 'disk', fileId: '101'}} = {}) {
  const calls = [], options = new Map(reference ? [['yuzmManagerSignature_7', JSON.stringify(reference)]] : []);
  const adapter = new BitrixAdapter({sdk: {isAdmin: () => admin}});
  adapter.connected = true;
  adapter.call = async (method, params) => {
    calls.push({method, params});
    if (method === 'crm.deal.get') return {ID: '55', ASSIGNED_BY_ID: owner, CURRENCY_ID: 'RUB', CATEGORY_ID: '0'};
    if (method === 'user.get') return [{ID: params.FILTER.ID, LAST_NAME: 'Тестов', NAME: 'Тест', SECOND_NAME: 'Тестович', EMAIL: `manager${params.FILTER.ID}@example.com`, WORK_PHONE: '+7 000 000-00-00', WORK_POSITION: 'Менеджер'}];
    if (method === 'app.option.get') return options.get(params.option) ?? '';
    if (method === 'app.option.set') { for (const [key, value] of Object.entries(params.options)) options.set(key, value); return true; }
    if (method === 'disk.file.get') return {ID: String(params.id), NAME: 'signature.png', SIZE: 123, TYPE: 'file', DOWNLOAD_URL: `https://portal.example/signature-${params.id}.png?token=current`, ...file};
    if (method === 'crm.documentgenerator.template.get') return {template: {id: '3', name: 'КП', active: 'Y', isDeleted: 'N', entityTypeId: ['2']}};
    if (method === 'crm.documentgenerator.document.add') return {document: {id: '77', title: 'КП', templateId: 3, entityId: 55, entityTypeId: 2, downloadUrl: 'https://portal.example/document.docx'}};
    throw new Error(`Unexpected method ${method}`);
  };
  adapter.loadDeal = async () => ({id: '55', currency: 'RUB', rows: []});
  adapter.applyToDeal = async () => {calls.push({method: 'TRANSFER'});};
  return {adapter, calls, options};
}
function snapshot() {
  return {dealId: '55', companyName: 'Заказчик', currency: 'RUB', total: 100,
    managerUserId: '7', managerSignatureReference: {kind: 'disk', fileId: '101'},
    documentFields: {YuzmManagerName: 'Тестов Тест Тестович', YuzmManagerEmail: 'manager7@example.com'},
    config: {coatings: [{code: 'none', name: 'Без покрытия'}]},
    rows: [{productId: '11', productName: 'Товар', quantity: '1', unitPrice: 100, lineTotal: 100, coatingCode: 'none', executionTerm: ''}]};
}

test('manager contacts and image come from the deal owner, including patronymic and email', async () => {
  const {adapter, calls} = fixture();
  const p = await adapter.getResponsibleManager(55);
  assert.equal(p.userId, '7'); assert.equal(p.name, 'Тестов Тест Тестович');
  assert.equal(p.email, 'manager7@example.com');
  assert.match(p.signatureUrl, /signature-101/);
  assert.equal(managerValues(p).YuzmManagerEmail, p.email);
  assert.equal(calls.find(c => c.method === 'user.get').params.FILTER.ID, 7);
});

test('a new responsible employee never inherits the previous owner signature', async () => {
  const {adapter} = fixture({owner: '8'});
  const p = await adapter.getResponsibleManager(55);
  assert.equal(p.email, 'manager8@example.com'); assert.equal(p.signatureReference, null); assert.equal(p.signatureUrl, '');
});

test('per-employee signature settings are shared, confirmed and removable', async () => {
  const {adapter, options} = fixture();
  await adapter.setManagerSignature(8, '00202');
  assert.deepEqual(await adapter.getManagerSignature(8), {kind: 'disk', fileId: '202'});
  assert.deepEqual(JSON.parse(options.get('yuzmManagerSignature_7')), {kind: 'disk', fileId: '101'});
  await adapter.setManagerSignature(8, '');
  assert.equal(await adapter.getManagerSignature(8), null);
});

test('non-admins cannot change signature settings', async () => {
  const {adapter, calls} = fixture({admin: false});
  await assert.rejects(adapter.setManagerSignature(7, '101'), /администратор/);
  assert.ok(!calls.some(c => c.method === 'app.option.set'));
});

test('Disk IDs are checked for identity, supported image type, size and current URL', async () => {
  for (const file of [{ID: '999'}, {NAME: 'signature.pdf'}, {SIZE: 3 * 1024 * 1024}, {DOWNLOAD_URL: ''}, {DOWNLOAD_URL: 'javascript:alert(1)'}]) {
    const {adapter} = fixture({file});
    await assert.rejects(adapter.resolveManagerSignature({kind: 'disk', fileId: '101'}));
  }
  const {adapter, calls} = fixture();
  await adapter.resolveManagerSignature({kind: 'disk', fileId: '101'});
  await adapter.resolveManagerSignature({kind: 'disk', fileId: '101'});
  assert.equal(calls.filter(c => c.method === 'disk.file.get').length, 2);
});

test('a failed image lookup keeps contacts available and reports an image error', async () => {
  const {adapter} = fixture({file: {NAME: 'signature.pdf'}});
  const p = await adapter.getResponsibleManager(55);
  assert.equal(p.email, 'manager7@example.com'); assert.equal(p.signatureUrl, ''); assert.ok(p.signatureError);
});

test('DOCX generation passes email, image type, fresh image URL and enabled stamps', async () => {
  const {adapter, calls} = fixture();
  const doc = await adapter.createQuoteDocument(55, 3, snapshot());
  assert.equal(doc.id, '77');
  const request = calls.find(c => c.method === 'crm.documentgenerator.document.add').params;
  assert.equal(request.fields.YuzmManagerEmail.VALUE, 'manager7@example.com');
  assert.equal(request.fields.YuzmManagerSignature.TYPE, 'STAMP');
  assert.match(request.values.YuzmManagerSignature, /signature-101/);
  assert.equal(request.stampsEnabled, 1);
});

test('changed owner or inaccessible signature blocks document creation before CRM writes', async () => {
  for (const opts of [{owner: '8'}, {file: {ID: '999'}}]) {
    const {adapter, calls} = fixture(opts);
    await assert.rejects(adapter.createQuoteDocument(55, 3, snapshot()));
    assert.ok(!calls.some(c => c.method === 'TRANSFER' || c.method === 'crm.documentgenerator.document.add'));
  }
});

test('invalid sources cannot be saved as employee Disk signatures', async () => {
  const {adapter} = fixture();
  for (const value of ['javascript:alert(1)', 'https://example.com/sign.png', '0', -1, '1.5']) await assert.rejects(adapter.setManagerSignature(7, value));
  assert.equal(signatureReference(' 00101 ').fileId, '101');
});

test('DOCX item delivery periods format numbers and preserve warehouse shipment text', async () => {
  for (const [value, expected] of [['15', '15 рабочих дней'], ['Отгрузка с СГП', 'Отгрузка с СГП'], ['15 рабочих дней', '15 рабочих дней']]) {
    const {adapter, calls} = fixture();
    const saved = snapshot(); saved.rows[0].executionTerm = value;
    await adapter.createQuoteDocument(55, 3, saved);
    const request = calls.find(c => c.method === 'crm.documentgenerator.document.add').params;
    assert.equal(request.values.KpItems[0].ExecutionTerm, expected);
    assert.equal(request.fields.YuzmDeliveryPeriod.VALUE, 'KpItems.Item.ExecutionTerm');
  }
});
