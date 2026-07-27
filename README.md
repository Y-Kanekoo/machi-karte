# 中野区 3D都市モデルビューア（nakano-3d）

東京都中野区全域を3Dで表示するWebアプリです。国土交通省 [Project PLATEAU](https://www.mlit.go.jp/plateau/) の中野区 3D都市モデル（2025年度版）をストリーミング配信で読み込み、CesiumJSで描画します。ビルドや3Dデータのダウンロードは不要で、`index.html` を開くだけで動きます。

## デモ

GitHub Pages: https://y-kanekoo.github.io/nakano-3d/

**初回のみ有効化が必要です**（GitHub Actionsのトークンでは自動有効化できないため）:

1. リポジトリの **Settings → Pages** を開く
2. 「Build and deployment」の **Source** を **GitHub Actions** にする
3. **Actions** タブから「Deploy to GitHub Pages」ワークフローを **Re-run**（または何かをpush）

以降はmainへのpushごとに自動デプロイされます。

## 機能

- **建物モデルの切り替え** — LOD2（テクスチャ付き・高精細）/ LOD2（テクスチャなし）/ LOD1（箱型・軽量）
- **高さによる色分け** — 建物の計測高さで5段階に色分け
- **日照シミュレーション** — 影の表示と時刻スライダー（6:00〜18:00 JST）
- **防災レイヤー** — 洪水浸水想定区域（神田川流域・荒川水系）を半透明で重ね合わせ
- **道路（LOD3）・水部レイヤー**
- **建物クリックで属性表示** — 計測高さ・用途などのCityGML属性
- **スポット移動** — 中野駅、サンプラザ跡・四季の森公園、中野ブロードウェイ、新井薬師、哲学堂公園
- **背景地図切り替え** — 地理院の航空写真 / 淡色地図

## ローカルでの実行

静的サイトなので、そのままHTTPサーバで配信するだけです。

```bash
python3 -m http.server 8000
# → http://localhost:8000 を開く
```

## 構成

| ファイル | 内容 |
|---|---|
| `index.html` | UIとCesiumJS（CDN）の読み込み |
| `app.js` | ビューア初期化、PLATEAUタイルセットの読み込み・スタイル・ピッキング |
| `style.css` | UIスタイル |
| `.github/workflows/pages.yml` | GitHub Pagesへの自動デプロイ |
| `docs/nakano-datasets.md` | 中野区で利用可能なPLATEAU配信データの一覧 |

## 使用データ

すべて PLATEAU Streaming（`assets.cms.plateau.reearth.io`）から実行時に取得します。

| データ | 形式 |
|---|---|
| 建築物モデル LOD1 / LOD2（テクスチャ有無） | 3D Tiles |
| 洪水浸水想定区域（神田川流域 L2、荒川水系 神田川・善福寺川等 L2） | 3D Tiles |
| 道路 LOD3 | 3D Tiles |
| 水部 LOD1 | 3D Tiles |

## 出典・ライセンス

- 3D都市モデル: 国土交通省 Project PLATEAU「中野区（2025年度）」（[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.ja) / 政府標準利用規約準拠）
- 背景地図: [地理院タイル](https://maps.gsi.go.jp/development/ichiran.html)（淡色地図・シームレス空中写真）
- 描画エンジン: [CesiumJS](https://cesium.com/platform/cesiumjs/)（Apache 2.0）

本リポジトリのコードはMITライセンスです。
