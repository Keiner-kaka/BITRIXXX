import {test} from 'node:test';
import assert from 'node:assert/strict';
import {catalogNavigation, navigationLabels, navigationFields, CatalogSearchIndex} from '../src/catalog.js';
import {BitrixAdapter} from '../src/bitrix.js';
import {newRow} from '../src/demo.js';

test('only properties 108/110/112 from iblock 24 are accepted, never property 114', () => {
  assert.deepEqual(navigationFields(), ['property108', 'property110', 'property112']);
  const nav = catalogNavigation({iblockId:24, property108:{value:'133'},property110:[{value:'3,5'}],property112:{value:0},property114:{value:4785}});
  assert.deepEqual(nav, {diameter:133,wallThickness:3.5,weight:0});
  assert.deepEqual(navigationLabels(nav), ['Стенка: 3,5 мм','Диаметр: 133 мм','Вес: 0 кг']);
  assert.deepEqual(catalogNavigation({iblockId:25,property108:{value:159}}),{});
  assert.deepEqual(catalogNavigation({CATALOG_ID:24,PROPERTY_108:{VALUE:'159'},PROPERTY_110:'4',PROPERTY_112:[{VALUE:'28'}]}),{diameter:159,wallThickness:4,weight:28});
});
test('empty, malformed and ambiguous values are omitted rather than shown as zero', () => {
  for (const value of [null,'','  ',false,'bad',-1,'Infinity',[1,2],{}, {value:''}]) {
    assert.deepEqual(catalogNavigation({iblockId:24,property108:value}), {});
  }
});
test('same clean names can be distinguished through diameter, wall and weight search', () => {
  const entries=[{id:'11',name:'ЗФ-20/4/К230-1,5-б',navigation:{diameter:133,wallThickness:3.5,weight:28}},
    {id:'12',name:'ЗФ-20/4/К230-1,5-б',navigation:{diameter:159,wallThickness:4,weight:31}}];
  const index=new CatalogSearchIndex(entries);
  for (const query of ['133','диаметр 133','ЗФ стенка 3,5','вес 28']) assert.deepEqual(index.search(query).map(e=>e.id),['11']);
  assert.deepEqual(index.search('159').map(e=>e.id),['12']);
  assert.deepEqual(index.search('#12').map(e=>e.id),['12']);
  assert.equal(index.search('ЗФ').length,2);
});
function fixture({reject=false,ignored=false,legacyOnly=false,legacyDenied=false}={}) {
  const calls=[];
  const goods=[{id:11,iblockId:24,name:'Одинаковое название',type:1,property108:{value:133},property110:{value:3},property112:{value:64},property114:{value:99999}},
    {id:12,iblockId:24,name:'Одинаковое название',type:1,property108:{value:159},property110:{value:4},property112:{value:81}}];
  function response(method,params) {
    if(legacyOnly&&method.startsWith('catalog.'))return {error:'ERROR_METHOD_NOT_FOUND'};
    if(method==='catalog.catalog.list')return {catalogs:[{id:24,iblockId:24},{id:25,iblockId:25}]};
    if(method==='catalog.product.list'){
      if(params.filter.iblockId===25)return {products:[{id:99,iblockId:25,name:'Другой каталог'}]};
      if(reject&&params.select.includes('property108'))return {error:'ERROR_ARGUMENT'};
      return {products:goods.map(g=>reject||ignored?{id:g.id,iblockId:g.iblockId,name:g.name}:g)};
    }
    if(method==='catalog.product.sku.list')return {products:[]};
    if(method==='crm.catalog.list')return [{ID:24},{ID:25}];
    if(method==='crm.product.list'){
      if(legacyDenied)return {error:'ACCESS_DENIED'};
      assert.equal(params.filter.CATALOG_ID,24);
      return goods.map(g=>({ID:g.id,NAME:g.name,CATALOG_ID:24,PROPERTY_108:{VALUE:g.property108.value},PROPERTY_110:{VALUE:g.property110.value},PROPERTY_112:{VALUE:g.property112.value}}));
    }
    if(method==='catalog.product.get')return {product:goods.find(g=>g.id===params.id)};
    if(method==='catalog.priceType.list')return {priceTypes:[{id:1,base:'Y'}]};
    if(method==='catalog.price.list')return {prices:[{id:1,productId:11,catalogGroupId:1,price:4785,currency:'RUB'}]};
    if(method==='crm.product.get')return {ID:params.id,NAME:'Одинаковое название',PRICE:4785,CURRENCY_ID:'RUB'};
    return {error:'ERROR_METHOD_NOT_FOUND'};
  }
  const sdk={callMethod(method,params,cb){calls.push({method,params});const data=response(method,params);
    cb({error:()=>data.error||false,answer:{error:data.error},data:()=>data,more:()=>false});}};
  const adapter=new BitrixAdapter({sdk});adapter.connected=true;return {adapter,calls};
}
test('modern properties travel on paginated product lists and subsequent searches make no calls',async()=>{
  const {adapter,calls}=fixture();const entries=await adapter.listCatalogEntries();
  assert.equal(entries.find(e=>e.id==='11').navigation.diameter,133);
  const relevant=calls.filter(c=>c.method==='catalog.product.list');
  assert.ok(relevant.find(c=>c.params.filter.iblockId===24).params.select.includes('property108'));
  assert.ok(!relevant.find(c=>c.params.filter.iblockId===25).params.select.includes('property108'));
  assert.ok(!calls.some(c=>c.method.endsWith('.get')||c.method.startsWith('crm.')));
  const n=calls.length;await adapter.listCatalogEntries();new CatalogSearchIndex(entries).search('133');assert.equal(calls.length,n);
  assert.ok(!JSON.stringify(calls).includes('property114'));
});
test('rejected or silently ignored modern fields fall back to one CRM list, not one request per product',async()=>{
  for (const mode of [{reject:true},{ignored:true}]){
    const {adapter,calls}=fixture(mode);const entries=await adapter.listCatalogEntries();
    assert.equal(entries.find(e=>e.id==='12').navigation.diameter,159);
    const legacy=calls.filter(c=>c.method==='crm.product.list');assert.equal(legacy.length,1);
    assert.ok(legacy[0].params.select.includes('PROPERTY_112'));
    assert.ok(!calls.some(c=>c.method.endsWith('.get')));
  }
});
test('legacy-only portal returns characteristics; access failure leaves searchable products and warning',async()=>{
  const legacy=fixture({legacyOnly:true});assert.equal((await legacy.adapter.listCatalogEntries())[0].navigation.diameter,133);
  const denied=fixture({ignored:true,legacyDenied:true});assert.equal((await denied.adapter.listCatalogEntries()).length,3);
  assert.ok(denied.adapter.catalogWarnings.some(w=>w.includes('Характеристики')));
});
test('selected product price and persisted calculation row ignore navigation weight and price property',async()=>{
  const {adapter}=fixture();await adapter.listCatalogEntries();const product=await adapter.getProduct(11);
  assert.equal(product.basePrice,4785);assert.equal(product.name,'Одинаковое название');assert.equal(product.navigation,undefined);
  const row=newRow({...product,navigation:{diameter:133,weight:64}});
  assert.equal(row.productName,'Одинаковое название');assert.equal(row.weight,'');assert.equal(row.navigation,undefined);
  assert.ok(!JSON.stringify(row).includes('diameter'));
});
