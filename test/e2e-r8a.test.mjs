// R8a-P0（manifest・表示品質プロファイル）のブラウザ統合テスト
// 実行: node test/e2e-r8a.test.mjs（事前に `npm run serve` が必要）

import {
  BASE_URL,
  launchViewer,
  check,
  equal,
  report,
} from './harness.mjs';
import { chromium } from 'playwright';
import fs from 'node:fs';

const MEBIBYTE = 1024 * 1024;

async function waitForInitialBuilding(page) {
  await page.waitForFunction(
    () => !!window.__nakano?.getBuildingState().tileset,
    null,
    { timeout: 180000, polling: 500 },
  );
}

console.log('\n=== 軽量プロファイル ===');
const lightViewer = await launchViewer({
  viewport: { width: 1440, height: 900 },
  url: BASE_URL + '?quality=light',
});
try {
  const { page } = lightViewer;
  await waitForInitialBuilding(page);
  const state = await page.evaluate(() => {
    const building = window.__nakano.getBuildingState();
    return {
      profile: window.__nakano.qualityProfileName,
      layerKind: building.layerKind,
      checkedLayer: document.querySelector('input[name="bldg"]:checked')?.value,
      maximumScreenSpaceError: building.tileset.maximumScreenSpaceError,
      cacheBytes: building.tileset.cacheBytes,
    };
  });
  equal('URL指定で軽量プロファイルを選ぶ', state.profile, 'light');
  equal('軽量プロファイルの初期レイヤーはLOD1', state.layerKind, 'lod1');
  equal('建物レイヤーUIもLOD1を示す', state.checkedLayer, 'lod1');
  equal('軽量プロファイルのmaximumScreenSpaceErrorは24', state.maximumScreenSpaceError, 24);
  equal('軽量プロファイルのcacheBytesは128MB', state.cacheBytes, 128 * MEBIBYTE);
} finally {
  await lightViewer.close();
}

console.log('\n=== 既定PCプロファイル ===');
const defaultViewer = await launchViewer({ viewport: { width: 1440, height: 900 } });
try {
  const { page } = defaultViewer;
  await waitForInitialBuilding(page);
  const state = await page.evaluate(() => {
    const building = window.__nakano.getBuildingState();
    return {
      profile: window.__nakano.qualityProfileName,
      layerKind: building.layerKind,
      checkedLayer: document.querySelector('input[name="bldg"]:checked')?.value,
      maximumScreenSpaceError: building.tileset.maximumScreenSpaceError,
      cacheBytes: building.tileset.cacheBytes,
    };
  });
  equal('品質未指定のPC相当は既定プロファイル', state.profile, 'default');
  equal('既定PCプロファイルの初期レイヤーはLOD2', state.layerKind, 'lod2');
  equal('建物レイヤーUIもLOD2を示す', state.checkedLayer, 'lod2');
  equal('既定PCのmaximumScreenSpaceErrorは16のまま', state.maximumScreenSpaceError, 16);
  equal('既定PCのcacheBytesは512MBのまま', state.cacheBytes, 512 * MEBIBYTE);

  const manifest = await page.evaluate(async () => {
    const response = await fetch('manifest.json');
    return {
      ok: response.ok,
      status: response.status,
      body: response.ok ? await response.json() : null,
    };
  });
  check('manifest.jsonをfetchできる', manifest.ok, `status=${manifest.status}`);
  equal('manifestのname', manifest.body?.name, '3D街カルテ');
  check('manifestにiconsがある', Array.isArray(manifest.body?.icons) && manifest.body.icons.length > 0);
  equal('manifestのstart_url', manifest.body?.start_url, './?source=pwa');
  equal('manifestのscope', manifest.body?.scope, './');
  equal('manifestのdisplay', manifest.body?.display, 'standalone');
} finally {
  await defaultViewer.close();
}

console.log('\n=== Service Worker登録 ===');
let swBrowser;
try {
  const launchOptions = {
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  };
  const chromiumPath = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
  if (fs.existsSync(chromiumPath)) launchOptions.executablePath = chromiumPath;
  swBrowser = await chromium.launch(launchOptions);
} catch (error) {
  console.warn(`  skip Service Worker対応ブラウザを起動できませんでした: ${error}`);
}

if (swBrowser) {
  try {
    const context = await swBrowser.newContext({ viewport: { width: 1280, height: 720 } });
    const baseOrigin = new URL(BASE_URL).origin;
    await context.route('**/*', (route) => {
      const requestOrigin = new URL(route.request().url()).origin;
      return requestOrigin === baseOrigin ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 180000 });
    const supported = await page.evaluate(() => 'serviceWorker' in navigator);
    if (!supported) {
      console.warn('  skip ブラウザがService Workerに対応していません');
    } else {
      const swState = await page.evaluate(async () => {
        try {
          const registration = await Promise.race([
            navigator.serviceWorker.ready,
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error('登録待ちがタイムアウトしました')), 20000);
            }),
          ]);
          return {
            active: registration.active?.state === 'activated',
            scriptURL: registration.active?.scriptURL || '',
          };
        } catch (error) {
          return { active: false, scriptURL: '', error: String(error) };
        }
      });
      check(
        '素の起動でService Workerが登録・有効化される',
        swState.active && swState.scriptURL.endsWith('/sw.js'),
        swState.error || swState.scriptURL,
      );
    }
  } finally {
    await swBrowser.close();
  }
}

report('R8a e2e');
