import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNumber, formatMoney, validateConfig, normalizeRelations, resolveRelations, calculateQuote } from '../src/calculator.js';

const config = {
  version: 'pilot', currency: 'RUB', formulaMode: 'catalog', rounding: 'line',
  coatings: [{ code: 'none', name: 'Без покрытия', coefficient: 1 }, { code: 'zinc', name: 'Цинк', coefficient: 1.18 }, { code: 'paint', name: 'Краска', coefficient: 1.12 }],
};
const row = (overrides = {}) => ({ id: 'row-1', productId: '101', productName: 'Опора', basePrice: 38600, currency: 'RUB', quantity: 24, coatingCode: 'zinc', k1: '1,12', k2: '1,08', ...overrides });
const relations = () => ({
  version: 'pilot',
  product_drawings: [
    { product_id: 101, drawing_id: 'd1', drawing_name: 'Чертёж 1', drawing_file_id: 701 },
    { product_id: '101', drawing_id: 'd2', drawing_name: 'Чертёж 2' },
    { product_id: 102, drawing_id: 'd1' },
  ],
  drawing_kd: [
    { drawing_id: 'd1', kit_id: 'kit1', kit_name: 'Комплект', file_id: 801, file_name: 'Сборка.pdf' },
    { drawing_id: 'd1', kit_id: 'kit1', file_id: 802, file_name: 'Детали.pdf' },
    { drawing_id: 'd2', kit_id: 'kit2', kit_name: 'Другой комплект' },
  ],
});

test('Russian decimal input is finite and blank input is never zero', () => {
  assert.equal(parseNumber('38 600,25'), 38600.25);
  assert.equal(parseNumber('−2'), NaN);
  assert.equal(parseNumber('-1,2e2'), -120);
  for (const input of ['', '  ', null, undefined, true, 'Infinity', Infinity, '1,2,3', '1 2', '1\n2', '1, 12', '2abc', {}, []]) assert.equal(Number.isNaN(parseNumber(input)), true, String(input));
  assert.equal(formatMoney(null), '—');
  assert.match(formatMoney(123.45), /123,45/);
});

test('legacy coefficient file imports without using kilogram prices', () => {
  const normalized = validateConfig({ version: 'test-1', currency: 'RUB', prices_per_kg: { 16: 120 }, coatings: [{ code: 'zinc', name: 'Цинк', coefficient: '1,15' }] });
  assert.equal(normalized.formulaMode, 'catalog');
  assert.equal(normalized.rounding, 'line');
  assert.equal(normalized.coatings[0].coefficient, 1.15);
  assert.equal('prices_per_kg' in normalized, false);
});

test('configuration rejects duplicates, invalid factors and unsupported choices', () => {
  assert.throws(() => validateConfig({ ...config, coatings: [config.coatings[0], config.coatings[0]] }), /Повторный/);
  assert.throws(() => validateConfig({ ...config, coatings: [{ code: 'bad', coefficient: -1 }] }), /коэффициент/);
  assert.throws(() => validateConfig({ ...config, currency: 'ZZZ' }), /валюта/);
  assert.throws(() => validateConfig({ ...config, rounding: 'floor' }), /округления/);
  assert.throws(() => validateConfig({ ...config, formulaMode: 'weight' }), /формула/);
});

test('screenshot calculation and rounded unit versus rounded line differ explicitly', () => {
  const rows = [row(), row({ id: 'row-2', quantity: 12, coatingCode: 'paint', k1: '1,15', k2: '1,05' })];
  const result = calculateQuote(rows, config);
  assert.equal(result.valid, true);
  assert.equal(result.rows[0].unitPrice, 55094.86);
  assert.equal(result.rows[0].lineTotal, 1322276.66);
  assert.equal(result.rows[1].lineTotal, 626431.68);
  assert.equal(result.total, 1948708.34);
  assert.equal(result.quantity, 36);
  assert.equal(calculateQuote(rows, { ...config, rounding: 'unit' }).total, 1948708.32);
});

