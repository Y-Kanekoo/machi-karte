// R1（共有URL・用途地域オーバーレイ・地点比較・UX改善）のブラウザ統合テスト
// 実行: node test/e2e-r1.test.mjs （事前に python3 -m http.server 8123 が必要）
//
// 既存の test/e2e.test.mjs（街カルテ本体）とは別ファイルにして、R1で追加した
// 機能だけをまとめて検証する。期待値は 2026-07-27 実測の実データに基づく。

import { launchViewer, waitForViewerReady, check, equal, near, report, shotPath, BASE_URL } from './harness.mjs';

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
