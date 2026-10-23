"""Chromium acceptance checks against a local app with a mocked BX24 transport.
Start HTTP at 127.0.0.1:8080 in versions/2.7.0, then run this script.
Requires Python Playwright and Chromium. Never calls the real portal.
"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8080'
ROOT = Path(__file__).resolve().parents[1]
TEXTS = json.loads((ROOT / 'data/yuzm-quote-texts.json').read_text())
FIELDS = {
    'DATE_CREATE': {'title': 'Дата заказа', 'type': 'datetime', 'isReadOnly': True},
    'COMPANY_ID': {'title': 'Клиент', 'type': 'crm_company'},
    'ASSIGNED_BY_ID': {'title': 'Менеджер', 'type': 'user'},
    'PAYMENT': {'title': 'Оплата', 'type': 'enumeration', 'isMultiple': True, 'items': [{'ID': '1', 'VALUE': 'Безналичный'}]},
    'ADDRESS': {'title': 'Адрес', 'type': 'string', 'isMultiple': True},
    'RESULT_TOTAL': {'title': 'Сумма заказа', 'type': 'money'},
    'RESULT_DELIVERY': {'title': 'Доставка', 'type': 'double'},
    'RESULT_WEIGHT': {'title': 'Масса', 'type': 'double'},
    'RESULT_JSON': {'title': 'JSON КП', 'type': 'string'},
}
CONFIG = {'schemaVersion': 1, 'revision': '1', 'fields': {
    'payment': {'code': 'PAYMENT'}, 'deliveryAddress': {'code': 'ADDRESS'},
    'total': {'code': 'RESULT_TOTAL'}, 'delivery': {'code': 'RESULT_DELIVERY'},
    'weight': {'code': 'RESULT_WEIGHT'}, 'snapshot': {'code': 'RESULT_JSON'},
}, 'resources': {'textFileId': '101', 'textFolderId': '102'}, 'deliveryCoefficientKeys': ['k2']}
MOCK = r"""
const configuration = __CONFIG__;
const fields = __FIELDS__;
window.testState = {texts: __TEXTS__, calls: [], docs: [], failUpdate: 0,
  deal: {ID:'718',TITLE:'Тестовая сделка',COMPANY_ID:'5',ASSIGNED_BY_ID:'7',DATE_CREATE:'2026-10-23T12:00:00+03:00',PAYMENT:['1'],ADDRESS:['Адрес теста'],CATEGORY_ID:'0',CURRENCY_ID:'RUB',RESULT_JSON:''},
  rows: [{ID:'90',PRODUCT_ID:0,PRODUCT_NAME:'Прежняя работа',PRICE:10,QUANTITY:1,SORT:10,TAX_RATE:0,TAX_INCLUDED:'Y'}],
  options: {yuzmIntegrationConfig: JSON.stringify(configuration),yuzmQuoteTemplateId:'3'}};
