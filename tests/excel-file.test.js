import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {calculateQuote} from '../src/calculator.js';

test('all eight rows reproduce the uploaded Excel totals with stored base costs, excluding weight', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/excel-calculation.json', import.meta.url), 'utf8'));
  const result = calculateQuote(fixture.rows, {
    currency: 'RUB', version: 'excel-fixture', formulaMode: 'excel', rounding: 'unit',
    coatings: [{code: 'none', name: 'Без покрытия', coefficient: 1}],
  });
  assert.equal(result.valid, true);
  assert.equal(result.rows.length, 8);
  assert.equal(result.total, fixture.expectedTotal);
  for (let i = 0; i < result.rows.length; i++) {
    assert.equal(result.rows[i].unitPrice, fixture.rows[i].expectedUnitPrice);
    assert.equal(result.rows[i].lineTotal, fixture.rows[i].expectedLineTotal);
  }
});
