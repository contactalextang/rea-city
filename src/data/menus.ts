/** 消费菜单数据：小贩中心、便利店 */
export interface MenuItem {
  id: string
  name: string
  price: number     // 新币
  hunger: number    // 饱食回复
  energy?: number   // 精力回复（饮料等）
}

export const HAWKER_MENU: MenuItem[] = [
  { id: 'chicken_rice', name: '海南鸡饭', price: 4, hunger: 35 },
  { id: 'laksa', name: '叻沙', price: 5, hunger: 40 },
  { id: 'char_kway_teow', name: '炒粿条', price: 4.5, hunger: 38 },
  { id: 'satay', name: '沙爹 10 串', price: 8, hunger: 45 },
  { id: 'nasi_lemak', name: '椰浆饭', price: 3.5, hunger: 30 },
  { id: 'kaya_toast', name: '咖椰吐司套餐', price: 3.2, hunger: 20, energy: 5 },
  { id: 'kopi', name: 'Kopi', price: 1.4, hunger: 15, energy: 8 },
  { id: 'teh', name: 'Teh', price: 1.4, hunger: 15, energy: 6 },
]

export const SHOP_MENU: MenuItem[] = [
  { id: 'water', name: '矿泉水', price: 1, hunger: 5 },
  { id: 'bread', name: '面包', price: 2, hunger: 15 },
  { id: 'cup_noodle', name: '杯面', price: 2.5, hunger: 25 },
  { id: 'energy_drink', name: '能量饮料', price: 3, hunger: 5, energy: 15 },
]

/** 工作与消费参数（集中放这里便于调平衡） */
export const ECONOMY = {
  rent: { white: 40, blue: 25 } as Record<string, number>,
  salary: { white: 180, gold: 600 } as Record<string, number>,
  siteWage: 18,
  taxiRent: 50,
  taxiRentBlue: 30,
  mrtBase: 1.19,
  mrtPerKm: 0.3,
  mrtCap: 2.5,
  mrtSpeedKmh: 30,
}
