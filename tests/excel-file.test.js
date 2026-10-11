import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {calculateQuote} from '../src/calculator.js';

test('authored regression cases verify the user-approved Excel formula with explicit price/kg and weight', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/excel-calculation.json', import.meta.url), 'utf8'));
  const result = calculateQuote(fixture.rows, {
    currency: 'RUB', version: 'approved-excel-formula-fixture', formulaMode: 'excel', rounding: fixture.rounding,
    coatings: [{code: 'none', name: 'Без покрытия'}],
  });
  assert.equal(result.valid, true);
  assert.equal(result.rows.length, fixture.rows.length);
  assert.equal(result.total, fixture.expectedTotal);
  for (let i = 0; i < result.rows.length; i++) {
    assert.equal(result.rows[i].unitPrice, fixture.rows[i].expectedUnitPrice);
    assert.equal(result.rows[i].lineTotal, fixture.rows[i].expectedLineTotal);
  }
});
