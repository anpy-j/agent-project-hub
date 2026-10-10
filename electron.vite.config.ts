import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig({
  main: {
    // Bundle LinkeDOM's ESM entry and its ESM-only selector dependencies for Electron 31.
    plugins: [externalizeDepsPlugin({ exclude: ['linkedom'] })],
    resolve: {
      alias: {
        '@main': resolve('electron'),
        // Article extraction needs DOM parsing, not native drawing. Resolve the optional
        // canvas dependency to LinkeDOM's own fallback in development and production.
        canvas: resolve('node_modules/linkedom/commonjs/canvas-shim.cjs')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('electron/main.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('electron/preload.ts') }
      }
    }
  },
  renderer: {
    root: 'src',
    resolve: {
      alias: {
        '@': resolve('src'),
        '@renderer': resolve('src')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/index.html') }
      }
    },
    plugins: [
      vue(),
      AutoImport({ resolvers: [ElementPlusResolver()] }),
      Components({ resolvers: [ElementPlusResolver()] })
    ]
  }
})
