import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  outDir: 'dist',
  clean: true,
  splitting: false,
  noExternal: [/^@mgravey\/loom-/],
  tsconfig: 'tsconfig.build.json',
});
