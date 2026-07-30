// R3 P0 スパイク計測（docs/plans/R3.md §3 P0 / §5.2）
//
// 実行: node test/r3-probe.mjs（事前に `npm run serve` が必要）
// npm test には含めない。設計分岐（§3.1.2 自建物の扱い / §3.3.1 プリロード方式）を
// 確定するための実測データを取るための使い捨て計測スクリプト。
//
// 計測項目:
//   (1) scene.pickFromRayMostDetailed が SwiftShader で動くか＋単発×10本の所要
//   (2) warm-up 後の同期 scene.pickFromRay 200本の1本あたり ms（平均/中央値）
//   (3) pickFromRay の objectsToExclude に Cesium3DTileFeature を渡した除外の可否
//   (4) scene.sampleHeightMostDetailed 441点（64点バッチ）の可否・所要・失敗数
//   (5) tileset.maximumScreenSpaceError 16→8 の totalMemoryUsageInBytes 変化と復元挙動
//   (6) 駅前建物の階数プロパティの実名（getPropertyIds の全列挙）
//
// アサーションは「動作可否」のみ。数値はログ出力に留める（§5.2の方針）。
// 非公開APIの呼び出しは必ず try/catch で包む。アプリコード（js/・index.html）は変更しない。

import fs from 'node:fs';
import path from 'node:path';
import { launchViewer, waitForViewerReady, check, report, OUTPUT_DIR, shotPath } from './harness.mjs';

const t = await launchViewer({ viewport: { width: 1440, height: 900 } });
const { page } = t;

/** ログ出力（コンソールとJSONの両方に残す） */
const log = [];
function say(line) {
  console.log(line);
  log.push(line);
}
function dump(label, obj) {
  say(`  ${label}: ${JSON.stringify(obj)}`);
}

page.on('console', (m) => {
  const txt = m.text();
  if (txt.startsWith('[r3]')) console.log('    (page) ' + txt);
});

const results = {};

