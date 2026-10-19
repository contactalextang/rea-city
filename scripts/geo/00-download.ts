// 第 0 步：下载原始数据到 data/geo/raw/（已存在且 > 1 KB 则跳过）。
// 用法：node scripts/geo/00-download.ts [--force]
// 任一数据源失败只打印 WARN 并继续，最后汇总。
import { renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DATAGOV,
  LTA_BASE,
  LTA_DATASETS,
  LTA_PAGE,
  OSM,
  RAW_DIR,
  RAW_LTA_DIR,
  RAW_OSM,
  ensureDir,
  fileSize,
  fmtBytes,
  log,
  rawDatagov,
  rawLtaZip,
  run,
  warn,
} from './lib/common.ts';

const FORCE = process.argv.includes('--force');
const MIN_BYTES = 1024;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) rea-city-geo-pipeline/1.0';

interface Report {
  name: string;
  url: string;
  dest: string;
  status: 'ok' | 'skipped' | 'failed';
  note?: string;
}
const report: Report[] = [];

function alreadyThere(dest: string): boolean {
  return !FORCE && fileSize(dest) > MIN_BYTES;
}

/** curl -L --fail --retry 3，先写 .part 再改名，避免留下半截文件 */
function curlTo(url: string, dest: string): boolean {
  const part = `${dest}.part`;
  rmSync(part, { force: true });
  const r = run(
    'curl',
    ['-L', '--fail', '--retry', '3', '--retry-delay', '2', '-sS', '-A', UA, '-e', LTA_PAGE, '-o', part, url],
    { quiet: true },
  );
  if (!r.ok || fileSize(part) <= MIN_BYTES) {
    const why = r.stderr.trim().split('\n').pop() ?? '';
    log(`  curl failed (${r.status}): ${why}`);
    rmSync(part, { force: true });
    return false;
  }
  renameSync(part, dest);
  return true;
}

/** 依次尝试多个 URL；每个 URL 可以是懒计算的（例如要先问 API 才知道） */
async function download(name: string, dest: string, candidates: Array<string | (() => Promise<string | null>)>): Promise<void> {
  if (alreadyThere(dest)) {
    log(`SKIP  ${name}: exists (${fmtBytes(fileSize(dest))}) ${dest}`);
    report.push({ name, url: '(cached)', dest, status: 'skipped' });
    return;
  }
  for (const c of candidates) {
    let url: string | null;
    try {
      url = typeof c === 'string' ? c : await c();
    } catch (e) {
      log(`  resolving URL failed: ${(e as Error).message}`);
      url = null;
    }
    if (!url) continue;
    log(`GET   ${name}\n      ${url.length > 140 ? url.slice(0, 140) + '…' : url}`);
    if (curlTo(url, dest)) {
      log(`OK    ${name}: ${fmtBytes(fileSize(dest))} -> ${dest}`);
      report.push({ name, url, dest, status: 'ok' });
      return;
    }
  }
  warn(`${name}: all sources failed, continuing without it`);
  report.push({ name, url: '-', dest, status: 'failed', note: 'all candidate URLs failed' });
}

// ---------------------------------------------------------------------------
// data.gov.sg：poll-download 拿到带签名的 S3 直链（1 小时有效）
// ---------------------------------------------------------------------------
async function datagovUrl(datasetId: string): Promise<string | null> {
  const base = `https://api-open.data.gov.sg/v1/public/api/datasets/${datasetId}`;
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await fetch(`${base}/poll-download`, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`poll-download HTTP ${res.status}`);
    const json = (await res.json()) as { code: number; data?: { url?: string; status?: string }; errorMsg?: string };
    if (json.code !== 0) throw new Error(`poll-download code ${json.code}: ${json.errorMsg ?? ''}`);
    if (json.data?.url) return json.data.url;
    // 大数据集可能需要先 initiate-download 再轮询
    if (attempt === 0) await fetch(`${base}/initiate-download`, { headers: { 'User-Agent': UA } }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

// ---------------------------------------------------------------------------
// LTA：固定文件名失败时，抓静态数据页面按前缀重新找（LTA 每月改后缀）
// ---------------------------------------------------------------------------
let ltaPageHtml: string | null = null;
async function ltaUrlFromPage(prefix: string): Promise<string | null> {
  if (ltaPageHtml === null) {
    const res = await fetch(LTA_PAGE, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`LTA page HTTP ${res.status}`);
    ltaPageHtml = await res.text();
  }
  const re = new RegExp(`/content/dam/datamall/datasets/Geospatial/${prefix}[^"']*\\.zip`, 'gi');
  const hits = [...new Set(ltaPageHtml.match(re) ?? [])].filter((p) => !/Planned Map Update/i.test(p));
  if (hits.length === 0) return null;
  return 'https://datamall.lta.gov.sg' + hits[0];
}

// ---------------------------------------------------------------------------
// BBBike：固定文件名失效时扫描目录页
// ---------------------------------------------------------------------------
async function bbbikeUrlFromIndex(): Promise<string | null> {
  const res = await fetch(OSM.bbbikeDir, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`BBBike index HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/href="([^"]*\.osm\.pbf)"/i);
  return m ? new URL(m[1], OSM.bbbikeDir).toString() : null;
}

async function main(): Promise<void> {
  ensureDir(RAW_DIR);
  ensureDir(RAW_LTA_DIR);
  log(`raw dir: ${RAW_DIR}${FORCE ? ' (force re-download)' : ''}\n`);

  // 1. OSM PBF
  await download('OSM Singapore PBF', RAW_OSM, [OSM.bbbike, bbbikeUrlFromIndex, OSM.geofabrik]);

  // 2–4. data.gov.sg
  for (const key of ['hdb', 'ura', 'hawker'] as const) {
    const ds = DATAGOV[key];
    await download(`data.gov.sg ${ds.name} (${ds.id})`, rawDatagov(key), [() => datagovUrl(ds.id)]);
  }

  // 5. LTA DataMall SHP zips
  for (const ds of LTA_DATASETS) {
    await download(`LTA ${ds.name}`, rawLtaZip(ds.name), [LTA_BASE + ds.zip, () => ltaUrlFromPage(ds.prefix)]);
  }

  // 汇总
  log('\n=== download summary ===');
  for (const r of report) {
    const size = fmtBytes(fileSize(r.dest));
    log(`${r.status.padEnd(7)} ${r.name.padEnd(60)} ${size.padStart(9)}  ${r.status === 'ok' ? r.url.split('?')[0] : r.note ?? ''}`);
  }
  const failed = report.filter((r) => r.status === 'failed');
  if (failed.length) warn(`${failed.length} source(s) failed: ${failed.map((f) => f.name).join('; ')}`);
  log(`raw dir listing: ${resolve(RAW_DIR)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
