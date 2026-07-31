// sw.jsのprecacheとキャッシュ除外ルールを、ネットワークなしで検証する。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, equal, report } from './harness.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testDir, '..');
const swSource = fs.readFileSync(path.join(rootDir, 'sw.js'), 'utf8');

const precacheMatch = swSource.match(/const PRECACHE_URLS = \[([\s\S]*?)\n\];/);
check('precache配列を読み取れる', !!precacheMatch);
const precacheUrls = precacheMatch
  ? [...precacheMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
  : [];

equal('precacheに重複がない', new Set(precacheUrls).size, precacheUrls.length);

const jsUrls = fs.readdirSync(path.join(rootDir, 'js'))
  .filter((fileName) => fileName.endsWith('.js'))
  .sort()
  .map((fileName) => `./js/${fileName}`);
for (const jsUrl of jsUrls) {
  check(`precacheに${jsUrl}を含む`, precacheUrls.includes(jsUrl));
}

const iconUrls = fs.readdirSync(path.join(rootDir, 'assets/icons'))
  .filter((fileName) => fileName.endsWith('.png') || fileName.endsWith('.svg'))
  .sort()
  .map((fileName) => `./assets/icons/${fileName}`);
for (const iconUrl of iconUrls) {
  check(`precacheに${iconUrl}を含む`, precacheUrls.includes(iconUrl));
}

for (const requiredUrl of ['./index.html', './style.css', './manifest.json', './offline.html']) {
  check(`precacheに${requiredUrl}を含む`, precacheUrls.includes(requiredUrl));
}

for (const precacheUrl of precacheUrls) {
  const localPath = precacheUrl.replace(/^\.\//, '');
  check(`precache対象が存在する: ${precacheUrl}`, fs.existsSync(path.join(rootDir, localPath)));
}

check(
  '同一オリジンデータをprecacheしない',
  !precacheUrls.some((url) => url.startsWith('./data/')),
);
check('VERSION定数がある', /const VERSION = 'v\d+';/.test(swSource));

const plateauRoute = swSource.match(
  /if \(isPlateau3DTile\(url\)\) \{([\s\S]*?)\n  \}/,
);
check('PLATEAU 3D Tilesのパススルー分岐がある', !!plateauRoute);
check(
  'PLATEAU 3D Tilesをキャッシュ戦略へ渡さない',
  !!plateauRoute
    && plateauRoute[1].includes('event.respondWith(fetch(event.request))')
    && !/(cacheFirst|staleWhileRevalidate|networkFirst|CACHE_NAMES)/.test(plateauRoute[1]),
);
check(
  '用途地域MVTを3D Tilesより先に判定する',
  swSource.indexOf('if (isZoningMvt(url))') < swSource.indexOf('if (isPlateau3DTile(url))'),
);

report('sw.test.mjs');
