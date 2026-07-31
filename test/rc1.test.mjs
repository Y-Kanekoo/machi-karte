// R4-RC1で追加した生成器・共有形式・矩形フォールバックの回帰テスト

import fs from 'node:fs';
import { check, equal, report } from './harness.mjs';
import {
  buildAreaIndex,
  restoreUrl,
  validateAreaIndex,
  urlContainsAreaCode,
} from '../scripts/build-area-index.mjs';
import { resolveServiceRect } from '../js/area.js';
import { AREA_RECT } from '../js/config.js';
import { parseHash, serializeState } from '../js/share.js';

const rc1Fixture = JSON.parse(
  fs.readFileSync(
    new URL('./fixtures/plateau-catalog-rc1.json', import.meta.url),
    'utf8',
  ),
);
const baseFixture = JSON.parse(
  fs.readFileSync(
    new URL('./fixtures/plateau-catalog-sample.json', import.meta.url),
    'utf8',
  ),
);

console.log('--- 荒尾市・益城町の建物URL選択とsanity ---');
const rc1Index = buildAreaIndex(rc1Fixture);
const arao = rc1Index.areas['43204'];
const mashiki = rc1Index.areas['43443'];
check('荒尾市を生成できる', !!arao);
check('益城町を生成できる', !!mashiki);
check(
  '荒尾市はコード・年度が一致する公式複合URLへフォールバック',
  arao.b1.includes('/43204-bldg-lod1-texture-2020/'),
  arao.b1,
);
check(
  '荒尾市のURLに益城町コードを混入させない',
  !arao.b1.includes('43443_mashiki-machi'),
  arao.b1,
);
check(
  '益城町は自身の直接URLを維持',
  restoreUrl(rc1Index.prefix, mashiki.b1).includes('43443_mashiki-machi_city_2023'),
  mashiki.b1,
);
check('荒尾市のURL内コードが一致', urlContainsAreaCode(arao.b1, '43204'));
check('益城町のURL内コードが一致', urlContainsAreaCode(mashiki.b1, '43443'));
const sanity = validateAreaIndex(rc1Index, { sanityMin: 2 });
equal('fixture sanityの自治体数', sanity.areas, 2);
equal('fixture sanityの建物URL数', sanity.buildingUrls, 5);

console.log('--- displayNameとcontentHash ---');
const generated = buildAreaIndex(baseFixture);
const generatedAgain = buildAreaIndex(baseFixture);
equal('政令市の区に親市名を保持', generated.areas['15101'].parentName, '新潟市');
equal('政令市の区にdisplayNameを生成', generated.areas['15101'].displayName, '新潟市 北区');
check('generatedAtを生成しない', !Object.hasOwn(generated, 'generatedAt'));
check('contentHashはsha256形式', /^[0-9a-f]{64}$/.test(generated.contentHash));
equal(
  '同じカタログからcontentHashを決定的に生成',
  generatedAgain.contentHash,
  generated.contentHash,
);
equal(
  '同じカタログからJSON全体を決定的に生成',
  JSON.stringify(generatedAgain),
  JSON.stringify(generated),
);

console.log('--- 中野矩形フォールバックの限定 ---');
equal(
  '旧呼び出しは中野矩形へフォールバック',
  JSON.stringify(resolveServiceRect()),
  JSON.stringify(AREA_RECT),
);
equal(
  '中野区はrect欠損時も静的矩形へフォールバック',
  JSON.stringify(resolveServiceRect({ code: '13114', rect: null })),
  JSON.stringify(AREA_RECT),
);
equal(
  '非中野はrect欠損時に中野矩形を使わない',
  resolveServiceRect({ code: '22206', rect: null }),
  null,
);

console.log('--- 比較共有URLの地点別city ---');
const compareHash = serializeState({
  city: '13113',
  compare: [
    { city: '13113', lon: 139.7006, lat: 35.6595 },
    { city: '22206', lon: 138.912567, lat: 35.124771 },
  ],
});
check(
  '新形式は各地点にcityを含める',
  compareHash.includes(
    'compare=13113,139.7006,35.6595;22206,138.912567,35.124771',
  ),
  compareHash,
);
const parsedCompare = parseHash(`#${compareHash}`).compare;
equal('新形式1地点目のcity', parsedCompare[0].city, '13113');
equal('新形式2地点目のcity', parsedCompare[1].city, '22206');
const legacyCompare = parseHash(
  '#v=1&compare=139.6659,35.7056;139.635,35.725',
).compare;
equal('旧形式1地点目は中野区', legacyCompare[0].city, '13114');
equal('旧形式2地点目も中野区', legacyCompare[1].city, '13114');

report('rc1.test.mjs');
