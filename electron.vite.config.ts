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
    plugins: [react()]
  }
})
