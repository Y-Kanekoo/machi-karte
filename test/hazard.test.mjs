// hazard.js / zoning.js のロジック単体テスト + 実タイルによる期待値の固定
// 実行: node test/hazard.test.mjs
//
// 判定ロジック（色分類・点内包判定）はブラウザ非依存なので Node でそのまま検証できる。
// タイルの取得は harness.mjs の curlFetch（プロキシ経由・ディスクキャッシュ）を使う。
//
// ここでの期待値はすべて 2026-07-27 に test/data-expectations.mjs と test/output/probe.mjs で
// 実測した値。外部データが更新されたら data-expectations を再実行して更新すること。

import { PNG } from 'pngjs';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf'; // Node は pbf v5。ブラウザ側は CDN の pbf@3.3.0（default export）
import { curlFetch, check, equal, report, SKIP_NETWORK } from './harness.mjs';
import { lonLatToPixel, lonLatToTileLocal, tileUrl, pointInRings } from '../js/tilemath.js';
import { HAZARD_TILES, ZONING_TILES } from '../js/config.js';
import {
  classifyFloodColor,
  classifyFloodL1Color,
  classifyKeizokuColor,
  classifyLandslideColor,
  FLOOD_LEGEND,
  FLOOD_LEGEND_L1,
  KEIZOKU_LEGEND,
  COLOR_MATCH_THRESHOLD,
} from '../js/hazard.js';

// ---- 1. 色分類ロジック --------------------------------------------------------

console.log('--- 洪水の色分類 ---');
equal('完全透過は区域外', classifyFloodColor([0, 0, 0, 0]).rank, '区域外');
equal('nullは区域外', classifyFloodColor(null).rank, '区域外');
for (const l of FLOOD_LEGEND) {
  equal(`凡例色 [${l.rgb}] → ${l.rank}`, classifyFloodColor([...l.rgb, 255]).rank, l.rank);
}
// アンチエイリアス想定（±20のズレ）でも最近傍で拾える
equal('近傍色（+15ずれ）も最近傍で判定',
  classifyFloodColor([247 - 15, 245 - 10, 169 + 10, 255]).rank, '0.5m未満');
// 凡例と全く違う色は判定不能
equal('無関係な色は判定不能', classifyFloodColor([0, 128, 0, 255]).rank, '判定不能');
check('判定不能の距離が閾値超',
  classifyFloodColor([0, 128, 0, 255]).distance > COLOR_MATCH_THRESHOLD);
// 半透明の境界ピクセルは区域外に寄せる
equal('アルファ小(30)は区域外', classifyFloodColor([255, 216, 192, 30]).rank, '区域外');

console.log('--- 洪水（計画規模・新凡例）の色分類 ---');
equal('L1: 完全透過は区域外', classifyFloodL1Color([0, 0, 0, 0]).rank, '区域外');
equal('L1: nullは区域外', classifyFloodL1Color(null).rank, '区域外');
for (const l of FLOOD_LEGEND_L1) {
  equal(`L1凡例色 [${l.rgb}] → ${l.rank}`, classifyFloodL1Color([...l.rgb, 255]).rank, l.rank);
}
// 細分色と既存色の分離（RGB距離 20.2。最近傍でも取り違えないこと）
equal('L1: 細分色[248,225,166]は0.5〜1.0m',
  classifyFloodL1Color([248, 225, 166, 255]).rank, '0.5〜1.0m');
equal('L1: 既存色[247,245,169]は0.5m未満',
  classifyFloodL1Color([247, 245, 169, 255]).rank, '0.5m未満');
check('L1: 細分色と既存色のRGB距離が20前後',
  Math.abs(Math.hypot(248 - 247, 225 - 245, 166 - 169) - 20.2) < 0.2,
  String(Math.hypot(248 - 247, 225 - 245, 166 - 169)));
equal('L1: 細分色は0.5〜1.0mのdepthMaxが1',
  classifyFloodL1Color([248, 225, 166, 255]).depthMax, 1);
// L2用テーブルに細分色を混ぜていないこと（L2で引くと既存色に丸められる）
equal('L2テーブルには細分色がない', classifyFloodColor([248, 225, 166, 255]).rank, '0.5m未満');
check('L2の凡例は6色のまま', FLOOD_LEGEND.length === 6, String(FLOOD_LEGEND.length));
check('L1の凡例は8色', FLOOD_LEGEND_L1.length === 8, String(FLOOD_LEGEND_L1.length));

console.log('--- 浸水継続時間の色分類 ---');
equal('継続: 完全透過はデータなし', classifyKeizokuColor([0, 0, 0, 0]).rank, 'データなし');
equal('継続: null（タイル404）はデータなし', classifyKeizokuColor(null).rank, 'データなし');
for (const l of KEIZOKU_LEGEND) {
  equal(`継続凡例色 [${l.rgb}] → ${l.rank}`, classifyKeizokuColor([...l.rgb, 255]).rank, l.rank);
}
check('継続の凡例は7ランク', KEIZOKU_LEGEND.length === 7, String(KEIZOKU_LEGEND.length));
equal('継続: 近傍色（±12ずれ）も最近傍で判定',
  classifyKeizokuColor([160 - 12, 210 + 8, 255 - 10, 255]).rank, '12時間未満');
