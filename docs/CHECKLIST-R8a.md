# R8a PWA実機チェックリスト

Lighthouse v12以降は専用のPWAカテゴリが廃止されているため、`docs/plans/R5-R7-R8.md` §8の旧PWA監査相当項目をChrome DevTools Applicationパネルと実機で確認する。

## 実施記録

- 実施日:
- 確認者:
- 対象URL（HTTPS）:
- 対象コミット:
- Android端末 / OS / Chrome:
- iOS端末 / OS / Safari:
- 中間性能Android端末 / 回線:

## 1. Chrome DevToolsでのPWA基本確認

- [ ] 対象URLがHTTPSで配信されている
- [ ] Application → Manifestに検証エラーが0件で、「インストール可能」と表示される
- [ ] Manifestの`start_url`が開け、`display: standalone`、`theme_color`、`background_color`、192px / 512pxアイコンが認識される
- [ ] Application → Service Workersで`sw.js`がactivatedになり、ページがService Workerの制御下にある
- [ ] モバイル表示でコンテンツがviewport内に収まり、意図しない横スクロールや画面外へのはみ出しがない

## 2. オフライン再読み込み

事前にオンラインで一度開き、Service Workerがactivatedになったことを確認してから実施する。

- [ ] DevToolsのNetworkをOfflineにして再読み込みしても、アプリシェル（`offline.html`の案内画面）が表示される
- [ ] オフライン案内から、3D地図と診断には通信が必要だと分かる
- [ ] Onlineへ戻して再読み込みすると、3D地図と診断を再び利用できる

## 3. アイコンとセーフゾーン

- [ ] `assets/icons/icon-maskable-192.png`を[maskable.app](https://maskable.app/)で開き、minimum safe area内で主要図形や文字が欠けない
- [ ] `assets/icons/icon-maskable-512.png`を[maskable.app](https://maskable.app/)で開き、minimum safe area内で主要図形や文字が欠けない

## 4. Android実機

- [ ] Chromeの「ホーム画面に追加」または「アプリをインストール」からインストールできる
- [ ] ホーム画面のアイコン、テーマ色、起動時のスプラッシュ画面に不自然な欠けや色崩れがない
- [ ] ホーム画面のアイコンから起動すると、アドレスバーのないスタンドアロン表示になる
- [ ] 住所検索または地図タップから診断し、洪水・土砂災害・都市計画・日照の結果表示まで完走する
- [ ] 診断ボトムシートがドラッグに追従し、peek / half / fullへ自然にスナップする
- [ ] ボトムシート内の縦スクロールと背後の3D地図操作が意図せず競合しない

## 5. iOS実機

- [ ] Safariの共有 →「ホーム画面に追加」→「追加」でホーム画面へ追加できる
- [ ] ホーム画面にapple-touch-iconが欠けや色崩れなく表示される
- [ ] ホーム画面のアイコンから起動すると、Safariのアドレスバーがないスタンドアロン表示になる
- [ ] 住所検索または地図タップから診断し、洪水・土砂災害・都市計画・日照の結果表示まで完走する
- [ ] 診断ボトムシートがドラッグに追従し、peek / half / fullへ自然にスナップする
- [ ] ボトムシート内の縦スクロールと背後の3D地図操作が意図せず競合しない

## 6. 表示品質と性能

- [ ] 中間性能Androidで`?quality=light`を指定すると、初期建物レイヤーがLOD1になる
- [ ] 中間性能Androidで起動または再読み込みを開始してからLOD1の建物が初めて表示されるまで5秒以内である
  - 計測値:
- [ ] 「軽量」から「高画質」へ切り替えると再読み込みされ、LOD2の高精細表示になる
- [ ] 「高画質」から「軽量」へ戻すと再読み込みされ、LOD1の軽量表示になる
- [ ] 選択した表示品質が次回起動時にも維持される
- [ ] iOSで「高画質」を選ぶと「メモリ制限により強制再読み込みされる場合があります」と表示される

## 7. WebGL context lostからの復帰

開発者ツールまたは端末のメモリ圧迫により`webglcontextlost`を発生させて確認する。

Chrome DevToolsのConsoleから発生させる場合:

```js
const canvas = document.querySelector('#cesiumContainer canvas');
const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
gl.getExtension('WEBGL_lose_context').loseContext();
```

- [ ] 「メモリ不足のため表示をリセットします」と表示される
- [ ] 軽量モードへ切り替わって自動再読み込みされる
- [ ] 再読み込み後に3D地図を操作でき、診断を開始できる
- 発生方法 / 確認端末:

## 判定

- [ ] 上記の全項目を確認し、R8aの実機受け入れ基準を満たした
- 未解決事項:
