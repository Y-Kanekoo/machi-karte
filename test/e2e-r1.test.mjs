// R1（共有URL・用途地域オーバーレイ・地点比較・UX改善）のブラウザ統合テスト
// 実行: node test/e2e-r1.test.mjs （事前に python3 -m http.server 8123 が必要）
//
// 既存の test/e2e.test.mjs（街カルテ本体）とは別ファイルにして、R1で追加した
// 機能だけをまとめて検証する。期待値は 2026-07-27 実測の実データに基づく。

import { PNG } from 'pngjs';
import { launchViewer, waitForViewerReady, check, equal, near, report, shotPath, BASE_URL } from './harness.mjs';
import { USE_DISTRICT_COLORS } from '../js/config.js';

const t = await launchViewer({
  viewport: { width: 1440, height: 900 },
  // 現在地診断（F1-4）で geolocation も使う
  permissions: ['clipboard-read', 'clipboard-write', 'geolocation'],
});
const { page } = t;

/** 指定セクションの取得中スピナーが消えるのを待ってテキストを返す */
async function waitSection(p, id, timeout = 90000) {
  await p.waitForFunction(
    (sid) => {
      const el = document.getElementById(sid);
      return !!el && !el.querySelector('.spinner');
    },
    id,
    { timeout }
  );
  return (await p.textContent('#' + id)).replace(/\s+/g, ' ').trim();
}

async function diagnoseByAddress(q) {
  await page.fill('#searchInput', q);
  await page.click('#searchBtn');
  await page.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 60000 });
  await waitSection(page, 'secPlace');
}

async function cameraOf(p) {
  return p.evaluate(() => {
    const c = window.__nakano.viewer.camera;
    const carto = c.positionCartographic;
    return {
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
      height: carto.height,
      heading: Cesium.Math.toDegrees(c.heading),
      pitch: Cesium.Math.toDegrees(c.pitch),
    };
  });
}

