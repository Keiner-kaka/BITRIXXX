/* Load the official BX24 library and report failures without exposing auth data. */
(function (root) {
  'use strict';
  const sources = ['https://api.bitrix24.tech/api/v1/', 'https://api.bitrix24.com/api/v1/'];
  const messages = {
    OUTSIDE_FRAME: 'Страница открыта вне фрейма приложения. Откройте конструктор через пункт приложения в Битрикс24.',
    FRAME_CONTEXT_MISSING: 'Фрейм открыт, но Битрикс24 не передал контекст приложения. Откройте его через «Перейти к приложению» в карточке интеграции. Если ошибка повторится, скопируйте диагностику из настроек.',
    SDK_LOAD_FAILED: 'Не удалось загрузить библиотеку BX24 с серверов Битрикс24. Проверьте блокировщик браузера и доступ к api.bitrix24.tech и api.bitrix24.com, затем повторите подключение.',
    SDK_LOAD_TIMEOUT: 'Загрузка библиотеки BX24 ещё не завершилась. Проверьте соединение и повторите подключение.',
    SDK_CONTEXT_REJECTED: 'Библиотека BX24 загрузилась, но не приняла контекст фрейма. Скопируйте диагностику из настроек для проверки запуска приложения.',
    SDK_EXECUTION_FAILED: 'Файл библиотеки BX24 загрузился, но библиотека не запустилась. Проверьте диагностику подключения в настройках.',
  };
  let chain = null, pending = null;
  let state = {code: 'NOT_STARTED', sdk_source: null};
  const available = () => Boolean(root.BX24?.init && root.BX24?.callMethod);
  function context() {
    const parts = String(root.name || '').split('|');
    return {in_frame: root.parent !== root, frame_context_present: Boolean(parts[0] && parts[2])};
  }
  function result(code, source = state.sdk_source) {
    state = {code, sdk_source: source};
    return {sdk: code === 'SDK_READY' ? root.BX24 : null, code, message: messages[code] || ''};
  }
  function loadSource(source) {
    return new Promise(resolve => {
      const script = root.document.createElement('script');
      script.src = source;
      script.async = true;
      let rejectedContext = false;
      const onError = event => {
        if (event.message === 'Unable to initialize Bitrix24 JS library!') rejectedContext = true;
      };
      root.addEventListener('error', onError);
      const finish = code => {
        root.removeEventListener('error', onError);
        script.onload = script.onerror = null;
        script.remove();
        resolve({code, source});
      };
      script.onload = () => finish(available() ? 'SDK_READY'
        : root.BX24 === null || rejectedContext ? 'SDK_CONTEXT_REJECTED' : 'SDK_EXECUTION_FAILED');
      script.onerror = () => finish(rejectedContext ? 'SDK_CONTEXT_REJECTED' : 'SDK_LOAD_FAILED');
      root.document.head.append(script);
    });
  }
  async function load() {
    if (available()) return result('SDK_READY');
    const frame = context();
    if (!frame.in_frame) return result('OUTSIDE_FRAME');
    if (!frame.frame_context_present) return result('FRAME_CONTEXT_MISSING');
    if (pending) return pending;
    if (!chain) {
      chain = (async () => {
        for (const source of sources) {
          state = {code: 'SDK_LOADING', sdk_source: source};
          const outcome = await loadSource(source);
          if (['SDK_READY', 'SDK_CONTEXT_REJECTED'].includes(outcome.code)) return outcome;
          if (source === sources.at(-1)) return outcome;
        }
        return {code: 'SDK_LOAD_FAILED', source: sources.at(-1)};
      })();
      // Keep an unfinished request: a timeout must not start a second SDK copy
      // that could overwrite the first one when its network response arrives.
      chain.then(() => { chain = null; });
    }
    const active = chain;
    pending = (async () => {
      let timer;
      try {
        const outcome = await Promise.race([
          active,
          new Promise(resolve => { timer = root.setTimeout(() => resolve({code: 'SDK_LOAD_TIMEOUT', source: state.sdk_source}), 10000); }),
        ]);
        return result(outcome.code, outcome.source);
      } finally {
        root.clearTimeout(timer);
        pending = null;
      }
    })();
    return pending;
  }
  root.YUZM_BX24 = {
    load,
    diagnostics() {
      return {
        ...context(),
        ...state,
        sdk_available: available(),
        page_protocol: root.location.protocol,
      };
    },
  };
  // The app renders before awaiting this load, so the UI remains usable.
  load();
})(window);
