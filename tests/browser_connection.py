"""Check the connection UI with the actual BX24 library and a simulated portal.

Run an HTTP server first. Cache the official SDK with:
curl -fsSL https://api.bitrix24.tech/api/v1/ -o /tmp/yuzm-bx24-sdk.js
No real portal, OAuth token, or credentials are used.
"""
import json
import os
from pathlib import Path
from urllib.parse import urlparse, parse_qs
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

    def scenario(named=True, delay=0, blocked=None, api_result=None, suspended=False, api_routes=None):
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
            method = urlparse(route.request.url).path.split('/rest/', 1)[-1].removesuffix('.json')
            if method in (api_routes or {}):
                answer = api_routes[method]
                if callable(answer):
                    answer = answer(parse_qs(route.request.post_data or '', keep_blank_values=True))
                route.fulfill(status=400 if 'error' in answer else 200,
                              content_type='application/json', body=json.dumps(answer))
                return
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

    catalog_routes = {
        'catalog.catalog.list': {'result': {'catalogs': [{'id': 7, 'iblockId': 7, 'productIblockId': 0}]}},
        'catalog.product.list': {'result': {'products': [{'id': 101, 'iblockId': 7, 'name': 'Товар 101', 'type': 1}]}},
    }
    context, page, frame, calls, errors, control, held = scenario(api_routes={
        **catalog_routes,
        'catalog.product.list': {'error': 200040300010, 'error_description': 'private-auth-data'},
    })
    expect(frame.locator('#connectionBadge')).to_contain_text('подключён')
    frame.locator('#addItemBtn').click()
    expect(frame.locator('#productResults')).to_contain_text('catalog.product.list — 200040300010')
    frame.locator('#closeProductBtn').click()
    report = diagnostics(frame)
    assert report['rest_requests'][-1]['code'] == '200040300010'
    assert not any('/rest/catalog.price' in call for call in calls)
    assert 'private-' not in json.dumps(report) and not errors
    context.close()
    passed('actual SDK preserves catalog access errors without leaking descriptions or loading prices')

    variation = {'id': 101, 'iblockId': 8, 'name': 'Вариация рабочего каталога', 'type': 4, 'parentId': {'value': '90'}}
    context, page, frame, calls, errors, control, held = scenario(api_routes={
        'catalog.catalog.list': {'result': {'catalogs': [{'id': 7, 'iblockId': 7, 'productIblockId': 0}, {'id': 8, 'iblockId': 8, 'productIblockId': 7}]}},
        'catalog.product.list': {'result': {'products': []}},
        'catalog.product.sku.list': {'result': {'units': [{'id': 90, 'iblockId': 7, 'type': 3, 'name': 'Основной товар'}]}},
        'catalog.product.offer.list': {'result': {'offers': [variation]}},
        'catalog.product.get': {'error': '', 'error_description': 'product does not exist.'},
        'catalog.product.offer.get': {'result': {'offer': variation}},
        'catalog.priceType.list': {'result': {'priceTypes': [{'id': 1, 'name': 'BASE', 'base': 'Y'}]}},
        'catalog.price.list': {'result': {'prices': [{'id': 1, 'productId': 101, 'catalogGroupId': 1, 'price': 500, 'currency': 'RUB'}]}},
    })
    expect(frame.locator('#connectionBadge')).to_contain_text('подключён')
    frame.locator('#addItemBtn').click()
    expect(frame.locator('#productResults .catalog-result')).to_have_count(1)
    assert not any('/rest/catalog.price' in call for call in calls)
    frame.locator('#productResultsSelect').select_option('101')
    frame.locator('[data-choose-catalog=productResults]').click()
    expect(frame.locator('.item-row').last.locator('.base-price')).to_contain_text('500')
    assert not any('/rest/crm.product.get' in call for call in calls)
    assert not errors, errors
    context.close()
    passed('actual SDK verifies only the chosen variation and handles empty missing-product codes')

    starts = []
    name = 'Опора СФГ-700-10,0-01-ц'
    def product_pages(params):
        values = params.get('start', ['0'])
        starts.append(values)
        offset = int(values[-1])
        assert not any(key.startswith('filter[') and ('name]' in key or 'parentId]' in key) for key in params)
        rows = [{'id': 1000 + index, 'iblockId': 7, 'type': 1, 'name': name + ' #' + str(index)}
                for index in range(offset, min(offset + 50, 51))]
        return {'result': {'products': rows}, 'total': 51, **({'next': offset + 50} if offset + 50 < 51 else {})}

    def product_prices(params):
        ids = [int(value[0]) for key, value in params.items() if key.startswith('filter[@productId]')]
        assert len(ids) == 1
        return {'result': {'prices': [{'id': ids[0], 'productId': ids[0], 'catalogGroupId': 1, 'price': 57900, 'currency': 'RUB'}]}}

    context, page, frame, calls, errors, control, held = scenario(api_routes={
        **catalog_routes,
        'catalog.product.list': product_pages,
        'catalog.product.get': lambda params: {'result': {'product': {'id': int(params['id'][0]), 'name': name, 'type': 1}}},
        'catalog.priceType.list': {'result': {'priceTypes': [{'id': 1, 'name': 'BASE', 'base': 'Y'}]}},
        'catalog.price.list': product_prices,
    })
    expect(frame.locator('#connectionBadge')).to_contain_text('подключён')
    frame.locator('#addItemBtn').click()
    expect(frame.locator('#productResults .catalog-result')).to_have_count(51, timeout=15000)
    assert starts == [['0'], ['50']], starts
    for fragment in ['СФГ', '700']:
        frame.locator('#productQuery').fill(fragment)
        frame.locator('#productSearchBtn').click()
        expect(frame.locator('#productResults .catalog-result')).to_have_count(51)
        assert starts == [['0'], ['50']], starts
    assert not any('/rest/catalog.price' in call for call in calls)
    frame.locator('#productResultsSelect').select_option('1050')
    frame.locator('[data-choose-catalog=productResults]').click()
    expect(frame.locator('.item-row').last.locator('.base-price')).to_contain_text('57')
    assert not errors, errors
    context.close()
    passed('actual SDK reads both product pages once, filters locally and loads only the selected price')

    offer_starts = []
    def offer_pages(params):
        assert params['filter[iblockId]'] == ['8']
        assert not any(key.startswith('filter[') and ('parentId]' in key or 'name]' in key) for key in params)
        values = params.get('start', ['0'])
        offer_starts.append(values)
        offset = int(values[-1])
        rows = [{'id': 1000 + index, 'iblockId': 8, 'type': 4, 'active': 'Y',
                 'parentId': {'value': '999' if index == 549 else '301'}, 'name': 'Исполнение #' + str(index)}
                for index in range(offset, min(offset + 50, 550))]
        return {'result': {'offers': rows}, 'total': 550, **({'next': offset + 50} if offset + 50 < 550 else {})}

    context, page, frame, calls, errors, control, held = scenario(api_routes={
        'catalog.catalog.list': {'result': {'catalogs': [{'id': 7, 'iblockId': 7, 'productIblockId': 0}, {'id': 8, 'iblockId': 8, 'productIblockId': 7}]}},
        'catalog.product.list': {'result': {'products': []}},
        'catalog.product.sku.list': {'result': {'units': [{'id': 301, 'iblockId': 7, 'type': 3, 'name': name, 'active': 'Y'}]}},
        'catalog.product.offer.list': offer_pages,
        'catalog.product.get': {'error': '', 'error_description': 'product does not exist.'},
        'catalog.product.offer.get': lambda params: {'result': {'offer': {'id': int(params['id'][0]), 'name': 'Исполнение #549', 'type': 4, 'parentId': {'value': '999'}}}},
        'catalog.priceType.list': {'result': {'priceTypes': [{'id': 1, 'name': 'BASE', 'base': 'Y'}]}},
        'catalog.price.list': product_prices,
    })
    expect(frame.locator('#connectionBadge')).to_contain_text('подключён')
    frame.locator('#addItemBtn').click()
    expect(frame.locator('#productResults .catalog-result')).to_have_count(550, timeout=20000)
    assert offer_starts == [[str(index)] for index in range(0,550,50)], offer_starts
    expect(frame.locator('#productResults')).to_contain_text('Исполнение #549')
    for fragment in ['СФГ', '700']:
        frame.locator('#productQuery').fill(fragment)
        frame.locator('#productSearchBtn').click()
        expect(frame.locator('#productResults .catalog-result')).to_have_count(549)
    assert len(offer_starts) == 11
    frame.locator('#productQuery').fill('1549')
    frame.locator('#productSearchMode').select_option('id')
    expect(frame.locator('#productResults .catalog-result')).to_have_count(1)
    assert not any('/rest/catalog.price' in call for call in calls)
    frame.locator('#productResultsSelect').select_option('1549')
    frame.locator('[data-choose-catalog=productResults]').click()
    expect(frame.locator('.item-row').last.locator('[data-field=productId]')).to_have_value('1549')
    assert not errors, errors
    context.close()
    passed('actual SDK exposes all 550 variations, including an unrelated parent, and locally filters without a 500 limit')

    browser.close()
print(f'{len(checks)} connection browser checks passed.')
