// 不動産情報ライブラリ（国土交通省）API クライアント — 価格データ取得レイヤ
//
// 公式マニュアル: https://www.reinfolib.mlit.go.jp/help/apiManual/
// - 利用には API 利用申請（無料・審査あり）で発行される API キーが必要。
//   キーはリクエストヘッダ `Ocp-Apim-Subscription-Key` で送る（URL には載せない）。
// - 公式マニュアルは「CORSエラーの発生を防ぐために、APIリクエストをブラウザから
//   送信しないようご注意ください」と明記している。そのため本クライアントは
//   Node（tools/fetch-price-snapshot.mjs によるスナップショット生成）での利用を
//   主対象とし、ブラウザ側は生成済みスナップショットを読むだけにする。
// - XIT001/XIT002 は「データが無い場合 HTTP 404」を返す（公式マニュアル Q.8）。
//   404 はエラーではなく「該当データなし」として扱う。
// - API キーが無い環境では例外を投げず { available:false } を返す。
//   呼び出し側は「価格データ未設定」として扱うこと。
//
// テストは test/reinfolib.test.mjs（fetch を差し替えて検証する）。

import { REINFOLIB_API_BASE, PRICE_SNAPSHOT_URL } from './config.js';

/** APIキーを読む環境変数名（Node実行時） */
export const REINFOLIB_API_KEY_ENV = 'REINFOLIB_API_KEY';

/** XIT001 の priceClassification: '01' = 取引価格情報 */
export const PRICE_CLASSIFICATION_TRADE = '01';

/**
 * APIキーを解決する。優先順: 明示指定 > 環境変数。
 * ブラウザから直接呼ばない設計のため localStorage 等の経路は持たない。
 * @param {{apiKey?: string, env?: object}} [opts]
 * @returns {string|null}
 */
export function resolveReinfolibApiKey(opts = {}) {
  if (opts.apiKey) return opts.apiKey;
  const env = opts.env ?? (typeof process !== 'undefined' ? process.env : undefined);
  const v = env?.[REINFOLIB_API_KEY_ENV];
  return v ? String(v) : null;
}

/** XIT001（不動産価格（取引価格・成約価格）情報） のURLを組み立てる。キーは含めない。 */
export function buildTransactionsUrl(
  { year, quarter, area, city, priceClassification = PRICE_CLASSIFICATION_TRADE, language = 'ja' },
  base = REINFOLIB_API_BASE
) {
  const u = new URL(`${base}/XIT001`);
  u.searchParams.set('year', String(year));
  if (quarter != null) u.searchParams.set('quarter', String(quarter));
  if (area) u.searchParams.set('area', String(area));
  if (city) u.searchParams.set('city', String(city));
  u.searchParams.set('priceClassification', priceClassification);
  u.searchParams.set('language', language);
  return u.toString();
}

/** XIT002（都道府県内市区町村一覧） のURLを組み立てる。 */
export function buildCitiesUrl({ area }, base = REINFOLIB_API_BASE) {
  const u = new URL(`${base}/XIT002`);
  u.searchParams.set('area', String(area));
  return u.toString();
}

/** 文字列数値（カンマ区切り等）を number にする。解釈できなければ null。 */
export function toNumberOrNull(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * XIT001 の1レコードをアプリ内で扱う形に正規化する。
 * 公式仕様では Area / TradePrice / PricePerUnit / UnitPrice は文字列で返る。
 */
export function normalizeTransaction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    type: raw.Type ?? null, // 例: '中古マンション等' / '宅地(土地)'
    region: raw.Region ?? null,
    prefecture: raw.Prefecture ?? null,
    municipality: raw.Municipality ?? null,
    municipalityCode: raw.MunicipalityCode ?? null,
    districtName: raw.DistrictName ?? null,
    tradePrice: toNumberOrNull(raw.TradePrice), // 取引総額（円）
    pricePerUnit: toNumberOrNull(raw.UnitPrice), // 平方メートル単価（円/㎡）
    unitPrice: toNumberOrNull(raw.PricePerUnit), // 坪単価（円/坪）
    areaSqm: toNumberOrNull(raw.Area), // 面積（m²）
    floorPlan: raw.FloorPlan ?? null,
    buildingYear: raw.BuildingYear ?? null,
    structure: raw.Structure ?? null,
    use: raw.Use ?? null,
    cityPlanning: raw.CityPlanning ?? null,
    period: raw.Period ?? null, // 例: '2025年第3四半期'
  };
}

