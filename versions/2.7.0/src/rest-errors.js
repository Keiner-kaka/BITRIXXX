/** Safe user-facing REST details. Never display upstream URLs or credential values. */
export function safeErrorText(value) {
  let text = typeof value === 'string' ? value : '';
  text = text.replace(/\\\//g, '/').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"');
  for (let i = 0; i < 2; i++) text = text.replace(/(?:%[0-9a-f]{2})+/gi, part => {
    try { return decodeURIComponent(part); } catch { return '[скрыто]'; }
  });
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, '[адрес скрыт]')
    .replace(/\/rest\/\d+\/[^/\s"'<>?]+/gi, '/rest/[секрет скрыт]')
    .replace(/\b(Bearer|Basic)\s+[\w.+/=-]+/gi, '$1 [скрыто]')
    .replace(/(\b(?:access_token|refresh_token|client_secret|webhook(?:_secret|_token)?|auth(?:\[[^\]]+\])?|token|signature|password|authorization|secret|токен|пароль|секрет)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}<>"'{\]]+)/gi, '$1[скрыто]')
    .replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ');
  return text.trim().slice(0, 1500);
}
export function formatActionError(action, error) {
  const rest = error?.method ? error : error?.cause?.method ? error.cause : null;
  let detail = safeErrorText(error?.message || String(error)) || 'Неизвестная ошибка.';
  if (rest === error && rest.description) detail = safeErrorText(rest.description);
  else if (rest?.description) detail += ' ' + safeErrorText(rest.description);
  const method = /^[a-zA-Z0-9_.]+$/.test(rest?.method || '') ? rest.method : '';
  const code = /^[a-zA-Z0-9_.-]{1,80}$/.test(rest?.code || '') ? rest.code : 'CLIENT_ERROR';
  return `${safeErrorText(action)}: ${detail}${method ? ` Метод: ${method}. Код: ${code}.` : ''}`;
}
