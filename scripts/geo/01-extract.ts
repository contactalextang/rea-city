// 第 1 步：用 GDAL ogr2ogr 从原始数据里按 bbox 提取为 WGS84 GeoJSON，写到 data/geo/。
// 用法：node scripts/geo/01-extract.ts [--force]
//   - OSM PBF  → osm-lines.geojson / osm-polygons.geojson / osm-points.geojson（自定义 osmconf.ini）
//   - LTA SHP  → 解压到 raw/lta/<name>/，EPSG:3414 → EPSG:4326，裁剪后写 lta/<name>.geojson
//   - URA 土地用途、NEA 小贩中心 → 直接 -spat 裁剪
//   - HDB CSV  → 原样复制为 hdb.csv
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  GEO_DIR,
  LTA_DATASETS,
  LTA_OUT_DIR,
  OSMCONF,
  RAW_LTA_DIR,
  RAW_OSM,
  ensureDir,
  fileSize,
  fmtBytes,
  gdalTool,
  log,
  rawDatagov,
  rawLtaZip,
  run,
  warn,
} from './lib/common.ts';
import { SPAT_ARGS } from './lib/proj.ts';

const FORCE = process.argv.includes('--force');
const OGR2OGR = gdalTool('ogr2ogr');
const OGRINFO = gdalTool('ogrinfo');
const GEOJSON_LCO = ['-lco', 'COORDINATE_PRECISION=7', '-lco', 'WRITE_NAME=NO'];
const failures: string[] = [];

function upToDate(out: string): boolean {
  return !FORCE && fileSize(out) > 0;
}

function sourceMissing(label: string, path: string): boolean {
  if (fileSize(path) > 0) return false;
  warn(`${label}: source missing (${path}), skipped — run 00-download first`);
  failures.push(label);
  return true;
}

