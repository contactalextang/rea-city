import * as THREE from 'three'

/**
 * P14.6 外墙照片扫描细节（仅 fx=high）：public/assets/facade/detail.webp（scripts/facade-tex/build.ts 产出，ambientCG CC0）
 * 4 层纵向拼成 1024×4096，切成 DataArrayTexture 的 4 层；每层 R = 亮度比 ×0.5，G/B = NormalGL xy（不带颜色）。
 * 层序（FacadeShader 层号）：0 涂料抹灰 / 1 风化混凝土 / 2 店屋老抹灰 / 3 方砖。
 *
 * 懒加载：DayNight 首次进入 fx=high 才 fetch，low/off 永不下载；加载前与失败时绑定 1×1×4 中性占位（0.5 = 无变化），
 * FacadeShader 共享这里的 uniforms（全城仍 1 个 program），切档只改 uFacDetailOn，不重编译。
 * `?facdetail=0` 关闭（前后对比）。
 */
const URL = '/assets/facade/detail.webp'
const SIZE = 1024
const LAYERS = 4

function neutral(): THREE.DataArrayTexture {
  const t = new THREE.DataArrayTexture(new Uint8Array(4 * LAYERS).fill(128), 1, 1, LAYERS)
  t.needsUpdate = true
  return t
}

/** FacadeShader 在 onBeforeCompile 里挂这两个 uniform（同一对象引用） */
export const FACADE_DETAIL = {
  uFacDetailTex: { value: neutral() as THREE.DataArrayTexture },
  uFacDetailOn: { value: 0 },
}

const disabled = new URLSearchParams(location.search).get('facdetail') === '0'
let loading: Promise<void> | null = null

async function load(renderer: THREE.WebGLRenderer): Promise<void> {
  const res = await fetch(URL)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  // 不做色彩空间转换：R 是线性亮度比、G/B 是法线
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  if (bmp.width !== SIZE || bmp.height !== SIZE * LAYERS) throw new Error(`尺寸 ${bmp.width}×${bmp.height}`)
  const cv = document.createElement('canvas')
  cv.width = bmp.width; cv.height = bmp.height
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无 2D 上下文')
  ctx.drawImage(bmp, 0, 0)
  bmp.close()
  const data = new Uint8Array(ctx.getImageData(0, 0, cv.width, cv.height).data.buffer)
  const tex = new THREE.DataArrayTexture(data, SIZE, SIZE, LAYERS)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
  tex.needsUpdate = true
  const old = FACADE_DETAIL.uFacDetailTex.value
  FACADE_DETAIL.uFacDetailTex.value = tex
  old.dispose()
}

/** DayNight 按画质调用：high 开（首次触发加载），其它档关 */
export function setFacadeDetail(on: boolean, renderer: THREE.WebGLRenderer): void {
  on = on && !disabled
  FACADE_DETAIL.uFacDetailOn.value = on ? 1 : 0
  if (on && !loading) {
    loading = load(renderer).catch((e) => console.warn('[FacadeDetail] 细节贴图加载失败，保持无细节：', e))
  }
}
