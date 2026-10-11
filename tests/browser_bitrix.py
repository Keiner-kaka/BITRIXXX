"""Exercise the real UI against a mocked Bitrix24 SDK; never call a live portal.

Run a server on localhost:8080 first, then python tests/browser_bitrix.py.
Requires Playwright and system Chromium, as in browser_smoke.py.
"""
import re
from playwright.sync_api import sync_playwright, expect

BASE = 'http://127.0.0.1:8080/'
checks = []
DOCUMENT_FIELDS = {
    'YuzmPaymentTerms': '40% при заказе, 60% перед отгрузкой — согласовано с клиентом',
    'YuzmFastenerTerms': 'Метизы включены в стоимость изделий',
    'YuzmDocumentsTerms': 'Паспорт изделия и сертификат качества',
    'YuzmDeliveryTerms': 'Самовывоз со склада производителя',
    'YuzmValidityTerms': 'Предложение действует 10 рабочих дней',
    'YuzmManagerPosition': 'Менеджер отдела продаж',
    'YuzmManagerName': 'Иван Петров',
    'YuzmManagerPhone': '+7 900 123-45-67',
}

MOCK = r"""
(() => {
  const persisted = sessionStorage.getItem('__pilot_mock_server');
  const m = window.__pilotMock = persisted ? JSON.parse(persisted) : {
    calls: [], setCount: 0, uploads: [], nextFileId: 1000, documents: {}, nextDocumentId: 500,
    products: [
      {id:201, iblockId:7, name:'НФГ-6,0-02', type:1, price:38600},
      {id:202, iblockId:7, name:'ОГК-6', type:1, price:29000}
    ],
    dealRows: [{ID:'900', PRODUCT_ID:201, PRODUCT_NAME:'НФГ-6,0-02', PRICE:100,
      QUANTITY:2, SORT:10, TAX_RATE:20, TAX_INCLUDED:'Y'}],
    templates: {
      '7': {id:7, name:'КП ЮЗМ — действующий шаблон', active:'Y', isDeleted:'N', entityTypeId:['2']},
      '8': {id:8, name:'КП ЮЗМ — шаблон по умолчанию', active:'Y', isDeleted:'N', entityTypeId:['2_category_0']},
      '9': {id:9, name:'Архивный шаблон', active:'N', isDeleted:'N', entityTypeId:['2']}
    },
    files: {
      '11': {name:'coatings.json', data:{version:'pilot-coatings', currency:'RUB',
        coatings:[{code:'none',name:'Без покрытия',coefficient:1}, {code:'zinc',name:'Горячее цинкование',coefficient:1.18}, {code:'paint',name:'Окраска',coefficient:1.12}],
        formulaMode:'catalog', rounding:'unit'}},
      '12': {name:'metal-prices.json', data:{version:'pilot-metal', currency:'RUB', prices_per_kg:{'201':120,'202':130}}}
    }
  };
  const persist = () => sessionStorage.setItem('__pilot_mock_server', JSON.stringify(m));
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://pilot.bitrix.example/mock-disk/')) {
      if (options.credentials !== 'include') throw new Error('Disk request must include credentials');
      const fileId = url.split('/').at(-1);
      const file = m.files[fileId];
      return new Response(file ? JSON.stringify(file.data) : '{}', {status:file ? 200 : 404, headers:{'Content-Type':'application/json'}});
    }
    return nativeFetch(input, options);
  };
  window.BX24 = {
    init(callback) { queueMicrotask(callback); },
    getDomain() { return 'pilot.bitrix.example'; },
    placement: {info() {return {placement:'CRM_DEAL_DETAIL_TAB',options:{ID:'1048'}};}},
    callMethod(method, params, callback) {
      m.calls.push({method,params:structuredClone(params)});
      let data, error;
      switch (method) {
        case 'app.info': data={ID:'99',INSTALLED:true}; break;
        case 'crm.deal.get': data={ID:'1048',TITLE:'Пилот КП',COMPANY_ID:1,CURRENCY_ID:'RUB',CATEGORY_ID:0}; break;
        case 'crm.company.get': data={ID:'1',TITLE:'ООО «Пилот»'}; break;
        case 'crm.deal.productrows.get': data=structuredClone(m.dealRows); break;
        case 'crm.documentgenerator.template.list': data={templates:structuredClone(m.templates)}; break;
        case 'crm.documentgenerator.template.get': {
          const template=m.templates[String(params.id)];
          if (!template) error='NOT_FOUND'; else data={template:structuredClone(template)}; break;
        }
        case 'crm.documentgenerator.document.add': {
          if (params.entityId!==1048 || params.entityTypeId!==2 || params.templateId!==7) {error='WRONG_DOCUMENT_TARGET'; break;}
          const documentId=String(m.nextDocumentId++);
          const document={id:documentId,title:'КП ЮЗМ #'+documentId,templateId:params.templateId,
            entityId:params.entityId,entityTypeId:params.entityTypeId,
            downloadUrl:'https://pilot.bitrix.example/documents/'+documentId+'.docx',pdfUrl:'',
            publicUrl:'https://pilot.bitrix.example/documents/'+documentId};
          m.documents[documentId]=document;
          data={document:structuredClone(document)}; break;
        }
        case 'crm.documentgenerator.document.get': {
          const document=m.documents[String(params.id)];
          if (!document) {error='NOT_FOUND'; break;}
          document.pdfUrl='https://pilot.bitrix.example/documents/'+document.id+'.pdf';
          data={document:structuredClone(document)}; break;
        }
        case 'catalog.catalog.list': data={catalogs:[{id:7,iblockId:7,name:'Каталог пилота',productIblockId:0}]}; break;
        case 'catalog.product.list':
          if (params.filter.iblockId !== 7) {error='WRONG_CATALOG'; break;}
          data={products:m.products.filter(product=>!params.filter['%name'] || product.name.toLowerCase().includes(params.filter['%name'].toLowerCase()))}; break;
        case 'catalog.product.get': {
          if (m.conflictOnNextProductCheck) {m.dealRows[0].QUANTITY=999; m.conflictOnNextProductCheck=false;}
          const product=m.products.find(product=>product.id===Number(params.id));
          if (product) data={product}; else error='NOT_FOUND'; break;
        }
        case 'catalog.priceType.list': data={priceTypes:[{id:1,name:'BASE',base:'Y'}]}; break;
        case 'catalog.price.list':
          if (params.filter.catalogGroupId !== 1) {error='WRONG_PRICE_TYPE'; break;}
          data={prices:m.products.filter(product=>params.filter['@productId'].includes(product.id)).map(product=>({id:product.id,productId:product.id,catalogGroupId:1,price:product.price,currency:'RUB'}))}; break;
        case 'disk.folder.getChildren':
          data=Object.entries(m.files).filter(([,file])=>file.folderId===Number(params.id)).map(([fileId,file])=>({ID:fileId,NAME:file.name,TYPE:'file',DELETED_TYPE:0})); break;
        case 'disk.file.get': {
          const file=m.files[String(params.id)];
          if (!file) {error='NOT_FOUND'; break;}
          data={ID:String(params.id),NAME:file.name,TYPE:'file',GLOBAL_CONTENT_VERSION:'1',DOWNLOAD_URL:'https://pilot.bitrix.example/mock-disk/'+params.id}; break;
        }
        case 'disk.folder.uploadFile': {
          if (!params.fileContent || params.fileContent[0]!==params.data.NAME || params.generateUniqueName!==false) {error='WRONG_UPLOAD'; break;}
          if (Object.values(m.files).some(file=>file.name===params.data.NAME)) {error='NAME_ALREADY_EXISTS'; break;}
          const bytes=Uint8Array.from(atob(params.fileContent[1]),c=>c.charCodeAt(0));
          const snapshot=JSON.parse(new TextDecoder().decode(bytes));
          const fileId=String(m.nextFileId++);
          m.files[fileId]={name:params.data.NAME,folderId:Number(params.id),data:snapshot};
          m.uploads.push({fileId,name:params.data.NAME,snapshot});
          data={ID:fileId,NAME:params.data.NAME}; break;
        }
        case 'crm.item.productrow.set':
          if (params.ownerType!=='D' || params.ownerId!==1048) {error='WRONG_DEAL'; break;}
          m.setCount++;
          m.dealRows=params.productRows.map((row,index)=>({ID:String(100+index),PRODUCT_ID:row.productId,
            PRODUCT_NAME:row.productName,PRICE:row.price,QUANTITY:row.quantity,SORT:row.sort,
            TAX_RATE:row.taxRate,TAX_INCLUDED:row.taxIncluded}));
          data=true; break;
        default: error='ERROR_METHOD_NOT_FOUND';
      }
      persist();
      queueMicrotask(()=>callback({
        error:()=>error ? {status:400,ex:{error,error_description:'Mock API error'}} : undefined,
        data:()=>structuredClone(data), more:()=>false
      }));
    }
  };
})();
"""


