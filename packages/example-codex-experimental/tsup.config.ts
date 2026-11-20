import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/brand-animation.ts', 'src/chatgpt-callback.ts'],
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  outDir: 'dist',
  clean: true,
  splitting: false,
  noExternal: [/^@mgravey\/loom-/, /^lottie-web(?:\/|$)/u, /^jose(?:\/|$)/u],
  tsconfig: 'tsconfig.build.json',
});