/** XIT001 のレスポンス全体（{ status, data: [...] }）を正規化済み配列にする。 */
export function normalizeTransactions(json) {
  const data = Array.isArray(json) ? json : json?.data;
  if (!Array.isArray(data)) return [];
  return data.map(normalizeTransaction).filter(Boolean);
}

/**
 * XIT001 で取引価格を取得する。
 * @param {{year:number, quarter?:number, area?:string, city?:string}} params
 * @param {{apiKey?:string, env?:object, fetchImpl?:Function, baseUrl?:string}} [opts]
 * @returns {Promise<{available:boolean, reason?:string, notFound?:boolean, rows:object[]}>}
 */
export async function fetchTransactions(params, opts = {}) {
  const apiKey = resolveReinfolibApiKey(opts);
  if (!apiKey) return { available: false, reason: 'no-api-key', rows: [] };
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const url = buildTransactionsUrl(params, opts.baseUrl ?? REINFOLIB_API_BASE);
  const res = await doFetch(url, {
    headers: { 'Ocp-Apim-Subscription-Key': apiKey },
  });
  // 公式仕様: データが無い場合は 404（エラーではない）
  if (res.status === 404) return { available: true, notFound: true, rows: [] };
  if (!res.ok) throw new Error(`reinfolib XIT001 failed: HTTP ${res.status}`);
  const json = await res.json();
  return { available: true, rows: normalizeTransactions(json) };
}

/** XIT002 で都道府県内の市区町村一覧を取得する（city コードの検証用）。 */
export async function fetchCities({ area }, opts = {}) {
  const apiKey = resolveReinfolibApiKey(opts);
  if (!apiKey) return { available: false, reason: 'no-api-key', cities: [] };
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const url = buildCitiesUrl({ area }, opts.baseUrl ?? REINFOLIB_API_BASE);
  const res = await doFetch(url, {
    headers: { 'Ocp-Apim-Subscription-Key': apiKey },
  });
  if (res.status === 404) return { available: true, notFound: true, cities: [] };
  if (!res.ok) throw new Error(`reinfolib XIT002 failed: HTTP ${res.status}`);
  const json = await res.json();
  const data = Array.isArray(json) ? json : json?.data;
  const cities = (Array.isArray(data) ? data : []).map((c) => ({
    id: c?.id ?? null,
    name: c?.name ?? null,
  }));
  return { available: true, cities };
}

/**
 * 四半期候補を新しい順に返す。取引価格の公開には約1〜2四半期のラグがあるため、
 * 「最新を指定して空なら1期ずつ遡る」探索に使う。
 * @param {Date} [from] 基準日（既定: 今日）
 * @param {number} [count] 候補数
 * @returns {Array<{year:number, quarter:number}>}
 */
export function quarterCandidates(from = new Date(), count = 6) {
  let year = from.getFullYear();
  let quarter = Math.floor(from.getMonth() / 3) + 1;
  // 公開ラグを見込んで1四半期前から始める
  quarter -= 1;
  if (quarter < 1) { quarter = 4; year -= 1; }
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({ year, quarter });
    quarter -= 1;
    if (quarter < 1) { quarter = 4; year -= 1; }
  }
  return out;
}

/**
 * データが得られる最新の四半期まで遡って取引価格を取得する。
 * @returns {Promise<{available:boolean, reason?:string, year?:number, quarter?:number, rows:object[]}>}
 */
export async function fetchLatestTransactions({ area, city }, opts = {}) {
  if (!resolveReinfolibApiKey(opts)) {
    return { available: false, reason: 'no-api-key', rows: [] };
  }
  for (const { year, quarter } of quarterCandidates(opts.from ?? new Date(), opts.maxBack ?? 6)) {
    const r = await fetchTransactions({ year, quarter, area, city }, opts);
    if (r.rows.length > 0) return { available: true, year, quarter, rows: r.rows };
  }
  return { available: true, rows: [] };
}

