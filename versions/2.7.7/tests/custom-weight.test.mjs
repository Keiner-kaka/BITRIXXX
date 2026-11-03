import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {calculateQuote,validateConfig,withCoatingOptions} from '../src/calculator.js';
import {calculationVersion,restoreCalculationVersion} from '../src/calculation-version.js';
import {newCustomRow} from '../src/demo.js';
const config=withCoatingOptions(validateConfig(JSON.parse(await readFile(new URL('../data/coatings.example.json',import.meta.url),'utf8'))));
const row={...newCustomRow(),productName:'Своя позиция',pricePerKg:'2,26',weightKg:'3,1',basePrice:99999,quantity:'3',k1:'1,12',k2:'1,08',k3:'1,18',fastenersEnabled:true,fasteners:'2,50'};
for(const rounding of ['line','unit']){
 const custom=calculateQuote([row],{...config,rounding});
 const catalog=calculateQuote([{...row,rowType:'catalog',productId:'9',basePrice:'7.006'}],{...config,rounding});
 assert.ok(custom.valid,custom.errors.join(';'));assert.equal(custom.total,catalog.total);assert.equal(custom.deliveryTotal,catalog.deliveryTotal);assert.equal(custom.rows[0].basePrice,'7.006');
}
for(const key of ['pricePerKg','weightKg'])for(const value of ['', 'wrong','-1'])assert.equal(calculateQuote([{...row,[key]:value}],config).valid,false);
assert.equal(calculateQuote([{...row,weightKg:'0'}],config).valid,true);
const catalog=calculateQuote([{...row,rowType:'catalog',basePrice:'10',weightKg:undefined,pricePerKg:undefined}],config);assert.ok(catalog.valid);
const calculated=calculateQuote([row],config);
const saved=calculationVersion({dealId:'42',quoteId:'q',companyName:'Тест',currency:'RUB',config,rows:calculated.rows},{deal:{TITLE:'Тест'},event:'generation'});
assert.equal(saved.parameters.rows[0].pricePerKg,'2,26');assert.equal(saved.parameters.rows[0].weightKg,'3,1');assert.ok(!('basePrice'in saved.parameters.rows[0]));
const restored=restoreCalculationVersion(saved,'42',config);assert.equal(restored.rows[0].pricePerKg,'2,26');assert.equal(restored.rows[0].weightKg,'3,1');assert.equal(calculateQuote(restored.rows,config).total,calculated.total);
console.log('PASS: exact mass × kg price, unchanged coefficients/fasteners/rounding/delivery, stale base price ignored, required inputs, catalog without weight, JSON factors roundtrip');
