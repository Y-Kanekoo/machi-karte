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
      shelterDisabled: document.getElementById('shelterLayer')?.disabled,
      shelterText: labelText('shelterLayer'),
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
  check(
    '三島市の避難所レイヤーは未提供表示',
    ui.shelterDisabled === true
      && ui.shelterText.includes('このエリアでは提供されていません'),
    ui.shelterText,
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
  equal(
    '三島市の避難所診断は未提供表示',
    (await page.textContent('#secShelter')).replace(/\s+/g, ' ').trim(),
    'このエリアでは提供されていません',
  );
  const mishimaHistory = await page.evaluate(() => window.__nakano.diagnosis.getHistory());
  equal('診断履歴に三島市cityを保存', mishimaHistory[0]?.city, '22206');

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
  check(
    '三島市の内水注記は自治体汎用文言',
    floodText.includes('お住まいの市区町村の公式ハザードマップをご確認ください')
      && !floodText.includes('中野区ハザードマップ'),
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

// ============================================================================
// 3. 渋谷区: 建物・実データ診断・共有URL復元
// ============================================================================

console.log('\n=== 渋谷区の建物・実データ診断・共有URL復元 ===');
const shibuyaViewer = await launchViewer({
  viewport: { width: 1440, height: 900 },
  url: BASE_URL + '?city=13113',
});
try {
  const { page } = shibuyaViewer;
  await waitForApp(page, '13113');
  await page.waitForFunction(
    () => window.__nakano?.loaded?.bldgLod2?.tilesLoaded === true,
    null,
    { timeout: 180000, polling: 500 },
  );

  const initial = await page.evaluate(() => ({
    search: location.search,
    hash: location.hash,
    pageTitle: document.title,
    headerTitle: document.getElementById('areaTitle')?.getAttribute('aria-label'),
    currentArea: document.getElementById('areaCurrentName')?.textContent,
    buildingShown: window.__nakano.loaded.bldgLod2?.show === true,
  }));
  equal('渋谷区クエリはURLから除去される', initial.search, '');
  check(
    '渋谷区クエリはcity付きハッシュへ正規化される',
    initial.hash.startsWith('#v=1&city=13113'),
    initial.hash,
  );
  equal('渋谷区のページタイトル', initial.pageTitle, '3D街カルテ — 渋谷区');
  equal('渋谷区のヘッダ表記', initial.headerTitle, '3D街カルテ — 渋谷区');
  equal('エリア選択UIの現在地は渋谷区', initial.currentArea, '渋谷区');
  check('渋谷区のLOD2建物が表示される', initial.buildingShown, JSON.stringify(initial));

  const hachiko = await diagnoseAt(
    page,
    139.7006,
    35.6595,
    '渋谷駅ハチ公前付近',
  );
  equal('ハチ公前付近の洪水判定', hachiko.flood, '0.5〜3.0m');
  equal('ハチ公前付近の用途地域', hachiko.use, '商業地域');
  equal('ハチ公前付近の建蔽率', hachiko.coverage, 80);
  equal('ハチ公前付近の容積率', hachiko.floorArea, 1000);

  await page.evaluate(() => {
    window.__nakano.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(139.7006, 35.6595, 600),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-50),
        roll: 0,
      },
    });
  });
  await page.click('#shareBtn');
  const shareHash = await page.evaluate(() => location.hash);
  check(
    '渋谷区の共有URLはcityの後にspotを持つ',
    /^#v=1&city=13113&spot=139\.7006,35\.6595(?:&|$)/.test(shareHash),
    shareHash,
  );
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  const shareUrl = String(clip).startsWith('http') ? String(clip) : BASE_URL + shareHash;

  const restoredPage = await shibuyaViewer.newPage(shareUrl);
  await waitForApp(restoredPage, '13113');
  await restoredPage.waitForFunction(
    () => window.__nakano?.getRestored?.() instanceof Promise,
    null,
    { timeout: 180000, polling: 500 },
  );
  await restoredPage.evaluate(() => window.__nakano.getRestored());
  await restoredPage.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 120000 });
  const restored = await restoredPage.evaluate(() => {
    const carto = window.__nakano.viewer.camera.positionCartographic;
    const result = window.__nakano.diagnosis.getLastResult();
    return {
      city: window.__nakano.areaConfig.code,
      lon: result?.lon,
      lat: result?.lat,
      flood: result?.flood?.rank,
      use: result?.zoning?.use?.name,
      coverage: result?.zoning?.use?.coverage,
      floorArea: result?.zoning?.use?.floorArea,
      cameraLon: Cesium.Math.toDegrees(carto.longitude),
      cameraLat: Cesium.Math.toDegrees(carto.latitude),
    };
  });
  equal('共有URL復元後も渋谷区', restored.city, '13113');
  near('共有URLからハチ公前の経度を復元', restored.lon, 139.7006, 1e-6);
  near('共有URLからハチ公前の緯度を復元', restored.lat, 35.6595, 1e-6);
  equal('共有URL復元後の洪水判定', restored.flood, '0.5〜3.0m');
  equal('共有URL復元後の用途地域', restored.use, '商業地域');
  equal('共有URL復元後の建蔽率', restored.coverage, 80);
  equal('共有URL復元後の容積率', restored.floorArea, 1000);
  near('共有URL復元後のカメラ経度', restored.cameraLon, 139.7006, 1e-4);
  near('共有URL復元後のカメラ緯度', restored.cameraLat, 35.6595, 1e-4);
  await restoredPage.close();

  const fatal = shibuyaViewer.errors.filter(
    (error) => error.startsWith('PAGEERROR')
      || /Failed to load module|SyntaxError|is not a function/.test(error),
  );
  check('渋谷区の共有復元に致命的なJSエラーがない', fatal.length === 0, JSON.stringify(fatal));
} finally {
  await shibuyaViewer.close();
}

