import { defineConfig } from 'vite';

// base relative : le site fonctionne aussi bien à la racine que sous /configurateur-auto/ (GitHub Pages)
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
});