equal('継続: アルファ小(30)はデータなし', classifyKeizokuColor([160, 210, 255, 30]).rank, 'データなし');
equal('継続: 凡例と無関係な色は判定不能', classifyKeizokuColor([0, 200, 0, 255]).rank, '判定不能');

console.log('--- 土砂災害の色分類 ---');
equal('透過は区域外', classifyLandslideColor([0, 0, 0, 0]).rank, '区域外');
equal('実測イエロー[250,230,0]', classifyLandslideColor([250, 230, 0, 255]).rank, '警戒区域（イエロー）');
equal('実測レッド[250,40,0]', classifyLandslideColor([250, 40, 0, 255]).rank, '特別警戒区域（レッド）');
equal('境界の半透明イエローも警戒区域',
  classifyLandslideColor([250, 229, 0, 170]).rank, '警戒区域（イエロー）');
equal('非透明だが凡例外の色は区分不明',
  classifyLandslideColor([0, 0, 255, 255]).rank, '区域内（区分不明）');

// ---- 2. 実タイルによる期待値（2026-07-27 実測） --------------------------------
//
// SKIP_NETWORK=1 のときはここから下（外部データ取得を伴う照合）を丸ごと飛ばす。
// CIは外部サーバの都合で赤くなるのを避けるため既定でスキップし、週1のscheduleで
// フラグ無し（実タイル照合込み）を実行する。

async function floodRankAt(lon, lat) {
  const cfg = HAZARD_TILES.floodL2;
  const t = lonLatToPixel(lon, lat, cfg.z);
  const res = await curlFetch(tileUrl(cfg.url, t.z, t.x, t.y));
  if (res.status !== 200) return '区域外'; // タイル自体が無い＝区域外
  const png = PNG.sync.read(res.body);
  const i = (png.width * t.py + t.px) * 4;
  return classifyFloodColor([png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]]).rank;
}

/** 浸水継続時間のランク（タイル404 = データなし） */
async function keizokuRankAt(lon, lat) {
  const cfg = HAZARD_TILES.floodKeizoku;
  const t = lonLatToPixel(lon, lat, cfg.z);
  const res = await curlFetch(tileUrl(cfg.url, t.z, t.x, t.y));
  if (res.status !== 200) return 'データなし';
  const png = PNG.sync.read(res.body);
  const i = (png.width * t.py + t.px) * 4;
  return classifyKeizokuColor([png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]]).rank;
}

/** 洪水（計画規模）のランク（タイル404 = 区域外） */
async function floodL1RankAt(lon, lat) {
  const cfg = HAZARD_TILES.floodL1;
  const t = lonLatToPixel(lon, lat, cfg.z);
  const res = await curlFetch(tileUrl(cfg.url, t.z, t.x, t.y));
  if (res.status !== 200) return '区域外';
  const png = PNG.sync.read(res.body);
  const i = (png.width * t.py + t.px) * 4;
  return classifyFloodL1Color([png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]]).rank;
}

async function landslideRankAt(key, lon, lat) {
  const cfg = HAZARD_TILES[key];
  const t = lonLatToPixel(lon, lat, cfg.z);
  const res = await curlFetch(tileUrl(cfg.url, t.z, t.x, t.y));
  if (res.status !== 200) return '区域外';
  const png = PNG.sync.read(res.body);
  const i = (png.width * t.py + t.px) * 4;
  return classifyLandslideColor([png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]]).rank;
}

async function zoningAt(key, lon, lat) {
  const cfg = ZONING_TILES[key];
  const t0 = lonLatToTileLocal(lon, lat, cfg.z, 1);
  const res = await curlFetch(tileUrl(cfg.url, cfg.z, t0.x, t0.y));
  if (res.status !== 200) return null;
  const tile = new VectorTile(new PbfReader(res.body));
  for (const name of Object.keys(tile.layers)) {
    const layer = tile.layers[name];
    const loc = lonLatToTileLocal(lon, lat, cfg.z, layer.extent);
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (pointInRings(loc.lx, loc.ly, f.loadGeometry())) return { layer: name, props: f.properties };
    }
  }
  return null;
}

