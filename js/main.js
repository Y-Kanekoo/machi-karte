// 中野区 3D都市モデルビューア
// データ: 国土交通省 Project PLATEAU 中野区 2025年度 (CC BY 4.0)
// 配信: PLATEAU Streaming (assets.cms.plateau.reearth.io)

import { TILESETS, PRESETS, HEIGHT_PROP_CANDIDATES } from './config.js';
import { escapeHtml } from './util.js';
import { initDiagnosis } from './diagnose.js';
import { initShare } from './share.js';
import { initZoningOverlay } from './zoning-overlay.js';
import { initCompare } from './compare.js';
import { createShelterLayer } from './shelter.js';
import { initShadeMap } from './shademap-ui.js';

// ---- Viewer ----------------------------------------------------------------

const gsiPhoto = new Cesium.UrlTemplateImageryProvider({
  url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
  maximumLevel: 18,
  credit: new Cesium.Credit('地理院タイル（シームレス空中写真）'),
});
const gsiPale = new Cesium.UrlTemplateImageryProvider({
  url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
  maximumLevel: 18,
  credit: new Cesium.Credit('地理院タイル（淡色地図）'),
});

const viewer = new Cesium.Viewer('cesiumContainer', {
  baseLayer: new Cesium.ImageryLayer(gsiPhoto),
  baseLayerPicker: false,
  geocoder: false,
  timeline: false,
  animation: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  selectionIndicator: false,
  infoBox: false,
  shadows: false,
  terrainShadows: Cesium.ShadowMode.DISABLED,
});
viewer.scene.globe.depthTestAgainstTerrain = false;
viewer.scene.skyAtmosphere.show = true;

// JST正午を初期時刻に（影シミュレーション用）
function setJstTime(hourDecimal) {
  const now = new Date();
  const h = Math.floor(hourDecimal);
  const m = Math.round((hourDecimal - h) * 60);
  // JST = UTC+9
  const utc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), h - 9, m, 0);
  viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date(utc));
}
setJstTime(12);

// ---- Tileset loading (lazy) ------------------------------------------------

const loaded = {}; // key -> Cesium3DTileset
const statusEl = document.getElementById('status');

function setStatus(msg) {
  statusEl.textContent = msg;
  statusEl.style.display = msg ? 'block' : 'none';
}

async function getTileset(key) {
  if (loaded[key]) return loaded[key];
  setStatus('データ読み込み中…');
  try {
    const tileset = await Cesium.Cesium3DTileset.fromUrl(TILESETS[key], {
      maximumScreenSpaceError: 16,
    });
    viewer.scene.primitives.add(tileset);
    loaded[key] = tileset;
    if (key.startsWith('fld')) {
      tileset.style = new Cesium.Cesium3DTileStyle({
        color: "color('#2266cc', 0.55)",
      });
    }
    setStatus('');
    return tileset;
  } catch (e) {
    console.error('tileset load failed:', key, e);
    setStatus('読み込みに失敗しました: ' + key);
    return null;
  }
}

function findHeightProperty(tileset) {
  const props = tileset.properties;
  if (!Cesium.defined(props)) return null;
  for (const cand of HEIGHT_PROP_CANDIDATES) {
    if (Cesium.defined(props[cand])) return cand;
  }
  return null;
}

function heightStyle(prop) {
  const v = `Number(\${feature['${prop}']})`;
  return new Cesium.Cesium3DTileStyle({
    color: {
      conditions: [
        [`${v} >= 100`, "color('#d73027')"],
        [`${v} >= 60`, "color('#fc8d59')"],
        [`${v} >= 31`, "color('#fee090')"],
        [`${v} >= 12`, "color('#91bfdb')"],
        [`${v} >= 0`, "color('#4575b4')"],
        ['true', "color('#cccccc')"],
      ],
    },
  });
}

// ---- Building layer switching ----------------------------------------------

const BLDG_KEYS = { lod1: 'bldgLod1', lod2: 'bldgLod2', lod2notex: 'bldgLod2NoTex' };
let currentBldg = null;
let currentBldgKind = null;
let shadeMapController = null;
let buildingLayerRequestGeneration = 0;

async function showBuildings(mode) {
  const requestGeneration = ++buildingLayerRequestGeneration;
  shadeMapController?.onBuildingLayerChange();
  for (const k of Object.values(BLDG_KEYS)) {
    if (loaded[k]) loaded[k].show = false;
  }
  currentBldg = null;
  currentBldgKind = null;
  if (mode === 'none') {
    diagnosis.onBuildingLayerChange();
    return;
  }
  const key = BLDG_KEYS[mode];
  const ts = await getTileset(key);
  if (!ts) {
    if (requestGeneration === buildingLayerRequestGeneration) {
      diagnosis.onBuildingLayerChange();
    }
    return;
  }
  if (requestGeneration !== buildingLayerRequestGeneration) {
    if (ts !== currentBldg) ts.show = false;
    return;
  }
  ts.show = true;
  currentBldg = ts;
  currentBldgKind = mode;
  applyHeightColor();
  diagnosis.onBuildingLayerChange();
}

