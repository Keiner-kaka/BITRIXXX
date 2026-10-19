import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatExecutionTerm, calculateQuote} from '../src/calculator.js';
import {newRow} from '../src/demo.js';

const config = {currency: 'RUB', coatings: [{code: 'none', name: 'Без покрытия'}]};
const row = () => newRow({id: '11', name: 'Товар', basePrice: 100, currency: 'RUB'});

test('numbers become working-day terms with Russian endings', () => {
  for (const [input, expected] of [['15', '15 рабочих дней'], ['1', '1 рабочий день'], ['2', '2 рабочих дня'], ['11', '11 рабочих дней'], ['21', '21 рабочий день'], ['22', '22 рабочих дня'], ['0', '0 рабочих дней'], [30, '30 рабочих дней']]) {
    assert.equal(formatExecutionTerm(input), expected);
  }
});

test('warehouse shipment text and previously written terms pass through unchanged', () => {
  for (const value of ['Отгрузка с СГП', '15 рабочих дней', '  Отгрузка с СГП  ', 'По согласованию']) assert.equal(formatExecutionTerm(value), value);
  assert.equal(formatExecutionTerm(''), '');
  assert.equal(formatExecutionTerm(undefined), '');
});

test('fractional, negative and oversized numeric day counts are rejected', () => {
  for (const value of ['-1', '2,5', '1.5', '9007199254740992', Infinity]) assert.throws(() => formatExecutionTerm(value));
});

test('calculated snapshots keep entered values and formatted terms without affecting totals', () => {
  for (const [value, expected] of [['15', '15 рабочих дней'], ['Отгрузка с СГП', 'Отгрузка с СГП']]) {
    const q = calculateQuote([{...row(), executionTerm: value}], config);
    assert.equal(q.valid, true); assert.equal(q.total, 100);
    assert.equal(q.rows[0].executionTerm, value);
    assert.equal(q.rows[0].executionTermText, expected);
  }
  assert.equal(calculateQuote([{...row(), executionTerm: '-1'}], config).valid, false);
});
