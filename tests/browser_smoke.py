"""Functional UI tests. Start HTTP server first; uses system Chromium."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
BASE = 'http://127.0.0.1:8080/'
checks = []

def text_money(value):
    return ''.join(value.split()).replace('₽', '')

def passed(name):
    checks.append(name)
    print('PASS:', name, flush=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, locale='ru-RU')
    context.route('https://api.bitrix24.tech/**', lambda route: route.abort())
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE, wait_until='networkidle')
    expect(page.locator('.item-row')).to_have_count(2)
    assert text_money(page.locator('#grandTotal').inner_text()) == '1948708,34'
    assert page.locator('#applyDealBtn').is_disabled()
    expect(page.locator('.item-row').first.locator('[data-field=k3]')).to_have_value('1,18')
    expect(page.locator('.item-row').last.locator('[data-field=k3]')).to_have_value('1,12')
    expect(page.locator('#docsBody .document-row')).to_have_count(0)
    expect(page.locator('#relationsBody, #relationsSummary, #localRelationsInput, #relationsFileId, [data-field=drawingId], [data-file-id]')).to_have_count(0)
    passed('demo formula matches the supplied mockup and blocks real-deal writes')

    row = page.locator('.item-row').first
    row.locator('[data-field=quantity]').fill('0')
    assert page.locator('#saveBtn').is_disabled()
    row.locator('[data-field=quantity]').fill('24')
    row.locator('[data-field=k1]').fill('')
    assert page.locator('#saveBtn').is_disabled()
    row.locator('[data-field=k1]').fill('0')
    assert not page.locator('#saveBtn').is_disabled()
    assert text_money(page.locator('#grandTotal').inner_text()) == '626431,68'
    row.locator('[data-field=k1]').fill('-1,12')
    assert text_money(page.locator('#grandTotal').inner_text()) == '-695844,98'
    row.locator('[data-field=k1]').fill('1,12')
    row.locator('[data-field=k3]').fill('')
    assert page.locator('#saveBtn').is_disabled()
    row.locator('[data-field=k3]').fill('0')
    assert text_money(page.locator('#grandTotal').inner_text()) == '626431,68'
    row.locator('[data-field=k3]').fill('1,18')
    passed('blank/zero quantity blocks save; signed and zero modelling coefficients work')

    row.locator('[data-field=coatingCode]').select_option('none')
    assert text_money(page.locator('#grandTotal').inner_text()) == '1948708,34'
    expect(row.locator('[data-field=k3]')).to_have_value('1,18')
    row.locator('[data-field=coatingCode]').select_option('zinc')
    passed('changing coating names never changes the manual painting coefficient or price')

    page.locator('#paymentTermsPreset').select_option('100')
    expect(page.locator('#YuzmPaymentTerms')).to_have_value('100% предоплата.')
    page.locator('#paymentTermsPreset').select_option('50_50')
    expect(page.locator('#YuzmPaymentTerms')).to_have_value('50% предоплата + 50% по факту готовности к отгрузке.')
    page.locator('#paymentTermsPreset').select_option('40_60')
    expect(page.locator('#YuzmPaymentTerms')).to_have_value('40% предоплата + 60% по факту готовности к отгрузке.')
    payment_text = '40% предоплата, 60% при готовности; по договору №7.'
    delivery_text = 'Самовывоз со склада.'
    page.locator('#YuzmPaymentTerms').fill(payment_text)
    page.locator('#YuzmDeliveryTerms').fill(delivery_text)
    expect(page.locator('#paymentTermsPreset')).to_have_value('')
    passed('payment presets fill concrete text that can be edited independently')

    row.locator('[data-field=executionTerm]').fill('15 рабочих дней')
    page.locator('.item-row').last.locator('[data-field=executionTerm]').fill('20 рабочих дней')
    page.locator('#saveBtn').click()
    expect(page.locator('#status')).to_contain_text('Сохранена версия 1')
    row.locator('[data-field=quantity]').fill('3')
    row.locator('[data-field=executionTerm]').fill('99 дней')
    row.locator('[data-field=k3]').fill('2')
    page.locator('#YuzmPaymentTerms').fill('Условия изменены после сохранения')
    page.locator('#YuzmDeliveryTerms').fill('Доставка изменена после сохранения')
    page.locator('#historyBtn').click()
    expect(page.locator('.history-row')).to_have_count(1)
    page.locator('[data-view-version]').click()
    assert '1' in page.locator('#quotePreview').inner_text()
    assert text_money(page.locator('.quote-total').inner_text().replace('Итого:', '')) == '1948708,34'
    expect(page.locator('#quotePreview')).to_contain_text('15 рабочих дней')
    expect(page.locator('#quotePreview')).to_contain_text('20 рабочих дней')
    expect(page.locator('#quotePreview')).to_contain_text(payment_text)
    expect(page.locator('#quotePreview')).to_contain_text(delivery_text)
    assert 'Условия изменены после сохранения' not in page.locator('#quotePreview').inner_text()
    assert '99 дней' not in page.locator('#quotePreview').inner_text()
    page.locator('#closeQuoteBtn').click()
    page.locator('#historyBtn').click()
    page.locator('[data-restore-version]').click()
    expect(page.locator('.item-row').first.locator('[data-field=quantity]')).to_have_value('24')
    expect(page.locator('.item-row').first.locator('[data-field=k3]')).to_have_value('1,18')
    expect(page.locator('.item-row').first.locator('[data-field=executionTerm]')).to_have_value('15 рабочих дней')
    expect(page.locator('#YuzmPaymentTerms')).to_have_value(payment_text)
    expect(page.locator('#YuzmDeliveryTerms')).to_have_value(delivery_text)
    page.reload(wait_until='networkidle')
    expect(page.locator('.item-row').first.locator('[data-field=k3]')).to_have_value('1,18')
    expect(page.locator('.item-row').first.locator('[data-field=executionTerm]')).to_have_value('15 рабочих дней')
    expect(page.locator('#YuzmPaymentTerms')).to_have_value(payment_text)
    expect(page.locator('#YuzmDeliveryTerms')).to_have_value(delivery_text)
    expect(page.locator('#paymentTermsPreset')).to_have_value('')
    passed('saved K3, execution terms and edited conditions remain immutable through restore and reload')

    # Simulate a saved v1 browser cache containing the retired relations/drawing fields.
    # Archive data stays immutable while the restored editable drafts drop drawing IDs.
    legacy_archive = page.evaluate("""() => {
      const key = 'yuzm-kp-prototype-v1-demo';
      const cached = JSON.parse(localStorage.getItem(key));
      cached.state.schemaVersion = 1;
      delete cached.config.calculationVersion;
      cached.config.coatings.forEach(coating => coating.coefficient = {none: 1, zinc: 1.18, paint: 1.12}[coating.code] || 1);
      cached.relations = {product_drawings: [], drawing_kd: [{drawing_id: 'missing'}]};
      cached.relationMeta = {source: 'legacy'};
      cached.state.settings.relationsFileId = '10';
      for (const variant of cached.state.variants) {
        variant.context.config = structuredClone(cached.config);
        variant.draft.rows.forEach(row => {
          delete row.k3;
          row.drawingId = 'legacy-drawing';
          row.coatingFactor = cached.config.coatings.find(coating => coating.code === row.coatingCode).coefficient;
          row.extraCoating = '0'; row.delivery = '0';
        });
      }
      const archived = cached.state.variants[0].versions[0];
      archived.schemaVersion = 1;
      archived.config = structuredClone(cached.config);
      archived.rows.forEach(row => {delete row.k3; row.drawingId = 'legacy-drawing';});
      archived.relations = cached.relations;
      archived.documents = [{id: '501', name: 'Legacy drawing'}];
      localStorage.setItem(key, JSON.stringify(cached));
      return JSON.stringify(archived);
    }""")
    page.reload(wait_until='networkidle')
    expect(page.locator('.item-row')).to_have_count(2)
    assert text_money(page.locator('#grandTotal').inner_text()) == '1948708,34'
    expect(page.locator('.item-row').first.locator('[data-field=k3]')).to_have_value('1.18')
    expect(page.locator('.item-row').last.locator('[data-field=k3]')).to_have_value('1.12')
    assert page.evaluate("JSON.parse(localStorage.getItem('yuzm-kp-prototype-v1-demo')).state.schemaVersion") == 2
    assert page.evaluate("""() => JSON.parse(localStorage.getItem('yuzm-kp-prototype-v1-demo'))
      .state.variants.every(variant => variant.draft.rows.every(row => !['drawingId','coatingFactor','extraCoating','delivery'].some(key => key in row)))""")
    assert page.evaluate("""() => JSON.stringify(JSON.parse(localStorage.getItem('yuzm-kp-prototype-v1-demo'))
      .state.variants[0].versions[0])""") == legacy_archive
    expect(page.locator('#docsBody .document-row')).to_have_count(1)
    page.locator('#docsBody [data-view-document]').click()
    assert text_money(page.locator('.quote-total').inner_text().replace('Итого:', '')) == '1948708,34'
    page.locator('#closeQuoteBtn').click()
    page.locator('#historyBtn').click()
    page.locator('[data-restore-version]').click()
    assert page.evaluate("""() => JSON.parse(localStorage.getItem('yuzm-kp-prototype-v1-demo'))
      .state.variants[0].draft.rows.every(row => !('drawingId' in row))""")
    assert text_money(page.locator('#grandTotal').inner_text()) == '1948708,34'
    expect(page.locator('.item-row').first.locator('[data-field=k3]')).to_have_value('1.18')
    passed('legacy v1 catalog migration preserves prices through explicit K3 while archives remain exact')

    original_variant = page.locator('#variantSelect').input_value()
    page.locator('#duplicateVariantBtn').click()
    assert page.locator('#variantSelect option').count() == 2
    duplicate_variant = page.locator('#variantSelect').input_value()
    expect(page.locator('.item-row').first.locator('[data-field=executionTerm]')).to_have_value('15 рабочих дней')
    expect(page.locator('.item-row').first.locator('[data-field=k3]')).to_have_value('1.18')
    expect(page.locator('#YuzmPaymentTerms')).to_have_value(payment_text)
    expect(page.locator('#YuzmDeliveryTerms')).to_have_value(delivery_text)
    page.locator('.item-row').first.locator('[data-field=executionTerm]').fill('7 дней')
    page.locator('.item-row').first.locator('[data-field=k3]').fill('1.5')
    page.locator('#paymentTermsPreset').select_option('100')
    page.locator('#YuzmDeliveryTerms').fill('Доставка только для копии')
    page.locator('#newVariantBtn').click()
    expect(page.locator('.item-row')).to_have_count(0)
    assert page.locator('#saveBtn').is_disabled()
    page.locator('#variantSelect').select_option(original_variant)
    expect(page.locator('.item-row')).to_have_count(2)
    expect(page.locator('.item-row').first.locator('[data-field=executionTerm]')).to_have_value('15 рабочих дней')
    expect(page.locator('.item-row').first.locator('[data-field=k3]')).to_have_value('1.18')
    expect(page.locator('#YuzmPaymentTerms')).to_have_value(payment_text)
    expect(page.locator('#YuzmDeliveryTerms')).to_have_value(delivery_text)
    expect(page.locator('#paymentTermsPreset')).to_have_value('')
    passed('duplicated variants retain independent K3, execution and payment terms; empty variants cannot save')

    page.locator('#addItemBtn').click()
    expect(page.locator('#productResults .catalog-result')).to_have_count(4)
    page.locator('#productResults .catalog-result').nth(2).click()
    expect(page.locator('.item-row')).to_have_count(3)
    expect(page.locator('[data-field=drawingId]')).to_have_count(0)
    page.locator('.item-row').last.locator('[data-action=remove]').click()
    assert not page.locator('#saveBtn').is_disabled()
    passed('catalog items can be added and removed without drawing selection')

    page.locator('#settingsBtn').click()
    page.locator('#localPricesInput').set_input_files(str(ROOT / 'data/prices.original.example.json'))
    expect(page.locator('#settingsError')).to_be_visible()
    expect(page.locator('#settingsError')).to_contain_text('Загружен файл')
    page.locator('#closeSettingsBtn').click()
    assert text_money(page.locator('#grandTotal').inner_text()) == '1948708,34'
    expect(page.locator('.item-row').first.locator('[data-field=k3]')).to_have_value('1.18')
    assert page.evaluate("JSON.parse(localStorage.getItem('yuzm-kp-prototype-v1-demo')).metalPrices.prices_per_kg['17']") == 130
    passed('legacy coating imports discard automatic factors without repricing or replacing metal prices')

    page.locator('#settingsBtn').click()
    expect(page.locator('#localRelationsInput, #relationsFileId')).to_have_count(0)
    page.locator('#closeSettingsBtn').click()
    passed('settings omit retired relation imports and file bindings')

    page.locator('#settingsBtn').click()
    page.locator('#formulaMode').select_option('excel')
    page.locator('#settingsForm button[type=submit]').click()
    assert page.locator('#saveBtn').is_disabled()
    expect(page.locator('.item-row').first.locator('[data-field=pricePerKg]')).to_have_value('120')
    expect(page.locator('.item-row').last.locator('[data-field=pricePerKg]')).to_have_value('130')
    assert page.locator('.item-row').first.locator('[data-field=pricePerKg]').get_attribute('readonly') is not None
    page.locator('.item-row').first.locator('[data-field=weight]').fill('10')
    page.locator('.item-row').last.locator('[data-field=weight]').fill('20')
    page.locator('.item-row').first.locator('[data-field=fasteners]').fill('800')
    assert text_money(page.locator('#grandTotal').inner_text()) == '102501,93'
    page.locator('#saveBtn').click()
    expect(page.locator('#status')).to_contain_text('Сохранена версия 2')
    passed('Excel requires weight and calculates file price/kg times unit weight, three coefficients, then fasteners')

    page.locator('#settingsBtn').click()
    page.locator('#localMetalPricesInput').set_input_files({
        'name': 'updated-metal.json', 'mimeType': 'application/json',
        'buffer': json.dumps({'version': 'metal-test-2', 'currency': 'RUB', 'prices_per_kg': {'16': 150, '17': 200}}).encode()
    })
    expect(page.locator('#settingsError')).to_contain_text('Загружены цены металла')
    page.locator('#closeSettingsBtn').click()
    assert text_money(page.locator('#grandTotal').inner_text()) == '135499,01'
    cached = page.evaluate("JSON.parse(localStorage.getItem('yuzm-kp-prototype-v1-demo'))")
    original = next(variant for variant in cached['state']['variants'] if variant['id'] == original_variant)
    duplicate = next(variant for variant in cached['state']['variants'] if variant['id'] == duplicate_variant)
    assert original['draft']['rows'][0]['pricePerKg'] == '150'
    assert duplicate['draft']['rows'][0]['pricePerKg'] == '120'
    assert original['draft']['documentFields']['YuzmPaymentTerms'] == payment_text
    assert duplicate['draft']['documentFields']['YuzmPaymentTerms'] == '100% предоплата.'
    assert original['versions'][1]['rows'][0]['pricePerKg'] == '120'
    assert original['versions'][1]['total'] == 102501.93
    passed('metal import updates only the current draft and preserves other drafts and saved rates')

    page.locator('#settingsBtn').click()
    summary_before = page.locator('#metalPricesSummary').inner_text()
    page.locator('#localMetalPricesInput').set_input_files({
        'name': 'invalid-metal.json', 'mimeType': 'application/json',
        'buffer': json.dumps({'prices_per_kg': {'16': True}}).encode()
    })
    expect(page.locator('#settingsError')).to_contain_text('цена за килограмм')
    assert page.locator('#metalPricesSummary').inner_text() == summary_before
    page.locator('#closeSettingsBtn').click()
    assert text_money(page.locator('#grandTotal').inner_text()) == '135499,01'
    passed('invalid metal input is rejected without corrupting the current prices')

    page.locator('#settingsBtn').click()
    page.locator('#localMetalPricesInput').set_input_files({
        'name': 'partial-metal.json', 'mimeType': 'application/json',
        'buffer': json.dumps({'currency': 'RUB', 'prices_per_kg': {'16': 150}}).encode()
    })
    expect(page.locator('#settingsError')).to_contain_text('Загружены цены металла')
    page.locator('#closeSettingsBtn').click()
    expect(page.locator('.item-row').last.locator('[data-field=pricePerKg]')).to_have_value('')
    assert page.locator('#saveBtn').is_disabled()
    page.reload(wait_until='networkidle')
    assert page.locator('#saveBtn').is_disabled()
    expect(page.locator('.item-row').last.locator('[data-field=pricePerKg]')).to_have_value('')
    page.locator('#historyBtn').click()
    page.locator('.history-row').first.locator('[data-restore-version]').click()
    expect(page.locator('.item-row').last.locator('[data-field=pricePerKg]')).to_have_value('130')
    expect(page.locator('.item-row').first.locator('[data-field=executionTerm]')).to_have_value('15 рабочих дней')
    assert text_money(page.locator('#grandTotal').inner_text()) == '102501,93'
    passed('missing product prices block Excel across reload; restoring a version restores its metal price context')

    page.reload(wait_until='networkidle')
    assert text_money(page.locator('#grandTotal').inner_text()) == '102501,93'
    assert page.locator('#variantSelect option').count() == 3
    passed('drafts, variants, and imported reference data survive reload')

    with page.expect_download() as download:
        page.locator('#downloadBtn').click()
    target = ROOT / 'test-results' / 'downloaded-snapshot.json'
    target.parent.mkdir(exist_ok=True)
    download.value.save_as(target)
    snapshot = json.loads(target.read_text())
    assert snapshot['total'] == 102501.93 and snapshot['config']['formulaMode'] == 'excel'
    assert snapshot['schemaVersion'] == 2 and snapshot['config']['calculationVersion'] == 2
    assert len(snapshot['rows']) == 2 and snapshot['rows'][0]['weight'] == '10'
    assert snapshot['rows'][0]['executionTerm'] == '15 рабочих дней'
    assert snapshot['documentFields']['YuzmPaymentTerms'] == payment_text
    assert snapshot['documentFields']['YuzmDeliveryTerms'] == delivery_text
    assert snapshot['rows'][0]['k3'] == '1.18' and snapshot['metalPrices']['prices_per_kg']['16'] == 120
    assert all(set(coating) == {'code', 'name'} for coating in snapshot['config']['coatings'])
    assert not {'relations', 'relationMeta', 'documents'}.intersection(snapshot)
    assert all(not {'drawingId', 'coatingFactor', 'extraCoating', 'delivery'}.intersection(row) for row in snapshot['rows'])
    passed('download contains complete reproducible quote and reference snapshots')

    # Historical Excel rows did not have weight. Retired stored base prices cannot
    # silently stand in for the newly required unit weight.
    excel_archive = page.evaluate("""() => {
      const key = 'yuzm-kp-prototype-v1-demo';
      const cached = JSON.parse(localStorage.getItem(key));
      const variant = cached.state.variants.find(item => item.id === cached.state.selectedVariantId);
      cached.state.schemaVersion = 1;
      delete cached.config.calculationVersion;
      cached.config.formulaMode = 'excel';
      variant.context.config = structuredClone(cached.config);
      variant.draft.rows.forEach(row => {
        delete row.weight; delete row.pricePerKg; delete row.k3;
        row.basePrice = 38600; row.extraCoating = '999'; row.delivery = '999';
      });
      localStorage.setItem(key, JSON.stringify(cached));
      return JSON.stringify(variant.versions[1]);
    }""")
    page.reload(wait_until='networkidle')
    assert page.locator('#saveBtn').is_disabled()
    expect(page.locator('.item-row').first.locator('[data-field=weight]')).to_have_value('')
    expect(page.locator('.item-row').first.locator('[data-field=k3]')).to_have_value('1')
    assert page.evaluate("""() => JSON.stringify(JSON.parse(localStorage.getItem('yuzm-kp-prototype-v1-demo'))
      .state.variants.find(item => item.id === JSON.parse(localStorage.getItem('yuzm-kp-prototype-v1-demo')).state.selectedVariantId).versions[1])""") == excel_archive
    page.locator('#historyBtn').click()
    page.locator('.history-row').first.locator('[data-restore-version]').click()
    expect(page.locator('.item-row').first.locator('[data-field=weight]')).to_have_value('10')
    assert text_money(page.locator('#grandTotal').inner_text()) == '102501,93'
    passed('legacy Excel rows without weights cannot save or substitute old stored base prices')

    # XSS remains text in the proposal, including imported/user-provided labels.
    page.locator('#companyName').fill('<img src=x onerror=alert(1)>')
    page.locator('#createQuoteBtn').click()
    expect(page.locator('#quoteDialog')).to_be_visible()
    assert page.locator('#quotePreview img').count() == 0
    assert '<img src=x' in page.locator('#quotePreview').inner_text()
    page.locator('#closeQuoteBtn').click()
    passed('client data is rendered as text, not HTML')

    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    page.screenshot(path=str(ROOT / 'test-results' / 'prototype-mobile.png'), full_page=True)
    passed('mobile layout keeps the page within the viewport')
    assert not errors, errors
    passed('no uncaught browser errors')
    browser.close()
print(str(len(checks)) + ' browser checks passed.')
