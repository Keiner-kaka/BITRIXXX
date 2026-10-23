import {fingerprintRows} from './bitrix.js';
import {PARAMETERS, validateMappings, readPrimary, encodeResult, displayValue} from './integration-config.js';
import {calculateQuote, parseNumber} from './calculator.js';
import {canonical, sha256, calculateMetrics, createSnapshot, checkSnapshotSize, verifySnapshot} from './quote-snapshot.js';

const active = new Set();
export function rowsMatchQuote(rows, quote) {
  return rows.length === quote.rows.length && rows.every((row, i) => {
    const expected = quote.rows[i];
    return String(row.productId || 0) === String(expected.rowType === 'custom' ? 0 : expected.productId)
      && row.productName === expected.productName && Math.abs(Number(row.unitPrice) - expected.unitPrice) < 0.000001
      && Math.abs(Number(row.quantity) - parseNumber(expected.quantity)) < 0.000001
      && Number(row.taxRate || 0) === Number(expected.taxRate ?? expected.raw?.TAX_RATE ?? 0)
      && String(row.taxIncluded || 'Y') === String(expected.taxIncluded ?? expected.raw?.TAX_INCLUDED ?? 'Y');
  });
}
function sameResult(actual, expected) {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v,i) => sameResult(actual[i],v));
  return String(actual ?? '') === String(expected ?? '');
}
function identity(quote) {
  const {quoteId, createdAt, operationId, ...body} = quote;
  return body;
}
export class QuoteSaver {
  constructor(adapter, settings, {storage = globalThis.localStorage, scope = 'portal', confirm = message => globalThis.confirm(message), notify = () => {}} = {}) {
    this.adapter = adapter; this.settings = settings; this.storage = storage; this.scope = scope; this.confirm = confirm; this.notify = notify;
  }
  key(dealId) { return `yuzm-save-operation-${this.scope}-deal-${dealId}`; }
  pending(dealId) {
    const raw = this.storage.getItem(this.key(dealId));
    if (!raw) return null;
    try { const value = JSON.parse(raw); if (value.dealId !== String(dealId) || !value.operationId || !value.quote) throw new Error(); return value; }
    catch { throw new Error('Журнал сохранения повреждён. Проверьте историю документов и CRM перед новой генерацией.'); }
  }
  persist(operation) {
    try { this.storage.setItem(this.key(operation.dealId), JSON.stringify(operation)); }
    catch { throw new Error('Не удалось сохранить журнал операции в браузере. Продолжение записи заблокировано.'); }
  }
  async runLocked(dealId, run) {
    const name = this.key(dealId);
    if (active.has(name)) throw new Error('Сохранение этого КП уже выполняется.');
    const guarded = async () => {active.add(name); try {return await run();} finally {active.delete(name);}};
    if (globalThis.navigator?.locks) return navigator.locks.request(name, {ifAvailable: true}, lock => {
      if (!lock) throw new Error('КП этой сделки сохраняется в другой вкладке браузера.');
      return guarded();
    });
    if (globalThis.window) throw new Error('Для безопасного сохранения нужен современный браузер с Web Locks на HTTPS-хосте.');
    return guarded();
  }
  async save(quote, config, fields) {
    return this.runLocked(quote.dealId, async () => {
      validateMappings(config, fields);
      quote = JSON.parse(JSON.stringify({...quote, deliveryCoefficientKeys: config.deliveryCoefficientKeys}));
      const quoteHash = await sha256(identity(quote));
      let operation = this.pending(quote.dealId);
      if (operation && operation.stage === 'done' && operation.quoteHash !== quoteHash) operation = null;
      if (operation && operation.quoteHash !== quoteHash) throw new Error('Осталось незавершённое сохранение другого расчёта. Нажмите «Продолжить сохранение КП» для исходного расчёта.');
      if (operation && canonical(operation.config) !== canonical(config)) throw new Error('Конфигурация изменилась во время операции. Верните исходные настройки и завершите сохранение.');
      if (!operation) {
        const recalculated = calculateQuote(quote.rows, quote.config);
        if (!recalculated.valid || recalculated.total !== quote.total) throw new Error('Суммы предпросмотра не совпали со штатным калькулятором.');
        quote = JSON.parse(JSON.stringify({...quote, deliveryCoefficientKeys: config.deliveryCoefficientKeys}));
        const metrics = calculateMetrics(quote, config.deliveryCoefficientKeys);
        const deal = await this.adapter.call('crm.deal.get', {id: Number(quote.dealId)});
        if (String(deal?.ID) !== String(quote.dealId)) throw new Error('CRM вернула другую сделку.');
        const primary = readPrimary(deal, config, fields);
        for (const field of Object.values(fields)) {
          const output = Object.entries(PARAMETERS).some(([key,p]) => p.direction === 'out' && config.fields[key].code === field.code);
          if (field.required && !field.readOnly && !output && !displayValue(deal[field.code]).trim()) throw new Error(`Обязательное поле сделки «${field.label}» не заполнено.`);
        }
        if (quote.primary && canonical(quote.primary) !== canonical(primary)) throw new Error('Исходные поля сделки изменились. Обновите данные сделки и предпросмотр.');
        const preflight = await this.adapter.applyToDeal(quote.dealId, quote, undefined, {dryRun: true});
        const operationId = crypto.randomUUID();
        const frozen = {...quote, primary, operationId};
        const prepared = await this.adapter.prepareQuoteDocument(quote.dealId, quote.documentTemplateId, frozen);
        // Reserve room for the real document ID/number/date before creating anything.
        const provisional = await createSnapshot(frozen, {id: '9'.repeat(20), number: 'X'.repeat(250), createdAt: new Date().toISOString()}, metrics, operationId);
        checkSnapshotSize(provisional, config.snapshotMaxBytes, fields[config.fields.snapshot.code]);
        for (const key of ['total','delivery','weight']) encodeResult(metrics[key], fields[config.fields[key].code], quote.currency);
        const warning = `Сохранить КП сделки #${quote.dealId}? Будет создан документ и заменены ВСЕ ${preflight.before.rows.length} товарных строк полным составом КП (${quote.rows.length} строк, включая произвольные). Сумма: ${quote.total} ${quote.currency}. JSON последнего КП будет заменён. Согласование клиентом не устанавливается.`;
        if (!await this.confirm(warning)) return null;
        operation = {dealId: String(quote.dealId), operationId, quoteHash, quote: frozen, config, metrics, stage: 'prepared',
          beforeRows: fingerprintRows(preflight.before.rows), originalFields: Object.fromEntries(['total','delivery','weight','snapshot'].map(key => [config.fields[key].code, deal[config.fields[key].code] ?? null]))};
        this.persist(operation);
        // Keep signature URLs in memory only, never in the journal.
        return this.execute(operation, fields, prepared);
      }
      return this.execute(operation, fields);
    });
  }
  async execute(operation, fields, prepared) {
    const {quote, config} = operation;
    if (operation.stage === 'document-unknown') throw new Error('Ответ на создание документа не получен. Автоповтор заблокирован: найдите документ в истории и укажите его ID через «Проверить документ незавершённого сохранения».');
    try {
      if (!operation.document) {
        if (canonical(await this.settings.load()) !== canonical(config)) throw new Error('Общие настройки изменились перед созданием документа.');
        const currentDeal = await this.adapter.call('crm.deal.get', {id: Number(quote.dealId)});
        if (String(currentDeal?.ID) !== String(quote.dealId) || canonical(readPrimary(currentDeal,config,fields)) !== canonical(quote.primary)) throw new Error('Исходные поля сделки изменились перед созданием документа.');
        await this.adapter.applyToDeal(quote.dealId, quote, operation.beforeRows, {dryRun:true});
        prepared ||= await this.adapter.prepareQuoteDocument(quote.dealId, quote.documentTemplateId, quote);
        // A reload at any point after this durable marker cannot cause another add.
        operation.stage = 'document-unknown'; this.persist(operation);
        this.notify('Создание документа КП…');
        let document;
        try { document = await this.adapter.createPreparedQuoteDocument(prepared); }
        catch (error) {
          if (error.documentId) { operation.unverifiedDocumentId = error.documentId; this.persist(operation); }
          // Explicit REST rejection cannot have created a document. Transport failures remain ambiguous.
          const rejected = ['ACCESS_DENIED','insufficient_scope','INVALID_ARG_VALUE','ERROR_ARGUMENT','NO_AUTH_FOUND','expired_token','user_access_error','ERROR_METHOD_NOT_FOUND','METHOD_NOT_FOUND'];
          if (error.method === 'crm.documentgenerator.document.add' && rejected.includes(error.code)) {operation.stage = 'prepared'; this.persist(operation);}
          throw error;
        }
        operation.document = {id: document.id, number: document.number, templateId: document.templateId, createdAt: document.createdAt || new Date().toISOString(), title: document.title};
        operation.stage = 'document-created'; this.persist(operation);
      }
      const document = await this.adapter.getQuoteDocument(operation.document.id, {dealId: quote.dealId, templateId: quote.documentTemplateId});
      if (!document.number) throw new Error('Bitrix24 ещё не вернул номер документа. Повторите продолжение сохранения после его формирования.');
      if (!document.downloadUrl) throw new Error('Файл DOCX ещё не сформирован. Продолжите сохранение после готовности документа.');
      if (operation.document.number && operation.document.number !== document.number) throw new Error('Номер уже созданного документа изменён; требуется сверка документа.');
      operation.document.number = document.number;
      this.persist(operation);
      const snapshot = await createSnapshot(quote, operation.document, operation.metrics, operation.operationId);
      const encoded = checkSnapshotSize(snapshot, config.snapshotMaxBytes, fields[config.fields.snapshot.code]);
      const updates = {};
      for (const key of ['total','delivery','weight']) updates[config.fields[key].code] = encodeResult(operation.metrics[key], fields[config.fields[key].code], quote.currency);
      updates[config.fields.snapshot.code] = fields[config.fields.snapshot.code].multiple ? [encoded] : encoded;
      if (operation.stage !== 'done') {
        const freshConfig = await this.settings.load();
        if (canonical(freshConfig) !== canonical(config)) throw new Error('Общие настройки изменились во время сохранения. Запись приостановлена.');
        const fresh = await this.adapter.call('crm.deal.get', {id: Number(quote.dealId)});
        if (String(fresh?.ID) !== String(quote.dealId) || canonical(readPrimary(fresh,config,fields)) !== canonical(quote.primary)) throw new Error('Исходные поля сделки изменились; запись приостановлена.');
        for (const [code, value] of Object.entries(updates)) {
          if (!sameResult(fresh[code], operation.originalFields[code]) && !sameResult(fresh[code], value)) throw new Error(`Поле ${code} изменено другим пользователем; запись приостановлена.`);
        }
        const current = await this.adapter.loadDeal(quote.dealId);
        if (!rowsMatchQuote(current.rows, quote)) {
          if (fingerprintRows(current.rows) !== operation.beforeRows) throw new Error('Товары сделки изменены другим пользователем. Повторная замена заблокирована.');
          this.notify('Запись полного состава товаров…');
          await this.adapter.applyToDeal(quote.dealId, quote, operation.beforeRows);
        }
        operation.stage = 'rows-written'; this.persist(operation);
        this.notify('Запись JSON и результатов расчёта…');
        if (await this.adapter.call('crm.deal.update', {id: Number(quote.dealId), fields: updates}) !== true) throw new Error('CRM не подтвердила запись JSON и результатов.');
        operation.stage = 'fields-written'; this.persist(operation);
      }
      const [actual, current] = await Promise.all([
        this.adapter.call('crm.deal.get', {id: Number(quote.dealId)}), this.adapter.loadDeal(quote.dealId),
      ]);
      if (String(actual?.ID) !== String(quote.dealId) || !rowsMatchQuote(current.rows, quote) || current.currency !== quote.currency || Object.entries(updates).some(([code,value]) => !sameResult(actual[code],value))) throw new Error('Контрольное чтение: поля, суммы или товары отличаются. КП не отмечено сохранённым.');
      const raw = actual[config.fields.snapshot.code];
      const verified = await verifySnapshot(Array.isArray(raw) ? raw[0] : raw, quote.dealId);
      if (verified.snapshot.document.id !== document.id || verified.snapshot.operationId !== operation.operationId) throw new Error('JSON и документ относятся к разным операциям.');
      operation.stage = 'done'; this.persist(operation);
      return {document, snapshot};
    } catch (error) {
      const stage = operation.stage;
      const detail = operation.document ? `Документ #${operation.document.id} уже существует; повтор продолжит запись без создания копии.` : stage === 'document-unknown' ? 'Создание документа не подтверждено; повтор создания заблокирован.' : 'Документ не создан.';
      throw new Error(`Сохранение КП не завершено (${stage}). ${detail} ${error.message}`);
    }
  }
  async recoverDocument(dealId, documentId) {
    return this.runLocked(dealId, async () => {
      const operation = this.pending(dealId);
      if (!operation || operation.stage !== 'document-unknown') throw new Error('Нет операции с неподтверждённым созданием документа.');
      const document = await this.adapter.getQuoteDocument(documentId, {dealId, templateId: operation.quote.documentTemplateId});
      if (!document.title.includes(`[${operation.operationId}]`)) throw new Error('Документ не содержит маркер этой операции; автоматическая привязка запрещена.');
      if (!await this.confirm(`Привязать найденный документ #${document.id} к сохранению КП сделки #${dealId}?`)) return;
      operation.document = {id: document.id, number: document.number, templateId: document.templateId, createdAt: document.createdAt || new Date().toISOString(), title: document.title};
      operation.stage = 'document-created'; this.persist(operation);
    });
  }
}
