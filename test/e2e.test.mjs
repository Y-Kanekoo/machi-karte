// 街カルテ（地点診断）のブラウザ統合テスト
// 実行: node test/e2e.test.mjs （事前に python3 -m http.server 8123 が必要）
//
// 期待値は 2026-07-27 に test/data-expectations.mjs / test/output/probe.mjs で
// 実タイルから確定した実測値（test/hazard.test.mjs と同じ）。

import { launchViewer, waitForViewerReady, check, equal, report, shotPath } from './harness.mjs';

const t = await launchViewer({ viewport: { width: 1440, height: 900 } });
const { page } = t;

/** 指定セクションの取得中スピナーが消えるのを待ってテキストを返す */
async function waitSection(id, timeout = 90000) {
  await page.waitForFunction(
    (sid) => {
      const el = document.getElementById(sid);
      return !!el && !el.querySelector('.spinner');
    },
    id,
    { timeout }
  );
  return (await page.textContent('#' + id)).replace(/\s+/g, ' ').trim();
}

async function diagnoseByAddress(q) {
  await page.fill('#searchInput', q);
  await page.click('#searchBtn');
  await page.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 60000 });
}

try {
  await waitForViewerReady(page);

  // ==== 1. 検索UIの存在 ====
  check('検索ボックスがある', await page.isVisible('#searchInput'));
  check('診断モードトグルがある', await page.isVisible('#diagMode'));
  check('診断カードは初期状態で非表示', await page.isHidden('#diagnosisPanel'));

  // ==== 2. 該当なしのメッセージ ====
  await page.fill('#searchInput', 'ｚｚｚ存在しない住所ｚｚｚ');
  await page.click('#searchBtn');
  await page.waitForFunction(
    () => document.getElementById('searchMsg')?.textContent.includes('見つかりません'),
    null, { timeout: 40000 }
  );
  check('該当なしで「見つかりませんでした」を表示', true);

  // ==== 3. 中野五丁目（台地側・区域外・第1種中高層住居専用地域） ====
  console.log('\n--- 中野区中野五丁目 ---');
  const beforeLon = await page.evaluate(() => window.__nakano.viewer.camera.positionCartographic.longitude);
  await diagnoseByAddress('中野区中野五丁目');

  const place5 = await waitSection('secPlace');
  console.log('  📍 ' + place5);
  check('地点セクションに住所が入る', place5.includes('中野五丁目'), place5);
  check('地点セクションに経緯度が入る', /139\.66/.test(place5) && /35\.70/.test(place5), place5);

  await page.waitForTimeout(3500);
  const afterLon = await page.evaluate(() => window.__nakano.viewer.camera.positionCartographic.longitude);
  check('検索でカメラが移動する', Math.abs(afterLon - beforeLon) > 1e-6, `${beforeLon} -> ${afterLon}`);

  const pinCount = await page.evaluate(() => window.__nakano.viewer.entities.values.length);
  check('ピンが1つ立つ', pinCount === 1, `entities=${pinCount}`);

  const flood5 = await waitSection('secFlood');
  console.log('  🌊 ' + flood5);
  check('中野五丁目の洪水判定が「区域外」', flood5.includes('区域外'), flood5);

  const land5 = await waitSection('secLandslide');
  console.log('  ⛰️ ' + land5);
  check('土砂: 土石流の行がある', land5.includes('土石流'), land5);
  check('土砂: 急傾斜地の行がある', land5.includes('急傾斜地'), land5);
  check('土砂: 地すべりの行がある', land5.includes('地すべり'), land5);
  check('中野五丁目は3種とも区域外', (land5.match(/区域外/g) || []).length >= 3, land5);

  const zone5 = await waitSection('secZoning');
  console.log('  🏘️ ' + zone5);
  check('中野五丁目の用途地域が第1種中高層住居専用地域',
    zone5.includes('第1種中高層住居専用地域'), zone5);
  check('建蔽率60%が表示される', zone5.includes('建蔽率 60%'), zone5);
  check('容積率200%が表示される', zone5.includes('容積率 200%'), zone5);
  check('防火地域が準防火地域', zone5.includes('準防火地域'), zone5);
  check('高度地区が表示される', zone5.includes('高度地区'), zone5);

  const sun5 = await waitSection('secSun', 180000);
  console.log('  ☀️ ' + sun5.slice(0, 200));
  check('日照に冬至が表示される', sun5.includes('冬至'), sun5.slice(0, 120));
  check('日照に春分が表示される', sun5.includes('春分'), sun5.slice(0, 120));
  check('日照に夏至が表示される', sun5.includes('夏至'), sun5.slice(0, 120));
  check('簡易計算の注記がある', sun5.includes('簡易計算'), sun5.slice(0, 200));

  const sunData = await page.evaluate(() => {
    const r = window.__nakano.diagnosis.getLastResult();
    return {
      days: r?.sunlight?.days?.map((d) => ({ label: d.label, hours: d.hours, slots: d.slots.length })),
      error: r?.sunlight?.error,
      raysCast: r?.sunlight?.raysCast,
      pickErrors: r?.sunlight?.pickErrors,
      baseHeight: r?.baseHeight,
    };
  });
  console.log('  日照データ: ' + JSON.stringify(sunData));
  check('日照が3日付分ある', sunData.days?.length === 3, JSON.stringify(sunData.days));
  check('全日付で日照時間が0hより大きい',
    sunData.days?.every((d) => d.hours > 0), JSON.stringify(sunData.days));
  check('夏至の日照時間 >= 冬至の日照時間',
    sunData.days?.find((d) => d.label === '夏至').hours >= sunData.days.find((d) => d.label === '冬至').hours,
    JSON.stringify(sunData.days));
  check('レイキャストが実行されている', sunData.raysCast > 50, `rays=${sunData.raysCast}`);
  check('日照計算がエラーになっていない', !sunData.error, String(sunData.error));

  const bars = await page.evaluate(() => ({
    days: document.querySelectorAll('#secSun .sun-day').length,
    cells: document.querySelectorAll('#secSun .sun-bar i').length,
    lit: document.querySelectorAll('#secSun .sun-bar i.lit').length,
  }));
  check('タイムラインが3本描画される', bars.days === 3, JSON.stringify(bars));
  check('タイムラインのセルが93個（31×3）', bars.cells === 93, JSON.stringify(bars));
  check('日照セルが1つ以上ある', bars.lit > 0, JSON.stringify(bars));

  check('出典表記がある', (await page.textContent('.diag-source')).includes('ハザードマップポータル'));

  await page.screenshot({ path: shotPath('01-diagnosis-nakano5.png') });
  await page.locator('#diagnosisPanel').screenshot({ path: shotPath('02-card-nakano5.png') });

  // ==== 4. 弥生町二丁目（洪水判定あり・近隣商業地域） ====
  console.log('\n--- 中野区弥生町2丁目（洪水判定あり） ---');
  await diagnoseByAddress('中野区弥生町2丁目');
  const placeY = await waitSection('secPlace');
  console.log('  📍 ' + placeY);
  check('弥生町の住所が表示される', placeY.includes('弥生町'), placeY);

  const floodY = await waitSection('secFlood');
  console.log('  🌊 ' + floodY);
  check('弥生町の洪水判定が「0.5m未満」', floodY.includes('0.5m未満'), floodY);
  check('弥生町は区域外ではない', !floodY.includes('区域外'), floodY);

  const zoneY = await waitSection('secZoning');
  console.log('  🏘️ ' + zoneY);
  check('弥生町の用途地域が近隣商業地域', zoneY.includes('近隣商業地域'), zoneY);
  check('弥生町の建蔽率80%', zoneY.includes('建蔽率 80%'), zoneY);
  check('弥生町の容積率400%', zoneY.includes('容積率 400%'), zoneY);

  await waitSection('secSun', 180000);
  await page.screenshot({ path: shotPath('03-flood-yayoicho.png') });
  await page.locator('#diagnosisPanel').screenshot({ path: shotPath('04-card-yayoicho.png') });

  // ==== 5. クリック診断モード ====
  console.log('\n--- クリック診断モード ---');
  await page.evaluate(() => window.__nakano.diagnosis.close());
  check('閉じるとカードが隠れる', await page.isHidden('#diagnosisPanel'));
  const pinsAfterClose = await page.evaluate(() => window.__nakano.viewer.entities.values.length);
  check('閉じるとピンも消える', pinsAfterClose === 0, `entities=${pinsAfterClose}`);

  await page.check('#diagMode');
  check('診断モードONでbodyにクラスが付く',
    await page.evaluate(() => document.body.classList.contains('diag-mode')));

  const box = await page.locator('.cesium-widget canvas').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 100);
  await page.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 30000 });
  const clickFlood = await waitSection('secFlood');
  const clickZone = await waitSection('secZoning');
  console.log('  クリック診断 🌊 ' + clickFlood + ' / 🏘️ ' + clickZone.slice(0, 60));
  check('クリック診断で洪水判定が出る', clickFlood.length > 0 && !clickFlood.includes('取得中'), clickFlood);
  check('クリック診断で都市計画が出る', clickZone.length > 0 && !clickZone.includes('取得中'), clickZone.slice(0, 80));
  await page.uncheck('#diagMode');

  // ==== 6. 建物クリック → 建物セクション付き診断 ====
  console.log('\n--- 建物クリック診断 ---');
  await page.evaluate(() => window.__nakano.diagnosis.close());
  await page.click('button[data-preset="nakanoSta"]');
  await page.waitForTimeout(7000);
  let bldgRows = 0;
  for (const [dx, dy] of [[0, 60], [-80, 80], [80, 40], [0, 130], [-160, 20], [160, 110], [-40, 160]]) {
    await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
    await page.waitForTimeout(1200);
    bldgRows = await page.evaluate(() => {
      const p = document.getElementById('diagnosisPanel');
      if (p.classList.contains('hidden')) return 0;
      return document.querySelectorAll('#secBuilding tr').length;
    });
    if (bldgRows > 3) break;
  }
  check('建物クリックで建物属性セクションが出る', bldgRows > 3, `rows=${bldgRows}`);
  const bldgText = await page.textContent('#secBuilding');
  check('建物属性に計測高さが含まれる', /計測高さ|measuredHeight/.test(bldgText), bldgText.slice(0, 120));
  await waitSection('secFlood');
  await waitSection('secZoning');
  await waitSection('secSun', 180000);
  await page.screenshot({ path: shotPath('05-building-diagnosis.png') });
  await page.locator('#diagnosisPanel').screenshot({ path: shotPath('06-card-building.png') });

  // 日照タイムラインだけのクローズアップ
  await page.locator('#secSun').screenshot({ path: shotPath('07-sunlight-timeline.png') });

  // ==== 7. モバイル幅で崩れないこと ====
  console.log('\n--- モバイル幅 ---');
  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForTimeout(1500);
  const mobile = await page.evaluate(() => {
    const panel = document.getElementById('diagnosisPanel').getBoundingClientRect();
    const bar = document.getElementById('searchBar').getBoundingClientRect();
    return {
      w: window.innerWidth,
      panelRight: panel.right, panelLeft: panel.left, panelBottom: panel.bottom,
      barRight: bar.right, barLeft: bar.left,
      scrollW: document.documentElement.scrollWidth,
    };
  });
  console.log('  ' + JSON.stringify(mobile));
  check('モバイル: 診断カードが画面内に収まる',
    mobile.panelLeft >= 0 && mobile.panelRight <= mobile.w + 1, JSON.stringify(mobile));
  check('モバイル: 検索バーが画面内に収まる',
    mobile.barLeft >= 0 && mobile.barRight <= mobile.w + 1, JSON.stringify(mobile));
  check('モバイル: 横スクロールが発生しない', mobile.scrollW <= mobile.w + 1, JSON.stringify(mobile));
  await page.screenshot({ path: shotPath('08-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 900 });

  // ==== 8. JSエラー ====
  const fatal = t.errors.filter(
    (e) => e.startsWith('PAGEERROR') || /Failed to load module|SyntaxError|is not a function/.test(e)
  );
  check('致命的なJSエラーがない', fatal.length === 0, JSON.stringify(fatal.slice(0, 4)));
  if (t.errors.length) console.log('\n(参考) console errors: ' + JSON.stringify(t.errors.slice(0, 6), null, 1));
  console.log('中継: ' + JSON.stringify(t.relay));
} finally {
  await t.close();
}

report('e2e.test.mjs');
