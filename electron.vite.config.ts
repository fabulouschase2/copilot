import path from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    // Stage 10 finding: sandboxed preloads cannot require() external modules
    // (crashed with "module not found: zod" in production builds only, taking
    // the whole UI down). Bundle all preload dependencies instead.
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })]
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        // Two documents: the main workspace and the frameless private overlay
        // (Phase 6). Both share the same preload bridge.
        input: {
          index: path.join(__dirname, 'src/renderer/index.html'),
          overlay: path.join(__dirname, 'src/renderer/overlay.html')
        }
      }
    }
  }
})
