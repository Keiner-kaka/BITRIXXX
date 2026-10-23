import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BitrixAdapter} from '../src/bitrix.js';
import {IntegrationSettings, CONFIG_OPTION, normalizeFields, normalizeIntegrationConfig} from '../src/integration-config.js';
import {diagnoseIntegration} from '../src/integration-diagnostics.js';
import {DiskTexts} from '../src/text-templates.js';
import {formatActionError, safeErrorText} from '../src/rest-errors.js';

const texts = JSON.parse(await readFile(new URL('../data/yuzm-quote-texts.json', import.meta.url)));
const rawFields = {DATE_CREATE:{type:'datetime'},COMPANY_ID:{type:'crm_company'},ASSIGNED_BY_ID:{type:'user'},
  TOTAL:{title:'Стоимость',type:'money'},SHIPPING:{title:'Доставка',type:'double'},WEIGHT:{title:'Вес',type:'double'},SNAPSHOT:{title:'JSON',type:'string'}};
const fields = normalizeFields(rawFields);
const config = () => normalizeIntegrationConfig({fields:{total:{code:'TOTAL'},delivery:{code:'SHIPPING'},weight:{code:'WEIGHT'},snapshot:{code:'SNAPSHOT'}},resources:{textFileId:'101',textFolderId:'102'}});
function fixture({admin=true,exists=true}={}) {
  const options = {yuzmQuoteTemplateId:'3',yuzmManagerSignature_7:'{"kind":"disk","fileId":"300"}'};
  if(exists) options[CONFIG_OPTION]=JSON.stringify(config());
  const state={calls:[],options,fail:{},writes:0,failReadAfterWrite:false,mismatch:false,dropSetReply:false};
  const adapter=new BitrixAdapter({timeoutMs:25,sdk:{isAdmin:()=>admin,callMethod(method,params,callback){
    state.calls.push({method,params:structuredClone(params)});
    let data, failure=state.fail[method];
    if(method==='app.option.get' && state.failReadAfterWrite && state.writes) failure={code:'ACCESS_DENIED',description:'Контрольное чтение запрещено.'};
    if(method==='disk.file.get' && state.fail['file-'+params.id]) failure=state.fail['file-'+params.id];
    if(!failure){
      if(method==='app.option.get') data=state.mismatch&&state.writes ? JSON.stringify(config()) : options[params.option]??'';
      else if(method==='app.option.set'){Object.assign(options,params.options);state.writes++;data=true;if(state.dropSetReply)return;}
      else if(method==='crm.deal.fields')data=rawFields;
      else if(method==='crm.deal.userfield.list')data=[];
      else if(method==='methods')data=[]; // Deliberately incomplete. No decision may depend on it.
      else if(method==='crm.documentgenerator.template.list')data={templates:{3:{id:3,name:'КП'}}};
      else if(method==='disk.file.get')data={ID:String(params.id),NAME:params.id===101?'texts.json':'reference.csv',TYPE:'file',DOWNLOAD_URL:'https://portal.example/download?token=HIDDEN_URL_TOKEN'};
      else if(method==='disk.folder.get')data={ID:String(params.id),TYPE:'folder'};
      else if(method==='disk.folder.getchildren')data=[];
      else if(method==='disk.file.uploadVersion')data={ID:String(params.id)};
      else throw new Error('Unexpected method '+method);
    }
    callback({error:()=>failure?.code||false,answer:{error:failure?.code,error_description:failure?.description},data:()=>structuredClone(data),more:()=>false});
  }}});
  adapter.connected=true;
  const settings=new IntegrationSettings(adapter,{now:()=>Date.parse('2026-10-24T09:00:00Z')});
  const disk=new DiskTexts(adapter,{fetcher:async()=>new Response(JSON.stringify(texts))});
  return {adapter,settings,disk,state};
}
test('settings save uses only app.option.set/get and ignores absent methods, generator and Disk permissions',async()=>{
  const f=fixture();
  for(const method of ['methods','crm.documentgenerator.template.list','disk.file.get','disk.file.uploadVersion'])f.state.fail[method]={code:'ACCESS_DENIED'};
  const original=config(), saved=await f.settings.save(original,fields);
  assert.deepEqual(f.state.calls.map(call=>call.method),['app.option.set','app.option.get']);
  assert.equal(saved.fields.total.code,'TOTAL');assert.equal(saved.revision,'2026-10-24T09:00:00.000Z');assert.equal(original.revision,'');
  assert.equal(f.state.options.yuzmQuoteTemplateId,'3');assert.equal(f.state.options.yuzmManagerSignature_7,'{"kind":"disk","fileId":"300"}');
});
test('confirmed settings and revision survive a new settings service instance',async()=>{
  const f=fixture(),saved=await f.settings.save(config(),fields);
  const record=await new IntegrationSettings(f.adapter).loadRecord();
  assert.equal(record.exists,true);assert.deepEqual(record.config,saved);
});
test('defaults are explicitly distinguished from an existing record without revision',async()=>{
  const absent=fixture({exists:false});const empty=await absent.settings.loadRecord();
  assert.equal(empty.exists,false);assert.equal(empty.config.fields.client.code,'COMPANY_ID');assert.equal(absent.state.writes,0);
  const legacy=await fixture().settings.loadRecord();assert.equal(legacy.exists,true);assert.equal(legacy.config.revision,'');
});
test('each successful write receives a fresh revision even within one clock millisecond',async()=>{
  const f=fixture(),first=await f.settings.save(config(),fields),second=await f.settings.save(config(),fields);
  assert.equal(Date.parse(second.revision)-Date.parse(first.revision),1);
});
test('invalid structure, IDs, missing fields, incompatible types and duplicates block writes',async()=>{
  for(const change of [c=>c.resources.textFileId='-1',c=>c.resources.textFolderId='12.3',c=>c.resources.textFolderId=0,c=>c.resources.referenceFileIds='1,2',c=>c.fields.weight.code='SNAPSHOT',c=>c.fields.total.code='SHIPPING',c=>c.fields.snapshot.code='',c=>c.fields.total={code:1},c=>c.resources=[]]){
    const f=fixture(),candidate=config();change(candidate);await assert.rejects(f.settings.save(candidate,fields));assert.equal(f.state.writes,0);
  }
});
test('explicit REST write rejection preserves the input and exposes safe method/code/description',async()=>{
  const f=fixture(),candidate=config(),before=structuredClone(candidate);f.state.fail['app.option.set']={code:'ACCESS_DENIED',description:'Только администратор может менять настройки.'};
  await assert.rejects(f.settings.save(candidate,fields),error=>{
    assert.notEqual(error.writeSubmitted,true);
    assert.match(formatActionError('Сохранение настроек',error),/app.option.set.*ACCESS_DENIED/);
    assert.match(error.description,/Только администратор/);return true;
  });assert.deepEqual(candidate,before);assert.equal(f.state.writes,0);
});
test('acknowledged write followed by failed readback is unconfirmed and can be reloaded later',async()=>{
  const f=fixture(),candidate=config();f.state.failReadAfterWrite=true;
  await assert.rejects(f.settings.save(candidate,fields),error=>error.writeSubmitted===true&&/Запись отправлена/.test(error.message)&&error.cause.method==='app.option.get');
  assert.equal(f.state.writes,1);assert.equal(candidate.revision,'');
  f.state.failReadAfterWrite=false;const record=await f.settings.loadRecord();assert.equal(record.config.revision,'2026-10-24T09:00:00.000Z');
});
test('different or absent readback never becomes a successful confirmation',async()=>{
  const f=fixture();f.state.mismatch=true;
  await assert.rejects(f.settings.save(config(),fields),error=>error.writeSubmitted&&error.cause.code==='CONFIG_MISMATCH');
  f.state.mismatch=false;const next=await f.settings.save(config(),fields);assert.equal(next.revision,'2026-10-24T09:00:00.001Z');
});
test('lost write response remains unconfirmed while preserving the actually stored configuration',async()=>{
  const f=fixture();f.state.dropSetReply=true;
  await assert.rejects(f.settings.save(config(),fields),error=>error.writeSubmitted&&error.cause.code==='REQUEST_TIMEOUT');
  assert.equal((await f.settings.loadRecord()).exists,true);assert.equal(f.state.writes,1);
});
test('ordinary managers read common settings and run read-only diagnostics but cannot save or publish',async()=>{
  const f=fixture({admin:false});assert.equal((await f.settings.loadRecord()).exists,true);
  await assert.rejects(f.settings.save(config(),fields),/администратор/);await assert.rejects(f.disk.publish('101',texts),/администратор/);
  const report=await diagnoseIntegration(f.adapter,f.settings,f.disk,config());assert.ok(report.every(row=>row.state!=='error'));assert.equal(f.state.writes,0);
  assert.ok(!f.state.calls.some(call=>call.method==='disk.file.uploadVersion'));
});
test('diagnostics call template.list directly and never use methods or mutate settings/data',async()=>{
  const f=fixture(),before=structuredClone(f.state.options),progress=[];
  const report=await diagnoseIntegration(f.adapter,f.settings,f.disk,config(),row=>progress.push(row.key));
  assert.equal(report.length,5);assert.equal(progress.length,5);assert.equal(report.find(row=>row.key==='documents').state,'ok');
  assert.ok(f.state.calls.some(call=>call.method==='crm.documentgenerator.template.list'));
  assert.ok(f.state.calls.every(call=>['crm.deal.fields','crm.deal.userfield.list','crm.documentgenerator.template.list','disk.file.get','disk.folder.get','disk.folder.getchildren'].includes(call.method)));
  assert.deepEqual(f.state.options,before);
});
test('generator and file errors appear independently while other components still run',async()=>{
  const f=fixture(),candidate=config();candidate.resources.referenceFileIds=['201','202'];
  f.state.fail['crm.documentgenerator.template.list']={code:'ACCESS_DENIED',description:'Нет доступа к шаблонам.'};
  f.state.fail['file-101']={code:'ACCESS_DENIED',description:'Файл текстов недоступен.'};
  f.state.fail['file-201']={code:'ERROR_NOT_FOUND',description:'Нет справочного файла.'};
  const report=await diagnoseIntegration(f.adapter,f.settings,f.disk,candidate);
  assert.deepEqual(Object.fromEntries(report.map(row=>[row.key,row.state])),{fields:'ok',documents:'error',texts:'error',folder:'ok','reference-0':'error','reference-1':'ok'});
  assert.match(report.find(row=>row.key==='texts').message,/disk.file.get.*ACCESS_DENIED/);
  await f.settings.save(candidate,fields);assert.equal(f.state.writes,1);
});
test('bad JSON is a diagnostic error but cannot prevent saving field mappings',async()=>{
  const f=fixture();f.disk.fetcher=async()=>new Response('{');
  const report=await diagnoseIntegration(f.adapter,f.settings,f.disk,config());assert.equal(report.find(row=>row.key==='texts').state,'error');
  assert.equal(report.find(row=>row.key==='documents').state,'ok');await f.settings.save(config(),fields);assert.equal(f.state.writes,1);
});
test('invalid optional resource IDs do not suppress independent field and generator probes',async()=>{
  const f=fixture(),candidate=config();candidate.resources.textFileId='bad';candidate.resources.textFolderId='bad';
  const report=await diagnoseIntegration(f.adapter,f.settings,f.disk,candidate);
  assert.equal(report.find(row=>row.key==='fields').state,'ok');assert.equal(report.find(row=>row.key==='documents').state,'ok');
  assert.equal(report.find(row=>row.key==='texts').state,'error');assert.equal(report.find(row=>row.key==='folder').state,'error');
});
test('missing uploadVersion is checked only at publication and does not prevent save or text reading',async()=>{
  const f=fixture();f.state.fail['disk.file.uploadVersion']={code:'ERROR_METHOD_NOT_FOUND',description:'Метод недоступен.'};
  await f.settings.save(config(),fields);assert.equal((await f.disk.read('101')).schemaVersion,1);
  assert.ok(!f.state.calls.some(call=>call.method==='disk.file.uploadVersion'));
  await assert.rejects(f.disk.publish('101',texts),/ERROR_METHOD_NOT_FOUND/);await f.settings.save(config(),fields);assert.equal(f.state.writes,2);
});
test('REST descriptions retain useful text while redacting URLs, webhook secrets and tokens',async()=>{
  const f=fixture();const secrets=['URL_TOKEN','WEBHOOK_SECRET','AUTH_SECRET','BEARER_SECRET','ENCODED_SECRET'];
  f.state.fail['disk.file.get']={code:'ACCESS_DENIED',description:'Файл недоступен. https://portal.example/download?auth=URL_TOKEN /rest/7/WEBHOOK_SECRET/disk.file.get auth[auth]=AUTH_SECRET Bearer BEARER_SECRET https%253A%252F%252Fportal.example%252Ffile%253Ftoken%253DENCODED_SECRET'};
  await assert.rejects(f.adapter.call('disk.file.get',{id:101}),error=>{
    const output=formatActionError('Проверка текстов',error);assert.match(output,/Файл недоступен/);assert.match(output,/disk.file.get.*ACCESS_DENIED/);
    for(const secret of secrets)assert.ok(!output.includes(secret));return true;
  });
  assert.ok(!safeErrorText('client_secret="SENSITIVE" refresh_token=OTHER').includes('SENSITIVE'));
  assert.ok(!safeErrorText('client_secret="SENSITIVE" refresh_token=OTHER').includes('OTHER'));
});
