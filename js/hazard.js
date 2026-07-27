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
 * 洪水タイルのRGBAから浸水深ランクを判定する。
 * @param {number[]} rgba [r,g,b,a]
 * @returns {{rank:string, distance:number, depthMin:number|null, depthMax:number|null}}
 */
export function classifyFloodColor(rgba) {
  if (!rgba || rgba[3] < ALPHA_THRESHOLD) {
    return { rank: '区域外', distance: 0, depthMin: null, depthMax: null };
  }
  let best = null;
  let bestD = Infinity;
  for (const l of FLOOD_LEGEND) {
    const d = colorDistance(rgba, l.rgb);
    if (d < bestD) { bestD = d; best = l; }
  }
  if (bestD > COLOR_MATCH_THRESHOLD) {
    return { rank: '判定不能', distance: bestD, depthMin: null, depthMax: null };
  }
  return { rank: best.rank, distance: bestD, depthMin: best.depthMin, depthMax: best.depthMax };
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
