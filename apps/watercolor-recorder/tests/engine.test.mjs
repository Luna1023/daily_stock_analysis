import test from 'node:test';
import assert from 'node:assert/strict';

import {
  batchPlan, deltaE2000, describeDeltaE, extractPalette, hexToLab, hexToRgb, mixHex,
  normalizePercents, pickRecommended, recommendEffects, rgbToHex, solveRecipe, solveWithPreference,
} from '../web/engine.js';
import {
  DEFAULT_PIGMENTS, EFFECT_PIGMENTS, GENERIC_PIGMENTS, MARIES_PIGMENTS, migratePigments,
} from '../web/pigments.js';

const byId = Object.fromEntries(DEFAULT_PIGMENTS.map((p) => [p.id, p]));
const mix = (...pairs) => mixHex(pairs.map(([id, weight]) => ({ pigment: byId[id], weight })));

test('hex 与 rgb 互转', () => {
  assert.deepEqual(hexToRgb('#ff8000'), [255, 128, 0]);
  assert.equal(rgbToHex([255, 128, 0]), '#FF8000');
  assert.throws(() => hexToRgb('red'));
});

test('deltaE2000 对已知样例给出参考值', () => {
  // Sharma et al. 的参考数据对 #1
  const d = deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485]);
  assert.ok(Math.abs(d - 2.0425) < 0.001, `got ${d}`);
  assert.equal(deltaE2000([50, 10, 10], [50, 10, 10]), 0);
});

test('单一颜料混色还原其纯色', () => {
  for (const id of ['pb15', 'py3', 'pr254', 'pbk9']) {
    const d = deltaE2000(hexToLab(mix([id, 1])), hexToLab(byId[id].hex));
    assert.ok(d < 1.5, `${id} 偏差 ${d}`);
  }
});

test('黄 + 蓝 得到绿色，红 + 蓝 偏紫', () => {
  const [r, g, b] = hexToRgb(mix(['py3', 1], ['pb15', 1]));
  assert.ok(g > r && g > b, `不是绿色: ${r},${g},${b}`);
  const [r2, g2, b2] = hexToRgb(mix(['pv19', 1], ['pb29', 1]));
  assert.ok(b2 > g2 && r2 > g2, `不是紫色: ${r2},${g2},${b2}`);
});

test('加白后明度升高且随白色比例单调', () => {
  const L = (hex) => hexToLab(hex)[0];
  const l0 = L(mix(['pb29', 1]));
  const l1 = L(mix(['pb29', 3], ['pw6', 1]));
  const l2 = L(mix(['pb29', 1], ['pw6', 1]));
  assert.ok(l0 < l1 && l1 < l2, `${l0} ${l1} ${l2}`);
});

test('求解器能找回由已知配方混出的颜色', () => {
  const target = mix(['py74', 3], ['pb28', 2], ['pw6', 1]);
  const results = solveRecipe(target, GENERIC_PIGMENTS, { maxPigments: 3 });
  assert.equal(results.length, 3);
  const best = results.find((r) => r.count === 3);
  assert.ok(best.deltaE < 1.5, `ΔE=${best.deltaE}`);
  for (const r of results) {
    assert.equal(r.items.reduce((s, it) => s + it.pct, 0), 100);
    assert.equal(r.count, r.items.length);
  }
  assert.ok(results[0].deltaE >= best.deltaE);
});

test('求解器只使用传入的原料', () => {
  const owned = DEFAULT_PIGMENTS.filter((p) => ['pb29', 'pw6'].includes(p.id));
  const results = solveRecipe('#6C7BD6', owned, { maxPigments: 4 });
  assert.equal(results.length, 2);
  for (const r of results) for (const it of r.items) assert.ok(['pb29', 'pw6'].includes(it.id));
});

test('超出色域的目标色给出较大色差与对应提示', () => {
  const owned = DEFAULT_PIGMENTS.filter((p) => ['pbk9', 'pw6'].includes(p.id));
  const [best] = solveRecipe('#FF00FF', owned, { maxPigments: 2 }).sort((a, b) => a.deltaE - b.deltaE);
  assert.ok(best.deltaE > 12);
  assert.match(describeDeltaE(best.deltaE), /色域/);
});

test('pickRecommended 在差异不大时偏向更少用料', () => {
  const rec = pickRecommended([{ deltaE: 5 }, { deltaE: 2.0 }, { deltaE: 1.0 }]);
  assert.equal(rec, 1);
  assert.equal(pickRecommended([]), -1);
});

test('extractPalette 提取两块纯色并按占比排序', () => {
  const px = new Uint8ClampedArray(100 * 4);
  for (let i = 0; i < 100; i += 1) {
    const red = i < 70;
    px.set(red ? [200, 30, 30, 255] : [20, 40, 200, 255], i * 4);
  }
  const pal = extractPalette(px, 4);
  assert.equal(pal.length, 2);
  assert.equal(pal[0].hex, '#C81E1E');
  assert.ok(Math.abs(pal[0].share - 0.7) < 1e-9);
  assert.equal(pal[1].hex, '#1428C8');
});

test('normalizePercents 总和恒为 100', () => {
  assert.deepEqual(normalizePercents([1, 1, 1]), [34, 33, 33]);
  assert.equal(normalizePercents([3, 2, 7, 0.5]).reduce((s, v) => s + v, 0), 100);
  assert.deepEqual(normalizePercents([0, 0]), [0, 0]);
});

