// R8a-P0（manifest・表示品質プロファイル）のブラウザ統合テスト
// 実行: node test/e2e-r8a.test.mjs（事前に `npm run serve` が必要）

import {
  BASE_URL,
  launchViewer,
  check,
  equal,
  report,
  shotPath,
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

console.log('\n=== モバイルUI ===');
const mobileViewer = await launchViewer({
  viewport: { width: 390, height: 844 },
  contextOptions: { hasTouch: true, isMobile: true },
});
try {
  const { page } = mobileViewer;
  await page.waitForFunction(() => !!window.__nakano?.bottomSheet);
  await page.evaluate(() => {
    void window.__nakano.diagnosis.runDiagnosisAt(139.6686, 35.7056, {
      title: '中野駅',
      fly: false,
      skipSunlight: true,
    });
  });
  await page.waitForSelector('#diagnosisPanel:not(.hidden)');
  await page.waitForFunction(
    () => document.getElementById('diagnosisPanel')?.dataset.sheetState === 'half',
  );

  const initialSheet = await page.evaluate(() => ({
    state: window.__nakano.bottomSheet.getState(),
    bodyOpen: document.body.classList.contains('sheet-open'),
    role: document.getElementById('diagnosisPanel')?.getAttribute('role'),
    label: document.getElementById('diagnosisPanel')?.getAttribute('aria-label'),
    handleRole: document.querySelector('.sheet-handle')?.getAttribute('role'),
  }));
  equal('モバイル診断シートの初期状態はhalf', initialSheet.state, 'half');
  check('診断シート表示中はbodyにsheet-openが付く', initialSheet.bodyOpen);
  equal('診断シートはdialogロールを持つ', initialSheet.role, 'dialog');
  equal('診断シートにアクセシブル名がある', initialSheet.label, '街カルテ 診断結果');
  equal('シートハンドルはbuttonロールを持つ', initialSheet.handleRole, 'button');

  await page.locator('.sheet-handle').dispatchEvent('keydown', { key: 'ArrowDown' });
  equal(
    'ハンドル操作でpeekへ遷移する',
    await page.locator('#diagnosisPanel').getAttribute('data-sheet-state'),
    'peek',
  );
  await page.locator('.sheet-handle').dispatchEvent('keydown', { key: 'ArrowUp' });
  equal(
    'ハンドル操作でhalfへ戻る',
    await page.locator('#diagnosisPanel').getAttribute('data-sheet-state'),
    'half',
  );
  await page.locator('.sheet-handle').dispatchEvent('keydown', { key: 'ArrowUp' });
  const fullSheet = await page.evaluate(() => {
    const body = document.getElementById('diagBody');
    return {
      state: document.getElementById('diagnosisPanel')?.dataset.sheetState,
      overflowY: getComputedStyle(body).overflowY,
    };
  });
  equal('ハンドル操作でfullへ遷移する', fullSheet.state, 'full');
  equal('full状態ではシート内スクロールが有効', fullSheet.overflowY, 'auto');

  await page.locator('.sheet-handle').dispatchEvent('keydown', { key: 'ArrowDown' });
  const halfSheet = await page.evaluate(() => {
    const body = document.getElementById('diagBody');
    return {
      state: document.getElementById('diagnosisPanel')?.dataset.sheetState,
      overflowY: getComputedStyle(body).overflowY,
    };
  });
  equal('fullからhalfへ遷移する', halfSheet.state, 'half');
  equal('half状態ではシート内スクロールが無効', halfSheet.overflowY, 'hidden');
  await page.screenshot({ path: shotPath('r8a-p2-bottomsheet-half.png') });

  const qualityUi = await page.evaluate(() => ({
    text: document.getElementById('qualityControl')?.textContent.replace(/\s+/g, ' ').trim(),
    lightChecked: document.getElementById('qualityLight')?.checked,
    highChecked: document.getElementById('qualityHigh')?.checked,
  }));
  check(
    '表示品質ラジオに軽量と高画質が表示される',
    qualityUi.text.includes('表示品質:')
      && qualityUi.text.includes('軽量（推奨）')
      && qualityUi.text.includes('高画質'),
    qualityUi.text,
  );
  check('モバイル初期値は軽量ラジオ', qualityUi.lightChecked && !qualityUi.highChecked);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 180000 }),
    page.evaluate(() => {
      const high = document.getElementById('qualityHigh');
      high.checked = true;
      high.dispatchEvent(new Event('change', { bubbles: true }));
    }),
  ]);
  equal(
    '高画質選択をlocalStorageへ保存する',
    await page.evaluate(() => localStorage.getItem('quality')),
    'high',
  );
} finally {
  await mobileViewer.close();
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
