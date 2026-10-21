import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BitrixAdapter} from '../src/bitrix.js';
import {catalogNavigation,navigationLabels,navigationFields,CatalogSearchIndex} from '../src/catalog.js';
import {SUPPORT_SECTION_IDS,assignFasteners} from '../src/fasteners.js';
import {calculateQuote,validateConfig,withCoatingOptions} from '../src/calculator.js';
import {newRow} from '../src/demo.js';
const config=withCoatingOptions(validateConfig({currency:'RUB',coatings:[{code:'none',name:'Без покрытия'}]}));
const full={id:11,iblockId:24,iblockSectionId:44,name:'Произвольное название изделия',type:1,active:'Y',
 property108:{value:'133'},property110:{value:'4'},property112:{value:'28'},property116:{value:'725,50'},
 property118:{value:'300×300'},property120:{value:'220/250'},property122:{value:'Торцевое'},property124:{value:'60/133'}};
function legacy(p){
 const r={ID:p.id,CATALOG_ID:p.iblockId,SECTION_ID:p.iblockSectionId,NAME:p.name,TYPE:p.type,ACTIVE:p.active,PRICE:'1000',CURRENCY_ID:'RUB'};
 for(const property of [108,110,112,116,118,120,122,124])if(Object.hasOwn(p,'property'+property))r['PROPERTY_'+property]={VALUE:p['property'+property]?.value};
 return r;
}
function fixture({rows=[structuredClone(full)],legacyOnly=false,omitGet=false,denyDetails=false,getUnavailable=false,rejectSelectedProperties=false}={}){
 const calls=[];
 const sdk={callMethod(method,params,cb){
  calls.push({method,params});let data,error;
  if(legacyOnly&&method.startsWith('catalog.'))error='ERROR_METHOD_NOT_FOUND';
  else if(method==='catalog.catalog.list')data={catalogs:[{id:24,iblockId:24}]};
  else if(method==='catalog.product.list'){
   if(denyDetails&&params.filter.id)error='ACCESS_DENIED';
   else if(rejectSelectedProperties&&params.filter.id&&params.select.some(field=>field.startsWith('property')))error='ERROR_ARGUMENT';
   else data={products:rows.filter(p=>(!params.filter.id||p.id===params.filter.id)&&p.active!=='N').map(p=>rejectSelectedProperties&&params.filter.id?Object.fromEntries(Object.entries(p).filter(([key])=>!key.startsWith('property'))):p)};
  }
  else if(method==='catalog.product.sku.list')data={products:[]};
  else if(method==='crm.catalog.list')data=[{ID:24}];
  else if(method==='crm.product.list'){if(denyDetails&&params.filter.ID)error='ACCESS_DENIED';else data=rows.filter(p=>(!params.filter.ID||p.id===params.filter.ID)&&p.active!=='N').map(legacy);}
  else if(method==='catalog.product.get'){
   if(getUnavailable)error='ERROR_METHOD_NOT_FOUND';
   else {let p=structuredClone(rows.find(p=>p.id===params.id));if(omitGet){delete p.property116;delete p.iblockSectionId;}data={product:p};}
  }
  else if(['catalog.product.offer.get','catalog.product.sku.get'].includes(method))error='ERROR_METHOD_NOT_FOUND';
  else if(method==='crm.product.get'){
   if(getUnavailable)error='ERROR_METHOD_NOT_FOUND';else data=legacy(rows.find(p=>p.id===params.id));
  }
  else if(method==='catalog.priceType.list')data={priceTypes:[{id:1,base:'Y'}]};
  else if(method==='catalog.price.list')data={prices:params.filter['@productId'].map(id=>({id,productId:id,catalogGroupId:1,price:1000,currency:'RUB'}))};
  else error='ERROR_METHOD_NOT_FOUND';
  cb({error:()=>error||false,answer:{error},data:()=>data,more:()=>false});
 }};
 const adapter=new BitrixAdapter({sdk});adapter.connected=true;return {adapter,calls,rows};
}
test('all eight properties are decoded by ID or code, with string sizes and zero price preserved',()=>{
 const nav=catalogNavigation(full);
 assert.deepEqual(nav,{diameter:133,wallThickness:4,weight:28,fastenerPrice:725.5,flangeSize:'300×300',centerDistance:'220/250',bracketPosition:'Торцевое',cutDimensions:'60/133'});
 const codeRaw={IBLOCK_ID:24,DIAMETRMM_FMZJ0M:133,TSENA_MK_RUB_3RS0SE:0,RAZMER_OPORNOGO_FLANTSA_YUA0LC:'400х400'};
 assert.deepEqual(catalogNavigation(codeRaw),{diameter:133,fastenerPrice:0,flangeSize:'400х400'});
 assert.deepEqual(catalogNavigation({...full,iblockId:25}),{});
 const labels=navigationLabels(nav).join(' · ');assert.ok(labels.includes('Размер опорного фланца: 300×300'));
 assert.ok(labels.includes('Цена МК: 725,50 ₽'));
 assert.ok(!navigationFields().includes('property114'));
});
test('text property labels and values participate in search without changing the printed product name',()=>{
 const entry={id:'11',name:full.name,navigation:catalogNavigation(full)};const index=new CatalogSearchIndex([entry]);
 for(const query of ['фланца 300','фланец 300х300','300x300','Торцевое','срез 60 133','220/250','Цена МК 725'])assert.deepEqual(index.search(query).map(x=>x.id),['11']);
 assert.equal(entry.name,full.name);
});
test('section 44 enables hardware regardless of name; a pole name in another section remains unchecked',async()=>{
 assert.deepEqual(SUPPORT_SECTION_IDS,[44]);
 const rows=[structuredClone(full),{...structuredClone(full),id:12,iblockSectionId:45,name:'НФГ-6,0-05-ц'},
 {...structuredClone(full),id:13,iblockSectionId:46,name:'Опоры вложенный'}];
 const {adapter,calls}=fixture({rows});await adapter.listCatalogEntries();
 for(const [id,expected]of [[11,true],[12,false],[13,false]]){
  const p=await adapter.getProduct(id,{includeCatalogDetails:true}),r=newRow(p);assignFasteners(r,p);
  assert.equal(r.fastenersEnabled,expected);assert.equal(r.fasteners,'725.5');assert.equal(r.fastenersPropertyPrice,725.5);
 }
 assert.ok(!calls.some(c=>c.method.includes('section.list')||c.method.includes('productsection')));
 assert.ok(calls.find(c=>c.method==='catalog.product.list').params.select.includes('iblockSectionId'));
});
test('legacy CRM product methods read property 116 and SECTION_ID with the same behaviour',async()=>{
 const {adapter,calls}=fixture({legacyOnly:true});await adapter.listCatalogEntries();
 const p=await adapter.getProduct(11,{includeCatalogDetails:true});assert.equal(p.isSupportSection,true);assert.equal(p.fastenerUnitPrice,725.5);
 const list=calls.find(c=>c.method==='crm.product.list');assert.ok(list.params.select.includes('PROPERTY_124'));assert.ok(list.params.select.includes('SECTION_ID'));
});
test('selection rechecks omitted metadata with one filtered active list and uses changed property value',async()=>{
 const {adapter,rows,calls}=fixture({omitGet:true});await adapter.listCatalogEntries();rows[0].property116.value='900';
 const p=await adapter.getProduct(11,{includeCatalogDetails:true});assert.equal(p.fastenerUnitPrice,900);assert.equal(p.isSupportSection,true);
 const selected=calls.filter(c=>c.method==='catalog.product.list'&&c.params.filter.id===11);assert.equal(selected.length,1);
 assert.equal(selected[0].params.filter.active,'Y');assert.ok(selected[0].params.select.includes('property116'));
});
test('list-only portals also preserve section and property metadata for selected items',async()=>{
 const {adapter}=fixture({getUnavailable:true});await adapter.listCatalogEntries();
 const p=await adapter.getProduct(11,{includeCatalogDetails:true});assert.equal(p.fastenerUnitPrice,725.5);assert.equal(p.isSupportSection,true);
});
test('missing, malformed or negative property 116 opens a required manual amount; zero is known',async()=>{
 for(const value of [null,'','bad','-1',0]){
  const raw={...structuredClone(full),property116:{value}};const {adapter}=fixture({rows:[raw]});await adapter.listCatalogEntries();
  const p=await adapter.getProduct(11,{includeCatalogDetails:true}),r=newRow(p);assignFasteners(r,p);
  assert.equal(r.fastenersEnabled,true);
  if(value===0){assert.equal(r.fastenersPropertyPrice,0);assert.equal(calculateQuote([r],config).valid,true);}
  else{assert.equal(r.fastenersPropertyPrice,null);assert.equal(r.fasteners,'');assert.equal(calculateQuote([r],config).valid,false);
   r.fasteners='20';assert.equal(calculateQuote([r],config).total,1020);r.fastenersEnabled=false;assert.equal(calculateQuote([r],config).total,1000);}
 }
});
test('the cost is added per unit before every coefficient and quantity; unrelated properties never affect total',async()=>{
 const {adapter}=fixture();await adapter.listCatalogEntries();const p=await adapter.getProduct(11,{includeCatalogDetails:true}),r=newRow(p);assignFasteners(r,p);
 Object.assign(r,{k1:'2',k2:'1,5',k3:'1,2',quantity:'3'});
 assert.equal(calculateQuote([r],config).total,18635.4);
 r.fastenersEnabled=false;assert.equal(calculateQuote([r],config).total,10800);
 assert.equal(r.navigation,undefined);assert.equal(r.flangeSize,undefined);
});
test('offer can use the parent section but never inherits the parent fastener price',async()=>{
 const offer={id:11,iblockId:25,iblockSectionId:0,name:'Вариация',type:4,parentId:10,active:'Y'};
 const {adapter}=fixture({rows:[offer]});adapter._catalogRaw.set('10',{raw:{id:10,iblockId:24,iblockSectionId:44,property116:{value:99999}},source:'catalog.product.sku.list'});
 const p=await adapter.getProduct(11,{includeCatalogDetails:true});assert.equal(p.isSupportSection,true);assert.equal(p.fastenerUnitPrice,null);
});
test('normal CRM verification does not fetch calculation properties or section trees',async()=>{
 const {adapter,calls}=fixture({omitGet:true});await adapter.listCatalogEntries();const n=calls.length;
 const p=await adapter.getProduct(11);assert.equal(p.fastenerUnitPrice,undefined);
 assert.ok(!calls.slice(n).some(c=>c.method.endsWith('.list')&&c.params.filter?.id===11));
});

