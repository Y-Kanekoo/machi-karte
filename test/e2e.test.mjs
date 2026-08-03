// 街カルテ（地点診断）のブラウザ統合テスト
// 実行: node test/e2e.test.mjs （事前に python3 -m http.server 8123 が必要）
//
// 期待値は 2026-07-27 に test/data-expectations.mjs / test/output/probe.mjs で
// 実タイルから確定した実測値（test/hazard.test.mjs と同じ）。

import { launchViewer, waitForViewerReady, openSection, check, equal, report, shotPath } from './harness.mjs';

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

/**
 * 診断カード内のボタンを押す。
 * SwiftShader環境ではCesiumの再描画で Playwright の actionability（stable）判定が
 * タイムアウトすることがあるため、DOM の click() を直接呼ぶ。
 */
async function clickCardButton(act) {
  // polling を rAF ではなく 500ms のタイマーにする。SwiftShader + Cesium の描画で
  // rAF が詰まると waitForSelector / 既定の waitForFunction がタイムアウトするため。
  await page.waitForFunction(
    (a) => {
      const b = document.querySelector(`#diagBody button[data-act="${a}"]`);
      return !!b && !b.disabled;
    },
    act,
    { timeout: 60000, polling: 500 }
  );
  await page.evaluate(
    (a) => document.querySelector(`#diagBody button[data-act="${a}"]`).click(),
    act
  );
}

/**
 * 左パネルのチェックボックスをDOMから直接切り替える。
 * 避難所レイヤーON＋高高度の俯瞰では Cesium の描画で Playwright の
 * actionability 判定（check/uncheck）がタイムアウトするため。
 */
