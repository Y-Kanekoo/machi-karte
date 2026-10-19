// PR #12 R3 warm-up diagnostic. Run only through the isolated manual workflow.
// Keep the original F3-3 acceptance assertions and application code unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { launchViewer, waitForViewerReady, check, report, shotPath, OUTPUT_DIR } from './harness.mjs';

const record = {
  head: process.env.GITHUB_SHA || null,
  startedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, node: process.version },
  requests: [],
  requestSummary: {},
  cameraBefore: null,
  cameraAfter: null,
  preload: null,
  browser: null,
  probe: null,
  errors: [],
};
const MAX_REQUESTS = 1000;
const startedRequests = new WeakMap();
const responseStatuses = new WeakMap();
const recordRequest = (request, outcome, status = null, error = null) => {
  let url;
  try {
    const parsed = new URL(request.url());
    url = parsed.origin + parsed.pathname; // Do not persist query strings or tokens.
  } catch (_) { url = '[invalid URL]'; }
  const host = (() => { try { return new URL(request.url()).host; } catch (_) { return 'unknown'; } })();
  const key = `${host} ${outcome} ${status ?? ''}`;
  record.requestSummary[key] = (record.requestSummary[key] || 0) + 1;
  if (record.requests.length < MAX_REQUESTS) record.requests.push({
    at: new Date().toISOString(),
    ms: Date.now() - (startedRequests.get(request) ?? Date.now()),
    url, type: request.resourceType(), outcome, status, error,
  });
};

