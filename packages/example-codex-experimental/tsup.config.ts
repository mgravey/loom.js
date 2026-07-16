import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  outDir: 'dist',
  clean: true,
  splitting: false,
  noExternal: [/^@loom\//],
  tsconfig: 'tsconfig.build.json',
});
