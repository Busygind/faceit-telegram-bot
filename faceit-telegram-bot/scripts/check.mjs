import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const errors = [];
async function walk(path) {
  const paths = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const item = resolve(path, entry.name);
    if (entry.isDirectory()) paths.push(...await walk(item));
    else if (entry.isFile()) paths.push(item);
    else errors.push(`${relative(root, item)}: unexpected symlink`);
  }
  return paths;
}
const files = await walk(root);
for (const file of files) {
  const name = relative(root, file);
  if (/\.(?:js|mjs)$/.test(file)) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) errors.push(`${name}: invalid JS syntax`);
  }
  if (name === 'bot') {
    const result = spawnSync('/bin/sh', ['-n', file], { encoding: 'utf8' });
    if (result.status !== 0) errors.push(`${name}: invalid shell syntax`);
  }
  if (name.startsWith('tgcloud/') && file.endsWith('.js')) {
    const source = await readFile(file, 'utf8');
    const vendor = name.includes('/vendor/');
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
      const target = match[1];
      if (target === 'sdk' || target.startsWith('sdk/')) continue;
      if (!target.startsWith('.') || !target.endsWith('.js')
          || !resolve(dirname(file), target).startsWith(resolve(root, 'tgcloud') + '/')) {
        errors.push(`${name}: unsupported import ${target}`);
      } else if (!files.includes(resolve(dirname(file), target))
          && !(name === 'tgcloud/lib/runtime.js' && target === './private-settings.js')) {
        errors.push(`${name}: missing import ${target}`);
      }
    }
    if (!vendor && /\b(?:Buffer|process|require|setTimeout|setInterval)\b/.test(source.replace(/\/\/[^\n]*/g, ''))) {
      errors.push(`${name}: unsupported Node/timer global`);
    }
  }
  if ((name === 'bot' || /\.(?:js|mjs|json|jsonc|md|txt|sql)$/.test(file)) && !/LICENSE/i.test(name)) {
    const source = await readFile(file, 'utf8');
    if (!source.endsWith('\n') || source.includes('\r') || /[\t ]+$/m.test(source)) errors.push(`${name}: formatting`);
  }
}
if (errors.length) { for (const error of errors) console.error(error); process.exitCode = 1; }
else console.log(`Checked ${files.length} files: syntax, imports, runtime constraints, LF/whitespace.`);
