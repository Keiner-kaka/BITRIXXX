import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {deliveryProductIds,normalizeDeliveryProductIds} from '../src/delivery-products.js';
import {calculateQuote,validateConfig,withCoatingOptions} from '../src/calculator.js';
import {includeDeliveryRows} from '../src/deal-rows.js';
import {calculationVersion,restoreCalculationVersion} from '../src/calculation-version.js';
const config=withCoatingOptions(validateConfig(JSON.parse(await readFile(new URL('../data/coatings.example.json',import.meta.url),'utf8'))));
assert.deepEqual(deliveryProductIds('101, 202,101'),['101','202']);
assert.equal(normalizeDeliveryProductIds(' 101 ,202 '),'101, 202');
assert.deepEqual(deliveryProductIds(101),['101']);assert.deepEqual(deliveryProductIds(''),[]);
for(const bad of ['101,','101,,202','0,202','-1,2','1.5,2','101;202','9007199254740992'])assert.throws(()=>deliveryProductIds(bad));
const row=(id,price,quantity,k2,custom=false)=>({rowType:custom?'custom':'catalog',productId:id,productName:'Товар '+id,basePrice:String(price),quantity:String(quantity),k1:'1',k2:String(k2),k3:'1',coatingCode:'none',currency:'RUB',fastenersEnabled:false,executionTerm:''});
const rows=[row('101',100,2,2),row('202',50,3,1.5),row('303',100,1,1.1),row('101',10,1,2,true)];
for(const rounding of ['line','unit']){
 const c=calculateQuote(rows,{...config,rounding},{deliveryProductId:'101,202,101'});
 assert.ok(c.valid,c.errors.join(';'));assert.equal(c.deliveryTotal,645);assert.equal(c.total,755);
 assert.equal(calculateQuote(rows,{...config,rounding},{deliveryProductId:'101'}).deliveryTotal,495);
 assert.equal(calculateQuote(rows,{...config,rounding},{}).deliveryTotal,295);
}
const deal={currency:'RUB',rows:[{productId:'101',productName:'Д1',price:100,quantity:1},{productId:'101',productName:'Д1 повтор',price:200,quantity:2},{productId:'202',productName:'Д2',price:50,quantity:3},{productId:'999',productName:'Другое',price:80,quantity:1}]};
const edited=[row('101',777,2,1),row('202',25,1,1,true)];
const included=includeDeliveryRows(edited,deal,'101,202,101');assert.equal(included.length,4);assert.equal(included[0].basePrice,'777');
assert.equal(included[2].basePrice,200);assert.equal(included[3].productId,'202');
assert.deepEqual(includeDeliveryRows(included,deal,'101,202'),included);
const value=calculationVersion({quoteId:'q',dealId:'42',companyName:'Тест',currency:'RUB',config,rows},{event:'generation',deal:{TITLE:'Тест'},deliveryProductId:'101, 202'});
assert.equal(value.parameters.deliveryProductId,'101, 202');
assert.equal(restoreCalculationVersion(value,'42',config).deliveryProductId,'101, 202');
value.parameters.deliveryProductId='101';assert.equal(restoreCalculationVersion(value,'42',config).deliveryProductId,'101');
console.log('PASS: comma-separated IDs, validation/deduplication, all delivery products counted without duplicate K2, regular/custom rows unchanged, per-ID missing CRM rows, JSON roundtrip and single-ID compatibility');
