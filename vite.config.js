import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        background: 'background.js',
        content: 'content.js',
        popup: 'popup/popup.html',
      },
      output: {
        entryFileNames: '[name].js',
      },
    },
  },
});