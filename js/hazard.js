// ハザードマップポータル（重ねるハザードマップ）のラスタタイルから
// 地点のリスク区分を判定する。
//
// タイルPNGを1枚取得 → canvasに描いて該当ピクセルのRGBAを読み、凡例色と照合する。
// ロジック部（classifyFloodColor / classifyLandslideColor）はDOM非依存なので
// Node からも import して単体テストできる。

import { HAZARD_TILES } from './config.js';
import { lonLatToPixel, tileUrl } from './tilemath.js';

/**
 * 洪水浸水想定区域（想定最大規模）の凡例色。
 *
 * 実測（2026-07-27、test/data-expectations.mjs でタイル 16/58194/25804（弥生町）を
 * pngjs でデコードし、タイル内の色分布を集計）:
 *   [0,0,0,0] × 30905（区域外） / [255,216,192,255] × 27294 / [247,245,169,255] × 5803
 *   [255,183,183,255] × 1354 / [255,145,145,255] × 180
 * 出現した色はいずれも下記の凡例表とRGB距離0で一致。PLAN.md §3 の表どおりだった。
 */
export const FLOOD_LEGEND = [
  { rank: '0.5m未満',    rgb: [247, 245, 169], depthMin: 0,    depthMax: 0.5 },
  { rank: '0.5〜3.0m',   rgb: [255, 216, 192], depthMin: 0.5,  depthMax: 3 },
  { rank: '3.0〜5.0m',   rgb: [255, 183, 183], depthMin: 3,    depthMax: 5 },
  { rank: '5.0〜10.0m',  rgb: [255, 145, 145], depthMin: 5,    depthMax: 10 },
  { rank: '10.0〜20.0m', rgb: [242, 133, 201], depthMin: 10,   depthMax: 20 },
  { rank: '20.0m以上',   rgb: [220, 122, 220], depthMin: 20,   depthMax: Infinity },
];

/** 凡例色とのユークリッド距離がこれを超えたら「判定不能」 */
export const COLOR_MATCH_THRESHOLD = 60;

/** 透過とみなすアルファ閾値（アンチエイリアス境界を区域外に寄せる） */
const ALPHA_THRESHOLD = 60;

