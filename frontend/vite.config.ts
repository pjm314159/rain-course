/// <reference types="vitest/config" />
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { compression } from 'vite-plugin-compression2'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    // 构建期生成 .gz 产物，配合 nginx 的 gzip_static 直出，省去运行时压缩 CPU
    compression({
      algorithms: ['gzip'],
      include: /\.(js|mjs|css|html|svg|json)$/,
      threshold: 1024,
    }),
  ],
  server: {
    proxy: {
      // 开发期把 /api、/ws 转发到本地后端（生产由 nginx 反代）
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
  },
})