try {
  say('=== R3 P0 スパイク計測 ===');
  await waitForViewerReady(page);

  // 中野駅前へ。建物クリックのイベントハンドラを起動させたくないので
  // マウス操作は一切せず、テストフックの flyTo と scene.pick だけで完結させる。
  // （Cesium のエラーパネルが出ているとポインタイベントを奪って page.click が失敗するため）
  await page.evaluate(() =>
    window.__nakano.flyTo({ lon: 139.6659, lat: 35.7010, height: 500, heading: 0, pitch: -40 }, 0)
  );
  await page.waitForTimeout(9000);
  const errPanel = await page.evaluate(() => {
    const el = document.querySelector('.cesium-widget-errorPanel');
    return el ? el.innerText.slice(0, 600) : null;
  });
  if (errPanel) say(`  (注意) Cesiumエラーパネルが表示されている: ${JSON.stringify(errPanel)}`);
  await page.waitForFunction(
    () => window.__nakano?.loaded?.bldgLod2?.tilesLoaded === true,
    null,
    { timeout: 120000, polling: 500 }
  ).catch(() => say('  (注意) bldgLod2.tilesLoaded が真になる前にタイムアウト。続行する'));
  await page.screenshot({ path: shotPath('r3-probe-00-station.png') });

  // 画面内の建物フィーチャを scene.pick で拾う（アプリのクリックハンドラは経由しない）
  const found = await page.evaluate(() => {
    const scene = window.__nakano.viewer.scene;
    const canvas = scene.canvas;
    const feats = [];
    const seen = new Set();
    const W = canvas.clientWidth, H = canvas.clientHeight;
    for (let fy = 0.30; fy <= 0.85 && feats.length < 8; fy += 0.05) {
      for (let fx = 0.15; fx <= 0.85 && feats.length < 8; fx += 0.05) {
        const x = Math.round(W * fx), y = Math.round(H * fy);
        let p = null;
        try { p = scene.pick(new Cesium.Cartesian2(x, y)); } catch (_) { continue; }
        if (!(p instanceof Cesium.Cesium3DTileFeature)) continue;
        let key = null;
        try { key = String(p.getProperty('gml_id') ?? p.getProperty('名称') ?? '') + '@' + p.featureId; } catch (_) { key = '@' + p.featureId; }
        if (seen.has(key)) continue;
        seen.add(key);
        let pos = null;
        try {
          if (scene.pickPositionSupported) pos = scene.pickPosition(new Cesium.Cartesian2(x, y));
        } catch (_) { /* noop */ }
        // 以降のレイ原点計算に世界座標が要るので、取れなかったフィーチャは採らない
        if (!Cesium.defined(pos)) { seen.delete(key); continue; }
        feats.push({ feature: p, x, y, pos });
      }
    }
    window.__r3 = { feats, scene, viewer: window.__nakano.viewer };
    return feats.map((f) => {
      const carto = f.pos ? Cesium.Cartographic.fromCartesian(f.pos) : null;
      return {
        x: f.x, y: f.y,
        lon: carto ? Cesium.Math.toDegrees(carto.longitude) : null,
        lat: carto ? Cesium.Math.toDegrees(carto.latitude) : null,
        surfaceHeight: carto ? carto.height : null,
      };
    });
  });
  check('画面内から建物フィーチャを取得できる', found.length > 0, `count=${found.length}`);
  say(`\n--- 取得した建物フィーチャ ${found.length}件 ---`);
  for (const f of found) dump('feature', f);
  results.pickedFeatures = found;
  if (!found.length) throw new Error('建物フィーチャが取得できなかったため計測を中止する');

  // ==== (6) 階数プロパティの実名 ====================================================
  say('\n=== (6) 建物フィーチャのプロパティ名の実測 ===');
  const props = await page.evaluate(() => {
    const CANDIDATES = [
      '地上階数', '地下階数', 'storeysAboveGround', 'storeysBelowGround',
      'bldg:storeysAboveGround', 'bldg:storeysBelowGround',
      '計測高さ', 'bldg:measuredHeight', '_zmin', '_zmax',
    ];
    return window.__r3.feats.map((f, i) => {
      let ids = [];
      try { ids = f.feature.getPropertyIds(); } catch (e) { ids = ['(getPropertyIds失敗) ' + String(e)]; }
      const values = {};
      for (const n of ids) {
        try {
          const v = f.feature.getProperty(n);
          values[n] = typeof v === 'object' && v !== null ? JSON.stringify(v).slice(0, 60) : v;
        } catch (e) { values[n] = '(取得失敗)'; }
      }
      const candidateHits = {};
      for (const c of CANDIDATES) {
        try {
          const v = f.feature.getProperty(c);
          if (v !== undefined) candidateHits[c] = v;
        } catch (_) { /* noop */ }
      }
      return { index: i, propertyIds: ids, values, candidateHits };
    });
  });
  for (const p of props) {
    say(`  [${p.index}] propertyIds(${p.propertyIds.length}): ${JSON.stringify(p.propertyIds)}`);
    say(`  [${p.index}] values: ${JSON.stringify(p.values)}`);
    say(`  [${p.index}] 階数候補ヒット: ${JSON.stringify(p.candidateHits)}`);
  }
  results.properties = props;
  check('getPropertyIds() でプロパティ名を列挙できる',
    props.some((p) => p.propertyIds.length > 0), `first=${JSON.stringify(props[0]?.propertyIds)}`);
  const floorNames = ['地上階数', 'storeysAboveGround', 'bldg:storeysAboveGround'];
  const floorFound = props.flatMap((p) => p.propertyIds).filter((n) => floorNames.includes(n));
  say(`  階数プロパティの実名（全フィーチャ横断）: ${JSON.stringify([...new Set(floorFound)])}`);

  // ==== (1) pickFromRayMostDetailed ================================================
  say('\n=== (1) scene.pickFromRayMostDetailed の動作可否と単発×10本の所要 ===');
  const mostDetailed = await page.evaluate(async () => {
    const { scene, viewer } = window.__r3;
    const out = { exists: typeof scene.pickFromRayMostDetailed === 'function', rays: [], errors: [] };
    if (!out.exists) return out;
    const solar = await import('/js/solar.js');
    const f0 = window.__r3.feats[0];
    const carto = Cesium.Cartographic.fromCartesian(f0.pos);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    const lat = Cesium.Math.toDegrees(carto.latitude);
    let base = 35;
    try {
      const z = Number(f0.feature.getProperty('_zmin'));
      if (Number.isFinite(z)) base = z;
    } catch (_) { /* noop */ }
    const origin = Cesium.Cartesian3.fromDegrees(lon, lat, base + 1.2);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
    window.__r3.origin = origin;
    window.__r3.enu = enu;
    window.__r3.lonLatBase = { lon, lat, base };

    const RAD = Math.PI / 180;
    const dir = (az, el) => {
      const e = el * RAD, a = az * RAD;
      const v = new Cesium.Cartesian3(Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e));
      const ecef = Cesium.Matrix4.multiplyByPointAsVector(enu, v, new Cesium.Cartesian3());
      return Cesium.Cartesian3.normalize(ecef, ecef);
    };
    // 冬至・春分・夏至の 8/10/12/14/16時の太陽方向のうち高度5度以上を最大10本
    const dates = solar.solarKeyDates(new Date().getFullYear());
    const dirs = [];
    for (const d of dates) {
      for (const h of [8, 10, 12, 14, 16]) {
        const s = solar.sunPosition(solar.jstDate(d.year, d.month, d.day, h, 0), lon, lat);
        if (s.elevationDeg >= 5) dirs.push({ label: `${d.key}-${h}時`, az: s.azimuthDeg, el: s.elevationDeg });
      }
    }
    window.__r3.warmDirs = dirs;
    const picked = dirs.slice(0, 10);
    for (const p of picked) {
      const ray = new Cesium.Ray(origin, dir(p.az, p.el));
      const t0 = performance.now();
      try {
        const res = await Promise.race([
          scene.pickFromRayMostDetailed(ray),
          new Promise((r) => setTimeout(() => r('__timeout__'), 60000)),
        ]);
        const ms = performance.now() - t0;
        if (res === '__timeout__') {
          out.rays.push({ label: p.label, ms, status: 'timeout' });
        } else {
          out.rays.push({
            label: p.label, ms, status: 'resolved',
            hit: !!(res && res.position),
            objectType: res && res.object ? res.object.constructor.name : null,
          });
        }
      } catch (e) {
        out.rays.push({ label: p.label, ms: performance.now() - t0, status: 'throw' });
        out.errors.push(String(e).slice(0, 200));
      }
    }
    return out;
  });
  say(`  存在: ${mostDetailed.exists}`);
  for (const r of mostDetailed.rays) dump('ray', { ...r, ms: Math.round(r.ms) });
  if (mostDetailed.errors.length) dump('errors', mostDetailed.errors);
  const mdResolved = mostDetailed.rays.filter((r) => r.status === 'resolved');
  const mdMs = mdResolved.map((r) => r.ms);
  const mdStats = stats(mdMs);
  say(`  解決 ${mdResolved.length}/${mostDetailed.rays.length}本、所要(ms) 合計=${
    Math.round(mdMs.reduce((a, b) => a + b, 0))} 平均=${mdStats.mean} 中央値=${mdStats.median} 最小=${
    mdStats.min} 最大=${mdStats.max}`);
  results.pickFromRayMostDetailed = { exists: mostDetailed.exists, rays: mostDetailed.rays, stats: mdStats, errors: mostDetailed.errors };
  check('pickFromRayMostDetailed が関数として存在する', mostDetailed.exists === true);
  check('pickFromRayMostDetailed の Promise が解決する（SwiftShader）',
    mdResolved.length > 0, `resolved=${mdResolved.length}/${mostDetailed.rays.length}`);

  // ==== (2) 同期 pickFromRay 200本 =================================================
  say('\n=== (2) warm-up 後の同期 scene.pickFromRay 200本の所要 ===');
  const sync = await page.evaluate(async () => {
    const { scene } = window.__r3;
    const solar = await import('/js/solar.js');
    const { lon, lat, base } = window.__r3.lonLatBase;
    const origin = window.__r3.origin;
    const enu = window.__r3.enu;
    const RAD = Math.PI / 180;
    const dirOf = (az, el) => {
      const e = el * RAD, a = az * RAD;
      const v = new Cesium.Cartesian3(Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e));
      const ecef = Cesium.Matrix4.multiplyByPointAsVector(enu, v, new Cesium.Cartesian3());
      return Cesium.Cartesian3.normalize(ecef, ecef);
    };
    // 実運用と同じ方向分布（3日付 × 7:00〜17:00 20分刻み、高度5度以上）
    const dates = solar.solarKeyDates(new Date().getFullYear());
    const dirs = [];
    for (const d of dates) {
      for (const s of solar.sampleDay(d.year, d.month, d.day, lon, lat, { hourStart: 7, hourEnd: 17, stepMinutes: 20 })) {
        if (s.elevationDeg >= 5) dirs.push(dirOf(s.azimuthDeg, s.elevationDeg));
      }
    }
    const ray = new Cesium.Ray(origin, new Cesium.Cartesian3());
    // warm-up 20本（計測から除外）
    for (let i = 0; i < 20; i++) {
      ray.direction = dirs[i % dirs.length];
      try { scene.pickFromRay(ray); } catch (_) { /* noop */ }
    }
    const N = 200;
    const times = [];
    let hits = 0, errors = 0;
    const tAll = performance.now();
    for (let i = 0; i < N; i++) {
      ray.direction = dirs[i % dirs.length];
      const t0 = performance.now();
      try {
        const r = scene.pickFromRay(ray);
        times.push(performance.now() - t0);
        if (r && r.position) hits++;
      } catch (e) {
        times.push(performance.now() - t0);
        errors++;
      }
    }
    return { n: N, dirCount: dirs.length, times, hits, errors, totalMs: performance.now() - tAll, base };
  });
  const syncStats = stats(sync.times);
  say(`  方向数=${sync.dirCount}（高度5度以上）、実行=${sync.n}本、遮蔽ヒット=${sync.hits}、例外=${sync.errors}`);
  say(`  1本あたり(ms): 平均=${syncStats.mean} 中央値=${syncStats.median} p90=${syncStats.p90} 最小=${
    syncStats.min} 最大=${syncStats.max} / 200本合計=${Math.round(sync.totalMs)}ms`);
  results.pickFromRaySync = { n: sync.n, hits: sync.hits, errors: sync.errors, totalMs: sync.totalMs, stats: syncStats };
  check('同期 pickFromRay が200本完走する', sync.times.length === 200 && sync.errors === 0,
    `errors=${sync.errors}`);

  // ==== (3) objectsToExclude による自建物の除外 ======================================
  say('\n=== (3) pickFromRay の objectsToExclude に Cesium3DTileFeature を渡した除外 ===');
  const excl = await page.evaluate(async () => {
    const { scene, viewer } = window.__r3;
    const solar = await import('/js/solar.js');
    // (1)(2) の実行中にタイルが再構築されている可能性があるので同じ画面座標で取り直す
    const repicked = [];
    for (const f of window.__r3.feats) {
      try {
        const p = scene.pick(new Cesium.Cartesian2(f.x, f.y));
        if (p instanceof Cesium.Cesium3DTileFeature) {
          const pos = scene.pickPosition(new Cesium.Cartesian2(f.x, f.y));
          repicked.push({ feature: p, x: f.x, y: f.y, pos: pos || f.pos });
        }
      } catch (_) { /* noop */ }
    }
    const feats = repicked.length >= 2 ? repicked : window.__r3.feats;
    window.__r3.feats = feats;
    const A = feats[0];
    const B = feats.find((f, i) => i > 0 && f.feature !== A.feature) || null;
    const out = { cases: [], sunRay: null, errors: [] };
    const describe = (r) => {
      if (!r) return { hit: false, object: null };
      return {
        hit: !!r.position,
        object: r.object ? r.object.constructor.name : null,
        isA: r.object === A.feature,
        isB: !!(B && r.object === B.feature),
      };
    };
    const run = (label, ray, exclude) => {
      try {
        const r = scene.pickFromRay(ray, exclude);
        out.cases.push({ label, ...describe(r) });
      } catch (e) {
        out.cases.push({ label, error: String(e).slice(0, 200) });
      }
    };
    // 3a: カメラ→建物A のレイ。除外なし／A除外／Aのprimitive(タイルセット全体)除外
    const rayA = viewer.camera.getPickRay(new Cesium.Cartesian2(A.x, A.y));
    run('A: 除外なし', rayA, undefined);
    run('A: [featureA] を除外', rayA, [A.feature]);
    let primA = null;
    try { primA = A.feature.primitive; } catch (_) { /* noop */ }
    if (primA) run('A: [featureA.primitive(=tileset)] を除外', rayA, [primA]);
    // 3b: カメラ→建物B のレイに A除外を渡す（除外がタイルセット全体を消していないかの確認）
    if (B) {
      const rayB = viewer.camera.getPickRay(new Cesium.Cartesian2(B.x, B.y));
      run('B: 除外なし', rayB, undefined);
      run('B: [featureA] を除外', rayB, [A.feature]);
      if (primA) run('B: [featureA.primitive] を除外', rayB, [primA]);
    }
    // 3c: 実運用シナリオ — 建物Aの3階相当の高さから太陽方向へ93本
    //     クリック面上の点（surface）と、そこから水平にカメラの逆方向へ2m押し込んだ点
    //     （inward = 建物内部相当）の両方で、除外あり/なしの日照スロット数を比較する。
    try {
      const carto = Cesium.Cartographic.fromCartesian(A.pos);
      const lon = Cesium.Math.toDegrees(carto.longitude);
      const lat = Cesium.Math.toDegrees(carto.latitude);
      let zmin = null, zmax = null;
      try { zmin = Number(A.feature.getProperty('_zmin')); } catch (_) { /* noop */ }
      try { zmax = Number(A.feature.getProperty('_zmax')); } catch (_) { /* noop */ }
      const base = Number.isFinite(zmin) ? zmin : 35;
      const floorH = base + 1.2 + 3.0 * 2; // 3階相当
      const enu = Cesium.Transforms.eastNorthUpToFixedFrame(
        Cesium.Cartesian3.fromDegrees(lon, lat, floorH)
      );
      const RAD = Math.PI / 180;
      const dates = solar.solarKeyDates(new Date().getFullYear());
      const dirs = [];
      for (const d of dates) {
        for (const s of solar.sampleDay(d.year, d.month, d.day, lon, lat, { hourStart: 7, hourEnd: 17, stepMinutes: 20 })) {
          if (s.elevationDeg >= 5) {
            const e = s.elevationDeg * RAD, a = s.azimuthDeg * RAD;
            const v = new Cesium.Cartesian3(Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e));
            const ecef = Cesium.Matrix4.multiplyByPointAsVector(enu, v, new Cesium.Cartesian3());
            dirs.push(Cesium.Cartesian3.normalize(ecef, ecef));
          }
        }
      }
      // 建物内部方向 = カメラ→クリック点 の水平成分（見えている面の裏側へ入る向き）
      const camToPt = Cesium.Cartesian3.subtract(A.pos, viewer.camera.positionWC, new Cesium.Cartesian3());
      const up = Cesium.Cartesian3.normalize(A.pos, new Cesium.Cartesian3());
      const vert = Cesium.Cartesian3.multiplyByScalar(up, Cesium.Cartesian3.dot(camToPt, up), new Cesium.Cartesian3());
      const horiz = Cesium.Cartesian3.subtract(camToPt, vert, new Cesium.Cartesian3());
      Cesium.Cartesian3.normalize(horiz, horiz);
      const inwardOffset = Cesium.Cartesian3.multiplyByScalar(horiz, 2.0, new Cesium.Cartesian3());

      const originSurface = Cesium.Cartesian3.fromDegrees(lon, lat, floorH);
      const originInward = Cesium.Cartesian3.add(originSurface, inwardOffset, new Cesium.Cartesian3());
      const count = (origin, exclude) => {
        const ray = new Cesium.Ray(origin, new Cesium.Cartesian3());
        let lit = 0, hitA = 0, hitOther = 0, err = 0;
        for (const d of dirs) {
          // 太陽方向は同一地点なので原点が数m動いても使い回してよい
          ray.direction = d;
          try {
            const r = scene.pickFromRay(ray, exclude);
            if (!(r && r.position)) lit++;
            else if (r.object === A.feature) hitA++;
            else hitOther++;
          } catch (_) { err++; }
        }
        return { lit, hitA, hitOther, err, total: dirs.length };
      };
      const roofH = Number.isFinite(zmax) ? zmax + 1.2 : null;
      const roof = roofH == null ? null : {
        height: roofH,
        ...count(Cesium.Cartesian3.fromDegrees(lon, lat, roofH), undefined),
      };
      out.sunRay = {
        lon, lat, zmin, zmax, floorHeight: floorH, slots: dirs.length,
        surface: {
          without: count(originSurface, undefined),
          withFeatureExclude: count(originSurface, [A.feature]),
          withPrimitiveExclude: primA ? count(originSurface, [primA]) : null,
        },
        inward2m: {
          without: count(originInward, undefined),
          withFeatureExclude: count(originInward, [A.feature]),
          withPrimitiveExclude: primA ? count(originInward, [primA]) : null,
        },
        roof,
      };
    } catch (e) {
      out.errors.push('3c: ' + String(e).slice(0, 300));
    }
    return out;
  });
  for (const c of excl.cases) dump('case', c);
  if (excl.sunRay) {
    say(`  --- 3c: 自建物の3階相当から太陽方向${excl.sunRay.slots}本（lit=遮蔽なし=日照スロット数） ---`);
    dump('geom', {
      lon: excl.sunRay.lon?.toFixed(6), lat: excl.sunRay.lat?.toFixed(6),
      zmin: excl.sunRay.zmin, zmax: excl.sunRay.zmax,
      floorHeight: excl.sunRay.floorHeight?.toFixed(1),
    });
    for (const [where, k] of [['クリック面上', 'surface'], ['内部2m', 'inward2m']]) {
      dump(`${where} 除外なし`, excl.sunRay[k].without);
      dump(`${where} featureA除外`, excl.sunRay[k].withFeatureExclude);
      dump(`${where} tileset除外`, excl.sunRay[k].withPrimitiveExclude);
    }
    dump('屋上(_zmax+1.2) 除外なし', excl.sunRay.roof);
  }
  if (excl.errors.length) dump('errors', excl.errors);
  results.objectsToExclude = excl;
  check('objectsToExclude の検証を実行できる', excl.cases.length > 0, `cases=${excl.cases.length}`);

  // ==== (4) sampleHeightMostDetailed 441点 ==========================================
  say('\n=== (4) scene.sampleHeightMostDetailed 441点（64点バッチ） ===');
  const sampleH = await page.evaluate(async () => {
    const { scene } = window.__r3;
    const { lon, lat } = window.__r3.lonLatBase;
    const out = { supported: scene.sampleHeightSupported, batches: [], errors: [] };
    const pts = [];
    const step = 10; // m
    for (let iy = -10; iy <= 10; iy++) {
      for (let ix = -10; ix <= 10; ix++) {
        const dLat = (iy * step) / 111320;
        const dLon = (ix * step) / (111320 * Math.cos(lat * Math.PI / 180));
        pts.push(Cesium.Cartographic.fromDegrees(lon + dLon, lat + dLat));
      }
    }
    out.pointCount = pts.length;
    const heights = [];
    const tAll = performance.now();
    for (let i = 0; i < pts.length; i += 64) {
      const batch = pts.slice(i, i + 64);
      const t0 = performance.now();
      try {
        const res = await Promise.race([
          scene.sampleHeightMostDetailed(batch),
          new Promise((r) => setTimeout(() => r('__timeout__'), 120000)),
        ]);
        const ms = performance.now() - t0;
        if (res === '__timeout__') {
          out.batches.push({ i, n: batch.length, ms, status: 'timeout' });
          continue;
        }
        let ok = 0;
        for (const c of res) {
          if (Number.isFinite(c?.height)) { ok++; heights.push(c.height); }
        }
        out.batches.push({ i, n: batch.length, ms, status: 'ok', resolved: ok });
      } catch (e) {
        out.batches.push({ i, n: batch.length, ms: performance.now() - t0, status: 'throw' });
        out.errors.push(String(e).slice(0, 200));
      }
    }
    out.totalMs = performance.now() - tAll;
    out.resolvedCount = heights.length;
    out.failedCount = pts.length - heights.length;
    if (heights.length) {
      heights.sort((a, b) => a - b);
      out.heightMin = heights[0];
      out.heightMax = heights[heights.length - 1];
      out.heightMedian = heights[Math.floor(heights.length / 2)];
      out.heightP25 = heights[Math.floor(heights.length * 0.25)];
      out.heightP75 = heights[Math.floor(heights.length * 0.75)];
      // このアプリは地形プロバイダを載せていないので、建物に当たらない点は
      // 楕円体（≒0m）が返るはず。地盤高として使えるかの判断材料に分布を数える。
      out.nearZeroCount = heights.filter((h) => Math.abs(h) < 0.5).length;
      out.aboveBuildingBaseCount = heights.filter((h) => h > 20).length;
      out.between = heights.filter((h) => Math.abs(h) >= 0.5 && h <= 20).length;
    }
    return out;
  });
  say(`  sampleHeightSupported=${sampleH.supported}、点数=${sampleH.pointCount}、バッチ=${sampleH.batches.length}`);
  for (const b of sampleH.batches) dump('batch', { ...b, ms: Math.round(b.ms) });
  say(`  合計=${Math.round(sampleH.totalMs)}ms、成功=${sampleH.resolvedCount}点、失敗=${sampleH.failedCount}点`);
  say(`  高さ範囲: min=${fmt(sampleH.heightMin)} p25=${fmt(sampleH.heightP25)} median=${
    fmt(sampleH.heightMedian)} p75=${fmt(sampleH.heightP75)} max=${fmt(sampleH.heightMax)}`);
  say(`  高さの内訳: |h|<0.5m（楕円体＝地形なし）=${sampleH.nearZeroCount}点 / 0.5〜20m=${
    sampleH.between}点 / >20m（建物面）=${sampleH.aboveBuildingBaseCount}点`);
  if (sampleH.errors.length) dump('errors', sampleH.errors);
  results.sampleHeightMostDetailed = sampleH;
  check('sampleHeightMostDetailed が441点で完走する',
    sampleH.batches.length === 7 && sampleH.batches.every((b) => b.status === 'ok'),
    JSON.stringify(sampleH.batches.map((b) => b.status)));

  // ==== (5) maximumScreenSpaceError 16→8→16 ========================================
  say('\n=== (5) maximumScreenSpaceError 16→8 のメモリ変化と復元挙動 ===');
  const msse = await page.evaluate(async () => {
    const ts = window.__nakano.loaded.bldgLod2;
    const out = { available: !!ts, samples: [], errors: [] };
    if (!ts) return out;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const snap = (phase, tSec) => {
      const s = ts.statistics;
      out.samples.push({
        phase, tSec,
        // 描画ループが回っていることの対照（frameNumber が進めば統計は最新）
        frame: window.__nakano.viewer.scene.frameState.frameNumber,
        msse: ts.maximumScreenSpaceError,
        memMB: +(ts.totalMemoryUsageInBytes / 1048576).toFixed(1),
        geomMB: +(s.geometryByteLength / 1048576).toFixed(1),
        texMB: +(s.texturesByteLength / 1048576).toFixed(1),
        cacheBytesMB: +(ts.cacheBytes / 1048576).toFixed(1),
        tilesLoaded: ts.tilesLoaded,
        selected: s.selected,
        visited: s.visited,
        numberOfPendingRequests: s.numberOfPendingRequests,
        numberOfTilesProcessing: s.numberOfTilesProcessing,
        numberOfTilesWithContentReady: s.numberOfTilesWithContentReady,
        numberOfTilesTotal: s.numberOfTilesTotal,
        numberOfLoadedTilesTotal: s.numberOfLoadedTilesTotal,
        numberOfAttemptedRequests: s.numberOfAttemptedRequests,
      });
    };
    // タイル木の構造（msse を下げて refine の余地があるのかを判断する材料）
    try {
      const root = ts.root;
      let maxDepth = 0, nodes = 0, leaves = 0;
      const geErrors = [];
      const walk = (tile, depth) => {
        nodes++;
        maxDepth = Math.max(maxDepth, depth);
        geErrors.push(tile.geometricError);
        const ch = tile.children || [];
        if (!ch.length) leaves++;
        for (const c of ch) walk(c, depth + 1);
      };
      walk(root, 0);
      out.tree = {
        rootGeometricError: root.geometricError,
        nodes, leaves, maxDepth,
        refine: root.refine === Cesium.Cesium3DTileRefine.REPLACE ? 'REPLACE' : 'ADD',
        geometricErrorMin: Math.min(...geErrors),
        geometricErrorMax: Math.max(...geErrors),
        distinctGeometricErrors: [...new Set(geErrors)].sort((a, b) => b - a).slice(0, 10),
      };
    } catch (e) {
      out.errors.push('tree: ' + String(e).slice(0, 200));
    }

    const original = ts.maximumScreenSpaceError;
    out.original = original;
    // 視点2条件で試す: 現在の駅前(500m) と、より広域の俯瞰(1800m)。
    // 広域では粗いLODが選ばれるので msse を下げた効果が出るはず。
    const views = [
      { name: '駅前500m', p: { lon: 139.6659, lat: 35.7010, height: 500, heading: 0, pitch: -40 } },
      { name: '広域1800m', p: { lon: 139.6659, lat: 35.7060, height: 1800, heading: 0, pitch: -50 } },
      // 遠方の建物が効くケース（区境〜新宿方向を低いピッチで見る）。
      // 遠いタイルほど画面誤差が小さく、msse を下げた効果が出やすい条件。
      { name: '低ピッチ東向き200m', p: { lon: 139.6659, lat: 35.7010, height: 200, heading: 90, pitch: -5 } },
    ];
    for (const v of views) {
      try {
        window.__nakano.flyTo(v.p, 0);
        await sleep(6000);
        snap(`${v.name} before(msse=16)`, 0);
        ts.maximumScreenSpaceError = 8;
        for (let i = 1; i <= 10; i++) {
          await sleep(2500);
          snap(`${v.name} msse=8`, i * 2.5);
          if (ts.tilesLoaded && i >= 3) break;
        }
      } catch (e) {
        out.errors.push(`${v.name} msse=8: ` + String(e).slice(0, 200));
      } finally {
        try { ts.maximumScreenSpaceError = original; } catch (e) { out.errors.push('restore: ' + String(e).slice(0, 200)); }
      }
      for (let i = 1; i <= 8; i++) {
        await sleep(2500);
        snap(`${v.name} restored(msse=16)`, i * 2.5);
        if (ts.tilesLoaded && i >= 3) break;
      }
    }
    out.finalMsse = ts.maximumScreenSpaceError;
    out.loadedAfterRestore = ts.tilesLoaded;
    return out;
  });
  if (msse.tree) dump('タイル木', msse.tree);
  for (const s of msse.samples) dump('sample', s);
  if (msse.errors.length) dump('errors', msse.errors);
  for (const view of ['駅前500m', '広域1800m', '低ピッチ東向き200m']) {
    const at16 = msse.samples.filter((s) => s.phase === `${view} before(msse=16)`);
    const at8 = msse.samples.filter((s) => s.phase === `${view} msse=8`);
    const after = msse.samples.filter((s) => s.phase === `${view} restored(msse=16)`);
    if (!at16.length) continue;
    say(`  [${view}] msse=16(開始): mem=${at16[0].memMB}MB tex=${at16[0].texMB}MB tiles=${
      at16[0].numberOfTilesWithContentReady} selected=${at16[0].selected}`);
    say(`  [${view}] msse=8(最終): mem=${at8.at(-1)?.memMB}MB tex=${at8.at(-1)?.texMB}MB tiles=${
      at8.at(-1)?.numberOfTilesWithContentReady} selected=${at8.at(-1)?.selected} 最大mem=${
      Math.max(...at8.map((s) => s.memMB))}MB`);
    say(`  [${view}] msse=16復元(最終): mem=${after.at(-1)?.memMB}MB tiles=${
      after.at(-1)?.numberOfTilesWithContentReady} selected=${after.at(-1)?.selected}`);
    say(`  [${view}] 対照(描画ループ): frameNumber ${at16[0].frame} → ${after.at(-1)?.frame}`);
  }
  say(`  復元値=${msse.finalMsse}（元の値=${msse.original}）`);
  results.msse = msse;
  check('maximumScreenSpaceError を変更して復元できる', msse.finalMsse === msse.original,
    `original=${msse.original}, final=${msse.finalMsse}`);

  // ==== まとめ ====
  say('\n=== JSエラー ===');
  const fatal = t.errors.filter((e) => e.startsWith('PAGEERROR') || /SyntaxError|is not a function/.test(e));
  say(`  致命的: ${fatal.length}件 ${JSON.stringify(fatal.slice(0, 4))}`);
  if (t.errors.length) say(`  (参考) console errors: ${JSON.stringify(t.errors.slice(0, 8))}`);
  check('probe中に致命的なJSエラーが出ない', fatal.length === 0, JSON.stringify(fatal.slice(0, 3)));
  say(`  中継: ${JSON.stringify(t.relay)}`);
} finally {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'r3-probe.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'r3-probe.log'), log.join('\n'));
  await t.close();
}

report('r3-probe.mjs');

// ---- ユーティリティ ---------------------------------------------------------

function stats(arr) {
  if (!arr || !arr.length) return { n: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    n: s.length,
    mean: +mean.toFixed(3),
    median: +s[Math.floor(s.length / 2)].toFixed(3),
    p90: +s[Math.min(s.length - 1, Math.floor(s.length * 0.9))].toFixed(3),
    min: +s[0].toFixed(3),
    max: +s[s.length - 1].toFixed(3),
  };
}

function fmt(v) {
  return Number.isFinite(v) ? v.toFixed(2) : String(v);
}
