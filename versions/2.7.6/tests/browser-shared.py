import json,threading,http.server,functools
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
class Handler(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*a):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(root)))
threading.Thread(target=server.serve_forever,daemon=True).start()
app=(root/'src/app.js').read_text().replace('    await connectPortal();', '    window.testReady = true;')
app+='''
window.harness={
 async setup(admin){
  connected=adapter.connected=true;state.scope='deal-42';state.activeDealId='42';state.settings.dealId='42';
  state.settings.historyFolderId=admin?'77':'999';state.settings.deliveryProductId=admin?'101, 202':'';
  adapter.sdk={isAdmin:()=>admin,callMethod(method,params,cb){window.testREST(admin,method,params).then(result=>cb({error:()=>result.error||null,data:()=>result.data,more:()=>false}));}};
  await refreshSharedSettings(); await refreshSharedTemplate(); await refreshTemplates();render();settingsToForm();
 },
 state:()=>structuredClone(state),
 common:()=>structuredClone(commonSettings),
};
'''
options={};calls=[]
def rest(admin,method,params):
 calls.append({'admin':admin,'method':method,'params':params})
 if method=='app.option.get':return {'data':options.get(params['option'])}
 if method=='app.option.set':
  if not admin:return {'error':'ACCESS_DENIED'}
  options.update(params['options']);return {'data':True}
 if method=='crm.deal.get':return {'data':{'ID':'42','CATEGORY_ID':'0','CURRENCY_ID':'RUB'}}
 if method.startswith('crm.documentgenerator.template.'):
  if not admin:return {'error':'DOCGEN_ACCESS_ERROR'}
  return {'data':{'templates':{'3':{'id':'3','name':'Общий КП','active':'Y','isDeleted':'N','entityTypeId':['2']}}}}
 raise Exception('Unexpected API '+method)
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 errors=[]
 def open_page(context):
  page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  page.expose_function('testREST',rest)
  page.route('**/src/app.js',lambda r:r.fulfill(body=app,content_type='application/javascript'))
  page.goto(f'http://127.0.0.1:{server.server_port}/')
  page.wait_for_function('window.testReady && window.harness')
  return page
 admin_context=browser.new_context();admin=open_page(admin_context);admin.evaluate('harness.setup(true)')
 admin.locator('#settingsBtn').click()
 admin.wait_for_function("!document.getElementById('saveSettingsBtn').disabled")
 assert 'ещё не опубликованы' in admin.locator('#sharedSettingsStatus').inner_text()
 admin.locator('#historyFolderId').fill('177')
 admin.locator('#termTemplate-validity').fill('КП действительно 7 дней.')
 admin.locator('#defaultDocumentTemplateId').select_option('3')
 admin.locator('#saveSettingsBtn').click()
 admin.wait_for_function("!document.getElementById('settingsDialog').open")
 assert options['yuzmQuoteTemplateId']=='3'
 assert json.loads(options['yuzmQuoteConstructorSettings'])['settings']['historyFolderId']=='177'
 manager_context=browser.new_context();manager=open_page(manager_context);manager.evaluate('harness.setup(false)')
 assert manager.evaluate('harness.state().settings.deliveryProductId')=='101, 202'
 assert manager.evaluate('harness.state().settings.historyFolderId')=='177'
 assert manager.evaluate('harness.state().settings.termTemplates.validity')=='КП действительно 7 дней.'
 assert 'Общий шаблон КП: #3' in manager.locator('#templateSummary').inner_text()
 assert not any(not c['admin'] and c['method'].startswith('crm.documentgenerator.template.') for c in calls)
 manager.locator('#settingsBtn').click()
 manager.wait_for_function("document.getElementById('historyFolderId').disabled && !document.getElementById('saveSettingsBtn').disabled")
 assert manager.locator('#historyFolderId').input_value()=='177'
 assert manager.locator('#deliveryProductId').input_value()=='101, 202'
 assert manager.locator('#deliveryProductId').is_disabled()
 assert manager.locator('#historyFolderId').is_disabled()
 assert manager.locator('#defaultDocumentTemplateId').is_disabled()
 assert manager.locator('#refreshTemplatesBtn').is_disabled()
 assert 'Изменить их может администратор' in manager.locator('#sharedSettingsStatus').inner_text()
 manager.locator('#saveSettingsBtn').click()
 manager.wait_for_function("!document.getElementById('settingsDialog').open")
 assert not any(not c['admin'] and c['method']=='app.option.set' for c in calls)
 # A completely fresh browser also obtains the same published configuration.
 fresh_context=browser.new_context();fresh=open_page(fresh_context);fresh.evaluate('harness.setup(false)')
 assert fresh.evaluate('harness.state().settings.historyFolderId')=='177'
 assert not errors,errors
 print('PASS: admin publishes settings/template; isolated employee and fresh browser read them; stale local folder replaced; common controls readonly for manager; no manager template.list/get or app.option.set')
 browser.close()
server.shutdown()
