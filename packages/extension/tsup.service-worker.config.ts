import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/service-worker.ts'],
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  outDir: 'dist',
  clean: false,
  splitting: false,
  noExternal: [/^@mgravey\/loom-/],
  tsconfig: 'tsconfig.build.json',
});
