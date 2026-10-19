// 车行道路网图的数据格式：由 scripts/geo/03-roads.ts 生成 data/geo/build/graph.json，
// 运行时直接按此类型加载。坐标为本地米制（见 lib/proj.ts）：x 向东为正，z 向南为正。

export type RoadKind = 'expressway' | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'residential' | 'service';

export interface GraphNodeData {
  /** 0 起连续编号 */
  id: number;
  x: number;
  z: number;
  /** 路口（度 ≥3 或 way 端点）；false 表示只是属性变化点（车道数 / 限速 / 单向性变化） */
  junction: boolean;
  /** 25 m 内有 OSM traffic_signals 节点 */
  signal: boolean;
  /** 路口半径（米）：汇入各边半宽（双向合计）的最大值 + 1，最小 4 */
  jr: number;
}

export interface GraphEdgeData {
  /** 0 起连续编号 */
  id: number;
  from: number;
  to: number;
  /** 折线 [x0, z0, x1, z1, ...]，首尾即 from / to 节点坐标 */
  pts: number[];
  /** 本方向车道数 */
  lanes: number;
  /** 单车道宽（米）：3.3，service 为 3.0 */
  laneW: number;
  kind: RoadKind;
  /** 限速 km/h */
  speedLimit: number;
  oneway: boolean;
  /** 双向路的反向边 id；单向为 null */
  reverse: number | null;
  /** 人行横道位置：沿边从 from 起算的弧长（米），升序 */
  crossings: number[];
  name?: string;
  bridge?: boolean;
}

export interface GraphData {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
}
