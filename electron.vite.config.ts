import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // main はデフォルト (src/main/index.ts → out/main/index.js / dist/main/index.js)
  main: {},
  // preload もデフォルト (src/preload/index.ts → out/preload/index.mjs / dist/preload/index.js)
  preload: {},
  renderer: {
    plugins: [react()]
  }
});