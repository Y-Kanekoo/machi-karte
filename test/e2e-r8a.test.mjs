// R8a-P0（manifest・表示品質プロファイル）のブラウザ統合テスト
// 実行: node test/e2e-r8a.test.mjs（事前に `npm run serve` が必要）

import {
  BASE_URL,
  launchViewer,
  openSection,
  check,
  equal,
  report,
  shotPath,
} from './harness.mjs';

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

  await openSection(page, 'buildingModelSection');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 180000 }),
    page.evaluate(() => {
      const high = document.getElementById('qualityHigh');
      high.checked = true;
      high.dispatchEvent(new Event('change', { bubbles: true }));
    }),
  ]);
  await waitForInitialBuilding(page);
  const highState = await page.evaluate(() => {
    const profile = window.__nakano.qualityProfile;
    const building = window.__nakano.getBuildingState();
    return {
      qualityParam: new URL(location.href).searchParams.get('quality'),
      saved: localStorage.getItem('quality'),
      profileName: window.__nakano.qualityProfileName,
      layerKind: building.layerKind,
      maximumScreenSpaceError: building.tileset.maximumScreenSpaceError,
      cacheBytes: building.tileset.cacheBytes,
      dynamicScreenSpaceError: profile.dynamicScreenSpaceError,
      resolutionScale: profile.resolutionScale,
      requestRenderMode: profile.requestRenderMode,
    };
  });
  equal('品質変更後はURLのquality指定を除去する', highState.qualityParam, null);
  equal('URL上書き除去後は保存済み高画質を適用する', highState.saved, 'high');
  equal('再読み込み後の実効プロファイルは高画質', highState.profileName, 'high');
  equal('高画質プロファイルの初期レイヤーはLOD2', highState.layerKind, 'lod2');
  equal('高画質のmaximumScreenSpaceErrorは既定PCと同じ16', highState.maximumScreenSpaceError, 16);
  equal('高画質のcacheBytesは既定PCと同じ512MB', highState.cacheBytes, 512 * MEBIBYTE);
  equal('高画質のdynamicScreenSpaceErrorは既定PCと同じfalse', highState.dynamicScreenSpaceError, false);
  equal('高画質のresolutionScaleは既定PCと同じ1', highState.resolutionScale, 1);
  equal('高画質は既定PCと同じ連続描画', highState.requestRenderMode, false);
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

  const toastElements = await page.evaluate(() => {
    const shared = document.getElementById('toast');
    const swUpdate = document.getElementById('swUpdateToast');
    return {
      sharedExists: !!shared,
      swUpdateExists: !!swUpdate,
      distinct: shared !== swUpdate,
    };
  });
  check(
    'SW更新通知トーストは共有・比較トーストと別要素',
    toastElements.sharedExists && toastElements.swUpdateExists && toastElements.distinct,
  );
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

  await page.evaluate(() => window.__nakano.compare.add());
  await page.waitForSelector('#compareBar:not(.hidden)');
  await page.evaluate(() => window.__nakano.bottomSheet.setState('full'));
  await page.waitForTimeout(350);
  const mobileLayout = await page.evaluate(() => {
    const sheet = document.getElementById('diagnosisPanel');
    const bar = document.getElementById('compareBar');
    const barBox = bar.getBoundingClientRect();
    const hitTarget = document.elementFromPoint(
      (barBox.left + barBox.right) / 2,
      (barBox.top + barBox.bottom) / 2,
    );
    return {
      panelBottomPx: parseFloat(getComputedStyle(sheet).bottom),
      barH: bar.offsetHeight,
      barRect: { top: barBox.top, bottom: barBox.bottom },
      innerH: innerHeight,
      hitTest: hitTarget === bar || bar.contains(hitTarget),
      sheetZIndex: Number(getComputedStyle(sheet).zIndex),
      compareZIndex: Number(getComputedStyle(bar).zIndex),
    };
  });
  check(
    'モバイルで診断シートと比較バーが重ならない',
    mobileLayout.panelBottomPx >= mobileLayout.barH - 1
      && mobileLayout.barRect.bottom <= mobileLayout.innerH + 1
      && mobileLayout.barRect.top >= 0
      && mobileLayout.hitTest === true,
    JSON.stringify(mobileLayout),
  );
  check(
    '比較バーは診断シートより前面で操作できる',
    mobileLayout.compareZIndex > mobileLayout.sheetZIndex,
    JSON.stringify(mobileLayout),
  );
  await page.evaluate(() => window.__nakano.compare.clearAll());
  await page.evaluate(() => window.__nakano.bottomSheet.setState('half'));
  await page.waitForTimeout(350);
  await page.screenshot({ path: shotPath('r8a-p2-bottomsheet-half.png') });

  await openSection(page, 'buildingModelSection');
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
  const readQualityFromLocalStorage = async () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await page.waitForFunction(
          () => document.readyState === 'complete',
          { timeout: 30000 },
        );
        return await page.evaluate(() => localStorage.getItem('quality'));
      } catch (error) {
        if (!String(error).includes('Execution context was destroyed') || attempt === 3) {
          throw error;
        }
        await page.waitForTimeout(300);
      }
    }
    throw new Error('localStorageの読み取りに失敗しました');
  };
  equal(
    '高画質選択をlocalStorageへ保存する',
    await readQualityFromLocalStorage(),
    'high',
  );
} finally {
  await mobileViewer.close();
}

console.log('\n=== Service Worker登録 ===');
const swViewer = await launchViewer({
  viewport: { width: 1280, height: 720 },
  goto: false,
});
try {
  const { page } = swViewer;
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    const text = message.text();
    const isExpectedResource404 = text.includes('Failed to load resource')
      && text.includes('404');
    if (message.type() === 'error' && !isExpectedResource404) {
      consoleErrors.push(text.slice(0, 300));
    }
  });
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 400)));
  const registrationAttempt = page.waitForEvent('console', {
    predicate: (message) => message.type() === 'warning'
      && message.text().includes('Service Workerを登録できませんでした'),
    timeout: 20000,
  }).then(() => true, () => false);

  // launchViewerの自動遷移を使わず、noswなしで登録処理を実行させる。
  await page.goto(BASE_URL, { waitUntil: 'load', timeout: 180000 });
  const registrationBlocked = await registrationAttempt;
  await page.waitForFunction(() => !!window.__nakano?.diagnosis);
  const diagnosisState = await page.evaluate(async () => {
    const result = await window.__nakano.diagnosis.runDiagnosisAt(139.6686, 35.7056, {
      title: '中野駅',
      fly: false,
      skipSunlight: true,
    });
    return {
      title: result.title,
      panelVisible: !document.getElementById('diagnosisPanel')?.classList.contains('hidden'),
    };
  });

  check(
    'SW登録はブロック環境でもグレースフルに失敗する',
    registrationBlocked
      && consoleErrors.length === 0
      && pageErrors.length === 0
      && diagnosisState.title === '中野駅'
      && diagnosisState.panelVisible,
    `登録失敗警告=${registrationBlocked}, コンソールエラー=${JSON.stringify(consoleErrors)}, `
      + `pageerror=${JSON.stringify(pageErrors)}, `
      + `診断=${JSON.stringify(diagnosisState)}`,
  );
} finally {
  await swViewer.close();
}

report('R8a e2e');