// ============================================================================
// 4. エリアセレクタ: 中野区から渋谷区へreload切替
// ============================================================================

console.log('\n=== エリアセレクタのreload切替 ===');
const selectorViewer = await launchViewer({ viewport: { width: 1440, height: 900 } });
try {
  const { page } = selectorViewer;
  await waitForApp(page, '13114');
  equal(
    '都道府県セレクタは東京都を選択',
    await page.inputValue('#areaPrefSelect'),
    '東京都',
  );
  equal(
    '自治体セレクタは中野区を選択',
    await page.inputValue('#areaCitySelect'),
    '13114',
  );

  await page.selectOption('#areaCitySelect', '13113');
  await waitForApp(page, '13113');
  await page.waitForFunction(
    () => window.__nakano?.loaded?.bldgLod2?.tilesLoaded === true,
    null,
    { timeout: 180000, polling: 500 },
  );
  const switched = await page.evaluate(() => ({
    hash: location.hash,
    pageTitle: document.title,
    headerTitle: document.getElementById('areaTitle')?.getAttribute('aria-label'),
    currentArea: document.getElementById('areaCurrentName')?.textContent,
    selectedCity: document.getElementById('areaCitySelect')?.value,
    navigationType: performance.getEntriesByType('navigation')[0]?.type,
    buildingShown: window.__nakano.loaded.bldgLod2?.show === true,
  }));
  equal('エリア切替後のhash', switched.hash, '#v=1&city=13113');
  equal('エリア切替後のページタイトル', switched.pageTitle, '3D街カルテ — 渋谷区');
  equal('エリア切替後のヘッダ表記', switched.headerTitle, '3D街カルテ — 渋谷区');
  equal('エリア切替後の現在地表示', switched.currentArea, '渋谷区');
  equal('エリア切替後の自治体選択値', switched.selectedCity, '13113');
  equal('エリア切替はreloadで行われる', switched.navigationType, 'reload');
  check('reload後に渋谷区の建物が表示される', switched.buildingShown, JSON.stringify(switched));
} finally {
  await selectorViewer.close();
}

// ============================================================================
// 5. 不正な自治体コードのフォールバック
// ============================================================================