function colorDistance(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * 洪水浸水想定区域（計画規模）の凡例色。**L2用の FLOOD_LEGEND とは混ぜないこと。**
 *
 * 新凡例（newlegend）は既存6色に細分の2色（0.3m未満・0.5〜1.0m）を加えた8色構成。
 * 実測（2026-07-27、01_flood_l1_shinsuishin_newlegend_data のタイル 16/58192/25808（南台）を
 * pngjs でデコードして色分布を集計）:
 *   [0,0,0,0] × 55830（区域外） / [247,245,169,255] × 484 / [248,225,166,255] × 9221
 *   [255,216,192,255] × 0 …（南台タイルは細分色が主）
 * 細分色 (248,225,166) と既存色 (247,245,169) のRGB距離は 20.2 で最近傍判定でも分離できる。
 */
export const FLOOD_LEGEND_L1 = [
  { rank: '0.3m未満',    rgb: [255, 255, 179], depthMin: 0,    depthMax: 0.3 },
  { rank: '0.5m未満',    rgb: [247, 245, 169], depthMin: 0,    depthMax: 0.5 },
  { rank: '0.5〜1.0m',   rgb: [248, 225, 166], depthMin: 0.5,  depthMax: 1 },
  { rank: '0.5〜3.0m',   rgb: [255, 216, 192], depthMin: 0.5,  depthMax: 3 },
  { rank: '3.0〜5.0m',   rgb: [255, 183, 183], depthMin: 3,    depthMax: 5 },
  { rank: '5.0〜10.0m',  rgb: [255, 145, 145], depthMin: 5,    depthMax: 10 },
  { rank: '10.0〜20.0m', rgb: [242, 133, 201], depthMin: 10,   depthMax: 20 },
  { rank: '20.0m以上',   rgb: [220, 122, 220], depthMin: 20,   depthMax: Infinity },
];

/**
 * 浸水継続時間（想定最大規模）の凡例色。
 *
 * 凡例画像 disaportal.gsi.go.jp/hazardmap/copyright/img/shinsui_legend_l2_keizoku.png を
 * pngjs で実測して確定（2026-07-27）。
 * 「2週間〜4週間」の色は自治体により「2週間以上」を意味する場合があるため、
 * カードのnoteでその旨を注記する（§2.1）。
 */
export const KEIZOKU_LEGEND = [
  { rank: '12時間未満',    rgb: [160, 210, 255] },
  { rank: '12時間〜1日',   rgb: [0, 65, 255] },
  { rank: '1日〜3日',      rgb: [250, 245, 0] },
  { rank: '3日〜1週間',    rgb: [255, 153, 0] },
  { rank: '1週間〜2週間',  rgb: [255, 40, 0] },
  { rank: '2週間〜4週間',  rgb: [180, 0, 104] },
  { rank: '4週間以上',     rgb: [96, 0, 96] },
];

/**
 * 洪水タイルのRGBAから浸水深ランクを判定する。
 * @param {number[]} rgba [r,g,b,a]
 * @param {Array} [legend] 凡例テーブル（既定は想定最大規模 L2 用）
 * @returns {{rank:string, distance:number, depthMin:number|null, depthMax:number|null}}
 */
export function classifyFloodColor(rgba, legend = FLOOD_LEGEND) {
  if (!rgba || rgba[3] < ALPHA_THRESHOLD) {
    return { rank: '区域外', distance: 0, depthMin: null, depthMax: null };
  }
  let best = null;
  let bestD = Infinity;
  for (const l of legend) {
    const d = colorDistance(rgba, l.rgb);
    if (d < bestD) { bestD = d; best = l; }
  }
  if (bestD > COLOR_MATCH_THRESHOLD) {
    return { rank: '判定不能', distance: bestD, depthMin: null, depthMax: null };
  }
  return { rank: best.rank, distance: bestD, depthMin: best.depthMin, depthMax: best.depthMax };
}

/** 計画規模（L1・新凡例）用の色分類。凡例テーブルだけがL2と異なる */
export function classifyFloodL1Color(rgba) {
  return classifyFloodColor(rgba, FLOOD_LEGEND_L1);
}

/**
 * 浸水継続時間タイルのRGBAからランクを判定する。
 * 透明（タイルなし・区域外）は「データなし」を返す。
 * 「浸水しない」ではない点に注意（洪水ランクとの組合せで表示を出し分ける。§2.1）。
 * @param {number[]} rgba [r,g,b,a]
 * @returns {{rank:string, distance:number}}
 */
export function classifyKeizokuColor(rgba) {
  if (!rgba || rgba[3] < ALPHA_THRESHOLD) return { rank: 'データなし', distance: 0 };
  let best = null, bestD = Infinity;
  for (const l of KEIZOKU_LEGEND) {
    const d = colorDistance(rgba, l.rgb);
    if (d < bestD) { bestD = d; best = l; }
  }
  if (bestD > COLOR_MATCH_THRESHOLD) return { rank: '判定不能', distance: bestD };
  return { rank: best.rank, distance: bestD };
}

/**
 * 土砂災害警戒区域タイルの凡例色。
 *
 * 実測（2026-07-27、test/output/probe.mjs で 05_kyukeishakeikaikuiki の
 * タイル 16/58195/25799（上高田）をデコードし色分布を集計）:
 *   [0,0,0,0] × 64355（区域外） / [250,230,0,255] × 893（イエロー）/ [250,40,0,255] × 17（レッド）
 * 中野区全域の粗スキャン（z=16、168タイル分）では
 *   土石流 0/168・地すべり 0/168 タイル（＝中野区に指定なし・全て404）、
 *   急傾斜地の崩壊 13/168 タイルのみ存在。
 */
export const LANDSLIDE_LEGEND = [
  { rank: '特別警戒区域（レッド）', rgb: [250, 40, 0] },
  { rank: '警戒区域（イエロー）',   rgb: [250, 230, 0] },
];

export function classifyLandslideColor(rgba) {
  if (!rgba || rgba[3] < ALPHA_THRESHOLD) return { rank: '区域外', distance: 0 };
  let best = null, bestD = Infinity;
  for (const l of LANDSLIDE_LEGEND) {
    const d = colorDistance(rgba, l.rgb);
    if (d < bestD) { bestD = d; best = l; }
  }
  // 非透明だが凡例色と大きく離れる場合は「区域内（区分不明）」とする
  if (bestD > 120) return { rank: '区域内（区分不明）', distance: bestD };
  return { rank: best.rank, distance: bestD };
}

// ---- ブラウザ側のタイル取得 --------------------------------------------------

const pixelCache = new Map();

/**
 * タイルPNGを読み込んで指定ピクセルのRGBAを返す（ブラウザ専用）。
 * タイルが存在しない（404）場合は null を返す＝区域外扱い。
 */
async function readTilePixel(urlTemplate, lon, lat, z) {
  const t = lonLatToPixel(lon, lat, z);
  const url = tileUrl(urlTemplate, t.z, t.x, t.y);
  const cacheKey = `${url}|${t.px},${t.py}`;
  if (pixelCache.has(cacheKey)) return pixelCache.get(cacheKey);

  const rgba = await new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth || 256;
        cv.height = img.naturalHeight || 256;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        // タイルサイズが256でない場合に備えてスケール
        const sx = Math.min(cv.width - 1, Math.floor((t.px / 256) * cv.width));
        const sy = Math.min(cv.height - 1, Math.floor((t.py / 256) * cv.height));
        const d = ctx.getImageData(sx, sy, 1, 1).data;
        resolve([d[0], d[1], d[2], d[3]]);
      } catch (e) {
        console.warn('hazard tile decode failed', url, e);
        resolve(null);
      }
    };
    img.onerror = () => resolve(null); // 404 等 = 区域外
    img.src = url;
  });

  pixelCache.set(cacheKey, rgba);
  return rgba;
}

