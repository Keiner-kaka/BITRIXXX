import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const files = ['versions/2.7.0/server.mjs'];
for (const root of ['src','versions/2.7.0/src']) {
  files.push(...(await readdir(root)).filter(name => name.endsWith('.js')).map(name => `${root}/${name}`));
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {stdio:'inherit'});
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked: ${files.length} JavaScript modules`);
