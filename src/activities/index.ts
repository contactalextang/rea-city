import type { Game } from '../core/Game'
import { installCasino } from './casino'
import { installRace } from './race'
import { installClub } from './club'
import { installArena } from './arena'

/** P10 娱乐玩法总入口：各插件自行 game.addPlugin(...)；Game 构造时调用一次 */
export function installActivities(game: Game) {
  installCasino(game)
  installRace(game)
  installClub(game)
  installArena(game)
}