test('batchPlan 计算颜料、胶液与辅料克数', () => {
  const plan = batchPlan(
    [{ pigment: { id: 'a', name: 'A', binder: 1 }, pct: 60 }, { pigment: { id: 'b', name: 'B', binder: 0.5 }, pct: 40 }],
    2,
    [{ name: '蜂蜜', ratio: 10 }],
  );
  assert.ok(Math.abs(plan.pigments[0].grams - 1.2) < 1e-9);
  assert.ok(Math.abs(plan.pigments[1].grams - 0.8) < 1e-9);
  assert.ok(Math.abs(plan.binderTotal - 1.6) < 1e-9);
  assert.ok(Math.abs(plan.extras[0].grams - 0.2) < 1e-9);
});

test('原料库预设：玛丽 36 色、效果粉分组与字段', () => {
  assert.equal(MARIES_PIGMENTS.length, 36);
  assert.equal(new Set(DEFAULT_PIGMENTS.map((p) => p.id)).size, DEFAULT_PIGMENTS.length);
  for (const p of MARIES_PIGMENTS) {
    assert.ok(p.preferred && p.owned && p.group === 'mine' && p.kind === 'color' && p.binder === 0 && !p.calibrated);
  }
  assert.equal(EFFECT_PIGMENTS.filter((p) => p.subtype === 'chameleon').length, 12);
  for (const p of EFFECT_PIGMENTS) assert.ok(p.kind === 'effect' && p.hex2 && p.dose > 0);
  for (const p of GENERIC_PIGMENTS) assert.ok(!p.owned && !p.preferred && p.group === 'generic');
});

test('求解器不会把效果粉当作混色原料', () => {
  const results = solveRecipe('#8844AA', DEFAULT_PIGMENTS.filter((p) => p.kind === 'effect' || p.id === 'pb29' || p.id === 'pv19'), { maxPigments: 3 });
  for (const r of results) for (const it of r.items) assert.ok(['pb29', 'pv19'].includes(it.id));
});

test('首选我的原料：目标色可由玛丽色配出时不出现补充方案', () => {
  const target = mix(['mm12', 1]);
  const { preferred, supplement } = solveWithPreference(target, DEFAULT_PIGMENTS, { maxPigments: 3 });
  assert.ok(preferred.length === 3 && supplement.length === 0);
  for (const r of preferred) for (const it of r.items) assert.ok(it.id.startsWith('mm'));
  assert.ok(Math.min(...preferred.map((r) => r.deltaE)) < 1.5);
});

test('我的原料色域不足时，补充方案只在明显更好且含非首选原料时出现', () => {
  const onlyBlackWhite = DEFAULT_PIGMENTS.map((p) => ({ ...p, owned: ['mm27', 'mm28'].includes(p.id) || p.group === 'generic' }));
  const { preferred, supplement } = solveWithPreference('#C5245F', onlyBlackWhite, { maxPigments: 3 });
  assert.ok(preferred.length > 0);
  for (const r of preferred) for (const it of r.items) assert.ok(['mm27', 'mm28'].includes(it.id));
  const bestMine = Math.min(...preferred.map((r) => r.deltaE));
  assert.ok(bestMine > 6);
  assert.ok(supplement.length > 0);
  for (const r of supplement) {
    assert.ok(r.deltaE < bestMine - 1.5);
    assert.ok(r.items.some((it) => it.extra));
    assert.ok(r.items.every((it) => it.extra === !['mm27', 'mm28'].includes(it.id)));
  }
});

test('没有任何首选原料时，preferred 为空而不是抛错', () => {
  const none = DEFAULT_PIGMENTS.map((p) => ({ ...p, owned: false }));
  assert.deepEqual(solveWithPreference('#336699', none).preferred, []);
});

test('recommendEffects 按色相接近度排序，且只推荐已有的效果粉', () => {
  const ranked = recommendEffects('#2E5DC8', DEFAULT_PIGMENTS, 3);
  assert.equal(ranked.length, 3);
  assert.ok(ranked[0].deltaE <= ranked[1].deltaE && ranked[1].deltaE <= ranked[2].deltaE);
  assert.ok(ranked.every((r) => r.pigment.kind === 'effect'));
  const none = recommendEffects('#2E5DC8', DEFAULT_PIGMENTS.map((p) => ({ ...p, owned: false })));
  assert.deepEqual(none, []);
});

test('batchPlan 将效果粉按基础原料质量百分比计入克数与胶液', () => {
  const plan = batchPlan(
    [{ pigment: { id: 'a', name: 'A', binder: 0 }, pct: 100 }],
    10,
    [{ name: '蜂蜜', ratio: 10 }],
    [{ pigment: { id: 'e', name: 'E', binder: 1.5 }, pct: 8 }],
  );
  assert.ok(Math.abs(plan.effects[0].grams - 0.8) < 1e-9);
  assert.ok(Math.abs(plan.effects[0].binderGrams - 1.2) < 1e-9);
  assert.ok(Math.abs(plan.binderTotal - 1.2) < 1e-9);
  assert.ok(Math.abs(plan.extras[0].grams - 1) < 1e-9);
});

test('migratePigments 补齐新增默认项并保留用户修改，旧数据归入通用分组', () => {
  const old = [
    { id: 'pw6', name: '我的白', hex: '#FFFFFF', strength: 1, opacity: 1, binder: 1, owned: true },
    { id: 'custom-1', name: '自定义', hex: '#123456', strength: 1, opacity: 0.4, binder: 1, owned: true },
  ];
  const merged = migratePigments(old);
  const pw6 = merged.find((p) => p.id === 'pw6');
  assert.equal(pw6.name, '我的白');
  assert.equal(pw6.group, 'generic');
  assert.equal(pw6.preferred, false);
  assert.equal(merged.filter((p) => p.id === 'pw6').length, 1);
  assert.equal(merged.filter((p) => p.group === 'mine').length, 36 + EFFECT_PIGMENTS.length);
  assert.equal(migratePigments(null).length, DEFAULT_PIGMENTS.length);
  assert.equal(migratePigments(merged).length, merged.length);
});
