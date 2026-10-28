// AI 试玩员 · 观测：每个控制周期从 window.__game 读一份快照（只读，不改游戏状态）
import type { Page } from 'playwright'
import type { Obs, PoiInfo } from './schemas.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function observe(page: Page): Promise<Obs> {
  return page.evaluate(() => {
    const g = (window as any).__game
    const pl = g.player
    const mine = pl.inVehicle ? g.cars.find((c: any) => c.driver === 'player') ?? null : null
    const js = g.jobs.state
    const q = g.quests
    return {
      state: g.state, fps: g.stats.fps,
      x: pl.x, z: pl.z, inVehicle: pl.inVehicle, speed: Math.abs(pl.speed), money: pl.money,
      hour: g.clock.hour, day: g.clock.day,
      energy: g.needs.energy, hunger: g.needs.hunger,
      camYaw: g.camYaw,
      car: mine ? { x: mine.x, z: mine.z, yaw: mine.yaw, speed: Math.abs(mine.speed), kind: mine.kind, wrecked: !!mine.wrecked } : null,
      quest: { id: q.active, step: q.step, label: q.stepLabel ?? '', target: q.target ? { x: q.target.x, z: q.target.z } : null, progress: q.progress ?? 0, done: q.done },
      job: { active: g.jobs.active, target: js.target ? { x: js.target.x, z: js.target.z } : null, taxiPhase: js.taxi?.phase ?? null, canBoard: !!js.canBoard },
      near: g.pois.near,
      panel: { open: !!g.panel.open, labels: [...(g.panel.labels ?? [])] },
      phone: { open: !!g.phone.open, sub: g.phone.sub ?? null },
      stars: g.wanted.stars,
      level: g.progress.level,
      netWorth: g.netWorth,
      toast: (() => { const el = document.getElementById('toast'); return el?.classList.contains('show') ? el.textContent : null })(),
    }
  })
}

export async function listPois(page: Page): Promise<PoiInfo[]> {
  return page.evaluate(() => (window as any).__game.pois.list().map((p: any) => ({ id: p.id, type: p.type, name: p.name, door: { x: p.door.x, z: p.door.z, yaw: p.door.yaw } })))
}
