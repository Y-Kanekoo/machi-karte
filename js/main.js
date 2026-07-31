// 中野区 3D都市モデルビューア
// データ: 国土交通省 Project PLATEAU 中野区 2025年度 (CC BY 4.0)
// 配信: PLATEAU Streaming (assets.cms.plateau.reearth.io)

import { HEIGHT_PROP_CANDIDATES } from './config.js';
import {
  parseCityCode,
  loadAreaIndex,
  loadSpots,
  resolveArea,
  enrichAreaConfig,
  buildNakanoFallback,
} from './area.js';
import { escapeHtml } from './util.js';
import { initDiagnosis } from './diagnose.js';
import { initShare } from './share.js';
import { initZoningOverlay } from './zoning-overlay.js';
import { initCompare } from './compare.js';
import { createShelterLayer } from './shelter.js';
import { initShadeMap } from './shademap-ui.js';

// ---- AreaConfig -------------------------------------------------------------

const requestedCityCode = parseCityCode(location);
const [areaIndex, spots] = await Promise.all([loadAreaIndex(), loadSpots()]);
const resolvedArea = requestedCityCode
  ? resolveArea(areaIndex, requestedCityCode, spots)
  : null;
const unsupportedArea = requestedCityCode === null
  || (areaIndex !== null && resolvedArea === null);
const baseAreaConfig = resolvedArea || buildNakanoFallback(spots);
const areaConfig = await enrichAreaConfig(baseAreaConfig);

const LEGACY_PRESET_LABELS = {
  nakanoSta: '中野駅',
  sunplaza: 'サンプラザ跡・四季の森',
  broadway: '中野ブロードウェイ',
  araiyakushi: '新井薬師',
  tetsugakudo: '哲学堂公園',
  overview: '全体俯瞰',
};

function floodControl(entry, index) {
  if (entry.label === '神田川流域') {
    return {
      ...entry,
      id: 'fldKanda',
      key: 'fldKandaL2',
      text: '洪水浸水想定（神田川流域・L2）',
    };
  }
  if (entry.label === '荒川水系神田川流域') {
    return {
      ...entry,
      id: 'fldArakawa',
      key: 'fldArakawaL2',
      text: '洪水浸水想定（荒川水系 神田川等・L2）',
    };
  }
  return {
    ...entry,
    id: `fld-${index}`,
    key: `fld${index}`,
    text: `洪水浸水想定（${entry.label}・L2）`,
  };
}

const areaFloods = areaConfig.code === '13114'
  ? [
    areaConfig.tilesets.fld.find(({ label }) => label === '神田川流域'),
    areaConfig.tilesets.fld.find(({ label }) => label === '荒川水系神田川流域'),
  ].filter(Boolean)
  : areaConfig.tilesets.fld;
const floodControls = areaFloods.filter((entry) => entry?.url).map(floodControl);
const tilesetUrls = {
  bldgLod1: areaConfig.tilesets.bldgLod1,
  bldgLod2: areaConfig.tilesets.bldgLod2,
  bldgLod2NoTex: areaConfig.tilesets.bldgLod2NoTex,
  ...Object.fromEntries(floodControls.map(({ key, url }) => [key, url])),
  tranLod3: areaConfig.tilesets.tranLod3,
  wtrLod1: areaConfig.tilesets.wtrLod1,
};
const initialBuildingMode = areaConfig.tilesets.bldgLod2 ? 'lod2' : 'lod1';

function unavailableText() {
  return '<span class="unavailable-text">このエリアでは提供されていません</span>';
}

