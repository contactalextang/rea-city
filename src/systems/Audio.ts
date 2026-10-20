import type { Ctx } from '../core/Context'
import type { Vehicle } from '../entities/Vehicle'
import type { Poi } from './Poi'
import { Music } from './Music'

/** 新加坡 MRT 进站提示音 "叮-咚-叮"（Hz） */
const MRT_CHIME = [1318.5, 987.8, 1318.5]

/**
 * WebAudio 合成音效：引擎、警笛、撞击、雨声、雷声、喇叭，以及环境音（城市车流底噪、鸟鸣/蟋蟀、
 * MRT 进站提示音、路口行人过街提示音、交通车被挡鸣笛）与程序合成背景音乐（见 Music）。无外部音频文件
 */
export class Audio {
  private ac: AudioContext | null = null
  private engine: OscillatorNode | null = null
  private engineGain: GainNode | null = null
  private siren: OscillatorNode | null = null
  private sirenGain: GainNode | null = null
  private noise: AudioBuffer | null = null
  private master: GainNode | null = null
  private rainGain: GainNode | null = null
  private rumble: AudioBuffer | null = null
  /** 总音量 0–1（设置页可调） */
  private masterVol = 1
  private out: GainNode | null = null
  private rainLevel = 0
  // ---- 环境音状态 ----
  private trafficGain: GainNode | null = null
  private ambT = 0
  private birdIn = 3
  private cricketIn = 1
  private mrtIn = 0
  private mrtPois: Poi[] | null = null
  private walkBeepIn = 0
  /** 最近的信号灯路口：{ 距离, 行人是否绿灯 }（每 0.25 s 刷新） */
  private nearSignal: { d: number; green: boolean } | null = null
  private blocked = new Map<Vehicle, { t: number; cool: number }>()
  // ---- 撞击音节流 ----
  private lastCrashAt = -1
  private lastCrashImp = 0
  /** 实际播放过的撞击音次数（测试用） */
  crashCount = 0
  // ---- 背景音乐 ----
  private music: Music | null = null
  private musicOn = true

  /** 必须在用户手势后调用 */
  unlock() {
    if (this.ac) return
    try {
      this.ac = new AudioContext()
      const ac = this.ac
      // out = 总音量；master = 原混音（0.6）；枪声/撞击/喇叭直连 out
      const out = ac.createGain(); out.gain.value = this.masterVol; out.connect(ac.destination)
      this.out = out
      const master = ac.createGain(); master.gain.value = 0.6; master.connect(out)
      this.master = master
      this.engine = ac.createOscillator(); this.engine.type = 'sawtooth'
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400
      this.engineGain = ac.createGain(); this.engineGain.gain.value = 0
      this.engine.connect(lp).connect(this.engineGain).connect(master); this.engine.start()
      this.siren = ac.createOscillator(); this.siren.type = 'square'
      this.sirenGain = ac.createGain(); this.sirenGain.gain.value = 0
      this.siren.connect(this.sirenGain).connect(master); this.siren.start()
      const len = ac.sampleRate * 0.3
      this.noise = ac.createBuffer(1, len, ac.sampleRate)
      const d = this.noise.getChannelData(0)
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2
      // 雷声用的长白噪（3 s，无包络）
      const rl = ac.sampleRate * 3
      this.rumble = ac.createBuffer(1, rl, ac.sampleRate)
      const rd = this.rumble.getChannelData(0)
      for (let i = 0; i < rl; i++) rd[i] = Math.random() * 2 - 1
      // 持续雨声：2 s 白噪循环 → 带通 → 增益（默认 0，暴雨时淡入）
      const rain = ac.createBufferSource(); rain.buffer = this.rumble; rain.loop = true
      const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 500
      const rlp = ac.createBiquadFilter(); rlp.type = 'lowpass'; rlp.frequency.value = 2600
      this.rainGain = ac.createGain(); this.rainGain.gain.value = 0
      rain.connect(hp).connect(rlp).connect(this.rainGain).connect(master); rain.start()
      // 城市车流底噪：同一段白噪（偏移起点避免与雨声相关）→ 低通 → 增益（按附近车流量调）
      const hum = ac.createBufferSource(); hum.buffer = this.rumble; hum.loop = true
      const hlp = ac.createBiquadFilter(); hlp.type = 'lowpass'; hlp.frequency.value = 260
      const hpk = ac.createBiquadFilter(); hpk.type = 'peaking'; hpk.frequency.value = 90; hpk.gain.value = 3
      this.trafficGain = ac.createGain(); this.trafficGain.gain.value = 0
      hum.connect(hlp).connect(hpk).connect(this.trafficGain).connect(master); hum.start(0, 1.37)
      this.music = new Music(ac, out)
      if (!this.musicOn) this.music.setEnabled(false)
    } catch { this.ac = null }
  }

