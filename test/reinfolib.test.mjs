// reinfolib.js（不動産情報ライブラリAPIクライアント）の単体テスト
// 実行: node test/reinfolib.test.mjs
//
// 実APIは叩かない。fetch を差し替え、URL・ヘッダ・正規化・集計・四半期探索を検証する。
// フィクスチャは公式マニュアルの項目定義に沿って合成したもの（実データではない）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, equal, near, report } from './harness.mjs';
import {
  buildTransactionsUrl,
  buildCitiesUrl,
  resolveReinfolibApiKey,
  fetchTransactions,
  fetchCities,
  fetchLatestTransactions,
  normalizeTransactions,
  summarizeTransactions,
  quarterCandidates,
  median,
  loadPriceSnapshot,
} from '../js/reinfolib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'reinfolib-xit001.json'), 'utf8')
);

/** fetch のモック。handler(url, opts) が {status, json} を返す */
function mockFetch(handler, calls = []) {
  return async (url, opts) => {
    calls.push({ url: String(url), opts });
    const r = handler(String(url), opts);
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: async () => r.json,
    };
  };
}

console.log('--- URL 組み立て ---');
{
  const url = buildTransactionsUrl({ year: 2025, quarter: 3, area: '13', city: '13114' });
  check('XIT001 のパスを含む', url.includes('/ex-api/external/XIT001'));
  check('year/quarter/area/city が入る',
    url.includes('year=2025') && url.includes('quarter=3') &&
    url.includes('area=13') && url.includes('city=13114'));
  check('priceClassification=01（取引価格）', url.includes('priceClassification=01'));
  const cities = buildCitiesUrl({ area: '13' });
  check('XIT002 のパスと area', cities.includes('/ex-api/external/XIT002') && cities.includes('area=13'));
}

console.log('--- APIキー解決 ---');
{
  equal('明示指定が最優先', resolveReinfolibApiKey({ apiKey: 'A', env: { REINFOLIB_API_KEY: 'B' } }), 'A');
  equal('環境変数から読む', resolveReinfolibApiKey({ env: { REINFOLIB_API_KEY: 'B' } }), 'B');
  equal('無ければ null', resolveReinfolibApiKey({ env: {} }), null);
}

console.log('--- 取得（モック） ---');
{
  // キーが無い場合は fetch を呼ばず available:false
  let called = 0;
  const r0 = await fetchTransactions(
    { year: 2025, quarter: 3, city: '13114' },
    { env: {}, fetchImpl: async () => { called++; throw new Error('must not be called'); } }
  );
  equal('キー無しは available:false', r0.available, false);
  equal('キー無しは reason=no-api-key', r0.reason, 'no-api-key');
  equal('キー無しは fetch を呼ばない', called, 0);

  // 正常系: ヘッダにキーが載り、URL には載らない
  const calls = [];
  const r1 = await fetchTransactions(
    { year: 2025, quarter: 3, area: '13', city: '13114' },
    { apiKey: 'TESTKEY', fetchImpl: mockFetch(() => ({ status: 200, json: fixture }), calls) }
  );
  equal('正常系は available:true', r1.available, true);
  equal('フィクスチャ4件が返る', r1.rows.length, 4);
  equal('ヘッダ Ocp-Apim-Subscription-Key にキーが載る',
    calls[0].opts.headers['Ocp-Apim-Subscription-Key'], 'TESTKEY');
  check('URL にキーを含めない', !calls[0].url.includes('TESTKEY'));

  // 404 は「データなし」（公式仕様）であり例外にしない
  const r2 = await fetchTransactions(
    { year: 2025, quarter: 3, city: '13114' },
    { apiKey: 'K', fetchImpl: mockFetch(() => ({ status: 404, json: {} })) }
  );
  equal('404 は notFound', r2.notFound, true);
  equal('404 は rows 空', r2.rows.length, 0);

  // 500 は例外
  let threw = false;
  try {
    await fetchTransactions(
      { year: 2025, quarter: 3, city: '13114' },
      { apiKey: 'K', fetchImpl: mockFetch(() => ({ status: 500, json: {} })) }
    );
  } catch { threw = true; }
  check('500 は例外を投げる', threw);

  // XIT002
  const rc = await fetchCities(
    { area: '13' },
    { apiKey: 'K', fetchImpl: mockFetch(() => ({ status: 200, json: { status: 'OK', data: [{ id: '13114', name: '中野区' }] } })) }
  );
  equal('XIT002 の市区町村が読める', rc.cities[0]?.name, '中野区');
}

