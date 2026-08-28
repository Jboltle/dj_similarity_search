import { defineConfig } from 'vite';

/**
 * Electron loads dist/index.html via the file:// protocol (see
 * electron/main.js -> win.loadFile). Vite defaults to absolute asset URLs
 * (`/assets/...`), which under file:// resolve to the filesystem root and
 * silently fail — you get an unstyled, script-less page.
 *
 * `base: './'` makes Vite emit relative paths (`./assets/...`) which work
 * under both file:// (packaged Electron app) and http:// (Vite dev server).
 */
export default defineConfig({
  root: '.',
  base: './',
  publicDir: 'public',
  server: {
    port: 5173,
    open: false,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    assetsInlineLimit: 0,
  },
});
