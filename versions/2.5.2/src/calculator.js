/** Pure calculation and reference-data helpers. No network or CRM writes. */

const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const FALLBACK_CURRENCIES = new Set('RUB USD EUR GBP CNY JPY KZT BYN UAH AMD AZN GEL UZS KGS TJS TRY CHF CAD AUD AED INR BRL KRW SEK NOK DKK PLN CZK HUF RON BGN ILS ZAR VND THB'.split(' '));

function numberText(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== 'string') return null;
  // Spaces are allowed as copied Russian thousands separators. Comma is decimal.
  const input = value.trim().replace(/[\u00a0\u202f]/g, ' ');
  if (/\s/.test(input) && !/^[+-]?\d{1,3}(?: \d{3})+(?:[.,]\d+)?(?:e[+-]?\d+)?$/i.test(input)) return null;
  const text = input.replace(/ /g, '').replace(',', '.');
  if (!text || !NUMBER_PATTERN.test(text) || !Number.isFinite(Number(text))) return null;
  return text;
}

/** Return NaN for blank, malformed or non-finite input; do not coerce booleans. */
export function parseNumber(value) {
  const text = numberText(value);
  return text === null ? NaN : Number(text);
}

export function formatMoney(value, currency = 'RUB') {
  const number = parseNumber(value);
  if (!Number.isFinite(number)) return '—';
  try {
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(Object.is(number, -0) ? 0 : number);
  } catch {
    return '—';
  }
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: ожидается объект.`);
  return value;
}

function version(value) {
  if (value === undefined) return '1';
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()) {
    throw new Error('Некорректная версия справочника.');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Некорректная версия справочника.');
  return String(value).trim();
}

function isCurrencySupported(currency) {
  if (!/^[A-Z]{3}$/.test(currency)) return false;
  try {
    return typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('currency').includes(currency)
      : FALLBACK_CURRENCIES.has(currency);
  } catch {
    return FALLBACK_CURRENCIES.has(currency);
  }
}

export function validateConfig(raw) {
  object(raw, 'Настройки расчёта');
  const currency = raw.currency === undefined ? 'RUB' : String(raw.currency).trim().toUpperCase();
  if (!isCurrencySupported(currency)) throw new Error('В настройках указана неподдерживаемая валюта.');
  const formulaMode = raw.formulaMode ?? 'catalog';
  const rounding = raw.rounding ?? 'line';
  if (!['catalog', 'excel'].includes(formulaMode)) throw new Error('Неизвестная формула расчёта.');
  if (!['unit', 'line'].includes(rounding)) throw new Error('Неизвестный способ округления.');
  if (!Array.isArray(raw.coatings) || raw.coatings.length === 0) throw new Error('Нужен непустой справочник покрытий.');
  const seen = new Set();
  const coatings = raw.coatings.map((entry, index) => {
    object(entry, `Покрытие ${index + 1}`);
    const code = id(entry.code, `Код покрытия ${index + 1}`);
    const name = optionalText(entry.name, 'Название покрытия') || code;
    if (seen.has(code)) throw new Error(`Повторный код покрытия «${code}».`);
    seen.add(code);
    return { code, name, ...(coatingSupportsRal({...entry, code, name}) ? {supportsRal: true} : {}) };
  });
  // Metal prices are loaded separately; importing coating settings never changes them.
  return { version: version(raw.version), currency, coatings, formulaMode, rounding, calculationVersion: 2 };
}

/** Add the new standard option to editable drafts, including older Disk lists. */
export function withCoatingOptions(config) {
  if (config.coatings.some(coating => coating.code === 'zinc_paint'
    || (/цинк/i.test(coating.name) && coatingSupportsRal(coating)))) return config;
  return {...config, coatings: [...config.coatings, {
    code: 'zinc_paint', name: 'Горячее цинкование + окрашивание RAL', supportsRal: true,
  }]};
}

export function coatingSupportsRal(coating) {
  return Boolean(coating && (coating.supportsRal === true
    || ['paint', 'zinc_paint'].includes(coating.code) || /окраск|окраш|покраск/i.test(coating.name || '')));
}

/** RAL is descriptive text only and never participates in the price formula. */
export function formatCoating(coating, ralColor = '') {
  const name = coating?.name || coating?.code || '';
  if (!coatingSupportsRal(coating)) return name;
  if (typeof ralColor !== 'string' || ralColor.length > 100 || /[\u0000-\u001f\u007f]/.test(ralColor)) {
    throw new Error('Номер RAL: введите текст длиной до 100 символов.');
  }
  const color = ralColor.trim().replace(/^RAL\s*/i, '').trim();
  const label = name.replace(/\s+RAL\s*$/i, '');
  return color ? `${label} RAL ${color}` : label;
}

/** Validate the separately loaded per-product metal price file. */
export function validateMetalPrices(raw) {
  object(raw, 'Цены металла');
  const currency = raw.currency === undefined ? 'RUB' : String(raw.currency).trim().toUpperCase();
  if (!isCurrencySupported(currency)) throw new Error('В ценах металла указана неподдерживаемая валюта.');
  const prices = object(raw.prices_per_kg, 'Цены за килограмм');
  const entries = Object.entries(prices);
  if (!entries.length) throw new Error('Нужен непустой справочник цен за килограмм.');
  const seen = new Set();
  const normalized = entries.map(([productId, price]) => {
    const numericId = Number(productId);
    if (!/^\d+$/.test(productId) || !Number.isSafeInteger(numericId) || numericId <= 0) {
      throw new Error('Цена металла: ID товара должен быть положительным безопасным целым числом.');
    }
    const key = String(numericId);
    if (seen.has(key)) throw new Error(`Повторная цена металла для товара #${key}.`);
    seen.add(key);
    const value = parseNumber(price);
    if (!Number.isFinite(value) || value < 0) throw new Error(`Товар #${key}: цена за килограмм должна быть конечным неотрицательным числом.`);
    return [key, value];
  });
  return {version: version(raw.version), currency, prices_per_kg: Object.fromEntries(normalized)};
}