console.log('--- 正規化 ---');
{
  const rows = normalizeTransactions(fixture);
  equal('4件', rows.length, 4);
  equal('TradePrice は数値化', rows[0].tradePrice, 45000000);
  equal('PricePerUnit は数値化', rows[0].pricePerUnit, 750000);
  equal('Area は数値化', rows[0].areaSqm, 60);
  equal('地区名', rows[0].districtName, '中央');
  equal('空文字の BuildingYear はそのまま', rows[3].buildingYear, '');
  equal('不正な入力は空配列', normalizeTransactions({ data: null }).length, 0);
  equal('null レコードは除外', normalizeTransactions({ data: [null] }).length, 0);
}

console.log('--- 集計 ---');
{
  const rows = normalizeTransactions(fixture);
  const all = summarizeTransactions(rows);
  equal('全件数', all.count, 4);
  // m²単価: 520000, 690000, 750000, 810000 → 中央値 (690000+750000)/2
  equal('全件の中央値（m²単価）', all.medianPricePerUnit, 720000);
  const condo = summarizeTransactions(rows, { typeIncludes: 'マンション' });
  equal('マンションは3件', condo.count, 3);
  equal('マンション中央値（m²単価）', condo.medianPricePerUnit, 750000);
  equal('マンション平均（m²単価）', condo.meanPricePerUnit, 750000);
  equal('総額の中央値（マンション）', condo.medianTradePrice, 45000000);
  check('地区名が重複なく集まる', condo.districtNames.length === 3);
  equal('空配列の中央値は null', summarizeTransactions([]).medianPricePerUnit, null);
  equal('median の偶数個', median([4, 1, 3, 2]), 2.5);
  near('median の奇数個', median([10, 30, 20]), 20, 0);
}

console.log('--- 四半期候補と最新探索 ---');
{
  const cands = quarterCandidates(new Date(2026, 10, 16), 4); // 2026-11-16
  equal('公開ラグを見込み前四半期から', `${cands[0].year}Q${cands[0].quarter}`, '2026Q3');
  equal('遡る順序', `${cands[1].year}Q${cands[1].quarter}`, '2026Q2');
  equal('年またぎ', `${quarterCandidates(new Date(2026, 1, 1), 2)[1].year}Q${quarterCandidates(new Date(2026, 1, 1), 2)[1].quarter}`, '2025Q3');

  // 最初の候補が404、次の候補でデータが得られるモック
  const fetchImpl = mockFetch((url) =>
    url.includes('quarter=3') ? { status: 404, json: {} } : { status: 200, json: fixture }
  );
  const latest = await fetchLatestTransactions(
    { area: '13', city: '13114' },
    { apiKey: 'K', fetchImpl, from: new Date(2026, 10, 16) }
  );
  equal('404 を遡って取得できる', latest.rows.length, 4);
  equal('取得できた四半期は Q2', latest.quarter, 2);

  const none = await fetchLatestTransactions(
    { area: '13', city: '13114' },
    { env: {}, fetchImpl }
  );
  equal('キー無しは available:false', none.available, false);
}

console.log('--- スナップショット読み込み ---');
{
  const snap = { metadata: { city: '13114' }, rows: normalizeTransactions(fixture) };
  const ok = await loadPriceSnapshot('13114', {
    url: 'memory://snap',
    fetchImpl: mockFetch(() => ({ status: 200, json: snap })),
  });
  equal('スナップショットが読める', ok?.rows.length, 4);
  const missing = await loadPriceSnapshot('13114', {
    url: 'memory://none',
    fetchImpl: mockFetch(() => ({ status: 404, json: {} })),
  });
  equal('無ければ null', missing, null);
}

report('reinfolib.test');
