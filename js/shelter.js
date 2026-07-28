// 避難所・避難場所（中野区オープンデータ・同梱GeoJSON）
//
// - 読み込み: data/shelters.geojson（tools/fetch-shelters.mjs で生成、CC BY 4.0）
// - 診断カード: 最寄りの震災時避難所／水害時避難所を直線距離で1件ずつ
// - 3D地図: 種別で色分けした点Entityを専用の CustomDataSource に入れて一括表示切替
//
// 距離計算・最寄り探索は純関数なので Node からそのまま単体テストできる
// （Cesium に触るのは createShelterLayer 以下だけ）。

import { SHELTERS_URL, SHELTER_TYPES, SHELTER_LABEL_MAX_DISTANCE } from './config.js';
import { distanceMeters } from './tilemath.js';

// ---- 純粋ロジック ------------------------------------------------------------

/**
 * GeoJSON の FeatureCollection を、扱いやすい配列に正規化する。
 * 座標や名称が欠けた Feature は黙って落とす（同梱データなので通常は起きない）。
 *
 * @param {object} geojson
 * @returns {Array<{name:string, address:string, type:string, typeLabel:string, lon:number, lat:number}>}
 */
export function parseShelters(geojson) {
  const out = [];
  for (const f of geojson?.features || []) {
    const c = f?.geometry?.coordinates;
    const p = f?.properties || {};
    if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    if (!p.name) continue;
    out.push({
      name: p.name,
      address: p.address || '',
      type: p.type || '',
      typeLabel: p.typeLabel || SHELTER_TYPES[p.type]?.label || '',
      lon: c[0],
      lat: c[1],
    });
  }
  return out;
}

/**
 * 指定種別の中で最寄りの避難所を返す（102件の線形走査。空間インデックスは不要）。
 *
 * @param {Array} shelters parseShelters の結果
 * @param {number} lon @param {number} lat
 * @param {string} type 'quake' | 'flood' | 'wide'
 * @returns {{name:string, address:string, type:string, lon:number, lat:number, distance:number}|null}
 */
export function nearestShelter(shelters, lon, lat, type) {
  if (!Array.isArray(shelters) || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  let best = null;
  let bestD = Infinity;
  for (const s of shelters) {
    if (type && s.type !== type) continue;
    const d = distanceMeters(lon, lat, s.lon, s.lat);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best ? { ...best, distance: bestD } : null;
}

/**
 * 距離の表示文字列。「約440m」／1km以上は「約1.2km」。
 * 直線距離の目安なので、10m単位までしか出さない。
 */
export function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '―';
  if (meters >= 1000) return `約${(meters / 1000).toFixed(1)}km`;
  return `約${Math.round(meters / 10) * 10}m`;
}

// ---- 読み込み（ブラウザ／Node共用。fetch のみ使う） ------------------------------

let sheltersPromise = null;

/**
 * 同梱GeoJSONを読み込む（1回だけ。以降はキャッシュを返す）。
 * 失敗しても診断の他項目は動かしたいので、例外は投げずに空配列を返す。
 * @returns {Promise<{shelters:Array, metadata:object|null, error:string|null}>}
 */
export function loadShelters(url = SHELTERS_URL) {
  if (!sheltersPromise) {
    sheltersPromise = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then((g) => ({ shelters: parseShelters(g), metadata: g.metadata || null, error: null }))
      .catch((e) => {
        console.warn('shelters load failed', e);
        return { shelters: [], metadata: null, error: '避難所データを読み込めませんでした' };
      });
  }
  return sheltersPromise;
}

/**
 * 診断カード用: 最寄りの震災時避難所・水害時避難所をまとめて返す。
 * @returns {Promise<{quake:object|null, flood:object|null, error:string|null, count:number}>}
 */
export async function queryNearestShelters(lon, lat) {
  const { shelters, error } = await loadShelters();
  return {
    quake: nearestShelter(shelters, lon, lat, 'quake'),
    flood: nearestShelter(shelters, lon, lat, 'flood'),
    error,
    count: shelters.length,
  };
}

// ---- 3D地図レイヤー（Cesium） --------------------------------------------------

/**
 * 避難所レイヤーを作る。Entityは専用の CustomDataSource に入れるので、
 * 表示切替は dataSource.show 一発で済み、診断ピン（viewer.entities）とも干渉しない。
 *
 * @param {object} viewer Cesium.Viewer
 * @returns {{setVisible:(on:boolean)=>Promise<number>, isVisible:()=>boolean, count:()=>number}}
 */
export function createShelterLayer(viewer) {
  const ds = new Cesium.CustomDataSource('shelters');
  ds.show = false;
  viewer.dataSources.add(ds);
  let built = null;

  async function build() {
    if (built) return built;
    built = loadShelters().then(({ shelters }) => {
      for (const s of shelters) {
        const color = Cesium.Color.fromCssColorString(
          SHELTER_TYPES[s.type]?.color || '#cccccc'
        );
        ds.entities.add({
          name: s.name,
          position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 0),
          properties: { shelterType: s.type },
          point: {
            pixelSize: 10,
            color,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.NONE,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: s.name,
            font: '11px "Hiragino Kaku Gothic ProN", sans-serif',
            fillColor: Cesium.Color.WHITE,
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString('rgba(20,26,34,0.8)'),
            pixelOffset: new Cesium.Cartesian2(0, -18),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            // 近景のみラベル表示（102件のラベル重なりと描画負荷を抑える）
            distanceDisplayCondition:
              new Cesium.DistanceDisplayCondition(0, SHELTER_LABEL_MAX_DISTANCE),
          },
        });
      }
      return ds.entities.values.length;
    });
    return built;
  }

  return {
    async setVisible(on) {
      if (on) await build();
      ds.show = !!on;
      return ds.entities.values.length;
    },
    isVisible: () => ds.show,
    count: () => ds.entities.values.length,
    dataSource: ds,
  };
}
