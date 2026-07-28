# 中野区 PLATEAU 配信データ一覧（2025年度）

PLATEAUデータカタログAPI（`https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets`）から取得した、中野区（区コード 13114）の配信データ一覧です（2026-07-27時点）。

## 3D Tiles

| データ | LOD | テクスチャ | URL |
|---|---|---|---|
| 建築物モデル | 1 | あり | `https://assets.cms.plateau.reearth.io/assets/00/0bafbd-0652-4f11-ab1f-ca88d81a98a7/13114_nakano-ku_pref_2025_citygml_1_op_bldg_3dtiles_13114_nakano-ku_lod1/tileset.json` |
| 建築物モデル | 2 | あり | `https://assets.cms.plateau.reearth.io/assets/69/c68a38-eae5-4a70-b981-497109b3e7f7/13114_nakano-ku_pref_2025_citygml_1_op_bldg_3dtiles_13114_nakano-ku_lod2/tileset.json` |
| 建築物モデル | 2 | なし | `https://assets.cms.plateau.reearth.io/assets/b7/d791c7-3f75-4050-b8bd-73bdc13b7b06/13114_nakano-ku_pref_2025_citygml_1_op_bldg_3dtiles_13114_nakano-ku_lod2_no_texture/tileset.json` |
| 洪水浸水想定区域（荒川水系 神田川・善福寺川等 L1） | - | なし | `https://assets.cms.plateau.reearth.io/assets/da/522425-bd49-4518-84aa-4afc705460ff/13114_nakano-ku_pref_2025_citygml_1_op_fld_pref_arakawa_kandagawa-zenpukujigawa-etc-2_3dtiles_l1_no_texture/tileset.json` |
| 洪水浸水想定区域（荒川水系 神田川・善福寺川等 L2） | - | なし | `https://assets.cms.plateau.reearth.io/assets/60/f43d45-f6e1-4e9f-9578-135c630c9bce/13114_nakano-ku_pref_2025_citygml_1_op_fld_pref_arakawa_kandagawa-zenpukujigawa-etc-2_3dtiles_l2_no_texture/tileset.json` |
| 洪水浸水想定区域（神田川流域 L2） | - | なし | `https://assets.cms.plateau.reearth.io/assets/90/585930-f5a4-4e06-8c93-22148c0d512c/13114_nakano-ku_pref_2025_citygml_1_op_fld_pref_kandagawa-ryuiki_3dtiles_l2_no_texture/tileset.json` |
| 道路モデル | 3 | あり | `https://assets.cms.plateau.reearth.io/assets/53/bac53a-130c-42cb-b02b-063825ee2ede/13114_nakano-ku_pref_2025_citygml_1_op_tran_3dtiles_lod3/tileset.json` |
| 水部モデル | 1 | あり | `https://assets.cms.plateau.reearth.io/assets/98/907332-c134-4908-b890-a984769c70f1/13114_nakano-ku_pref_2025_citygml_1_op_wtr_3dtiles_lod1/tileset.json` |

## MVT（ベクトルタイル）

| データ | LOD | URL |
|---|---|---|
| 土砂災害警戒区域 | - | `https://assets.cms.plateau.reearth.io/assets/8a/ffb843-8429-4a16-90da-3d2d9cdc2295/13114_nakano-ku_pref_2025_citygml_1_op_lsld_mvt/{z}/{x}/{y}.mvt` |
| 土地利用 | - | `https://assets.cms.plateau.reearth.io/assets/c4/756b22-d2cb-443c-917d-d429b7908bfb/13114_nakano-ku_pref_2025_citygml_1_op_luse_mvt/{z}/{x}/{y}.mvt` |
| 道路 | 1 | `https://assets.cms.plateau.reearth.io/assets/2b/60f4fb-ef8a-4431-a023-c3152da2348c/13114_nakano-ku_pref_2025_citygml_1_op_tran_mvt_lod1/{z}/{x}/{y}.mvt` |
| 道路 | 2 | `https://assets.cms.plateau.reearth.io/assets/12/829a50-f2b0-4fcc-9bf7-4c4be8758ff4/13114_nakano-ku_pref_2025_citygml_1_op_tran_mvt_lod2/{z}/{x}/{y}.mvt` |
| 防火地域・準防火地域 | 1 | `https://assets.cms.plateau.reearth.io/assets/1e/0deb86-38bf-40cc-b15b-42b73827c80c/13114_nakano-ku_pref_2025_citygml_1_op_urf_FirePreventionDistrict_mvt_lod1/{z}/{x}/{y}.mvt` |
| 高度地区 | 1 | `https://assets.cms.plateau.reearth.io/assets/d9/40e036-37b1-4201-b43c-9b9bed6d91fb/13114_nakano-ku_pref_2025_citygml_1_op_urf_HeightControlDistrict_mvt_lod1/{z}/{x}/{y}.mvt` |
| 用途地域 | 1 | `https://assets.cms.plateau.reearth.io/assets/70/76a8aa-a308-4050-b7ae-6a62af2a88c1/13114_nakano-ku_pref_2025_citygml_1_op_urf_UseDistrict_mvt_lod1/{z}/{x}/{y}.mvt` |
| 水部 | 0 | `https://assets.cms.plateau.reearth.io/assets/9c/8b0756-4288-4710-8dc4-b1bf777d081f/13114_nakano-ku_pref_2025_citygml_1_op_wtr_mvt_lod0/{z}/{x}/{y}.mvt` |

