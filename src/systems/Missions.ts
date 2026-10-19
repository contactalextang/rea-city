import * as THREE from 'three'
import type { Ctx, EventBus } from '../core/Context'
import type { P2 } from '../world/RoadGraph'
import { Vehicle } from '../entities/Vehicle'

export type MissionType = 'deliver' | 'race' | 'wreck'
export interface MissionDef {
  id: string; type: MissionType; title: string; brief: string
  start: P2; target: P2 | null
  timeLimit: number; reward: number; count: number
  done: boolean
}

class Marker {
  group = new THREE.Group()
  private disc: THREE.Mesh
  private beam: THREE.Mesh
  constructor(color: number) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false })
    this.disc = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 0.5, 24, 1, true), mat)
    this.disc.position.y = 0.3
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.2, 70, 10, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }))
    this.beam.position.y = 35
    this.group.add(this.disc, this.beam)
  }
  set(p: P2 | null) { if (p) { this.group.position.set(p.x, 0, p.z); this.group.visible = true } else this.group.visible = false }
  sync(t: number) { this.disc.rotation.y = t; this.disc.scale.setScalar(1 + Math.sin(t * 3) * 0.05) }
}

/** 三个任务：送车、限时竞速、破坏。走入黄色标记开始，目标用蓝色标记 */
export class Missions {
  defs: MissionDef[] = []
  active: MissionDef | null = null
  timer = 0
  progress = 0
  missionCar: Vehicle
  private startMarkers: Marker[] = []
  private targetMarker = new Marker(0x3ea6ff)
  private toast: (s: string) => void = () => {}
  private result: 'none' | 'win' | 'fail' = 'none'
  resultTimer = 0

  constructor(private ctx: Ctx, events: EventBus) {
    const g = ctx.graph
    const lp = (i: number, j: number, di: number, dj: number, t: number): P2 => {
      const from = g.node(i, j), to = g.node(i + di, j + dj)
      const e = from.out.find((o) => o.to === to)!
      return g.lanePoint(e, t, { x: 0, z: 0 })
    }
    this.defs.push(
      { id: 'deliver', type: 'deliver', title: '任务一：运货', brief: '把金色轿车完好送到蓝色标记（东南区）', start: lp(2, 1, 1, 0, 20), target: lp(8, 8, 1, 0, 24), timeLimit: 110, reward: 600, count: 1, done: false },
      { id: 'race', type: 'race', title: '任务二：赶时间', brief: '限时赶到蓝色标记（东北区），用什么交通工具随你', start: lp(1, 8, 1, 0, 24), target: lp(8, 1, 0, 1, 20), timeLimit: 70, reward: 450, count: 1, done: false },
      { id: 'wreck', type: 'wreck', title: '任务三：街头破坏', brief: '限时撞毁 4 辆车，然后甩掉警察', start: lp(5, 5, 1, 0, 24), target: null, timeLimit: 90, reward: 900, count: 4, done: false },
    )
    for (const d of this.defs) { const m = new Marker(0xffd33d); m.set(d.start); this.startMarkers.push(m); ctx.scene.add(m.group) }
    this.targetMarker.set(null); ctx.scene.add(this.targetMarker.group)
    this.missionCar = new Vehicle('mission', 0xf5b400)
    ctx.scene.add(this.missionCar.group); ctx.vehicles.push(this.missionCar)
    events.on('vehicleWrecked', (e) => {
      if (this.active?.type === 'wreck' && e.byPlayer && e.v !== this.missionCar) { this.progress++; this.toast(`撞毁 ${this.progress}/${this.active.count}`) }
      if (this.active?.type === 'deliver' && e.v === this.missionCar) this.fail('车报废了')
    })
  }

  setToast(fn: (s: string) => void) { this.toast = fn }
  get completed() { return this.defs.filter((d) => d.done).length }
  get allDone() { return this.completed === this.defs.length }

  /** 当前应在 HUD/小地图上指示的目标点 */
  get targetPoint(): P2 | null {
    if (!this.active) return null
    if (this.active.type === 'deliver' && this.ctx.player.vehicle !== this.missionCar) return { x: this.missionCar.x, z: this.missionCar.z }
    return this.active.target
  }

  begin(d: MissionDef) {
    this.active = d; this.timer = d.timeLimit; this.progress = 0; this.result = 'none'
    for (let i = 0; i < this.defs.length; i++) this.startMarkers[i].set(null)
    if (d.type === 'deliver') {
      if (this.ctx.player.vehicle === this.missionCar) this.ctx.player.exit(this.ctx.world)
      const g = this.ctx.graph
      const near = g.nearestLane(d.start.x, d.start.z)
      const e = near.edge, t = Math.min(e.length - 6, near.t + 9)
      const p = g.lanePoint(e, t, { x: 0, z: 0 })
      const dir = g.dirAt(e, t, { x: 0, z: 0 })
      this.missionCar.activate(p.x, p.z, Math.atan2(dir.x, dir.z))
      this.missionCar.controls.handbrake = true
      this.targetMarker.set(d.target)
      this.toast('上金色轿车，送到蓝色标记')
    } else if (d.type === 'race') {
      this.targetMarker.set(d.target)
      this.toast('出发！')
    } else {
      this.targetMarker.set(null)
      this.toast('开撞！先去找辆车')
    }
  }

  private finish() {
    const d = this.active!
    d.done = true
    this.ctx.player.money += d.reward
    this.toast(`任务完成 +$${d.reward}`)
    this.end('win')
  }
  fail(reason: string) {
    if (!this.active) return
    this.toast(`任务失败：${reason}`)
    this.end('fail')
  }
  private end(r: 'win' | 'fail') {
    this.result = r; this.resultTimer = 3
    this.active = null
    this.targetMarker.set(null)
    for (let i = 0; i < this.defs.length; i++) if (!this.defs[i].done) this.startMarkers[i].set(this.defs[i].start)
  }
  onPlayerDown() { this.fail('你倒下了') }

  update(dt: number) {
    const pl = this.ctx.player
    const px = pl.worldX, pz = pl.worldZ
    this.resultTimer = Math.max(0, this.resultTimer - dt)
    if (!this.active) {
      if (this.resultTimer > 0) return
      for (const d of this.defs) {
        if (d.done) continue
        if (Math.hypot(px - d.start.x, pz - d.start.z) < 3.6) { this.begin(d); break }
      }
      return
    }
    const d = this.active
    this.timer -= dt
    if (this.timer <= 0) { this.fail('超时'); return }
    if (d.type === 'deliver') {
      if (pl.vehicle === this.missionCar && Math.hypot(px - d.target!.x, pz - d.target!.z) < 4.5 && this.missionCar.absSpeed < 3) this.finish()
    } else if (d.type === 'race') {
      if (Math.hypot(px - d.target!.x, pz - d.target!.z) < 4.5) this.finish()
    } else if (this.progress >= d.count) this.finish()
  }

  hudText(): { title: string; desc: string; timer: string } | null {
    if (!this.active) {
      if (this.resultTimer > 0) return { title: this.result === 'win' ? '任务完成' : '任务失败', desc: '', timer: '' }
      return null
    }
    const d = this.active
    let desc = d.brief
    if (d.type === 'deliver' && this.ctx.player.vehicle !== this.missionCar) desc = '先去开金色轿车（蓝点）'
    if (d.type === 'wreck') desc = `已撞毁 ${this.progress}/${d.count}`
    return { title: d.title, desc, timer: `${Math.ceil(this.timer)}s` }
  }

  sync(t: number) {
    for (const m of this.startMarkers) m.sync(t)
    this.targetMarker.sync(t)
  }
}
