<?php
// POST-compatible entry point for a self-hosted boxed Bitrix24 application.
// Only non-secret placement context is passed to the browser. The BX24 SDK
// obtains application authentication from the embedding portal.
header('Content-Type: text/html; charset=utf-8');
$placementOptions = $_REQUEST['PLACEMENT_OPTIONS'] ?? '{}';
$options = is_string($placementOptions) ? json_decode($placementOptions, true) : [];
$dealId = is_array($options) ? ($options['ID'] ?? null) : null;
$context = ['dealId' => is_scalar($dealId) && preg_match('/^[1-9][0-9]*$/', (string)$dealId) ? (string)$dealId : null];
$html = file_get_contents(__DIR__ . '/index.html');
$contextScript = '<script>window.B24_PLACEMENT_CONTEXT=' .
    json_encode($context, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) .
    ';</script>';
echo str_replace('<head>', '<head>' . $contextScript, $html);
