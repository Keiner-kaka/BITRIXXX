# Internal module contract

Vanilla browser JavaScript with ES modules, no build step. Node tests use ESM.

## Calculator (`src/calculator.js`)

Exports `parseNumber(value)`, `formatMoney(value, currency='RUB')`, `validateConfig(raw)`, `normalizeRelations(raw)`, `resolveRelations(productId, relations)`, `calculateQuote(rows, config)`.

`validateConfig` returns normalized `{version,currency,coatings:[{code,name,coefficient}],formulaMode:'catalog'|'excel',rounding:'unit'|'line'}`. Ignore legacy `prices_per_kg` (weight is excluded); do not require production names. Reject invalid coefficients, duplicate coating codes, unsupported currency/formula/rounding.

Rows: `{id,productId,productName,basePrice,currency,quantity,coatingCode,k1,k2,fasteners,extraCoating,delivery,drawingId,nonstandard}`. Numeric fields may be strings with decimal commas. Blank and non-finite input is invalid. K1/K2 allow zero and negative numbers. Quantity must be positive; allow decimal quantities. Base price and additive costs must be >= 0. Currency must match config (no automatic conversion).

`catalog`: unit = basePrice * coatingCoefficient * k1 * k2.
`excel`: unit = (basePrice + fasteners + extraCoating + delivery) * k1 * k2. This reproduces the attached Excel formula with catalog base replacing weight*rate; coating multiplier is NOT also applied in this mode.

Round monetary values to 2 decimals. `unit`: round unit, then round unit*quantity. `line`: round rawUnit*quantity, display rounded unit. Return `{rows:[{...row,unitPrice,lineTotal,coatingFactor,valid,errors:[]}],total,quantity,valid,errors:[]}`. Invalid rows must prevent readiness, not silently yield a usable partial total.

Relations JSON: `{version,product_drawings:[{product_id,product_name?,drawing_id,drawing_name?,drawing_file_id?}],drawing_kd:[{drawing_id,kit_id,kit_name?,file_id?,file_name?}]}`. IDs stored as strings. Multiple product drawings allowed; never silently pick one when ambiguous. KD records can contain many files per kit. `resolveRelations` returns `{drawings:[{id,name,fileId,kits:[{id,name,files:[{id,name}]}]}]}`. Reject duplicate product/drawing pairs, dangling drawing references, inconsistent drawing/kit metadata, malformed IDs.

## Bitrix (`src/bitrix.js`)

Class `BitrixAdapter` exports async `init()` -> `{connected,dealId}`, `call(method,params)`, `loadDeal(id)` -> `{id,title,companyName,currency,rows}`; `searchProducts(query)` -> `[{id,name,basePrice,currency,verified:true}]`; `getProduct(id)` same object; `loadDiskJson(fileId)` -> `{data,fileId,version,name}`; `registerPlacement(title)`; `loadHistory(folderId,dealId)` -> array snapshots; `saveSnapshot(folderId,snapshot)` -> `{fileId,name}`; `applyToDeal(dealId,snapshot)` -> write result.

Never write catalog fields. Use BX24 SDK from original app, application auth. Paginate lists; retrieve base catalog prices explicitly (`catalog.price.list`, filter price group BASE). Modern catalog then validated legacy fallback. Do not quietly treat missing prices as zero. Offers/SKU must be handled or report unsupported. Load deal product rows with existing negotiated prices. Placement registration is explicit setup button only.

Disk snapshots immutable and unique file names `yuzm-kp-deal-{dealId}-{variantId}-v{version}-{snapshotId}.json`. Shared history only when folder configured and upload/read supported; label local-only history honestly. API paths/values must not expose tokens in errors. Apply must replace entire deal rows only after UI shows explicit confirmation, recheck current deal rows against preview fingerprint, and read back values to verify. Prevent append duplicates. Adapter may accept expected fingerprint optional third arg to applyToDeal. Export `fingerprintRows(rows)`.

## UI (`index.html`, `styles.css`)

Other agent owns only HTML/CSS. Root owns app.js and adapters. All visible text Russian, calm blue/white UI based on supplied screenshot. No required weight/production fields.

DOM IDs: `connectionBadge`, `dealBadge`, `saveBtn`, `settingsBtn`, `status`, `companyName`, `shipmentDate`, `variantSelect`, `variantName`, `newVariantBtn`, `duplicateVariantBtn`, `historyBtn`, `itemsBody`, `addItemBtn`, `quantityTotal`, `grandTotal`, `formulaHint`, `createQuoteBtn`, `applyDealBtn`, `docsBody`, `downloadBtn`, `relationsSummary`, `relationsBody`, `toggleRelationsBtn`, `settingsDialog`, `settingsForm`, `closeSettingsBtn`, `dealIdInput`, `catalogQuery`, `searchCatalogBtn`, `catalogResults`, `relationsFileId`, `pricesFileId`, `historyFolderId`, `loadRemoteBtn`, `localRelationsInput`, `localPricesInput`, `formulaMode`, `roundingMode`, `registerPlacementBtn`, `connectDealBtn`, `resetDemoBtn`, `settingsError`, `historyDialog`, `closeHistoryBtn`, `historyBody`, `productDialog`, `closeProductBtn`, `productQuery`, `productSearchBtn`, `productResults`, `quoteDialog`, `closeQuoteBtn`, `quotePreview`, `printBtn`.

`itemsBody`: dynamic rows DIV grid: name/base-price, coating, quantity, k1/k2, drawing/KD, optional nonstandard/delete. `docsBody`: related files dynamically. Native dialogs with keyboard support. Settings include integration config, Disk imports, formula mode, rounding choice. If table headers need IDs use `columnHeaders`. Include `<script type="module" src="src/app.js"></script>` and original BX24 SDK `<script src="https://api.bitrix24.tech/api/v1/"></script>`.
