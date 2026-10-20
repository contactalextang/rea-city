/**
 * 赌场音效：WebAudio 即时合成（筹码、发牌、轮盘小球、骰子、转轴、输赢提示），不依赖 Audio.ts。
 * AudioContext 在第一次播放时创建（都是点击触发，满足浏览器的用户手势要求）；音量跟随游戏总音量。
 */
export class CasinoSfx {
  private ac: AudioContext | null = null
  private out: GainNode | null = null
  private noiseBuf: AudioBuffer | null = null
  constructor(private volume: () => number) {}

  private ready(): AudioContext | null {
    if (!this.ac) {
      try {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!AC) return null
        this.ac = new AC()
        this.out = this.ac.createGain(); this.out.connect(this.ac.destination)
        const len = Math.floor(this.ac.sampleRate * 0.5)
        this.noiseBuf = this.ac.createBuffer(1, len, this.ac.sampleRate)
        const d = this.noiseBuf.getChannelData(0)
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
      } catch { return null }
    }
    if (this.ac.state === 'suspended') void this.ac.resume().catch(() => {})
    this.out!.gain.value = 0.5 * this.volume()
    return this.ac
  }

  private tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.3, at = 0, slide = 0) {
    const ac = this.ready(); if (!ac) return
    const t = ac.currentTime + at
    const o = ac.createOscillator(), g = ac.createGain()
    o.type = type; o.frequency.setValueAtTime(freq, t)
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur)
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g).connect(this.out!); o.start(t); o.stop(t + dur + 0.02)
  }

  private noise(dur: number, freq: number, q = 1, vol = 0.3, at = 0, type: BiquadFilterType = 'bandpass') {
    const ac = this.ready(); if (!ac || !this.noiseBuf) return
    const t = ac.currentTime + at
    const src = ac.createBufferSource(); src.buffer = this.noiseBuf
    const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q
    const g = ac.createGain()
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(f).connect(g).connect(this.out!); src.start(t, Math.random() * 0.2); src.stop(t + dur + 0.02)
  }

  /** 筹码落桌：两下短促的高频“咔” */
  chip() { this.noise(0.05, 4200, 6, 0.35); this.tone(2600, 0.05, 'triangle', 0.08, 0.015); this.noise(0.04, 5200, 8, 0.2, 0.03) }
  /** 发牌：纸牌摩擦 */
  card() { this.noise(0.09, 2400, 0.8, 0.25, 0, 'highpass') }
  /** 翻牌 */
  flip() { this.noise(0.05, 1800, 2, 0.3) }
  /** 按钮 */
  click() { this.tone(900, 0.04, 'square', 0.05) }
  /** 轮盘小球滚过格子 */
  tick(vol = 0.15) { this.noise(0.025, 3200 + Math.random() * 800, 10, vol) }
  /** 小球落袋 */
  ballDrop() { this.noise(0.08, 1500, 4, 0.4); this.noise(0.06, 2200, 6, 0.25, 0.09); this.noise(0.05, 2400, 6, 0.15, 0.16) }
  /** 骰盅摇动（一次） */
  rattle() { for (let i = 0; i < 4; i++) this.noise(0.04, 1200 + Math.random() * 1600, 5, 0.25, i * 0.035) }
  /** 骰盅落定 */
  thump() { this.tone(120, 0.18, 'sine', 0.5, 0, 0.5); this.noise(0.08, 600, 1, 0.2) }
  /** 老虎机转轴滴答 */
  reelTick() { this.tone(1400 + Math.random() * 200, 0.02, 'square', 0.03) }
  /** 转轴停 */
  reelStop() { this.tone(180, 0.12, 'triangle', 0.35, 0, 0.6); this.noise(0.05, 900, 2, 0.2) }
  /** 赢：上行琶音（big = 大奖再来一遍高八度） */
  win(big = false) {
    const notes = [523.3, 659.3, 784, 1046.5]
    notes.forEach((f, i) => this.tone(f, 0.22, 'triangle', 0.22, i * 0.08))
    if (big) [1046.5, 1318.5, 1568, 2093].forEach((f, i) => this.tone(f, 0.3, 'square', 0.08, 0.36 + i * 0.09))
  }
  /** 和局 */
  push() { this.tone(660, 0.15, 'triangle', 0.15); this.tone(660, 0.15, 'triangle', 0.12, 0.18) }
  /** 输：下行两音 */
  lose() { this.tone(330, 0.2, 'triangle', 0.18); this.tone(247, 0.32, 'triangle', 0.18, 0.18) }
}