window.BX24 = {init: cb=>setTimeout(cb,0),isAdmin:()=>__ADMIN__,getDomain:()=>'mock.portal.example',
  placement:{info:()=>({placement:'CRM_DEAL_DETAIL_TAB',options:{ID:'718'}})},
  callMethod(method, params, callback) {
    const s=window.testState;s.calls.push({method,params:structuredClone(params)});
    let data, error=false;
    if(method==='app.info')data={INSTALLED:'Y'};
    else if(method==='app.option.get')data=s.options[params.option]??'';
    else if(method==='app.option.set'){Object.assign(s.options,params.options);data=true;}
    else if(method==='crm.deal.fields')data=fields;
    else if(method==='crm.deal.userfield.list')data=[];
    else if(method==='crm.deal.get')data=s.deal;
    else if(method==='crm.deal.productrows.get')data=s.rows;
    else if(method==='crm.company.get')data={ID:'5',TITLE:'Тестовый заказчик'};
    else if(method==='user.get')data=[{ID:'7',NAME:'Тест',LAST_NAME:'Тестов',EMAIL:'test@example.com',WORK_PHONE:'123',WORK_POSITION:'Менеджер'}];
    else if(method==='crm.documentgenerator.template.list')data={templates:[{id:3,name:'КП',active:'Y',entityTypeId:['2']}]};
    else if(method==='crm.documentgenerator.template.get')data={template:{id:3,name:'КП',active:'Y',entityTypeId:['2']}};
    else if(method==='crm.documentgenerator.document.list')data={documents:s.docs};
    else if(method==='crm.documentgenerator.document.add'){
      const doc={id:String(77+s.docs.length),number:'КП-'+(77+s.docs.length),title:params.values.DocumentTitle,templateId:3,entityId:718,entityTypeId:2,createTime:new Date().toISOString(),downloadUrl:'https://portal.example/doc.docx'};
      s.docs.push(doc);data={document:doc};
    }else if(method==='crm.documentgenerator.document.get')data={document:s.docs.find(d=>d.id===String(params.id))};
    else if(method==='crm.item.productrow.set'){
      s.rows=params.productRows.map((r,i)=>({ID:String(100+i),PRODUCT_ID:r.productId,PRODUCT_NAME:r.productName,PRICE:r.price,QUANTITY:r.quantity,SORT:r.sort,TAX_RATE:r.taxRate,TAX_INCLUDED:r.taxIncluded}));data={productRows:s.rows};
    }else if(method==='crm.deal.update'){
      if(s.failUpdate){s.failUpdate--;error='ACCESS_DENIED';}else{Object.assign(s.deal,params.fields);data=true;}
    }else if(method==='disk.file.get')data={ID:String(params.id),NAME:'yuzm-quote-texts.json',SIZE:1000,DOWNLOAD_URL:'https://portal.example/texts.json'};
    else if(method==='disk.folder.get')data={ID:String(params.id),TYPE:'folder'};
    else if(method==='disk.folder.getchildren')data=[{ID:101,NAME:'yuzm-quote-texts.json',TYPE:'file'}];
    else if(method==='disk.file.uploadVersion'){
      const binary=atob(params.fileContent[1]);s.texts=JSON.parse(new TextDecoder().decode(Uint8Array.from(binary,c=>c.charCodeAt(0))));data={ID:String(params.id)};
    }else if(method==='methods')data=['app.option.get','app.option.set','crm.deal.fields','crm.deal.userfield.list','crm.deal.get','crm.deal.update','crm.deal.productrows.get','crm.item.productrow.set','crm.documentgenerator.document.add','crm.documentgenerator.document.get','crm.documentgenerator.document.list','crm.documentgenerator.template.get','crm.documentgenerator.template.list','disk.file.get','disk.file.uploadVersion','user.get'];
    else error='MOCK_METHOD_UNSUPPORTED';
    const copied=structuredClone(data);
    setTimeout(()=>callback({error:()=>error,answer:{error:error||undefined},data:()=>copied,more:()=>false,total:()=>Array.isArray(copied)?copied.length:0}),0);
  }};
