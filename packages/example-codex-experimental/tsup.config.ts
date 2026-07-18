import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/brand-animation.ts'],
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  outDir: 'dist',
  clean: true,
  splitting: false,
  noExternal: [/^@loom\//, /^lottie-web(?:\/|$)/u],
  tsconfig: 'tsconfig.build.json',
});
