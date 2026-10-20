import * as THREE from 'three'
import type { Ctx } from '../core/Context'
import type { DayNight } from './DayNight'
import type { Audio } from './Audio'
import { rand, clamp } from '../config'

export type WeatherState = 'clear' | 'cloudy' | 'storm'
const GLOOM: Record<WeatherState, number> = { clear: 0, cloudy: 0.4, storm: 1 }
export const WEATHER_LABEL: Record<WeatherState, string> = { clear: '晴', cloudy: '多云', storm: '雷雨' }
export const isWeatherState = (s: unknown): s is WeatherState => s === 'clear' || s === 'cloudy' || s === 'storm'
/** 存档里的天气：状态 + 自然剩余时长 + 手动锁定剩余（游戏小时） */
export interface WeatherSave { state: WeatherState; remainHours: number; lockHours: number }

const RAIN_COUNT = 4000
const RAIN_BOX = 40

/**
 * 天气系统：clear/cloudy/storm 马尔可夫转移（每游戏小时抽一次，午后雷雨峰值），
 * 雨滴（LineSegments + shader 循环下落，零 CPU 更新）、闪电与雷声、雨声、路面变深。
 * 跳时（吃饭/睡觉/读档/调试 clock.set）不抽签；手动 set(…, true) 的天气锁定若干游戏小时，
 * 锁只按真实流逝的游戏时间消耗，期间既不抽签也不自然过期。
 */
export class Weather {
  state: WeatherState = 'clear'
  /** 平滑后的阴沉系数 0–1 */
  gloom = 0
  private remainHours = 0          // 当前状态剩余时长（游戏小时），0 表示按小时随机抽
  private lastHourTick = -1
  private lastJumpSeq = -1
  private lastAbs = -1
  /** 手动锁定剩余（游戏小时）；> 0 时不抽签、不自然过期 */
  private lockHours = 0
  private rain: THREE.LineSegments
  private rainMat: THREE.ShaderMaterial
  private rainLevel = 0
  private lightningIn = 8
  private flash = 0
  private flashHold = 0
  private thunderIn = -1
  private roads: THREE.MeshLambertMaterial[] = []
  private roadBase: THREE.Color[] = []
  private tmpV = new THREE.Vector3()