test('known property price remains authoritative over a stale manual amount',()=>{
 const r=newRow({id:'11',name:'Изделие',basePrice:1000,currency:'RUB'});
 assignFasteners(r,{isSupportSection:true,fastenerUnitPrice:725.5});r.fasteners='99999';
 const q=calculateQuote([r],config);assert.equal(q.total,1725.5);assert.equal(q.rows[0].fasteners,'725.5');
});

test('unreadable fresh properties use known section but require manual cost instead of cached price',async()=>{
 const {adapter,rows}=fixture({omitGet:true,denyDetails:true});await adapter.listCatalogEntries();rows[0].property116.value='900';
 const p=await adapter.getProduct(11,{includeCatalogDetails:true});assert.equal(p.isSupportSection,true);assert.equal(p.fastenerUnitPrice,null);
 const r=newRow(p);assignFasteners(r,p);assert.equal(r.fasteners,'');assert.equal(r.fastenersPropertyPrice,null);
});
test('old list-only portal can reject property select without breaking selection or losing accessible CRM cost',async()=>{
 const {adapter,calls}=fixture({getUnavailable:true,rejectSelectedProperties:true});await adapter.listCatalogEntries();
 const p=await adapter.getProduct(11,{includeCatalogDetails:true});assert.equal(p.isSupportSection,true);assert.equal(p.fastenerUnitPrice,725.5);
 assert.ok(calls.some(c=>c.method==='crm.product.list'&&c.params.filter.ID===11&&c.params.select.includes('PROPERTY_116')));
 const plain=await adapter.getProduct(11);assert.equal(plain.verified,true);
});
test('RUB property is not silently added to a quote in another currency',async()=>{
 const {adapter}=fixture({rows:[{...structuredClone(full),price:1000,currency:'EUR'}]});await adapter.listCatalogEntries();
 const p=await adapter.getProduct(11,{currency:'EUR',includeCatalogDetails:true});assert.equal(p.isSupportSection,true);assert.equal(p.fastenerUnitPrice,null);
 assert.ok(p.fastenersNote.includes('рублях'));
});
