import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// 多页：主游戏 + dev/*.html 独立查看页（world.html 真实世界区块、chars.html 角色库）
const input: Record<string, string> = { main: resolve(import.meta.dirname, 'index.html') }
for (const f of readdirSync(resolve(import.meta.dirname, 'dev'))) if (f.endsWith('.html')) input[f.replace(/\.html$/, '')] = resolve(import.meta.dirname, 'dev', f)

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: { input },
  },
})
