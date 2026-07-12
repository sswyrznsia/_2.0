import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            rolldownOptions: { external: ['archiver', 'unzipper'] },
          },
        },
      },
      preload: { input: 'electron/preload.ts' },
    }),
  ],
  build: { sourcemap: false },
})