function id(value, label) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}: некорректный ID.`);
    return String(value);
  }
  if (typeof value !== 'string') throw new Error(`${label}: нужен непустой ID.`);
  const result = value.trim();
  if (!result || result.length > 250 || /[\u0000-\u001f\u007f]/.test(result)) throw new Error(`${label}: некорректный ID.`);
  return result;
}

function optionalText(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label}: ожидается текст.`);
  return value.trim() || undefined;
}

// Decimal coefficients are represented exactly as integer × 10^(-scale).
// This avoids binary floating point changing a half-kopeck rounding decision.
function decimal(value) {
  let text = numberText(value);
  if (text === null) throw new Error('Некорректное число.');
  // An underflowing numeric literal is zero in JavaScript; avoid enormous powers.
  if (Number(text) === 0) return { n: 0n, scale: 0 };
  const [mantissa, exponentText = '0'] = text.toLowerCase().split('e');
  const exponent = Number(exponentText);
  const sign = mantissa.startsWith('-') ? -1n : 1n;
  const unsigned = mantissa.replace(/^[+-]/, '');
  const [whole = '', fraction = ''] = unsigned.split('.');
  let n = BigInt((whole + fraction) || '0') * sign;
  let scale = fraction.length - exponent;
  if (scale < 0) { n *= pow10(-scale); scale = 0; }
  return { n, scale };
}

function pow10(power) { return 10n ** BigInt(power); }
function add(a, b) {
  const scale = Math.max(a.scale, b.scale);
  return { n: a.n * pow10(scale - a.scale) + b.n * pow10(scale - b.scale), scale };
}
function multiply(a, b) { return { n: a.n * b.n, scale: a.scale + b.scale }; }

/** Round half away from zero, symmetrically for signed modelling coefficients. */
function cents(value) {
  if (value.scale <= 2) return value.n * pow10(2 - value.scale);
  const divisor = pow10(value.scale - 2);
  let rounded = value.n / divisor;
  const remainder = value.n % divisor;
  const absoluteRemainder = remainder < 0n ? -remainder : remainder;
  if (absoluteRemainder * 2n >= divisor) rounded += value.n < 0n ? -1n : 1n;
  return rounded;
}

function moneyNumber(value) {
  // Convert after rounding, retaining a finite result for very large finite input.
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(3, '0');
  const result = Number(`${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`);
  if (!Number.isFinite(result)) throw new Error('Результат расчёта превышает допустимый числовой диапазон.');
  return result === 0 ? 0 : result;
}

