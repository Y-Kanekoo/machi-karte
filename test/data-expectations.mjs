// 外部タイルを直接読んでテストの期待値を確定するスクリプト（Node実行）
// 実行: node test/data-expectations.mjs
//
// ブラウザからの外部通信は遮断されているが、Node からは curl（プロキシ経由）で出られる。
// harness.mjs の curlFetch を再利用してタイルを取得し、
//   - 洪水/土砂: pngjs でデコードして該当ピクセルの RGBA を出力
//   - 用途地域等: pbf + @mapbox/vector-tile でデコードして点内包判定
// を行い、実測値を出力する。ここで得た値を e2e.test.mjs / 各モジュールのコメントに固定する。

import { PNG } from 'pngjs';
import { VectorTile } from '@mapbox/vector-tile';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
// Node側は pbf 最新版（v5）を使うので `PbfReader`。
// ブラウザ側（js/zoning.js）は CDN の pbf@3.3.0 を動的importするため default export の `Pbf`。
// バージョンが違う点に注意（PLAN.md §4）。
import { PbfReader } from 'pbf';
import { check, curlFetch, equal, report } from './harness.mjs';
import { lonLatToPixel, lonLatToTileLocal, tileUrl, pointInRings } from '../js/tilemath.js';
import { HAZARD_TILES, ZONING_TILES, GEOCODE_URL } from '../js/config.js';
import { resolveArea } from '../js/area.js';
import {
  FLOOD_LEGEND,
  FLOOD_LEGEND_L1,
  KEIZOKU_LEGEND,
  classifyFloodColor,
  classifyFloodL1Color,
  classifyKeizokuColor,
} from '../js/hazard.js';

// GSI住所検索で確定した座標（2026-07-27 実測）
const POINTS = [
  { name: '中野区弥生町二丁目', lon: 139.673935, lat: 35.691502 },
  { name: '中野区本町四丁目',   lon: 139.670731, lat: 35.695683 },
  { name: '中野区中野五丁目',   lon: 139.66893,  lat: 35.707859 },
  { name: '中野区上高田四丁目', lon: 139.67868,  lat: 35.713402 },
  { name: '中野区江古田三丁目', lon: 139.665833, lat: 35.728607 },
  { name: '中野駅（台地側）',   lon: 139.6659,   lat: 35.7010 },
  { name: '中野新橋駅付近',     lon: 139.669,    lat: 35.697 },
];

// R2（防災強化）で追加した地点。§3.1 の表と対応
const R2_POINTS = [
  ...POINTS,
  { name: '南台五丁目',         lon: 139.663,   lat: 35.688 },
  { name: '南台・神田川沿い',   lon: 139.66320, lat: 35.68847 },
  { name: '沼袋',               lon: 139.662,   lat: 35.720 },
];

