// R4-P2（動的レイヤーUI・データ欠損UI）のブラウザ統合テスト
// 実行: node test/e2e-r4.test.mjs（事前に `npm run serve` が必要）
//
// Cesium canvasのマウス操作は使わず、既存のwindow.__nakanoフックとDOMを直接操作する。

import {
  BASE_URL,
  launchViewer,
  check,
  equal,
  near,
  report,
} from './harness.mjs';

async function waitForApp(page, cityCode) {
  await page.waitForFunction(
    (code) => window.__nakano?.areaConfig?.code === code,
    cityCode,
    { timeout: 180000, polling: 500 },
  );
}

async function diagnoseAt(page, lon, lat, title) {
  return page.evaluate(
    async ({ x, y, name }) => {
      const result = await window.__nakano.diagnosis.runDiagnosisAt(x, y, {
        title: name,
        fly: false,
        skipSunlight: true,
      });
      return {
        flood: result.flood?.rank || null,
        use: result.zoning?.use?.name || null,
        coverage: result.zoning?.use?.coverage ?? null,
        floorArea: result.zoning?.use?.floorArea ?? null,
        fireUnavailable: result.zoning?.fire?.unavailable === true,
        heightUnavailable: result.zoning?.height?.unavailable === true,
      };
    },
    { x: lon, y: lat, name: title },
  );
}

// ============================================================================
// 1. パラメータなし起動の簡易回帰
// ============================================================================

console.log('\n=== パラメータなし起動の簡易回帰 ===');
const defaultViewer = await launchViewer({ viewport: { width: 1440, height: 900 } });
try {
  const { page } = defaultViewer;
  await waitForApp(page, '13114');

  const ui = await page.evaluate(() => ({
    title: document.getElementById('areaTitle')?.textContent,
    checkedBuilding: document.querySelector('input[name="bldg"]:checked')?.value,
    lod2Disabled: document.querySelector('input[name="bldg"][value="lod2"]')?.disabled,
    floodIds: Array.from(document.querySelectorAll('#floodLayers input')).map((el) => el.id),
    tranDisabled: document.getElementById('tran')?.disabled,
    wtrDisabled: document.getElementById('wtr')?.disabled,
    presets: Array.from(document.querySelectorAll('#presetButtons button')).map(
      (button) => button.dataset.preset,
    ),
  }));
  equal('既定タイトルは従来どおり', ui.title, '中野区 3Dビューア');
  equal('既定の建物モデルはLOD2', ui.checkedBuilding, 'lod2');
  check('中野区のLOD2は有効', ui.lod2Disabled === false, JSON.stringify(ui));
  equal(
    '中野区の洪水レイヤーIDは従来どおり2件',
    JSON.stringify(ui.floodIds),
    JSON.stringify(['fldKanda', 'fldArakawa']),
  );
  check('中野区の道路・水部は有効', !ui.tranDisabled && !ui.wtrDisabled, JSON.stringify(ui));
  equal('中野区のスポットは従来どおり6件', ui.presets.length, 6);
  equal('中野駅プリセットIDを維持', ui.presets[0], 'nakanoSta');
  equal('全体俯瞰プリセットIDを維持', ui.presets[5], 'overview');

  const result = await diagnoseAt(
    page,
    139.66893,
    35.707859,
    '中野区中野五丁目（R4回帰）',
  );
  equal('中野五丁目の洪水判定', result.flood, '区域外');
  equal('中野五丁目の用途地域', result.use, '第1種中高層住居専用地域');
  equal('中野五丁目の建蔽率', result.coverage, 60);
  equal('中野五丁目の容積率', result.floorArea, 200);

  const fatal = defaultViewer.errors.filter(
    (error) => error.startsWith('PAGEERROR')
      || /Failed to load module|SyntaxError|is not a function/.test(error),
  );
  check('既定起動に致命的なJSエラーがない', fatal.length === 0, JSON.stringify(fatal));
} finally {
  await defaultViewer.close();
}

// ============================================================================
// 2. 三島市: LOD・レイヤー欠損UIと実データ診断
// ============================================================================