export function calculateQuote(rows, rawConfig) {
  let config;
  try { config = validateConfig(rawConfig); }
  catch (error) { return { rows: [], total: null, quantity: 0, valid: false, errors: [error.message] }; }
  if (!Array.isArray(rows) || rows.length === 0) {
    return { rows: [], total: null, quantity: 0, valid: false, errors: ['Добавьте хотя бы одну позицию.'] };
  }
  const quoteErrors = [];
  let sum = 0n;
  let quantitySum = decimal(0);
  const coatingCodes = new Set(config.coatings.map(coating => coating.code));
  const calculatedRows = rows.map((input, index) => {
    const row = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const errors = [];
    if (row !== input) errors.push('Некорректная позиция.');
    if (!coatingCodes.has(String(row.coatingCode ?? ''))) errors.push('Выберите покрытие из справочника.');
    let coatingName = '';
    try { coatingName = formatCoating(config.coatings.find(coating => coating.code === row.coatingCode), row.ralColor); }
    catch (error) { errors.push(error.message); }
    if (row.currency !== config.currency) errors.push(`Валюта товара должна быть ${config.currency}; автоматическая конвертация не выполняется.`);
    const commonFields = [
      ['quantity', 'Количество', false, true],
      ['k1', 'К1', true, false], ['k2', 'К2', true, false], ['k3', 'К3', true, false],
    ];
    const fields = config.formulaMode === 'excel' ? [
      ...commonFields,
      ['pricePerKg', 'Цена за килограмм', false, false],
      ['weight', 'Вес единицы', false, true],
      ['fasteners', 'Метизы за единицу', false, false],
    ] : [
      ['basePrice', 'Базовая цена', false, false],
      ...commonFields,
    ];
    const values = {};
    for (const [field, label, signed, positive] of fields) {
      const value = row[field] === undefined && field === 'fasteners' ? 0 : row[field];
      const number = parseNumber(value);
      if (!Number.isFinite(number)) { errors.push(`${label}: введите конечное число.`); continue; }
      if (positive && number <= 0) { errors.push(`${label}: значение должно быть больше нуля.`); continue; }
      if (!signed && !positive && number < 0) { errors.push(`${label}: значение не может быть отрицательным.`); continue; }
      values[field] = decimal(value);
    }
    if (values.quantity) quantitySum = add(quantitySum, values.quantity);
    let unitPrice = null;
    let lineTotal = null;
    if (!errors.length) {
      try {
        let rawUnit;
        if (config.formulaMode === 'excel') {
          const materialCost = multiply(values.pricePerKg, values.weight);
          const adjustedCost = multiply(multiply(multiply(materialCost, values.k1), values.k2), values.k3);
          rawUnit = add(adjustedCost, values.fasteners);
        } else {
          rawUnit = multiply(multiply(multiply(values.basePrice, values.k1), values.k2), values.k3);
        }
        const unitCents = cents(rawUnit);
        const lineCents = cents(multiply(config.rounding === 'unit' ? { n: unitCents, scale: 2 } : rawUnit, values.quantity));
        unitPrice = moneyNumber(unitCents);
        lineTotal = moneyNumber(lineCents);
        sum += lineCents;
      } catch (error) {
        errors.push(error.message);
        unitPrice = null;
        lineTotal = null;
      }
    }
    quoteErrors.push(...errors.map(error => `Позиция ${index + 1}: ${error}`));
    const calculatedRow = {...row, coatingName, unitPrice, lineTotal, valid: errors.length === 0, errors};
    delete calculatedRow.coatingFactor;
    return calculatedRow;
  });
  let total = null;
  let quantity = Number(quantitySum.n) / 10 ** quantitySum.scale;
  // String conversion also covers quantity sums whose integer numerator overflows.
  if (!Number.isFinite(quantity)) {
    const digits = quantitySum.n.toString().padStart(quantitySum.scale + 1, '0');
    quantity = Number(quantitySum.scale ? `${digits.slice(0, -quantitySum.scale)}.${digits.slice(-quantitySum.scale)}` : digits);
  }
  if (!Number.isFinite(quantity)) { quantity = null; quoteErrors.push('Общее количество превышает допустимый числовой диапазон.'); }
  if (!quoteErrors.length) {
    try { total = moneyNumber(sum); }
    catch (error) { quoteErrors.push(error.message); }
  }
  return { rows: calculatedRows, total, quantity, valid: quoteErrors.length === 0, errors: quoteErrors };
}
