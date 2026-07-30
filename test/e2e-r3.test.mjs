// R3（日照・日影の本格化）のブラウザ統合テスト
// 実行: node test/e2e-r3.test.mjs （事前に `npm run serve` が必要）
//
// 既存の test/e2e.test.mjs は無改変のまま、R3で追加・変更した振る舞いだけをここで検証する。
// P1時点の対象は F3-3（プリロード置換）の先行2項目:
//   1. 住所検索の診断でカメラが上空400m（従来の prepareTiles）へ強制テレポートしないこと
//   2. 置き換え後も日照の既存アサーション群（3日付・93セル・raysCast>50・エラーなし）が成立すること
// F3-1（階数UI）・F3-2（日影マップ）の項目はP2以降でこのファイルに追加する。
//
// 実装方針（R3計画書「P0後の設計確定」#11）:
//   canvas 上のマウス操作は使わない。Cesium のエラーパネルがポインタイベントを奪って
//   page.click が30秒タイムアウトする事象があるため、DOM直叩きと window.__nakano フックで操作する。

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

  // ==== 3. JSエラー ====
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