let t;
try {
  t = await launchViewer({ viewport: { width: 1440, height: 900 } });
  const { page } = t;
  record.browser = await t.browser.version();
  page.on('request', (r) => startedRequests.set(r, Date.now()));
  page.on('response', (r) => responseStatuses.set(r.request(), r.status()));
  page.on('requestfinished', (r) => recordRequest(r, 'finished', responseStatuses.get(r) ?? null));
  page.on('requestfailed', (r) => recordRequest(r, 'failed', null, r.failure()?.errorText || null));

  await waitForViewerReady(page);
  await page.waitForTimeout(8000); // Same startup wait as test/e2e-r3.test.mjs.

  // Observe the original API without changing its arguments, return value, or timing policy.
  await page.evaluate(() => {
    const viewer = window.__nakano.viewer;
    const scene = viewer.scene;
    const tileset = window.__nakano.loaded?.bldgLod2;
    const probe = window.__r3diag = {
      startedAt: new Date().toISOString(),
      qualityProfile: window.__nakano.qualityProfileName,
      rayCalls: [], tileEvents: [], frameSamples: [], cameraSamples: [],
      initialTilesLoaded: tileset?.tilesLoaded ?? null,
      initialFrameNumber: scene.frameState?.frameNumber ?? null,
    };
    const elapsed = () => Math.round(performance.now());
    const addTileEvent = (event, detail = {}) => {
      if (probe.tileEvents.length < 1000) probe.tileEvents.push({ at: elapsed(), event, ...detail });
    };
    try { tileset?.tileLoad?.addEventListener(() => addTileEvent('tileLoad')); } catch (_) {}
    try { tileset?.tileFailed?.addEventListener((error) => addTileEvent('tileFailed', { error: String(error?.message || error).slice(0, 200) })); } catch (_) {}
    try { tileset?.loadProgress?.addEventListener((pending, processing) => addTileEvent('loadProgress', { pending, processing })); } catch (_) {}
    try { tileset?.allTilesLoaded?.addEventListener(() => addTileEvent('allTilesLoaded')); } catch (_) {}

    const original = scene.pickFromRayMostDetailed;
    scene.pickFromRayMostDetailed = function (...args) {
      const entry = { index: probe.rayCalls.length + 1, startedAt: elapsed(), completedAt: null, outcome: 'pending' };
      probe.rayCalls.push(entry);
      try {
        const result = original.apply(this, args);
        Promise.resolve(result).then(
          (value) => { entry.completedAt = elapsed(); entry.outcome = 'resolved'; entry.hit = !!value?.position; },
          (error) => { entry.completedAt = elapsed(); entry.outcome = 'rejected'; entry.error = String(error?.message || error).slice(0, 200); },
        );
        return result;
      } catch (error) {
        entry.completedAt = elapsed(); entry.outcome = 'threw';
        entry.error = String(error?.message || error).slice(0, 200);
        throw error;
      }
    };

    const cam = viewer.camera;
    probe.timer = setInterval(() => {
      const c = cam.positionCartographic;
      probe.cameraSamples.push({
        at: elapsed(), lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude),
        height: c.height, pitchDeg: Cesium.Math.toDegrees(cam.pitch),
      });
    }, 200);
    probe.frameTimer = setInterval(() => {
      probe.frameSamples.push({ at: elapsed(), frameNumber: scene.frameState?.frameNumber ?? null,
        tilesLoaded: tileset?.tilesLoaded ?? null });
    }, 500);
  });

  record.cameraBefore = await page.evaluate(() => {
    const c = window.__nakano.viewer.camera.positionCartographic;
    return { lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude), height: c.height };
  });
  await page.evaluate(() => {
    window.__nakano.diagnosis.searchAndDiagnose('中野区中野五丁目')
      .catch((e) => console.warn('searchAndDiagnose failed', e));
  });
  await page.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 60000 });
  await page.waitForFunction((sid) => {
    const el = document.getElementById(sid);
    return !!el && !el.querySelector('.spinner');
  }, 'secSun', { timeout: 180000, polling: 500 });
  const sunText = (await page.textContent('#secSun')).replace(/\s+/g, ' ').trim();

  record.probe = await page.evaluate(() => {
    clearInterval(window.__r3diag.timer);
    clearInterval(window.__r3diag.frameTimer);
    const { timer, frameTimer, ...data } = window.__r3diag;
    return data;
  });
  const samples = record.probe.cameraSamples;
  record.cameraAfter = samples[samples.length - 1] || null;
  record.preload = await page.evaluate(() => window.__nakano.diagnosis.getLastResult()?.sunlight?.preload || null);
  record.sunlight = await page.evaluate(() => {
    const s = window.__nakano.diagnosis.getLastResult()?.sunlight;
    return { days: s?.days?.length, raysCast: s?.raysCast, pickErrors: s?.pickErrors, error: s?.error || null };
  });

  // Original F3-3 assertions from test/e2e-r3.test.mjs, with identical thresholds.
  const teleported = samples.filter((s) => Math.abs(s.height - 400) < 25 && Math.abs(s.pitchDeg + 60) < 3);
  check('診断中にカメラが上空400m・pitch−60°へテレポートしない', teleported.length === 0, JSON.stringify(teleported.slice(0, 3)));
  check('カメラサンプルが取れている', samples.length >= 10, `count=${samples.length}`);
  check('診断後のカメラがflyToの目的地（高度600m）にとどまる', Math.abs(record.cameraAfter.height - 600) < 60, String(record.cameraAfter.height));
  check('診断後のカメラのピッチがflyToの−50°のまま', Math.abs(record.cameraAfter.pitchDeg + 50) < 3, String(record.cameraAfter.pitchDeg));
  check('カメラは検索地点へは移動している', Math.abs(record.cameraAfter.lon - record.cameraBefore.lon) > 1e-6 || Math.abs(record.cameraAfter.lat - record.cameraBefore.lat) > 1e-6);
  check('先読みが太陽経路ウォームアップで行われる', record.preload?.method === 'warmUpSunPath', JSON.stringify(record.preload));
  check('ウォームアップのレイが解決している', record.preload?.warmUp?.resolved > 0, JSON.stringify(record.preload?.warmUp));
  check('ウォームアップのレイ本数が8〜12本', record.preload?.warmUp?.rays >= 8 && record.preload?.warmUp?.rays <= 12, String(record.preload?.warmUp?.rays));
  check('ウォームアップがタイムアウトしていない', record.preload?.warmUp?.timedOut === false, JSON.stringify(record.preload?.warmUp));
  check('発射した本数が計画本数と一致する', record.preload?.warmUp?.attempted === record.preload?.warmUp?.rays,
    JSON.stringify({ attempted: record.preload?.warmUp?.attempted, rays: record.preload?.warmUp?.rays }));
  check('ウォームアップがキャンセルされていない', record.preload?.warmUp?.cancelled === false, JSON.stringify(record.preload?.warmUp));
  check('先読みがキャンセル扱いになっていない', record.preload?.cancelled === false, JSON.stringify(record.preload));
  check('先読みが成功扱いになっている', record.preload?.ok === true, JSON.stringify(record.preload));
  check('先読みのフォールバック注記が出ていない', !sunText.includes('フォールバック') && !sunText.includes('先読みができなかった'), sunText.slice(-160));
  await page.locator('#diagnosisPanel').screenshot({ path: shotPath('r3-warmup-diagnostic.png') });
  report('r3-warmup-diagnostic');
} catch (error) {
  record.errors.push(String(error?.stack || error));
  process.exitCode = 1;
  if (t) {
    try { await t.page.screenshot({ path: shotPath('r3-warmup-diagnostic.png') }); } catch (_) {}
  }
} finally {
  record.finishedAt = new Date().toISOString();
  if (t) {
    record.browserErrors = t.errors;
    record.relay = t.relay;
    if (!record.probe) {
      try { record.probe = await t.page.evaluate(() => {
        if (!window.__r3diag) return null;
        clearInterval(window.__r3diag.timer);
        clearInterval(window.__r3diag.frameTimer);
        const { timer, frameTimer, ...data } = window.__r3diag;
        return data;
      }); } catch (_) {}
    }
    try { await t.close(); } catch (_) {}
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'r3-warmup-diagnostic.json'), JSON.stringify(record, null, 2));
  console.log('R3 diagnostic summary:', JSON.stringify({
    head: record.head, browser: record.browser, host: record.host,
    cameraBefore: record.cameraBefore, cameraAfter: record.cameraAfter,
    preload: record.preload, sunlight: record.sunlight,
    rays: record.probe?.rayCalls, requestSummary: record.requestSummary,
    errors: record.errors,
  }));
}
