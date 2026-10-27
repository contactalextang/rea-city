/** 英文词典：按模块分文件（各自维护），这里合并；key 为中文原文。同 key 在不同文件须译文一致（npm run i18n:check 查冲突） */
import ui from './ui'
import systems from './systems'
import data from './data'
import social from './social'
import arena from './arena'
import casino from './casino'

export const EN: Record<string, string> = { ...ui, ...systems, ...data, ...social, ...arena, ...casino }
