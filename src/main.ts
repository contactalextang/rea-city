import { applyDom } from './i18n'
import { Game } from './core/Game'

applyDom()
const game = new Game(document.getElementById('app')!)
game.start()
