"""Mock Bitrix24 integration through the actual browser UI; no live portal calls.

Run a server on localhost:8080 first, then python tests/browser_bitrix.py.
Requires Playwright and system Chromium, as in browser_smoke.py.
"""
from playwright.sync_api import sync_playwright, expect

BASE = 'http://127.0.0.1:8080/'
checks = []

MOCK = r"""
(() => {
  const persisted = sessionStorage.getItem('__pilot_mock_server');
  const m = window.__pilotMock = persisted ? JSON.parse(persisted) : {
    calls: [], setCount: 0, uploads: [], nextFileId: 1000,
    products: [
      {id:201, iblockId:7, name:'НФГ-6,0-02', type:1, price:38600},
      {id:202, iblockId:7, name:'ОГК-6', type:1, price:29000}
    ],
    dealRows: [{ID:'900', PRODUCT_ID:201, PRODUCT_NAME:'НФГ-6,0-02', PRICE:100,
      QUANTITY:2, SORT:10, TAX_RATE:20, TAX_INCLUDED:'Y'}],
    files: {
      '10': {name:'relations.json', data:{version:'pilot-relations',
        product_drawings:[{product_id:'201', product_name:'НФГ-6,0-02', drawing_id:'nfg-a', drawing_name:'НФГ-6,0 — пилот', drawing_file_id:'501'}],
        drawing_kd:[{drawing_id:'nfg-a', kit_id:'kit-a', kit_name:'Комплект КД', file_id:'502', file_name:'КД.pdf'}]}},
      '11': {name:'coatings.json', data:{version:'pilot-coatings', currency:'RUB',
        coatings:[{code:'none',name:'Без покрытия',coefficient:1}, {code:'zinc',name:'Горячее цинкование',coefficient:1.18}, {code:'paint',name:'Окраска',coefficient:1.12}],
        formulaMode:'catalog', rounding:'unit'}}
    }
  };
  const persist = () => sessionStorage.setItem('__pilot_mock_server', JSON.stringify(m));
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, options) => {
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
        case 'crm.deal.get': data={ID:'1048',TITLE:'Пилот КП',COMPANY_ID:1,CURRENCY_ID:'RUB'}; break;
        case 'crm.company.get': data={ID:'1',TITLE:'ООО «Пилот»'}; break;
        case 'crm.deal.productrows.get': data=structuredClone(m.dealRows); break;
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


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1440, 'height': 1100}, locale='ru-RU')
    context.add_init_script(MOCK)
    context.route('https://api.bitrix24.tech/**', lambda route: route.fulfill(status=200, content_type='application/javascript', body='/* mock SDK already injected */'))
    # Block any accidentally unmocked portal/network request.
    context.route('https://pilot.bitrix.example/**', lambda route: route.abort())
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
    passed('placement deal opens with negotiated prices; startup never writes CRM')

    page.locator('#settingsBtn').click()
    page.locator('#relationsFileId').fill('10')
    page.locator('#pricesFileId').fill('11')
    page.locator('#historyFolderId').fill('42')
    page.locator('#roundingMode').select_option('unit')
    page.locator('#loadRemoteBtn').click()
    expect(page.locator('#settingsError')).to_contain_text('загружены и проверены')
    page.locator('#closeSettingsBtn').click()
    expect(page.locator('.item-row [data-field=drawingId]')).to_have_value('nfg-a')
    expect(page.locator('#docsBody .document-row')).to_have_count(2)
    passed('Disk config and product → drawing → KD links load through authenticated JSON fetch')

    page.locator('.item-row [data-action=choose-product]').click()
    expect(page.locator('#productResults .catalog-result')).to_have_count(2)
    page.locator('#productResults .catalog-result').filter(has_text='НФГ-6,0-02').click()
    expect(page.locator('.item-row [data-field=quantity]')).to_have_value('2')
    assert money(page.locator('#grandTotal').inner_text()) == '77200,00'
    page.locator('.item-row [data-field=quantity]').fill('3')
    page.locator('.item-row [data-field=coatingCode]').select_option('zinc')
    assert money(page.locator('#grandTotal').inner_text()) == '136644,00'
    passed('catalog selection replaces negotiated price with actual BASE price and recalculates coating')

    page.locator('#saveBtn').click()
    expect(page.locator('#status')).to_contain_text('Сохранена версия 1')
    expect(page.locator('#status')).to_contain_text('на Диске')
    assert page.evaluate('window.__pilotMock.uploads.length') == 1
    page.locator('#historyBtn').click()
    expect(page.locator('.history-row')).to_have_count(1)
    expect(page.locator('.history-row')).to_contain_text('Диск Bitrix24')
    page.locator('[data-view-version]').click()
    assert money(page.locator('.quote-total').inner_text().replace('Итого:', '')) == '136644,00'
    page.locator('#closeQuoteBtn').click()
    passed('save uploads an immutable UTF-8 snapshot and readback confirms shared history')

    page.locator('#applyDealBtn').click()
    expect(page.locator('#status')).to_contain_text('записан в сделку #1048')
    assert page.evaluate('window.__pilotMock.setCount') == 1
    assert page.evaluate('window.__pilotMock.dealRows.length') == 1
    assert page.evaluate('window.__pilotMock.dealRows[0].PRICE') == 45548
    assert page.evaluate('window.__pilotMock.dealRows[0].QUANTITY') == 3
    assert page.evaluate('window.__pilotMock.dealRows[0].TAX_RATE') == 20
    assert page.evaluate('window.__pilotMock.dealRows[0].TAX_INCLUDED') == 'Y'
    passed('confirmed application replaces the full deal row set, verifies readback and preserves VAT')

    page.locator('#applyDealBtn').click()
    expect(page.locator('#status')).to_contain_text('записан в сделку #1048')
    assert page.evaluate('window.__pilotMock.setCount') == 2
    assert page.evaluate('window.__pilotMock.dealRows.length') == 1
    assert page.evaluate('window.__pilotMock.uploads.length') == 3
    assert page.evaluate('new Set(window.__pilotMock.uploads.map(file=>file.name)).size') == 3
    assert not page.evaluate(r'window.__pilotMock.calls.some(call=>call.method.endsWith(".add") || /^catalog\..*(update|delete|add)$/.test(call.method))')
    passed('repeated application creates versions without appending duplicate CRM products or editing catalog')

    # Delete only the app's per-deal browser cache: shared history must rebuild its variants.
    page.evaluate("localStorage.removeItem('yuzm-kp-prototype-v1-bitrix-pilot.bitrix.example-deal-1048')")
    page.reload(wait_until='networkidle')
    expect(page.locator('#dealBadge')).to_contain_text('1048')
    expect(page.locator('#variantSelect option')).to_have_count(2)
    saved_variant = page.evaluate('window.__pilotMock.uploads[0].snapshot.variantId')
    page.locator('#variantSelect').select_option(saved_variant)
    expect(page.locator('.item-row [data-field=drawingId]')).to_have_value('nfg-a')
    assert money(page.locator('#grandTotal').inner_text()) == '136644,00'
    page.locator('#historyBtn').click()
    expect(page.locator('.history-row')).to_have_count(3)
    page.locator('#closeHistoryBtn').click()
    passed('shared Disk history rebuilds saved variants with their own reference/calculation context')

    # A concurrent manager changes quantity after preview but before the adapter's final check.
    page.evaluate('window.__pilotMock.conflictOnNextProductCheck=true')
    page.locator('#applyDealBtn').click()
    expect(page.locator('#status')).to_contain_text('изменились после предварительного просмотра')
    assert page.evaluate('window.__pilotMock.setCount') == 2
    assert page.evaluate('window.__pilotMock.dealRows[0].QUANTITY') == 999
    passed('concurrent deal edit blocks replacement before any CRM write')

    assert not errors, errors
    passed('mock portal workflow produces no uncaught browser errors or live portal calls')
    browser.close()

print(f'{len(checks)} mocked Bitrix24 browser checks passed.')