async function setPanelCheckbox(id, on) {
  await page.evaluate(({ i, v }) => {
    const cb = document.getElementById(i);
    if (cb.checked === v) return;
    cb.checked = v;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  }, { i: id, v: on });
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
  // R2: 区域外なので継続時間は「―」（「データなし」と区別する）／計画規模も区域外
  check('中野五丁目の浸水継続時間が「―」',
    /浸水継続時間\s*―/.test(flood5), flood5);
  check('中野五丁目の計画規模が「区域外」',
    /計画規模の想定\s*区域外/.test(flood5), flood5);
  check('内水未対応の注記とリンクがある',
    flood5.includes('内水') && flood5.includes('中野区ハザードマップ'), flood5);
  check('内水注記のリンク先が中野区の公式ページ',
    (await page.getAttribute('#secFlood a', 'href') || '').includes('city.tokyo-nakano.lg.jp'),
    await page.getAttribute('#secFlood a', 'href'));
  // R2 F2-4: 区域外では浸水深3Dのボタンを押せない
  check('区域外では浸水深3Dボタンが無効',
    await page.getAttribute('#secFlood button[data-act="flooddepth"]', 'disabled') !== null,
    String(await page.getAttribute('#secFlood button[data-act="flooddepth"]', 'disabled')));

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
  // R2でセクションに継続時間・計画規模の行が増えたので、想定最大規模のバッジだけを見る
  const floodBadgeY = (await page.textContent('#secFlood .diag-badge')).trim();
  check('弥生町の想定最大規模バッジは区域外ではない', floodBadgeY !== '区域外', floodBadgeY);

  const zoneY = await waitSection('secZoning');
  console.log('  🏘️ ' + zoneY);
  check('弥生町の用途地域が近隣商業地域', zoneY.includes('近隣商業地域'), zoneY);
  check('弥生町の建蔽率80%', zoneY.includes('建蔽率 80%'), zoneY);
  check('弥生町の容積率400%', zoneY.includes('容積率 400%'), zoneY);

  await waitSection('secSun', 180000);
  await page.screenshot({ path: shotPath('03-flood-yayoicho.png') });
  await page.locator('#diagnosisPanel').screenshot({ path: shotPath('04-card-yayoicho.png') });

  // ==== 4a-2. 弥生町: 浸水想定区域内だが継続時間の配信がない実例（R2） ====
  check('弥生町の浸水継続時間は「データなし」',
    /浸水継続時間\s*データなし/.test(floodY), floodY);
  check('弥生町の計画規模は「区域外」',
    /計画規模の想定\s*区域外/.test(floodY), floodY);
  check('区域内で継続時間が無い場合の説明が出る',
    floodY.includes('継続時間のデータは配信されていません'), floodY);

  const shelterY = await waitSection('secShelter');
  console.log('  🏫 ' + shelterY);
  check('弥生町の最寄り震災時避難所が「第二中学校（約260m）」',
    /震災時\s*第二中学校（約260m）/.test(shelterY), shelterY);
  check('弥生町の最寄り水害時避難所が「中野本郷小学校（約520m）」',
    /水害時\s*中野本郷小学校（約520m）/.test(shelterY), shelterY);
  check('直線距離である旨の注記がある', shelterY.includes('直線距離'), shelterY);
  check('避難所セクションに地図表示ボタンがある',
    await page.locator('#secShelter button[data-act="shelters"]').count() === 1);

  // ==== 4b. 上高田四丁目（土砂災害＝急傾斜地の崩壊 警戒区域） ====
  console.log('\n--- 中野区上高田4丁目（土砂災害警戒区域あり） ---');
  await diagnoseByAddress('中野区上高田4丁目');
  const placeK = await waitSection('secPlace');
  check('上高田の住所が表示される', placeK.includes('上高田'), placeK);
  const landK = await waitSection('secLandslide');
  console.log('  ⛰️ ' + landK);
  check('上高田の急傾斜地が警戒区域（イエロー）',
    /急傾斜地の崩壊\s*警戒区域（イエロー）/.test(landK), landK);
  check('上高田の土石流・地すべりは区域外',
    (landK.match(/区域外/g) || []).length === 2, landK);
  check('警戒区域該当時の注記が出る', landK.includes('警戒区域に該当します'), landK);
  await waitSection('secSun', 180000);
  await page.locator('#diagnosisPanel').screenshot({ path: shotPath('09-card-landslide-kamitakada.png') });

  // ==== 4c. 南台五丁目付近（浸水継続時間・計画規模の本命地点。R2） ====
  //
  // 「中野区南台5丁目」の住所検索は (139.66214, 35.681908) を返し、そこは計画規模が
  // 「0.5m未満」になる。R2計画書 §3.1 の実測地点は神田川寄りの (139.663, 35.688) なので、
  // 公開APIで座標を直接指定して診断する。
  console.log('\n--- 南台五丁目付近（139.663, 35.688） ---');
  await page.evaluate(() =>
    window.__nakano.diagnosis.runDiagnosisAt(139.663, 35.688, {
      title: '南台五丁目付近（神田川沿い）', fly: true,
    })
  );
  await page.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 60000 });
  const floodM = await waitSection('secFlood');
  console.log('  🌊 ' + floodM);
  check('南台の想定最大規模が「0.5〜3.0m」', floodM.includes('0.5〜3.0m'), floodM);
  check('南台の浸水継続時間が「12時間未満」',
    /浸水継続時間\s*12時間未満/.test(floodM), floodM);
  check('南台の計画規模が「0.5〜1.0m」',
    /計画規模の想定\s*0\.5〜1\.0m/.test(floodM), floodM);
  const floodRanks = await page.evaluate(() => {
    const r = window.__nakano.diagnosis.getLastResult();
    return { l2: r?.flood?.rank, keizoku: r?.floodKeizoku?.rank, l1: r?.floodL1?.rank };
  });
  console.log('  結果オブジェクト: ' + JSON.stringify(floodRanks));
  check('lastResultに継続時間が入る', floodRanks.keizoku === '12時間未満', JSON.stringify(floodRanks));
  check('lastResultに計画規模が入る', floodRanks.l1 === '0.5〜1.0m', JSON.stringify(floodRanks));
  const shelterM = await waitSection('secShelter');
  console.log('  🏫 ' + shelterM);
  check('南台の最寄り震災時避難所が「南台小学校（約440m）」',
    /震災時\s*南台小学校（約440m）/.test(shelterM), shelterM);
  await waitSection('secSun', 180000);
  await page.locator('#diagnosisPanel').screenshot({ path: shotPath('r2-01-card-minamidai.png') });

  // ==== 4c-2. 浸水深の3D表示（R2 F2-4） ====
  console.log('\n--- 浸水深の3D表示 ---');
  check('区域内では浸水深3Dボタンが有効',
    await page.getAttribute('#secFlood button[data-act="flooddepth"]', 'disabled') === null);
  check('水面の説明文がカードに出る',
    (await page.textContent('#secFlood')).includes('柱状で示した目安'),
    (await page.textContent('#secFlood')).slice(-160));

  const entitiesBefore = await page.evaluate(() => window.__nakano.viewer.entities.values.length);
  await clickCardButton('flooddepth');
  await page.waitForFunction(
    () => window.__nakano.viewer.entities.values.some((e) => !!e.ellipse),
    null, { timeout: 30000 }
  );
  const viz = await page.evaluate(() => {
    const e = window.__nakano.viewer.entities.values.find((x) => !!x.ellipse);
    const t = Cesium.JulianDate.now();
    return {
      name: e.name,
      radius: e.ellipse.semiMajorAxis.getValue(t),
      height: e.ellipse.height.getValue(t),
      extruded: e.ellipse.extrudedHeight.getValue(t),
      total: window.__nakano.viewer.entities.values.length,
    };
  });
  console.log('  ' + JSON.stringify(viz));
  check('水面Entityが1つ増える', viz.total === entitiesBefore + 1, `${entitiesBefore} -> ${viz.total}`);
  check('水面の半径が150m', Math.abs(viz.radius - 150) < 0.01, String(viz.radius));
  // 南台は「0.5〜3.0m」なので上限3.0m ぶん立ち上がる
  check('水面の厚みが浸水深の上限（3.0m）',
    Math.abs((viz.extruded - viz.height) - 3.0) < 0.01, `${viz.height} -> ${viz.extruded}`);
  check('地面高さが妥当な範囲（中野区は概ね20〜60m）',
    viz.height > 10 && viz.height < 120, String(viz.height));
  const vizBtnOn = await page.textContent('#secFlood button[data-act="flooddepth"]');
  check('ボタン表示が「3D表示を消す」に変わる', vizBtnOn.includes('消す'), vizBtnOn);

  // 建物と水面の高さ関係が見えるよう、低いピッチで寄って撮る
  await page.evaluate(() =>
    window.__nakano.flyTo({ lon: 139.6626, lat: 35.6866, height: 120, heading: 30, pitch: -12 }, 0)
  );
  await page.waitForTimeout(5000);
  await page.screenshot({ path: shotPath('r2-03-flood3d-minamidai.png') });

  // もう一度押すと消える
  await clickCardButton('flooddepth');
  await page.waitForTimeout(500);
  check('もう一度押すと水面が消える',
    await page.evaluate(() => !window.__nakano.viewer.entities.values.some((e) => !!e.ellipse)));

  // カードを閉じても消える（onClose の後始末）
  await clickCardButton('flooddepth');
  await page.waitForFunction(
    () => window.__nakano.viewer.entities.values.some((e) => !!e.ellipse),
    null, { timeout: 30000 }
  );
  await page.evaluate(() => window.__nakano.diagnosis.close());
  const afterClose = await page.evaluate(() => window.__nakano.viewer.entities.values.length);
  check('カードを閉じると水面もピンも消える', afterClose === 0, `entities=${afterClose}`);

  // 続く避難所レイヤーの検証のためカードを開き直す
  await page.evaluate(() =>
    window.__nakano.diagnosis.runDiagnosisAt(139.663, 35.688, {
      title: '南台五丁目付近（神田川沿い）', fly: true, skipSunlight: true,
    })
  );
  await waitSection('secShelter');

  // ==== 4d. 避難所レイヤー（R2） ====
  console.log('\n--- 避難所レイヤー ---');
  await openSection(page, 'hazardSection');
  check('初期状態では避難所レイヤーOFF', !(await page.isChecked('#shelterLayer')));
  check('初期状態では凡例が隠れている', await page.isHidden('#shelterLegend'));

  await setPanelCheckbox('shelterLayer', true);
  await page.waitForFunction(
    () => window.__nakano.shelterLayer.count() > 0, null, { timeout: 60000, polling: 500 }
  );
  const shelterStats = await page.evaluate(() => ({
    count: window.__nakano.shelterLayer.count(),
    visible: window.__nakano.shelterLayer.isVisible(),
    pins: window.__nakano.viewer.entities.values.length,
    types: window.__nakano.shelterLayer.dataSource.entities.values.reduce((a, e) => {
      const t = e.properties.shelterType.getValue();
      a[t] = (a[t] || 0) + 1;
      return a;
    }, {}),
  }));
  console.log('  ' + JSON.stringify(shelterStats));
  check('避難所Entityが90件以上', shelterStats.count >= 90, JSON.stringify(shelterStats));
  check('種別3つに色分けされている',
    Object.keys(shelterStats.types).sort().join(',') === 'flood,quake,wide',
    JSON.stringify(shelterStats.types));
  check('レイヤーが表示状態', shelterStats.visible === true);
  check('診断ピン（viewer.entities）とは別管理', shelterStats.pins <= 1, `pins=${shelterStats.pins}`);
  check('避難所の凡例が出る', await page.isVisible('#shelterLegend'));
  const shelterBtnOn = await page.textContent('#secShelter button[data-act="shelters"]');
  check('カードのボタン表示が「隠す」に変わる', shelterBtnOn.includes('隠す'), shelterBtnOn);

  // カード内のボタンからもトグルできる（左パネルのチェックボックスと双方向）。
  // 俯瞰に飛ぶ前に確かめる（高高度＋102Entityの描画中はPlaywrightのpollingが詰まりやすい）
  await clickCardButton('shelters');
  await page.waitForTimeout(500);
  check('カードのボタンでレイヤーがOFFになる',
    !(await page.isChecked('#shelterLayer')) &&
    !(await page.evaluate(() => window.__nakano.shelterLayer.isVisible())));
  check('OFFで凡例も隠れる', await page.isHidden('#shelterLegend'));
  const shelterBtnOff = await page.textContent('#secShelter button[data-act="shelters"]');
  check('カードのボタン表示が「表示」に戻る', shelterBtnOff.includes('表示'), shelterBtnOff);

  // 俯瞰スクリーンショット用に再度ON（今度は左パネルから）
  await setPanelCheckbox('shelterLayer', true);
  await page.waitForTimeout(500);
  check('左パネルから再度ONにできる',
    await page.evaluate(() => window.__nakano.shelterLayer.isVisible()));
  await page.evaluate(() =>
    window.__nakano.flyTo({ lon: 139.664, lat: 35.708, height: 6000, heading: 0, pitch: -85 }, 0)
  );
  await page.waitForTimeout(4000);
  await page.screenshot({ path: shotPath('r2-02-shelters-overview.png') });

  // 元の視点に戻してからOFFにする（高高度＋102Entityのまま操作すると描画負荷で不安定）
  await page.evaluate(() => window.__nakano.flyTo(
    { lon: 139.6659, lat: 35.7010, height: 500, heading: 0, pitch: -40 }, 0
  ));
  await page.waitForTimeout(2000);
  await setPanelCheckbox('shelterLayer', false);
  await page.waitForTimeout(500);
  check('左パネルからOFFにできる',
    !(await page.evaluate(() => window.__nakano.shelterLayer.isVisible())));
  await page.waitForTimeout(2000);

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
  await openSection(page, 'presetSection');
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
