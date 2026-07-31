// R3（日照・日影の本格化）のブラウザ統合テスト
// 実行: node test/e2e-r3.test.mjs （事前に `npm run serve` が必要）
//
// 既存の test/e2e.test.mjs は無改変のまま、R3で追加・変更した振る舞いだけをここで検証する。
// P1時点の対象は F3-3（プリロード置換）の先行2項目:
//   1. 住所検索の診断でカメラが上空400m（従来の prepareTiles）へ強制テレポートしないこと
//   2. 置き換え後も日照の既存アサーション群（3日付・93セル・raysCast>50・エラーなし）が成立すること
// P2でF3-1（視点高さセレクタ＝階数指定日照）の項目を追加した。F3-2（日影マップ）はP4以降。
//
// 実装方針（R3計画書「P0後の設計確定」#11）:
//   canvas 上のマウス操作は使わない。Cesium のエラーパネルがポインタイベントを奪って
//   page.click が30秒タイムアウトする事象があるため、DOM直叩きと window.__nakano フックで操作する。
//   建物クリック相当は viewer.scene.pick でフィーチャを拾い、diagnosis.diagnose({picked}) に渡す
//   （P1実装記録の方法。window.__nakano.viewer / window.__nakano.diagnosis は main.js が既に公開済み
//   なので、日照の観測値は diagnosis.getSunlightTestState() から読み取る）。

import { launchViewer, waitForViewerReady, check, report, shotPath } from './harness.mjs';

/** 従来 prepareTiles のテレポート先（この姿勢が観測されたら回帰） */
const TELEPORT_HEIGHT = 400;
const TELEPORT_PITCH_DEG = -60;
/** diagnose.js の flyToPoint の目的地 */
const FLYTO_HEIGHT = 600;
const FLYTO_PITCH_DEG = -50;

const t = await launchViewer({ viewport: { width: 1440, height: 900 } });
const { page } = t;

/** 指定セクションの取得中スピナーが消えるのを待ってテキストを返す */
async function waitSection(id, timeout = 180000) {
  await page.waitForFunction(
    (sid) => {
      const el = document.getElementById(sid);
      return !!el && !el.querySelector('.spinner');
    },
    id,
    { timeout, polling: 500 }
  );
  return (await page.textContent('#' + id)).replace(/\s+/g, ' ').trim();
}

