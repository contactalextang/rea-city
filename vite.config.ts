import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    // 多页：主游戏 + 真实世界独立查看页（dev/world.html，验证区块加载用）
    rollupOptions: { input: { main: 'index.html', world: 'dev/world.html' } },
  },
})
