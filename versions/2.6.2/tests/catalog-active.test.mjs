import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BitrixAdapter} from '../src/bitrix.js';
import {CatalogSearchIndex,filterCatalogEntries,isInactiveCatalogEntry} from '../src/catalog.js';

test('both REST activity fields exclude explicit false values while absent flags stay compatible',()=>{
  for(const flag of ['N',' n ',false,0,'0','false']){
    assert.equal(isInactiveCatalogEntry({active:flag}),true);
    assert.equal(isInactiveCatalogEntry({ACTIVE:flag}),true);
  }
  for(const flag of ['Y',true,1,'1',undefined,null])assert.equal(isInactiveCatalogEntry({active:flag}),false);
  assert.equal(isInactiveCatalogEntry({active:'Y',ACTIVE:'N'}),true);
});
test('inactive products cannot be retrieved from the search index by name, ID, empty query or get',()=>{
  const entries=[{id:'1',name:'Опора',active:'Y'},{id:'2',name:'Опора',active:'N'},
    {id:'3',name:'Опора',ACTIVE:'N'},{id:'4',name:'Опора',active:false}];
  const index=new CatalogSearchIndex(entries);
  for(const query of ['','Опора','1'])assert.deepEqual(index.search(query).map(p=>p.id),['1']);
  for(const query of ['2','#2','id:3','4'])assert.deepEqual(index.search(query),[]);
  assert.equal(index.get('2'),undefined);
  assert.deepEqual(filterCatalogEntries(entries).map(p=>p.id),['1']);
  assert.deepEqual(filterCatalogEntries(entries,'2','id'),[]);
});
function fixture({legacyOnly=false,getMissing=false,ignoreFilters=false,rejectProperties=false}={}){
 const calls=[];
 const rows=[{id:11,iblockId:24,name:'Опора',active:'Y',type:1,property108:{value:133}},
  {id:12,iblockId:24,name:'Архив',active:'N',type:1},
  {id:13,iblockId:24,name:'Архив вариация',active:'N',type:4,parentId:11},
  {id:14,iblockId:24,name:'Услуга',active:'Y',type:2}];
 const legacy=p=>({ID:p.id,NAME:p.name,CATALOG_ID:24,ACTIVE:p.active,PRICE:100,CURRENCY_ID:'RUB'});
 let priceReads=0;
 const sdk={callMethod(method,params,cb){
   calls.push({method,params});let data,error;
   if(legacyOnly&&method.startsWith('catalog.'))error='ERROR_METHOD_NOT_FOUND';
   else if(method==='catalog.catalog.list')data={catalogs:[{id:24,iblockId:24}]};
   else if(['catalog.product.list','catalog.product.sku.list','catalog.product.offer.list'].includes(method)){
     if(rejectProperties&&params.select.includes('property108'))error='ERROR_ARGUMENT';
     else data={products:rows.filter(p=>ignoreFilters||((!params.filter.id||p.id===params.filter.id)&&(!params.filter.active||p.active===params.filter.active)))};
   }
   else if(method==='crm.catalog.list')data=[{ID:24}];
   else if(method==='crm.product.list')data=rows.filter(p=>ignoreFilters||((!params.filter.ID||p.id===params.filter.ID)&&(!params.filter.ACTIVE||p.active===params.filter.ACTIVE))).map(legacy);
   else if(method==='catalog.product.get'){
     if(getMissing)error='ERROR_METHOD_NOT_FOUND';else data={product:rows.find(p=>p.id===params.id)};
   }
   else if(['catalog.product.offer.get','catalog.product.sku.get','crm.product.get'].includes(method)){
     if(getMissing)error='ERROR_METHOD_NOT_FOUND';else data=method==='crm.product.get'?legacy(rows.find(p=>p.id===params.id)):{product:rows.find(p=>p.id===params.id)};
   }
   else if(method==='catalog.priceType.list')data={priceTypes:[{id:1,base:'Y'}]};
   else if(method==='catalog.price.list') {priceReads++;data={prices:[{id:1,productId:11,catalogGroupId:1,price:100,currency:'RUB'}]};}
   else if(method==='crm.deal.get')data={ID:55,CURRENCY_ID:'RUB'};
   else if(method==='crm.deal.productrows.get')data=[{ID:1,PRODUCT_ID:12,PRODUCT_NAME:'Архив',PRICE:100,QUANTITY:1}];
   else error='ERROR_METHOD_NOT_FOUND';
   cb({error:()=>error||false,answer:{error},data:()=>data,more:()=>false});
 }};
 const adapter=new BitrixAdapter({sdk});adapter.connected=true;
 return {adapter,calls,rows,priceReads:()=>priceReads};
}
test('modern lists request active items and ignore inactive rows even when server ignores filter',async()=>{
 const {adapter,calls}=fixture({ignoreFilters:true});const entries=await adapter.listCatalogEntries();
 assert.deepEqual(entries.map(p=>p.id).sort(),['11','14']);
 const lists=calls.filter(c=>/^catalog\.product\..*list$/.test(c.method));
 assert.ok(lists.length);assert.ok(lists.every(c=>c.params.filter.active==='Y'));
 assert.ok(!adapter._catalogRaw.has('12'));assert.ok(!adapter._catalogRaw.has('13'));
});
test('legacy lists also request ACTIVE=Y and locally exclude archived products',async()=>{
 const {adapter,calls}=fixture({legacyOnly:true,ignoreFilters:true});const entries=await adapter.listCatalogEntries();
 assert.deepEqual(entries.map(p=>p.id).sort(),['11','14']);
 assert.ok(calls.filter(c=>c.method==='crm.product.list').every(c=>c.params.filter.ACTIVE==='Y'));
});
test('retrying unsupported property selects preserves the active-only filter',async()=>{
 const {adapter,calls}=fixture({rejectProperties:true,ignoreFilters:true});const entries=await adapter.listCatalogEntries();
 assert.deepEqual(entries.map(p=>p.id).sort(),['11','14']);
 assert.ok(calls.filter(c=>c.method==='catalog.product.list'||c.method==='catalog.product.sku.list').every(c=>c.params.filter.active==='Y'));
});
test('deactivation after catalog load blocks selection before reading prices; refresh hides it',async()=>{
 const {adapter,rows,priceReads}=fixture();await adapter.listCatalogEntries();rows[0].active='N';
 await assert.rejects(adapter.getProduct(11),error=>error.code==='PRODUCT_INACTIVE');
 assert.equal(priceReads(),0);assert.ok(!(await adapter.listCatalogEntries({refresh:true})).some(p=>p.id==='11'));
});
test('legacy get cannot bypass deactivation through the active cached list',async()=>{
 const {adapter,rows}=fixture({legacyOnly:true});await adapter.listCatalogEntries();rows[0].active='N';
 await assert.rejects(adapter.getProduct(11),error=>error.code==='PRODUCT_INACTIVE');
});
test('when get is unsupported, selection checks fresh active-only list rather than trusting cached activity',async()=>{
 const {adapter,rows,calls}=fixture({getMissing:true});await adapter.listCatalogEntries();
 assert.equal((await adapter.getProduct(11)).id,'11');rows[0].active='N';
 await assert.rejects(adapter.getProduct(11),/не найден среди активных/);
 assert.ok(calls.some(c=>c.method.startsWith('catalog.product.')&&c.method.endsWith('.list')&&c.params.filter.id===11&&c.params.filter.active==='Y'));
});
test('old deal rows are read intact but inactive products block CRM writes',async()=>{
 const {adapter,calls}=fixture();const deal=await adapter.loadDeal(55);assert.equal(deal.rows[0].productId,'12');
 await assert.rejects(adapter.applyToDeal(55,{dealId:'55',currency:'RUB',rows:[{productId:'12',productName:'Архив',unitPrice:100,quantity:1}],total:100}),error=>error.code==='PRODUCT_INACTIVE');
 assert.ok(!calls.some(c=>c.method==='crm.item.productrow.set'||c.method==='crm.deal.productrows.set'));
});

test('an empty active catalog is valid when another optional endpoint is unavailable',async()=>{
 const {adapter,rows}=fixture();rows.forEach(row=>row.active='N');
 const original=adapter.call.bind(adapter);
 adapter.call=async(method,params)=>{
   if(method==='catalog.product.sku.list'){
     const error=new Error('Optional SKU endpoint unavailable');error.code='ERROR_METHOD_NOT_FOUND';throw error;
   }
   return original(method,params);
 };
 assert.deepEqual(await adapter.listCatalogEntries(),[]);
});
