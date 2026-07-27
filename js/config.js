// 定数定義（タイルセットURL・プリセット視点・外部データソース）

export const TILESETS = {
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

export const PRESETS = {
  nakanoSta:   { lon: 139.6659, lat: 35.7010, height: 500, heading: 0,   pitch: -40 },
  sunplaza:    { lon: 139.6645, lat: 35.7040, height: 450, heading: 30,  pitch: -35 },
  broadway:    { lon: 139.6656, lat: 35.7085, height: 400, heading: 180, pitch: -40 },
  araiyakushi: { lon: 139.6674, lat: 35.7125, height: 450, heading: 0,   pitch: -40 },
  tetsugakudo: { lon: 139.6790, lat: 35.7195, height: 500, heading: 220, pitch: -35 },
  overview:    { lon: 139.6640, lat: 35.6900, height: 4500, heading: 0,  pitch: -55 },
};

export const HEIGHT_PROP_CANDIDATES = ['計測高さ', 'bldg:measuredHeight', 'measuredHeight', '高さ'];

// ---- 地点診断で使う外部データソース ------------------------------------------

/** 国土地理院 住所検索API（CORS: *、キー不要） */
export const GEOCODE_URL = 'https://msearch.gsi.go.jp/address-search/AddressSearch';

/** ハザードマップポータル ラスタタイル（CORS: *、キー不要） */
export const HAZARD_TILES = {
  // 洪水浸水想定区域（想定最大規模） z=2〜17
  floodL2: {
    url: 'https://disaportaldata.gsi.go.jp/raster/01_flood_l2_shinsuishin_data/{z}/{x}/{y}.png',
    z: 16,
    label: '洪水浸水想定（想定最大規模）',
  },
  // 土砂災害警戒区域 z=2〜17
  debrisFlow: {
    url: 'https://disaportaldata.gsi.go.jp/raster/05_dosekiryukeikaikuiki/{z}/{x}/{y}.png',
    z: 16,
    label: '土石流',
  },
  steepSlope: {
    url: 'https://disaportaldata.gsi.go.jp/raster/05_kyukeishakeikaikuiki/{z}/{x}/{y}.png',
    z: 16,
    label: '急傾斜地の崩壊',
  },
  landslide: {
    url: 'https://disaportaldata.gsi.go.jp/raster/05_jisuberikeikaikuiki/{z}/{x}/{y}.png',
    z: 16,
    label: '地すべり',
  },
};

/** PLATEAU 都市計画決定情報 MVT（中野区 2025年度） */
export const ZONING_TILES = {
  use: {
    url: 'https://assets.cms.plateau.reearth.io/assets/70/76a8aa-a308-4050-b7ae-6a62af2a88c1/13114_nakano-ku_pref_2025_citygml_1_op_urf_UseDistrict_mvt_lod1/{z}/{x}/{y}.mvt',
    z: 16,
    label: '用途地域',
  },
  fire: {
    url: 'https://assets.cms.plateau.reearth.io/assets/1e/0deb86-38bf-40cc-b15b-42b73827c80c/13114_nakano-ku_pref_2025_citygml_1_op_urf_FirePreventionDistrict_mvt_lod1/{z}/{x}/{y}.mvt',
    z: 16,
    label: '防火地域・準防火地域',
  },
  height: {
    url: 'https://assets.cms.plateau.reearth.io/assets/d9/40e036-37b1-4201-b43c-9b9bed6d91fb/13114_nakano-ku_pref_2025_citygml_1_op_urf_HeightControlDistrict_mvt_lod1/{z}/{x}/{y}.mvt',
    z: 16,
    label: '高度地区',
  },
};

/** MVTデコード用CDN（ブラウザ用。pbf v4以降はexport形状が変わるためv3系に固定） */
export const MVT_CDN = [
  {
    pbf: 'https://cdn.jsdelivr.net/npm/pbf@3.3.0/+esm',
    vectorTile: 'https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@1.3.1/+esm',
  },
  {
    pbf: 'https://unpkg.com/pbf@3.3.0/index.js',
    vectorTile: 'https://unpkg.com/@mapbox/vector-tile@1.3.1/index.js',
  },
];
