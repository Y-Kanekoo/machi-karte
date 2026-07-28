// 浸水深の3D表現
//
// 診断地点の周囲に半透明の水面（円柱）を立てて、「3mの浸水＝建物2階の床下」を
// 直感的に見せる。想定最大規模（queryFlood）の depthMax の**上限**を柱状に示した
// 目安であって、実際の水位分布ではない点をカード側の注記で必ず断る。
//
// 高さは絶対高（height=地面高さ, extrudedHeight=地面高さ+浸水深）。
// 地形なし構成なので、estimateBaseHeight の結果をそのまま使えば建物と整合する。

import { FLOOD_VIZ_RADIUS, FLOOD_VIZ_MAX_DEPTH } from './config.js';

// ---- 純粋ロジック（Node単体テスト対象） -----------------------------------------

/**
 * 洪水判定の depthMax から、水面に使う深さを決める。
 * 「20.0m以上」は Infinity なので上限でキャップし、キャップした事実を返す。
 *
 * @param {number|null|undefined} depthMax queryFlood の depthMax
 * @returns {{depth:number, capped:boolean, usable:boolean}}
 */
export function floodVizDepth(depthMax) {
  const d = Number(depthMax);
  if (!Number.isFinite(d) && d !== Infinity) return { depth: 0, capped: false, usable: false };
  if (d === Infinity) return { depth: FLOOD_VIZ_MAX_DEPTH, capped: true, usable: true };
  if (!(d > 0)) return { depth: 0, capped: false, usable: false };
  if (d > FLOOD_VIZ_MAX_DEPTH) return { depth: FLOOD_VIZ_MAX_DEPTH, capped: true, usable: true };
  return { depth: d, capped: false, usable: true };
}

/**
 * 地面高さとして「ありえる」下限（m）。
 *
 * PLATEAUの建物は実標高（中野区は概ね30〜60m）に置かれる一方、
 * 地形なし構成では建物タイルが未読込の地点で `sampleHeightMostDetailed` が
 * 楕円体（＝0m付近）を返すことがある。その値をそのまま使うと水面が地下に沈むので、
 * これを下回ったら既定の地面高さにフォールバックする。
 */
export const MIN_PLAUSIBLE_BASE_HEIGHT = 1;

/**
 * 実測した地面高さを採用するか、既定値にフォールバックするかを決める。
 * @param {number|null|undefined} sampled 実測値（m）
 * @param {number} fallback 既定の地面高さ（m）
 */
export function resolveBaseHeight(sampled, fallback) {
  return Number.isFinite(sampled) && sampled > MIN_PLAUSIBLE_BASE_HEIGHT ? sampled : fallback;
}

/**
 * 3D表示できる判定結果か（区域外・判定不能・深さ不明はボタンを無効にする）。
 * @param {{rank:string, depthMax:number|null}|null} flood
 */
export function canShowFloodDepth(flood) {
  if (!flood) return false;
  if (flood.rank === '区域外' || flood.rank === '判定不能') return false;
  return floodVizDepth(flood.depthMax).usable;
}

// ---- Cesium（ブラウザ専用） -----------------------------------------------------

let entity = null;
let owner = null;

/**
 * 診断地点の周囲に半透明の水面を立てる。既に出ていれば作り直す。
 *
 * @param {object} viewer Cesium.Viewer
 * @param {{lon:number, lat:number, depthMax:number, baseHeight:number}} opts
 * @returns {{depth:number, capped:boolean, entity:object}|null} 表示できなければ null
 */
export function showFloodDepth(viewer, { lon, lat, depthMax, baseHeight }) {
  clearFloodDepth();
  const { depth, capped, usable } = floodVizDepth(depthMax);
  if (!usable) return null;
  const base = Number.isFinite(baseHeight) ? baseHeight : 0;
  owner = viewer;
  entity = viewer.entities.add({
    name: '想定浸水深（目安）',
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
    ellipse: {
      semiMinorAxis: FLOOD_VIZ_RADIUS,
      semiMajorAxis: FLOOD_VIZ_RADIUS,
      height: base,
      extrudedHeight: base + depth,
      material: Cesium.Color.fromCssColorString('#2a7fd4').withAlpha(0.4),
      outline: true,
      outlineColor: Cesium.Color.fromCssColorString('#9fd6ff').withAlpha(0.85),
    },
  });
  return { depth, capped, entity };
}

/** 水面を消す（カードを閉じたとき・別地点を診断したときに呼ぶ） */
export function clearFloodDepth() {
  if (entity && owner) {
    try { owner.entities.remove(entity); } catch (e) { console.warn('floodviz remove failed', e); }
  }
  entity = null;
  owner = null;
}

/** 水面が表示中か */
export function isFloodDepthVisible() {
  return !!entity;
}