## ハザードマップポータル ラスタタイル（中野区で200が返るもの）

PLATEAU外だが街カルテで使っている全国配信のラスタタイル（`https://disaportaldata.gsi.go.jp/raster/...`、z=2〜17、CORS `*`）。2026-07-28 に中野区の代表地点で再確認。

| データ | パス | 中野区での配信状況 |
|---|---|---|
| 洪水浸水想定区域（想定最大規模） | `01_flood_l2_shinsuishin_data` | あり（河川沿い） |
| 洪水浸水想定区域（計画規模・現在の凡例） | `01_flood_l1_shinsuishin_newlegend_data` | あり。**`01_flood_l1_shinsuishin_data`（newlegendなし）は404** |
| 洪水浸水継続時間（想定最大規模） | `01_flood_l2_keizoku_data` | 河川沿いのタイルのみ。台地側はタイルごと404 |
| 土砂災害警戒区域（急傾斜地の崩壊） | `05_kyukeishakeikaikuiki` | あり（上高田等の13タイル） |
| 土砂災害警戒区域（土石流・地すべり） | `05_dosekiryukeikaikuiki` / `05_jisuberikeikaikuiki` | 中野区に指定なし（全404） |
| 内水（雨水出水）浸水想定 | `02_naisui_data` / `02_naisui_pref_data/13/` | **中野区は配信なし**（掲載市町村一覧に中野区なし。東京都は昭島市・福生市のみ） |

## 中野区オープンデータ（PLATEAU外・同梱データの出典）

東京都オープンデータカタログサイト（CKAN）経由の中野区データ。いずれも CC BY 4.0（`license_id` をAPIで確認、カタログ最終更新 2025-12-12）、UTF-8 with BOM のCSV、`access-control-allow-origin: *`。

| データ | 件数 | リソースURL |
|---|---|---|
| 震災時の避難所一覧 | 45 | `https://www2.wagmap.jp/nakanodatamap/nakanodatamap/opendatafile/map_32/CSV/opendata_5000342.csv` |
| 水害時避難所 | 44 | `https://www2.wagmap.jp/nakanodatamap/nakanodatamap/opendatafile/map_28/CSV/opendata_18000130.csv` |
| 広域避難場所 | 13 | `https://www2.wagmap.jp/nakanodatamap/nakanodatamap/opendatafile/map_32/CSV/opendata_6000680.csv` |

`tools/fetch-shelters.mjs`（`npm run shelters`）で `data/shelters.geojson` に変換して同梱しています。

不採用にした代替: 国土数値情報 避難施設P20（2012年度作成・非商用条件で鮮度もライセンスも劣る）／東京都下水道局の浸水予想区域図CSV（神田川流域北側だけで27.3MBの10mメッシュ点データで静的サイト同梱の規模を超える）／中野区オープンデータの「浸水深」「浸水継続時間」CSV（ランクごとの代表点1個ずつの凡例アノテーションで面判定には使えない）。

## CityGML（元データ）

生のCityGML（属性フル収録）が必要な場合は [G空間情報センターのPLATEAUページ](https://front.geospatial.jp/plateau_portal_site/) から「中野区」で検索してダウンロードできます。FBX/OBJ形式（Unity・Blender向け）も同梱されています。