  constructor(private scene: THREE.Scene, private dayNight: DayNight, private audio: Audio) {
    const pos = new Float32Array(RAIN_COUNT * 2 * 3)
    const tail = new Float32Array(RAIN_COUNT * 2)
    for (let i = 0; i < RAIN_COUNT; i++) {
      const x = rand(-RAIN_BOX / 2, RAIN_BOX / 2), y = rand(0, RAIN_BOX), z = rand(-RAIN_BOX / 2, RAIN_BOX / 2)
      for (const k of [0, 1]) {
        const o = (i * 2 + k) * 3
        pos[o] = x; pos[o + 1] = y; pos[o + 2] = z
        tail[i * 2 + k] = k === 0 ? 0 : rand(0.5, 0.9)
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('aTail', new THREE.BufferAttribute(tail, 1))
    this.rainMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uOpacity: { value: 0 }, uBox: { value: RAIN_BOX }, uSpeed: { value: 20 } },
      vertexShader: `
        attribute float aTail;
        uniform float uTime, uBox, uSpeed; uniform vec3 uCenter;
        void main() {
          vec3 p = position;
          p.y = mod(p.y - uTime * uSpeed, uBox) - aTail;
          p.x += aTail * 0.25;
          p += uCenter - vec3(0.0, uBox * 0.5, 0.0);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `
        uniform float uOpacity;
        void main() { gl_FragColor = vec4(0.72, 0.8, 0.95, 0.5 * uOpacity); }`,
      transparent: true, depthWrite: false, fog: false,
    })
    this.rain = new THREE.LineSegments(geo, this.rainMat)
    this.rain.frustumCulled = false
    this.rain.visible = false
    scene.add(this.rain)
  }

  /** 世界就绪后读取路面材质（用于雨天变深） */
  attachWorld() {
    this.roads = (this.scene.userData.roads as THREE.MeshLambertMaterial[] | undefined) ?? []
    this.roadBase = this.roads.map((m) => m.color.clone())
  }

  /** 切换天气；manual = 手动指定（调试/剧情），锁定 lockHours 游戏小时不被整点抽签与自然过期改掉 */
  set(state: WeatherState, manual = false, lockHours = 3) {
    if (manual) this.lockHours = Math.max(0, lockHours)
    if (state === this.state) return
    this.state = state
    if (state === 'storm') { this.remainHours = rand(0.5, 1.5); this.lightningIn = rand(1, 4) }
    else if (state === 'cloudy') this.remainHours = rand(0.5, 1.2)
    else this.remainHours = 0
  }

  get rainIntensity() { return this.rainLevel }
  get locked() { return this.lockHours > 0 }

  serialize(): WeatherSave { return { state: this.state, remainHours: this.remainHours, lockHours: this.lockHours } }
  /** 读档恢复（旧存档无天气字段时保持现状）；阴沉/雨量直接到位，不从晴天慢慢渐变 */
  restore(d: WeatherSave | undefined) {
    if (!d || !isWeatherState(d.state)) return
    this.state = d.state
    this.remainHours = Math.max(0, Number(d.remainHours) || 0)
    this.lockHours = Math.max(0, Number(d.lockHours) || 0)
    this.gloom = GLOOM[d.state]
    this.rainLevel = d.state === 'storm' ? 1 : 0
  }

  update(dt: number, ctx: Ctx) {
    const clock = ctx.clock
    // 每游戏小时抽一次转移；跳时（jumpSeq 变了）只同步整点、不抽签
    const abs = clock.absHours, tick = Math.floor(abs)
    // 真实流逝的游戏时间（面板暂停时为 0，跳时不算）：消耗手动锁与自然时长
    let gameHoursDt = this.lastAbs >= 0 ? Math.max(0, abs - this.lastAbs) : 0
    this.lastAbs = abs
    if (clock.jumpSeq !== this.lastJumpSeq) { this.lastJumpSeq = clock.jumpSeq; this.lastHourTick = tick; gameHoursDt = 0 }
    if (tick !== this.lastHourTick) {
      if (this.lastHourTick >= 0 && this.lockHours <= 0) this.roll(clock.hour)
      this.lastHourTick = tick
    }
    // 锁定期间不自然过期
    if (this.lockHours > 0) this.lockHours = Math.max(0, this.lockHours - gameHoursDt)
    else if (this.remainHours > 0) {
      this.remainHours -= gameHoursDt
      if (this.remainHours <= 0) this.set(this.state === 'storm' ? 'cloudy' : 'clear')
    }

    // 阴沉与雨量平滑
    const gTarget = GLOOM[this.state]
    this.gloom += (gTarget - this.gloom) * (1 - Math.exp(-dt * 0.8))
    const rTarget = this.state === 'storm' ? 1 : 0
    this.rainLevel += (rTarget - this.rainLevel) * (1 - Math.exp(-dt * 1.2))
    this.dayNight.gloom = this.gloom

    // 雨滴跟随相机（向视线前方偏移，让画面里雨更密）
    const cam = ctx.cam.camera
    this.rainMat.uniforms.uTime.value = ctx.time
    this.rainMat.uniforms.uOpacity.value = this.rainLevel
    cam.getWorldDirection(this.tmpV)
    this.rainMat.uniforms.uCenter.value.copy(cam.position).addScaledVector(this.tmpV, 10).y += 8
    this.rain.visible = this.rainLevel > 0.02

    // 路面变深
    const wet = clamp(this.gloom, 0, 1)
    for (let i = 0; i < this.roads.length; i++) this.roads[i].color.copy(this.roadBase[i]).multiplyScalar(1 - 0.45 * wet)

    // 闪电与雷声
    if (this.state === 'storm' && this.rainLevel > 0.5) {
      this.lightningIn -= dt
      if (this.lightningIn <= 0) {
        this.lightningIn = rand(6, 20)
        this.flash = 1; this.flashHold = 2
        this.thunderIn = rand(0.3, 1.5)
      }
    }
    if (this.flashHold > 0) this.flashHold--
    else this.flash *= Math.exp(-dt * 22)
    this.dayNight.flash = this.flash
    if (this.thunderIn >= 0) {
      this.thunderIn -= dt
      if (this.thunderIn < 0) { this.audio.thunder(rand(0.6, 1)); this.thunderIn = -1 }
    }
    this.audio.setRain(this.rainLevel)
  }

  /** 整点抽签：14–17 点雷雨概率峰值 */
  private roll(hour: number) {
    const peak = hour >= 14 && hour < 17
    if (this.state === 'clear') {
      const r = Math.random()
      if (r < (peak ? 0.35 : 0.06)) this.set('storm')
      else if (r < (peak ? 0.55 : 0.16)) this.set('cloudy')
    } else if (this.state === 'cloudy' && this.remainHours <= 0) {
      const r = Math.random()
      if (r < (peak ? 0.3 : 0.08)) this.set('storm')
      else if (r < 0.5) this.set('clear')
    }
  }
}
