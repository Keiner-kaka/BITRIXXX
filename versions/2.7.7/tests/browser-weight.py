import threading,http.server,functools
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
class Handler(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*a):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(root)))
threading.Thread(target=server.serve_forever,daemon=True).start()
app=(root/'src/app.js').read_text().replace('    await connectPortal();', '    window.testReady = true;')
app+='''
window.harness={clear(){state.draft.rows=[];renderRows();},rows:()=>structuredClone(draft().rows),snapshot:()=>buildQuoteData()};
'''
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1440,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.route('**/src/app.js',lambda r:r.fulfill(body=app,content_type='application/javascript'))
 page.goto(f'http://127.0.0.1:{server.server_port}/');page.wait_for_function('window.testReady && window.harness');page.evaluate('harness.clear()')
 page.locator('#addCustomBtn').click()
 page.locator('[data-field="productName"]').fill('Произвольная позиция')
 page.locator('[data-field="pricePerKg"]').fill('100,50');page.locator('[data-field="weightKg"]').fill('2,5')
 assert page.locator('.custom-item-row [data-field="basePrice"]').count()==0
 assert page.evaluate('harness.snapshot().rows[0].unitPrice')==251.25
 for width in [1440,400]:
  page.set_viewport_size({'width':width,'height':1000})
  price=page.locator('[data-field="pricePerKg"]').bounding_box();weight=page.locator('[data-field="weightKg"]').bounding_box()
  assert abs(price['y']-weight['y'])<1,(width,price,weight)
  assert price['x']+price['width']<=weight['x']+1
  assert price['width']<150 and weight['width']<150
 page.reload();page.wait_for_function('window.testReady && window.harness')
 assert page.locator('[data-field="pricePerKg"]').input_value()=='100,50'
 assert page.locator('[data-field="weightKg"]').input_value()=='2,5'
 assert page.evaluate('harness.snapshot().rows[0].unitPrice')==251.25
 assert not errors,errors
 print('PASS: adjacent compact price/kg and weight inputs at desktop/mobile, no custom base-price input, live calculation, browser draft reload preserves both values')
 browser.close()
server.shutdown()
