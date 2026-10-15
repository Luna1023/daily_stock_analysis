// 配色引擎：颜色空间转换、主色提取、颜料混色模型与配方求解。
// 纯函数模块，浏览器与 Node（node --test）共用。

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`无效的颜色值: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(rgb) {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

const toLinear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const fromLinear = (v) => {
  const c = Math.max(0, Math.min(1, v));
  return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
};

export function linearToLab(r, g, b) {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function rgbToLab(rgb) {
  return linearToLab(toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2]));
}

export function hexToLab(hex) {
  return rgbToLab(hexToRgb(hex));
}

export function deltaE76(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function deltaE2000(l1, l2) {
  const rad = Math.PI / 180;
  const [L1, a1, b1] = l1;
  const [L2, a2, b2] = l2;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cm, 7) / (Math.pow(Cm, 7) + Math.pow(25, 7))));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hp = (b, a) => {
    if (b === 0 && a === 0) return 0;
    const h = Math.atan2(b, a) / rad;
    return h < 0 ? h + 360 : h;
  };
  const h1p = hp(b1, a1p), h2p = hp(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 360 : -360;
    hbp /= 2;
  }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad)
    + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(Cbp, 7) / (Math.pow(Cbp, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt(
    Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2)
    + Rt * (dCp / Sc) * (dHp / Sh),
  );
}

// ---------- 主色提取 ----------

// pixels: RGBA Uint8ClampedArray。在 Lab 空间做加权 k-means，返回按占比降序的主色。
export function extractPalette(pixels, k = 6, { iterations = 12, minShare = 0.02 } = {}) {
  const pts = [];
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 200) continue;
    const lab = rgbToLab([pixels[i], pixels[i + 1], pixels[i + 2]]);
    pts.push({ lab, rgb: [pixels[i], pixels[i + 1], pixels[i + 2]] });
  }
  if (!pts.length) return [];
  k = Math.min(k, pts.length);

  // k-means++ 的确定性变体：每次选离已选中心最远的点，保证结果可复现。
  const centers = [pts[0].lab.slice()];
  while (centers.length < k) {
    let best = -1, bestD = -1;
    for (let i = 0; i < pts.length; i += 1) {
      let d = Infinity;
      for (const c of centers) d = Math.min(d, deltaE76(pts[i].lab, c));
      if (d > bestD) { bestD = d; best = i; }
    }
    centers.push(pts[best].lab.slice());
  }

  const assign = new Int32Array(pts.length);
  for (let it = 0; it < iterations; it += 1) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < pts.length; i += 1) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < centers.length; c += 1) {
        const d = deltaE76(pts[i].lab, centers[c]);
        if (d < bd) { bd = d; bi = c; }
      }
      assign[i] = bi;
      const s = sums[bi];
      s[0] += pts[i].lab[0]; s[1] += pts[i].lab[1]; s[2] += pts[i].lab[2]; s[3] += 1;
    }
    sums.forEach((s, c) => {
      if (s[3]) centers[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
    });
  }

  const groups = centers.map(() => ({ n: 0, rgb: [0, 0, 0] }));
  for (let i = 0; i < pts.length; i += 1) {
    const g = groups[assign[i]];
    g.n += 1;
    g.rgb[0] += pts[i].rgb[0]; g.rgb[1] += pts[i].rgb[1]; g.rgb[2] += pts[i].rgb[2];
  }
  return groups
    .filter((g) => g.n / pts.length >= minShare)
    .map((g) => ({ hex: rgbToHex(g.rgb.map((v) => v / g.n)), share: g.n / pts.length }))
    .sort((a, b) => b.share - a.share);
}

// ---------- 颜料混色模型 ----------
//
// 单常数之外再区分遮盖力的简化 Kubelka-Munk：对每个线性 RGB 通道，
//   K/S = (1-R)^2 / (2R)，混合 K/S = Σ(w·强度·S·K/S) / Σ(w·强度·S)
// 白色 S 大，加入后按遮盖力稀释着色颜料的 K/S，因此能表现出「加白变浅」；
// 黄 + 蓝会同时吸收红和蓝通道，得到绿色。仅为近似，真实结果取决于颜料的光谱特性。

const R_MIN = 0.002;
const R_MAX = 0.985;

export function pigmentOptics(p) {
  const rgb = hexToRgb(p.hex).map(toLinear);
  const strength = Number(p.strength) > 0 ? Number(p.strength) : 1;
  const opacity = Number(p.opacity) > 0 ? Number(p.opacity) : 0.3;
  const a = rgb.map((r) => {
    const R = Math.min(R_MAX, Math.max(R_MIN, r));
    return strength * opacity * ((1 - R) * (1 - R)) / (2 * R);
  });
  return { a, b: strength * opacity };
}

function mixLinear(optics, weights) {
  let sb = 0;
  let k0 = 0, k1 = 0, k2 = 0;
  for (let i = 0; i < weights.length; i += 1) {
    const w = weights[i];
    const o = optics[i];
    k0 += w * o.a[0]; k1 += w * o.a[1]; k2 += w * o.a[2];
    sb += w * o.b;
  }
  const out = [0, 0, 0];
  const ks = [k0 / sb, k1 / sb, k2 / sb];
  for (let c = 0; c < 3; c += 1) {
    out[c] = 1 + ks[c] - Math.sqrt(ks[c] * ks[c] + 2 * ks[c]);
  }
  return out;
}

export function mixHex(items) {
  const active = items.filter((it) => it.weight > 0);
  if (!active.length) return null;
  const total = active.reduce((s, it) => s + it.weight, 0);
  const lin = mixLinear(active.map((it) => pigmentOptics(it.pigment)), active.map((it) => it.weight / total));
  return rgbToHex(lin.map(fromLinear));
}

// ---------- 配方求解 ----------

function enumerateCompositions(parts, units, cb, buf = [], left = units) {
  if (buf.length === parts - 1) {
    buf.push(left);
    cb(buf);
    buf.pop();
    return;
  }
  const remainingSlots = parts - buf.length - 1;
  for (let v = 1; v <= left - remainingSlots; v += 1) {
    buf.push(v);
    enumerateCompositions(parts, units, cb, buf, left - v);
    buf.pop();
  }
}

function combinations(n, k, cb, start = 0, buf = []) {
  if (buf.length === k) { cb(buf); return; }
  for (let i = start; i <= n - (k - buf.length); i += 1) {
    buf.push(i);
    combinations(n, k, cb, i + 1, buf);
    buf.pop();
  }
}

const STEP_UNITS = { 1: 1, 2: 20, 3: 20, 4: 10 }; // 每个 unit = 100/units 个百分点
const KEEP_PER_SIZE = 6;

function labOf(optics, pct) {
  const lin = mixLinear(optics, pct.map((p) => p / 100));
  return linearToLab(lin[0], lin[1], lin[2]);
}

function refine(optics, pct, targetLab) {
  let best = pct.slice();
  let bestD = deltaE76(labOf(optics, best), targetLab);
  for (let guard = 0; guard < 300; guard += 1) {
    let improved = false;
    for (let i = 0; i < best.length; i += 1) {
      for (let j = 0; j < best.length; j += 1) {
        if (i === j || best[j] <= 1) continue;
        const next = best.slice();
        next[i] += 1;
        next[j] -= 1;
        const d = deltaE76(labOf(optics, next), targetLab);
        if (d < bestD - 1e-9) { best = next; bestD = d; improved = true; }
      }
    }
    if (!improved) break;
  }
  return best;
}

// 在已有原料中搜索最接近目标色的配方；每种用料数（1..maxPigments）各返回一个最优方案。
// 返回 [{ items: [{ id, pct }], hex, deltaE, count }]，pct 为整数百分比且和为 100。
export function solveRecipe(targetHex, allPigments, { maxPigments = 3 } = {}) {
  const pigments = allPigments.filter((p) => p.kind !== 'effect');
  const targetLab = hexToLab(targetHex);
  const optics = pigments.map(pigmentOptics);
  const results = [];

  for (let size = 1; size <= Math.min(maxPigments, pigments.length); size += 1) {
    const units = STEP_UNITS[size] || 10;
    const scale = 100 / units;
    const pool = [];
    const push = (idx, pct, d) => {
      pool.push({ idx: idx.slice(), pct: pct.slice(), d });
      pool.sort((a, b) => a.d - b.d);
      if (pool.length > KEEP_PER_SIZE) pool.pop();
    };

    combinations(pigments.length, size, (idx) => {
      const sub = idx.map((i) => optics[i]);
      let bestD = Infinity, bestPct = null;
      const evalPct = (pct) => {
        const d = deltaE76(labOf(sub, pct), targetLab);
        if (d < bestD) { bestD = d; bestPct = pct.slice(); }
      };
      if (size === 1) evalPct([100]);
      else enumerateCompositions(size, units, (comp) => evalPct(comp.map((u) => u * scale)));
      if (bestPct && (pool.length < KEEP_PER_SIZE || bestD < pool[pool.length - 1].d)) push(idx, bestPct, bestD);
    });

    let winner = null;
    for (const cand of pool) {
      const sub = cand.idx.map((i) => optics[i]);
      const pct = size === 1 ? [100] : refine(sub, cand.pct, targetLab);
      const lab = labOf(sub, pct);
      const d = deltaE76(lab, targetLab);
      if (!winner || d < winner.d) winner = { idx: cand.idx, pct, d, lab };
    }
    if (!winner) continue;

    const items = winner.idx.map((i, n) => ({ id: pigments[i].id, pct: winner.pct[n] }))
      .sort((a, b) => b.pct - a.pct);
    const hex = mixHex(items.map((it) => ({
      pigment: pigments.find((p) => p.id === it.id), weight: it.pct,
    })));
    results.push({ items, hex, deltaE: deltaE2000(winner.lab, targetLab), count: size });
  }
  return results;
}

// 在误差几乎没有改善时偏向用料更少的方案。
export function pickRecommended(results, tolerance = 1.5) {
  if (!results.length) return -1;
  const best = Math.min(...results.map((r) => r.deltaE));
  return results.findIndex((r) => r.deltaE <= best + tolerance);
}

export function describeDeltaE(d) {
  if (d < 1) return '肉眼几乎无法分辨';
  if (d < 3) return '非常接近';
  if (d < 6) return '接近，可通过微调修正';
  if (d < 12) return '有明显差异，建议补充原料或放宽用料数';
  return '超出现有原料色域，需要补充其他颜料';
}

export const ACCEPTABLE_DELTA_E = 6;

// 首选「我的原料」：先只用 preferred 且已有的颜料求解；
// 若色差仍大于阈值，再用全部颜料（含通用参考颜料）求解，只保留明显更好的方案作为「补充方案」。
// 返回 { preferred: [...], supplement: [...] }，supplement 里的 items 带 extra 标记（不属于我的原料）。
export function solveWithPreference(targetHex, pigments, { maxPigments = 3, threshold = ACCEPTABLE_DELTA_E } = {}) {
  const colors = pigments.filter((p) => p.kind !== 'effect');
  const mine = colors.filter((p) => p.preferred && p.owned);
  const preferred = mine.length ? solveRecipe(targetHex, mine, { maxPigments }) : [];
  const best = preferred.length ? Math.min(...preferred.map((r) => r.deltaE)) : Infinity;

  let supplement = [];
  if (best > threshold) {
    const mineIds = new Set(mine.map((p) => p.id));
    supplement = solveRecipe(targetHex, colors, { maxPigments: Math.min(maxPigments, 3) })
      .filter((r) => r.deltaE < best - 1.5 && r.items.some((it) => !mineIds.has(it.id)))
      .map((r) => ({ ...r, items: r.items.map((it) => ({ ...it, extra: !mineIds.has(it.id) })) }));
  }
  return { preferred, supplement };
}

// 为目标色推荐效果粉（珠光 / 变色龙）：按正面色或侧视色与目标色的 ΔE00 排序。
// 效果粉的实际观感取决于底色与角度，这里只做色相接近度的提示。
export function recommendEffects(targetHex, pigments, limit = 3) {
  const targetLab = hexToLab(targetHex);
  return pigments
    .filter((p) => p.kind === 'effect' && p.owned && p.preferred !== false)
    .map((p) => {
      const candidates = [p.hex, p.hex2].filter(Boolean).map((hex) => ({ hex, d: deltaE2000(hexToLab(hex), targetLab) }));
      const near = candidates.reduce((a, b) => (b.d < a.d ? b : a));
      return { pigment: p, deltaE: near.d, nearHex: near.hex };
    })
    .sort((a, b) => a.deltaE - b.deltaE)
    .slice(0, limit);
}

// ---------- 批量配料 ----------

// items: [{ pigment, pct }]（基础原料，合计 100%）；effects: [{ pigment, pct }]（pct 为占基础原料质量的百分比）
// additives: [{ name, ratio }]（ratio 为相对基础原料总质量的百分比）
export function batchPlan(items, totalGrams, additives = [], effects = []) {
  const pigments = items.map((it) => {
    const grams = (totalGrams * it.pct) / 100;
    return {
      id: it.pigment.id,
      name: it.pigment.name,
      pct: it.pct,
      grams,
      binderGrams: grams * (Number(it.pigment.binder) || 0),
    };
  });
  const effectLines = effects.map((it) => {
    const grams = (totalGrams * (Number(it.pct) || 0)) / 100;
    return {
      id: it.pigment.id,
      name: it.pigment.name,
      pct: Number(it.pct) || 0,
      grams,
      binderGrams: grams * (Number(it.pigment.binder) || 0),
    };
  });
  const binderTotal = [...pigments, ...effectLines].reduce((s, p) => s + p.binderGrams, 0);
  const extras = additives.map((a) => ({ name: a.name, grams: (totalGrams * Number(a.ratio || 0)) / 100 }));
  return { pigments, effects: effectLines, binderTotal, extras };
}

// 把任意正数权重归一化为和为 100 的整数百分比（最大余数法）。
export function normalizePercents(weights) {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (!total) return weights.map(() => 0);
  const raw = weights.map((w) => (Math.max(0, w) / total) * 100);
  const floor = raw.map(Math.floor);
  let rest = 100 - floor.reduce((s, v) => s + v, 0);
  raw.map((v, i) => ({ i, frac: v - floor[i] }))
    .sort((a, b) => b.frac - a.frac)
    .forEach(({ i }) => { if (rest > 0) { floor[i] += 1; rest -= 1; } });
  return floor;
}
