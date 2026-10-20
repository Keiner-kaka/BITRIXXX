/** One editable draft per deal. Legacy versions and document caches are discarded. */
export function normalizeStoredDraft(value, scope) {
  const old = value?.state;
  if (!old || old.scope !== scope || ![1, 2, 3].includes(old.schemaVersion)) return null;
  const selected = old.schemaVersion === 3 ? {draft: old.draft} :
    old.variants?.find(item => item.id === old.selectedVariantId) ?? old.variants?.[0];
  const source = selected?.draft;
  if (!source || !Array.isArray(source.rows)) return null;
  const context = selected.context ?? value;
  const settings = {...old.settings};
  for (const field of ['historyFolderId', 'relationsFileId', 'documentFields', 'defaultDocumentTemplateId']) delete settings[field];
  const draft = {
    companyName: source.companyName ?? '', currency: source.currency ?? 'RUB', rows: source.rows,
    documentFields: source.documentFields ?? {}, managerOverrides: source.managerOverrides,
    managerUserId: source.managerUserId ?? '', managerSignatureReference: source.managerSignatureReference ?? null,
  };
  return {state: {schemaVersion: 3, scope, activeDealId: old.activeDealId ?? null, settings, draft},
    config: context.config ?? value.config, priceMeta: context.priceMeta ?? value.priceMeta,
    metalPrices: Object.hasOwn(context, 'metalPrices') ? context.metalPrices : value.metalPrices ?? null, metalPriceMeta: context.metalPriceMeta ?? value.metalPriceMeta};
}
