/** Optional same-origin server when the portal's DOWNLOAD_URL disallows browser CORS.
 * Run behind HTTPS; current OAuth tokens exist only for the lifetime of one POST.
 */
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, resolve, extname, sep} from 'node:path';
import {validateTextTemplates, MAX_TEXT_BYTES} from './src/text-templates.js';
const root = dirname(fileURLToPath(import.meta.url));
const hostname = value => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(value) && value.includes('.') && !/^\d+(\.\d+){3}$/.test(value) && !value.includes('..');
const list = value => String(value || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
export async function limitedText(response, max = MAX_TEXT_BYTES) {
  if (!response.ok || Number(response.headers.get('content-length')) > max) throw new Error('UPSTREAM_RESPONSE');
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try {
    while (true) {
      const {value, done} = await reader.read(); if (done) break;
      length += value.byteLength; if (length > max) throw new Error('TOO_LARGE'); chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}
export async function readDiskJson(input, {allowedDomains, downloadHosts = [], fetcher = fetch} = {}) {
  const domain = String(input?.domain || '').toLowerCase();
  if (!hostname(domain) || !allowedDomains?.includes(domain) || !/^[1-9]\d*$/.test(String(input.fileId)) || !Number.isSafeInteger(Number(input.fileId)) || typeof input.accessToken !== 'string' || !input.accessToken || input.accessToken.length > 4096) throw new Error('INVALID_REQUEST');
  const signal = AbortSignal.timeout(20000);
  const metadataResponse = await fetcher(`https://${domain}/rest/disk.file.get.json`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: Number(input.fileId), auth: input.accessToken}), redirect: 'error', signal});
  const metadata = JSON.parse(await limitedText(metadataResponse)).result;
  if (String(metadata?.ID) !== String(input.fileId) || !/\.json$/i.test(metadata.NAME) || Number(metadata.SIZE) > MAX_TEXT_BYTES) throw new Error('INVALID_FILE');
  let url = new URL(metadata.DOWNLOAD_URL);
  for (let redirect = 0; redirect < 4; redirect++) {
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || ![domain, ...downloadHosts].includes(url.hostname.toLowerCase()) || !hostname(url.hostname)) throw new Error('DOWNLOAD_HOST_DENIED');
    const response = await fetcher(url.href, {redirect: 'manual', signal, headers: {'Accept': 'application/json'}});
    if ([301,302,303,307,308].includes(response.status)) {
      url = new URL(response.headers.get('location'), url); continue;
    }
    return validateTextTemplates(JSON.parse(await limitedText(response)));
  }
  throw new Error('TOO_MANY_REDIRECTS');
}
export function createAppServer({appOrigin = process.env.APP_ORIGIN, allowedDomains = list(process.env.BITRIX_ALLOWED_DOMAINS), downloadHosts = list(process.env.BITRIX_DOWNLOAD_HOSTS), fetcher = fetch} = {}) {
  return http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/disk-json') {
        if (request.method !== 'POST') {response.writeHead(405); response.end(); return;}
        if (!appOrigin || !appOrigin.startsWith('https://') || request.headers.origin !== appOrigin || !String(request.headers['content-type']).startsWith('application/json')) {response.writeHead(403); response.end('{"error":"ORIGIN_DENIED"}'); return;}
        const chunks = []; let length = 0;
        for await (const chunk of request) {length += chunk.length; if (length > 16384) throw new Error('REQUEST_TOO_LARGE'); chunks.push(chunk);}
        const result = await readDiskJson(JSON.parse(Buffer.concat(chunks).toString('utf8')), {allowedDomains, downloadHosts, fetcher});
        response.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'}); response.end(JSON.stringify(result)); return;
      }
      if (!['GET','HEAD'].includes(request.method)) {response.writeHead(405); response.end(); return;}
      const path = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      if (!/^\/(?:index\.html|admin\.html|styles\.css|src\/[\w-]+\.js|data\/[\w.-]+\.json)$/.test(path)) {response.writeHead(404); response.end(); return;}
      const filename = resolve(root, '.' + path);
      if (!filename.startsWith(root + sep)) throw new Error('INVALID_PATH');
      const data = await readFile(filename);
      const type = {'.html':'text/html','.js':'application/javascript','.json':'application/json','.css':'text/css'}[extname(filename)];
      response.writeHead(200, {'Content-Type': type + '; charset=utf-8'}); response.end(request.method === 'HEAD' ? undefined : data);
    } catch {
      // Neither upstream URLs/errors nor request bodies are logged or returned.
      response.writeHead(502, {'Content-Type': 'application/json'}); response.end('{"error":"DISK_JSON_UNAVAILABLE"}');
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  createAppServer().listen(Number(process.env.PORT || 8080), '127.0.0.1');
}
