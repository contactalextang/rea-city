// 三步流水线共用：路径、外部命令、数据源清单。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const GEO_DIR = resolve(PROJECT_ROOT, 'data/geo');
/** 原始下载目录：视为不可信数据，只以路径作为参数读取，绝不在里面执行任何东西 */
export const RAW_DIR = resolve(GEO_DIR, 'raw');
export const LTA_OUT_DIR = resolve(GEO_DIR, 'lta');
export const LOCAL_DIR = resolve(GEO_DIR, 'local');
export const OSMCONF = resolve(PROJECT_ROOT, 'scripts/geo/osmconf.ini');

/** GDAL 可执行文件目录：优先环境变量 GDAL_BIN，其次 Postgres.app 自带的 GDAL 3.7，最后 PATH */
const GDAL_CANDIDATES = [
  process.env.GDAL_BIN,
  '/Applications/Postgres.app/Contents/Versions/16/bin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
].filter((p): p is string => !!p);

export function gdalTool(name: 'ogr2ogr' | 'ogrinfo'): string {
  for (const dir of GDAL_CANDIDATES) {
    const p = resolve(dir, name);
    if (existsSync(p)) return p;
  }
  return name; // 退回 PATH
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

export function fmtBytes(n: number): string {
  if (n < 0) return 'missing';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export interface RunResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

/** 同步执行外部命令（不经 shell，参数原样传递） */
export function run(cmd: string, args: string[], opts: { quiet?: boolean; env?: NodeJS.ProcessEnv } = {}): RunResult {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...opts.env },
  });
  const ok = r.status === 0;
  if (!ok && !opts.quiet) {
    console.error(`  [cmd failed ${r.status ?? r.signal}] ${cmd} ${args.join(' ')}`);
    if (r.stderr) console.error(r.stderr.trim().split('\n').slice(-8).join('\n'));
  }
  return { ok, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function log(msg: string): void {
  console.log(msg);
}
export function warn(msg: string): void {
  console.warn(`WARN  ${msg}`);
}

// ---------------------------------------------------------------------------
// 数据源清单
// ---------------------------------------------------------------------------

/** data.gov.sg 数据集 id（已通过 /v2/public/api/datasets/<id>/metadata 核实，2026-10） */
export const DATAGOV = {
  hdb: { id: 'd_17f5382f26140b1fdae0ba2ef6239d2f', name: 'HDB Property Information', file: 'hdb-property-information.csv' },
  ura: { id: 'd_90d86daa5bfaa371668b84fa5f01424f', name: 'Master Plan 2019 Land Use layer', file: 'ura-mp2019-landuse.geojson' },
  hawker: { id: 'd_4a086da0a5553be1d89383cd90d07ecd', name: 'Hawker Centres (GEOJSON)', file: 'nea-hawker-centres.geojson' },
} as const;

export const OSM = {
  bbbikeDir: 'https://download.bbbike.org/osm/bbbike/Singapore/',
  bbbike: 'https://download.bbbike.org/osm/bbbike/Singapore/Singapore.osm.pbf',
  geofabrik: 'https://download.geofabrik.de/asia/malaysia-singapore-brunei-latest.osm.pbf',
  file: 'singapore.osm.pbf',
} as const;

export const LTA_PAGE = 'https://datamall.lta.gov.sg/content/datamall/en/static-data.html';
export const LTA_BASE = 'https://datamall.lta.gov.sg/content/dam/datamall/datasets/Geospatial/';

/**
 * LTA DataMall 静态地理数据（SHP zip，免 key）。
 * `zip` 是 2026-10 页面上的实际文件名；若 404（LTA 每月改后缀），00-download 会按 `prefix` 去页面重新找。
 */
export const LTA_DATASETS: { name: string; prefix: string; zip: string }[] = [
  { name: 'lamp-post', prefix: 'LampPost', zip: 'LampPost_Sep2026.zip' },
  { name: 'traffic-light', prefix: 'TrafficLight', zip: 'TrafficLight_Sep2026.zip' },
  { name: 'bus-stop', prefix: 'BusStopLocation', zip: 'BusStopLocation_Sep2026.zip' },
  { name: 'train-station', prefix: 'TrainStation_', zip: 'TrainStation_Sep2026.zip' },
  { name: 'train-station-exit', prefix: 'TrainStationExit', zip: 'TrainStationExit.zip' },
  { name: 'taxi-stand', prefix: 'TaxiStand', zip: 'TaxiStand_Sep2026.zip' },
  { name: 'erp-gantry', prefix: 'ERPGantry', zip: 'ERPGantry_Sep2026.zip' },
  { name: 'covered-linkway', prefix: 'CoveredLinkWay', zip: 'CoveredLinkWay_Sep2026.zip' },
  { name: 'pedestrian-overhead-bridge', prefix: 'PedestrainOverheadbridge', zip: 'PedestrainOverheadbridge_UnderPass_Sep2026.zip' },
  { name: 'kerbline', prefix: 'KerbLine', zip: 'KerbLine_Sep2026.zip' },
  { name: 'lane-marking', prefix: 'LaneMarking', zip: 'LaneMarking_Sep2026.zip' },
  { name: 'road-section-line', prefix: 'RoadSectionLine', zip: 'RoadSectionLine_Sep2026.zip' },
];

export const RAW_OSM = resolve(RAW_DIR, OSM.file);
export const RAW_LTA_DIR = resolve(RAW_DIR, 'lta');
export const rawLtaZip = (name: string) => resolve(RAW_LTA_DIR, `${name}.zip`);
export const rawDatagov = (key: keyof typeof DATAGOV) => resolve(RAW_DIR, DATAGOV[key].file);
