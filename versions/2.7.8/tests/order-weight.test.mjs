import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {calculateQuote,validateConfig,withCoatingOptions} from '../src/calculator.js';
import {newRow,newCustomRow} from '../src/demo.js';
import {calculationVersion,restoreCalculationVersion} from '../src/calculation-version.js';
import {BitrixAdapter} from '../src/bitrix.js';
const config=withCoatingOptions(validateConfig(JSON.parse(await readFile(new URL('../data/coatings.example.json',import.meta.url),'utf8'))));
const rows=[{...newRow({id:'9',name:'Опора',basePrice:10,currency:'RUB'}),weightKg:'2,345',quantity:'3',k1:'4',k2:'5',k3:'6'},
 {...newCustomRow(),productName:'Своя',weightKg:'0,125',pricePerKg:'10',quantity:'2',k1:'0,9',k2:'3',k3:'2'},
 {...newRow({id:'10',name:'Без веса',basePrice:5,currency:'RUB'}),quantity:'10'}];
const c=calculateQuote(rows,config);assert.ok(c.valid);assert.equal(c.weightTotal,7.285);
const changed=calculateQuote(rows.map(r=>({...r,k1:'1',k2:'1',k3:'1'})),config);assert.equal(changed.weightTotal,c.weightTotal);assert.notEqual(changed.total,c.total);
const version=calculationVersion({dealId:'42',quoteId:'q',companyName:'Тест',currency:'RUB',config,rows:c.rows},{event:'generation',deal:{TITLE:'Тест'}});
assert.deepEqual(version.parameters.rows.map(r=>r.weightKg),['2,345','0,125','']);
const restored=restoreCalculationVersion(version,'42',config);assert.equal(calculateQuote(restored.rows,config).weightTotal,c.weightTotal);
assert.equal(calculateQuote([{...rows[0],weightKg:'-1'}],config).valid,false);
assert.equal(calculateQuote([{...rows[0],weightKg:'bad'}],config).valid,false);
function fixture(){
 let storedRows=[],storedWeight=0;const calls=[];let writable=true;let round=false;
 const a=new BitrixAdapter({sdk:{isAdmin:()=>false}});a.connected=true;
 a.getProduct=async()=>({verified:true,currency:'RUB'});
 a.loadDeal=async()=>({currency:'RUB',rows:storedRows});
 a.call=async(method,params)=>{calls.push({method,params});
 if(method==='app.option.get')return '3';
 if(method==='crm.deal.fields')return {UF_CRM_WEIGHT:{type:'double',isReadOnly:!writable,isMultiple:false}};
 if(method==='crm.deal.get')return {ID:'42',CURRENCY_ID:'RUB',CATEGORY_ID:'0',UF_CRM_WEIGHT:storedWeight};
 if(method==='crm.deal.update'){storedWeight=round?Math.round(params.fields.UF_CRM_WEIGHT):params.fields.UF_CRM_WEIGHT;return true;}
 if(method==='crm.item.productrow.set'){storedRows=params.productRows.map(r=>({...r,productId:String(r.productId??''),unitPrice:r.price}));return true;}
 if(method==='crm.documentgenerator.document.add')return {document:{id:'900',entityId:'42',entityTypeId:'2',templateId:'3',title:'КП'}};
 throw Error(method);};
 return {a,calls,setWritable:v=>writable=v,setRound:v=>round=v};
}
const snap={dealId:'42',companyName:'Тест',currency:'RUB',config,rows:c.rows,total:c.total,weightFieldCode:'UF_CRM_WEIGHT',weightTotal:c.weightTotal};
const f=fixture();const doc=await f.a.createQuoteDocument('42','3',snap);assert.equal(doc.id,'900');
const update=f.calls.find(x=>x.method==='crm.deal.update');assert.deepEqual(update.params.fields,{UF_CRM_WEIGHT:7.285});
assert.ok(f.calls.findIndex(x=>x.method==='crm.item.productrow.set')<f.calls.indexOf(update));
assert.ok(f.calls.indexOf(update)<f.calls.findIndex(x=>x.method==='crm.documentgenerator.document.add'));
const invalid=fixture();invalid.setWritable(false);await assert.rejects(invalid.a.saveOrderWeight('42','UF_CRM_WEIGHT',7.285),/числовое поле/);assert.ok(!invalid.calls.some(x=>x.method==='crm.deal.update'));
const rounded=fixture();rounded.setRound(true);await assert.rejects(rounded.a.saveOrderWeight('42','UF_CRM_WEIGHT',7.285),/отличается/);assert.equal(rounded.calls.filter(x=>x.method==='crm.deal.update').length,1);
console.log('PASS: all-row mass × quantity without coefficients; JSON per-row weight roundtrip; CRM numeric field validation, write/readback, generation order and precision mismatch without retry');