console.log('\n=== 三島市の欠損UI・実データ診断 ===');
const mishimaViewer = await launchViewer({
  viewport: { width: 1440, height: 900 },
  url: BASE_URL + '?city=22206',
});
try {
  const { page } = mishimaViewer;
  await waitForApp(page, '22206');

  const ui = await page.evaluate(() => {
    const labelText = (id) =>
      document.getElementById(id)?.closest('label')?.textContent.replace(/\s+/g, ' ').trim() || '';
    return {
      title: document.getElementById('areaTitle')?.textContent,
      lod2Disabled: document.querySelector('input[name="bldg"][value="lod2"]')?.disabled,
      lod2NoTexDisabled:
        document.querySelector('input[name="bldg"][value="lod2notex"]')?.disabled,
      checkedBuilding: document.querySelector('input[name="bldg"]:checked')?.value,
      tranDisabled: document.getElementById('tran')?.disabled,
      tranText: labelText('tran'),
      wtrDisabled: document.getElementById('wtr')?.disabled,
      wtrText: labelText('wtr'),
      fireDisabled: document.getElementById('ov-fire')?.disabled,
      fireText: labelText('ov-fire'),
      heightDisabled: document.getElementById('ov-height')?.disabled,
      heightText: labelText('ov-height'),
      floodText: document.getElementById('floodLayers')?.textContent.replace(/\s+/g, ' ').trim(),
      floodCount: document.querySelectorAll('#floodLayers input:not(:disabled)').length,
      groundHeight: window.__nakano.areaConfig.groundHeight,
      rect: window.__nakano.areaConfig.rect,
    };
  });
  equal('三島市の動的タイトル', ui.title, '3D街カルテ — 三島市');
  check('三島市のLOD2ラジオはdisabled', ui.lod2Disabled === true, JSON.stringify(ui));
  check(
    '三島市のテクスチャなしLOD2もdisabled',
    ui.lod2NoTexDisabled === true,
    JSON.stringify(ui),
  );
  equal('三島市はLOD1が選択状態', ui.checkedBuilding, 'lod1');
  check(
    '三島市の道路は未提供表示',
    ui.tranDisabled === true && ui.tranText.includes('このエリアでは提供されていません'),
    ui.tranText,
  );
  check(
    '三島市の水部は未提供表示',
    ui.wtrDisabled === true && ui.wtrText.includes('このエリアでは提供されていません'),
    ui.wtrText,
  );
  check(
    '三島市の防火レイヤーは未提供表示',
    ui.fireDisabled === true && ui.fireText.includes('このエリアでは提供されていません'),
    ui.fireText,
  );
  check(
    '三島市の高度地区レイヤーは未提供表示',
    ui.heightDisabled === true && ui.heightText.includes('このエリアでは提供されていません'),
    ui.heightText,
  );
  equal('三島市の洪水レイヤーは1件', ui.floodCount, 1);
  check('三島市の洪水レイヤーは狩野川水系', ui.floodText.includes('狩野川水系'), ui.floodText);
  near('三島市のregion最小高を地盤高に採用', ui.groundHeight, 51.4, 0.2);
  check(
    '三島市のregion矩形が取得される',
    ui.rect
      && ui.rect.west < 138.912567 && ui.rect.east > 138.9291
      && ui.rect.south < 35.0946 && ui.rect.north > 35.124771,
    JSON.stringify(ui.rect),
  );

  const ichibancho = await diagnoseAt(
    page,
    138.912567,
    35.124771,
    '三島市一番町（三島駅南）',
  );
  equal('一番町の洪水判定', ichibancho.flood, '区域外');
  equal('一番町の用途地域', ichibancho.use, '近隣商業地域');
  equal('一番町の建蔽率', ichibancho.coverage, 80);
  equal('一番町の容積率', ichibancho.floorArea, 200);
  check('一番町の防火地域は未提供', ichibancho.fireUnavailable, JSON.stringify(ichibancho));
  check('一番町の高度地区は未提供', ichibancho.heightUnavailable, JSON.stringify(ichibancho));

  const zoningText = (await page.textContent('#secZoning')).replace(/\s+/g, ' ').trim();
  check(
    '診断カードに防火・高度地区の未提供表示',
    /防火地域\s*このエリアでは提供されていません/.test(zoningText)
      && /高度地区\s*このエリアでは提供されていません/.test(zoningText),
    zoningText,
  );

  const daibagawa = await diagnoseAt(
    page,
    138.9291,
    35.0946,
    '三島市大場川沿い',
  );
  equal('大場川沿いの洪水判定', daibagawa.flood, '0.5〜3.0m');
  const floodText = (await page.textContent('#secFlood')).replace(/\s+/g, ' ').trim();
  check(
    '洪水注記に未公表河川の注意を表示',
    floodText.includes('浸水想定が公表されていない河川は表示されません'),
    floodText,
  );

  const fatal = mishimaViewer.errors.filter(
    (error) => error.startsWith('PAGEERROR')
      || /Failed to load module|SyntaxError|is not a function/.test(error),
  );
  check('三島市起動に致命的なJSエラーがない', fatal.length === 0, JSON.stringify(fatal));
  console.log('中継: ' + JSON.stringify(mishimaViewer.relay));
} finally {
  await mishimaViewer.close();
}

report('e2e-r4.test.mjs');
