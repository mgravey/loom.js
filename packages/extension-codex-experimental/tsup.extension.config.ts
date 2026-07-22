import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/service-worker.ts', 'src/options.ts', 'src/callback.ts', 'src/brand-animation.ts'],
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  outDir: 'dist',
  clean: false,
  splitting: false,
  noExternal: [/^@mgravey\/loom-/, /^lottie-web(?:\/|$)/u],
  tsconfig: 'tsconfig.build.json',
});
