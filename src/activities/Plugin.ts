import type { AppView } from '../core/Context'
import type { PanelButton } from '../ui/Panels'
import type { Poi } from '../systems/Poi'

/**
 * P10 娱乐插件：赌场 / 赛车 / 夜店恋爱 / 竞技场各自实现一个，经 game.addPlugin 注册，
 * Game 统一负责每帧更新、存档、POI 面板按钮、手机页、HUD 任务卡与小地图目标。插件不改 Game.ts。
 */
export interface GamePlugin {
  /** 存档键（SaveData.plugins[id]）兼调试钩子名（__game.plug[id]） */
  id: string
  /** 世界运行时每帧调用（panel / activity / arena 期间不调用） */
  update?(dt: number): void
  serialize?(): unknown
  /** 读档或新开局（s 为 undefined）时调用 */
  restore?(s: unknown): void
  /** 往 POI 面板塞按钮（同 interactions.addProvider） */
  poiButtons?(poi: Poi): PanelButton[]
  /** 手机页：index.html 里 `data-app=<app.name>` 的按钮打开它 */
  app?: { name: string; title: string; view(): AppView }
  /** HUD 底部任务卡（优先于工作 / 任务） */
  hudCard?(): { title: string; desc: string; timer: string; sub?: string } | null   // timer 空串 = 不显示
  /** 小地图 / 光柱目标（优先于工作 / 任务） */
  navTarget?(): { x: number; z: number } | null
  /** 小地图 / 手机大地图上画的导航折线（如赛道线）；null = 不画 */
  navPath?(): { x: number; z: number }[] | null
  /** 被捕 / 倒下时 */
  onBustOrDeath?(): void
  /** Phase AIR：F 键（在上下车之前调用）；返回 true = 插件已处理（如登机 / 下飞机） */
  keyF?(): boolean
  /** 接管相机（返回 true 时 Game 跳过默认 cam.update，如驾驶飞机） */
  driveCamera?(dt: number): boolean
  /** 当前操控模式（'fly' = 驾驶飞机；触屏布局与 HUD 据此切换） */
  controlMode?(): 'fly' | null
  /** 发动机声音来源（驾驶飞机时；null = 不接管） */
  audioMount?(): { speed: number; throttle: number } | null
  /** HUD 底部提示（排在 POI 交互提示之后；null = 无） */
  hint?(): string | null
  /** 测试钩子对象，挂到 window.__game.plug[id] */
  debug?(): unknown
}