function applyHeightColor() {
  const on = document.getElementById('heightColor').checked;
  document.getElementById('legend').classList.toggle('hidden', !on);
  if (!currentBldg) return;
  if (on) {
    const prop = findHeightProperty(currentBldg);
    currentBldg.style = prop
      ? heightStyle(prop)
      : new Cesium.Cesium3DTileStyle({ color: "color('#91bfdb')" });
  } else {
    currentBldg.style = undefined;
  }
}

// ---- UI wiring ---------------------------------------------------------------

document.querySelectorAll('input[name="bldg"]').forEach((el) => {
  el.addEventListener('change', () => showBuildings(el.value));
});
document.getElementById('heightColor').addEventListener('change', applyHeightColor);

document.getElementById('shadows').addEventListener('change', (e) => {
  viewer.shadows = e.target.checked;
  viewer.scene.globe.enableLighting = e.target.checked;
  document.getElementById('timeControl').classList.toggle('hidden', !e.target.checked);
});

document.getElementById('timeSlider').addEventListener('input', (e) => {
  const t = Number(e.target.value);
  const h = Math.floor(t);
  const m = String(Math.round((t - h) * 60)).padStart(2, '0');
  document.getElementById('timeLabel').textContent = `${h}:${m}`;
  setJstTime(t);
});

const CHECK_LAYERS = {
  fldKanda: 'fldKandaL2',
  fldArakawa: 'fldArakawaL2',
  tran: 'tranLod3',
  wtr: 'wtrLod1',
};
for (const [id, key] of Object.entries(CHECK_LAYERS)) {
  document.getElementById(id).addEventListener('change', async (e) => {
    if (e.target.checked) {
      const ts = await getTileset(key);
      if (ts) ts.show = true;
    } else if (loaded[key]) {
      loaded[key].show = false;
    }
  });
}

// 背景地図の切り替え。
// removeAll() だと都市計画オーバーレイまで消えてしまうので、
// 最下段（index 0）の背景レイヤーだけを差し替える。
let baseImageryLayer = viewer.imageryLayers.get(0);
document.querySelectorAll('input[name="imagery"]').forEach((el) => {
  el.addEventListener('change', () => {
    const next = new Cesium.ImageryLayer(el.value === 'pale' ? gsiPale : gsiPhoto);
    viewer.imageryLayers.add(next, 0);
    // ImageryLayer.destroy() は provider を壊さないので、毎回新しい層を作って古い層は破棄してよい
    if (baseImageryLayer) viewer.imageryLayers.remove(baseImageryLayer, true);
    baseImageryLayer = next;
    shadeMapController?.ensureTop();
  });
});

function flyTo(p, duration = 2.0) {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height),
    orientation: {
      heading: Cesium.Math.toRadians(p.heading),
      pitch: Cesium.Math.toRadians(p.pitch),
      roll: 0,
    },
    duration,
  });
}
document.querySelectorAll('.presets button').forEach((btn) => {
  btn.addEventListener('click', () => flyTo(PRESETS[btn.dataset.preset]));
});

// ---- Feature picking ---------------------------------------------------------

let highlighted = null;

function clearHighlight() {
  if (highlighted && !highlighted.isDestroyed?.()) {
    try { highlighted.color = Cesium.Color.WHITE; } catch (_) { /* tile unloaded */ }
  }
  highlighted = null;
}

/** ピックした建物フィーチャの属性行HTMLを組み立てる */
function buildingTableHtml(picked) {
  const PRIORITY = ['名称', 'gml:name', '計測高さ', 'bldg:measuredHeight', '用途', 'bldg:usage', '地上階数', '地下階数', '建築年'];
  const ids = picked.getPropertyIds().filter((n) => !n.startsWith('_'));
  ids.sort((a, b) => {
    const ia = PRIORITY.indexOf(a), ib = PRIORITY.indexOf(b);
    return (ia === -1 ? PRIORITY.length : ia) - (ib === -1 ? PRIORITY.length : ib);
  });
  const rows = [];
  for (const name of ids) {
    const val = picked.getProperty(name);
    if (val === undefined || val === null || val === '') continue;
    rows.push(`<tr><th>${escapeHtml(name)}</th><td>${escapeHtml(String(val))}</td></tr>`);
  }
  return rows.join('') || '<tr><td>属性なし</td></tr>';
}

// ---- トースト（共有・比較の操作フィードバック） -----------------------------------

let toastTimer = null;
const toastEl = document.getElementById('toast');

function toast(msg, ms = 2000) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), ms);
}

// ---- 街カルテ（地点診断） -------------------------------------------------------

const diagnosis = initDiagnosis({
  viewer,
  getCurrentBuildingTileset: () => currentBldg,
  buildingTableHtml,
  setStatus,
  toast,
  onDiagnosisStart: () => shadeMapController?.abortForDiagnosis(),
});
diagnosis.onClose(clearHighlight);

