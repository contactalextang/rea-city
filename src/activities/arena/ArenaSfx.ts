import type { WeaponDef } from '../../data/arena'

/**
 * 竞技场音效：WebAudio 即时合成（不改 Audio.ts）。
 * 3D 方位：按听者位置/朝向算左右声像 + 距离衰减 + 远处低通；静步/蹲走不发脚步声由调用方决定。
 */
export class ArenaSfx {
  private ac: AudioContext | null = null
  private out: GainNode | null = null
  private noiseBuf: AudioBuffer | null = null
  /** 听者 */
  lx = 0; lz = 0; lyaw = 0
  constructor(private volume: () => number) {}

  private ready(): AudioContext | null {
    if (!this.ac) {
      try {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!AC) return null
        this.ac = new AC()
        const comp = this.ac.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 6
        this.out = this.ac.createGain(); this.out.connect(comp).connect(this.ac.destination)
        const len = Math.floor(this.ac.sampleRate * 1.0)
        this.noiseBuf = this.ac.createBuffer(1, len, this.ac.sampleRate)
        const d = this.noiseBuf.getChannelData(0)
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
      } catch { return null }
    }
    if (this.ac.state === 'suspended') void this.ac.resume().catch(() => {})
    this.out!.gain.value = 0.55 * this.volume()
    return this.ac
  }

  /** 空间化节点：返回接入点（null = 太远听不见） */
  private spatial(x: number | null, z: number | null, maxD: number, vol: number): AudioNode | null {
    const ac = this.ready(); if (!ac || !this.out) return null
    const g = ac.createGain()
    if (x === null || z === null) { g.gain.value = vol; g.connect(this.out); return g }
    const dx = x - this.lx, dz = z - this.lz, d = Math.hypot(dx, dz)
    if (d > maxD) return null
    const att = vol * Math.pow(Math.max(0, 1 - d / maxD), 1.6) / (1 + d * 0.04)
    if (att < 0.003) return null
    g.gain.value = att
    // 听者右向 = (cos yaw, -sin yaw)
    const rx = Math.cos(this.lyaw), rz = -Math.sin(this.lyaw)
    const pan = d > 0.5 ? Math.max(-1, Math.min(1, (dx * rx + dz * rz) / d)) * 0.85 : 0
    const p = ac.createStereoPanner(); p.pan.value = pan
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.max(900, 16000 - d * 260)
    // 身后略闷
    const fx = -Math.sin(this.lyaw), fz = -Math.cos(this.lyaw)
    if (d > 0.5 && (dx * fx + dz * fz) / d < -0.3) lp.frequency.value *= 0.55
    g.connect(lp).connect(p).connect(this.out)
    return g
  }

  private noise(dst: AudioNode, t: number, dur: number, f: number, q: number, vol: number, type: BiquadFilterType = 'bandpass', decay = dur) {
    const ac = this.ac!
    const src = ac.createBufferSource(); src.buffer = this.noiseBuf; src.playbackRate.value = 0.8 + Math.random() * 0.4
    const flt = ac.createBiquadFilter(); flt.type = type; flt.frequency.value = f; flt.Q.value = q
    const g = ac.createGain()
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + decay)
    src.connect(flt).connect(g).connect(dst); src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05)
  }
  private tone(dst: AudioNode, t: number, freq: number, dur: number, vol: number, type: OscillatorType = 'sine', slide = 1) {
    const ac = this.ac!
    const o = ac.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t)
    if (slide !== 1) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur)
    const g = ac.createGain()
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g).connect(dst); o.start(t); o.stop(t + dur + 0.05)
  }

  /** 枪声：低频冲击 + 带通噪声爆裂 + 远处回声（每把枪参数不同） */
  gun(def: WeaponDef, x: number | null, z: number | null) {
    const s = def.sound
    const dst = this.spatial(x, z, 140, s.vol); if (!dst) return
    const t = this.ac!.currentTime
    this.tone(dst, t, s.pitch * 0.35, s.decay * 1.2, 0.9, 'sine', 0.4)
    this.noise(dst, t, s.decay, s.pitch * 4, 0.9, 0.9, 'bandpass', s.decay)
    this.noise(dst, t, s.decay * 0.5, 7000, 0.7, 0.35 * (s.crack ?? 0.3), 'highpass', s.decay * 0.4)
    if (s.crack) this.noise(dst, t + 0.09, s.decay * 2.5, s.pitch * 1.5, 0.6, 0.12 * s.crack, 'lowpass', s.decay * 2.5)
  }
  knife(x: number | null, z: number | null, hit: boolean) {
    const dst = this.spatial(x, z, 20, 0.5); if (!dst) return
    const t = this.ac!.currentTime
    this.noise(dst, t, 0.14, 3000, 1.5, 0.35, 'bandpass', 0.14)
    if (hit) this.tone(dst, t + 0.05, 180, 0.12, 0.6, 'triangle', 0.6)
  }
  dry() { const dst = this.spatial(null, null, 0, 0.3); if (!dst) return; const t = this.ac!.currentTime; this.tone(dst, t, 2200, 0.03, 0.4, 'square') }
  reload(x: number | null, z: number | null, total: number) {
    const dst = this.spatial(x, z, 18, 0.35); if (!dst) return
    const t = this.ac!.currentTime
    this.noise(dst, t + 0.1, 0.05, 2500, 2, 0.6, 'bandpass', 0.05)
    this.noise(dst, t + total * 0.55, 0.05, 1800, 2, 0.7, 'bandpass', 0.05)
    this.noise(dst, t + total * 0.85, 0.06, 3200, 3, 0.8, 'bandpass', 0.06)
  }
  /** 脚步：短促低频 + 鞋底噪声；台阶/货柜（金属）更亮 */
  step(x: number | null, z: number | null, loud: number, metal = false) {
    const dst = this.spatial(x, z, 28, 0.55 * loud); if (!dst) return
    const t = this.ac!.currentTime
    this.noise(dst, t, 0.07, metal ? 1800 : 600, 1.2, 0.8, 'bandpass', 0.07)
    this.tone(dst, t, metal ? 240 : 90, 0.06, 0.5, 'sine', 0.7)
  }
  land(x: number | null, z: number | null) { const dst = this.spatial(x, z, 25, 0.6); if (!dst) return; const t = this.ac!.currentTime; this.noise(dst, t, 0.12, 400, 1, 0.9, 'lowpass', 0.12) }
  /** 命中反馈：爆头清脆 / 身体闷响 */
  hitmark(head: boolean, kill: boolean) {
    const dst = this.spatial(null, null, 0, 0.5); if (!dst) return
    const t = this.ac!.currentTime
    if (head) { this.tone(dst, t, 1800, 0.12, 0.5, 'triangle', 1.4); this.tone(dst, t + 0.02, 3600, 0.08, 0.2, 'sine') }
    else this.noise(dst, t, 0.06, 900, 2, 0.6, 'bandpass', 0.06)
    if (kill) this.tone(dst, t + 0.05, 600, 0.18, 0.35, 'sine', 0.5)
  }
  hurt() { const dst = this.spatial(null, null, 0, 0.45); if (!dst) return; const t = this.ac!.currentTime; this.noise(dst, t, 0.15, 300, 1, 0.9, 'lowpass', 0.15) }
  /** C4 滴答（剩余时间越少越急） */
  beep(x: number, z: number, urgent: boolean) {
    const dst = this.spatial(x, z, 80, urgent ? 0.5 : 0.35); if (!dst) return
    const t = this.ac!.currentTime
    this.tone(dst, t, 2700, 0.09, 0.6, 'square')
  }
  plantTick() { const dst = this.spatial(null, null, 0, 0.25); if (!dst) return; const t = this.ac!.currentTime; this.tone(dst, t, 1200 + Math.random() * 400, 0.05, 0.5, 'square') }
  defuseTick(x: number, z: number) { const dst = this.spatial(x, z, 30, 0.3); if (!dst) return; const t = this.ac!.currentTime; this.noise(dst, t, 0.04, 4000, 4, 0.6, 'bandpass', 0.04) }
  explosion(x: number, z: number, big: boolean) {
    const dst = this.spatial(x, z, big ? 300 : 120, big ? 1.2 : 0.9); if (!dst) return
    const t = this.ac!.currentTime
    this.tone(dst, t, 70, big ? 1.6 : 0.8, 1, 'sine', 0.35)
    this.noise(dst, t, big ? 2.2 : 1.0, 500, 0.6, 1, 'lowpass', big ? 2.2 : 1.0)
    this.noise(dst, t, 0.3, 3000, 0.5, 0.6, 'bandpass', 0.3)
  }
  bounce(x: number, z: number) { const dst = this.spatial(x, z, 25, 0.3); if (!dst) return; const t = this.ac!.currentTime; this.tone(dst, t, 900, 0.05, 0.4, 'triangle', 0.8) }
  smokePop(x: number, z: number) { const dst = this.spatial(x, z, 40, 0.5); if (!dst) return; const t = this.ac!.currentTime; this.noise(dst, t, 2.5, 1200, 0.3, 0.5, 'bandpass', 2.5) }
  flashPop(x: number, z: number) { const dst = this.spatial(x, z, 60, 0.7); if (!dst) return; const t = this.ac!.currentTime; this.noise(dst, t, 0.25, 4000, 0.5, 1, 'highpass', 0.25) }
  ui(kind: 'buy' | 'deny' | 'round' | 'win' | 'lose') {
    const dst = this.spatial(null, null, 0, 0.4); if (!dst) return
    const t = this.ac!.currentTime
    if (kind === 'buy') { this.tone(dst, t, 880, 0.06, 0.4, 'triangle'); this.tone(dst, t + 0.05, 1320, 0.08, 0.3, 'triangle') }
    else if (kind === 'deny') this.tone(dst, t, 200, 0.15, 0.4, 'square')
    else if (kind === 'round') { this.tone(dst, t, 660, 0.2, 0.3, 'sine'); this.tone(dst, t + 0.18, 990, 0.3, 0.3, 'sine') }
    else if (kind === 'win') { for (let i = 0; i < 3; i++) this.tone(dst, t + i * 0.12, [523, 659, 784][i], 0.4, 0.35, 'triangle') }
    else { for (let i = 0; i < 3; i++) this.tone(dst, t + i * 0.15, [392, 330, 262][i], 0.45, 0.35, 'triangle') }
  }
  dispose() { void this.ac?.close().catch(() => {}); this.ac = null }
}
