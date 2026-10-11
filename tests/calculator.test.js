import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { parseNumber, formatMoney, validateConfig, validateMetalPrices, calculateQuote } from '../src/calculator.js';

const config = {
  version: 'pilot', currency: 'RUB', formulaMode: 'catalog', rounding: 'line',
  coatings: [{ code: 'none', name: 'Без покрытия' }, { code: 'zinc', name: 'Цинк' }, { code: 'paint', name: 'Краска' }],
};
const row = (overrides = {}) => ({ id: 'row-1', productId: '101', productName: 'Опора', basePrice: 38600, currency: 'RUB', quantity: 24, coatingCode: 'zinc', k1: '1,12', k2: '1,08', k3: '1,18', ...overrides });
const excelConfig = {...config, formulaMode: 'excel'};
const excelRow = (overrides = {}) => row({pricePerKg: 20, weight: 5, quantity: 2, k1: 2, k2: 1.5, k3: 1.2, fasteners: 10, ...overrides});

test('Russian decimal input is finite and blank input is never zero', () => {
  assert.equal(parseNumber('38 600,25'), 38600.25);
  assert.equal(parseNumber('−2'), NaN);
  assert.equal(parseNumber('-1,2e2'), -120);
  for (const input of ['', '  ', null, undefined, true, 'Infinity', Infinity, '1,2,3', '1 2', '1\n2', '1, 12', '2abc', {}, []]) assert.equal(Number.isNaN(parseNumber(input)), true, String(input));
  assert.equal(formatMoney(null), '—');
  assert.match(formatMoney(123.45), /123,45/);
});

test('legacy coating config imports labels while discarding old coefficients and kilogram prices', () => {
  const normalized = validateConfig({ version: 'test-1', currency: 'RUB', prices_per_kg: { 16: 120 }, coatings: [{ code: 'zinc', name: 'Цинк', coefficient: '1,15' }] });
  assert.equal(normalized.formulaMode, 'catalog');
  assert.equal(normalized.rounding, 'line');
  assert.deepEqual(normalized.coatings, [{code: 'zinc', name: 'Цинк'}]);
  assert.equal(normalized.calculationVersion, 2);
  assert.equal('prices_per_kg' in normalized, false);
  assert.deepEqual(validateConfig({...config, coatings: [{code: 'none'}]}).coatings, [{code: 'none', name: 'none'}]);
});

test('configuration rejects duplicate coatings and unsupported choices', () => {
  assert.throws(() => validateConfig({ ...config, coatings: [config.coatings[0], config.coatings[0]] }), /Повторный/);
  assert.throws(() => validateConfig({ ...config, coatings: [{code: 'x', name: {}}] }), /Название покрытия/);
  assert.throws(() => validateConfig({ ...config, currency: 'ZZZ' }), /валюта/);
  assert.throws(() => validateConfig({ ...config, rounding: 'floor' }), /округления/);
  assert.throws(() => validateConfig({ ...config, formulaMode: 'weight' }), /формула/);
});

test('metal price file imports existing per-product values independently of coating properties', () => {
  const original = JSON.parse(readFileSync(new URL('../data/prices.original.example.json', import.meta.url), 'utf8'));
  const before = JSON.stringify(original);
  const normalized = validateMetalPrices(original);
  assert.deepEqual(normalized, {version: 'test-1', currency: 'RUB', prices_per_kg: {'16': 120}});
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(validateMetalPrices({prices_per_kg: {'0016': '120,25', '17': 0}}),
    {version: '1', currency: 'RUB', prices_per_kg: {'16': 120.25, '17': 0}});
  assert.deepEqual(validateMetalPrices({...original, coatings: false}).prices_per_kg, {'16': 120});
  assert.equal('prices_per_kg' in validateConfig(original), false);
});

