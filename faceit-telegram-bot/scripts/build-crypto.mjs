import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await build({
  absWorkingDir: root,
  stdin: {
    contents: "export { gcmsiv } from '@noble/ciphers/aes.js';\n",
    resolveDir: root,
    sourcefile: 'crypto-entry.js',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  treeShaking: true,
  legalComments: 'inline',
  outfile: 'tgcloud/lib/vendor/noble-gcmsiv.js',
});
