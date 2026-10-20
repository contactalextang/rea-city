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
    // three 核心压缩前约 630 kB、本身不可再拆；阈值放到 700 kB，超出仍会报警
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      input,
      output: {
        // 第三方库单独成块并起可读名字：three 核心 → three-*.js，three/examples 工具 → three-addons-*.js；
        // loaders（GLTFLoader）不进组，随 CharacterLibrary 的动态 import 单独成块按需加载
        codeSplitting: {
          groups: [
            // 核心先认领（优先级高），否则 addons 组会把它依赖的核心一并卷进去
            { name: 'three', test: /[\\/]node_modules[\\/]three[\\/]build[\\/]/, priority: 2 },
            { name: 'three-addons', test: /[\\/]node_modules[\\/]three[\\/]examples[\\/]jsm[\\/](?!loaders[\\/])/, priority: 1 },
          ],
        },
      },
    },
  },
})
