// 診断カード「相場」セクション（不動産情報ライブラリのスナップショット表示）の検証。
// 実行: node test/e2e-price.test.mjs（事前に `npm run serve` が必要）
// 実スナップショットは API キー取得後まで存在しないため、表示側の検証は
// page.route でフィクスチャ JSON を差し込んで行う（実データではない）。

import { launchViewer, waitForViewerReady, check, report } from './harness.mjs';

const SNAPSHOT = {
  metadata: {
    source: '出典：国土交通省 不動産情報ライブラリ',
    api: 'XIT001 不動産価格（取引価格・成約価格）情報取得API',
    city: '13114',
    area: '13',
    year: 2026,
    quarter: 2,
    fetchedAt: '2026-11-16',
    count: 3,
  },
  summary: {
    all: {
      count: 3, medianPricePerUnit: 623000, meanPricePerUnit: 610000,
      minPricePerUnit: 400000, maxPricePerUnit: 800000,
      medianTradePrice: 39800000, period: '2026年第2四半期', districtNames: ['中野'],
    },
    condominium: {
      count: 2, medianPricePerUnit: 623000, meanPricePerUnit: 615000,
      minPricePerUnit: 446000, maxPricePerUnit: 800000,
      medianTradePrice: 39800000, period: '2026年第2四半期', districtNames: ['中野'],
    },
    land: {
      count: 1, medianPricePerUnit: 450000, meanPricePerUnit: 450000,
      minPricePerUnit: 450000, maxPricePerUnit: 450000,
      medianTradePrice: 45000000, period: '2026年第2四半期', districtNames: ['本町'],
    },
  },
  rows: [],
};

async function runDiagnosis(page) {
  await page.evaluate(async () => {
    await window.__nakano.diagnosis.runDiagnosisAt(139.6686, 35.7056, {
      title: '中野駅',
      fly: false,
      skipSunlight: true,
    });
  });
  await page.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 60000 });
}

// A: スナップショット無し（キー取得までの実環境）→ 未収録の空状態
{
  const v = await launchViewer({});
  try {
    await waitForViewerReady(v.page);
    await runDiagnosis(v.page);
    await v.page.waitForFunction(
      () => document.getElementById('secPrice')?.textContent.includes('まだ収録されていません'),
      null,
      { timeout: 30000 },
    );
    const sec = await v.page.evaluate(() => {
      const el = document.querySelector('.diag-sec[data-sec="price"]');
      return {
        exists: !!el,
        heading: el?.querySelector('h3')?.textContent || '',
        collapsible: el?.querySelector('h3')?.getAttribute('role') === 'button',
      };
    });
    check('相場セクションが存在する', sec.exists);
    check('見出しは「相場（取引価格）」', sec.heading.includes('相場（取引価格）'), sec.heading);
    check('他のセクションと同じ折りたたみ見出しになる', sec.collapsible);
  } finally {
    await v.close();
  }
}

// B: スナップショット有り（route 差し込み）→ ヒーロー・内訳・出典
{
  const v = await launchViewer({});
  try {
    await v.page.route('**/data/price-13114.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SNAPSHOT),
    }));
    await waitForViewerReady(v.page);
    await runDiagnosis(v.page);
    await v.page.waitForFunction(
      () => document.querySelector('#secPrice .price-hero-value')?.textContent.includes('62.3'),
      null,
      { timeout: 30000 },
    );
    const text = await v.page.textContent('#secPrice');
    check('ヒーローは中古マンション等㎡単価の中央値', text.includes('中古マンション等 ㎡単価（中央値）'));
    check('宅地の㎡単価を行で表示', text.includes('45万円/㎡'));
    check('取引総額の中央値を表示', text.includes('3,980万円'));
    check('対象期間を表示', text.includes('2026年第2四半期'));
    check('自治体全域の参考値である旨を明記', text.includes('全域の取引事例を集計した参考値'));
    check('出典を表示', text.includes('国土交通省 不動産情報ライブラリ'));
  } finally {
    await v.close();
  }
}

report('e2e-price.test');
