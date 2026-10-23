import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BitrixAdapter, fingerprintRows} from '../src/bitrix.js';
import {IntegrationSettings, CONFIG_OPTION, normalizeIntegrationConfig, normalizeFields, validateMappings, readPrimary, encodeResult, decodeField} from '../src/integration-config.js';
import {DiskTexts, validateTextTemplates, appliedTexts} from '../src/text-templates.js';
import {calculateQuote, withCoatingOptions, validateConfig} from '../src/calculator.js';
import {newRow, newCustomRow} from '../src/demo.js';
import {QuoteSaver} from '../src/quote-save.js';
import {loadPrimaryData} from '../src/deal-primary.js';
import {createSnapshot, verifySnapshot, calculateMetrics, sha256, checkSnapshotSize} from '../src/quote-snapshot.js';
import {normalizeStoredDraft} from '../src/draft-store.js';
import {readDiskJson, createAppServer} from '../server.mjs';

const texts = validateTextTemplates(JSON.parse(await readFile(new URL('../data/yuzm-quote-texts.json', import.meta.url))));
const calcConfig = withCoatingOptions(validateConfig({currency:'RUB',rounding:'unit',coatings:[{code:'none',name:'Без покрытия'}]}));
const rawFields = {
 DATE_CREATE:{type:'datetime',title:'Создано',isReadOnly:true}, COMPANY_ID:{type:'crm_company',title:'Клиент'}, ASSIGNED_BY_ID:{type:'user',title:'Менеджер'},
 PAYMENT:{type:'enumeration',title:'Оплата',isMultiple:true,items:[{ID:'1',VALUE:'Безналичный'},{ID:'2',VALUE:'Наличный'}]},
 ADDRESS:{type:'string',title:'Адрес',isMultiple:true}, DELIVERY_DATE:{type:'date',title:'Дата доставки'},
 RESULT_TOTAL:{type:'money',title:'Сумма'}, RESULT_DELIVERY:{type:'double',title:'Доставка'}, RESULT_WEIGHT:{type:'double',title:'Вес'}, RESULT_JSON:{type:'string',title:'JSON',settings:{MAX_LENGTH:100000}},
};
const fields = normalizeFields(rawFields);
function configuration() {return normalizeIntegrationConfig({revision:'1',fields:{payment:{code:'PAYMENT'},deliveryAddress:{code:'ADDRESS'},deliveryDate:{code:'DELIVERY_DATE'},total:{code:'RESULT_TOTAL'},delivery:{code:'RESULT_DELIVERY'},weight:{code:'RESULT_WEIGHT'},snapshot:{code:'RESULT_JSON'}}, resources:{textFileId:'101',textFolderId:'102'}});}
function memoryStorage() {const values = new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key),values};}
function initialDeal() {return {ID:'55',TITLE:'Заказ',DATE_CREATE:'2026-10-23T12:00:00+03:00',COMPANY_ID:'5',ASSIGNED_BY_ID:'7',PAYMENT:['1','2'],ADDRESS:['Адрес 1','Адрес 2'],DELIVERY_DATE:'2026-10-30',CATEGORY_ID:'0',CURRENCY_ID:'RUB',RESULT_TOTAL:'99999|RUB',RESULT_WEIGHT:999,RESULT_DELIVERY:999,RESULT_JSON:''};}
function quote(deal=initialDeal(), {customOnly=false, separate=false}={}) {
 const goods = {...newRow({id:'11',name:'Изделие',basePrice:100,currency:'RUB',source:'catalog'}),quantity:'2',k1:'0.9',k2:'1.1',k3:'1.2',unitWeight:'3'};
 const custom = {...newCustomRow(),productName:'Работа',basePrice:'50',unitWeight:'0'};
 const shipping = {...newCustomRow(),productName:'Отдельная доставка',basePrice:'20',unitWeight:'0',deliveryRole:'separate'};
 const rows = [...(customOnly?[]:[goods]),custom,...(separate?[shipping]:[])];
 const calculated = calculateQuote(rows,calcConfig);
 const documentFields = Object.fromEntries(Object.values(texts.templates).map(category=>[category.field,category.presets.find(p=>p.id===category.defaultPresetId).text]));
 return {...calculated,schemaVersion:3,quoteId:'quote-1',createdAt:'2026-10-23T09:00:00Z',dealId:'55',companyName:'Заказчик',currency:'RUB',config:calcConfig,documentTemplateId:'3',documentFields,primary:readPrimary(deal,configuration(),fields),appliedTexts:appliedTexts(documentFields,texts),deliveryCoefficientKeys:['k2']};
}
function fixture(options={}) {
 const config = configuration(), deal = initialDeal(), calls=[], docs=new Map(), storage=memoryStorage();
 let rawRows=[{ID:'90',PRODUCT_ID:99,PRODUCT_NAME:'Старый заказ',PRICE:10,QUANTITY:1,SORT:10,TAX_RATE:0,TAX_INCLUDED:'Y'}];
 let updates=0, additions=0, rowWrites=0;
 const adapter=new BitrixAdapter({sdk:{isAdmin:()=>true}});adapter.connected=true;
 adapter.getProduct=async()=>{if(options.inactive)throw new Error('Товар деактивирован');return {verified:true,currency:'RUB'};};
 adapter.call=async(method,params={})=>{
  calls.push({method,params:structuredClone(params)});
  if(method==='app.option.get')return params.option===CONFIG_OPTION?JSON.stringify(config):'';
  if(method==='crm.deal.get')return structuredClone(deal);
  if(method==='crm.deal.productrows.get')return structuredClone(rawRows);
  if(method==='crm.company.get')return {ID:'5',TITLE:'Заказчик'};
  if(method==='crm.documentgenerator.template.get')return {template:{id:3,name:'КП',active:'Y',isDeleted:'N',entityTypeId:['2']}};
  if(method==='crm.documentgenerator.document.add'){
   additions++;
   if(options.rejectAdd && additions===1){const e=new Error('ACCESS_DENIED');e.code='ACCESS_DENIED';e.method=method;throw e;}
   const document={id:'77',number:'КП-77',title:params.values.DocumentTitle,createTime:'2026-10-23T09:00:00Z',templateId:3,entityId:55,entityTypeId:2,downloadUrl:'https://portal.example/document?token=NEVER_STORE'};
   docs.set('77',document);
   if(options.timeoutAdd && additions===1){const e=new Error('Timeout');e.code='REQUEST_TIMEOUT';throw e;}
   return {document};
  }
  if(method==='crm.documentgenerator.document.get')return {document:docs.get(String(params.id))};
  if(method==='crm.item.productrow.set'){
   rowWrites++;
   rawRows=params.productRows.map((r,i)=>({ID:String(100+i),PRODUCT_ID:r.productId,PRODUCT_NAME:r.productName,PRICE:r.price,QUANTITY:r.quantity,SORT:r.sort,TAX_RATE:r.taxRate,TAX_INCLUDED:r.taxIncluded}));
   if(options.timeoutRows && rowWrites===1)throw new Error('Timeout after row commit');
   return {productRows:rawRows};
  }
  if(method==='crm.deal.update'){
   updates++;
   if(options.failFields && updates===1)throw new Error('Поле временно недоступно');
   Object.assign(deal,params.fields);
   if(options.poisonFields)deal.RESULT_WEIGHT=-1;
   if(options.timeoutFields && updates===1)throw new Error('Timeout after field commit');
   return true;
  }
  throw new Error('Unexpected '+method);
 };
 const settings=new IntegrationSettings(adapter);
 const saver=new QuoteSaver(adapter,settings,{storage,scope:'test.portal',confirm:options.confirm||(()=>true)});
 return {adapter,config,deal,calls,docs,storage,saver,rows:()=>rawRows,counters:()=>({updates,additions,rowWrites})};
}
test('deal ID uses only the existing placement or validated fallback',async()=>{
 for(const [placement,expected] of [[{placement:'CRM_DEAL_DETAIL_TAB',options:{ID:'55'}},'55'],[{placement:'CRM_DEAL_DETAIL_TAB',options:'{"ID":"56"}'},'56'],[{placement:'OTHER',options:{ID:'55'}},null],[{placement:'CRM_DEAL_DETAIL_TAB',options:{ID:'-1'}},null]]){
  const adapter=new BitrixAdapter({sdk:{init:cb=>cb(),callMethod(){},placement:{info:()=>placement}}});assert.equal((await adapter.init()).dealId,expected);
 }
});
test('field metadata includes lists from userfield.list and multiple flags',()=>{
 const all=normalizeFields({CUSTOM:{title:'Список',type:'enumeration',isMultiple:'Y'}},[{FIELD_NAME:'CUSTOM',LIST:[{ID:15,VALUE:'Перевод'}]}]);
 assert.deepEqual(all.CUSTOM.items,[{id:'15',label:'Перевод'}]);assert.equal(all.CUSTOM.multiple,true);
 assert.deepEqual(decodeField(['15'],all.CUSTOM),[{id:'15',label:'Перевод'}]);
});
test('primary input handles arrays, dates and enum IDs without reading result fields',()=>{
 const deal=initialDeal();for(const key of ['RESULT_TOTAL','RESULT_DELIVERY','RESULT_WEIGHT','RESULT_JSON'])Object.defineProperty(deal,key,{get(){throw new Error('Result feedback');}});
 const data=readPrimary(deal,configuration(),fields);assert.deepEqual(data.payment,[{id:'1',label:'Безналичный'},{id:'2',label:'Наличный'}]);assert.deepEqual(data.deliveryAddress,['Адрес 1','Адрес 2']);assert.equal(data.createdAt,deal.DATE_CREATE);
});
test('unknown enum IDs, missing required input and incompatible mappings fail clearly',()=>{
 assert.throws(()=>readPrimary({...initialDeal(),PAYMENT:['999']},configuration(),fields),/неизвестный/);
 assert.throws(()=>readPrimary({...initialDeal(),ASSIGNED_BY_ID:''},configuration(),fields),/обязательное/);
 const config=configuration();config.fields.weight.code='RESULT_JSON';assert.throws(()=>validateMappings(config,fields),/несовместимый/);
});
test('mappings reject missing, duplicate, read-only and integer output loss',()=>{
 const config=configuration();config.fields.total.code='MISSING';assert.throws(()=>validateMappings(config,fields),/доступное поле/);
 config.fields.total.code='RESULT_DELIVERY';assert.throws(()=>validateMappings(config,fields),/нескольким/);
 assert.throws(()=>validateMappings(configuration(),{...fields,RESULT_TOTAL:{...fields.RESULT_TOTAL,readOnly:true}}),/чтения/);
 assert.throws(()=>encodeResult(1.5,{type:'integer',label:'Вес'},'RUB'),/дробный/);
 assert.deepEqual(encodeResult(12.5,{type:'money',multiple:true},'RUB'),['12.5|RUB']);
});
test('selected client and manager fields drive initial loading',async()=>{
 const f=fixture();const result=await loadPrimaryData(f.adapter,55,f.config,fields);assert.equal(result.companyName,'Заказчик');assert.equal(f.adapter.managerFieldCode,'ASSIGNED_BY_ID');
 const cfg=configuration();cfg.fields.client.code='ADDRESS';const value=await loadPrimaryData(f.adapter,55,cfg,fields);assert.equal(value.companyName,'Адрес 1, Адрес 2');
});
test('non-administrators cannot write shared configuration or upload templates',async()=>{
 const f=fixture();f.adapter.sdk.isAdmin=()=>false;
 await assert.rejects(new IntegrationSettings(f.adapter).save(f.config,fields),/администратор/);
 await assert.rejects(new DiskTexts(f.adapter).publish('101',texts),/администратор/);
 assert.ok(!f.calls.some(c=>['app.option.set','disk.file.uploadVersion'].includes(c.method)));
});
test('weight and delivery use quantities, K2 and separate delivery without changing total formula',()=>{
 const q=quote(initialDeal(),{separate:true}),metrics=calculateMetrics(q,['k2']);
 assert.equal(q.total,307.6);assert.deepEqual(metrics,{total:307.6,weight:6,delivery:41.6,embeddedDelivery:21.6,separateDelivery:20});
 assert.throws(()=>calculateMetrics({...q,rows:q.rows.map(row=>({...row,unitWeight:''}))},['k2']),/Масса единицы/);
});
test('complete save creates a document, transfers every row and verifies JSON and outputs',async()=>{
 const f=fixture();const result=await f.saver.save(quote(f.deal),f.config,fields);
 assert.equal(result.document.id,'77');assert.equal(f.rows().length,2);assert.equal(f.rows()[1].PRODUCT_ID,0);assert.equal(f.deal.RESULT_TOTAL,'287.6|RUB');assert.equal(f.deal.RESULT_WEIGHT,6);assert.equal(f.deal.RESULT_DELIVERY,21.6);
 assert.equal((await verifySnapshot(f.deal.RESULT_JSON,55)).snapshot.status,'generated');assert.deepEqual(f.counters(),{updates:1,additions:1,rowWrites:1});
 assert.ok(!JSON.stringify([...f.storage.values.values()]).includes('NEVER_STORE'));assert.ok(!('STAGE_ID' in f.calls.find(c=>c.method==='crm.deal.update').params.fields));
});
test('custom-only proposal replaces old rows with named non-catalog positions',async()=>{
 const f=fixture();await f.saver.save(quote(f.deal,{customOnly:true}),f.config,fields);assert.equal(f.rows().length,1);assert.equal(f.rows()[0].PRODUCT_ID,0);assert.equal(f.rows()[0].PRODUCT_NAME,'Работа');
});
test('cancelled replacement preserves old deals and does not create a document',async()=>{
 const f=fixture({confirm:()=>false});const rows=structuredClone(f.rows());assert.equal(await f.saver.save(quote(f.deal),f.config,fields),null);assert.deepEqual(f.rows(),rows);assert.deepEqual(f.counters(),{updates:0,additions:0,rowWrites:0});
});
test('missing settings, inactive products, invalid mass and oversize JSON block all writes',async()=>{
 for(const mode of ['settings','inactive','weight','size']){
  const f=fixture({inactive:mode==='inactive'}),q=quote(f.deal);
  if(mode==='settings')f.config.fields.snapshot.code='';if(mode==='weight')q.rows[0].unitWeight='';if(mode==='size')f.config.snapshotMaxBytes=1024;
  await assert.rejects(f.saver.save(q,f.config,fields));assert.deepEqual(f.counters(),{updates:0,additions:0,rowWrites:0});
 }
});
test('old deal transfer requires explicit fingerprint and detects concurrent row changes',async()=>{
 const f=fixture(),q=quote(f.deal);
 await assert.rejects(f.adapter.applyToDeal(55,q),/подтверждение/);
 await assert.rejects(f.adapter.applyToDeal(55,q,'stale'),/изменились/);assert.equal(f.counters().rowWrites,0);
});
test('partial field failure resumes without creating a second document',async()=>{
 const f=fixture({failFields:true}),q=quote(f.deal);await assert.rejects(f.saver.save(q,f.config,fields),/не завершено/);
 assert.equal(f.saver.pending(55).stage,'rows-written');
 const resumed=new QuoteSaver(f.adapter,new IntegrationSettings(f.adapter),{storage:f.storage,scope:'test.portal',confirm:()=>true});
 await resumed.save(f.saver.pending(55).quote,f.config,fields);assert.deepEqual(f.counters(),{updates:2,additions:1,rowWrites:1});
});
test('lost response after row or field commit is safely verified on retry',async()=>{
 for(const flag of ['timeoutRows','timeoutFields']){
  const f=fixture({[flag]:true}),q=quote(f.deal);await assert.rejects(f.saver.save(q,f.config,fields));
  await f.saver.save(q,f.config,fields);assert.equal(f.counters().additions,1);assert.equal(f.counters().rowWrites,1);assert.equal(f.saver.pending(55).stage,'done');
 }
});
test('document timeout blocks blind retry and recovers only matching deal/template/operation',async()=>{
 const f=fixture({timeoutAdd:true}),q=quote(f.deal);await assert.rejects(f.saver.save(q,f.config,fields),/заблокирован/);assert.equal(f.saver.pending(55).stage,'document-unknown');
 await assert.rejects(f.saver.save(q,f.config,fields),/Автоповтор/);assert.equal(f.counters().additions,1);
 f.docs.get('77').title='Посторонний документ';await assert.rejects(f.saver.recoverDocument(55,77),/маркер/);
 f.docs.get('77').title=`КП ЮЗМ [${f.saver.pending(55).operationId}]`;await f.saver.recoverDocument(55,77);await f.saver.save(q,f.config,fields);assert.equal(f.counters().additions,1);
});
test('explicit document API rejection allows a safe new attempt before any row mutation',async()=>{
 const f=fixture({rejectAdd:true}),q=quote(f.deal);await assert.rejects(f.saver.save(q,f.config,fields),/ACCESS_DENIED/);assert.equal(f.saver.pending(55).stage,'prepared');assert.equal(f.counters().rowWrites,0);await f.saver.save(q,f.config,fields);assert.equal(f.docs.size,1);
});
test('missing document number or DOCX defers success and resumes after generation without a copy',async()=>{
 const f=fixture(),q=quote(f.deal),get=f.adapter.getQuoteDocument.bind(f.adapter);
 f.adapter.getQuoteDocument=async(...args)=>({...await get(...args),number:''});
 await assert.rejects(f.saver.save(q,f.config,fields),/номер документа/);assert.equal(f.counters().additions,1);assert.equal(f.counters().rowWrites,0);
 f.adapter.getQuoteDocument=async(...args)=>({...await get(...args),downloadUrl:''});
 await assert.rejects(f.saver.save(q,f.config,fields),/DOCX ещё не сформирован/);assert.equal(f.counters().rowWrites,0);
 f.adapter.getQuoteDocument=get;await f.saver.save(q,f.config,fields);assert.equal(f.counters().additions,1);assert.equal(JSON.parse(f.deal.RESULT_JSON).document.number,'КП-77');
});
test('double click and repeated successful save create only one document',async()=>{
 const f=fixture(),q=quote(f.deal);const result=await Promise.allSettled([f.saver.save(q,f.config,fields),f.saver.save(q,f.config,fields)]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
 await f.saver.save(q,f.config,fields);assert.equal(f.counters().additions,1);
});
test('concurrent result edits and invalid readback never report successful save',async()=>{
 const f=fixture({failFields:true}),q=quote(f.deal);await assert.rejects(f.saver.save(q,f.config,fields));f.deal.RESULT_WEIGHT=123;
 await assert.rejects(f.saver.save(q,f.config,fields),/другим пользователем/);assert.equal(f.counters().additions,1);
 const poisoned=fixture({poisonFields:true});await assert.rejects(poisoned.saver.save(quote(poisoned.deal),poisoned.config,fields),/Контрольное чтение/);assert.notEqual(poisoned.saver.pending(55).stage,'done');
});
test('concurrent row or primary edits after partial save block replacement',async()=>{
 for(const mode of ['rows','primary']){
  const f=fixture({failFields:true}),q=quote(f.deal);await assert.rejects(f.saver.save(q,f.config,fields));
  if(mode==='rows')f.rows()[0].QUANTITY=100;else f.deal.PAYMENT=['2'];
  await assert.rejects(f.saver.save(q,f.config,fields),mode==='rows'?/Товары сделки изменены/:/Исходные поля/);assert.equal(f.counters().rowWrites,1);
 }
});
test('snapshot integrity, schema, algorithm and deal checks precede restore',async()=>{
 const q=quote(),snapshot=await createSnapshot(q,{id:'77',number:'КП-77',templateId:'3'},calculateMetrics(q,['k2']),'operation');
 assert.equal((await verifySnapshot(JSON.stringify(snapshot),55)).quote.total,q.total);
 for(const change of [s=>s.dealId='99',s=>s.schemaVersion=99,s=>s.algorithmVersion='future',s=>s.quote.rows[0].k2='2',s=>s.integrity.digest='0'.repeat(64)]){
  const broken=structuredClone(snapshot);change(broken);await assert.rejects(verifySnapshot(broken,55));
 }
 assert.throws(()=>checkSnapshotSize(snapshot,100,{maxLength:0}),/превышает/);
});
test('local draft and CRM JSON are independent; restoration uses stored prices and text',async()=>{
 const f=fixture(),q=quote(f.deal),draftKey='draft-deal-55';f.storage.setItem(draftKey,JSON.stringify({state:{schemaVersion:3,scope:'deal-55',draft:{rows:[{productName:'Незавершённая правка'}]},settings:{}}}));
 const before=f.storage.getItem(draftKey);await f.saver.save(q,f.config,fields);assert.equal(f.storage.getItem(draftKey),before);
 const local=normalizeStoredDraft(JSON.parse(before),'deal-55');assert.equal(local.state.draft.rows[0].productName,'Незавершённая правка');
 const restored=await verifySnapshot(f.deal.RESULT_JSON,55);assert.equal(restored.quote.rows[0].basePrice,100);assert.equal(restored.quote.documentFields.YuzmDocumentsTerms,q.documentFields.YuzmDocumentsTerms);
});
test('changed central text applies to new quotes and cannot mutate old JSON',async()=>{
 const f=fixture(),q=quote(f.deal);await f.saver.save(q,f.config,fields);const old=f.deal.RESULT_JSON;
 const updated=structuredClone(texts);updated.version='2';updated.templates.documents.presets[0].text='Новая редакция';
 const newFields={...q.documentFields,YuzmDocumentsTerms:'Новая редакция'};assert.equal(appliedTexts(newFields,updated).documents.text,'Новая редакция');
 assert.notEqual((await verifySnapshot(old,55)).quote.documentFields.YuzmDocumentsTerms,'Новая редакция');assert.equal(f.deal.RESULT_JSON,old);
});
test('Disk JSON updates keep the same ID and verify downloaded content',async()=>{
 let remote=structuredClone(texts);const calls=[];
 const adapter={canManageSettings:()=>true,call:async(method,params)=>{calls.push({method,params});if(method==='disk.file.get')return {ID:'101',NAME:'yuzm-quote-texts.json',SIZE:100,DOWNLOAD_URL:'https://portal.example/file?token=SECRET'};if(method==='disk.file.uploadVersion'){remote=JSON.parse(Buffer.from(params.fileContent[1],'base64').toString('utf8'));return {ID:'101'};}throw new Error(method);}};
 const disk=new DiskTexts(adapter,{fetcher:async()=>new Response(JSON.stringify(remote)),origin:'https://app.example'});
 const updated=structuredClone(texts);updated.version='2';updated.templates.documents.presets[0].text='Сертификат ТР ТС с паспортом';
 assert.equal((await disk.publish('101',updated)).version,'2');assert.equal(calls.find(c=>c.method==='disk.file.uploadVersion').params.id,101);
});
test('CORS failures are actionable and never expose the tokenized URL',async()=>{
 const adapter={call:async()=>({ID:'101',NAME:'texts.json',DOWNLOAD_URL:'https://portal.example/file?auth=SECRET'})};
 const disk=new DiskTexts(adapter,{fetcher:async()=>{throw new Error('https://portal.example/file?auth=SECRET');}});
 await assert.rejects(disk.read('101'),error=>/CORS/.test(error.message)&&!error.message.includes('SECRET'));
});
test('Disk proxy uses same-origin POST with transient SDK auth rather than persistent credentials',async()=>{
 const adapter={sdk:{getAuth:()=>({access_token:'TRANSIENT'}),getDomain:()=> 'portal.example'},call:async()=>({ID:'101',NAME:'texts.json'})};let request;
 const disk=new DiskTexts(adapter,{origin:'https://app.example',fetcher:async(url,params)=>{request={url,params};return new Response(JSON.stringify(texts));}});
 await disk.read('101','/api/disk-json');assert.equal(request.url,'https://app.example/api/disk-json');assert.equal(request.params.method,'POST');assert.equal(JSON.parse(request.params.body).accessToken,'TRANSIENT');assert.ok(!request.url.includes('TRANSIENT'));
 await assert.rejects(new DiskTexts(adapter,{origin:'https://app.example',fetcher:()=>{throw new Error();}}).read('101','https://evil.example/proxy'),/Не удалось/);
});
test('template structure rejects duplicate IDs, unknown schemas and forbidden custom text',()=>{
 const broken=structuredClone(texts);broken.templates.documents.presets.push(broken.templates.documents.presets[0]);assert.throws(()=>validateTextTemplates(broken));assert.throws(()=>validateTextTemplates({...texts,schemaVersion:2}));
 const strict=structuredClone(texts);strict.templates.payment.allowCustom=false;assert.throws(()=>appliedTexts({},strict),/выберите/);
});
test('optional Disk server restricts portal, HTTPS download hosts and redirects',async()=>{
 const input={domain:'portal.example',fileId:101,accessToken:'SECRET'},policy={allowedDomains:['portal.example']};
 let count=0;const fetcher=async(url,params)=>{count++;if(count===1){assert.equal(JSON.parse(params.body).auth,'SECRET');return new Response(JSON.stringify({result:{ID:'101',NAME:'texts.json',SIZE:100,DOWNLOAD_URL:'https://portal.example/file'}}));}return new Response(JSON.stringify(texts));};
 assert.equal((await readDiskJson(input,{...policy,fetcher})).schemaVersion,1);
 await assert.rejects(readDiskJson({...input,domain:'127.0.0.1'},policy),/INVALID_REQUEST/);
 for(const target of ['http://portal.example/file','https://evil.example/file','https://portal.example:8080/file']){
  await assert.rejects(readDiskJson(input,{...policy,fetcher:async()=>new Response(JSON.stringify({result:{ID:'101',NAME:'texts.json',DOWNLOAD_URL:target}}))}),/DOWNLOAD_HOST_DENIED/);
 }
});
test('server rejects cross-origin proxy calls and hides its own source files',async()=>{
 const server=createAppServer({appOrigin:'https://app.example',allowedDomains:['portal.example']});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {const base=`http://127.0.0.1:${server.address().port}`;assert.equal((await fetch(base+'/api/disk-json',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'})).status,403);assert.equal((await fetch(base+'/server.mjs')).status,404);assert.equal((await fetch(base+'/admin.html')).status,200);}
 finally {await new Promise(resolve=>server.close(resolve));}
});