/**
 * 洪水浸水想定（想定最大規模）を判定する。
 * @returns {Promise<{rank:string, rgba:number[]|null, source:string}>}
 */
export async function queryFlood(lon, lat) {
  const cfg = HAZARD_TILES.floodL2;
  const rgba = await readTilePixel(cfg.url, lon, lat, cfg.z);
  const cls = classifyFloodColor(rgba);
  return { rank: cls.rank, depthMin: cls.depthMin, depthMax: cls.depthMax, rgba, source: cfg.label };
}

/**
 * 浸水継続時間（想定最大規模）を判定する。
 * @returns {Promise<{rank:string, rgba:number[]|null, source:string}>}
 */
export async function queryFloodKeizoku(lon, lat) {
  const cfg = HAZARD_TILES.floodKeizoku;
  const rgba = await readTilePixel(cfg.url, lon, lat, cfg.z);
  const cls = classifyKeizokuColor(rgba);
  return { rank: cls.rank, rgba, source: cfg.label };
}

/**
 * 洪水浸水想定（計画規模・新凡例）を判定する。
 * @returns {Promise<{rank:string, depthMin:number|null, depthMax:number|null, rgba:number[]|null, source:string}>}
 */
export async function queryFloodL1(lon, lat) {
  const cfg = HAZARD_TILES.floodL1;
  const rgba = await readTilePixel(cfg.url, lon, lat, cfg.z);
  const cls = classifyFloodL1Color(rgba);
  return { rank: cls.rank, depthMin: cls.depthMin, depthMax: cls.depthMax, rgba, source: cfg.label };
}

/**
 * 土砂災害警戒区域（土石流・急傾斜地・地すべり）を判定する。
 * @returns {Promise<Array<{key:string, label:string, rank:string}>>}
 */
export async function queryLandslide(lon, lat) {
  const keys = ['debrisFlow', 'steepSlope', 'landslide'];
  return Promise.all(
    keys.map(async (key) => {
      const cfg = HAZARD_TILES[key];
      const rgba = await readTilePixel(cfg.url, lon, lat, cfg.z);
      const cls = classifyLandslideColor(rgba);
      return { key, label: cfg.label, rank: cls.rank, rgba };
    })
  );
}
