import os
"""Exercise the real UI against a mocked Bitrix24 SDK; never call a live portal.

Run a server on localhost:8080 first, then python tests/browser_bitrix.py.
Requires Playwright and system Chromium, as in browser_smoke.py.
"""
import re
import json
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('YUZM_APP_URL', 'http://127.0.0.1:8080/').rstrip('/') + '/'
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
    responsibleId: 27, creatorId: 99, templateId: '7',
    users: {
      '27': {ID:'27',NAME:'Анна',LAST_NAME:'Соколова',WORK_POSITION:'Менеджер по продажам',WORK_PHONE:'+7 495 111-22-33',PERSONAL_MOBILE:'+7 900 000-00-00'},
      '28': {ID:'28',NAME:'Павел',LAST_NAME:'Иванов',WORK_POSITION:'Ведущий менеджер',WORK_PHONE:'+7 495 444-55-66'},
      '99': {ID:'99',NAME:'Создатель',LAST_NAME:'Сделки',WORK_POSITION:'Администратор',WORK_PHONE:'+7 495 999-99-99'}
    },
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
    isAdmin() { return m.admin !== false; },
    placement: {info() {return {placement:'CRM_DEAL_DETAIL_TAB',options:{ID:'1048'}};}},
    callMethod(method, params, callback) {
      m.calls.push({method,params:structuredClone(params)});
      if (window.__portalOptionsServer && ['app.option.get','app.option.set'].includes(method)) {
        fetch('app-options-mock', {method:'POST', body:JSON.stringify({method,params,admin:m.admin !== false})})
          .then(response => response.json()).then(outcome => callback({error:()=>outcome.error ? {ex:{error:outcome.error}} : false, data:()=>outcome.data}));
        return;
      }
      let data, error;
      switch (method) {
        case 'app.info': data={ID:'99',INSTALLED:true}; break;
        case 'app.option.get': if (m.optionsError) error=m.optionsError; else data=m.templateId ?? null; break;
        case 'app.option.set':
          if (m.failOptionWrite || m.admin === false) error='ACCESS_DENIED';
          else {m.templateId=params.options.yuzmQuoteTemplateId; data=true;}
          break;
        case 'crm.deal.get': data={ID:String(params.id),TITLE:'Пилот КП',COMPANY_ID:1,CURRENCY_ID:'RUB',CATEGORY_ID:0,ASSIGNED_BY_ID:Number(params.id)===1049 ? 28 : m.responsibleId,CREATED_BY_ID:m.creatorId}; break;
        case 'user.get': {
          if (m.profileError) {error=m.profileError; break;}
          const user=m.users[String(params.FILTER.ID)];
          data=user ? [structuredClone(user)] : []; break;
        }
        case 'crm.company.get': data={ID:'1',TITLE:'ООО «Пилот»'}; break;
        case 'crm.deal.productrows.get': data=structuredClone(m.dealRows); break;
        case 'crm.documentgenerator.template.list': data={templates:structuredClone(m.templates)}; break;
        case 'crm.documentgenerator.template.get': {
          const template=m.templates[String(params.id)];
          if (!template) error='NOT_FOUND'; else data={template:structuredClone(template)}; break;
        }
        case 'crm.documentgenerator.document.add': {
          if (params.entityId!==1048 || params.entityTypeId!==2 || params.templateId!==Number(m.templateId)) {error='WRONG_DOCUMENT_TARGET'; break;}
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
        case 'catalog.catalog.list': data={catalogs:[{id:7,iblockId:7,name:'Каталог пилота',productIblockId:0}, ...(m.offers ? [{id:8,iblockId:8,name:'Вариации пилота',productIblockId:7,skuPropertyId:21}] : [])]}; break;
        case 'catalog.product.list':
          if (params.filter.iblockId !== 7) {error='WRONG_CATALOG'; break;}
          data={products:m.products.filter(product=>!params.filter['%name'] || product.name.toLowerCase().includes(params.filter['%name'].toLowerCase()))}; break;
        case 'catalog.product.sku.list':
          data={units:(m.parents || []).filter(parent=>parent.active !== 'N' && (!params.filter['%name'] || parent.name.toLowerCase().includes(params.filter['%name'].toLowerCase())))}; break;
        case 'catalog.product.sku.get': {
          const sku=(m.parents || []).find(parent=>parent.id===Number(params.id));
          if (sku) data={sku}; else error='NOT_FOUND'; break;
        }
        case 'catalog.product.offer.list': {
          if (params.filter.iblockId !== 8) {error='WRONG_VARIATION_CATALOG'; break;}
          const ids=params.filter['@parentId'] || (params.filter.parentId ? [params.filter.parentId] : null);
          data={offers:(m.offers || []).filter(offer=>offer.active !== 'N'
            && (!params.filter['%name'] || offer.name.toLowerCase().includes(params.filter['%name'].toLowerCase()))
            && (!ids || ids.includes(Number(offer.parentId?.value ?? offer.parentId))))}; break;
        }
        case 'catalog.product.offer.get': {
          const offer=(m.offers || []).find(offer=>offer.id===Number(params.id));
          if (offer) data={offer}; else error='NOT_FOUND'; break;
        }
        case 'catalog.product.get': {
          if (m.conflictOnNextProductCheck) {m.dealRows[0].QUANTITY=m.dealRows[0].QUANTITY===999 ? 1000 : 999; m.conflictOnNextProductCheck=false;}
          const product=m.products.find(product=>product.id===Number(params.id));
          if (product) data={product}; else error='NOT_FOUND'; break;
        }
        case 'catalog.priceType.list': data={priceTypes:[{id:1,name:'BASE',base:'Y'}]}; break;
        case 'catalog.price.list':
          if (params.filter.catalogGroupId !== 1) {error='WRONG_PRICE_TYPE'; break;}
          data={prices:[...m.products,...(m.offers || [])].filter(product=>params.filter['@productId'].includes(product.id)).map(product=>({id:product.id,productId:product.id,catalogGroupId:1,price:product.price,currency:'RUB'}))}; break;
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
          if (m.failNextWrite) {m.failNextWrite=false; error='ACCESS_DENIED'; break;}
          m.setCount++;
          m.dealRows=params.productRows.map((row,index)=>({ID:String(100+index),PRODUCT_ID:row.productId,
            PRODUCT_NAME:row.productName,PRICE:row.price,QUANTITY:row.quantity,SORT:row.sort,
            TAX_RATE:row.taxRate,TAX_INCLUDED:row.taxIncluded}));
          if (m.corruptNextReadback) {m.corruptNextReadback=false; m.dealRows[0].QUANTITY+=1;}
          data=true; break;
        default: error='ERROR_METHOD_NOT_FOUND';
      }
      persist();
      const deliver = ()=>callback({
        error:()=>error ? {status:400,ex:{error,error_description:'Mock API error'}} : undefined,
        data:()=>structuredClone(data), more:()=>false
      });
      if (method==='catalog.product.sku.list' && m.catalogDelay) setTimeout(deliver,m.catalogDelay);
      else if (method==='user.get' && m.profileDelay && Number(params.FILTER.ID)===27) setTimeout(deliver,m.profileDelay);
      else queueMicrotask(deliver);
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
    # One portal setting shared by independent manager browsers.
    portal_options = {'id':'7', 'deny_write':False, 'deny_read':False, 'writes':0}
    def shared_context(admin):
        ctx = browser.new_context(viewport={'width':1440,'height':1100}, locale='ru-RU')
        ctx.add_init_script(MOCK + '\nwindow.__portalOptionsServer=true; window.__pilotMock.admin=' + json.dumps(admin) + ';')
        ctx.route('https://api.bitrix24.tech/**', lambda route: route.fulfill(status=200, content_type='application/javascript', body='/* SDK mock */'))
        def options_route(route):
            request = json.loads(route.request.post_data)
            if request['method'] == 'app.option.get':
                outcome = {'error':'ACCESS_DENIED'} if portal_options['deny_read'] else {'data':portal_options['id']}
            elif not request['admin'] or portal_options['deny_write']:
                outcome = {'error':'ACCESS_DENIED'}
            else:
                portal_options['id'] = request['params']['options']['yuzmQuoteTemplateId']
                portal_options['writes'] += 1
                outcome = {'data':True}
            route.fulfill(status=200, content_type='application/json', body=json.dumps(outcome))
        ctx.route(BASE + 'app-options-mock', options_route)
        pg = ctx.new_page()
        pg.goto(BASE, wait_until='networkidle')
        expect(pg.locator('#dealBadge')).to_contain_text('1048')
        return ctx, pg

    admin_ctx, admin_page = shared_context(True)
    expect(admin_page.locator('#templateSummary')).to_contain_text('#7')
    admin_page.locator('#settingsBtn').click()
    admin_page.locator('#defaultDocumentTemplateId').select_option('8')
    admin_page.locator('#closeSettingsBtn').click()
    expect(admin_page.locator('#templateSummary')).to_contain_text('#7')
    assert portal_options['writes'] == 0
    admin_page.locator('#settingsBtn').click()
    expect(admin_page.locator('#defaultDocumentTemplateId')).to_have_value('7')
    admin_page.locator('#defaultDocumentTemplateId').select_option('8')
    admin_page.locator('#settingsForm button[type=submit]').click()
    expect(admin_page.locator('#settingsDialog')).not_to_be_visible()
    assert portal_options['id'] == '8' and portal_options['writes'] == 1
    expect(admin_page.locator('#createQuoteBtn')).to_be_enabled()
    passed('admin saves one portal template; closing settings without saving keeps the previous choice')

    manager_ctx, manager_page = shared_context(False)
    expect(manager_page.locator('#templateSummary')).to_contain_text('#8')
    manager_page.locator('#settingsBtn').click()
    expect(manager_page.locator('#defaultDocumentTemplateId')).to_have_value('8')
    expect(manager_page.locator('#defaultDocumentTemplateId')).to_be_disabled()
    manager_page.locator('#closeSettingsBtn').click()
    # Old browser-only defaults and draft overrides cannot replace the shared setting.
    manager_page.evaluate("""() => {
      const store='yuzm-kp-prototype-v1', scope=store+'-bitrix-pilot.bitrix.example-deal-1048';
      const local=JSON.parse(localStorage.getItem(scope));
      local.state.settings.defaultDocumentTemplateId='9';
      local.state.variants.forEach(variant=>variant.draft.documentTemplateId='9');
      localStorage.setItem(scope,JSON.stringify(local));
      localStorage.setItem(store+'-settings',JSON.stringify({...local.state.settings,defaultDocumentTemplateId:'9'}));
    }""")
    manager_page.reload(wait_until='networkidle')
    expect(manager_page.locator('#templateSummary')).to_contain_text('#8')
    passed('a second manager browser reads the same template and ignores legacy local overrides')

    admin_page.locator('#settingsBtn').click()
    admin_page.locator('#defaultDocumentTemplateId').select_option('7')
    portal_options['deny_write'] = True
    admin_page.locator('#settingsForm button[type=submit]').click()
    expect(admin_page.locator('#settingsError')).to_contain_text('ACCESS_DENIED')
    expect(admin_page.locator('#settingsDialog')).to_be_visible()
    expect(admin_page.locator('#templateSummary')).to_contain_text('#8')
    assert portal_options['id'] == '8' and portal_options['writes'] == 1
    passed('failed portal saving does not claim success or replace the common template locally')
    portal_options['deny_write'] = False
    admin_page.locator('#closeSettingsBtn').click()
    manager_page.locator('#createQuoteBtn').click()
    expect(manager_page.locator('#quoteDialog')).to_be_visible()
    portal_options['deny_read'] = True
    manager_page.locator('#generateDocumentBtn').click()
    expect(manager_page.locator('#status')).to_contain_text('app.option.get')
    expect(manager_page.locator('#status')).to_contain_text('ACCESS_DENIED')
    assert manager_page.evaluate('window.__pilotMock.setCount') == 0
    assert doc_add_count(manager_page) == 0
    expect(manager_page.locator('#generateDocumentBtn')).to_be_disabled()
    passed('fresh portal-option read failure blocks CRM and document writes instead of using a stale browser template')
    portal_options['deny_read'] = False
    manager_page.locator('#closeQuoteBtn').click()
    manager_page.locator('#settingsBtn').click()
    manager_page.locator('#refreshTemplatesBtn').click()
    expect(manager_page.locator('#defaultDocumentTemplateId')).to_have_value('8')
    expect(manager_page.locator('#defaultDocumentTemplateId')).to_be_disabled()
    manager_page.locator('#closeSettingsBtn').click()
    admin_ctx.close()
    manager_ctx.close()

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
    expect(page.locator('#defaultDocumentTemplateId option[value="7"]')).to_have_text('КП ЮЗМ — действующий шаблон · #7')
    expect(page.locator('#defaultDocumentTemplateId option[value="8"]')).to_have_count(1)
    expect(page.locator('#defaultDocumentTemplateId option[value="9"]')).to_have_count(0)
    assert doc_add_count(page) == 0
    passed('placement opens negotiated prices and registered templates without CRM/document writes')
    expect(page.locator('#YuzmManagerName')).to_have_value('Анна Соколова')
    expect(page.locator('#YuzmManagerPosition')).to_have_value('Менеджер по продажам')
    expect(page.locator('#YuzmManagerPhone')).to_have_value('+7 495 111-22-33')
    request = page.evaluate("window.__pilotMock.calls.find(call => call.method==='user.get').params")
    assert request['FILTER'] == {'ID': 27}
    assert request['select'] == ['ID', 'NAME', 'LAST_NAME', 'WORK_POSITION', 'WORK_PHONE']
    passed('signature automatically uses the responsible employee and work phone, never the creator')

    page.locator('#settingsBtn').click()
    page.locator('#pricesFileId').fill('11')
    page.locator('#metalPricesFileId').fill('12')
    page.locator('#historyFolderId').fill('42')
    page.locator('#defaultDocumentTemplateId').select_option('8')
    page.locator('#roundingMode').select_option('unit')
    page.locator('#loadRemoteBtn').click()
    expect(page.locator('#settingsError')).to_contain_text('загружены и проверены')
    page.locator('#loadMetalPricesBtn').click()
    expect(page.locator('#settingsError')).to_contain_text('Цены металла загружены с Диска')
    expect(page.locator('#metalPricesSummary')).to_contain_text('2 цен')
    expect(page.locator('#metalPricesSummary')).to_contain_text('файл #12')
    page.locator('#defaultDocumentTemplateId').select_option('8')
    page.locator('#settingsForm button[type=submit]').click()
    expect(page.locator('#settingsDialog')).not_to_be_visible()
    expect(page.locator('#templateSummary')).to_contain_text('#8')
    expect(page.locator('#relationsBody, #relationsSummary, #localRelationsInput, #relationsFileId, [data-field=drawingId], [data-file-id]')).to_have_count(0)
    expect(page.locator('#docsBody .document-row')).to_have_count(0)
    assert not page.evaluate("window.__pilotMock.calls.some(call => call.method==='disk.file.get' && Number(call.params.id)===10)")
    passed('separate JSON sources load and the registered common template saves to portal settings')
    expect(page.locator('[data-field=coatingCode] option[value=zinc_paint]')).to_have_count(1)
    passed('older Disk coating lists gain the combined zinc and RAL painting option')

    page.locator('.item-row [data-action=choose-product]').click()
    expect(page.locator('#productResults')).to_contain_text('Введите название или ID')
    page.locator('#productQuery').fill('Г')
    page.locator('#productSearchBtn').click()
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
    page.locator('#productQuery').fill('Г')
    page.locator('#productSearchBtn').click()
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
    second.locator('[data-field=ralColor]').fill('9005')
    first.locator('[data-field=coatingCode]').select_option('zinc_paint')
    first.locator('[data-field=ralColor]').fill('RAL 7035 матовый')
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
    page.locator('#settingsBtn').click()
    page.locator('#defaultDocumentTemplateId').select_option('7')
    page.locator('#settingsForm button[type=submit]').click()
    expect(page.locator('#settingsDialog')).not_to_be_visible()
    uploads_before_preview = page.evaluate('window.__pilotMock.uploads.length')
    page.locator('#createQuoteBtn').click()
    expect(page.locator('#quoteDialog')).to_be_visible()
    expect(page.locator('#quotePreview tbody tr')).to_have_count(2)
    expect(page.locator('#quotePreview tbody tr').nth(0)).to_contain_text('15 рабочих дней')
    expect(page.locator('#quotePreview tbody tr').nth(1)).to_contain_text('до 30.11.2026')
    expect(page.locator('#quotePreview tbody tr').nth(0)).to_contain_text('Горячее цинкование + окрашивание RAL 7035 матовый')
    expect(page.locator('#quotePreview tbody tr').nth(1)).to_contain_text('Окраска RAL 9005')
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
    # Another administrator changes the portal template while this manager's tab remains open.
    page.evaluate("window.__pilotMock.templateId='8'")
    expect(page.locator('#templateSummary')).to_contain_text('#7')
    page.locator('#historyBtn').click()
    page.locator('[data-view-version]').nth(0).click()
    assert money(page.locator('.quote-total').inner_text().replace('Итого:', '')) == '13657,60'
    expect(page.locator('#generateDocumentBtn')).to_be_enabled()
    # Every failure must stop before document.add; a retry keeps this saved KP.
    page.evaluate('window.__pilotMock.failNextWrite=true')
    page.locator('#generateDocumentBtn').click()
    expect(page.locator('#status')).to_contain_text('ACCESS_DENIED')
    assert doc_add_count(page) == 0
    assert page.evaluate('window.__pilotMock.setCount') == 2
    passed('denied mandatory transfer blocks document creation')
    page.evaluate('window.__pilotMock.conflictOnNextProductCheck=true')
    page.locator('#generateDocumentBtn').click()
    expect(page.locator('#status')).to_contain_text('изменились после предварительного просмотра')
    assert doc_add_count(page) == 0
    assert page.evaluate('window.__pilotMock.setCount') == 2
    passed('concurrent CRM changes block document creation before replacement')
    page.evaluate('window.__pilotMock.corruptNextReadback=true')
    page.locator('#generateDocumentBtn').click()
    expect(page.locator('#status')).to_contain_text('Запись выполнена, но состав или цены')
    assert doc_add_count(page) == 0
    assert page.evaluate('window.__pilotMock.setCount') == 3
    passed('unverified mandatory transfer blocks document creation without automatic retry')
    page.locator('#generateDocumentBtn').click()
    expect(page.locator('#documentResult')).to_contain_text('Документ #500 создан')
    expect(page.locator('#documentResult a').filter(has_text='Скачать DOCX')).to_have_attribute('href', 'https://pilot.bitrix.example/documents/500.docx')
    expect(page.locator('#documentResult a').filter(has_text='Скачать PDF')).to_have_count(0)
    expect(page.locator('#generateDocumentBtn')).to_be_disabled()
    assert doc_add_count(page) == 1
    request = page.evaluate("window.__pilotMock.calls.find(call=>call.method==='crm.documentgenerator.document.add').params")
    assert request['templateId'] == 8 and request['entityId'] == 1048 and request['entityTypeId'] == 2
    assert request['values']['KpItems'] == [
        {'Name': 'НФГ-6,0-02', 'Coating': 'Горячее цинкование + окрашивание RAL 7035 матовый', 'Quantity': '3', 'Price': '2\u00a0109,20', 'Total': '6\u00a0327,60', 'ExecutionTerm': '15 рабочих дней'},
        {'Name': 'ОГК-6', 'Coating': 'Окраска RAL 9005', 'Quantity': '2', 'Price': '3\u00a0665,00', 'Total': '7\u00a0330,00', 'ExecutionTerm': 'до 30.11.2026'},
    ]
    assert money(request['fields']['TotalSum']['VALUE']) == '13657,60'
    for field, value in DOCUMENT_FIELDS.items():
        assert request['fields'][field]['VALUE'] == (value + ' ' if field == 'YuzmManagerPosition' else value)
    assert page.evaluate('(index) => JSON.stringify(window.__pilotMock.uploads[index].snapshot)', snapshot_index) == snapshot_before
    assert page.evaluate('window.__pilotMock.setCount') == 4
    assert page.evaluate('window.__pilotMock.dealRows.map(row => [row.PRODUCT_ID, row.PRICE, row.QUANTITY])') == [[201, 2109.2, 3], [202, 3665, 2]]
    methods = page.evaluate('window.__pilotMock.calls.map(call => call.method)')
    assert max(i for i, method in enumerate(methods) if method=='crm.deal.productrows.get') < methods.index('crm.documentgenerator.document.add')
    expect(page.locator('#templateSummary')).to_contain_text('#8')
    passed('generation re-reads the current common template while preserving all saved prices, RAL, terms and signature')

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

    page.locator('#closeQuoteBtn').click()
    page.locator('#settingsBtn').click()
    page.locator('#defaultDocumentTemplateId').select_option('7')
    page.locator('#settingsForm button[type=submit]').click()
    expect(page.locator('#settingsDialog')).not_to_be_visible()
    page.locator('#historyBtn').click()
    page.locator('[data-view-version]').nth(0).click()
    expect(page.locator('#generateDocumentBtn')).to_be_enabled()
    page.locator('#generateDocumentBtn').click()
    expect(page.locator('#documentResult')).to_contain_text('Документ #501 создан')
    assert doc_add_count(page) == 2
    assert page.evaluate("window.__pilotMock.documents['500'].templateId") == 8
    assert page.evaluate("window.__pilotMock.documents['501'].templateId") == 7
    assert page.evaluate("window.__pilotMock.documents['500'].pdfUrl") == 'https://pilot.bitrix.example/documents/500.pdf'
    assert page.evaluate('(index) => JSON.stringify(window.__pilotMock.uploads[index].snapshot)', snapshot_index) == snapshot_before
    expect(page.locator('#docsBody a').filter(has_text='Скачать DOCX')).to_have_count(2)
    passed('a changed common template can generate a new document from the same version while keeping previous documents and snapshots')

    assert not page.evaluate(r'window.__pilotMock.calls.some(call=>/^catalog\..*(update|delete|add)$/.test(call.method))')
    assert not errors, errors
    assert not live_requests, live_requests
    passed('all mocked integration flows finish without uncaught browser errors or live portal calls')
    variation_ctx = browser.new_context(viewport={'width':1440,'height':1100}, locale='ru-RU')
    variation_ctx.add_init_script(MOCK + r"""
      window.__pilotMock.parents=[{id:301,iblockId:7,name:'Опора серии VAR',type:3,active:'Y'}];
      window.__pilotMock.offers=[
        {id:311,iblockId:8,name:'Модель 100',type:4,active:'Y',parentId:{value:'301',valueId:'123'},price:500},
        {id:312,iblockId:8,name:'Модель 200',type:4,active:'Y',parentId:301,price:900},
        {id:313,iblockId:8,name:'Архивная модель',type:4,active:'N',parentId:301,price:999}
      ];
      Object.assign(window.__pilotMock.files['12'].data.prices_per_kg,{'301':999,'311':150,'312':200});
    """)
    variation_ctx.route('https://api.bitrix24.tech/**', lambda route: route.fulfill(status=200,content_type='application/javascript',body='/* SDK mock */'))
    vp = variation_ctx.new_page()
    vp.on('pageerror',lambda error: errors.append(str(error)))
    vp.goto(BASE,wait_until='networkidle')
    expect(vp.locator('#dealBadge')).to_contain_text('1048')
    vp.locator('#addItemBtn').click()
    expect(vp.locator('#productResults')).to_contain_text('Введите название или ID')
    assert not vp.evaluate("window.__pilotMock.calls.some(call=>call.method==='catalog.catalog.list')")
    vp.locator('#productQuery').fill('Опора серии VAR')
    vp.locator('#productSearchBtn').click()
    expect(vp.locator('#productResults .catalog-result')).to_have_count(2)
    expect(vp.locator('#productResults')).to_contain_text('Модель 100 · вариация #311')
    expect(vp.locator('#productResults')).not_to_contain_text('Архивная модель')
    assert vp.locator('#productResults .catalog-result').evaluate_all("nodes=>nodes.map(node=>JSON.parse(node.dataset.product).id)") == ['311','312']
    passed('parent-name search finds active variations whose own names differ and labels them separately')
    vp.locator('#productQuery').fill('301')
    vp.locator('#productSearchBtn').click()
    expect(vp.locator('#productResults .catalog-result')).to_have_count(2)
    vp.evaluate('window.__pilotMock.catalogDelay=800')
    vp.locator('#productQuery').fill('Опора серии VAR')
    vp.locator('#productSearchBtn').click()
    vp.wait_for_function("window.__pilotMock.calls.at(-1).method==='catalog.product.sku.list'")
    vp.locator('#productQuery').fill('311')
    vp.locator('#productSearchBtn').click()
    expect(vp.locator('#productResults .catalog-result')).to_have_count(1)
    expect(vp.locator('#productResults')).to_contain_text('Модель 100')
    vp.wait_for_timeout(1000)
    expect(vp.locator('#productResults .catalog-result')).to_have_count(1)
    vp.evaluate('window.__pilotMock.catalogDelay=0')
    passed('parent ID expands to variations, exact variation ID stays exact and late searches cannot overwrite it')
    vp.locator('#productResults .catalog-result').click()
    expect(vp.locator('.item-row')).to_have_count(2)
    vp.locator('.item-row').first.locator('[data-action=remove]').click()
    vr = vp.locator('.item-row').first
    expect(vr.locator('[data-field=productId]')).to_have_value('311')
    expect(vr.locator('.base-price')).to_have_text(re.compile('500'))
    vr.locator('[data-field=quantity]').fill('2')
    vr.locator('[data-field=k1]').fill('1,2')
    vr.locator('[data-field=k2]').fill('1,1')
    vr.locator('[data-field=k3]').fill('1,05')
    vr.locator('[data-field=executionTerm]').fill('15 рабочих дней')
    assert money(vp.locator('#grandTotal').inner_text()) == '1386,00'
    vp.locator('#createQuoteBtn').click()
    expect(vp.locator('#quotePreview tbody tr')).to_have_count(1)
    expect(vp.locator('#quotePreview tbody tr')).to_contain_text('Модель 100')
    expect(vp.locator('#quotePreview')).not_to_contain_text('вариация #311')
    vp.locator('#generateDocumentBtn').click()
    expect(vp.locator('#documentResult')).to_contain_text('Документ #500 создан')
    assert vp.evaluate('window.__pilotMock.dealRows.map(row=>[row.PRODUCT_ID,row.PRICE,row.QUANTITY])') == [[311,693,2]]
    req = vp.evaluate("window.__pilotMock.calls.find(call=>call.method==='crm.documentgenerator.document.add').params")
    assert req['values']['KpItems'][0]['Name'] == 'Модель 100'
    assert money(req['values']['KpItems'][0]['Total']) == '1386,00'
    saved_variation = vp.evaluate("JSON.parse(localStorage.getItem('yuzm-kp-prototype-v1-bitrix-pilot.bitrix.example-deal-1048')).state.variants[0].versions[0]")
    assert saved_variation['rows'][0]['productId'] == '311'
    assert saved_variation['rows'][0]['parentProductId'] == '301'
    assert saved_variation['rows'][0]['isVariation'] and saved_variation['rows'][0]['basePrice'] == 500
    passed('selected variation uses its own base price and ID in calculation, mandatory CRM transfer and document rows')
    vp.locator('#closeQuoteBtn').click()
    vp.reload(wait_until='networkidle')
    vr = vp.locator('.item-row').first
    expect(vr.locator('[data-field=productId]')).to_have_value('311')
    expect(vr.locator('[data-field=productId] option:checked')).to_contain_text('вариация #311')
    assert money(vp.locator('#grandTotal').inner_text()) == '1386,00'
    passed('variation identity, name and price survive reload without replacing saved quote data')
    vp.locator('#settingsBtn').click()
    vp.locator('#formulaMode').select_option('excel')
    vp.locator('#metalPricesFileId').fill('12')
    vp.locator('#loadMetalPricesBtn').click()
    expect(vp.locator('#settingsError')).to_contain_text('Цены металла загружены с Диска')
    vp.locator('#closeSettingsBtn').click()
    vr = vp.locator('.item-row').first
    expect(vr.locator('[data-field=pricePerKg]')).to_have_value('150')
    vr.locator('[data-field=weight]').fill('2')
    vr.locator('[data-field=fasteners]').fill('10')
    assert money(vp.locator('#grandTotal').inner_text()) == '851,60'
    vp.locator('#addItemBtn').click()
    vp.locator('#productQuery').fill('312')
    vp.locator('#productSearchBtn').click()
    expect(vp.locator('#productResults .catalog-result')).to_have_count(1)
    vp.locator('#productResults .catalog-result').click()
    expect(vp.locator('.item-row').last.locator('[data-field=pricePerKg]')).to_have_value('200')
    vp.locator('.item-row').last.locator('[data-field=weight]').fill('3')
    vp.locator('.item-row').last.locator('[data-field=fasteners]').fill('20')
    assert money(vp.locator('#grandTotal').inner_text()) == '1471,60'
    passed('Excel loads metal prices by variation ID and applies all three coefficients without using the parent metal price')
    # A parent metal price cannot cover a missing rate for a concrete variation.
    vp.evaluate("delete window.__pilotMock.files['12'].data.prices_per_kg['312']")
    vp.locator('#settingsBtn').click()
    vp.locator('#loadMetalPricesBtn').click()
    expect(vp.locator('#settingsError')).to_contain_text('Цены металла загружены с Диска')
    vp.locator('#closeSettingsBtn').click()
    expect(vp.locator('.item-row').last.locator('[data-field=pricePerKg]')).to_have_value('')
    expect(vp.locator('#saveBtn')).to_be_disabled()
    assert vp.evaluate("JSON.parse(localStorage.getItem('yuzm-kp-prototype-v1-bitrix-pilot.bitrix.example-deal-1048')).state.variants[0].versions[0]") == saved_variation
    passed('missing variation metal price blocks Excel even when the parent rate exists and keeps the saved catalog version exact')
    variation_ctx.close()

    # Isolated signature scenarios keep the main integration history unchanged.
    manager_context = browser.new_context(viewport={'width':1440,'height':1100}, locale='ru-RU')
    manager_context.add_init_script(MOCK)
    manager_page = manager_context.new_page()
    manager_page.on('pageerror', lambda error: errors.append(str(error)))
    manager_page.goto(BASE, wait_until='networkidle')
    expect(manager_page.locator('#YuzmManagerName')).to_have_value('Анна Соколова')
    manager_page.locator('.manager-details summary').click()
    manager_page.locator('#YuzmManagerPhone').fill('Телефон для этого КП')
    manager_page.locator('#YuzmManagerPosition').fill('')
    manager_page.evaluate("""() => {const m=window.__pilotMock; m.responsibleId=28;
      sessionStorage.setItem('__pilot_mock_server',JSON.stringify(m));}""")
    manager_page.reload(wait_until='networkidle')
    expect(manager_page.locator('#YuzmManagerName')).to_have_value('Павел Иванов')
    expect(manager_page.locator('#YuzmManagerPhone')).to_have_value('Телефон для этого КП')
    expect(manager_page.locator('#YuzmManagerPosition')).to_have_value('')
    passed('responsible changes update automatic fields while manual phone and intentional blank survive reload')

    manager_page.locator('.manager-details summary').click()
    manager_page.locator('#fillManagerBtn').click()
    expect(manager_page.locator('#YuzmManagerPosition')).to_have_value('Ведущий менеджер')
    expect(manager_page.locator('#YuzmManagerPhone')).to_have_value('+7 495 444-55-66')
    manager_page.locator('#newVariantBtn').click()
    expect(manager_page.locator('#YuzmManagerName')).to_have_value('Павел Иванов')
    expect(manager_page.locator('#YuzmManagerPhone')).to_have_value('+7 495 444-55-66')
    manager_page.locator('#duplicateVariantBtn').click()
    manager_page.locator('#YuzmManagerName').fill('Имя только для копии')
    manager_page.locator('#variantSelect').select_option(index=1)
    expect(manager_page.locator('#YuzmManagerName')).to_have_value('Павел Иванов')
    manager_page.locator('#variantSelect').select_option(index=0)
    passed('profile button replaces manual signature, new variants autofill and duplicates remain independent')

    manager_page.locator('#saveBtn').click()
    expect(manager_page.locator('#status')).to_contain_text('Сохранена версия 1')
    archive = manager_page.evaluate("JSON.stringify(JSON.parse(localStorage.getItem('yuzm-kp-prototype-v1-bitrix-pilot.bitrix.example-deal-1048')).state.variants[0].versions[0])")
    manager_page.evaluate("""() => {const m=window.__pilotMock; m.users['28'].NAME='Новое имя';
      m.users['28'].WORK_PHONE=''; m.users['28'].PERSONAL_MOBILE='+7 900 777-77-77';
      sessionStorage.setItem('__pilot_mock_server',JSON.stringify(m));}""")
    manager_page.reload(wait_until='networkidle')
    expect(manager_page.locator('#YuzmManagerPhone')).to_have_value('')
    expect(manager_page.locator('#managerProfileHint')).to_contain_text('заполните его вручную')
    manager_page.locator('#historyBtn').click()
    manager_page.locator('[data-view-version]').click()
    expect(manager_page.locator('#quotePreview')).to_contain_text('Павел Иванов')
    expect(manager_page.locator('#quotePreview')).to_contain_text('+7 495 444-55-66')
    assert manager_page.evaluate("JSON.stringify(JSON.parse(localStorage.getItem('yuzm-kp-prototype-v1-bitrix-pilot.bitrix.example-deal-1048')).state.variants[0].versions[0])") == archive
    manager_page.locator('#closeQuoteBtn').click()
    passed('empty work phone stays empty despite mobile number, and saved signatures do not change with the profile')

    manager_page.locator('.manager-details summary').click()
    manager_page.locator('#YuzmManagerPhone').fill('Рабочий номер, введённый вручную')
    manager_page.evaluate("""() => {const m=window.__pilotMock; m.profileError='insufficient_scope';
      sessionStorage.setItem('__pilot_mock_server',JSON.stringify(m));}""")
    manager_page.reload(wait_until='networkidle')
    expect(manager_page.locator('#connectionBadge')).to_contain_text('подключён')
    expect(manager_page.locator('#managerProfileHint')).to_contain_text('user_basic')
    expect(manager_page.locator('#YuzmManagerPhone')).to_have_value('Рабочий номер, введённый вручную')
    expect(manager_page.locator('#saveBtn')).to_be_enabled()
    passed('profile scope errors do not break CRM connection or manual signature and show the required permission')

    manager_page.evaluate("""() => {const m=window.__pilotMock; delete m.profileError; delete m.users['28'].WORK_PHONE;
      sessionStorage.setItem('__pilot_mock_server',JSON.stringify(m));}""")
    manager_page.reload(wait_until='networkidle')
    manager_page.locator('.manager-details summary').click()
    manager_page.locator('#fillManagerBtn').click()
    expect(manager_page.locator('#managerProfileHint')).to_contain_text('user_basic')
    expect(manager_page.locator('#YuzmManagerName')).to_have_value('Новое имя Иванов')
    expect(manager_page.locator('#YuzmManagerPhone')).to_have_value('')
    passed('omitted phone field is distinguished from an empty phone and never replaced by personal mobile')
    manager_context.close()

    delay_context = browser.new_context(viewport={'width':1440,'height':1100}, locale='ru-RU')
    delay_context.add_init_script(MOCK + '\nwindow.__pilotMock.profileDelay=1800;')
    delay_page = delay_context.new_page()
    delay_page.on('pageerror', lambda error: errors.append(str(error)))
    delay_page.goto(BASE, wait_until='networkidle')
    delay_page.locator('.manager-details summary').click()
    delay_page.locator('#YuzmManagerName').fill('Ручная правка во время загрузки')
    expect(delay_page.locator('#saveBtn')).to_be_disabled()
    expect(delay_page.locator('#YuzmManagerPosition')).to_have_value('Менеджер по продажам')
    expect(delay_page.locator('#YuzmManagerName')).to_have_value('Ручная правка во время загрузки')
    expect(delay_page.locator('#saveBtn')).to_be_enabled()
    passed('late profile response preserves edits made during loading and save waits for autofill')
    delay_context.close()

    switch_context = browser.new_context(viewport={'width':1440,'height':1100}, locale='ru-RU')
    switch_context.add_init_script(MOCK + '\nwindow.__pilotMock.profileDelay=1800;')
    switch_page = switch_context.new_page()
    switch_page.on('pageerror', lambda error: errors.append(str(error)))
    switch_page.goto(BASE, wait_until='networkidle')
    switch_page.locator('#settingsBtn').click()
    switch_page.locator('#dealIdInput').fill('1049')
    switch_page.locator('#connectDealBtn').click()
    expect(switch_page.locator('#YuzmManagerName')).to_have_value('Павел Иванов')
    switch_page.locator('#closeSettingsBtn').click()
    # Read back the original request's completion without a blocking sleep.
    expect(switch_page.locator('#fillManagerBtn')).to_be_enabled()
    switch_page.wait_for_timeout(2000)
    expect(switch_page.locator('#dealBadge')).to_contain_text('1049')
    expect(switch_page.locator('#YuzmManagerName')).to_have_value('Павел Иванов')
    passed('late previous-deal profile responses cannot replace the new deal signature')
    switch_context.close()

    reset_context = browser.new_context(viewport={'width':1440,'height':1100}, locale='ru-RU')
    reset_context.add_init_script(MOCK + '\nwindow.__pilotMock.profileDelay=1800;')
    reset_page = reset_context.new_page()
    reset_page.on('pageerror', lambda error: errors.append(str(error)))
    reset_page.on('dialog', lambda dialog: dialog.accept())
    reset_page.goto(BASE, wait_until='networkidle')
    reset_page.locator('#settingsBtn').click()
    reset_page.locator('#resetDemoBtn').click()
    expect(reset_page.locator('#dealBadge')).to_have_text('ПИЛОТ')
    expect(reset_page.locator('#saveBtn')).to_be_enabled()
    reset_page.wait_for_timeout(2000)
    expect(reset_page.locator('#YuzmManagerName')).to_have_value('')
    expect(reset_page.locator('#saveBtn')).to_be_enabled()
    passed('switching to demo cancels pending profile fill without blocking saves or leaking the previous signature')
    reset_context.close()
    assert not errors, errors
    browser.close()

print(f'{len(checks)} mocked Bitrix24 browser checks passed.')