/** 数値配列の中央値。空なら null。 */
export function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 取引レコードを相場サマリに集計する（診断カードの「相場」表示の素材）。
 * @param {object[]} rows normalizeTransactions の出力
 * @param {{typeIncludes?: string}} [filter] type の部分一致で絞り込む（例: 'マンション'）
 */
export function summarizeTransactions(rows, filter = {}) {
  const target = filter.typeIncludes
    ? rows.filter((r) => (r.type ?? '').includes(filter.typeIncludes))
    : rows;
  const perUnit = target.map((r) => r.pricePerUnit).filter((n) => n != null && n > 0);
  const totals = target.map((r) => r.tradePrice).filter((n) => n != null && n > 0);
  const mean = perUnit.length
    ? perUnit.reduce((a, b) => a + b, 0) / perUnit.length
    : null;
  return {
    count: target.length,
    medianPricePerUnit: median(perUnit),
    meanPricePerUnit: mean != null ? Math.round(mean) : null,
    minPricePerUnit: perUnit.length ? Math.min(...perUnit) : null,
    maxPricePerUnit: perUnit.length ? Math.max(...perUnit) : null,
    medianTradePrice: median(totals),
    period: target.find((r) => r.period)?.period ?? null,
    districtNames: [...new Set(target.map((r) => r.districtName).filter(Boolean))],
  };
}

/** 土地のみの取引区分かどうか（API表記の半角括弧と資料表記の全角括弧の両方に対応）。 */
export function isLandOnly(row) {
  return row?.type === '宅地(土地)' || row?.type === '宅地（土地）';
}

/**
 * スナップショット用の価格サマリ（全件／マンション／土地のみ）を構築する純粋関数。
 * 生成器（tools/fetch-price-snapshot.mjs）とテストの両方から使う。
 */
export function buildPriceSummary(rows) {
  return {
    all: summarizeTransactions(rows),
    condominium: summarizeTransactions(rows, { typeIncludes: 'マンション' }),
    land: summarizeTransactions(rows.filter(isLandOnly)),
  };
}

/**
 * 円額を万円単位の数値文字列にする（例: 623000 → '62.3'、500000 → '50'）。
 * 小数1桁までで表し、末尾の '.0' は落とす。null や不正値は null。
 */
export function formatManYenValue(yen) {
  if (yen == null || !Number.isFinite(yen)) return null;
  const man = yen / 10000;
  const rounded = Math.round(man * 10) / 10;
  return Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(1);
}

/** ㎡単価（円/㎡）を「62.3万円/㎡」表記にする。null は null。 */
export function formatPricePerUnit(yenPerSqm) {
  const v = formatManYenValue(yenPerSqm);
  return v == null ? null : `${v}万円/㎡`;
}

/**
 * 取引総額（円）を「3,980万円」「1億2,300万円」表記にする。null は null。
 */
export function formatTradePrice(yen) {
  if (yen == null || !Number.isFinite(yen)) return null;
  if (yen >= 100000000) {
    let oku = Math.floor(yen / 100000000);
    let man = Math.round((yen % 100000000) / 10000);
    if (man === 10000) { oku += 1; man = 0; }
    return man > 0 ? `${oku}億${man.toLocaleString('ja-JP')}万円` : `${oku}億円`;
  }
  return `${Math.round(yen / 10000).toLocaleString('ja-JP')}万円`;
}

/**
 * 同梱スナップショット（data/price-<city>.json）を読む。
 * 無ければ null（「価格データ未設定」として扱う）。ブラウザ/Node 両対応。
 */
export async function loadPriceSnapshot(city, opts = {}) {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const url = opts.url ?? PRICE_SNAPSHOT_URL(city);
  try {
    const res = await doFetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || !Array.isArray(json.rows)) return null;
    return json;
  } catch {
    return null;
  }
}