function renderAreaChrome() {
  if (areaConfig.code !== '13114') {
    const title = `3D街カルテ — ${areaConfig.name}`;
    document.title = `${title} | PLATEAU`;
    document.getElementById('areaTitle').textContent = title;
    document.getElementById('areaSubtitle').textContent =
      `PLATEAU 3D都市モデル (${areaConfig.year}年度版)`;
    document.getElementById('searchInput').placeholder =
      `住所で診断（例: ${areaConfig.name}○○）`;
    document.getElementById('attribution').innerHTML =
      `出典: <a href="https://www.mlit.go.jp/plateau/" target="_blank" rel="noopener">` +
      `国土交通省 Project PLATEAU</a>（${escapeHtml(areaConfig.name)} 3D都市モデル ` +
      `${escapeHtml(areaConfig.year)}年度・CC BY 4.0）／` +
      `<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">` +
      `地理院タイル</a>／` +
      `<a href="https://catalog.data.metro.tokyo.lg.jp/" target="_blank" rel="noopener">` +
      `中野区オープンデータ</a>（避難所・避難場所・CC BY 4.0）`;
  }

  const buildingOptions = [
    {
      value: 'lod2',
      text: 'LOD2（テクスチャ付き・高精細）',
      available: !!areaConfig.tilesets.bldgLod2,
    },
    {
      value: 'lod2notex',
      text: 'LOD2（テクスチャなし）',
      available: !!areaConfig.tilesets.bldgLod2NoTex,
    },
    {
      value: 'lod1',
      text: 'LOD1（箱型・軽量）',
      available: !!areaConfig.tilesets.bldgLod1,
    },
    { value: 'none', text: '非表示', available: true },
  ];
  document.getElementById('buildingLayers').innerHTML = buildingOptions
    .map(({ value, text, available }) =>
      `<label${available ? '' : ' class="layer-unavailable"'}>` +
      `<input type="radio" name="bldg" value="${value}"` +
      `${value === initialBuildingMode ? ' checked' : ''}${available ? '' : ' disabled'}> ` +
      `${text}${available ? '' : unavailableText()}</label>`)
    .join('');

  const zoningLabels = {
    use: '用途地域',
    fire: '防火・準防火地域',
    height: '高度地区',
  };
  document.getElementById('zoningLayers').innerHTML = Object.entries(zoningLabels)
    .map(([key, text]) => {
      const available = !!areaConfig.zoning[key];
      return `<label${available ? '' : ' class="layer-unavailable"'}>` +
        `<input type="checkbox" id="ov-${key}"${available ? '' : ' disabled'}> ${text}` +
        `${available ? '' : unavailableText()}</label>`;
    })
    .join('');

  document.getElementById('floodLayers').innerHTML = floodControls.length
    ? floodControls
      .map(({ id, text }) =>
        `<label><input type="checkbox" id="${escapeHtml(id)}"> ${escapeHtml(text)}</label>`)
      .join('')
    : `<label class="layer-unavailable"><input type="checkbox" id="fldUnavailable" disabled> ` +
      `洪水浸水想定${unavailableText()}</label>`;

  const transportOptions = [
    {
      id: 'tran',
      text: '道路（LOD3）',
      available: !!areaConfig.tilesets.tranLod3,
    },
    {
      id: 'wtr',
      text: '水部（LOD1）',
      available: !!areaConfig.tilesets.wtrLod1,
    },
  ];
  document.getElementById('transportLayers').innerHTML = transportOptions
    .map(({ id, text, available }) =>
      `<label${available ? '' : ' class="layer-unavailable"'}>` +
      `<input type="checkbox" id="${id}"${available ? '' : ' disabled'}> ${text}` +
      `${available ? '' : unavailableText()}</label>`)
    .join('');

  document.getElementById('presetButtons').innerHTML = Object.entries(areaConfig.presets || {})
    .map(([key, preset]) =>
      `<button data-preset="${escapeHtml(key)}">${escapeHtml(
        preset.label || LEGACY_PRESET_LABELS[key] || key,
      )}</button>`)
    .join('');
}

renderAreaChrome();

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
  const url = tilesetUrls[key];
  if (!url) return null;
  setStatus('データ読み込み中…');
  try {
    const tileset = await Cesium.Cesium3DTileset.fromUrl(url, {
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
  ...Object.fromEntries(floodControls.map(({ id, key }) => [id, key])),
  tran: 'tranLod3',
  wtr: 'wtrLod1',
};
for (const [id, key] of Object.entries(CHECK_LAYERS)) {
  const checkbox = document.getElementById(id);
  if (!checkbox || checkbox.disabled) continue;
  checkbox.addEventListener('change', async (e) => {
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
document.querySelectorAll('#presetButtons button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const preset = areaConfig.presets?.[btn.dataset.preset];
    if (preset) flyTo(preset);
  });
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
if (unsupportedArea) toast('未対応のエリア指定です', 3000);

// ---- 街カルテ（地点診断） -------------------------------------------------------

const diagnosis = initDiagnosis({
  viewer,
  areaConfig,
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
  areaConfig,
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

const overlays = initZoningOverlay({ viewer, areaConfig });

// compare は「比較のリンクをコピー」でのみ share を使うので、実体は後から差し込む
// （share は起動時復元で compare.restoreFromPoints を呼ぶため、相互に必要になる）
const shareRef = {};
const compare = initCompare({
  diagnosis,
  viewer,
  areaConfig,
  toast,
  share: { shareCompare: (pts) => shareRef.api.shareCompare(pts) },
});
const share = initShare({
  viewer,
  diagnosis,
  overlays,
  compare,
  toast,
  areaConfig,
});
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
  if (areaConfig.presets?.overview) flyTo(areaConfig.presets.overview, 0);
  await showBuildings(initialBuildingMode);
  // 共有URLがあればそちらを優先する（既定の中野駅プリセットへは飛ばさない）
  const hasHash = !!location.hash && location.hash.length > 1;
  const initialPreset = areaConfig.presets?.nakanoSta
    || Object.values(areaConfig.presets || {})[0]
    || null;
  if (!hasHash && initialPreset) {
    flyTo(initialPreset, 3.0);
  }
  restored = share.restoreFromHash().catch((e) => {
    console.warn('share: restore failed', e);
    return null;
  });
  const state = await restored;
  if (!state && hasHash && initialPreset) {
    flyTo(initialPreset, 3.0);
  }
})();

// テスト用フック（e2eから内部状態を参照するため）
window.__nakano = {
  viewer, getTileset, loaded, flyTo, showBuildings,
  diagnosis, overlays, compare, share, toast, shelterLayer, areaConfig,
  shadeMap: {
    run: (opts) => shadeMapController.run(opts),
    clear: () => shadeMapController.clear(),
    abort: () => shadeMapController.abort(),
    getState: () => shadeMapController.getState(),
    getCanvasState: () => shadeMapController.getCanvasState(),
  },
  getRestored: () => restored,
};