try {
  await waitForViewerReady(page);
  // 起動時の flyTo（中野駅プリセット・3秒）が終わってから計測を始める
  await page.waitForTimeout(8000);

  // ==== 1. F3-3: 診断でカメラが強制テレポートしないこと ====
  console.log('\n--- F3-3: プリロードのカメラ非テレポート ---');

  // カメラの姿勢を200ms間隔でサンプリングする（rAFではなくタイマー。SwiftShaderでも詰まらない）
  await page.evaluate(() => {
    const cam = window.__nakano.viewer.camera;
    window.__r3cam = { samples: [], timer: null };
    window.__r3cam.timer = setInterval(() => {
      const c = cam.positionCartographic;
      window.__r3cam.samples.push({
        lon: Cesium.Math.toDegrees(c.longitude),
        lat: Cesium.Math.toDegrees(c.latitude),
        height: c.height,
        pitchDeg: Cesium.Math.toDegrees(cam.pitch),
      });
    }, 200);
  });

  const before = await page.evaluate(() => {
    const c = window.__nakano.viewer.camera.positionCartographic;
    return { lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude), height: c.height };
  });
  console.log('  診断前のカメラ: ' + JSON.stringify(before));

  // 住所検索から診断（DOM直叩き。await すると診断完了まで戻らないので投げっぱなしにする）
  await page.evaluate(() => {
    window.__nakano.diagnosis.searchAndDiagnose('中野区中野五丁目')
      .catch((e) => console.warn('searchAndDiagnose failed', e));
  });
  await page.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 60000 });
  const sunText = await waitSection('secSun', 180000);
  console.log('  ☀️ ' + sunText.slice(0, 180));

  const cam = await page.evaluate(() => {
    clearInterval(window.__r3cam.timer);
    const s = window.__r3cam.samples;
    return { samples: s, count: s.length, last: s[s.length - 1] };
  });
  console.log(`  カメラサンプル ${cam.count}件、最終 ` + JSON.stringify(cam.last));

  const teleported = cam.samples.filter(
    (s) => Math.abs(s.height - TELEPORT_HEIGHT) < 25 && Math.abs(s.pitchDeg - TELEPORT_PITCH_DEG) < 3
  );
  check('診断中にカメラが上空400m・pitch−60°へテレポートしない',
    teleported.length === 0, JSON.stringify(teleported.slice(0, 3)));
  // SwiftShaderでは日照計算中にメインスレッドが埋まりタイマーが大きく間引かれる
  // （実測19件/40秒）。テレポートしていれば計算中ずっと400mに留まるので粗い間隔でも検出できる。
  check('カメラサンプルが取れている', cam.count >= 10, `count=${cam.count}`);
  check('診断後のカメラがflyToの目的地（高度600m）にとどまる',
    Math.abs(cam.last.height - FLYTO_HEIGHT) < 60, String(cam.last.height));
  check('診断後のカメラのピッチがflyToの−50°のまま',
    Math.abs(cam.last.pitchDeg - FLYTO_PITCH_DEG) < 3, String(cam.last.pitchDeg));
  check('カメラは検索地点へは移動している',
    Math.abs(cam.last.lon - before.lon) > 1e-6 || Math.abs(cam.last.lat - before.lat) > 1e-6,
    JSON.stringify({ before, last: cam.last }));

  const preload = await page.evaluate(
    () => window.__nakano.diagnosis.getLastResult()?.sunlight?.preload || null
  );
  console.log('  先読み: ' + JSON.stringify(preload));
  check('先読みが太陽経路ウォームアップで行われる',
    preload?.method === 'warmUpSunPath', JSON.stringify(preload));
  check('ウォームアップのレイが解決している',
    preload?.warmUp?.resolved > 0, JSON.stringify(preload?.warmUp));
  check('ウォームアップのレイ本数が8〜12本',
    preload?.warmUp?.rays >= 8 && preload?.warmUp?.rays <= 12, String(preload?.warmUp?.rays));
  check('ウォームアップがタイムアウトしていない', preload?.warmUp?.timedOut === false,
    JSON.stringify(preload?.warmUp));
  // P1.1: 計画本数(rays)と実際に発射した本数(attempted)を別々に記録する
  check('発射した本数が計画本数と一致する',
    preload?.warmUp?.attempted === preload?.warmUp?.rays,
    JSON.stringify({ attempted: preload?.warmUp?.attempted, rays: preload?.warmUp?.rays }));
  check('ウォームアップがキャンセルされていない', preload?.warmUp?.cancelled === false,
    JSON.stringify(preload?.warmUp));
  check('先読みがキャンセル扱いになっていない', preload?.cancelled === false, JSON.stringify(preload));
  check('先読みが成功扱いになっている', preload?.ok === true, JSON.stringify(preload));
  check('先読みのフォールバック注記が出ていない',
    !sunText.includes('フォールバック') && !sunText.includes('先読みができなかった'),
    sunText.slice(-160));

  // ==== 2. 置き換え後も日照の既存アサーションが成立すること ====
  console.log('\n--- F3-3: 日照結果の維持 ---');
  const sun = await page.evaluate(() => {
    const r = window.__nakano.diagnosis.getLastResult();
    const s = r?.sunlight;
    return {
      days: s?.days?.map((d) => ({ label: d.label, hours: d.hours, slots: d.slots.length })),
      error: s?.error,
      raysCast: s?.raysCast,
      pickErrors: s?.pickErrors,
      pickSupported: s?.pickSupported,
      excludedFeatures: s?.excludedFeatures,
      cancelled: s?.cancelled,
      originHeight: s?.originHeight,
      msPerRayMean: s?.msPerRayMean,
      msPerRayMedian: s?.msPerRayMedian,
      baseHeight: r?.baseHeight,
      dom: {
        days: document.querySelectorAll('#secSun .sun-day').length,
        cells: document.querySelectorAll('#secSun .sun-bar i').length,
        lit: document.querySelectorAll('#secSun .sun-bar i.lit').length,
      },
    };
  });
  console.log('  日照データ: ' + JSON.stringify(sun));

  check('日照が3日付分ある', sun.days?.length === 3, JSON.stringify(sun.days));
  check('レイキャストが50本より多い', sun.raysCast > 50, `rays=${sun.raysCast}`);
  // P1.1: 同期 pickFromRay の機能検出（非対応環境では日本語の理由を出して計算しない）
  check('同期pickFromRayが利用できると判定される', sun.pickSupported === true, String(sun.pickSupported));
  check('pickエラーが多発していない', sun.pickErrors <= sun.raysCast * 0.5,
    `errors=${sun.pickErrors} / rays=${sun.raysCast}`);
  check('既定では自建物の除外をしない', sun.excludedFeatures === 0, String(sun.excludedFeatures));
  check('日照計算がエラーになっていない', !sun.error, String(sun.error));
  check('日照計算がキャンセルされていない', sun.cancelled === false, String(sun.cancelled));
  check('全日付で日照時間が0hより大きい',
    sun.days?.every((d) => d.hours > 0), JSON.stringify(sun.days));
  check('夏至の日照時間 >= 冬至の日照時間',
    sun.days?.find((d) => d.label === '夏至').hours >= sun.days.find((d) => d.label === '冬至').hours,
    JSON.stringify(sun.days));
  check('タイムラインが3本描画される', sun.dom.days === 3, JSON.stringify(sun.dom));
  check('タイムラインのセルが93個（31×3）', sun.dom.cells === 93, JSON.stringify(sun.dom));
  check('日照セルが1つ以上ある', sun.dom.lit > 0, JSON.stringify(sun.dom));
  check('既定のレイ原点は地面+1.2m',
    Math.abs(sun.originHeight - (sun.baseHeight.height + 1.2)) < 1e-6,
    `${sun.originHeight} vs ${sun.baseHeight?.height}`);
  check('1本あたりの所要（平均）が計測される',
    Number.isFinite(sun.msPerRayMean) && sun.msPerRayMean > 0, String(sun.msPerRayMean));
  check('1本あたりの所要（中央値）が計測される',
    Number.isFinite(sun.msPerRayMedian) && sun.msPerRayMedian > 0, String(sun.msPerRayMedian));
  check('既定表示の注記文言（簡易計算）が変わっていない',
    sunText.includes('簡易計算'), sunText.slice(-200));

  await page.locator('#diagnosisPanel').screenshot({ path: shotPath('r3-01-card-nakano5.png') });

  // ==== 3. F3-1: 建物クリックで視点高さセレクタに「屋上」が出る・1階と屋上の日照差 ====
  console.log('\n--- F3-1: 建物クリックの視点高さセレクタ ---');

  // 建物が並ぶ駅前へ。マウス操作はせず scene.pick + diagnosis.diagnose({picked}) で
  // 「建物クリック相当」を再現する（P0実装記録: page.click はエラーパネルにポインタを奪われ得る）。
  await page.evaluate(() =>
    window.__nakano.flyTo({ lon: 139.6659, lat: 35.7010, height: 500, heading: 0, pitch: -40 }, 0)
  );
  await page.waitForTimeout(6000);

  // 画面内をグリッド走査し、_zmin/_zmax を持つ建物フィーチャ（＝屋上が出せる建物）を拾う。
  const pickInfo = await page.evaluate(() => {
    const scene = window.__nakano.viewer.scene;
    const canvas = scene.canvas;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    for (let fy = 0.28; fy <= 0.88; fy += 0.04) {
      for (let fx = 0.12; fx <= 0.88; fx += 0.04) {
        const x = Math.round(W * fx), y = Math.round(H * fy);
        let p = null;
        try { p = scene.pick(new Cesium.Cartesian2(x, y)); } catch (_) { continue; }
        if (!(p instanceof Cesium.Cesium3DTileFeature)) continue;
        let zmin = null, zmax = null;
        try { zmin = Number(p.getProperty('_zmin')); } catch (_) { /* noop */ }
        try { zmax = Number(p.getProperty('_zmax')); } catch (_) { /* noop */ }
        if (!Number.isFinite(zmin) || !Number.isFinite(zmax) || zmax - zmin < 3) continue;
        let pos = null;
        try { if (scene.pickPositionSupported) pos = scene.pickPosition(new Cesium.Cartesian2(x, y)); } catch (_) { /* noop */ }
        if (!Cesium.defined(pos)) continue;
        const carto = Cesium.Cartographic.fromCartesian(pos);
        window.__r3p2Feature = p;
        return {
          found: true,
          lon: Cesium.Math.toDegrees(carto.longitude),
          lat: Cesium.Math.toDegrees(carto.latitude),
          zmin, zmax,
        };
      }
    }
    return { found: false };
  });
  console.log('  ピック結果: ' + JSON.stringify(pickInfo));
  check('画面内から屋上を出せる建物フィーチャ（zmin/zmax差3m以上）を取得できる',
    pickInfo.found, JSON.stringify(pickInfo));
  if (!pickInfo.found) throw new Error('建物フィーチャが見つからず F3-1 のテストを継続できない');

  const buildingInitialCount = await page.evaluate(
    () => window.__nakano.diagnosis.getSunlightTestState().runCount
  );
  await page.evaluate(({ lon, lat }) => {
    window.__nakano.diagnosis
      .diagnose({ lon, lat, title: null, picked: window.__r3p2Feature, fly: false })
      .catch((e) => console.warn('diagnose(picked) failed', e));
  }, { lon: pickInfo.lon, lat: pickInfo.lat });
  await page.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 30000 });
  const bldgSunText1 = await waitSection('secSun', 180000);
  console.log('  ☀️ (建物・既定) ' + bldgSunText1.slice(0, 260));

  const floorOptions = await page.evaluate(() => {
    const sel = document.getElementById('sunFloorSelect');
    if (!sel) return null;
    return Array.from(sel.options).map((o) => ({ value: o.value, text: o.textContent, selected: o.selected }));
  });
  console.log('  セレクタ: ' + JSON.stringify(floorOptions));
  check('視点高さセレクタが表示される',
    Array.isArray(floorOptions) && floorOptions.length > 0, JSON.stringify(floorOptions));
  check('セレクタに「屋上」が出る',
    !!floorOptions?.some((o) => o.value === 'roof' && o.text.includes('屋上')), JSON.stringify(floorOptions));
  check('建物クリックの既定選択は1階（従来既定＝地面+1.2m相当）と一致',
    floorOptions?.find((o) => o.selected)?.value === 'f1', JSON.stringify(floorOptions));

  const bldg1F = await page.evaluate(() => {
    const r = window.__nakano.diagnosis.getLastResult();
    return {
      raysCast: r?.sunlight?.raysCast,
      totalHours: r?.sunlight?.days?.reduce((a, d) => a + d.hours, 0),
      originHeight: r?.sunlight?.originHeight,
      cancelled: r?.sunlight?.cancelled,
      runCount: window.__nakano.diagnosis.getSunlightTestState().runCount,
    };
  });
  console.log('  1階（既定）: ' + JSON.stringify(bldg1F));
  check('建物クリックの既定表示でも日照が計算されている（初期表示では再計算しない）',
    bldg1F.raysCast > 50, JSON.stringify(bldg1F));
  check('建物クリックの初期診断では日照計算を1回だけ実行する',
    bldg1F.runCount - buildingInitialCount === 1,
    `before=${buildingInitialCount} after=${bldg1F.runCount}`);

  // 屋上へ切り替え → 400msデバウンス後に再計算される
  await page.evaluate(() => {
    const sel = document.getElementById('sunFloorSelect');
    sel.value = 'roof';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // デバウンス直後は旧タイムラインが .stale のまま「再計算中…」が出るはず
  await page.waitForFunction(
    () => !!document.querySelector('#secSun .sun-recalc-status'), null, { timeout: 3000 }
  ).catch(() => {});
  const staleState = await page.evaluate(() => ({
    stale: document.querySelectorAll('#secSun .sun-day.stale').length,
    status: !!document.querySelector('#secSun .sun-recalc-status'),
    selectValue: document.getElementById('sunFloorSelect')?.value,
  }));
  console.log('  デバウンス直後: ' + JSON.stringify(staleState));
  check('セレクタ変更直後は旧タイムラインがstale表示になる（.stale）',
    staleState.stale === 3, JSON.stringify(staleState));
  check('再計算中… の進捗表示が出る', staleState.status, JSON.stringify(staleState));
  check('セレクタのDOM値は選択直後から屋上になっている', staleState.selectValue === 'roof', JSON.stringify(staleState));

  await page.waitForFunction(() => {
    const sel = document.getElementById('sunFloorSelect');
    return sel && sel.value === 'roof' && !document.querySelector('#secSun .sun-recalc-status');
  }, null, { timeout: 60000, polling: 500 });

  const bldgRoof = await page.evaluate(() => {
    const r = window.__nakano.diagnosis.getLastResult();
    return {
      raysCast: r?.sunlight?.raysCast,
      totalHours: r?.sunlight?.days?.reduce((a, d) => a + d.hours, 0),
      originHeight: r?.sunlight?.originHeight,
      cancelled: r?.sunlight?.cancelled,
      dom: {
        days: document.querySelectorAll('#secSun .sun-day').length,
        cells: document.querySelectorAll('#secSun .sun-bar i').length,
        stale: document.querySelectorAll('#secSun .sun-day.stale').length,
      },
    };
  });
  console.log('  屋上: ' + JSON.stringify(bldgRoof));
  check('屋上再計算後もレイキャストが行われている', bldgRoof.raysCast > 50, JSON.stringify(bldgRoof));
  check('屋上再計算はキャンセルされていない', bldgRoof.cancelled === false, JSON.stringify(bldgRoof));
  check('屋上再計算後も .sun-day/.sun-bar/93セルのDOM構造が維持される',
    bldgRoof.dom.days === 3 && bldgRoof.dom.cells === 93, JSON.stringify(bldgRoof.dom));
  check('再計算完了後はstale表示が消える', bldgRoof.dom.stale === 0, JSON.stringify(bldgRoof.dom));
  check('屋上の合計日照時間が1階以上（受け入れ基準: 屋上 >= 1階）',
    bldgRoof.totalHours >= bldg1F.totalHours,
    `roof=${bldgRoof.totalHours} 1F=${bldg1F.totalHours}`);
  check('屋上と1階の差が0.5h以上（P0後の設計確定#10の確定閾値）',
    bldgRoof.totalHours - bldg1F.totalHours >= 0.5,
    `diff=${bldgRoof.totalHours - bldg1F.totalHours}`);
  check('屋上のレイ原点は1階より高い', bldgRoof.originHeight > bldg1F.originHeight,
    `roof=${bldgRoof.originHeight} 1F=${bldg1F.originHeight}`);

  const bldgNoteText = await page.evaluate(() => document.getElementById('secSun').textContent);
  check('屋上選択後の注記に「視点高さ」と「屋上」が出る',
    bldgNoteText.includes('視点高さ') && bldgNoteText.includes('屋上'), bldgNoteText.slice(-220));

  await page.locator('#diagnosisPanel').screenshot({ path: shotPath('r3-02-card-floor-select.png') });

  // ==== 4. F3-1: セレクタ連打 → 最終選択のみ表示（stale経由）・キャンセルの観測 ====
  console.log('\n--- F3-1: セレクタ連打（デバウンス・キャンセル） ---');

  // roof 以外の階から2つ選ぶ（現在値は roof なので、まずそれ以外へ切り替えないと change が発火しない）
  const nonRoof = floorOptions.filter((o) => o.value !== 'roof');
  const keyA = nonRoof[0].value;
  const keyB = nonRoof.length > 1 ? nonRoof[Math.floor(nonRoof.length / 2)].value : 'roof';
  console.log(`  keyA=${keyA} keyB=${keyB}`);
  const cancelBefore = await page.evaluate(
    () => window.__nakano.diagnosis.getSunlightTestState()
  );

  // 1回目の変更 → デバウンスが明けて計算が「実際に始まる」のを待ってから、
  // 完了前に2回目の変更を挟むことで、進行中の計算を本当にキャンセルさせる
  // （デバウンスだけで弾かれる「未着手キャンセル」ではなく、estimateSunlight内のisCancelled
  //   チェックで打ち切られる「進行中キャンセル」を再現する）。
  await page.evaluate((k) => {
    const sel = document.getElementById('sunFloorSelect');
    sel.value = k;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, keyA);
  await page.waitForFunction(
    () => {
      const state = window.__nakano.diagnosis.getSunlightTestState();
      return state.selectedKey === document.getElementById('sunFloorSelect')?.value
        && state.recalculationProgress > 0
        && state.recalculationProgress < 1;
    },
    null,
    { timeout: 10000, polling: 50 }
  );
  const movingState = await page.evaluate(
    () => window.__nakano.diagnosis.getSunlightTestState()
  );
  check('1回目の再計算で進捗が動き始めてから2回目を選択する',
    movingState.recalculationProgress > 0 && movingState.recalculationProgress < 1,
    JSON.stringify(movingState));

  await page.evaluate((k) => {
    const sel = document.getElementById('sunFloorSelect');
    sel.value = k;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, keyB);

  await page.waitForFunction((k) => {
    const sel = document.getElementById('sunFloorSelect');
    return sel && sel.value === k && !document.querySelector('#secSun .sun-recalc-status');
  }, keyB, { timeout: 60000, polling: 500 });

  const finalState = await page.evaluate(() => {
    const r = window.__nakano.diagnosis.getLastResult();
    const sel = document.getElementById('sunFloorSelect');
    return {
      selectValue: sel?.value,
      raysCast: r?.sunlight?.raysCast,
      originHeight: r?.sunlight?.originHeight,
      cancelled: r?.sunlight?.cancelled,
      staleCount: document.querySelectorAll('#secSun .sun-day.stale').length,
      testState: window.__nakano.diagnosis.getSunlightTestState(),
    };
  });
  console.log('  最終状態: ' + JSON.stringify(finalState));

  check('最終選択（2回目に選んだ階）の結果のみが表示される', finalState.selectValue === keyB, JSON.stringify(finalState));
  check('最終表示にstale表示が残っていない', finalState.staleCount === 0, JSON.stringify(finalState));
  check('最終結果はキャンセルされていない（成立したのは最後の選択のみ）',
    finalState.cancelled === false, JSON.stringify(finalState));
  check('最終結果は完走している（レイキャスト十分）', finalState.raysCast > 50, JSON.stringify(finalState));
  check('1回目の選択（keyA）の再計算がキャンセルされたことをテストフックで観測できる',
    finalState.testState.cancelledRunCount === cancelBefore.cancelledRunCount + 1,
    JSON.stringify({ before: cancelBefore, after: finalState.testState }));
  check('キャンセルされた再計算のraysCastは完走時より少ない（raysCast減）',
    finalState.testState.lastCancelledRaysCast < finalState.raysCast,
    JSON.stringify({ cancelledRays: finalState.testState.lastCancelledRaysCast, finalRays: finalState.raysCast }));
  check('連打では1回目と最終選択の2回だけ日照計算を開始する',
    finalState.testState.runCount === cancelBefore.runCount + 2,
    JSON.stringify({ before: cancelBefore, after: finalState.testState }));
  check('最終結果のoriginHeightが最終選択階の期待高さと一致する',
    Math.abs(finalState.originHeight - finalState.testState.expectedOriginHeight) < 1e-6,
    JSON.stringify({
      selectedKey: keyB,
      originHeight: finalState.originHeight,
      expectedOriginHeight: finalState.testState.expectedOriginHeight,
    }));

  // ==== 5. F3-1: 一般地点（住所検索）で階を選ぶと注記に視点高さが出る ====
  console.log('\n--- F3-1: 一般地点の階数選択 ---');
  await page.evaluate(() =>
    window.__nakano.diagnosis.runDiagnosisAt(139.663, 35.688, { title: '南台五丁目付近(F3-1)', fly: true })
  );
  await page.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 30000 });
  await waitSection('secSun', 180000);

  const groundOptions = await page.evaluate(() => {
    const sel = document.getElementById('sunFloorSelect');
    return sel ? Array.from(sel.options).map((o) => o.value) : null;
  });
  const expectedGroundOptions = Array.from({ length: 15 }, (_, i) => 'f' + (i + 1));
  console.log('  一般地点セレクタ: ' + JSON.stringify(groundOptions));
  check('一般地点のセレクタは1階〜15階（屋上なし）',
    JSON.stringify(groundOptions) === JSON.stringify(expectedGroundOptions), JSON.stringify(groundOptions));

  await page.evaluate(() => {
    const sel = document.getElementById('sunFloorSelect');
    sel.value = 'f3';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // デバウンス直後は「.sun-recalc-status がまだ無い」状態と「計算完了後」の両方が
  // "!recalc-status" を満たしてしまうので、先に「再計算が始まった（=出現した）」ことを
  // 確認してから完了待ちに入る（section 3のroof切り替えと同じ二段待ち）。
  await page.waitForFunction(
    () => !!document.querySelector('#secSun .sun-recalc-status'), null, { timeout: 3000 }
  ).catch(() => {});
  await page.waitForFunction(() => {
    const sel = document.getElementById('sunFloorSelect');
    return sel && sel.value === 'f3' && !document.querySelector('#secSun .sun-recalc-status');
  }, null, { timeout: 60000, polling: 500 });

  const groundAfter = await page.evaluate(() => {
    const r = window.__nakano.diagnosis.getLastResult();
    return {
      text: document.getElementById('secSun').textContent,
      originHeight: r?.sunlight?.originHeight,
      baseHeight: r?.baseHeight?.height,
      dom: {
        days: document.querySelectorAll('#secSun .sun-day').length,
        cells: document.querySelectorAll('#secSun .sun-bar i').length,
      },
    };
  });
  console.log('  3階選択後: ' + JSON.stringify({ ...groundAfter, text: groundAfter.text.slice(-220) }));
  check('3階選択後の注記に「視点高さ」が出る', groundAfter.text.includes('視点高さ'), groundAfter.text.slice(-220));
  // セレクタのoption文言にも「3階」は出るので、option一覧ではなく注記本文（末尾の「視点高さ...m（3階）。」）を見る
  check('3階選択後の注記が「視点高さ ○○m（3階）」になっている',
    /視点高さ\s*[\d.]+m（3階）/.test(groundAfter.text), groundAfter.text.slice(-220));
  check('「簡易計算」を含む既存文が視点高さの注記より先に来る（既存文の順序を維持）',
    groundAfter.text.indexOf('簡易計算') >= 0 &&
    groundAfter.text.indexOf('簡易計算') < groundAfter.text.indexOf('視点高さ'),
    groundAfter.text.slice(-260));
  check('3階のレイ原点は 地面+1.2+3.0×2 と一致',
    Math.abs(groundAfter.originHeight - (groundAfter.baseHeight + 1.2 + 3.0 * 2)) < 1e-6,
    `${groundAfter.originHeight} vs base=${groundAfter.baseHeight}`);
  check('3階再計算後も .sun-day/.sun-bar/93セルのDOM構造が維持される',
    groundAfter.dom.days === 3 && groundAfter.dom.cells === 93, JSON.stringify(groundAfter.dom));

  await page.locator('#secSun').screenshot({ path: shotPath('r3-03-sunsection-3f-ground.png') });

  // ==== 6. F3-1: 再計算中に新規診断を開始しても新しい診断だけが表示される ====
  console.log('\n--- F3-1: 再計算中の新規診断 ---');
  const rediagnoseBefore = await page.evaluate(
    () => window.__nakano.diagnosis.getSunlightTestState()
  );
  await page.evaluate(() => {
    const sel = document.getElementById('sunFloorSelect');
    sel.value = 'f5';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(
    () => {
      const p = window.__nakano.diagnosis.getSunlightTestState().recalculationProgress;
      return p > 0 && p < 1;
    },
    null,
    { timeout: 10000, polling: 50 }
  );
  await page.evaluate(() => {
    window.__nakano.diagnosis.diagnose({
      lon: 139.671,
      lat: 35.705,
      title: '再計算中に開始した新規診断',
      picked: null,
      fly: false,
    }).catch((e) => console.warn('rediagnose failed', e));
  });
  await waitSection('secSun', 180000);

  const rediagnosed = await page.evaluate(() => {
    const r = window.__nakano.diagnosis.getLastResult();
    return {
      title: r?.title,
      lon: r?.lon,
      lat: r?.lat,
      originHeight: r?.sunlight?.originHeight,
      baseHeight: r?.baseHeight?.height,
      cancelled: r?.sunlight?.cancelled,
      placeText: document.getElementById('secPlace')?.textContent,
      selectValue: document.getElementById('sunFloorSelect')?.value,
      staleCount: document.querySelectorAll('#secSun .sun-day.stale').length,
      status: !!document.querySelector('#secSun .sun-recalc-status'),
      days: document.querySelectorAll('#secSun .sun-day').length,
      cells: document.querySelectorAll('#secSun .sun-bar i').length,
      testState: window.__nakano.diagnosis.getSunlightTestState(),
    };
  });
  console.log('  新規診断: ' + JSON.stringify(rediagnosed));
  check('再計算中に開始した新規診断の地点名と座標が最終結果になる',
    rediagnosed.title === '再計算中に開始した新規診断'
      && Math.abs(rediagnosed.lon - 139.671) < 1e-9
      && Math.abs(rediagnosed.lat - 35.705) < 1e-9,
    JSON.stringify(rediagnosed));
  check('新規診断の地点名がカードに表示される',
    rediagnosed.placeText?.includes('再計算中に開始した新規診断'), String(rediagnosed.placeText));
  check('新規診断は既定の1階を選択し、地面+1.2mで完走する',
    rediagnosed.selectValue === 'f1'
      && rediagnosed.cancelled === false
      && Math.abs(rediagnosed.originHeight - (rediagnosed.baseHeight + 1.2)) < 1e-6,
    JSON.stringify(rediagnosed));
  check('新規診断のタイムラインだけが非staleの93セルで表示される',
    rediagnosed.days === 3 && rediagnosed.cells === 93
      && rediagnosed.staleCount === 0 && rediagnosed.status === false,
    JSON.stringify(rediagnosed));
  check('新規診断の開始で実行中だった再計算がキャンセルされる',
    rediagnosed.testState.cancelledRunCount === rediagnoseBefore.cancelledRunCount + 1,
    JSON.stringify({ before: rediagnoseBefore, after: rediagnosed.testState }));

  // ==== 7. F3-1: 再計算中にカードを閉じても例外を出さない ====
  console.log('\n--- F3-1: 再計算中のカード閉鎖 ---');
  const closeBefore = await page.evaluate(
    () => window.__nakano.diagnosis.getSunlightTestState()
  );
  const errorsBeforeClose = t.errors.length;
  await page.evaluate(() => {
    const sel = document.getElementById('sunFloorSelect');
    sel.value = 'f3';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(
    () => {
      const p = window.__nakano.diagnosis.getSunlightTestState().recalculationProgress;
      return p > 0 && p < 1;
    },
    null,
    { timeout: 10000, polling: 50 }
  );
  await page.evaluate(() => window.__nakano.diagnosis.close());
  await page.waitForFunction(
    (before) => window.__nakano.diagnosis.getSunlightTestState().cancelledRunCount > before,
    closeBefore.cancelledRunCount,
    { timeout: 10000, polling: 50 }
  );
  const closeState = await page.evaluate(() => ({
    hidden: document.getElementById('diagnosisPanel').classList.contains('hidden'),
    testState: window.__nakano.diagnosis.getSunlightTestState(),
  }));
  const closeErrors = t.errors.slice(errorsBeforeClose).filter(
    (e) => e.startsWith('PAGEERROR') || /Unhandled|unhandled|rejection/i.test(e)
  );
  console.log('  閉鎖後: ' + JSON.stringify({ ...closeState, closeErrors }));
  check('再計算中に閉じると診断カードが閉じる', closeState.hidden, JSON.stringify(closeState));
  check('カード閉鎖で実行中の日照再計算がキャンセルされる',
    closeState.testState.cancelledRunCount === closeBefore.cancelledRunCount + 1,
    JSON.stringify({ before: closeBefore, after: closeState.testState }));
  check('再計算中のカード閉鎖で未処理Promise拒否やページ例外が出ない',
    closeErrors.length === 0, JSON.stringify(closeErrors));

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

report('e2e-r3.test.mjs');
