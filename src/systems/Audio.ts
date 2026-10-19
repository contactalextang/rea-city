/** WebAudio 合成音效：引擎、警笛、撞击、雨声、雷声。无外部音频文件 */
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

  /** 必须在用户手势后调用 */
  unlock() {
    if (this.ac) return
    try {
      this.ac = new AudioContext()
      const ac = this.ac
      const master = ac.createGain(); master.gain.value = 0.6; master.connect(ac.destination)
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
    src.connect(hp).connect(g).connect(this.ac.destination); src.start(); src.stop(t + 0.15)
    const osc = this.ac.createOscillator(); osc.type = 'square'; osc.frequency.setValueAtTime(180, t); osc.frequency.exponentialRampToValueAtTime(50, t + 0.08)
    const og = this.ac.createGain(); og.gain.setValueAtTime(0.25, t); og.gain.exponentialRampToValueAtTime(0.01, t + 0.1)
    osc.connect(og).connect(this.ac.destination); osc.start(); osc.stop(t + 0.1)
  }

  crash(impulse: number) {
    if (!this.ac || !this.noise) return
    const src = this.ac.createBufferSource(); src.buffer = this.noise
    const g = this.ac.createGain(); g.gain.value = Math.min(0.8, impulse * 0.05)
    const lp = this.ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900
    src.connect(lp).connect(g).connect(this.ac.destination); src.start()
  }

  /** 雨声音量 0–1（每帧调用，平滑淡入淡出） */
  setRain(level: number) {
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
}