if (SKIP_NETWORK) {
  console.log('--- 実タイル照合: SKIP_NETWORK=1 のためスキップ ---');
} else {
console.log('--- 実タイル: 洪水浸水想定（想定最大規模） ---');
equal('弥生町二丁目(139.673935,35.691502)', await floodRankAt(139.673935, 35.691502), '0.5m未満');
equal('南台五丁目付近(139.663,35.688)', await floodRankAt(139.663, 35.688), '0.5〜3.0m');
equal('沼袋付近(139.662,35.720)', await floodRankAt(139.662, 35.72), '0.5〜3.0m');
equal('中野五丁目(139.66893,35.707859)', await floodRankAt(139.66893, 35.707859), '区域外');
equal('中野駅北口サンモール(139.6656,35.7072)', await floodRankAt(139.6656, 35.7072), '区域外');
equal('鷺宮(139.635,35.725)', await floodRankAt(139.635, 35.725), '区域外');

console.log('--- 実タイル: 浸水継続時間（想定最大規模） ---');
// 2026-07-28 に test/data-expectations.mjs で再確認（R2計画書 §3.1 の表と一致）
equal('南台五丁目(139.663,35.688)', await keizokuRankAt(139.663, 35.688), '12時間未満');
equal('南台・神田川沿い(139.6632,35.68847)', await keizokuRankAt(139.6632, 35.68847), '12時間〜1日');
equal('沼袋(139.662,35.720)', await keizokuRankAt(139.662, 35.72), '12時間未満');
// 洪水L2は「0.5m未満」なのに継続時間は透明（＝データなし）という実例
equal('弥生町二丁目は透明=データなし', await keizokuRankAt(139.673935, 35.691502), 'データなし');
equal('本町四丁目は透明=データなし', await keizokuRankAt(139.670731, 35.695683), 'データなし');
equal('中野五丁目はタイル404=データなし', await keizokuRankAt(139.66893, 35.707859), 'データなし');

console.log('--- 実タイル: 洪水浸水想定（計画規模・newlegend） ---');
equal('南台五丁目(139.663,35.688)', await floodL1RankAt(139.663, 35.688), '0.5〜1.0m');
equal('南台・神田川沿い(139.6632,35.68847)', await floodL1RankAt(139.6632, 35.68847), '0.5〜3.0m');
equal('沼袋(139.662,35.720)', await floodL1RankAt(139.662, 35.72), '区域外');
equal('弥生町二丁目(139.673935,35.691502)', await floodL1RankAt(139.673935, 35.691502), '区域外');
equal('中野五丁目(139.66893,35.707859)', await floodL1RankAt(139.66893, 35.707859), '区域外');
equal('上高田四丁目(139.67868,35.713402)', await floodL1RankAt(139.67868, 35.713402), '区域外');

console.log('--- 実タイル: 土砂災害警戒区域 ---');
equal('上高田四丁目 急傾斜地', await landslideRankAt('steepSlope', 139.67868, 35.713402), '警戒区域（イエロー）');
equal('上高田四丁目 土石流（中野区に指定なし）', await landslideRankAt('debrisFlow', 139.67868, 35.713402), '区域外');
equal('上高田四丁目 地すべり（中野区に指定なし）', await landslideRankAt('landslide', 139.67868, 35.713402), '区域外');
equal('中野五丁目 急傾斜地', await landslideRankAt('steepSlope', 139.66893, 35.707859), '区域外');

console.log('--- 実タイル: 用途地域 ---');
{
  const z = await zoningAt('use', 139.66893, 35.707859);
  equal('中野五丁目 レイヤー名', z?.layer, 'UseDistrict');
  equal('中野五丁目 用途地域', z?.props.urf_function, '第1種中高層住居専用地域');
  equal('中野五丁目 建蔽率', z?.props.urf_buildingCoverageRate, 60);
  equal('中野五丁目 容積率', z?.props.urf_floorAreaRate, 200);
}
{
  const z = await zoningAt('use', 139.6659, 35.7056); // 中野駅前
  equal('中野駅前 用途地域', z?.props.urf_function, '商業地域');
  equal('中野駅前 建蔽率', z?.props.urf_buildingCoverageRate, 80);
  equal('中野駅前 容積率', z?.props.urf_floorAreaRate, 600);
}
{
  const z = await zoningAt('use', 139.635, 35.725); // 鷺宮（閑静な住宅地）
  equal('鷺宮 用途地域', z?.props.urf_function, '第1種低層住居専用地域');
  equal('鷺宮 建蔽率', z?.props.urf_buildingCoverageRate, 50);
}
{
  const z = await zoningAt('use', 139.673935, 35.691502); // 弥生町二丁目
  equal('弥生町二丁目 用途地域', z?.props.urf_function, '近隣商業地域');
  equal('弥生町二丁目 容積率', z?.props.urf_floorAreaRate, 400);
}

console.log('--- 実タイル: 防火地域・高度地区 ---');
{
  const f = await zoningAt('fire', 139.66893, 35.707859);
  equal('中野五丁目 レイヤー名', f?.layer, 'FirePreventionDistrict');
  equal('中野五丁目 防火地域', f?.props.urf_function, '準防火地域');
  const h = await zoningAt('height', 139.66893, 35.707859);
  equal('中野五丁目 高度地区レイヤー名', h?.layer, 'HeightControlDistrict');
  equal('中野五丁目 高度地区', h?.props.urf_function, '高度地区');
}

// 区境: MVTタイルには隣接区のフィーチャも入っている（city_codeでフィルタしてはいけない）
{
  const z = await zoningAt('use', 139.663, 35.688); // 中野区南端、杉並区側のポリゴンにかかる
  check('区境付近でも用途地域が引ける（隣接区フィーチャを除外しない）',
    !!z?.props.urf_function, JSON.stringify(z?.props?.urf_location));
  console.log(`    → ${z?.props.urf_function} (${z?.props.urf_location})`);
}

} // end SKIP_NETWORK

report('hazard.test.mjs');
