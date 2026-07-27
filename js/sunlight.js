// 簡易日照シミュレーション
//
// 地点（地表+1.2m）から太陽方向へレイを飛ばし、scene.pickFromRay で読み込み済みの
// 建物3D Tilesとの交差を調べる。交差なし＝日照。
//
// 精度の注記（UIにも表示する）:
//   - 画面に読み込み済みの建物タイルのみを考慮する簡易計算
//   - 地形は平面（楕円体）扱い。周辺の地形による遮蔽は考慮しない
//   - 太陽高度5度未満は日照時間に数えない

import { sampleDay, solarKeyDates } from './solar.js';

const RAD = Math.PI / 180;

/** 太陽高度がこれ未満なら日照とみなさない（度） */
export const MIN_SUN_ELEVATION = 5;
/** 視点高さ（地表からの高さ、m） */
export const EYE_HEIGHT = 1.2;
/** 地面高さが取得できなかったときの既定値（中野駅周辺の実測 _zmin ≒ 33m に基づく） */
export const DEFAULT_BASE_HEIGHT = 35;

const SAMPLE_STEP_MIN = 20;
const HOUR_START = 7;
const HOUR_END = 17;

/**
 * ENU（東・北・上）方向ベクトルをECEFに変換したレイ方向を返す。
 * @param {object} enuMatrix Transforms.eastNorthUpToFixedFrame の結果
 * @param {number} azimuthDeg 北=0, 東=90
 * @param {number} elevationDeg
 */
function sunDirectionEcef(enuMatrix, azimuthDeg, elevationDeg) {
  const el = elevationDeg * RAD;
  const az = azimuthDeg * RAD;
  const dirEnu = new Cesium.Cartesian3(
    Math.cos(el) * Math.sin(az), // 東
    Math.cos(el) * Math.cos(az), // 北
    Math.sin(el)                 // 上
  );
  const ecef = Cesium.Matrix4.multiplyByPointAsVector(enuMatrix, dirEnu, new Cesium.Cartesian3());
  return Cesium.Cartesian3.normalize(ecef, ecef);
}

/**
 * 地点の地面高さを推定する。
 * 建物クリック時はその建物の `_zmin`、それ以外は sampleHeightMostDetailed、
 * どちらも取れなければ既定値。
 */
export async function estimateBaseHeight(viewer, lon, lat, pickedFeature) {
  if (pickedFeature) {
    try {
      const zmin = pickedFeature.getProperty('_zmin');
      const n = Number(zmin);
      if (Number.isFinite(n)) return { height: n, source: '建物の_zmin' };
    } catch (_) { /* 属性なし */ }
  }
  try {
    const carto = Cesium.Cartographic.fromDegrees(lon, lat);
    const results = await viewer.scene.sampleHeightMostDetailed([carto]);
    const h = results?.[0]?.height;
    if (Number.isFinite(h)) return { height: h, source: 'sampleHeightMostDetailed' };
  } catch (e) {
    console.warn('sampleHeightMostDetailed failed', e);
  }
  return { height: DEFAULT_BASE_HEIGHT, source: '既定値' };
}

/**
 * 対象地点の周辺タイルが読み込まれるのを待つ。
 * pickFromRay は「読み込み済み」のタイルにしか当たらないため、
 * 計算前に地点上空へカメラを向けてタイルを引き込む。
 */
export function prepareTiles(viewer, tileset, lon, lat, timeoutMs = 10000) {
  return new Promise((resolve) => {
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 400),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-60),
        roll: 0,
      },
    });
    if (!tileset) return resolve(false);
    if (tileset.tilesLoaded) {
      // すでに読み込み済みでも、視点移動後の追加読み込みを少し待つ
      setTimeout(() => resolve(true), 1500);
      return;
    }
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { tileset.allTilesLoaded.removeEventListener(onLoaded); } catch (_) { /* noop */ }
      clearTimeout(timer);
      resolve(ok);
    };
    const onLoaded = () => setTimeout(() => finish(true), 500);
    const timer = setTimeout(() => finish(false), timeoutMs);
    tileset.allTilesLoaded.addEventListener(onLoaded);
  });
}

/**
 * 日照時間を推定する。
 *
 * @param {object} viewer Cesium.Viewer
 * @param {object} tileset 建物の Cesium3DTileset（遮蔽物）
 * @param {number} lon @param {number} lat
 * @param {number} baseHeight 地面高さ(m)
 * @param {object} [opts] { excludeEntities: [], year, onProgress(fraction) }
 * @returns {Promise<{days: Array<{key,label,hours,slots:Array<{hourJst,lit,elevationDeg}>}>, error: string|null, raysCast:number}>}
 */
export async function estimateSunlight(viewer, tileset, lon, lat, baseHeight, opts = {}) {
  const {
    excludeEntities = [],
    year = new Date().getFullYear(),
    onProgress = null,
  } = opts;

  const scene = viewer.scene;
  const origin = Cesium.Cartesian3.fromDegrees(lon, lat, baseHeight + EYE_HEIGHT);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  const ray = new Cesium.Ray(origin, new Cesium.Cartesian3());

  const dates = solarKeyDates(year);
  const days = [];
  let raysCast = 0;
  let pickErrors = 0;

  const total = dates.length * (((HOUR_END - HOUR_START) * 60) / SAMPLE_STEP_MIN + 1);
  let done = 0;

  for (const d of dates) {
    const samples = sampleDay(d.year, d.month, d.day, lon, lat, {
      hourStart: HOUR_START,
      hourEnd: HOUR_END,
      stepMinutes: SAMPLE_STEP_MIN,
    });
    const slots = [];
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      let lit = false;
      if (s.elevationDeg >= MIN_SUN_ELEVATION) {
        try {
          ray.direction = sunDirectionEcef(enu, s.azimuthDeg, s.elevationDeg);
          const hit = scene.pickFromRay(ray, excludeEntities);
          raysCast++;
          // pickFromRay は交差時に {object, position} を返す。position があれば遮蔽されている。
          lit = !(Cesium.defined(hit) && Cesium.defined(hit.position));
        } catch (e) {
          pickErrors++;
          lit = false;
        }
      }
      slots.push({ hourJst: s.hourJst, lit, elevationDeg: s.elevationDeg });

      done++;
      // 数本ごとにフレームを譲ってUIをブロックしない
      if (i % 6 === 5) {
        if (onProgress) onProgress(done / total);
        await nextFrame();
      }
    }
    const litCount = slots.filter((x) => x.lit).length;
    days.push({
      key: d.key,
      label: d.label,
      dateLabel: `${d.month}/${d.day}`,
      hours: (litCount * SAMPLE_STEP_MIN) / 60,
      slots,
    });
  }

  if (onProgress) onProgress(1);

  let error = null;
  if (raysCast === 0) {
    error = '太陽高度が5度以上になる時間帯がありませんでした';
  } else if (pickErrors > raysCast * 0.5) {
    error = 'レイキャストに失敗しました（描画環境の制限の可能性があります）';
  }

  return { days, error, raysCast, pickErrors, hourStart: HOUR_START, hourEnd: HOUR_END };
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