// ---- R3: 日影マップ -----------------------------------------------------------

shadeMapController = initShadeMap({
  viewer,
  getBuildingState: () => ({
    tileset: currentBldg,
    layerKind: currentBldgKind,
  }),
  cancelDiagnosisSunlight: () => diagnosis.cancelSunlight(
    '日影マップを開始したため、日照計算を中断しました。'
  ),
});

// ---- R2: 避難所レイヤー ----------------------------------------------------------
// Entityは専用の CustomDataSource に入るので、診断ピン（viewer.entities）とは独立。
// 表示状態の単一ソースは左パネルのチェックボックスで、カード内のボタンはその表示。

const shelterLayer = createShelterLayer(viewer);
const shelterCheckbox = document.getElementById('shelterLayer');
const shelterLegend = document.getElementById('shelterLegend');

shelterCheckbox.addEventListener('change', async () => {
  const on = shelterCheckbox.checked;
  shelterLegend.classList.toggle('hidden', !on);
  diagnosis.updateShelterButton();
  if (on) setStatus('避難所データを読み込み中…');
  const n = await shelterLayer.setVisible(on);
  if (on) setStatus(n ? '' : '避難所データを読み込めませんでした');
});

// ---- R1: 都市計画オーバーレイ / 地点比較 / 共有URL -----------------------------------

const overlays = initZoningOverlay({ viewer });

// compare は「比較のリンクをコピー」でのみ share を使うので、実体は後から差し込む
// （share は起動時復元で compare.restoreFromPoints を呼ぶため、相互に必要になる）
const shareRef = {};
const compare = initCompare({
  diagnosis,
  viewer,
  toast,
  share: { shareCompare: (pts) => shareRef.api.shareCompare(pts) },
});
const share = initShare({ viewer, diagnosis, overlays, compare, toast });
shareRef.api = share;

/** クリック位置の経緯度を求める（建物表面 → 地表の順にフォールバック） */
function pickLonLat(windowPosition) {
  let pos = null;
  if (viewer.scene.pickPositionSupported) {
    const p = viewer.scene.pickPosition(windowPosition);
    if (Cesium.defined(p)) pos = p;
  }
  if (!pos) {
    const p = viewer.camera.pickEllipsoid(windowPosition, viewer.scene.globe.ellipsoid);
    if (Cesium.defined(p)) pos = p;
  }
  if (!pos) return null;
  const carto = Cesium.Cartographic.fromCartesian(pos);
  return {
    lon: Cesium.Math.toDegrees(carto.longitude),
    lat: Cesium.Math.toDegrees(carto.latitude),
  };
}

viewer.screenSpaceEventHandler.setInputAction((click) => {
  const picked = viewer.scene.pick(click.position);
  clearHighlight();

  const isBuilding = picked instanceof Cesium.Cesium3DTileFeature;
  if (isBuilding) {
    picked.color = Cesium.Color.YELLOW.withAlpha(0.8);
    highlighted = picked;
  }

  // 診断モードON、または建物クリック時に診断カードを開く
  if (diagnosis.isActive() || isBuilding) {
    const ll = pickLonLat(click.position);
    if (ll) {
      diagnosis.diagnose({
        lon: ll.lon,
        lat: ll.lat,
        title: null,
        picked: isBuilding ? picked : null,
        // 建物クリックは今の視点を保ちたいのでカメラを動かさない
        fly: !isBuilding,
      });
      return;
    }
  }
  if (!isBuilding && !diagnosis.isActive()) {
    diagnosis.close();
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// ---- Init --------------------------------------------------------------------

/** 共有URLの復元が終わった（または復元対象が無かった）ことを示す Promise（e2eから待てる） */
let restored = null;

(async () => {
  flyTo(PRESETS.overview, 0);
  await showBuildings('lod2');
  // 共有URLがあればそちらを優先する（既定の中野駅プリセットへは飛ばさない）
  const hasHash = !!location.hash && location.hash.length > 1;
  if (!hasHash) flyTo(PRESETS.nakanoSta, 3.0);
  restored = share.restoreFromHash().catch((e) => {
    console.warn('share: restore failed', e);
    return null;
  });
  const state = await restored;
  if (!state && hasHash) flyTo(PRESETS.nakanoSta, 3.0);
})();

// テスト用フック（e2eから内部状態を参照するため）
window.__nakano = {
  viewer, getTileset, loaded, flyTo, showBuildings,
  diagnosis, overlays, compare, share, toast, shelterLayer,
  shadeMap: {
    run: (opts) => shadeMapController.run(opts),
    clear: () => shadeMapController.clear(),
    abort: () => shadeMapController.abort(),
    getState: () => shadeMapController.getState(),
    getCanvasState: () => shadeMapController.getCanvasState(),
  },
  getRestored: () => restored,
};