def passed(name):
    checks.append(name)
    print('PASS:', name, flush=True)


def money(text):
    return ''.join(text.split()).replace('₽', '')


def doc_add_count(page):
    return page.evaluate("window.__pilotMock.calls.filter(call => call.method==='crm.documentgenerator.document.add').length")


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1440, 'height': 1100}, locale='ru-RU')
    context.add_init_script(MOCK)
    context.route('https://api.bitrix24.tech/**', lambda route: route.fulfill(status=200, content_type='application/javascript', body='/* mock SDK already injected */'))
    # Abort any accidentally unmocked portal request; SDK/fetch mocks never leave this browser.
    live_requests = []
    context.route('https://pilot.bitrix.example/**', lambda route: (live_requests.append(route.request.url), route.abort()))
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())
    page.goto(BASE, wait_until='networkidle')
    expect(page.locator('#dealBadge')).to_contain_text('1048')
    expect(page.locator('#connectionBadge')).to_contain_text('подключён')
    expect(page.locator('.item-row')).to_have_count(1)
    assert money(page.locator('#grandTotal').inner_text()) == '200,00'
    assert page.evaluate('window.__pilotMock.setCount') == 0
    expect(page.locator('#documentTemplateId option[value="7"]')).to_have_text('КП ЮЗМ — действующий шаблон · #7')
    expect(page.locator('#documentTemplateId option[value="8"]')).to_have_count(1)
    expect(page.locator('#documentTemplateId option[value="9"]')).to_have_count(0)
    assert doc_add_count(page) == 0
    passed('placement opens negotiated prices and registered templates without CRM/document writes')

    page.locator('#settingsBtn').click()
    page.locator('#pricesFileId').fill('11')
    page.locator('#metalPricesFileId').fill('12')
    page.locator('#historyFolderId').fill('42')
    page.locator('#defaultDocumentTemplateId').fill('8')
    page.locator('#roundingMode').select_option('unit')
    page.locator('#loadRemoteBtn').click()
    expect(page.locator('#settingsError')).to_contain_text('загружены и проверены')
    page.locator('#loadMetalPricesBtn').click()
    expect(page.locator('#settingsError')).to_contain_text('Цены металла загружены с Диска')
    expect(page.locator('#metalPricesSummary')).to_contain_text('2 цен')
    expect(page.locator('#metalPricesSummary')).to_contain_text('файл #12')
    page.locator('#closeSettingsBtn').click()
    expect(page.locator('#documentTemplateId')).to_have_value('8')
    expect(page.locator('#relationsBody, #relationsSummary, #localRelationsInput, #relationsFileId, [data-field=drawingId], [data-file-id]')).to_have_count(0)
    expect(page.locator('#docsBody .document-row')).to_have_count(0)
    assert not page.evaluate("window.__pilotMock.calls.some(call => call.method==='disk.file.get' && Number(call.params.id)===10)")
    passed('separate coating and metal JSON files load with authenticated Disk fetch and optional template default')

    page.locator('.item-row [data-action=choose-product]').click()
    expect(page.locator('#productResults .catalog-result')).to_have_count(2)
    page.locator('#productResults .catalog-result').filter(has_text='НФГ-6,0-02').click()
    expect(page.locator('.item-row [data-field=quantity]')).to_have_value('2')
    assert money(page.locator('#grandTotal').inner_text()) == '77200,00'
    page.locator('.item-row [data-field=coatingCode]').select_option('zinc')
    assert money(page.locator('#grandTotal').inner_text()) == '77200,00'
    page.locator('.item-row [data-field=quantity]').fill('3')
    page.locator('.item-row [data-field=k3]').fill('1.18')
    page.locator('.item-row [data-field=executionTerm]').fill('15 рабочих дней')
    assert money(page.locator('#grandTotal').inner_text()) == '136644,00'
    passed('catalog BASE price uses explicit K3; changing the coating label leaves the price unchanged')

    page.locator('#saveBtn').click()
    expect(page.locator('#status')).to_contain_text('Сохранена версия 1')
    expect(page.locator('#status')).to_contain_text('на Диске')
    assert page.evaluate('window.__pilotMock.uploads.length') == 1
    assert page.evaluate("""() => {
      const snapshot=window.__pilotMock.uploads[0].snapshot;
      return !['relations', 'relationMeta', 'documents'].some(key => key in snapshot)
        && snapshot.rows.every(row => !('drawingId' in row))
        && snapshot.rows[0].executionTerm==='15 рабочих дней';
    }""")
    page.locator('#historyBtn').click()
    expect(page.locator('.history-row')).to_have_count(1)
    expect(page.locator('.history-row')).to_contain_text('Диск Bitrix24')
    page.locator('[data-view-version]').click()
    assert money(page.locator('.quote-total').inner_text().replace('Итого:', '')) == '136644,00'
    expect(page.locator('#quotePreview')).to_contain_text('15 рабочих дней')
    page.locator('#closeQuoteBtn').click()
    passed('immutable UTF-8 Disk snapshots include execution terms and omit technical-document relations')

    page.locator('#applyDealBtn').click()
    expect(page.locator('#status')).to_contain_text('записан в сделку #1048')
    assert page.evaluate('window.__pilotMock.setCount') == 1
    assert page.evaluate('window.__pilotMock.dealRows.length') == 1
    assert page.evaluate('window.__pilotMock.dealRows[0].PRICE') == 45548
    assert page.evaluate('window.__pilotMock.dealRows[0].QUANTITY') == 3
    assert page.evaluate('window.__pilotMock.dealRows[0].TAX_RATE') == 20
    assert page.evaluate('window.__pilotMock.dealRows[0].TAX_INCLUDED') == 'Y'
    passed('confirmed CRM application replaces rows, verifies readback and preserves VAT')

    page.locator('#applyDealBtn').click()
    expect(page.locator('#status')).to_contain_text('записан в сделку #1048')
    assert page.evaluate('window.__pilotMock.setCount') == 2
    assert page.evaluate('window.__pilotMock.dealRows.length') == 1
    assert page.evaluate('window.__pilotMock.uploads.length') == 3
    assert page.evaluate('new Set(window.__pilotMock.uploads.map(file=>file.name)).size') == 3
    assert not page.evaluate(r'window.__pilotMock.calls.some(call=>/^catalog\..*(update|delete|add)$/.test(call.method))')
    passed('repeated application versions the proposal without duplicate CRM rows or catalog mutation')

    # Shared snapshots must recover variants even after removing the per-deal browser cache.
    page.evaluate("localStorage.removeItem('yuzm-kp-prototype-v1-bitrix-pilot.bitrix.example-deal-1048')")
    page.reload(wait_until='networkidle')
    expect(page.locator('#dealBadge')).to_contain_text('1048')
    expect(page.locator('#variantSelect option')).to_have_count(2)
    saved_variant = page.evaluate('window.__pilotMock.uploads[0].snapshot.variantId')
    page.locator('#variantSelect').select_option(saved_variant)
    expect(page.locator('[data-field=drawingId]')).to_have_count(0)
    expect(page.locator('#docsBody .document-row')).to_have_count(3)
    assert money(page.locator('#grandTotal').inner_text()) == '136644,00'
    page.locator('#historyBtn').click()
    expect(page.locator('.history-row')).to_have_count(3)
    page.locator('#closeHistoryBtn').click()
    passed('shared Disk history recovers saved variants and their own price/calculation context')

    page.evaluate('window.__pilotMock.conflictOnNextProductCheck=true')
    page.locator('#applyDealBtn').click()
    expect(page.locator('#status')).to_contain_text('изменились после предварительного просмотра')
    assert page.evaluate('window.__pilotMock.setCount') == 2
    assert page.evaluate('window.__pilotMock.dealRows[0].QUANTITY') == 999
    passed('a concurrent manager edit blocks replacement before any CRM write')

    page.locator('#settingsBtn').click()
    page.locator('#formulaMode').select_option('excel')
    page.locator('#settingsForm button[type=submit]').click()
    expect(page.locator('#settingsDialog')).not_to_be_visible()
    expect(page.locator('.item-row [data-field=pricePerKg]')).to_have_value('120')
    expect(page.locator('.item-row [data-field=pricePerKg]')).to_have_attribute('readonly', 'readonly')
    first = page.locator('.item-row').nth(0)
    first.locator('[data-field=weight]').fill('10')
    first.locator('[data-field=k1]').fill('1.1')
    first.locator('[data-field=k2]').fill('1.2')
    first.locator('[data-field=k3]').fill('1.3')
    first.locator('[data-field=fasteners]').fill('50')
    assert money(page.locator('#grandTotal').inner_text()) == '6327,60'
    page.locator('#addItemBtn').click()
    expect(page.locator('#productResults .catalog-result')).to_have_count(2)
    page.locator('#productResults .catalog-result').filter(has_text='ОГК-6').click()
    expect(page.locator('.item-row')).to_have_count(2)
    second = page.locator('.item-row').nth(1)
    expect(second.locator('[data-field=pricePerKg]')).to_have_value('130')
    second.locator('[data-field=quantity]').fill('2')
    second.locator('[data-field=weight]').fill('20')
    second.locator('[data-field=k1]').fill('1')
    second.locator('[data-field=k2]').fill('1')
    second.locator('[data-field=k3]').fill('1.4')
    second.locator('[data-field=fasteners]').fill('25')
    second.locator('[data-field=executionTerm]').fill('до 30.11.2026')
    second.locator('[data-field=coatingCode]').select_option('paint')
    assert money(page.locator('#grandTotal').inner_text()) == '13657,60'
    expect(page.locator('[data-field=extraCoating], [data-field=delivery]')).to_have_count(0)
    passed('two Excel lines use Disk price/kg × entered weight × K1 × K2 × K3 plus per-item fasteners')

    for preset, percentages in [('40_60', ['40%', '60%']), ('50_50', ['50%']), ('100', ['100%'])]:
        page.locator('#paymentTermsPreset').select_option(preset)
        for percentage in percentages:
            expect(page.locator('#YuzmPaymentTerms')).to_have_value(re.compile(percentage))
    page.locator('.manager-details summary').click()
    for field, value in DOCUMENT_FIELDS.items():
        page.locator('#' + field).fill(value)
    expect(page.locator('#paymentTermsPreset')).to_have_value('')
    page.locator('#duplicateVariantBtn').click()
    page.locator('#YuzmPaymentTerms').fill('Условия только копии варианта')
    page.locator('#variantSelect').select_option(saved_variant)
    expect(page.locator('#YuzmPaymentTerms')).to_have_value(DOCUMENT_FIELDS['YuzmPaymentTerms'])
    passed('editable payment presets and commercial conditions remain independent between variants')
    page.locator('#documentTemplateId').select_option('7')
    uploads_before_preview = page.evaluate('window.__pilotMock.uploads.length')
    page.locator('#createQuoteBtn').click()
    expect(page.locator('#quoteDialog')).to_be_visible()
    expect(page.locator('#quotePreview tbody tr')).to_have_count(2)
    expect(page.locator('#quotePreview tbody tr').nth(0)).to_contain_text('15 рабочих дней')
    expect(page.locator('#quotePreview tbody tr').nth(1)).to_contain_text('до 30.11.2026')
    assert money(page.locator('.quote-total').inner_text().replace('Итого:', '')) == '13657,60'
    assert page.evaluate('window.__pilotMock.uploads.length') == uploads_before_preview + 1
    assert doc_add_count(page) == 0
    snapshot_index = uploads_before_preview
    snapshot_before = page.evaluate('(index) => JSON.stringify(window.__pilotMock.uploads[index].snapshot)', snapshot_index)
    document_snapshot = page.evaluate('(index) => window.__pilotMock.uploads[index].snapshot', snapshot_index)
    assert document_snapshot['documentTemplateId'] == '7'
    assert document_snapshot['documentFields'] == DOCUMENT_FIELDS
    assert [float(row['pricePerKg']) for row in document_snapshot['rows']] == [120, 130]
    page.locator('#closeQuoteBtn').click()
    passed('local preview saves a two-line proposal with selected template and edited commercial conditions')

    # Change every live source; opening the saved version must still generate its original proposal.
    page.locator('.item-row').nth(0).locator('[data-field=quantity]').fill('7')
    page.locator('.item-row').nth(0).locator('[data-field=weight]').fill('99')
    page.locator('#YuzmPaymentTerms').fill('Новые условия только для текущего черновика')
    page.evaluate("window.__pilotMock.files['12'].data.prices_per_kg['201']=999")
    page.locator('#settingsBtn').click()
    page.locator('#loadMetalPricesBtn').click()
    expect(page.locator('#settingsError')).to_contain_text('Цены металла загружены с Диска')
    page.locator('#closeSettingsBtn').click()
    expect(page.locator('.item-row').nth(0).locator('[data-field=pricePerKg]')).to_have_value('999')
    page.locator('#documentTemplateId').select_option('8')
    page.locator('#historyBtn').click()
    page.locator('[data-view-version]').nth(0).click()
    assert money(page.locator('.quote-total').inner_text().replace('Итого:', '')) == '13657,60'
    expect(page.locator('#generateDocumentBtn')).to_be_enabled()
    page.locator('#generateDocumentBtn').click()
    expect(page.locator('#documentResult')).to_contain_text('Документ #500 создан')
    expect(page.locator('#documentResult a').filter(has_text='Скачать DOCX')).to_have_attribute('href', 'https://pilot.bitrix.example/documents/500.docx')
    expect(page.locator('#documentResult a').filter(has_text='Скачать PDF')).to_have_count(0)
    expect(page.locator('#generateDocumentBtn')).to_be_disabled()
    assert doc_add_count(page) == 1
    request = page.evaluate("window.__pilotMock.calls.find(call=>call.method==='crm.documentgenerator.document.add').params")
    assert request['templateId'] == 7 and request['entityId'] == 1048 and request['entityTypeId'] == 2
    assert request['values']['KpItems'] == [
        {'Name': 'НФГ-6,0-02', 'Coating': 'Горячее цинкование', 'Quantity': '3', 'Price': '2\u00a0109,20', 'Total': '6\u00a0327,60', 'ExecutionTerm': '15 рабочих дней'},
        {'Name': 'ОГК-6', 'Coating': 'Окраска', 'Quantity': '2', 'Price': '3\u00a0665,00', 'Total': '7\u00a0330,00', 'ExecutionTerm': 'до 30.11.2026'},
    ]
    assert money(request['fields']['TotalSum']['VALUE']) == '13657,60'
    for field, value in DOCUMENT_FIELDS.items():
        assert request['fields'][field]['VALUE'] == value
    assert page.evaluate('(index) => JSON.stringify(window.__pilotMock.uploads[index].snapshot)', snapshot_index) == snapshot_before
    assert page.evaluate('window.__pilotMock.setCount') == 2
    passed('document creation uses immutable snapshot prices, terms and template despite changed draft/deal data')

    page.locator('#refreshDocumentBtn').click()
    expect(page.locator('#documentResult')).to_contain_text('Документ #500 готов')
    expect(page.locator('#documentResult a').filter(has_text='Скачать PDF')).to_have_attribute('href', 'https://pilot.bitrix.example/documents/500.pdf')
    assert doc_add_count(page) == 1
    page.locator('#refreshDocumentBtn').click()
    expect(page.locator('#documentResult')).to_contain_text('Документ #500 готов')
    assert doc_add_count(page) == 1
    page.locator('#closeQuoteBtn').click()
    page.reload(wait_until='networkidle')
    page.locator('#variantSelect').select_option(saved_variant)
    expect(page.locator('#docsBody .document-row')).to_have_count(snapshot_index + 2)
    expect(page.locator('#docsBody a').filter(has_text='Скачать PDF')).to_have_attribute('href', 'https://pilot.bitrix.example/documents/500.pdf')
    page.locator('#historyBtn').click()
    page.locator('[data-view-version]').nth(0).click()
    expect(page.locator('#generateDocumentBtn')).to_be_disabled()
    expect(page.locator('#documentResult')).to_contain_text('Документ #500 готов')
    assert doc_add_count(page) == 1
    assert page.evaluate('(index) => JSON.stringify(window.__pilotMock.uploads[index].snapshot)', snapshot_index) == snapshot_before
    passed('PDF polling reuses the same document and generated links survive reload without changing snapshots')

    assert not page.evaluate(r'window.__pilotMock.calls.some(call=>/^catalog\..*(update|delete|add)$/.test(call.method))')
    assert not errors, errors
    assert not live_requests, live_requests
    passed('all mocked integration flows finish without uncaught browser errors or live portal calls')
    browser.close()

print(f'{len(checks)} mocked Bitrix24 browser checks passed.')
