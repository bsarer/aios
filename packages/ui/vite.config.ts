import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `pnpm --filter @aios/ui dev` proxies the WebSocket to a running aios-core.
// Start core with AIOS_UI_DEV_ORIGIN=http://localhost:5173 so it accepts the dev origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/ws': { target: 'ws://127.0.0.1:7777', ws: true } },
  },
});