console.log('\n=== 不正な自治体コードのフォールバック ===');
const invalidViewer = await launchViewer({
  viewport: { width: 1440, height: 900 },
  url: BASE_URL + '?city=99999',
});
try {
  const { page } = invalidViewer;
  const toastPromise = page
    .waitForFunction(
      () => {
        const el = document.getElementById('toast');
        return el && !el.classList.contains('hidden') ? el.textContent : null;
      },
      null,
      { timeout: 10000, polling: 30 },
    )
    .then((handle) => handle.jsonValue());
  await waitForApp(page, '13114');
  const toastText = await toastPromise;
  equal(
    '不正コードの理由付きトースト',
    toastText,
    '未対応のエリア指定のため中野区を表示しています',
  );
  const invalid = await page.evaluate(() => ({
    search: location.search,
    hash: location.hash,
    city: window.__nakano.areaConfig.code,
    pageTitle: document.title,
    headerTitle: document.getElementById('areaTitle')?.getAttribute('aria-label'),
  }));
  equal('不正コードは中野区へフォールバック', invalid.city, '13114');
  equal('不正コードのクエリはURLから除去される', invalid.search, '');
  equal('フォールバック後のhash', invalid.hash, '#v=1&city=13114');
  equal('フォールバック後のページタイトル', invalid.pageTitle, '3D街カルテ — 中野区');
  equal('フォールバック後のヘッダ表記', invalid.headerTitle, '3D街カルテ — 中野区');
} finally {
  await invalidViewer.close();
}

// ============================================================================
// 6. cityなしR1形式ハッシュの後方互換
// ============================================================================

console.log('\n=== cityなしR1形式ハッシュの後方互換 ===');
const legacyHash = '#v=1&spot=139.673935,35.691502'
  + '&addr=' + encodeURIComponent('東京都中野区弥生町二丁目')
  + '&cam=139.674,35.6905,720,45,-55';
const legacyViewer = await launchViewer({
  viewport: { width: 1440, height: 900 },
  url: BASE_URL + legacyHash,
});
try {
  const { page } = legacyViewer;
  await waitForApp(page, '13114');
  await page.waitForFunction(
    () => window.__nakano?.getRestored?.() instanceof Promise,
    null,
    { timeout: 180000, polling: 500 },
  );
  await page.evaluate(() => window.__nakano.getRestored());
  await page.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 120000 });
  const legacy = await page.evaluate(() => {
    const result = window.__nakano.diagnosis.getLastResult();
    return {
      city: window.__nakano.areaConfig.code,
      hash: location.hash,
      title: result?.title,
      lon: result?.lon,
      lat: result?.lat,
    };
  });
  equal('city省略時は中野区として復元', legacy.city, '13114');
  check('R1形式ハッシュへcityを暗黙追記しない', !legacy.hash.includes('city='), legacy.hash);
  check('R1形式の住所を復元', legacy.title?.includes('弥生町二丁目'), legacy.title);
  near('R1形式の経度を復元', legacy.lon, 139.673935, 1e-6);
  near('R1形式の緯度を復元', legacy.lat, 35.691502, 1e-6);
} finally {
  await legacyViewer.close();
}

// ============================================================================
// 7. cityなし比較URLの後方互換
// ============================================================================

console.log('\n=== cityなし比較URLの後方互換 ===');
const legacyCompareViewer = await launchViewer({
  viewport: { width: 1440, height: 900 },
  url: BASE_URL + '#v=1&compare=139.673935,35.691502;139.66893,35.707859',
});
try {
  const { page } = legacyCompareViewer;
  await waitForApp(page, '13114');
  await page.waitForFunction(
    () => window.__nakano?.getRestored?.() instanceof Promise,
    null,
    { timeout: 180000, polling: 500 },
  );
  await page.evaluate(() => window.__nakano.getRestored());
  await page.waitForFunction(
    () => window.__nakano?.compare?.getItems?.().length === 2,
    null,
    { timeout: 120000, polling: 500 },
  );
  const legacyCompare = await page.evaluate(() => ({
    city: window.__nakano.areaConfig.code,
    itemCities: window.__nakano.compare.getItems().map((item) => item.city),
    open: window.__nakano.compare.isOpen(),
  }));
  equal('cityなし比較URLは中野区で起動', legacyCompare.city, '13114');
  equal(
    'cityなし比較地点はすべて13114として復元',
    JSON.stringify(legacyCompare.itemCities),
    JSON.stringify(['13114', '13114']),
  );
  check('旧比較URLの比較モーダルを開く', legacyCompare.open, JSON.stringify(legacyCompare));
} finally {
  await legacyCompareViewer.close();
}

report('e2e-r4.test.mjs');
