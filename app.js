// 中野区 3D都市モデルビューア
// データ: 国土交通省 Project PLATEAU 中野区 2025年度 (CC BY 4.0)
// 配信: PLATEAU Streaming (assets.cms.plateau.reearth.io)

'use strict';

const TILESETS = {
  bldgLod1:
    'https://assets.cms.plateau.reearth.io/assets/00/0bafbd-0652-4f11-ab1f-ca88d81a98a7/13114_nakano-ku_pref_2025_citygml_1_op_bldg_3dtiles_13114_nakano-ku_lod1/tileset.json',
  bldgLod2:
    'https://assets.cms.plateau.reearth.io/assets/69/c68a38-eae5-4a70-b981-497109b3e7f7/13114_nakano-ku_pref_2025_citygml_1_op_bldg_3dtiles_13114_nakano-ku_lod2/tileset.json',
  bldgLod2NoTex:
    'https://assets.cms.plateau.reearth.io/assets/b7/d791c7-3f75-4050-b8bd-73bdc13b7b06/13114_nakano-ku_pref_2025_citygml_1_op_bldg_3dtiles_13114_nakano-ku_lod2_no_texture/tileset.json',
  fldKandaL2:
    'https://assets.cms.plateau.reearth.io/assets/90/585930-f5a4-4e06-8c93-22148c0d512c/13114_nakano-ku_pref_2025_citygml_1_op_fld_pref_kandagawa-ryuiki_3dtiles_l2_no_texture/tileset.json',
  fldArakawaL2:
    'https://assets.cms.plateau.reearth.io/assets/60/f43d45-f6e1-4e9f-9578-135c630c9bce/13114_nakano-ku_pref_2025_citygml_1_op_fld_pref_arakawa_kandagawa-zenpukujigawa-etc-2_3dtiles_l2_no_texture/tileset.json',
  tranLod3:
    'https://assets.cms.plateau.reearth.io/assets/53/bac53a-130c-42cb-b02b-063825ee2ede/13114_nakano-ku_pref_2025_citygml_1_op_tran_3dtiles_lod3/tileset.json',
  wtrLod1:
    'https://assets.cms.plateau.reearth.io/assets/98/907332-c134-4908-b890-a984769c70f1/13114_nakano-ku_pref_2025_citygml_1_op_wtr_3dtiles_lod1/tileset.json',
};

const PRESETS = {
  nakanoSta:   { lon: 139.6659, lat: 35.7010, height: 500, heading: 0,   pitch: -40 },
  sunplaza:    { lon: 139.6645, lat: 35.7040, height: 450, heading: 30,  pitch: -35 },
  broadway:    { lon: 139.6656, lat: 35.7085, height: 400, heading: 180, pitch: -40 },
  araiyakushi: { lon: 139.6674, lat: 35.7125, height: 450, heading: 0,   pitch: -40 },
  tetsugakudo: { lon: 139.6790, lat: 35.7195, height: 500, heading: 220, pitch: -35 },
  overview:    { lon: 139.6640, lat: 35.6900, height: 4500, heading: 0,  pitch: -55 },
};

const HEIGHT_PROP_CANDIDATES = ['計測高さ', 'bldg:measuredHeight', 'measuredHeight', '高さ'];

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

async function showBuildings(mode) {
  for (const k of Object.values(BLDG_KEYS)) {
    if (loaded[k]) loaded[k].show = false;
  }
  currentBldg = null;
  if (mode === 'none') return;
  const key = BLDG_KEYS[mode];
  const ts = await getTileset(key);
  if (!ts) return;
  ts.show = true;
  currentBldg = ts;
  applyHeightColor();
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

document.querySelectorAll('input[name="imagery"]').forEach((el) => {
  el.addEventListener('change', () => {
    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.addImageryProvider(el.value === 'pale' ? gsiPale : gsiPhoto);
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

const infoPanel = document.getElementById('infoPanel');
const infoTable = document.getElementById('infoTable');
let highlighted = null;

function clearHighlight() {
  if (highlighted && !highlighted.isDestroyed?.()) {
    try { highlighted.color = Cesium.Color.WHITE; } catch (_) { /* tile unloaded */ }
  }
  highlighted = null;
}

viewer.screenSpaceEventHandler.setInputAction((click) => {
  const picked = viewer.scene.pick(click.position);
  clearHighlight();
  if (picked instanceof Cesium.Cesium3DTileFeature) {
    picked.color = Cesium.Color.YELLOW.withAlpha(0.8);
    highlighted = picked;
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
      rows.push(
        `<tr><th>${escapeHtml(name)}</th><td>${escapeHtml(String(val))}</td></tr>`
      );
    }
    infoTable.innerHTML = rows.join('') || '<tr><td>属性なし</td></tr>';
    infoPanel.classList.remove('hidden');
  } else {
    infoPanel.classList.add('hidden');
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

document.getElementById('closeInfo').addEventListener('click', () => {
  infoPanel.classList.add('hidden');
  clearHighlight();
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---- Init --------------------------------------------------------------------

(async () => {
  flyTo(PRESETS.overview, 0);
  await showBuildings('lod2');
  flyTo(PRESETS.nakanoSta, 3.0);
})();