"""

def setup(page, admin=True):
    script = MOCK.replace('__CONFIG__', json.dumps(CONFIG)).replace('__FIELDS__', json.dumps(FIELDS)).replace('__TEXTS__', json.dumps(TEXTS)).replace('__ADMIN__', 'true' if admin else 'false')
    page.add_init_script(script)
    page.route('https://portal.example/texts.json', lambda route: route.fulfill(status=200, content_type='application/json', headers={'Access-Control-Allow-Origin': '*'}, body=json.dumps(page.evaluate('testState.texts'))))

def wait_save(page, count):
    page.wait_for_function('(count) => testState.docs.length === count && !!testState.deal.RESULT_JSON', arg=count)
    page.wait_for_function("document.getElementById('status').textContent.startsWith('КП сохранено:')")

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1440, 'height': 1100})
    page = context.new_page(); errors = []; page.on('pageerror', lambda error: errors.append(str(error))); setup(page)
    page.goto(BASE); page.wait_for_function("document.getElementById('dealBadge').textContent === 'Сделка #718'")
    page.wait_for_function("document.getElementById('integrationConfigStatus').textContent.includes('загружены')")
    assert page.locator('#primaryFields').inner_text().find('Безналичный') >= 0
    assert page.get_by_text('К1 · скидка', exact=True).count() == 1
    assert page.get_by_text('К2 · доставка', exact=True).count() == 1
    assert page.get_by_text('К3 · покрытие / краска', exact=True).count() == 1
    page.locator('[data-field="unitWeight"]').fill('0')
    page.locator('#addCustomBtn').click()
    row = page.locator('[data-row-id]').last
    row.locator('[data-field="productName"]').fill('Произвольная работа')
    row.locator('[data-field="basePrice"]').fill('50')
    row.locator('[data-field="unitWeight"]').fill('0')
    row.locator('[data-field="quantity"]').fill('2')
    row.locator('[data-field="k1"]').fill('0.9'); row.locator('[data-field="k2"]').fill('1.1'); row.locator('[data-field="k3"]').fill('1.2')
    page.locator('#createQuoteBtn').click(); page.locator('#quoteDialog').wait_for(state='visible')
    page.once('dialog', lambda dialog: dialog.dismiss()); page.locator('#generateDocumentBtn').click()
    page.wait_for_function("!document.getElementById('generateDocumentBtn').disabled")
    assert page.evaluate('testState.docs.length') == 0
    page.once('dialog', lambda dialog: dialog.accept()); page.locator('#generateDocumentBtn').click(); wait_save(page, 1)
    assert page.evaluate('testState.rows.length') == 2
    assert page.evaluate('testState.rows.every(row=>row.PRODUCT_ID===0)')
    assert page.evaluate('testState.deal.RESULT_DELIVERY') == 10.8
    assert page.evaluate('JSON.parse(testState.deal.RESULT_JSON).document.id') == '77'
    page.locator('#closeQuoteBtn').click()
    row.locator('[data-field="productName"]').fill('Локальная незавершённая правка')
    old_snapshot = page.evaluate('testState.deal.RESULT_JSON')
    page.once('dialog', lambda dialog: dialog.dismiss()); page.locator('#restoreCalculationBtn').click()
    page.wait_for_function("!document.getElementById('restoreCalculationBtn').disabled")
    assert row.locator('[data-field="productName"]').input_value() == 'Локальная незавершённая правка'
    page.once('dialog', lambda dialog: dialog.accept()); page.locator('#restoreCalculationBtn').click()
    page.wait_for_function("document.getElementById('status').textContent.includes('заново вычислен')")
    assert page.locator('[data-field="productName"]').last.input_value() == 'Произвольная работа'
    assert page.evaluate('testState.deal.RESULT_JSON') == old_snapshot
    page.locator('[data-field="productName"]').last.fill('Новая редакция работы')
    page.evaluate('testState.failUpdate=1')
    page.locator('#createQuoteBtn').click(); page.once('dialog', lambda dialog: dialog.accept()); page.locator('#generateDocumentBtn').click()
    page.wait_for_function("document.getElementById('status').textContent.includes('не завершено')")
    assert page.evaluate('testState.docs.length') == 2
    page.locator('#closeQuoteBtn').click(); page.locator('#resumeSaveBtn').click(); page.locator('#generateDocumentBtn').click(); wait_save(page, 2)
    assert page.evaluate('testState.docs.length') == 2
    page.locator('#closeQuoteBtn').click()
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.locator('body').evaluate('(element)=>element.scrollWidth <= innerWidth + 2')
    assert not errors, errors
    print('PASS: manager UI, coefficient labels, primary arrays, cancellation, complete custom-row save, JSON, manual restore, local independence, partial retry, mobile viewport')
    admin = context.new_page(); setup(admin); admin.goto(BASE+'/admin.html')
    admin.wait_for_function("!document.getElementById('adminControls').disabled")
    assert admin.locator('#map-snapshot').input_value() == 'RESULT_JSON'
    admin.locator('#checkConfig').click(); admin.wait_for_function("document.getElementById('adminStatus').textContent.startsWith('Поля, чтение JSON')")
    admin.locator('#listTextFiles').click(); admin.wait_for_function("document.getElementById('diskFilePicker').options.length===2")
    changed = json.loads(json.dumps(TEXTS)); changed['version']='browser-test-2'; changed['templates']['documents']['presets'][0]['text']='Обновлённая формулировка'
    admin.locator('#textUpload').set_input_files({'name':'texts.json','mimeType':'application/json','buffer':json.dumps(changed,ensure_ascii=False).encode()})
    admin.wait_for_function("document.getElementById('textVersion').textContent.includes('browser-test-2')")
    admin.locator('#publishTexts').click(); admin.wait_for_function("document.getElementById('adminStatus').textContent.includes('Новая версия опубликована')")
    assert admin.evaluate('testState.texts.version') == 'browser-test-2'
    print('PASS: admin field metadata, configuration check, folder selection, JSON preview and publication with same file ID')
    denied = context.new_page(); setup(denied, admin=False); denied.goto(BASE+'/admin.html')
    denied.wait_for_function("document.getElementById('adminStatus').textContent.includes('только администратору')")
    assert denied.locator('#saveConfig').is_disabled()
    print('PASS: manager cannot use admin writes')
    browser.close()
