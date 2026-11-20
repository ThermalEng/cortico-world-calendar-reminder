import { build } from 'esbuild';

await build({
  entryPoints: ['src/webui.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: 'dist/webui.js',
  minify: true,
});