  update(time: number, inVehicle: boolean, speed: number, throttle: number, stars: number, policeDist: number) {
    if (!this.ac) return
    const t = this.ac.currentTime
    const rpm = inVehicle ? 55 + Math.abs(speed) * 3.2 + Math.abs(throttle) * 12 : 0
    this.engine!.frequency.setTargetAtTime(Math.max(40, rpm), t, 0.08)
    this.engineGain!.gain.setTargetAtTime(inVehicle ? 0.09 + Math.abs(throttle) * 0.05 : 0, t, 0.1)
    const sirenOn = stars > 0 && policeDist < 160
    const vol = sirenOn ? 0.035 * (1 - Math.min(1, policeDist / 160)) + 0.005 : 0
    this.sirenGain!.gain.setTargetAtTime(vol, t, 0.1)
    this.siren!.frequency.setTargetAtTime(Math.floor(time * 2) % 2 === 0 ? 720 : 960, t, 0.02)
  }

  gunshot() {
    if (!this.ac || !this.noise) return
    const t = this.ac.currentTime
    const src = this.ac.createBufferSource(); src.buffer = this.noise
    const g = this.ac.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.01, t + 0.12)
    const hp = this.ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 600
    src.connect(hp).connect(g).connect(this.out!); src.start(); src.stop(t + 0.15)
    const osc = this.ac.createOscillator(); osc.type = 'square'; osc.frequency.setValueAtTime(180, t); osc.frequency.exponentialRampToValueAtTime(50, t + 0.08)
    const og = this.ac.createGain(); og.gain.setValueAtTime(0.25, t); og.gain.exponentialRampToValueAtTime(0.01, t + 0.1)
    osc.connect(og).connect(this.out!); osc.start(); osc.stop(t + 0.1)
  }

  /** 撞击音：只由玩家自己的碰撞触发；轻擦不响，0.35 s 内同等力度不重复（贴墙蹭不再连响） */
  crash(impulse: number) {
    if (!this.ac || !this.noise || impulse < 4) return
    const t = this.ac.currentTime
    if (t - this.lastCrashAt < 0.35 && impulse < this.lastCrashImp * 1.5) return
    this.lastCrashAt = t; this.lastCrashImp = impulse; this.crashCount++
    const src = this.ac.createBufferSource(); src.buffer = this.noise
    const g = this.ac.createGain(); g.gain.value = Math.min(0.5, impulse * 0.035)
    const lp = this.ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900
    src.connect(lp).connect(g).connect(this.master!); src.start()
  }

  /** 雨声音量 0–1（每帧调用，平滑淡入淡出） */
  setRain(level: number) {
    this.rainLevel = Math.max(0, level)
    if (!this.ac || !this.rainGain) return
    this.rainGain.gain.setTargetAtTime(Math.max(0, level) * 0.16, this.ac.currentTime, 0.4)
  }

  /** 雷声：白噪 → 低通扫频 → 指数衰减，外加次低频 */
  thunder(strength = 1) {
    if (!this.ac || !this.rumble || !this.master) return
    const ac = this.ac, t = ac.currentTime
    const src = ac.createBufferSource(); src.buffer = this.rumble
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'
    lp.frequency.setValueAtTime(420, t); lp.frequency.exponentialRampToValueAtTime(70, t + 2.2)
    const g = ac.createGain()
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.9 * strength, t + 0.06); g.gain.exponentialRampToValueAtTime(0.001, t + 2.8)
    src.connect(lp).connect(g).connect(this.master); src.start(t); src.stop(t + 3)
    const osc = ac.createOscillator(); osc.type = 'sine'
    osc.frequency.setValueAtTime(55, t); osc.frequency.exponentialRampToValueAtTime(28, t + 1.5)
    const og = ac.createGain(); og.gain.setValueAtTime(0.35 * strength, t); og.gain.exponentialRampToValueAtTime(0.001, t + 1.6)
    osc.connect(og).connect(this.master); osc.start(t); osc.stop(t + 1.7)
  }

  /** 总音量 0–1（未解锁时先记下，解锁后生效） */
  setMasterVolume(v: number) {
    this.masterVol = Math.min(1, Math.max(0, v))
    if (this.ac && this.out) this.out.gain.setTargetAtTime(this.masterVol, this.ac.currentTime, 0.05)
  }
  get masterVolume() { return this.masterVol }
  /** 背景音乐开关（未解锁时先记下） */
  setMusic(on: boolean) {
    this.musicOn = on
    this.music?.setEnabled(on)
  }
  /** 当前音乐模式；未解锁 / 关闭时为 null（测试用） */
  get musicMode() { return this.music && this.musicOn ? this.music.currentMode : null }
  /** 音频是否已解锁并在运行（headless / 未交互时可能 suspended） */
  get state() { return this.ac?.state ?? 'locked' }

  /** 短促单音：振荡器 + 指数衰减包络 */
  private tone(freq: number, at: number, dur: number, vol: number, type: OscillatorType = 'sine', dest?: AudioNode, glideTo?: number) {
    const ac = this.ac!
    const o = ac.createOscillator(); o.type = type
    o.frequency.setValueAtTime(freq, at)
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, at + dur)
    const g = ac.createGain()
    g.gain.setValueAtTime(0.0001, at); g.gain.linearRampToValueAtTime(vol, at + Math.min(0.012, dur * 0.2)); g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    o.connect(g).connect(dest ?? this.master!); o.start(at); o.stop(at + dur + 0.02)
  }

  /** 喇叭：两只失谐方波 → 低通；player = 玩家按 H（更响），bus = 低沉气喇叭；vol 用于 NPC 距离衰减 */
  horn(player = false, bus = false, vol = 1) {
    if (!this.ac || !this.out) return
    const ac = this.ac, t = ac.currentTime
    const dur = player ? 0.45 : 0.22
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = bus ? 900 : 1800
    const g = ac.createGain()
    const peak = (player ? 0.16 : 0.09) * vol
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + 0.02)
    g.gain.setValueAtTime(peak, t + dur - 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    lp.connect(g).connect(this.out)
    for (const f of bus ? [196, 233] : [415, 494]) {
      const o = ac.createOscillator(); o.type = 'square'; o.frequency.value = f
      o.connect(lp); o.start(t); o.stop(t + dur + 0.02)
    }
  }

  /** MRT 进站提示音 "叮-咚-叮" */
  mrtChime(vol = 1) {
    if (!this.ac) return
    const t = this.ac.currentTime + 0.02
    MRT_CHIME.forEach((f, i) => {
      this.tone(f, t + i * 0.42, 0.9, 0.07 * vol, 'sine')
      this.tone(f * 2, t + i * 0.42, 0.5, 0.015 * vol, 'sine')   // 泛音让音色更像电子钟
    })
  }

  /** 白天鸟鸣：2–4 声上扫啁啾 */
  private birdCall(vol: number) {
    const t = this.ac!.currentTime + 0.01
    const n = 2 + Math.floor(Math.random() * 3), base = 2600 + Math.random() * 1400
    for (let i = 0; i < n; i++) this.tone(base, t + i * 0.13, 0.09, 0.022 * vol, 'sine', undefined, base * (1.35 + Math.random() * 0.3))
  }

  /** 夜间蟋蟀：高频短脉冲串 */
  private cricket(vol: number) {
    const t = this.ac!.currentTime + 0.01
    const f = 4300 + Math.random() * 500
    for (let i = 0; i < 4; i++) this.tone(f, t + i * 0.045, 0.03, 0.012 * vol, 'triangle')
  }

  /** 路口行人提示音：一声短 "嘀" */
  private walkBeep(green: boolean, vol: number) {
    this.tone(green ? 2350 : 1900, this.ac!.currentTime + 0.005, green ? 0.035 : 0.08, 0.05 * vol, 'square')
  }

  /**
   * 环境音：由 Game 每帧调用。城市车流底噪、鸟鸣/蟋蟀（雨天关闭）、MRT 进站提示音、
   * 路口行人过街提示音（步行时）、交通车被玩家挡路 > 2 s 时偶发短促喇叭
   */
  ambient(ctx: Ctx, dt: number) {
    if (!this.ac || this.ac.state === 'closed') return
    const pl = ctx.player, px = pl.worldX, pz = pl.worldZ
    const now = this.ac.currentTime
    const rainy = this.rainLevel > 0.15
    this.music?.update({ inVehicle: pl.inVehicle, hour: ctx.clock.hour, rain: this.rainLevel, stars: ctx.law.policeStars })
    this.ambT -= dt
    if (this.ambT <= 0) {
      this.ambT = 0.25
      // 车流底噪：120 m 内的行驶车辆数
      let n = 0
      for (const v of ctx.vehicles) {
        if (!v.active || v === pl.vehicle) continue
        const d = Math.hypot(v.x - px, v.z - pz)
        if (d < 120) n += v.absSpeed > 1 ? 1 - d / 160 : 0.3 * (1 - d / 160)
      }
      const busy = Math.min(1, n / 14)
      this.trafficGain?.gain.setTargetAtTime(0.02 + busy * 0.07, now, 0.8)
      // 最近信号灯路口（20 m 内）
      this.nearSignal = null
      if (!pl.inVehicle) {
        let best = 20
        for (const id of ctx.signals.nodeIds) {
          const node = ctx.graph.nodes[id]
          const d = Math.hypot(node.x - px, node.z - pz)
          if (d >= best) continue
          const st = ctx.signals.stateOf(id)
          if (!st) continue
          best = d
          // 行人随第 0 组车流方向过街：该组绿灯 = 行人绿灯
          this.nearSignal = { d, green: st.phases[0] === 'green' }
        }
      }
      this.updateHorns(ctx, 0.25)
    }

    // 鸟鸣（白天）/ 蟋蟀（夜间），雨天关闭
    const h = ctx.clock.hour
    if (!rainy) {
      if (h >= 6.3 && h < 18.8) {
        this.birdIn -= dt
        if (this.birdIn <= 0) { this.birdIn = 2.5 + Math.random() * 7; this.birdCall(pl.inVehicle ? 0.4 : 1) }
      } else if (h >= 19.5 || h < 5.5) {
        this.cricketIn -= dt
        if (this.cricketIn <= 0) { this.cricketIn = 0.5 + Math.random() * 1.6; this.cricket(pl.inVehicle ? 0.35 : 1) }
      }
    }

    // MRT 进站提示音：40 m 内，靠近后约 2 s 首响，之后每 60–90 s
    if (!this.mrtPois || this.mrtPois.length === 0) this.mrtPois = ctx.pois.byType('mrt')
    let mrtD = Infinity
    for (const p of this.mrtPois) mrtD = Math.min(mrtD, Math.hypot(p.x - px, p.z - pz))
    if (mrtD < 40) {
      this.mrtIn -= dt
      if (this.mrtIn <= 0) { this.mrtIn = 60 + Math.random() * 30; this.mrtChime(1 - mrtD / 60) }
    } else this.mrtIn = Math.max(this.mrtIn, 2)   // 离开后冷却冻结；首次靠近 2 s 后响

    // 行人过街提示音：绿灯快速 "嘀嘀嘀"，红灯慢速 "嘀……嘀"
    const sig = this.nearSignal
    if (sig) {
      this.walkBeepIn -= dt
      if (this.walkBeepIn <= 0) {
        this.walkBeepIn = sig.green ? 0.14 : 1.3
        this.walkBeep(sig.green, 1 - sig.d / 26)
      }
    } else this.walkBeepIn = 0
  }

  /** 交通车被玩家挡路 > 2 s：低概率短促喇叭（新加坡司机很少按喇叭），每车冷却 8 s */
  private updateHorns(ctx: Ctx, dt: number) {
    const pl = ctx.player, px = pl.worldX, pz = pl.worldZ
    for (const v of ctx.vehicles) {
      if (!v.active || v.driver !== 'traffic' || v.wrecked) { this.blocked.delete(v); continue }
      const dx = px - v.x, dz = pz - v.z
      const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw)
      const f = dx * fx + dz * fz, l = Math.abs(dx * fz - dz * fx)
      const blocking = v.absSpeed < 0.6 && f > 0 && f < v.halfLen + 7 && l < 2.4
      let b = this.blocked.get(v)
      if (!blocking) { if (b) b.t = 0; if (b && b.cool <= 0) this.blocked.delete(v); else if (b) b.cool -= dt; continue }
      if (!b) { b = { t: 0, cool: 0 }; this.blocked.set(v, b) }
      b.t += dt; b.cool -= dt
      if (b.t > 2 && b.cool <= 0 && Math.random() < 0.12) {
        b.cool = 8
        this.horn(false, v.kind === 'bus', Math.max(0.2, 1 - Math.hypot(dx, dz) / 40))
      }
    }
  }
}
