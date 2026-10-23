import {normalizeIntegrationConfig, validateFieldMappings, positiveId} from './integration-config.js';
import {formatActionError, safeErrorText} from './rest-errors.js';

/** Read-only, independent probes. `methods` is not an access-control contract. */
export async function diagnoseIntegration(adapter, settings, disk, raw, onResult = () => {}) {
  const probes = [
    {key: 'fields', label: 'Поля сделки', run: async () => {
      const fields = await settings.fields();
      validateFieldMappings(normalizeIntegrationConfig({fields: raw.fields}), fields);
      return 'Существование, типы и назначения полей проверены.';
    }},
    {key: 'documents', label: 'Генератор документов', run: async () => {
      const templates = await adapter._list('crm.documentgenerator.template.list', {select: ['id', 'name'], order: {id: 'ASC'}}, 'templates');
      return `Прямой вызов crm.documentgenerator.template.list выполнен. Прочитано шаблонов: ${templates.length}. Право создания документов не проверялось.`;
    }},
    {key: 'texts', label: 'Файл текстов', run: async () => {
      const resources = normalizeIntegrationConfig({resources: {textFileId: raw.resources?.textFileId, diskProxyPath: raw.resources?.diskProxyPath || ''}}).resources;
      positiveId(resources.textFileId, 'Файл текстов');
      const texts = await disk.read(resources.textFileId, resources.diskProxyPath);
      return `Файл прочитан, структура JSON проверена. Версия: ${texts.version}. Право обновления не проверялось.`;
    }},
    {key: 'folder', label: 'Папка текстов', optional: !raw.resources?.textFolderId, run: async () => {
      const id = positiveId(raw.resources.textFolderId, 'Папка текстов');
      const folder = await adapter.call('disk.folder.get', {id: Number(id)});
      if (String(folder?.ID) !== id || folder.TYPE && folder.TYPE !== 'folder') throw new Error('Не подтверждена папка текстов на Диске.');
      await adapter._list('disk.folder.getchildren', {id: Number(id)});
      return 'Папка и список содержимого прочитаны. Право загрузки файлов не проверялось.';
    }},
  ];
  const references = raw.resources?.referenceFileIds;
  if (!Array.isArray(references)) probes.push({key: 'references', label: 'Дополнительные файлы', run: async () => {throw new Error('ID справочных файлов должны быть массивом.');}});
  else if (!references.length) probes.push({key: 'references', label: 'Дополнительные файлы', optional: true});
  else for (const [index, value] of references.entries()) probes.push({key: `reference-${index}`, label: /^[1-9]\d*$/.test(String(value)) ? `Дополнительный файл #${value}` : `Дополнительный файл ${index + 1}`, run: async () => {
    const id = positiveId(value, 'Справочный файл');
    const file = await adapter.call('disk.file.get', {id: Number(id)});
    if (String(file?.ID) !== id || file.TYPE && file.TYPE !== 'file') throw new Error('Не подтверждён справочный файл #' + id);
    return 'Доступность чтения подтверждена. Право изменения не проверялось.';
  }});
  return Promise.all(probes.map(async probe => {
    let result;
    if (probe.optional) result = {key: probe.key, label: probe.label, state: 'skipped', message: 'Не указано; необязательная настройка.'};
    else {
      try { result = {key: probe.key, label: probe.label, state: 'ok', message: await probe.run()}; }
      catch (error) { result = {key: probe.key, label: probe.label, state: 'error', message: formatActionError('Проверка не пройдена', error)}; }
    }
    result.label = safeErrorText(result.label); result.message = safeErrorText(result.message);
    onResult(result); return result;
  }));
}
