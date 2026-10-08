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
    const coefficient = parseNumber(entry.coefficient);
    if (!Number.isFinite(coefficient) || coefficient < 0) throw new Error(`Некорректный коэффициент покрытия «${name}».`);
    if (seen.has(code)) throw new Error(`Повторный код покрытия «${code}».`);
    seen.add(code);
    return { code, name, coefficient };
  });
  // Legacy prices_per_kg is deliberately neither read nor used: weight is excluded.
  return { version: version(raw.version), currency, coatings, formulaMode, rounding };
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

function optionalId(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  return id(value, label);
}

function optionalText(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label}: ожидается текст.`);
  return value.trim() || undefined;
}

function mergeMetadata(map, key, values, label) {
  const previous = map.get(key) || {};
  for (const [field, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (previous[field] !== undefined && previous[field] !== value) throw new Error(`${label} «${key}»: противоречивые данные.`);
    previous[field] = value;
  }
  map.set(key, previous);
}

/** Normalize a Disk JSON reference file and fail before using ambiguous data. */
export function normalizeRelations(raw) {
  object(raw, 'Связи');
  if (!Array.isArray(raw.product_drawings) || !Array.isArray(raw.drawing_kd)) {
    throw new Error('В файле связей нужны массивы product_drawings и drawing_kd.');
  }
  const drawingMetadata = new Map();
  const productMetadata = new Map();
  const kitMetadata = new Map();
  const fileMetadata = new Map();
  const productPairs = new Set();
  const kitFiles = new Set();

  const product_drawings = raw.product_drawings.map((entry, index) => {
    object(entry, `Связь товара ${index + 1}`);
    const result = {
      product_id: id(entry.product_id, 'Товар'),
      drawing_id: id(entry.drawing_id, 'Чертёж'),
    };
    const productName = optionalText(entry.product_name, 'Наименование товара');
    const drawingName = optionalText(entry.drawing_name, 'Название чертежа');
    const drawingFileId = optionalId(entry.drawing_file_id, 'Файл чертежа');
    if (productName !== undefined) result.product_name = productName;
    if (drawingName !== undefined) result.drawing_name = drawingName;
    if (drawingFileId !== undefined) result.drawing_file_id = drawingFileId;
    const pair = JSON.stringify([result.product_id, result.drawing_id]);
    if (productPairs.has(pair)) throw new Error(`Повторная связь товара «${result.product_id}» и чертежа «${result.drawing_id}».`);
    productPairs.add(pair);
    mergeMetadata(productMetadata, result.product_id, { name: productName }, 'Товар');
    mergeMetadata(drawingMetadata, result.drawing_id, { name: drawingName, fileId: drawingFileId }, 'Чертёж');
    return result;
  });

  const drawing_kd = raw.drawing_kd.map((entry, index) => {
    object(entry, `Связь комплекта КД ${index + 1}`);
    const result = { drawing_id: id(entry.drawing_id, 'Чертёж'), kit_id: id(entry.kit_id, 'Комплект КД') };
    if (!drawingMetadata.has(result.drawing_id)) throw new Error(`Комплект КД ссылается на неизвестный чертёж «${result.drawing_id}».`);
    const kitName = optionalText(entry.kit_name, 'Название комплекта КД');
    const fileId = optionalId(entry.file_id, 'Файл КД');
    const fileName = optionalText(entry.file_name, 'Название файла КД');
    if (fileName && !fileId) throw new Error('Название файла КД задано без ID файла.');
    if (kitName !== undefined) result.kit_name = kitName;
    if (fileId !== undefined) result.file_id = fileId;
    if (fileName !== undefined) result.file_name = fileName;
    const pair = JSON.stringify([result.drawing_id, result.kit_id, fileId ?? null]);
    if (kitFiles.has(pair)) throw new Error(`Повторная связь комплекта КД «${result.kit_id}» с файлом.`);
    kitFiles.add(pair);
    mergeMetadata(kitMetadata, result.kit_id, { name: kitName }, 'Комплект КД');
    if (fileId) mergeMetadata(fileMetadata, fileId, { name: fileName }, 'Файл КД');
    return result;
  });

  // Fill omitted metadata from other records describing the same ID.
  for (const entry of product_drawings) {
    const drawing = drawingMetadata.get(entry.drawing_id);
    const product = productMetadata.get(entry.product_id);
    if (drawing.name) entry.drawing_name = drawing.name;
    if (drawing.fileId) entry.drawing_file_id = drawing.fileId;
    if (product.name) entry.product_name = product.name;
  }
  for (const entry of drawing_kd) {
    const kit = kitMetadata.get(entry.kit_id);
    if (kit.name) entry.kit_name = kit.name;
    const file = entry.file_id && fileMetadata.get(entry.file_id);
    if (file?.name) entry.file_name = file.name;
  }
  return { version: version(raw.version), product_drawings, drawing_kd };
}

export function resolveRelations(productId, relations) {
  const product = id(productId, 'Товар');
  const normalized = normalizeRelations(relations);
  const drawings = normalized.product_drawings.filter(entry => entry.product_id === product).map(entry => {
    const kits = new Map();
    for (const related of normalized.drawing_kd.filter(item => item.drawing_id === entry.drawing_id)) {
      if (!kits.has(related.kit_id)) kits.set(related.kit_id, { id: related.kit_id, name: related.kit_name || related.kit_id, files: [] });
      if (related.file_id) kits.get(related.kit_id).files.push({ id: related.file_id, name: related.file_name || related.file_id });
    }
    return { id: entry.drawing_id, name: entry.drawing_name || entry.drawing_id, fileId: entry.drawing_file_id, kits: [...kits.values()] };
  });
  return { drawings };
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
  const coatings = new Map(config.coatings.map(coating => [coating.code, coating]));
  const calculatedRows = rows.map((input, index) => {
    const row = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const errors = [];
    if (row !== input) errors.push('Некорректная позиция.');
    const coating = coatings.get(String(row.coatingCode ?? ''));
    if (!coating) errors.push('Выберите покрытие из справочника.');
    if (row.currency !== config.currency) errors.push(`Валюта товара должна быть ${config.currency}; автоматическая конвертация не выполняется.`);
    const fields = [
      ['basePrice', 'Базовая цена', false, false],
      ['quantity', 'Количество', false, true],
      ['k1', 'К1', true, false], ['k2', 'К2', true, false],
      ['fasteners', 'Крепёж и покупные изделия', false, false],
      ['extraCoating', 'Дополнительное покрытие', false, false],
      ['delivery', 'Доставка', false, false],
    ];
    const values = {};
    for (const [field, label, signed, positive] of fields) {
      const value = row[field] === undefined && ['fasteners', 'extraCoating', 'delivery'].includes(field) ? 0 : row[field];
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
        let rawUnit = config.formulaMode === 'catalog'
          ? multiply(values.basePrice, decimal(coating.coefficient))
          : add(add(add(values.basePrice, values.fasteners), values.extraCoating), values.delivery);
        rawUnit = multiply(multiply(rawUnit, values.k1), values.k2);
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
    return { ...row, unitPrice, lineTotal, coatingFactor: coating?.coefficient ?? null, valid: errors.length === 0, errors };
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