function ogr2ogr(label: string, out: string, args: string[], env?: NodeJS.ProcessEnv): boolean {
  if (upToDate(out)) {
    log(`SKIP  ${label}: exists ${basename(out)} (${fmtBytes(fileSize(out))})`);
    return true;
  }
  rmSync(out, { force: true });
  const t0 = Date.now();
  const r = run(OGR2OGR, ['-f', 'GeoJSON', ...GEOJSON_LCO, out, ...args], { env });
  if (!r.ok || fileSize(out) <= 0) {
    warn(`${label}: ogr2ogr failed`);
    failures.push(label);
    rmSync(out, { force: true });
    return false;
  }
  log(`OK    ${label}: ${basename(out)} ${fmtBytes(fileSize(out))} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return true;
}

// ---------------------------------------------------------------------------
// OSM
// ---------------------------------------------------------------------------
function extractOsm(): void {
  if (sourceMissing('OSM', RAW_OSM)) return;
  const env = {
    OGR_INTERLEAVED_READING: 'YES',
    OSM_MAX_TMPFILE_SIZE: '512', // MB；超过则落盘临时 sqlite，37 MB 的 PBF 不会触发
    OSM_USE_CUSTOM_INDEXING: 'YES',
  };
  const layers: [string, string][] = [
    ['lines', 'osm-lines.geojson'],
    ['multipolygons', 'osm-polygons.geojson'],
    ['points', 'osm-points.geojson'],
  ];
  for (const [layer, file] of layers) {
    ogr2ogr(
      `OSM ${layer}`,
      resolve(GEO_DIR, file),
      ['-spat', ...SPAT_ARGS, '-oo', `CONFIG_FILE=${OSMCONF}`, RAW_OSM, layer],
      env,
    );
  }
}

// ---------------------------------------------------------------------------
// LTA SHP
// ---------------------------------------------------------------------------
function findShapefiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...findShapefiles(p));
    else if (/\.shp$/i.test(ent.name) && !ent.name.startsWith('.')) out.push(p);
  }
  return out.sort();
}

/** SHP 源坐标系：有 .prj 就让 GDAL 自己读；没有则按 LTA 惯例当作 SVY21 (EPSG:3414) */
function sourceSrsArgs(shp: string): string[] {
  const prj = shp.replace(/\.shp$/i, '.prj');
  if (existsSync(prj) && statSync(prj).size > 0) return [];
  const info = run(OGRINFO, ['-so', '-al', shp], { quiet: true }).stdout;
  const m = info.match(/Extent: \(([-\d.]+), ([-\d.]+)\) - \(([-\d.]+), ([-\d.]+)\)/);
  const looksGeographic = m && Math.abs(Number(m[3])) <= 180 && Math.abs(Number(m[4])) <= 90;
  return ['-s_srs', looksGeographic ? 'EPSG:4326' : 'EPSG:3414'];
}

function extractLta(): void {
  ensureDir(LTA_OUT_DIR);
  for (const ds of LTA_DATASETS) {
    const zip = rawLtaZip(ds.name);
    const label = `LTA ${ds.name}`;
    if (sourceMissing(label, zip)) continue;
    const dir = resolve(RAW_LTA_DIR, ds.name);
    if (FORCE || !existsSync(dir) || findShapefiles(dir).length === 0) {
      rmSync(dir, { recursive: true, force: true });
      ensureDir(dir);
      const r = run('unzip', ['-o', '-q', zip, '-d', dir]);
      if (!r.ok) {
        warn(`${label}: unzip failed`);
        failures.push(label);
        continue;
      }
    }
    const shps = findShapefiles(dir);
    if (shps.length === 0) {
      warn(`${label}: no .shp inside zip`);
      failures.push(label);
      continue;
    }
    for (const shp of shps) {
      const out =
        shps.length === 1
          ? resolve(LTA_OUT_DIR, `${ds.name}.geojson`)
          : resolve(LTA_OUT_DIR, `${ds.name}-${basename(shp, '.shp').toLowerCase()}.geojson`);
      // -spat_srs 让过滤框用 WGS84 给出，GDAL 会转到源坐标系 (SVY21) 再过滤；
      // -clipdst 则在目标坐标系 (WGS84) 里把跨边界的线/面真正裁断。
      ogr2ogr(`${label} (${basename(shp)})`, out, [
        ...sourceSrsArgs(shp),
        '-t_srs', 'EPSG:4326',
        '-spat', ...SPAT_ARGS, '-spat_srs', 'EPSG:4326',
        '-clipdst', ...SPAT_ARGS,
        '-nlt', 'PROMOTE_TO_MULTI',
        shp,
      ]);
    }
  }
}

// ---------------------------------------------------------------------------
// data.gov.sg
// ---------------------------------------------------------------------------
function extractDatagov(): void {
  const ura = rawDatagov('ura');
  if (!sourceMissing('URA land use', ura)) {
    ogr2ogr('URA Master Plan 2019 land use', resolve(GEO_DIR, 'ura-landuse.geojson'), [
      '-t_srs', 'EPSG:4326', '-spat', ...SPAT_ARGS, '-clipdst', ...SPAT_ARGS, '-nlt', 'PROMOTE_TO_MULTI', ura,
    ]);
  }
  const hawker = rawDatagov('hawker');
  if (!sourceMissing('NEA hawker centres', hawker)) {
    ogr2ogr('NEA hawker centres', resolve(GEO_DIR, 'hawker.geojson'), ['-t_srs', 'EPSG:4326', '-spat', ...SPAT_ARGS, hawker]);
  }
  const hdb = rawDatagov('hdb');
  if (!sourceMissing('HDB property info', hdb)) {
    const out = resolve(GEO_DIR, 'hdb.csv');
    if (upToDate(out)) log(`SKIP  HDB csv: exists`);
    else {
      copyFileSync(hdb, out);
      log(`OK    HDB property info: hdb.csv ${fmtBytes(fileSize(out))}`);
    }
  }
}

function main(): void {
  ensureDir(GEO_DIR);
  log(`ogr2ogr: ${OGR2OGR}`);
  const v = run(OGR2OGR, ['--version'], { quiet: true });
  if (!v.ok) {
    console.error('ogr2ogr not found. Set GDAL_BIN=<dir containing ogr2ogr> or install GDAL.');
    process.exit(1);
  }
  log(`         ${v.stdout.trim()}\nbbox:    ${SPAT_ARGS.join(' ')}\n`);

  extractOsm();
  extractLta();
  extractDatagov();

  log('\n=== extract summary ===');
  if (failures.length) warn(`${failures.length} item(s) failed: ${failures.join('; ')}`);
  else log('all items extracted');
}

main();