try {
  await waitForViewerReady(page);
  await page.evaluate(() => window.__nakano.getRestored?.());

  // ============================================================================
  // 1. 共有URL（F1-1）
  // ============================================================================
  console.log('\n=== 1. 共有URL ===');

  // カードのヘッダ固定部にあるボタン（カード再描画で消えない位置）
  check('リンクコピーのボタンがカードヘッダにある',
    await page.locator('#diagnosisPanel .info-header #shareBtn').count() === 1);
  check('診断前は診断カードごと隠れている', await page.isHidden('#shareBtn'));

  await diagnoseByAddress('中野区弥生町2丁目');
  check('診断カードを開くとコピーボタンが見える', await page.isVisible('#shareBtn'));
  const floodBefore = await waitSection(page, 'secFlood');
  check('元ページの洪水判定が「0.5m未満」', floodBefore.includes('0.5m未満'), floodBefore);

  // コピー時点のカメラが載ることを確かめるため、少しだけ視点を変えてからコピーする
  await page.evaluate(() => {
    window.__nakano.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(139.6740, 35.6905, 720),
      orientation: { heading: Cesium.Math.toRadians(45), pitch: Cesium.Math.toRadians(-55), roll: 0 },
    });
  });
  const camAtCopy = await cameraOf(page);

  await page.click('#shareBtn');
  // トーストは2秒で消えるので、消える前に「出たこと」を掴む
  // （waitForSelector だと再評価のタイミングで取り逃すため waitForFunction を使う）
  const toastText = await page
    .waitForFunction(
      () => {
        const el = document.getElementById('toast');
        return el && !el.classList.contains('hidden') ? el.textContent : null;
      },
      null,
      { timeout: 5000, polling: 30 }
    )
    .then((h) => h.jsonValue());
  check('コピー後にトーストが出る', toastText.includes('コピーしました'), toastText);

  const hash = await page.evaluate(() => location.hash);
  console.log('  hash: ' + hash);
  check('ハッシュに v=1 が入る', hash.startsWith('#v=1'), hash);
  check('ハッシュに spot が入る', /[?&#]spot=139\.67\d+,35\.69\d+/.test(hash), hash);
  check('ハッシュに addr が入る', hash.includes('addr=' + encodeURIComponent('東京都中野区弥生町二丁目')), hash);
  check('ハッシュに cam が入る', /&cam=139\.674,35\.6905,720,45,-55/.test(hash), hash);
  check('オーバーレイOFFなので ov は入らない', !hash.includes('ov='), hash);

  await page
    .waitForFunction(() => document.getElementById('toast').classList.contains('hidden'),
      null, { timeout: 6000 })
    .then(() => check('トーストは2秒程度で自動的に消える', true))
    .catch(() => check('トーストは2秒程度で自動的に消える', false, 'タイムアウト'));

  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => 'CLIP_ERR:' + e);
  console.log('  clipboard: ' + String(clip).slice(0, 120));
  check('クリップボードにURL全体が入る', String(clip).endsWith(hash) && String(clip).startsWith('http'), String(clip));

  const shareUrl = String(clip).startsWith('http') ? String(clip) : BASE_URL + hash;

  // --- 別ページで開き直して復元されること ---
  console.log('\n--- 共有URLを新しいタブで開く ---');
  const p2 = await t.newPage(shareUrl);
  await waitForViewerReady(p2);
  await p2.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 120000 });
  const place2 = await waitSection(p2, 'secPlace');
  console.log('  📍 ' + place2);
  check('復元先で同じ住所が表示される', place2.includes('弥生町二丁目'), place2);
  check('復元先で同じ座標が表示される', place2.includes('139.673935'), place2);

  const flood2 = await waitSection(p2, 'secFlood');
  console.log('  🌊 ' + flood2);
  check('復元先で同じ洪水ランク（0.5m未満）', flood2.includes('0.5m未満'), flood2);

  const zone2 = await waitSection(p2, 'secZoning');
  check('復元先で同じ用途地域（近隣商業地域）', zone2.includes('近隣商業地域'), zone2);

  const cam2 = await cameraOf(p2);
  console.log('  cam(copy)=' + JSON.stringify(camAtCopy) + '\n  cam(restore)=' + JSON.stringify(cam2));
  near('復元カメラの経度', cam2.lon, camAtCopy.lon, 1e-4);
  near('復元カメラの緯度', cam2.lat, camAtCopy.lat, 1e-4);
  near('復元カメラの高度', cam2.height, camAtCopy.height, 2);
  near('復元カメラのheading', cam2.heading, camAtCopy.heading, 1);
  near('復元カメラのpitch', cam2.pitch, camAtCopy.pitch, 1);

  const pin2 = await p2.evaluate(() => window.__nakano.viewer.entities.values.length);
  check('復元先でもピンが立つ', pin2 === 1, `entities=${pin2}`);

  await p2.screenshot({ path: shotPath('r1-01-share-restore.png') });
  await p2.locator('#diagnosisPanel').screenshot({ path: shotPath('r1-02-share-card.png') });
  await p2.close();

  // --- 壊れたハッシュ / 範囲外座標は黙って無視する ---
  console.log('\n--- 壊れた共有URL ---');
  const p3 = await t.newPage(BASE_URL + '#v=9&spot=999,999');
  await waitForViewerReady(p3);
  await p3.waitForTimeout(3000);
  check('未知バージョンでは診断カードが開かない', await p3.isHidden('#diagnosisPanel'));
  await p3.close();

  const p4 = await t.newPage(BASE_URL + '#v=1&spot=999,999');
  await waitForViewerReady(p4);
  await p4.waitForTimeout(3000);
  check('範囲外座標では診断カードが開かない', await p4.isHidden('#diagnosisPanel'));
  await p4.close();

  // ============================================================================
  // 2. 用途地域カラーオーバーレイ（F1-3）
  // ============================================================================
  console.log('\n=== 2. 都市計画オーバーレイ ===');

  await page.evaluate(() => window.__nakano.diagnosis.close());

  // --- 2a. 最小プロバイダ（全タイル単色）でCesiumの要件を満たしているか確認 ---
  const solid = await page.evaluate(async () => {
    const v = window.__nakano.viewer;
    const before = v.imageryLayers.length;
    const h = window.__nakano.overlays.addSolidTestLayer('#ff00ff');
    await new Promise((r) => setTimeout(r, 3000));
    const after = v.imageryLayers.length;
    const stats = { ...h.provider.stats };
    h.remove();
    return { before, after, stats, removed: v.imageryLayers.length };
  });
  console.log('  単色プロバイダ: ' + JSON.stringify(solid));
  equal('最小プロバイダでレイヤーが1枚増える', solid.after, solid.before + 1);
  check('最小プロバイダがタイルを要求される', solid.stats.requested > 0, JSON.stringify(solid.stats));
  check('最小プロバイダが失敗タイルを出さない', solid.stats.failed === 0, JSON.stringify(solid.stats));
  equal('最小プロバイダを外すと元の枚数に戻る', solid.removed, solid.before);

  // --- 2b. 用途地域ON ---
  const layersBefore = await page.evaluate(() => window.__nakano.viewer.imageryLayers.length);
  await page.check('#ov-use');
  await page.waitForTimeout(1000);
  const layersAfter = await page.evaluate(() => window.__nakano.viewer.imageryLayers.length);
  equal('用途地域ONでimageryLayersが1枚増える', layersAfter, layersBefore + 1);
  check('透明度スライダーが現れる', await page.isVisible('#overlayAlpha'));
  check('凡例が表示される', await page.isVisible('#zoningLegend'));
  const legendText = (await page.textContent('#zoningLegend')).replace(/\s+/g, ' ');
  check('凡例に「用途地域」の見出しがある', legendText.includes('用途地域'), legendText.slice(0, 100));
  check('凡例に商業地域がある', legendText.includes('商業地域'), legendText.slice(0, 200));
  check('凡例に「その他」がある', legendText.includes('その他'), legendText.slice(0, 300));

  // --- 2c. canvasピクセル検証（駅前上空を真上から見る） ---
  // 建物3Dと空気遠近を切って、背景を淡色地図にしてから、オーバーレイを不透明にして色を読む
  await page.evaluate(async () => {
    const n = window.__nakano;
    await n.showBuildings('none');
    n.viewer.scene.globe.showGroundAtmosphere = false;
    n.viewer.scene.skyAtmosphere.show = false;
    n.overlays.setAlpha(1.0);
  });
  await page.check('input[name="imagery"][value="pale"]');

  async function centerPixel(lon, lat, height = 900) {
    await page.evaluate(
      ({ lon, lat, height }) => {
        window.__nakano.viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
          orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
        });
      },
      { lon, lat, height }
    );
    // タイルの取得と描画を待つ
    await page.waitForTimeout(6000);
    const box = await page.locator('.cesium-widget canvas').boundingBox();
    const buf = await page.screenshot({
      clip: { x: box.x + box.width / 2 - 4, y: box.y + box.height / 2 - 4, width: 8, height: 8 },
    });
    const png = PNG.sync.read(buf);
    const i = (png.width * 4 + 4) * 4; // 8×8の中心
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
  }

  function hexToRgb(hex) {
    return [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
  }
  function rgbDist(a, b) {
    return Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0));
  }

  const commercial = hexToRgb(USE_DISTRICT_COLORS['商業地域']);
  const pxStation = await centerPixel(139.6659, 35.7056);
  console.log(`  中野駅前のピクセル: rgb(${pxStation}) / 商業地域=rgb(${commercial})`);
  check('駅前のピクセルが商業地域の色に一致する（±40）',
    rgbDist(pxStation, commercial) <= 40, `dist=${rgbDist(pxStation, commercial).toFixed(1)}`);
  check('駅前のピクセルは赤系（R>G かつ R>B）',
    pxStation[0] > pxStation[1] && pxStation[0] > pxStation[2], String(pxStation));

  const midRise = hexToRgb(USE_DISTRICT_COLORS['第1種中高層住居専用地域']);
  const pxNakano5 = await centerPixel(139.66893, 35.707859);
  console.log(`  中野五丁目のピクセル: rgb(${pxNakano5}) / 第1種中高層住居専用地域=rgb(${midRise})`);
  check('中野五丁目のピクセルが第1種中高層住居専用地域の色に一致する（±40）',
    rgbDist(pxNakano5, midRise) <= 40, `dist=${rgbDist(pxNakano5, midRise).toFixed(1)}`);
  check('中野五丁目のピクセルは緑系（G>R かつ G>B）',
    pxNakano5[1] > pxNakano5[0] && pxNakano5[1] > pxNakano5[2], String(pxNakano5));

  const provStats = await page.evaluate(() => ({ ...window.__nakano.overlays.getProvider('use').stats }));
  console.log('  provider stats: ' + JSON.stringify(provStats));
  check('MVTタイルを実際に描画している', provStats.drawn > 0, JSON.stringify(provStats));
  check('タイルのデコード失敗がない', provStats.failed === 0, JSON.stringify(provStats));

  // 見栄えのするスクリーンショット（斜め視点・初期透明度）
  await page.evaluate(() => {
    const n = window.__nakano;
    n.overlays.setAlpha(0.55);
    n.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(139.6659, 35.7010, 1400),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-55), roll: 0 },
    });
  });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: shotPath('r1-03-overlay-use.png') });

  // --- 2d. 透明度スライダー ---
  await page.fill('#overlayAlpha', '80');
  await page.dispatchEvent('#overlayAlpha', 'input');
  await page.waitForTimeout(300);
  const alpha80 = await page.evaluate(() => window.__nakano.overlays.getLayer('use').alpha);
  near('スライダー80%でImageryLayer.alphaが0.8になる', alpha80, 0.8, 1e-6);
  await page.fill('#overlayAlpha', '30');
  await page.dispatchEvent('#overlayAlpha', 'input');
  await page.waitForTimeout(300);
  const alpha30 = await page.evaluate(() => window.__nakano.overlays.getLayer('use').alpha);
  near('スライダー30%でImageryLayer.alphaが0.3になる', alpha30, 0.3, 1e-6);
  check('凡例ラベルが同期する', (await page.textContent('#overlayAlphaLabel')).includes('30'));

  // --- 2e. 防火・高度地区の同時表示 ---
  await page.check('#ov-fire');
  await page.check('#ov-height');
  await page.waitForTimeout(2500);
  const active = await page.evaluate(() => window.__nakano.overlays.getActive());
  equal('3レイヤーが同時にONになる', active.join(','), 'use,fire,height');
  const legend3 = (await page.textContent('#zoningLegend')).replace(/\s+/g, ' ');
  check('凡例に防火地域が積まれる', legend3.includes('準防火地域'), legend3.slice(0, 400));
  check('凡例に高度地区が積まれる', legend3.includes('高度地区'), legend3.slice(-200));
  await page.screenshot({ path: shotPath('r1-04-overlay-all.png') });

  // --- 2f. OFFでレイヤーが消える ---
  const before3 = await page.evaluate(() => window.__nakano.viewer.imageryLayers.length);
  await page.uncheck('#ov-use');
  await page.uncheck('#ov-fire');
  await page.uncheck('#ov-height');
  await page.waitForTimeout(500);
  const after3 = await page.evaluate(() => window.__nakano.viewer.imageryLayers.length);
  equal('3レイヤーOFFでimageryLayersが3枚減る', after3, before3 - 3);
  check('全OFFで凡例が隠れる', await page.isHidden('#zoningLegend'));
  check('全OFFで透明度スライダーも隠れる', await page.isHidden('#overlayAlpha'));

  // --- 2g. 背景地図を切り替えてもオーバーレイが残る（removeAllをやめた回帰） ---
  await page.check('#ov-use');
  await page.waitForTimeout(800);
  await page.check('input[name="imagery"][value="photo"]');
  await page.waitForTimeout(1200);
  const stillOn = await page.evaluate(() => ({
    active: window.__nakano.overlays.getActive(),
    layers: window.__nakano.viewer.imageryLayers.length,
  }));
  equal('背景地図を切り替えてもオーバーレイが残る', stillOn.active.join(','), 'use');
  equal('背景1枚＋オーバーレイ1枚', stillOn.layers, 2);
  await page.uncheck('#ov-use');

  // --- 2h. 点判定（診断カードの都市計画セクション）が回帰していない ---
  await page.evaluate(() => window.__nakano.showBuildings('lod2'));
  await diagnoseByAddress('中野区弥生町2丁目');
  const zoneAfterOverlay = await waitSection(page, 'secZoning');
  check('オーバーレイ導入後も点判定は近隣商業地域のまま',
    zoneAfterOverlay.includes('近隣商業地域') && zoneAfterOverlay.includes('建蔽率 80%'),
    zoneAfterOverlay);

  // --- 2i. オーバーレイONの状態が共有URLに載る ---
  await page.check('#ov-use');
  await page.check('#ov-height');
  await page.waitForTimeout(600);
  await page.click('#shareBtn');
  await page.waitForTimeout(400);
  const hashOv = await page.evaluate(() => location.hash);
  check('ハッシュに ov=use,height が入る', hashOv.includes('ov=use,height'), hashOv);

  const p5 = await t.newPage(BASE_URL + hashOv);
  await waitForViewerReady(p5);
  await p5.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 120000 });
  await p5.waitForTimeout(1500);
  const restoredOv = await p5.evaluate(() => ({
    active: window.__nakano.overlays.getActive(),
    checked: ['use', 'fire', 'height'].filter((k) => document.getElementById('ov-' + k).checked),
  }));
  console.log('  復元されたオーバーレイ: ' + JSON.stringify(restoredOv));
  equal('共有URLからオーバーレイが復元される', restoredOv.active.join(','), 'use,height');
  equal('チェックボックスも同期する', restoredOv.checked.join(','), 'use,height');
  await p5.close();
  await page.uncheck('#ov-use');
  await page.uncheck('#ov-height');

  // ============================================================================
  // 3. 地点比較（F1-2）
  // ============================================================================
  console.log('\n=== 3. 地点比較 ===');

  /** 座標を直接指定して素早く診断する（日照はスキップ） */
  async function quickDiagnose(lon, lat, title) {
    await page.evaluate(
      ({ lon, lat, title }) =>
        window.__nakano.diagnosis.runDiagnosisAt(lon, lat, { title, fly: false, skipSunlight: true }),
      { lon, lat, title }
    );
    await waitSection(page, 'secZoning');
  }

  const YAYOI = [139.673935, 35.691502, '東京都中野区弥生町二丁目'];
  const SAGINOMIYA = [139.635, 35.725, '東京都中野区鷺宮三丁目'];
  const STATION = [139.6659, 35.7056, '中野駅前'];
  const NAKANO5 = [139.66893, 35.707859, '東京都中野区中野五丁目'];

  await page.evaluate(() => window.__nakano.compare.clearAll());

  await quickDiagnose(...YAYOI);
  await page.click('#compareAddBtn');
  await page.waitForTimeout(300);
  check('1件目を追加すると比較バーが出る', await page.isVisible('#compareBar'));
  check('比較バーに件数が出る', (await page.textContent('#compareBarText')).includes('1地点'),
    await page.textContent('#compareBarText'));
  check('1件だけでは「表を表示」が押せない',
    await page.isDisabled('#compareShowBtn'));

  // 同一地点（10m未満）の重複追加は無視される
  await page.click('#compareAddBtn');
  await page.waitForTimeout(300);
  const dupCount = await page.evaluate(() => window.__nakano.compare.getItems().length);
  equal('同じ地点の重複追加は無視される', dupCount, 1);

  await quickDiagnose(...SAGINOMIYA);
  await page.click('#compareAddBtn');
  await page.waitForTimeout(300);
  check('2件目で「表を表示」が押せる', !(await page.isDisabled('#compareShowBtn')));

  await page.click('#compareShowBtn');
  await page.waitForSelector('#compareModal:not(.hidden)', { timeout: 10000 });
  check('比較モーダルが role="dialog" で開く',
    await page.getAttribute('#compareModal', 'role') === 'dialog');

  const table2 = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#compareModalBody tbody tr')];
    const out = {};
    for (const tr of rows) {
      const key = tr.querySelector('th').textContent.trim();
      out[key] = [...tr.querySelectorAll('td')].map((td) => td.textContent.trim());
    }
    return { rows: out, cols: document.querySelectorAll('#compareModalBody thead th').length - 1 };
  });
  console.log('  比較表: ' + JSON.stringify(table2.rows, null, 1).slice(0, 600));
  equal('列が2つ', table2.cols, 2);
  equal('洪水の行が「0.5m未満 vs 区域外」', table2.rows['洪水浸水想定'].join(' vs '), '0.5m未満 vs 区域外');
  equal('用途地域の行が「近隣商業地域 vs 第1種低層住居専用地域」',
    table2.rows['用途地域'].join(' vs '), '近隣商業地域 vs 第1種低層住居専用地域');
  equal('建蔽率の行', table2.rows['建蔽率'].join(' vs '), '80% vs 50%');
  equal('容積率の行', table2.rows['容積率'].join(' vs '), '400% vs 150%');
  equal('日照は未計算と出る', table2.rows['日照（冬至）'].join(' vs '), '未計算 vs 未計算');

  const headText = (await page.textContent('#compareModalBody thead')).replace(/\s+/g, ' ');
  check('列ヘッダに住所が出る', headText.includes('弥生町二丁目') && headText.includes('鷺宮'), headText);
  check('列ヘッダに削除ボタンがある', (await page.locator('#compareModalBody .cmp-del').count()) === 2);
  check('列ヘッダに地図で表示ボタンがある', (await page.locator('#compareModalBody .cmp-goto').count()) === 2);
  check('日照未計算の案内文が出る', (await page.textContent('#compareModalBody')).includes('地図で表示'));

  await page.screenshot({ path: shotPath('r1-05-compare-table.png') });
  await page.locator('.cmp-panel').screenshot({ path: shotPath('r1-06-compare-panel.png') });

  // Escapeで閉じる
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Escapeで比較モーダルが閉じる', await page.isHidden('#compareModal'));

  // 3件目・4件目（最古の押し出し）
  await quickDiagnose(...STATION);
  await page.click('#compareAddBtn');
  await page.waitForTimeout(300);
  equal('3件目まで追加できる',
    await page.evaluate(() => window.__nakano.compare.getItems().length), 3);

  await quickDiagnose(...NAKANO5);
  await page.click('#compareAddBtn');
  await page.waitForTimeout(300);
  const after4 = await page.evaluate(() => ({
    n: window.__nakano.compare.getItems().length,
    titles: window.__nakano.compare.getItems().map((s) => s.title),
    toast: document.getElementById('toast').textContent,
  }));
  console.log('  4件目追加後: ' + JSON.stringify(after4));
  equal('4件目を足しても3件のまま', after4.n, 3);
  check('最も古い弥生町が押し出される',
    !after4.titles.some((x) => String(x).includes('弥生町')), JSON.stringify(after4.titles));
  check('押し出しをトーストで知らせる', after4.toast.includes('最大'), after4.toast);

  // 列の削除
  await page.click('#compareShowBtn');
  await page.waitForSelector('#compareModal:not(.hidden)');
  await page.locator('#compareModalBody .cmp-del').first().click();
  await page.waitForTimeout(400);
  const cols2 = await page.locator('#compareModalBody thead th').count();
  equal('列を削除すると2列になる', cols2 - 1, 2);

  // 比較URLの共有と復元
  await page.click('#compareShareBtn');
  await page.waitForTimeout(500);
  const cmpHash = await page.evaluate(() => location.hash);
  console.log('  compare hash: ' + cmpHash);
  check('比較のハッシュに compare= が入る', /[&#]compare=[\d.]+,[\d.]+;[\d.]+,[\d.]+/.test(cmpHash), cmpHash);

  const p6 = await t.newPage(BASE_URL + cmpHash);
  await waitForViewerReady(p6);
  await p6.waitForSelector('#compareModal:not(.hidden)', { timeout: 150000 });
  const restoredCols = await p6.locator('#compareModalBody thead th').count();
  equal('比較URLを開くと2列のモーダルが自動表示される', restoredCols - 1, 2);
  const restoredText = (await p6.textContent('#compareModalBody')).replace(/\s+/g, ' ');
  check('復元した比較表に用途地域が入っている',
    /商業地域|住居専用地域/.test(restoredText), restoredText.slice(0, 200));
  check('復元時の日照は未計算', restoredText.includes('未計算'), restoredText.slice(0, 300));
  await p6.close();

  await page.evaluate(() => window.__nakano.compare.clearAll());
  check('消去で比較バーが隠れる', await page.isHidden('#compareBar'));

  // ============================================================================
  // JSエラー
  // ============================================================================
  const fatal = t.errors.filter(
    (e) => e.startsWith('PAGEERROR') || /Failed to load module|SyntaxError|is not a function|is not a constructor/.test(e)
  );
  check('致命的なJSエラーがない', fatal.length === 0, JSON.stringify(fatal.slice(0, 4)));
  if (t.errors.length) console.log('\n(参考) console errors: ' + JSON.stringify(t.errors.slice(0, 6), null, 1));
  console.log('中継: ' + JSON.stringify(t.relay));
} finally {
  await t.close();
}

report('e2e-r1.test.mjs');
