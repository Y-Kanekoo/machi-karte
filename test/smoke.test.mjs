// 既存機能のスモークテスト（P0: ESモジュール分割で挙動が変わっていないことを確認）
// 実行: node test/smoke.test.mjs （事前に python3 -m http.server 8123 が必要）

import { launchViewer, waitForViewerReady, openSection, check, equal, report, shotPath } from './harness.mjs';

const t = await launchViewer();
const { page } = t;

try {
  await waitForViewerReady(page);

  // --- 1. Cesium 初期化 ---
  const init = await page.evaluate(() => ({
    cesium: typeof Cesium !== 'undefined',
    canvas: !!document.querySelector('.cesium-widget canvas'),
    viewer: !!window.__nakano?.viewer,
  }));
  check('Cesiumがロードされる', init.cesium);
  check('canvasが生成される', init.canvas);
  check('viewerが初期化される', init.viewer);

  // --- 2. 建物タイルセット読み込み ---
  const bldg = await page.evaluate(() => {
    const ts = window.__nakano.loaded.bldgLod2;
    return { exists: !!ts, show: ts?.show, tilesLoaded: ts?.tilesLoaded, nProps: ts ? Object.keys(ts.properties || {}).length : 0 };
  });
  check('LOD2建物タイルセットが読み込まれる', bldg.exists);
  check('LOD2建物が表示状態', bldg.show === true);
  check('建物タイルが読み込み完了', bldg.tilesLoaded === true, JSON.stringify(bldg));

  // --- 3. 高さ色分け ---
  await openSection(page, 'buildingModelSection');
  await page.check('#heightColor');
  await page.waitForTimeout(800);
  const hc = await page.evaluate(() => ({
    legendVisible: !document.getElementById('legend').classList.contains('hidden'),
    styled: !!window.__nakano.loaded.bldgLod2?.style,
  }));
  check('高さ色分けONで凡例が表示される', hc.legendVisible);
  check('高さ色分けONでスタイルが適用される', hc.styled);
  await page.screenshot({ path: shotPath('smoke-height.png') });

  await page.uncheck('#heightColor');
  await page.waitForTimeout(500);
  const hcOff = await page.evaluate(() => ({
    legendVisible: !document.getElementById('legend').classList.contains('hidden'),
    styled: !!window.__nakano.loaded.bldgLod2?.style,
  }));
  check('高さ色分けOFFで凡例が隠れる', !hcOff.legendVisible);
  check('高さ色分けOFFでスタイルが外れる', !hcOff.styled);

  // --- 4. 洪水レイヤー ---
  await openSection(page, 'hazardSection');
  await page.check('#fldKanda');
  await page.waitForTimeout(6000);
  const fld = await page.evaluate(() => {
    const ts = window.__nakano.loaded.fldKandaL2;
    return { exists: !!ts, show: ts?.show };
  });
  check('洪水レイヤー（神田川L2）が読み込まれる', fld.exists);
  check('洪水レイヤーが表示状態', fld.show === true);
  await page.uncheck('#fldKanda');
  await page.waitForTimeout(300);
  const fldOff = await page.evaluate(() => window.__nakano.loaded.fldKandaL2?.show);
  check('洪水レイヤーOFFで非表示になる', fldOff === false);

  // --- 5. 背景地図切り替え ---
  await openSection(page, 'basemapSection');
  await page.check('input[name="imagery"][value="pale"]');
  await page.waitForTimeout(1500);
  const imagery = await page.evaluate(() => window.__nakano.viewer.imageryLayers.length);
  check('背景地図切り替え後もレイヤーが1枚ある', imagery === 1, `length=${imagery}`);
  await page.check('input[name="imagery"][value="photo"]');
  await page.waitForTimeout(1000);

  // --- 6. スポット移動 ---
  await openSection(page, 'presetSection');
  const before = await page.evaluate(() => window.__nakano.viewer.camera.positionCartographic.longitude);
  await page.click('button[data-preset="tetsugakudo"]');
  await page.waitForTimeout(4000);
  const after = await page.evaluate(() => window.__nakano.viewer.camera.positionCartographic.longitude);
  check('スポット移動でカメラ位置が変わる', Math.abs(after - before) > 1e-5, `${before} -> ${after}`);

  // --- 7. 建物クリックで属性表示（街カルテの「🏢建物」セクション） ---
  await page.click('button[data-preset="nakanoSta"]');
  await page.waitForTimeout(6000);
  const box = await page.locator('.cesium-widget canvas').boundingBox();
  let rows = 0;
  for (const [dx, dy] of [[0, 60], [-80, 80], [80, 40], [0, 120], [-150, 20], [150, 100]]) {
    await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
    await page.waitForTimeout(900);
    rows = await page.evaluate(() => {
      const p = document.getElementById('diagnosisPanel');
      if (p.classList.contains('hidden')) return 0;
      return document.querySelectorAll('#secBuilding tr').length;
    });
    if (rows > 3) break;
  }
  check('建物クリックで属性テーブルが表示される', rows > 3, `rows=${rows}`);
  await page.screenshot({ path: shotPath('smoke-pick.png') });

  // --- 8. JSエラーなし ---
  const fatal = t.errors.filter((e) => e.startsWith('PAGEERROR') || /Failed to load module|SyntaxError/.test(e));
  check('致命的なJSエラーがない', fatal.length === 0, JSON.stringify(fatal.slice(0, 3)));

  console.log('\n中継: ' + JSON.stringify(t.relay));
} finally {
  await t.close();
}

report('smoke.test.mjs');
