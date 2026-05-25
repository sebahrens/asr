import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    asr: 'src/index.ts',
  },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  outExtension: () => ({ js: '.mjs' }),
  noExternal: [/.*/],
  external: ['keytar'],
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'module';\nconst require = createRequire(import.meta.url);",
  },
  clean: true,
  dts: false,
});
