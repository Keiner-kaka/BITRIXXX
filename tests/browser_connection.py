"""Check the connection UI with the actual BX24 library and a simulated portal.

Run an HTTP server first. Cache the official SDK with:
curl -fsSL https://api.bitrix24.tech/api/v1/ -o /tmp/yuzm-bx24-sdk.js
No real portal, OAuth token, or credentials are used.
"""
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('YUZM_APP_URL', 'http://127.0.0.1:8080/').rstrip('/') + '/'
SDK_PATH = Path(os.environ.get('YUZM_BX24_SDK_PATH', '/tmp/yuzm-bx24-sdk.js'))
SDK = SDK_PATH.read_text()
ORIGIN = BASE.rstrip('/')
DOMAIN = urlparse(BASE).netloc
checks = []


def passed(message):
    checks.append(message)
    print('PASS:', message, flush=True)


def harness(named=True, delay=0):
    data = {'DOMAIN': DOMAIN, 'PROTOCOL': 0, 'PATH': '/rest', 'LANG': 'ru',
            'AUTH_ID': 'test-only-token', 'AUTH_EXPIRES': 3600, 'IS_ADMIN': True,
            'INSTALL': False, 'USER_OPTIONS': {}, 'APP_OPTIONS': {}, 'PLACEMENT_OPTIONS': {}}
    name = DOMAIN + '|0|test-only-frame-sid' if named else ''
    return '''<!doctype html><meta charset="utf-8"><script>
      window.addEventListener('message', event => {
        if (event.origin !== location.origin || typeof event.data !== 'string') return;
        const parts = event.data.split(':');
        if (parts[0] === 'getInitData') setTimeout(() => {
          event.source.postMessage(parts[2] + ':' + JSON.stringify(INIT_DATA), event.origin);
        }, INIT_DELAY);
      });
    </script><iframe name="FRAME_NAME" src="index.html" style="width:1400px;height:950px"></iframe>'''.replace(
        'INIT_DATA', json.dumps(data)).replace('INIT_DELAY', str(delay)).replace('FRAME_NAME', name)


