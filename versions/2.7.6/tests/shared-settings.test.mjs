import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BitrixAdapter} from '../src/bitrix.js';
import {SharedSettingsStore,SHARED_SETTINGS_OPTION} from '../src/shared-settings.js';
import {DEFAULT_PAYMENT_MAPPING} from '../src/payment-terms.js';
import {DEFAULT_DELIVERY_MODE_IDS} from '../src/delivery-mode.js';
import {DEFAULT_TERM_TEMPLATES} from '../src/term-templates.js';
const defaults={historyFolderId:'',deliveryProductId:'',deliveryAddressFieldCode:'UF_CRM_1',deliveryFieldCode:'UF_CRM_2',paymentFieldCode:'UF_CRM_3',deliveryModeFieldCode:'UF_CRM_4',paymentMapping:DEFAULT_PAYMENT_MAPPING,deliveryModeMapping:DEFAULT_DELIVERY_MODE_IDS,termTemplates:DEFAULT_TERM_TEMPLATES,rounding:'line'};
function fixture(){
 const options={};const calls=[];let brokenRead=false;let keyed=false;let denySet=false;
 function adapter(admin){const a=new BitrixAdapter({sdk:{isAdmin:()=>admin,callMethod(method,params,cb){
  calls.push({admin,method,params});let data;
  if(method==='app.option.get'){
   if(brokenRead&&options[SHARED_SETTINGS_OPTION])return cb({error:()=> 'ACCESS_DENIED'});
   data=keyed?{...options}:options[params.option]??null;
  }else if(method==='app.option.set'){
   if(!admin||denySet)return cb({error:()=> 'ACCESS_DENIED'});
   Object.assign(options,params.options);data=true;
  }else if(method==='crm.deal.get')data={ID:'42',CURRENCY_ID:'RUB',CATEGORY_ID:'0'};
  else if(method==='crm.documentgenerator.template.get'||method==='crm.documentgenerator.template.list')return cb({error:()=> 'DOCGEN_ACCESS_ERROR'});
  else if(method==='crm.documentgenerator.document.add')data={document:{id:'900',entityId:'42',entityTypeId:'2',templateId:'3',title:'КП'}};
  else throw Error('Unexpected method: '+method);
  cb({error:()=>null,data:()=>structuredClone(data)});
 }}});a.connected=true;return a;}
 return {options,calls,adapter,setBrokenRead:v=>brokenRead=v,setKeyed:v=>keyed=v,setDenySet:v=>denySet=v};
}
test('admin publishes common settings and template; independent manager sees identical configuration',async()=>{
 const f=fixture();const admin=new SharedSettingsStore(f.adapter(true),defaults);const manager=new SharedSettingsStore(f.adapter(false),defaults);
 assert.equal(await manager.read(),null);
 const expected={...defaults,historyFolderId:'77',deliveryProductId:'88, 99',rounding:'unit',dealId:'42',termTemplates:{...DEFAULT_TERM_TEMPLATES,validity:'Действительно 7 дней'}};
 const saved=await admin.save(expected,{templateId:'3'});
 assert.deepEqual(await manager.read(),saved);
 assert.equal(saved.settings.deliveryProductId,'88, 99');assert.equal(saved.settings.historyFolderId,'77');assert.equal(saved.settings.rounding,'unit');
 assert.ok(!('dealId'in saved.settings));assert.equal(f.options.yuzmQuoteTemplateId,'3');
 await assert.rejects(manager.save(expected,{expectedRevision:saved.revision}),/администратор/);
 assert.equal(f.calls.filter(c=>c.method==='app.option.set').length,1);
 assert.ok(f.calls.every(c=>!c.method.startsWith('crm.documentgenerator.template.')));
});
test('stale administrator revision is rejected before writing',async()=>{
 const f=fixture();const s=new SharedSettingsStore(f.adapter(true),defaults);await s.save(defaults);
 await assert.rejects(s.save({...defaults,historyFolderId:'99'},{expectedRevision:null}),/другим администратором/);
 assert.equal(f.calls.filter(c=>c.method==='app.option.set').length,1);
});
test('missing, malformed and keyed option responses are handled explicitly',async()=>{
 const f=fixture();const a=f.adapter(true);const s=new SharedSettingsStore(a,defaults);
 f.setKeyed(true);assert.equal(await a.getQuoteTemplateId(),'');
 const saved=await s.save(defaults,{templateId:'3'});assert.equal(await a.getQuoteTemplateId(),'3');assert.deepEqual(await s.read(),saved);
 f.options[SHARED_SETTINGS_OPTION]='{';await assert.rejects(s.read(),/некорректный JSON/);
});
test('server denial is surfaced without false confirmation',async()=>{
 const f=fixture();f.setDenySet(true);const s=new SharedSettingsStore(f.adapter(true),defaults);
 await assert.rejects(s.save(defaults),/ACCESS_DENIED/);assert.equal(f.options[SHARED_SETTINGS_OPTION],undefined);
});
test('manager generates with shared template without querying template administration methods',async()=>{
 const f=fixture();f.options.yuzmQuoteTemplateId='3';const a=f.adapter(false);let transferred=false;
 a.applyToDeal=async()=>{transferred=true;};
 const payload={dealId:'42',companyName:'ООО Тест',currency:'RUB',total:100,rows:[{productName:'Монтаж',rowType:'custom',quantity:'1',unitPrice:100,lineTotal:100,coatingCode:'none',executionTerm:''}]};
 const doc=await a.createQuoteDocument('42','3',payload);
 assert.equal(doc.id,'900');assert.ok(transferred);
 assert.ok(f.calls.some(c=>c.method==='crm.documentgenerator.document.add'));
 assert.ok(!f.calls.some(c=>c.method.startsWith('crm.documentgenerator.template.')));
});
test('changed shared template prevents manager transfer and generation',async()=>{
 const f=fixture();f.options.yuzmQuoteTemplateId='4';const a=f.adapter(false);let transferred=false;a.applyToDeal=async()=>{transferred=true;};
 const payload={dealId:'42',companyName:'Тест',currency:'RUB',total:100,rows:[{productName:'Работа',quantity:1,unitPrice:100,lineTotal:100,coatingCode:'none',executionTerm:''}]};
 await assert.rejects(a.createQuoteDocument('42','3',payload),/изменился/);assert.equal(transferred,false);
});
test('write accepted but verification denied reports unconfirmed persistence',async()=>{
 const f=fixture();const a=f.adapter(true);const original=a.call.bind(a);
 a.call=async(method,params)=>{const result=await original(method,params);if(method==='app.option.set')f.setBrokenRead(true);return result;};
 const s=new SharedSettingsStore(a,defaults);
 await assert.rejects(s.save(defaults),error=>error.settingsSent===true&&/подтверждение сохранения не получено/.test(error.message));
 assert.ok(f.options[SHARED_SETTINGS_OPTION]);
});
