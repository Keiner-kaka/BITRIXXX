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
    assert page.locator('#docsBody .document-row').count() == 4
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
    passed('blank/zero quantity blocks save; signed and zero modelling coefficients work')

    page.locator('#saveBtn').click()
    expect(page.locator('#status')).to_contain_text('Сохранена версия 1')
    row.locator('[data-field=quantity]').fill('3')
    page.locator('#historyBtn').click()
    expect(page.locator('.history-row')).to_have_count(1)
    page.locator('[data-view-version]').click()
    assert '1' in page.locator('#quotePreview').inner_text()
    assert text_money(page.locator('.quote-total').inner_text().replace('Итого:', '')) == '1948708,34'
    page.locator('#closeQuoteBtn').click()
    page.locator('#historyBtn').click()
    page.locator('[data-restore-version]').click()
    expect(page.locator('.item-row').first.locator('[data-field=quantity]')).to_have_value('24')
    passed('saved versions remain unchanged and restore into a new editable draft')

    original_variant = page.locator('#variantSelect').input_value()
    page.locator('#duplicateVariantBtn').click()
    assert page.locator('#variantSelect option').count() == 2
    page.locator('#newVariantBtn').click()
    expect(page.locator('.item-row')).to_have_count(0)
    assert page.locator('#saveBtn').is_disabled()
    page.locator('#variantSelect').select_option(original_variant)
    expect(page.locator('.item-row')).to_have_count(2)
    passed('variants keep independent row sets; empty variant cannot be saved')

    page.locator('#addItemBtn').click()
    expect(page.locator('#productResults .catalog-result')).to_have_count(4)
    page.locator('#productResults .catalog-result').nth(2).click()
    expect(page.locator('.item-row')).to_have_count(3)
    expect(page.locator('.item-row').last.locator('[data-field=drawingId]')).to_have_value('bracket-f2-r1')
    page.locator('.item-row').last.locator('[data-action=remove]').click()
    page.locator('.item-row').first.locator('[data-field=drawingId]').select_option('')
    page.locator('#saveBtn').click()
    expect(page.locator('#status')).to_contain_text('Выберите чертёж')
    page.locator('.item-row').first.locator('[data-field=drawingId]').select_option('nfg6-05-r1')
    passed('single drawing resolves automatically; ambiguous drawing requires a choice')

    page.locator('#settingsBtn').click()
    page.locator('#localPricesInput').set_input_files(str(ROOT / 'data/prices.original.example.json'))
    expect(page.locator('#settingsError')).to_be_visible()
    expect(page.locator('#settingsError')).to_contain_text('Загружен файл')
    page.locator('#closeSettingsBtn').click()
    assert text_money(page.locator('#grandTotal').inner_text()) == '1892718,58'
    passed('uploaded original JSON coefficients import without weight or production property')

    before = page.locator('#relationsSummary').inner_text()
    page.locator('#settingsBtn').click()
    page.locator('#localRelationsInput').set_input_files({
        'name': 'invalid.json', 'mimeType': 'application/json',
        'buffer': json.dumps({'product_drawings': [], 'drawing_kd': [{'drawing_id': 'missing', 'kit_id': 'x'}]}).encode()
    })
    expect(page.locator('#settingsError')).to_be_visible()
    expect(page.locator('#settingsError')).to_contain_text('неизвестный чертёж')
    page.locator('#closeSettingsBtn').click()
    assert page.locator('#relationsSummary').inner_text() == before
    passed('bad relation import is rejected without corrupting the current lookup')

    page.locator('#settingsBtn').click()
    page.locator('#formulaMode').select_option('excel')
    page.locator('#settingsForm button[type=submit]').click()
    page.locator('.item-row').first.locator('[data-field=fasteners]').fill('800')
    assert text_money(page.locator('#grandTotal').inner_text()) == '1703111,76'
    passed('Excel mode includes per-unit additive costs and excludes coating multiplier')

    page.reload(wait_until='networkidle')
    assert text_money(page.locator('#grandTotal').inner_text()) == '1703111,76'
    assert page.locator('#variantSelect option').count() == 3
    passed('drafts, variants, and imported reference data survive reload')

    with page.expect_download() as download:
        page.locator('#downloadBtn').click()
    target = ROOT / 'test-results' / 'downloaded-snapshot.json'
    target.parent.mkdir(exist_ok=True)
    download.value.save_as(target)
    snapshot = json.loads(target.read_text())
    assert snapshot['total'] == 1703111.76 and snapshot['config']['formulaMode'] == 'excel'
    assert len(snapshot['rows']) == 2 and 'weight' not in json.dumps(snapshot)
    passed('download contains complete reproducible quote and reference snapshots')

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
