import type { Game } from '../core/Game'
import { installCasino } from './casino'
import { installRace } from './race'
import { installClub } from './club'
import { installArena } from './arena'
import { installAviation } from './aviation'
import type { SgWorld } from '../world/SgWorld'

/** P10 娱乐玩法总入口：各插件自行 game.addPlugin(...)；Game 构造时调用一次 */
export function installActivities(game: Game) {
  installCasino(game)
  installRace(game)
  installClub(game)
  installArena(game)
  // Phase AIR：只在真实城市且机场接入（路网补丁成功）时启用
  if (game.source.kind === 'sg' && (game.source as unknown as SgWorld).airfield) installAviation(game)
}