def diagnostics(frame):
    frame.locator('#settingsBtn').click()
    value = frame.locator('#connectionDiagnostics').input_value()
    frame.locator('#closeSettingsBtn').click()
    assert 'test-only-token' not in value
    assert 'test-only-frame-sid' not in value
    assert DOMAIN not in value
    return json.loads(value)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])

    def scenario(named=True, delay=0, blocked=None, api_result=None, suspended=False):
        context = browser.new_context(locale='ru-RU', viewport={'width': 1450, 'height': 1100})
        page = context.new_page()
        requests, errors, held = [], [], []
        control = {'blocked': set(blocked or [])}
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(BASE + 'connection-test.html', lambda route: route.fulfill(
            status=200, content_type='text/html', body=harness(named, delay)))

        def library(route):
            requests.append(route.request.url)
            if suspended:
                held.append(route)
            elif urlparse(route.request.url).netloc in control['blocked']:
                route.abort()
            else:
                route.fulfill(status=200, content_type='application/javascript', body=SDK)
        page.route('https://api.bitrix24.tech/**', library)
        page.route('https://api.bitrix24.com/**', library)

        def api(route):
            requests.append(route.request.url.split('?')[0])
            if '/rest/app.option.get' in route.request.url:
                route.fulfill(status=200, content_type='application/json', body=json.dumps({'result':None}))
                return
            assert '/rest/app.info' in route.request.url, route.request.url
            route.fulfill(status=200, content_type='application/json', body=json.dumps(
                api_result if api_result is not None else {'result': {'ID': '99', 'INSTALLED': True}}))
        page.route(BASE + 'rest/**', api)
        page.goto(BASE + 'connection-test.html', wait_until='domcontentloaded')
        return context, page, page.frame_locator('iframe'), requests, errors, control, held

    context, page, frame, calls, errors, control, held = scenario(blocked=['api.bitrix24.tech'])
    expect(frame.locator('#connectionBadge')).to_contain_text('подключён', timeout=10000)
    report = diagnostics(frame)
    assert report['connection_code'] == 'CONNECTED'
    assert report['sdk_source'] == 'https://api.bitrix24.com/api/v1/'
    assert sum('/api/v1/' in call for call in calls) == 2
    assert sum('/rest/app.info' in call for call in calls) == 1
    assert not errors, errors
    context.close()
    passed('primary SDK host failure falls back to the official alternate host and verifies REST access')

    context, page, frame, calls, errors, control, held = scenario(delay=4000)
    expect(frame.locator('#connectionBadge')).to_contain_text('подключён', timeout=10000)
    assert diagnostics(frame)['connected']
    assert not errors, errors
    context.close()
    passed('a portal reply after four seconds connects successfully instead of remaining in demo mode')

    context, page, frame, calls, errors, control, held = scenario(named=False)
    expect(frame.locator('#connectionMessage')).to_contain_text('не передал контекст')
    report = diagnostics(frame)
    assert report['in_frame'] and not report['frame_context_present']
    assert report['connection_code'] == 'FRAME_CONTEXT_MISSING'
    assert not report['connected'] and not calls and not errors
    context.close()
    passed('an iframe without Bitrix context is diagnosed without attempting API calls')

    context, page, frame, calls, errors, control, held = scenario(blocked=['api.bitrix24.tech', 'api.bitrix24.com'])
    expect(frame.locator('#connectionMessage')).to_contain_text('Не удалось загрузить библиотеку')
    row = frame.locator('.item-row').first
    row.locator('[data-field=k3]').fill('2')
    assert diagnostics(frame)['connection_code'] == 'SDK_LOAD_FAILED'
    control['blocked'].clear()
    frame.locator('#retryConnectionBtn').click()
    expect(frame.locator('#connectionBadge')).to_contain_text('подключён', timeout=10000)
    expect(row.locator('[data-field=k3]')).to_have_value('2')
    assert not errors, errors
    context.close()
    passed('retry recovers after SDK network failure and preserves the edited draft')

    context, page, frame, calls, errors, control, held = scenario(api_result={
        'error': 'LICENSE_ERROR', 'error_description': 'private-credential https://portal/rest/private-token/'})
    expect(frame.locator('#connectionMessage')).to_contain_text('LICENSE_ERROR')
    report = diagnostics(frame)
    assert report['sdk_available'] and not report['connected']
    assert report['connection_code'] == 'LICENSE_ERROR'
    assert 'private-' not in frame.locator('#connectionMessage').inner_text()
    assert 'private-' not in json.dumps(report)
    assert not errors, errors
    context.close()
    passed('REST license denial is distinct from SDK failure and never reveals API error descriptions')

    context, page, frame, calls, errors, control, held = scenario(api_result={'result': {'INSTALLED': False}})
    expect(frame.locator('#connectionMessage')).to_contain_text('завершение установки')
    assert diagnostics(frame)['connection_code'] == 'INSTALL_NOT_FINISHED'
    assert not errors, errors
    context.close()
    passed('unfinished installation is detected before enabling real deal actions')

    context, page, frame, calls, errors, control, held = scenario(suspended=True)
    expect(frame.locator('#connectionMessage')).to_contain_text('ещё не завершилась', timeout=15000)
    assert len(held) == 1 and len(calls) == 1
    frame.locator('#retryConnectionBtn').click()
    held[0].fulfill(status=200, content_type='application/javascript', body=SDK)
    expect(frame.locator('#connectionBadge')).to_contain_text('подключён', timeout=10000)
    assert sum('/api/v1/' in call for call in calls) == 1
    assert not errors, errors
    context.close()
    passed('SDK load timeout and retry reuse the pending script instead of overwriting it with a second copy')

    browser.close()
print(f'{len(checks)} connection browser checks passed.')
