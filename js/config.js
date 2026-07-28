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
  // 洪水浸水継続時間（想定最大規模） z=2〜17
  // 中野区は神田川・善福寺川・妙正寺川沿いのタイルのみ配信あり（台地側は404）
  floodKeizoku: {
    url: 'https://disaportaldata.gsi.go.jp/raster/01_flood_l2_keizoku_data/{z}/{x}/{y}.png',
    z: 16,
    label: '浸水継続時間（想定最大規模）',
  },
  // 洪水浸水想定区域（計画規模・新凡例） z=2〜17
  // `01_flood_l1_shinsuishin_data`（newlegendなし）は中野区404。必ず newlegend を使う
  floodL1: {
    url: 'https://disaportaldata.gsi.go.jp/raster/01_flood_l1_shinsuishin_newlegend_data/{z}/{x}/{y}.png',
    z: 16,
    label: '洪水浸水想定（計画規模）',
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

// ---- R1: 共有・比較・見える化 ------------------------------------------------

/**
 * 対応エリア（中野区周辺）。
 * 用途地域オーバーレイの配信範囲（ImageryProvider の rectangle）と、
 * 現在地診断の「エリア内か」判定に使う。
 * R4 で自治体を増やすときは、この定数を「自治体ごとの矩形テーブル」に差し替え、
 * 選択中の自治体の矩形を返す関数経由で参照するようにする。
 */
export const AREA_RECT = { west: 139.60, south: 35.66, east: 139.72, north: 35.75 };

/** 共有URLに載せる座標の妥当性チェック範囲（日本域） */
export const JP_BOUNDS = { west: 122, south: 20, east: 154, north: 46 };

/** 都市計画オーバーレイのキー（ZONING_TILES のキーと対応。表示順もこの順） */
export const OVERLAY_KEYS = ['use', 'fire', 'height'];

/** オーバーレイのタイルレベル。実測: PLATEAU の MVT は z=10〜16 配信（z=17 は404）。
 *  z=10 は 2.6MB/タイルと重いので実用ズーム帯の 14〜16 に限定する。 */
export const OVERLAY_MIN_LEVEL = 14;
export const OVERLAY_MAX_LEVEL = 16;

/** ラスタライズ済みタイルのメモリキャッシュ上限（LRU） */
export const OVERLAY_TILE_CACHE_MAX = 100;

/** オーバーレイの初期透明度 */
export const OVERLAY_DEFAULT_ALPHA = 0.55;

/**
 * 用途地域の配色（都市計画図の慣用配色に準拠）。
 * オーバーレイの塗り色と凡例の単一ソース。
 */
export const USE_DISTRICT_COLORS = {
  '第1種低層住居専用地域': '#52A373',
  '第2種低層住居専用地域': '#7DBE8E',
  '第1種中高層住居専用地域': '#A8D8A0',
  '第2種中高層住居専用地域': '#C6E6B3',
  '第1種住居地域': '#F4E88B',
  '第2種住居地域': '#F9DFA0',
  '準住居地域': '#F5C97B',
  '近隣商業地域': '#F2AEC4',
  '商業地域': '#E77B8F',
  '準工業地域': '#C7A9D6',
  '工業地域': '#9FC6E8',
  '工業専用地域': '#7FA8D9',
};

/** 用途地域の未知の値（凡例では「その他」） */
export const USE_DISTRICT_OTHER_COLOR = '#BBBBBB';

/** 防火地域・準防火地域の配色 */
export const FIRE_COLORS = {
  '防火地域': '#E06666',
  '準防火地域': '#F0B060',
};

/** 高度地区は属性値の種類が少ないので単色 */
export const HEIGHT_DISTRICT_COLOR = '#8FB6E0';

/** 洪水ランク → 表示色（診断カードと比較表で共用） */
export const FLOOD_COLORS = {
  '区域外': '#7fd6a2',
  '0.5m未満': '#f7f5a9',
  '0.5〜3.0m': '#ffd8c0',
  '3.0〜5.0m': '#ffb7b7',
  '5.0〜10.0m': '#ff9191',
  '10.0〜20.0m': '#f285c9',
  '20.0m以上': '#dc7adc',
};

// ---- R2: 防災強化 --------------------------------------------------------------

/**
 * 中野区ハザードマップ（水害・土砂災害）の案内ページ。
 * 内水（雨水出水）は本ツール未対応なので、その注記からここへ誘導する。
 * 2026-07-28 に HTTP 200 を確認。
 */
export const NAKANO_HAZARDMAP_URL =
  'https://www.city.tokyo-nakano.lg.jp/bosai/hazardmap/hazardmap.html';

/**
 * 同梱の避難所GeoJSON（tools/fetch-shelters.mjs で生成）。
 * import.meta.url 起点なので GitHub Pages のサブパス配信でも解決できる。
 */
export const SHELTERS_URL = new URL('../data/shelters.geojson', import.meta.url).href;

/** 避難所の種別（GeoJSONの properties.type と対応）。ラベルと色の単一ソース */
export const SHELTER_TYPES = {
  quake: { label: '震災時の避難所', color: '#5ecb7a' },
  flood: { label: '水害時避難所',   color: '#5aa9f0' },
  wide:  { label: '広域避難場所',   color: '#f0a44a' },
};

/** 避難所ラベルを表示する距離（m）。102件のラベル重なりと描画負荷を抑える */
export const SHELTER_LABEL_MAX_DISTANCE = 2500;

/** 比較できる最大地点数 */
export const COMPARE_MAX = 3;
/** 比較の重複追加とみなす距離（m） */
export const COMPARE_DEDUPE_METERS = 10;
/** 比較状態の sessionStorage キー */
export const COMPARE_STORAGE_KEY = 'karte-compare';

/** 診断履歴の保持件数 */
export const HISTORY_MAX = 5;
/** 診断履歴の sessionStorage キー */
export const HISTORY_STORAGE_KEY = 'karte-history';
/** カードのセクション開閉状態の sessionStorage キー */
export const COLLAPSE_STORAGE_KEY = 'karte-collapsed';

/** 現在地取得のタイムアウト（ms） */
export const GEOLOCATION_TIMEOUT = 10000;

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
