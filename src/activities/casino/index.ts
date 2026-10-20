import type { Game } from '../../core/Game'
import { Casino } from './Casino'

/** P10.B 赌场（滨海湾金沙）：门口面板、五个赌桌活动、手机 casino 页、存档、__game.plug.casino 钩子 */
export function installCasino(game: Game) {
  const c = new Casino(game)
  game.addPlugin({
    id: 'casino',
    serialize: () => c.serialize(),
    restore: (s) => c.restore(s),
    poiButtons: (poi) => c.poiButtons(poi),
    app: { name: 'casino', title: '赌场', view: () => c.view() },
    debug: () => c.debug(),
  })
}