// R4（マルチエリア）で追加した地点。docs/plans/R4.md §1.5 と対応。
// 2026-07-31 実測期待値（用途地域MVTは全地点 layer=UseDistrict / extent=65536）:
//   渋谷区道玄坂二丁目       洪水=区域外    rgba=[0,0,0,0]         用途地域=商業地域 80%/800%
//   渋谷駅ハチ公前付近       洪水=0.5〜3.0m rgba=[255,216,192,255] 用途地域=商業地域 80%/1000%
//   渋谷区松濤一丁目         洪水=0.5m未満  rgba=[247,245,169,255] 用途地域=第2種中高層住居専用地域 60%/200%
//   三島市一番町（三島駅南） 洪水=区域外    rgba=[0,0,0,0]         用途地域=近隣商業地域 80%/200%
//   三島市大場川沿い         洪水=0.5〜3.0m rgba=[255,216,192,255] 用途地域=第2種中高層住居専用地域 60%/200%
const R4_POINTS = [
  {
    name: '渋谷区道玄坂二丁目',
    lon: 139.698318,
    lat: 35.659397,
    useUrl: 'https://assets.cms.plateau.reearth.io/assets/8c/e32d25-4532-43b4-9523-029812474e78/13113_shibuya-ku_pref_2025_citygml_1_op_urf_UseDistrict_mvt_lod1/{z}/{x}/{y}.mvt',
  },
  {
    name: '渋谷駅ハチ公前付近',
    lon: 139.7006,
    lat: 35.6595,
    useUrl: 'https://assets.cms.plateau.reearth.io/assets/8c/e32d25-4532-43b4-9523-029812474e78/13113_shibuya-ku_pref_2025_citygml_1_op_urf_UseDistrict_mvt_lod1/{z}/{x}/{y}.mvt',
  },
  {
    name: '渋谷区松濤一丁目',
    lon: 139.6926,
    lat: 35.6595,
    useUrl: 'https://assets.cms.plateau.reearth.io/assets/8c/e32d25-4532-43b4-9523-029812474e78/13113_shibuya-ku_pref_2025_citygml_1_op_urf_UseDistrict_mvt_lod1/{z}/{x}/{y}.mvt',
  },
  {
    name: '三島市一番町（三島駅南）',
    lon: 138.912567,
    lat: 35.124771,
    useUrl: 'https://assets.cms.plateau.reearth.io/assets/3d/7a1e6b-83b9-459b-9b88-7d0d9fb664a8/22206_mishima-shi_city_2023_citygml_2_op_urf_UseDistrict_mvt/{z}/{x}/{y}.mvt',
  },
  {
    name: '三島市大場川沿い',
    lon: 138.9291,
    lat: 35.0946,
    useUrl: 'https://assets.cms.plateau.reearth.io/assets/3d/7a1e6b-83b9-459b-9b88-7d0d9fb664a8/22206_mishima-shi_city_2023_citygml_2_op_urf_UseDistrict_mvt/{z}/{x}/{y}.mvt',
  },
];

// --check では、既存の実タイル単体テストと R4 §1.5 で固定した11地点を照合する。
// 中野区は floodRankAt の既存6地点を基準とし、固定済みの用途地域も併せて確認する。
const CHECK_POINTS = [
  {
    city: '13114',
    name: '中野区弥生町二丁目',
    lon: 139.673935,
    lat: 35.691502,
    flood: '0.5m未満',
    use: { name: '近隣商業地域', coverage: 80, floorArea: 400 },
  },
  {
    city: '13114',
    name: '中野区南台五丁目付近',
    lon: 139.663,
    lat: 35.688,
    flood: '0.5〜3.0m',
  },
  {
    city: '13114',
    name: '中野区沼袋付近',
    lon: 139.662,
    lat: 35.72,
    flood: '0.5〜3.0m',
  },
  {
    city: '13114',
    name: '中野区中野五丁目',
    lon: 139.66893,
    lat: 35.707859,
    flood: '区域外',
    use: { name: '第1種中高層住居専用地域', coverage: 60, floorArea: 200 },
  },
  {
    city: '13114',
    name: '中野駅前',
    lon: 139.6659,
    lat: 35.7056,
    flood: '区域外',
    use: { name: '商業地域', coverage: 80, floorArea: 600 },
  },
  {
    city: '13114',
    name: '中野区鷺宮',
    lon: 139.635,
    lat: 35.725,
    flood: '区域外',
    use: { name: '第1種低層住居専用地域', coverage: 50 },
  },
  {
    city: '13113',
    name: '渋谷区道玄坂二丁目',
    lon: 139.698318,
    lat: 35.659397,
    flood: '区域外',
    use: { name: '商業地域', coverage: 80, floorArea: 800 },
  },
  {
    city: '13113',
    name: '渋谷駅ハチ公前付近',
    lon: 139.7006,
    lat: 35.6595,
    flood: '0.5〜3.0m',
    use: { name: '商業地域', coverage: 80, floorArea: 1000 },
  },
  {
    city: '13113',
    name: '渋谷区松濤一丁目',
    lon: 139.6926,
    lat: 35.6595,
    flood: '0.5m未満',
    use: { name: '第2種中高層住居専用地域', coverage: 60, floorArea: 200 },
  },
  {
    city: '22206',
    name: '三島市一番町（三島駅南）',
    lon: 138.912567,
    lat: 35.124771,
    flood: '区域外',
    use: { name: '近隣商業地域', coverage: 80, floorArea: 200 },
  },
  {
    city: '22206',
    name: '三島市大場川沿い',
    lon: 138.9291,
    lat: 35.0946,
    flood: '0.5〜3.0m',
    use: { name: '第2種中高層住居専用地域', coverage: 60, floorArea: 200 },
  },
];

