/** 英文词典：aviation（Phase AIR 机场与飞行；key 为中文原文，{name} 为占位符） */
const en: Record<string, string> = {
  // src/world/Airfield.ts
  '滨海南机场 Marina South Airfield': 'Marina South Airfield',
  '机库 · 飞行俱乐部': 'Hangar · Flying Club',
  '机场货运站': 'Airport Cargo Terminal',
  '机场塔台': 'Control Tower',
  // src/systems/Poi.ts / Interactions.ts
  '机场': 'Airport',
  '滨海南机场 24 小时开放。': 'Marina South Airfield is open 24 hours.',
  // src/core/Game.ts
  '先降落并下飞机': 'Land and get out of the plane first',
  '机场 · {name}': 'Airport · {name}',
  '24 小时开放': 'Open 24 hours',
}
export default en