test('metal prices reject absent mappings, invalid currencies, unsafe IDs and normalized duplicates', () => {
  for (const raw of [undefined, null, [], {}, {prices_per_kg: {}}, {prices_per_kg: []}, {prices_per_kg: '120'}]) {
    assert.throws(() => validateMetalPrices(raw));
  }
  for (const currency of ['ZZZ', '', null, false, {}]) {
    assert.throws(() => validateMetalPrices({currency, prices_per_kg: {'16': 120}}), /валюта/);
  }
  for (const productId of ['0', '-1', '1.5', '1e2', ' 16', 'x', String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.throws(() => validateMetalPrices({prices_per_kg: {[productId]: 120}}), /ID товара/);
  }
  assert.throws(() => validateMetalPrices({prices_per_kg: {'016': 120, '16': 121}}), /Повторная цена/);
});

test('metal price values reject blank, coercible and non-finite input instead of becoming zero', () => {
  for (const price of ['', ' ', null, undefined, false, true, {}, [], Infinity, 'Infinity', -1, '1x']) {
    assert.throws(() => validateMetalPrices({prices_per_kg: {'16': price}}), /цена за килограмм/);
  }
});

test('explicit demo K3 values preserve the known total with separate unit/line rounding', () => {
  const rows = [row(), row({ id: 'row-2', quantity: 12, coatingCode: 'paint', k1: '1,15', k2: '1,05', k3: '1,12' })];
  const result = calculateQuote(rows, config);
  assert.equal(result.valid, true);
  assert.equal(result.rows[0].unitPrice, 55094.86);
  assert.equal(result.rows[0].lineTotal, 1322276.66);
  assert.equal(result.rows[1].lineTotal, 626431.68);
  assert.equal(result.total, 1948708.34);
  assert.equal(result.quantity, 36);
  assert.equal(calculateQuote(rows, { ...config, rounding: 'unit' }).total, 1948708.32);
});

test('catalog applies manual K3 once and coating labels or retired coefficients never change prices', () => {
  const input = row({basePrice: 100, quantity: 2, k1: 2, k2: 1.25, k3: 1.5, coatingFactor: 99,
    fasteners: -10, extraCoating: '', delivery: Infinity, weight: -1, pricePerKg: {}});
  const before = JSON.stringify(input);
  for (const coatingCode of ['none', 'zinc', 'paint']) {
    const legacyConfig = {...config, coatings: config.coatings.map(coating => ({...coating, coefficient: 99}))};
    const result = calculateQuote([{...input, coatingCode}], legacyConfig);
    assert.equal(result.valid, true);
    assert.equal(result.rows[0].unitPrice, 375);
    assert.equal(result.total, 750);
    assert.equal('coatingFactor' in result.rows[0], false);
  }
  assert.equal(JSON.stringify(input), before);
  for (const coefficient of [undefined, -1, Infinity, '', {}]) {
    const labels = validateConfig({...config, coatings: [{code: 'zinc', name: 'Переименовано', coefficient}]});
    assert.deepEqual(labels.coatings, [{code: 'zinc', name: 'Переименовано'}]);
    assert.equal(calculateQuote([input], labels).total, 750);
  }
});

test('Excel formula applies K1/K2/K3 to price per kg times unit weight, then adds unit fasteners', () => {
  const input = excelRow();
  const before = JSON.stringify(input);
  const result = calculateQuote([input], excelConfig);
  assert.equal(result.valid, true);
  assert.equal(result.rows[0].unitPrice, 370);
  assert.equal(result.total, 740);
  assert.equal('coatingFactor' in result.rows[0], false);
  assert.equal(JSON.stringify(input), before);
});

test('Excel totals ignore coating factor, catalog price and retired extra coating/delivery values', () => {
  for (const overrides of [
    {coatingCode: 'paint'},
    {basePrice: undefined, extraCoating: undefined, delivery: undefined},
    {basePrice: -1, extraCoating: '', delivery: Infinity},
    {basePrice: 1e308, extraCoating: -100, delivery: {}},
  ]) {
    const result = calculateQuote([excelRow(overrides)], excelConfig);
    assert.equal(result.valid, true);
    assert.equal(result.total, 740);
  }
  assert.equal(calculateQuote([row({ basePrice: 100, quantity: 1, k1: 1, k2: 1, weight: -100 })], config).total, 118);
});

test('Excel decimal arithmetic preserves line/unit rounding for fractional weights and quantities', () => {
  const input = excelRow({pricePerKg: '0,05', weight: '0,3', quantity: '0,5', k1: 1, k2: 1, k3: '0,5', fasteners: 0});
  const line = calculateQuote([input], excelConfig);
  assert.equal(line.valid, true);
  assert.equal(line.rows[0].unitPrice, 0.01);
  assert.equal(line.total, 0);
  assert.equal(line.quantity, 0.5);
  assert.equal(calculateQuote([input], {...excelConfig, rounding: 'unit'}).total, 0.01);
  const half = excelRow({pricePerKg: '0,005', weight: 1, quantity: 3, k1: 1, k2: 1, k3: -1, fasteners: 0});
  assert.equal(calculateQuote([half], excelConfig).rows[0].unitPrice, -0.01);
  assert.equal(calculateQuote([half], excelConfig).total, -0.02);
});

test('Excel signed/zero coefficients affect material cost while fasteners remain unscaled', () => {
  assert.equal(calculateQuote([excelRow({k3: 0})], excelConfig).total, 20);
  assert.equal(calculateQuote([excelRow({k3: -1.2})], excelConfig).total, -700);
  assert.equal(calculateQuote([excelRow({k1: -2, k2: -1.5})], excelConfig).total, 740);
  assert.equal(calculateQuote([excelRow({pricePerKg: 0})], excelConfig).total, 20);
  assert.equal(calculateQuote([excelRow({fasteners: undefined})], excelConfig).total, 720);
});

test('Excel requires valid price/kg, positive unit weight, K3 and nonnegative unit fasteners', () => {
  for (const overrides of [
    {pricePerKg: undefined}, {pricePerKg: ''}, {pricePerKg: -1}, {pricePerKg: Infinity},
    {weight: undefined}, {weight: ''}, {weight: 0}, {weight: -1}, {weight: Infinity},
    {k3: undefined}, {k3: ''}, {k3: Infinity}, {k3: {}},
    {fasteners: ''}, {fasteners: null}, {fasteners: -1}, {fasteners: Infinity},
  ]) {
    const result = calculateQuote([excelRow(), excelRow(overrides)], excelConfig);
    assert.equal(result.valid, false, JSON.stringify(overrides));
    assert.equal(result.total, null);
    assert.ok(result.errors.length);
    assert.equal(result.rows[1].unitPrice, null);
  }
});

test('money rounds decimal halves away from zero and all three coefficients may be zero or negative', () => {
  const minimal = overrides => row({ basePrice: '0,005', coatingCode: 'none', quantity: 1, k1: 1, k2: 1, k3: 1, ...overrides });
  assert.equal(calculateQuote([minimal({})], config).total, 0.01);
  assert.equal(calculateQuote([minimal({ k1: -1 })], config).total, -0.01);
  assert.equal(calculateQuote([minimal({ k1: 0 })], config).total, 0);
  assert.equal(calculateQuote([minimal({ k1: -2, k2: -3 })], config).total, 0.03);
  assert.equal(calculateQuote([minimal({ k3: -1 })], config).total, -0.01);
  assert.equal(calculateQuote([minimal({ k3: 0 })], config).total, 0);
  assert.equal(calculateQuote([minimal({ basePrice: '1.005' })], config).total, 1.01);
});

test('decimal quantities are supported and input rows are unchanged', () => {
  const input = row({ basePrice: '0,1', coatingCode: 'none', quantity: '0,3', k1: 1, k2: 1, k3: 1 });
  const before = JSON.stringify(input);
  const result = calculateQuote([input], config);
  assert.equal(result.total, 0.03);
  assert.equal(result.quantity, 0.3);
  assert.equal(JSON.stringify(input), before);
});

test('one bad row invalidates whole quote and prevents a partial total', () => {
  for (const overrides of [{ quantity: 0 }, { quantity: '' }, { k1: '' }, { k2: Infinity }, { k3: undefined }, {k3: ''}, {k3: Infinity}, {k3: false}, { basePrice: -1 }, { coatingCode: 'unknown' }, { currency: 'USD' }]) {
    const result = calculateQuote([row(), row(overrides)], config);
    assert.equal(result.valid, false, JSON.stringify(overrides));
    assert.equal(result.total, null);
    assert.ok(result.errors.length);
    assert.equal(result.rows[1].unitPrice, null);
  }
  assert.equal(calculateQuote([], config).valid, false);
  assert.equal(calculateQuote([row()], {}).valid, false);
});

test('overflow cannot produce a usable infinite total', () => {
  const result = calculateQuote([row({ basePrice: 1e308, k1: 1e308, k2: 1 })], config);
  assert.equal(result.valid, false);
  assert.equal(result.total, null);
  assert.match(result.errors.join(' '), /диапазон/);
});
