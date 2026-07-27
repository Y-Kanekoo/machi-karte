// 都市計画決定情報（用途地域・防火地域・高度地区）の地点判定。
//
// PLATEAU配信のMVT（ベクトルタイル）をz=16で取得し、CDNのpbf/vector-tileでデコードして
// 点内包判定（ray-casting）で該当ポリゴンの属性を取り出す。
//
// 実測（2026-07-27、test/data-expectations.mjs）:
//   レイヤー名は UseDistrict / FirePreventionDistrict / HeightControlDistrict、extent=65536。
//   タイルには隣接区（新宿・杉並）のフィーチャも含まれるため city_code でのフィルタはしない
//   （区境の判定が正しく出なくなるため）。
//   属性例:
//     中野区中野五丁目 (139.66893, 35.707859)
//       UseDistrict: urf_function=第1種中高層住居専用地域, 建蔽60%, 容積200%
//       FirePreventionDistrict: urf_function=準防火地域, urf_usage=防火地域（路線）
//       HeightControlDistrict: urf_function=高度地区
//     中野駅前 (139.6659, 35.7056)
//       UseDistrict: urf_function=商業地域, 建蔽80%, 容積600%
//     鷺宮 (139.635, 35.725)
//       UseDistrict: urf_function=第1種低層住居専用地域, 建蔽50%, 容積150%

import { ZONING_TILES, MVT_CDN } from './config.js';
import { lonLatToTileLocal, tileUrl, pointInRings } from './tilemath.js';

let mvtLibPromise = null;

/**
 * MVTデコード用ライブラリをCDNから動的importする。
 * pbf は v4 以降で export 形状が変わる（PbfReader）ため v3.3.0 に固定している。
 * jsDelivr が読めない場合は unpkg にフォールバック。
 *
 * zoning-overlay.js（タイルのラスタライズ）と共用するので export している。
 */
export async function loadMvtLib() {
  if (mvtLibPromise) return mvtLibPromise;
  mvtLibPromise = (async () => {
    let lastErr = null;
    for (const cdn of MVT_CDN) {
      try {
        const [pbfMod, vtMod] = await Promise.all([import(cdn.pbf), import(cdn.vectorTile)]);
        const Pbf = pbfMod.default || pbfMod.Pbf;
        const VectorTile = vtMod.VectorTile || vtMod.default?.VectorTile;
        if (typeof Pbf === 'function' && typeof VectorTile === 'function') {
          return { Pbf, VectorTile };
        }
        lastErr = new Error('unexpected module shape from ' + cdn.pbf);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('MVTライブラリを読み込めませんでした');
  })();
  return mvtLibPromise;
}

/**
 * MVTタイルの ArrayBuffer キャッシュ（URL → Promise<Uint8Array|null>）。
 * 点判定（このファイル）とオーバーレイ描画（zoning-overlay.js）で同じタイルを
 * 二重に取りに行かないよう、モジュールスコープで共用する。
 */
const tileCache = new Map();

/**
 * MVTタイルを取得する（同一URLは1回だけ実際にfetchする）。
 * @param {string} url
 * @returns {Promise<Uint8Array|null>} 404（配信範囲外）は null
 */
export async function fetchTileBuffer(url) {
  if (tileCache.has(url)) return tileCache.get(url);
  const p = (async () => {
    const res = await fetch(url);
    if (!res.ok) return null; // 404 = 配信範囲外
    return new Uint8Array(await res.arrayBuffer());
  })();
  tileCache.set(url, p);
  return p;
}

/** テスト・デバッグ用（キャッシュの効きを確認する） */
export function tileCacheSize() {
  return tileCache.size;
}

/**
 * 1レイヤー分のMVTを引いて、点を含む最初のフィーチャの属性を返す。
 * @returns {Promise<{layer:string, props:object}|null>}
 */
async function queryLayer(cfg, lon, lat) {
  const { Pbf, VectorTile } = await loadMvtLib();
  const t = lonLatToTileLocal(lon, lat, cfg.z, 1);
  const buf = await fetchTileBuffer(tileUrl(cfg.url, cfg.z, t.x, t.y));
  if (!buf) return null;
  const tile = new VectorTile(new Pbf(buf));
  for (const name of Object.keys(tile.layers)) {
    const layer = tile.layers[name];
    const loc = lonLatToTileLocal(lon, lat, cfg.z, layer.extent);
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (pointInRings(loc.lx, loc.ly, f.loadGeometry())) {
        return { layer: name, props: f.properties };
      }
    }
  }
  return null;
}

/**
 * 用途地域・防火地域・高度地区をまとめて判定する。
 * 個々のレイヤーの失敗は他をブロックしない。
 * @returns {Promise<{
 *   use: {name:string, coverage:number|null, floorArea:number|null, minSiteArea:number|null, heightLimit:string|null, location:string|null}|null,
 *   fire: {name:string, usage:string|null}|null,
 *   height: {name:string, location:string|null}|null,
 *   error: string|null
 * }>}
 */
export async function queryZoning(lon, lat) {
  const out = { use: null, fire: null, height: null, error: null };
  try {
    await loadMvtLib();
  } catch (e) {
    out.error = '都市計画情報を取得できませんでした（MVTライブラリの読み込みに失敗）';
    console.warn('zoning: mvt lib load failed', e);
    return out;
  }

  const [use, fire, height] = await Promise.all([
    queryLayer(ZONING_TILES.use, lon, lat).catch((e) => { console.warn('zoning use', e); return null; }),
    queryLayer(ZONING_TILES.fire, lon, lat).catch((e) => { console.warn('zoning fire', e); return null; }),
    queryLayer(ZONING_TILES.height, lon, lat).catch((e) => { console.warn('zoning height', e); return null; }),
  ]);

  if (use) {
    const p = use.props;
    out.use = {
      name: p.urf_function || null,
      coverage: num(p.urf_buildingCoverageRate),
      floorArea: num(p.urf_floorAreaRate),
      minSiteArea: num(p.urf_minimumSiteArea),
      heightLimit: p.urf_buildingHeightLimits != null ? String(p.urf_buildingHeightLimits) : null,
      location: p.urf_location || null,
    };
  }
  if (fire) {
    out.fire = { name: fire.props.urf_function || null, usage: fire.props.urf_usage || null };
  }
  if (height) {
    out.height = { name: height.props.urf_function || null, location: height.props.urf_location || null };
  }
  return out;
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
