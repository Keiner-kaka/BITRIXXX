import json,threading,http.server,functools
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
fixture={'schemaVersion':1,'version':'v1','documentId':'900','deal':{'id':'42','companyName':'ООО Загружено'},'parameters':{'currency':'RUB','rounding':'unit','rows':[{'productId':'9','productName':'Опора из JSON','basePrice':'100,50','quantity':'2','k1':'1,2','k2':'1,1','k3':'1','coatingCode':'none','executionTerm':'20','fastenersEnabled':True,'fasteners':'5'},{'rowType':'custom','productName':'Монтаж','basePrice':'30','quantity':'1','k1':'1','k2':'1','k3':'1','coatingCode':'custom','customCoating':'Особое покрытие','executionTerm':'Со склада','fastenersEnabled':False}]}}
class Handler(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*a):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(root)))
threading.Thread(target=server.serve_forever,daemon=True).start()
app=(root/'src/app.js').read_text().replace('    await connectPortal();', '    window.testReady = true;')
app+='''
window.harness = {
 setup() {
  connected = adapter.connected = true;
  state.scope='deal-42'; state.activeDealId='42'; state.settings.historyFolderId='77';state.settings.dealId='42';
  generatedDocuments=[{id:'900',title:'Документ 900',createdAt:new Date().toISOString(),downloadUrl:'https://portal.example/doc.docx'}];
  window.calls=[];
  adapter.sdk={callMethod(method,params,cb){window.calls.push(method);let data;
    if(method==='disk.folder.getchildren')data=[{ID:'1',NAME:'yuzm-kp-deal-42-date-v1-document-900.json',TYPE:'file'},{ID:'2',NAME:'yuzm-kp-deal-42-date-v2-document-901.json',TYPE:'file'}];
    else if(method==='disk.file.get')data={ID:'1',NAME:'yuzm-kp-deal-42-date-v1-document-900.json',TYPE:'file',PARENT_ID:'77',DOWNLOAD_URL:'https://portal.example/version.json'};
    else throw new Error('Unexpected write/API '+method);
    cb({error:()=>null,data:()=>data,more:()=>false});
  }};
  render();
 },
 state:()=>structuredClone(state),
};
'''
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 page=browser.new_page()
 errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
 page.route('**/src/app.js',lambda r:r.fulfill(body=app,content_type='application/javascript'))
 downloads=[]
 def json_route(r):
  downloads.append(1);r.fulfill(body=json.dumps(fixture),content_type='application/json',headers={'Access-Control-Allow-Origin':'*'})
 page.route('https://portal.example/version.json',json_route)
 page.goto(f'http://127.0.0.1:{server.server_port}/')
 page.wait_for_function('window.testReady && window.harness')
 page.evaluate('harness.setup()')
 before=page.evaluate('harness.state()')
 assert page.locator('[data-document-id="900"]').evaluate("el=>Array.from(el.children).findIndex(x=>x.textContent==='Загрузить') < Array.from(el.children).findIndex(x=>x.textContent==='Скачать DOCX')")
 page.locator('[data-load-calculation="900"]').click()
 page.wait_for_function("!document.getElementById('confirmLoadCalculationBtn').disabled")
 assert page.locator('#loadCalculationDialog').is_visible()
 assert 'будут заменены' in page.locator('#loadCalculationWarning').inner_text()
 assert page.locator('#calculationVersionSelect option').count()==1
 assert downloads==[]
 assert page.evaluate('calls')==['disk.folder.getchildren']
 page.locator('#cancelLoadCalculationBtn').click()
 assert page.evaluate('harness.state().draft')==before['draft']
 assert downloads==[]
 page.locator('[data-load-calculation="900"]').click()
 page.wait_for_function("!document.getElementById('confirmLoadCalculationBtn').disabled")
 page.locator('#confirmLoadCalculationBtn').click()
 page.wait_for_function("!document.getElementById('loadCalculationDialog').open")
 assert len(downloads)==1
 assert page.locator('#companyName').input_value()=='ООО Загружено'
 assert page.locator('[data-field="quantity"]').first.input_value()=='2'
 assert page.locator('[data-field="k1"]').first.input_value()=='1,2'
 assert page.locator('[data-field="fasteners"]').first.input_value()=='5'
 assert page.locator('[data-field="productName"]').input_value()=='Монтаж'
 assert page.locator('[data-field="customCoating"]').input_value()=='Особое покрытие'
 loaded=page.evaluate('harness.state()')
 assert len(loaded['draft']['rows'])==2
 # Wrong document must not modify the active draft.
 fixture['documentId']='901'
 page.locator('[data-load-calculation="900"]').click()
 page.wait_for_function("!document.getElementById('confirmLoadCalculationBtn').disabled")
 page.locator('#confirmLoadCalculationBtn').click()
 page.wait_for_function("document.getElementById('loadCalculationMessage').textContent.includes('не соответствует')")
 assert page.evaluate('harness.state().draft')==loaded['draft']
 assert set(page.evaluate('calls'))=={'disk.folder.getchildren','disk.file.get'}
 assert not errors, errors
 print('PASS: browser button order, linked document selection, warning before download, cancel preserves fields, confirmed JSON populates constructor, wrong document preserves draft, no CRM writes/generation/version save')
 browser.close()
server.shutdown()