const execFileAsync = promisify(execFile);

function rgba(png, px, py) {
  const i = (png.width * py + px) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

/** タイル内の色分布（上位10色）を [key, count] の配列で返す */
function colorHistogram(png, top = 10) {
  const hist = new Map();
  for (let i = 0; i < png.data.length; i += 4) {
    const k = `${png.data[i]},${png.data[i + 1]},${png.data[i + 2]},${png.data[i + 3]}`;
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  return [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
}

async function loadPng(url) {
  const res = await curlFetch(url);
  if (res.status !== 200) return { status: res.status, png: null };
  try {
    return { status: 200, png: PNG.sync.read(res.body) };
  } catch (e) {
    return { status: 200, png: null, error: String(e) };
  }
}

async function queryMvt(cfg, lon, lat) {
  const t = lonLatToTileLocal(lon, lat, cfg.z, 1); // extentは後で実値に置換
  const url = tileUrl(cfg.url, cfg.z, t.x, t.y);
  const res = await curlFetch(url);
  if (res.status !== 200) return { status: res.status };
  const tile = new VectorTile(new PbfReader(res.body));
  const layerNames = Object.keys(tile.layers);
  const out = { status: 200, layerNames, hits: [], extent: null, nFeatures: 0 };
  for (const ln of layerNames) {
    const layer = tile.layers[ln];
    out.extent = layer.extent;
    out.nFeatures += layer.length;
    const loc = lonLatToTileLocal(lon, lat, cfg.z, layer.extent);
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      const rings = f.loadGeometry();
      if (pointInRings(loc.lx, loc.ly, rings)) {
        out.hits.push({ layer: ln, props: f.properties });
      }
    }
  }
  return out;
}

async function checkFloodAt(point) {
  const cfg = HAZARD_TILES.floodL2;
  const t = lonLatToPixel(point.lon, point.lat, cfg.z);
  const res = await curlFetch(tileUrl(cfg.url, t.z, t.x, t.y));
  if (res.status === 404) return { status: 404, rank: '区域外' };
  if (res.status !== 200) return { status: res.status, rank: null };
  try {
    const png = PNG.sync.read(res.body);
    return {
      status: 200,
      rank: classifyFloodColor(rgba(png, t.px, t.py)).rank,
    };
  } catch (error) {
    return { status: 200, rank: null, error: String(error) };
  }
}

function resolvedAreaUrls(area) {
  const urls = [];
  for (const [key, value] of Object.entries(area.tilesets)) {
    if (key === 'fld') {
      value.forEach(({ url }, index) => urls.push({
        label: `tilesets.fld[${index}]`,
        url,
      }));
    } else if (typeof value === 'string') {
      urls.push({ label: `tilesets.${key}`, url: value });
    }
  }
  for (const [key, value] of Object.entries(area.zoning)) {
    if (value?.url) urls.push({ label: `zoning.${key}`, url: value.url });
  }
  return urls;
}

function materializeTileUrl(url, point) {
  if (!url.includes('{z}')) return url;
  const z = 16;
  const tile = lonLatToPixel(point.lon, point.lat, z);
  return tileUrl(url, z, tile.x, tile.y);
}

async function rangeGetStatus(url) {
  try {
    const { stdout } = await execFileAsync(
      'curl',
      [
        '-sS',
        '-L',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '--max-time',
        '90',
        '--range',
        '0-0',
        url,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    return Number(stdout) || 0;
  } catch (error) {
    return Number(error.stdout) || 0;
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => run()),
  );
  return results;
}

async function runCheckMode() {
  console.log('=== expectations:check ===');
  equal(
    '固定地点数（中野6・渋谷3・三島2）',
    CHECK_POINTS.map(({ city }) => city).join(','),
    [
      ...Array(6).fill('13114'),
      ...Array(3).fill('13113'),
      ...Array(2).fill('22206'),
    ].join(','),
  );

  let areaIndex;
  try {
    areaIndex = JSON.parse(
      fs.readFileSync(new URL('../data/area-index.json', import.meta.url), 'utf8'),
    );
  } catch (error) {
    check('自治体対応表を読み込める', false, String(error));
    report('data-expectations.mjs --check');
    return;
  }

  const areas = {};
  for (const code of ['13114', '13113', '22206']) {
    areas[code] = resolveArea(areaIndex, code);
    check(`${code}: resolveAreaで解決できる`, areas[code] !== null);
  }

  console.log('\n--- 固定11地点の実タイル照合 ---');
  for (const point of CHECK_POINTS) {
    const flood = await checkFloodAt(point);
    check(
      `${point.name}: 洪水タイルを取得できる`,
      flood.status === 200 || (flood.status === 404 && point.flood === '区域外'),
      `HTTP ${flood.status}${flood.error ? ` / ${flood.error}` : ''}`,
    );
    equal(`${point.name}: 洪水`, flood.rank, point.flood);

    if (!point.use) continue;
    const useConfig = areas[point.city]?.zoning.use;
    check(`${point.name}: 用途地域URLを解決できる`, Boolean(useConfig?.url));
    if (!useConfig?.url) continue;
    const zoning = await queryMvt(useConfig, point.lon, point.lat);
    equal(`${point.name}: 用途地域タイルHTTP`, zoning.status, 200);
    const hit = zoning.hits?.find(({ layer, props }) =>
      layer === 'UseDistrict'
      && props.urf_function === point.use.name
      && props.urf_buildingCoverageRate === point.use.coverage
      && (
        point.use.floorArea === undefined
        || props.urf_floorAreaRate === point.use.floorArea
      ));
    check(
      `${point.name}: 用途地域`,
      Boolean(hit),
      `expected ${JSON.stringify(point.use)}, got ${JSON.stringify(zoning.hits || [])}`,
    );
  }

  console.log('\n--- resolveArea 全URLのカタログ照合（GET Range: 0-0） ---');
  const urlChecks = [];
  for (const [code, area] of Object.entries(areas)) {
    if (!area) continue;
    const points = CHECK_POINTS.filter((candidate) => candidate.city === code);
    for (const entry of resolvedAreaUrls(area)) {
      urlChecks.push({
        code,
        label: entry.label,
        urls: entry.url.includes('{z}')
          ? [...new Set(points.map((point) => materializeTileUrl(entry.url, point)))]
          : [entry.url],
      });
    }
  }
  const statuses = await mapWithConcurrency(
    urlChecks,
    4,
    async (entry) => {
      let status = 0;
      let checkedUrl = entry.urls[0];
      for (const url of entry.urls) {
        checkedUrl = url;
        status = await rangeGetStatus(url);
        if (status === 200 || status === 206) break;
      }
      return { ...entry, status, checkedUrl };
    },
  );
  for (const { code, label, status, checkedUrl } of statuses) {
    check(
      `${code}: ${label}`,
      status === 200 || status === 206,
      `HTTP ${status} / ${checkedUrl}`,
    );
  }

  report('data-expectations.mjs --check');
}

const CHECK_MODE = process.argv.slice(2).includes('--check');

if (CHECK_MODE) {
  await runCheckMode();
} else {
// ---- 1. 洪水浸水想定（想定最大規模） ----------------------------------------

console.log('=== 洪水浸水想定（想定最大規模） z=16 ===');
const floodResults = {};
for (const p of POINTS) {
  const t = lonLatToPixel(p.lon, p.lat, HAZARD_TILES.floodL2.z);
  const url = tileUrl(HAZARD_TILES.floodL2.url, t.z, t.x, t.y);
  const { status, png } = await loadPng(url);
  if (!png) {
    console.log(`  ${p.name.padEnd(16)} HTTP ${status} タイルなし → 区域外`);
    floodResults[p.name] = { rank: '区域外', rgba: null };
    continue;
  }
  const c = rgba(png, t.px, t.py);
  const cls = classifyFloodColor(c);
  console.log(
    `  ${p.name.padEnd(16)} tile=${t.x}/${t.y} px=(${t.px},${t.py}) rgba=[${c}] → ${cls.rank} (距離 ${cls.distance.toFixed(1)})`
  );
  floodResults[p.name] = { rank: cls.rank, rgba: c };
}

console.log('\n--- R4検証地点（渋谷区・三島市） ---');
for (const p of R4_POINTS) {
  const t = lonLatToPixel(p.lon, p.lat, HAZARD_TILES.floodL2.z);
  const url = tileUrl(HAZARD_TILES.floodL2.url, t.z, t.x, t.y);
  const { status, png } = await loadPng(url);
  if (!png) {
    console.log(`  ${p.name.padEnd(20)} HTTP ${status} タイルなし → 区域外`);
    continue;
  }
  const c = rgba(png, t.px, t.py);
  const cls = classifyFloodColor(c);
  console.log(
    `  ${p.name.padEnd(20)} tile=${t.x}/${t.y} px=(${t.px},${t.py}) rgba=[${c}] → ${cls.rank} (距離 ${cls.distance.toFixed(1)})`
  );
}

// タイル内に実際に含まれる色の分布（凡例表の検証用）
console.log('\n--- 弥生町タイルに含まれる色の分布（上位10） ---');
{
  const t = lonLatToPixel(139.673935, 35.691502, 16);
  const { png } = await loadPng(tileUrl(HAZARD_TILES.floodL2.url, t.z, t.x, t.y));
  if (png) {
    const hist = new Map();
    for (let i = 0; i < png.data.length; i += 4) {
      const k = `${png.data[i]},${png.data[i + 1]},${png.data[i + 2]},${png.data[i + 3]}`;
      hist.set(k, (hist.get(k) || 0) + 1);
    }
    [...hist.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .forEach(([k, n]) => {
        const c = k.split(',').map(Number);
        const cls = c[3] === 0 ? { rank: '区域外', distance: 0 } : classifyFloodColor(c);
        console.log(`    [${k}] × ${n} → ${cls.rank} (距離 ${cls.distance.toFixed(1)})`);
      });
    console.log(`    凡例表: ${FLOOD_LEGEND.map((l) => l.rank).join(' / ')}`);
  }
}

// ---- 1b. 浸水継続時間（想定最大規模） R2 --------------------------------------

console.log('\n=== 浸水継続時間（想定最大規模） z=16 ===');
for (const p of R2_POINTS) {
  const cfg = HAZARD_TILES.floodKeizoku;
  const t = lonLatToPixel(p.lon, p.lat, cfg.z);
  const { status, png } = await loadPng(tileUrl(cfg.url, t.z, t.x, t.y));
  if (!png) {
    console.log(`  ${p.name.padEnd(16)} HTTP ${status} タイルなし → データなし`);
    continue;
  }
  const c = rgba(png, t.px, t.py);
  const cls = classifyKeizokuColor(c);
  console.log(
    `  ${p.name.padEnd(16)} tile=${t.x}/${t.y} px=(${t.px},${t.py}) rgba=[${c}] → ${cls.rank} (距離 ${cls.distance.toFixed(1)})`
  );
}

console.log('\n--- 継続時間タイルに含まれる色の分布（南台／弥生町） ---');
for (const p of [
  { name: '南台', lon: 139.663, lat: 35.688 },
  { name: '弥生町', lon: 139.673935, lat: 35.691502 },
]) {
  const cfg = HAZARD_TILES.floodKeizoku;
  const t = lonLatToPixel(p.lon, p.lat, cfg.z);
  const { status, png } = await loadPng(tileUrl(cfg.url, t.z, t.x, t.y));
  if (!png) { console.log(`  ${p.name}: HTTP ${status}`); continue; }
  console.log(`  ${p.name} tile=${t.x}/${t.y}`);
  for (const [k, n] of colorHistogram(png)) {
    const c = k.split(',').map(Number);
    const cls = classifyKeizokuColor(c);
    console.log(`    [${k}] × ${n} → ${cls.rank} (距離 ${cls.distance.toFixed(1)})`);
  }
}
console.log(`  凡例表: ${KEIZOKU_LEGEND.map((l) => l.rank).join(' / ')}`);

console.log('\n--- 継続時間の凡例画像に含まれる色（上位12） ---');
{
  const { status, png } = await loadPng(
    'https://disaportal.gsi.go.jp/hazardmap/copyright/img/shinsui_legend_l2_keizoku.png'
  );
  if (!png) console.log(`  HTTP ${status}`);
  else {
    for (const [k, n] of colorHistogram(png, 12)) {
      const c = k.split(',').map(Number);
      const hit = KEIZOKU_LEGEND.find((l) => l.rgb.every((v, i) => v === c[i]));
      console.log(`    [${k}] × ${n}${hit ? ` → 凡例表の「${hit.rank}」と一致` : ''}`);
    }
  }
}

// ---- 1c. 洪水浸水想定（計画規模・新凡例） R2 ------------------------------------

console.log('\n=== 洪水浸水想定（計画規模・newlegend） z=16 ===');
for (const p of R2_POINTS) {
  const cfg = HAZARD_TILES.floodL1;
  const t = lonLatToPixel(p.lon, p.lat, cfg.z);
  const { status, png } = await loadPng(tileUrl(cfg.url, t.z, t.x, t.y));
  if (!png) {
    console.log(`  ${p.name.padEnd(16)} HTTP ${status} タイルなし → 区域外`);
    continue;
  }
  const c = rgba(png, t.px, t.py);
  const cls = classifyFloodL1Color(c);
  console.log(
    `  ${p.name.padEnd(16)} tile=${t.x}/${t.y} px=(${t.px},${t.py}) rgba=[${c}] → ${cls.rank} (距離 ${cls.distance.toFixed(1)})`
  );
}

console.log('\n--- 計画規模タイルに含まれる色の分布（南台） ---');
{
  const cfg = HAZARD_TILES.floodL1;
  const t = lonLatToPixel(139.663, 35.688, cfg.z);
  const { status, png } = await loadPng(tileUrl(cfg.url, t.z, t.x, t.y));
  if (!png) console.log(`  HTTP ${status}`);
  else {
    for (const [k, n] of colorHistogram(png)) {
      const c = k.split(',').map(Number);
      const cls = classifyFloodL1Color(c);
      console.log(`    [${k}] × ${n} → ${cls.rank} (距離 ${cls.distance.toFixed(1)})`);
    }
  }
  console.log(`  凡例表(L1): ${FLOOD_LEGEND_L1.map((l) => l.rank).join(' / ')}`);
}

// 参考: newlegend なしのパスは中野区で配信されない（§3.1の注意書きの再確認）
{
  const t = lonLatToPixel(139.663, 35.688, 16);
  const url = tileUrl(
    'https://disaportaldata.gsi.go.jp/raster/01_flood_l1_shinsuishin_data/{z}/{x}/{y}.png',
    t.z, t.x, t.y
  );
  const { status } = await loadPng(url);
  console.log(`  参考: 01_flood_l1_shinsuishin_data（newlegendなし）南台 → HTTP ${status}`);
}

// ---- 2. 土砂災害警戒区域 -----------------------------------------------------

console.log('\n=== 土砂災害警戒区域 z=16 ===');
for (const key of ['debrisFlow', 'steepSlope', 'landslide']) {
  const cfg = HAZARD_TILES[key];
  const line = [];
  for (const p of POINTS) {
    const t = lonLatToPixel(p.lon, p.lat, cfg.z);
    const { status, png } = await loadPng(tileUrl(cfg.url, t.z, t.x, t.y));
    if (!png) { line.push(`${p.name}:HTTP${status}`); continue; }
    const c = rgba(png, t.px, t.py);
    line.push(`${p.name}:[${c}]`);
  }
  console.log(`  ${cfg.label}: ${line.join('  ')}`);
}

// ---- 3. 用途地域・防火地域・高度地区（MVT） -----------------------------------

console.log('\n=== 都市計画MVT z=16 ===');
console.log('\n--- R4検証地点の用途地域（渋谷区・三島市） ---');
for (const p of R4_POINTS) {
  const r = await queryMvt({ url: p.useUrl, z: 16 }, p.lon, p.lat);
  if (r.status !== 200) {
    console.log(`  ${p.name.padEnd(20)} HTTP ${r.status}`);
    continue;
  }
  if (!r.hits.length) {
    console.log(
      `  ${p.name.padEnd(20)} 該当なし (layers=${r.layerNames} extent=${r.extent} features=${r.nFeatures})`
    );
    continue;
  }
  for (const h of r.hits) {
    const props = h.props;
    console.log(
      `  ${p.name.padEnd(20)} [${h.layer}] extent=${r.extent} ` +
      `${props.urf_function} 建蔽率=${props.urf_buildingCoverageRate}% ` +
      `容積率=${props.urf_floorAreaRate}%`
    );
  }
}

for (const key of ['use', 'fire', 'height']) {
  const cfg = ZONING_TILES[key];
  console.log(`\n--- ${cfg.label} ---`);
  for (const p of POINTS) {
    const r = await queryMvt(cfg, p.lon, p.lat);
    if (r.status !== 200) { console.log(`  ${p.name.padEnd(16)} HTTP ${r.status}`); continue; }
    if (!r.hits.length) {
      console.log(`  ${p.name.padEnd(16)} 該当なし (layers=${r.layerNames} extent=${r.extent} features=${r.nFeatures})`);
      continue;
    }
    for (const h of r.hits) {
      const props = h.props;
      const compact = Object.fromEntries(
        Object.entries(props).filter(([k]) => /urf_|city_name|class/.test(k))
      );
      console.log(`  ${p.name.padEnd(16)} [${h.layer}] extent=${r.extent} ${JSON.stringify(compact)}`);
    }
  }
  // 属性キーの全列挙（1件だけ）
  const sample = await queryMvt(cfg, 139.66893, 35.707859);
  if (sample.hits?.length) {
    console.log(`  属性キー一覧: ${Object.keys(sample.hits[0].props).join(', ')}`);
  }
}

// ---- 4. 住所検索API -----------------------------------------------------------

console.log('\n=== 住所検索API ===');
for (const q of ['中野区中野五丁目', '中野区弥生町2丁目', 'ｚｚ存在しない住所ｚｚ']) {
  const res = await curlFetch(`${GEOCODE_URL}?q=${encodeURIComponent(q)}`);
  const body = res.body.toString('utf8');
  console.log(`  "${q}" → HTTP ${res.status} ${body.slice(0, 200)}`);
}
}
