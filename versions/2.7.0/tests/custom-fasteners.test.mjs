import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calculateQuote,validateConfig,withCoatingOptions,formatCoating} from '../src/calculator.js';
import {newRow,newCustomRow} from '../src/demo.js';
import {assignFasteners} from '../src/fasteners.js';
import {BitrixAdapter,fingerprintRows} from '../src/bitrix.js';
const config=withCoatingOptions(validateConfig({currency:'RUB',rounding:'unit',coatings:[{code:'none',name:'Без покрытия'}]}));
const product={id:'11',name:'НФГ-6,0-05-ц',basePrice:1000,currency:'RUB',source:'catalog',isSupportSection:true,fastenerUnitPrice:500};
function goods(){const row=newRow(product);assignFasteners(row,product);return row;}
function custom(){return {...newCustomRow(),productName:'Монтаж по чертежу',basePrice:'250',quantity:'2'};}
test('fasteners are added once per unit before all coefficients and quantity',()=>{
 const row={...goods(),k1:'2',k2:'1,5',k3:'1,2',quantity:'3'};
 const result=calculateQuote([row],config);assert.equal(result.valid,true);assert.equal(result.rows[0].unitPrice,5400);assert.equal(result.total,16200);
 const off=calculateQuote([{...row,fastenersEnabled:false}],config);assert.equal(off.total,10800);
});
test('only section classification enables automatic addition; names do not affect the choice',()=>{
 const row=newRow(product);assignFasteners(row,{...product,name:'Любое изделие',isSupportSection:false});
 assert.equal(row.fastenersEnabled,false);assert.equal(calculateQuote([row],config).total,1000);
 const old=newRow(product);assert.equal(old.fastenersEnabled,false);assert.equal(calculateQuote([old],config).total,1000);
});
test('custom row requires name and explicit price, including explicit zero; all coefficients and quantity apply',()=>{
 let row=newCustomRow();assert.equal(calculateQuote([row],config).valid,false);
 row.productName='Своя позиция';assert.equal(calculateQuote([row],config).valid,false);
 row.basePrice='0';assert.equal(calculateQuote([row],config).valid,true);
 row={...row,basePrice:'125,50',quantity:'3',k1:'2',k2:'1,5',k3:'1,2'};
 assert.equal(calculateQuote([row],config).total,1355.4);
 assert.equal(calculateQuote([{...row,basePrice:'-1'}],config).valid,false);
});
test('custom coating text is required and exported as entered; retired excel formula is ignored',()=>{
 assert.throws(()=>formatCoating({code:'custom'}),/Нестандартное/);
 const row={...custom(),coatingCode:'custom',customCoating:'Двухслойное покрытие заказчика'};
 const result=calculateQuote([row],config);assert.equal(result.rows[0].coatingName,row.customCoating);
 assert.equal(calculateQuote([{...row,customCoating:''}],config).valid,false);
 assert.equal(validateConfig({...config,formulaMode:'excel'}).formulaMode,'catalog');
 assert.equal(calculateQuote([{...goods(),pricePerKg:900,weight:900}],{...config,formulaMode:'excel'}).total,1500);
});
function adapterFixture({failDocument=false}={}){
 const adapter=new BitrixAdapter(),calls=[];adapter.connected=true;
 let current=[{productId:'99',productName:'Прежний товар',unitPrice:20,quantity:1,taxRate:0,taxIncluded:'Y'}];
 adapter._documentDeal=async()=>({currency:'RUB',categoryId:'0'});
 adapter.loadDeal=async()=>({id:'55',currency:'RUB',rows:structuredClone(current)});
 adapter.getProduct=async(id)=>{calls.push({method:'GET_PRODUCT',id});assert.equal(String(id),'11');return {verified:true,currency:'RUB'};};
 adapter.call=async(method,params)=>{
  calls.push({method,params});
  if(method==='crm.documentgenerator.template.get')return {template:{id:3,name:'КП',active:'Y',isDeleted:'N',entityTypeId:['2']}};
  if(method==='crm.item.productrow.set') {current=params.productRows.map(r=>({productId:String(r.productId),productName:r.productName,unitPrice:r.price,quantity:r.quantity,taxRate:r.taxRate,taxIncluded:r.taxIncluded}));return true;}
  if(method==='crm.documentgenerator.document.add'){
   if(failDocument)throw new Error('Generation failed');
   return {document:{id:77,templateId:3,entityId:55,entityTypeId:2,downloadUrl:'https://portal.example/doc.docx'}};
  }
  throw new Error(method);
 };
 return {adapter,calls,current:()=>current};
}
function snapshot(rows){const q=calculateQuote(rows,config);assert.equal(q.valid,true);return {...q,config,dealId:'55',companyName:'Заказчик',currency:'RUB',documentFields:{}};}
test('mixed quote contains custom lines and full total in DOCX, but CRM receives catalog goods only',async()=>{
 const {adapter,calls,current}=adapterFixture();const row={...custom(),coatingCode:'custom',customCoating:'Покрытие заказчика'};
 const q=snapshot([goods(),row]);assert.equal(q.total,2000);
 await adapter.createQuoteDocument(55,3,q);
 assert.equal(current().length,1);assert.equal(current()[0].productId,'11');assert.equal(current()[0].unitPrice,1500);
 assert.equal(calls.filter(c=>c.method==='GET_PRODUCT').length,1);
 const doc=calls.find(c=>c.method==='crm.documentgenerator.document.add').params;
 assert.equal(doc.values.KpItems.length,2);assert.equal(doc.values.KpItems[1].Name,row.productName);assert.equal(doc.values.KpItems[1].Coating,row.customCoating);
 assert.equal(doc.fields.TotalSum.VALUE.replace(/\s/g,''),'2000,00');
});
test('custom-only quote generates document without clearing or editing existing CRM goods',async()=>{
 const {adapter,calls,current}=adapterFixture();await adapter.createQuoteDocument(55,3,snapshot([custom()]));
 assert.equal(current()[0].productId,'99');assert.ok(!calls.some(c=>c.method==='GET_PRODUCT'||c.method==='crm.item.productrow.set'));
 assert.equal(calls.find(c=>c.method==='crm.documentgenerator.document.add').params.values.KpItems.length,1);
});
test('failed custom-only generation does not claim CRM goods were changed',async()=>{
 const {adapter,current}=adapterFixture({failDocument:true});
 await assert.rejects(adapter.createQuoteDocument(55,3,snapshot([custom()])),error=>error.goodsTransferred===false);
 assert.equal(current()[0].productId,'99');
});
test('explicit CRM transfer uses goods subtotal and refuses custom-only payload without writes',async()=>{
 const {adapter,calls,current}=adapterFixture();const expected=fingerprintRows(current());
 const result=await adapter.applyToDeal(55,snapshot([goods(),custom()]),expected);assert.equal(result.total,1500);
 const n=calls.length;await assert.rejects(adapter.applyToDeal(55,snapshot([custom()])),/только произвольные/);assert.equal(calls.length,n);
});
test('display prices batch visible IDs without per-product get and retain missing/zero distinction',async()=>{
 const adapter=new BitrixAdapter();adapter.connected=true;
 adapter._catalogRaw.set('11',{raw:{id:11,name:'Опора',iblockId:24},source:'catalog.product.list'});
 adapter._catalogRaw.set('12',{raw:{id:12,name:'Другой товар',iblockId:24},source:'catalog.product.list'});
 adapter._catalogRaw.set('13',{raw:{id:13,name:'Нулевая цена',price:0,currency:'RUB'},source:'catalog.product.list'});
 const requested=[];adapter._prices=async ids=>{requested.push(ids);return new Map([['11',{basePrice:1000,currency:'RUB'}]]);};
 const result=await adapter.getCatalogPrices(['11','12','13']);assert.deepEqual(requested,[['11','12']]);
 assert.equal(result[0].basePrice,1000);assert.equal(result[0].priceMissing,false);assert.equal(result[1].priceMissing,true);
 assert.equal(result[2].basePrice,0);assert.equal(result[2].priceMissing,false);
 await assert.rejects(adapter.getCatalogPrices(Array.from({length:51},(_,i)=>i+1)),/до 50/);
});

