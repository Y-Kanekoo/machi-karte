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
// Node側は pbf 最新版（v5）を使うので `PbfReader`。
// ブラウザ側（js/zoning.js）は CDN の pbf@3.3.0 を動的importするため default export の `Pbf`。
// バージョンが違う点に注意（PLAN.md §4）。
import { PbfReader } from 'pbf';
import { curlFetch } from './harness.mjs';
import { lonLatToPixel, lonLatToTileLocal, tileUrl, pointInRings } from '../js/tilemath.js';
import { HAZARD_TILES, ZONING_TILES, GEOCODE_URL } from '../js/config.js';
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
