import { defineConfig } from 'vite';

// Renderer lab for development only: `npx vite --config vite.lab.config.ts`, then open /lab.html.
// No Cloudflare plugin, so it never touches the Worker or Durable Object state.
export default defineConfig({
  cacheDir: 'node_modules/.vite-lab',
  server: { port: 5180, strictPort: true },
  build: { assetsInlineLimit: 0 },
});
