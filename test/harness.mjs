// テスト共通ハーネス
//
// このサンドボックスではブラウザからの直接の外部通信が遮断されているため、
// Playwright の page.route で外部ホストをインターセプトし、Node の child_process
// から curl（プロキシ経由で外部に出られる）で取得して route.fulfill で返す。
// 取得結果は test/output/relay-cache にディスクキャッシュする（gitignore対象）。

import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const OUTPUT_DIR = path.join(__dirname, 'output');
export const CACHE_DIR = path.join(OUTPUT_DIR, 'relay-cache');
export const BASE_URL = process.env.NAKANO_BASE_URL || 'http://localhost:8123/';

/**
 * HARNESS_DIRECT=1 で curl 中継をやめ、ブラウザに直接 fetch させる。
 * GitHub Actions のランナーのように外部へ直接出られる環境向け
 * （開発サンドボックスではブラウザの外部通信が遮断されているため中継が必須）。
 */
export const HARNESS_DIRECT = process.env.HARNESS_DIRECT === '1';

/** SKIP_NETWORK=1 で実タイル照合（外部データ取得）をスキップする。CIの単体テスト用 */
export const SKIP_NETWORK = process.env.SKIP_NETWORK === '1';

/** 中継対象ホスト（PLAN.md §8） */
export const RELAY_HOSTS = [
  'cesium.com',
  'assets.cms.plateau.reearth.io',
  'cyberjapandata.gsi.go.jp',
  'msearch.gsi.go.jp',
  'disaportaldata.gsi.go.jp',
  'cdn.jsdelivr.net',
  'unpkg.com',
];

const RELAY_RE = new RegExp(
  '^https://(' + RELAY_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|') + ')/'
);

fs.mkdirSync(CACHE_DIR, { recursive: true });

/** curl で URL を取得（ディスクキャッシュ付き） */
export function curlFetch(url) {
  return new Promise((resolve) => {
    const key = crypto.createHash('sha1').update(url).digest('hex');
    const bodyFile = path.join(CACHE_DIR, key);
    const metaFile = bodyFile + '.meta';
    if (fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      return resolve({ status: meta.status, type: meta.type, body: fs.readFileSync(bodyFile), cached: true });
    }
    execFile(
      'curl',
      ['-sSL', '-o', bodyFile, '-w', '%{http_code}\t%{content_type}', '--max-time', '90', url],
      { maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !fs.existsSync(bodyFile)) {
          return resolve({ status: 502, type: 'text/plain', body: Buffer.from('relay error'), cached: false });
        }
        const [status, type] = String(stdout).split('\t');
        const meta = { status: Number(status) || 502, type: type || 'application/octet-stream' };
        // 4xx/5xx はキャッシュしない（一時障害を焼き付けないため）
        if (meta.status >= 200 && meta.status < 400) {
          fs.writeFileSync(metaFile, JSON.stringify(meta));
        }
        resolve({ status: meta.status, type: meta.type, body: fs.readFileSync(bodyFile), cached: false });
      }
    );
  });
}

/**
 * Chromium を起動し、外部ホストを curl 中継するページを返す。
 * @returns {Promise<{browser, page, errors: string[], relay: {ok:number,fail:number,byHost:object}, close: () => Promise<void>}>}
 */
export async function launchViewer(opts = {}) {
  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({
    viewport: opts.viewport || { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    ...(opts.contextOptions || {}),
  });
  // クリップボード読み書きは e2e（headless）で明示的に許可しないと拒否される
  if (opts.permissions !== false) {
    await context.grantPermissions(opts.permissions || ['clipboard-read', 'clipboard-write'], {
      origin: new URL(BASE_URL).origin,
    }).catch((e) => console.warn('grantPermissions failed', e));
  }
  const errors = [];
  const relay = { ok: 0, fail: 0, byHost: {} };

  // 共有URLの復元は「別ページで開き直す」検証をするので、
  // 中継とエラー収集はページ単位ではなくコンテキスト単位で仕掛ける。
  function watch(p) {
    p.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text().slice(0, 300));
    });
    p.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 400)));
    return p;
  }

  if (!HARNESS_DIRECT) {
    await context.route(RELAY_RE, async (route) => {
      const url = route.request().url();
      const host = new URL(url).host;
      const res = await curlFetch(url);
      relay.byHost[host] = (relay.byHost[host] || 0) + 1;
      if (res.status >= 200 && res.status < 400) relay.ok++;
      else relay.fail++;
      await route.fulfill({
        status: res.status,
        contentType: res.type,
        headers: {
          'content-type': res.type,
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=3600',
        },
        body: res.body,
      });
    });
  }
  // テレメトリ等は遮断
  await context.route(/google|gstatic|doubleclick/, (route) => route.abort());

  const page = watch(await context.newPage());

  if (opts.goto !== false) {
    await page.goto(opts.url || BASE_URL, { waitUntil: 'load', timeout: 180000 });
  }

  return {
    browser,
    context,
    page,
    errors,
    relay,
    /** 同じ中継設定のまま新しいタブを開く（共有URLの復元検証用） */
    newPage: async (url) => {
      const p = watch(await context.newPage());
      if (url) await p.goto(url, { waitUntil: 'load', timeout: 180000 });
      return p;
    },
    close: () => browser.close(),
  };
}

/** Cesium ビューアの初期化と初回タイル読み込みを待つ */
export async function waitForViewerReady(page, timeoutMs = 120000) {
  await page.waitForFunction(
    () => typeof Cesium !== 'undefined' && !!window.__nakano?.viewer,
    null,
    { timeout: timeoutMs }
  );
  // 建物タイルセットが1つ以上描画されるまで待つ
  await page.waitForFunction(
    () => {
      const ts = window.__nakano?.loaded?.bldgLod2;
      return !!ts && ts.tilesLoaded === true;
    },
    null,
    { timeout: timeoutMs }
  ).catch(() => { /* タイル待ちのタイムアウトは致命ではない */ });
}

// ---- 簡易アサーション -------------------------------------------------------

let passed = 0;
const failures = [];

export function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

export function equal(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function near(name, actual, expected, tol) {
  const ok = typeof actual === 'number' && Math.abs(actual - expected) <= tol;
  check(name, ok, `expected ${expected}±${tol}, got ${actual}`);
}

export function report(title) {
  console.log(`\n${title}: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log('  ✗ ' + f);
    process.exitCode = 1;
  }
  return failures.length === 0;
}

export function shotPath(name) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  return path.join(OUTPUT_DIR, name);
}