test('Excel-adapted formula adds costs before K1/K2 and never reapplies coating factor', () => {
  const result = calculateQuote([row({ basePrice: 100, fasteners: 10, extraCoating: 20, delivery: 30, quantity: 2, k1: 2, k2: 1.5, weight: 99999 })], { ...config, formulaMode: 'excel' });
  assert.equal(result.valid, true);
  assert.equal(result.rows[0].unitPrice, 480);
  assert.equal(result.total, 960);
  assert.equal(result.rows[0].coatingFactor, 1.18);
  assert.equal(calculateQuote([row({ basePrice: 100, quantity: 1, k1: 1, k2: 1, weight: -100 })], config).total, 118);
});

test('money rounds decimal halves away from zero and K1/K2 may be zero or negative', () => {
  const minimal = overrides => row({ basePrice: '0,005', coatingCode: 'none', quantity: 1, k1: 1, k2: 1, ...overrides });
  assert.equal(calculateQuote([minimal({})], config).total, 0.01);
  assert.equal(calculateQuote([minimal({ k1: -1 })], config).total, -0.01);
  assert.equal(calculateQuote([minimal({ k1: 0 })], config).total, 0);
  assert.equal(calculateQuote([minimal({ k1: -2, k2: -3 })], config).total, 0.03);
  assert.equal(calculateQuote([minimal({ basePrice: '1.005' })], config).total, 1.01);
});

test('decimal quantities are supported and input rows are unchanged', () => {
  const input = row({ basePrice: '0,1', coatingCode: 'none', quantity: '0,3', k1: 1, k2: 1 });
  const before = JSON.stringify(input);
  const result = calculateQuote([input], config);
  assert.equal(result.total, 0.03);
  assert.equal(result.quantity, 0.3);
  assert.equal(JSON.stringify(input), before);
});

test('one bad row invalidates whole quote and prevents a partial total', () => {
  for (const overrides of [{ quantity: 0 }, { quantity: '' }, { k1: '' }, { k2: Infinity }, { basePrice: -1 }, { coatingCode: 'unknown' }, { currency: 'USD' }, { delivery: -1 }]) {
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

test('relations normalize numeric IDs, group kit files and preserve drawing ambiguity', () => {
  const original = relations();
  const before = JSON.stringify(original);
  const normalized = normalizeRelations(original);
  assert.equal(normalized.product_drawings[0].product_id, '101');
  assert.equal(normalized.product_drawings[2].drawing_name, 'Чертёж 1');
  assert.equal(normalized.product_drawings[2].drawing_file_id, '701');
  assert.equal(JSON.stringify(original), before);
  const resolved = resolveRelations(101, normalized);
  assert.equal(resolved.drawings.length, 2);
  assert.equal(resolved.drawings[0].kits.length, 1);
  assert.deepEqual(resolved.drawings[0].kits[0].files.map(file => file.id), ['801', '802']);
  assert.equal(resolved.drawings[0].kits[0].name, 'Комплект');
  assert.deepEqual(resolveRelations('unlinked', normalized), { drawings: [] });
});

test('relations reject duplicate pairs, dangling references and contradictory metadata', () => {
  let raw = relations();
  raw.product_drawings.push({ ...raw.product_drawings[0] });
  assert.throws(() => normalizeRelations(raw), /Повторная связь товара/);
  raw = relations(); raw.drawing_kd[0].drawing_id = 'missing';
  assert.throws(() => normalizeRelations(raw), /неизвестный чертёж/);
  raw = relations(); raw.product_drawings[2].drawing_name = 'Несовместимое имя';
  assert.throws(() => normalizeRelations(raw), /противоречивые/);
  raw = relations(); raw.drawing_kd[1].kit_name = 'Другое имя';
  assert.throws(() => normalizeRelations(raw), /противоречивые/);
  raw = relations(); raw.drawing_kd.push({ ...raw.drawing_kd[0] });
  assert.throws(() => normalizeRelations(raw), /Повторная связь комплекта/);
  raw = relations(); raw.drawing_kd[1].file_id = 801;
  assert.throws(() => normalizeRelations(raw), /Повторная/);
});

test('malformed IDs and file metadata without file ID cannot enter lookup', () => {
  for (const invalidId of ['', '  ', null, {}, [], true, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, 'a\u0000b']) {
    const raw = relations(); raw.product_drawings[0].product_id = invalidId;
    assert.throws(() => normalizeRelations(raw));
  }
  const raw = relations(); delete raw.drawing_kd[0].file_id;
  assert.throws(() => normalizeRelations(raw), /без ID/);
});
