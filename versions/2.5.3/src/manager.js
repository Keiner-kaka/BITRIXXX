/** Shared, per-employee signature settings. Images themselves stay outside the app. */
export function signatureReference(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    if (value.kind === 'disk') return signatureReference(value.fileId);
    if (value.kind === 'url') return signatureReference(value.url);
    throw new Error('Некорректная настройка подписи сотрудника.');
  }
  if (!['string', 'number'].includes(typeof value)) throw new Error('Укажите ID файла на Диске или прямую ссылку на изображение.');
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) > 0) return {kind: 'disk', fileId: String(Number(text))};
  let url;
  try { url = new URL(text); } catch { throw new Error('Укажите ID файла на Диске или прямую HTTP(S)-ссылку на изображение.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || text.length > 4096) {
    throw new Error('Ссылка подписи должна быть HTTP(S), без логина и пароля в адресе.');
  }
  url.hash = '';
  return {kind: 'url', url: url.href};
}

export function signatureSourceText(reference) {
  const ref = signatureReference(reference);
  return ref ? ref.kind === 'disk' ? ref.fileId : ref.url : '';
}

export function managerValues(profile) {
  return {YuzmManagerPosition: profile.position || '', YuzmManagerName: profile.name || '',
    YuzmManagerPhone: profile.workPhone || '', YuzmManagerEmail: profile.email || ''};
}
