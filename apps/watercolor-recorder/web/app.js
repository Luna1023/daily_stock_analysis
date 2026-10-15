import {
  batchPlan, describeDeltaE, deltaE2000, extractPalette, hexToLab, mixHex, pickRecommended, recommendEffects, rgbToHex,
  solveWithPreference,
} from './engine.js';
import { DEFAULT_ADDITIVES, DEFAULT_BINDER_NAME, DEFAULT_PIGMENTS, migratePigments } from './pigments.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (v) => JSON.parse(JSON.stringify(v));
const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '-');
const HEX_RE = /^#[0-9a-f]{6}$/i;
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// ---------- 存储 ----------

const KEYS = { pigments: 'wcr.pigments', additives: 'wcr.additives', binder: 'wcr.binder', recipes: 'wcr.recipes', settings: 'wcr.settings' };

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : clone(fallback);
  } catch {
    return clone(fallback);
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    toast('浏览器存储空间不足或被禁用，数据未能保存，请先导出 JSON 备份', 4000);
  }
}

const state = {
  pigments: migratePigments(load(KEYS.pigments, DEFAULT_PIGMENTS)),
  additives: load(KEYS.additives, DEFAULT_ADDITIVES),
  binderName: load(KEYS.binder, DEFAULT_BINDER_NAME),
  recipes: load(KEYS.recipes, []),
  settings: load(KEYS.settings, { maxPigments: 3, totalGrams: 2 }),
  targetHex: '#6C8EBF',
  thumb: null,
  sourceLabel: '',
  results: { preferred: [], supplement: [] },
  effectRecs: [],
  draft: null,
  imageData: null,
  recordQuery: '',
};

const pigmentSnapshot = (p) => ({
  id: p.id, name: p.name, code: p.code, hex: p.hex, hex2: p.hex2, kind: p.kind, subtype: p.subtype, dose: p.dose, strength: p.strength, opacity: p.opacity, binder: p.binder,
});

// ---------- 通用 UI ----------

let toastTimer;
function toast(message, ms = 2200) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function setStatus(message, isError = false) {
  const el = $('#status');
  el.hidden = !message;
  el.textContent = message || '';
  el.classList.toggle('error', isError);
}

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('is-active', p.id === `tab-${name}`));
}

$$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

$$('#sourceTabs .seg-btn').forEach((btn) => btn.addEventListener('click', () => {
  $$('#sourceTabs .seg-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
  $$('.source-pane').forEach((p) => p.classList.toggle('is-active', p.dataset.pane === btn.dataset.source));
}));

// ---------- 目标色 ----------

function setTarget(hex, { fromInput = false } = {}) {
  if (!HEX_RE.test(hex)) return;
  state.targetHex = hex.toUpperCase();
  $('#targetSwatch').style.background = state.targetHex;
  $('#targetPicker').value = state.targetHex.toLowerCase();
  if (!fromInput) $('#targetHex').value = state.targetHex;
}

$('#targetPicker').addEventListener('input', (e) => setTarget(e.target.value));
$('#targetHex').addEventListener('input', (e) => {
  const v = e.target.value.trim();
  setTarget(v.startsWith('#') ? v : `#${v}`, { fromInput: true });
});
$('#targetHex').addEventListener('blur', () => { $('#targetHex').value = state.targetHex; });

// ---------- 素材载入（图片 / 视频帧 / 链接） ----------

const STAGE_MAX = 900;
const THUMB_SIZE = 160;

function drawToStage(source, width, height, label) {
  const scale = Math.min(1, STAGE_MAX / Math.max(width, height));
  const canvas = $('#stageCanvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

  state.sourceLabel = label;
  state.thumb = makeThumb(canvas);
  $('#stage').hidden = false;
  $('#stageHint').hidden = false;
  $('#loupe').hidden = true;

  try {
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    state.imageData = data;
    renderPalette(sampleForPalette(data));
  } catch {
    state.imageData = null;
    setStatus('该素材受跨域限制，无法读取像素。请下载后上传，或改用链接解析。', true);
  }
}

function makeThumb(canvas) {
  const scale = THUMB_SIZE / Math.max(canvas.width, canvas.height);
  const t = document.createElement('canvas');
  t.width = Math.max(1, Math.round(canvas.width * Math.min(1, scale)));
  t.height = Math.max(1, Math.round(canvas.height * Math.min(1, scale)));
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.7);
}

function sampleForPalette(imageData) {
  const { width, height, data } = imageData;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 6000)));
  const out = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      out.push(data[i], data[i + 1], data[i + 2], data[i + 3]);
    }
  }
  return new Uint8ClampedArray(out);
}

function renderPalette(pixels) {
  const palette = extractPalette(pixels, 6);
  $('#paletteBox').hidden = !palette.length;
  $('#palette').innerHTML = palette.map((c) => `
    <button class="chip" data-hex="${c.hex}" title="点击设为目标色">
      <span class="swatch" style="background:${c.hex}"></span>
      <span>${c.hex}</span><span>${Math.round(c.share * 100)}%</span>
    </button>`).join('');
  if (palette.length) setTarget(palette[0].hex);
}

$('#palette').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) setTarget(chip.dataset.hex);
});

$('#stageCanvas').addEventListener('click', (e) => {
  if (!state.imageData) return;
  const canvas = e.currentTarget;
  const rect = canvas.getBoundingClientRect();
  const x = Math.round(((e.clientX - rect.left) / rect.width) * canvas.width);
  const y = Math.round(((e.clientY - rect.top) / rect.height) * canvas.height);
  const half = 2;
  const { width, height, data } = state.imageData;
  let r = 0, g = 0, b = 0, n = 0;
  for (let yy = Math.max(0, y - half); yy <= Math.min(height - 1, y + half); yy += 1) {
    for (let xx = Math.max(0, x - half); xx <= Math.min(width - 1, x + half); xx += 1) {
      const i = (yy * width + xx) * 4;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1;
    }
  }
  setTarget(rgbToHex([r / n, g / n, b / n]));
  const marker = $('#loupe');
  marker.hidden = false;
  marker.style.left = `${e.clientX - rect.left}px`;
  marker.style.top = `${e.clientY - rect.top}px`;
});

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片无法加载或格式不受支持'));
    img.src = src;
  });
}

async function useImageFile(file) {
  if (!file || !file.type.startsWith('image/')) { setStatus('请选择图片文件', true); return; }
  setStatus('');
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(url);
    drawToStage(img, img.naturalWidth, img.naturalHeight, file.name);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function bindDrop(zone, input, handler) {
  input.addEventListener('change', () => { if (input.files[0]) handler(input.files[0]); input.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('is-over'); }));
  zone.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) handler(e.dataTransfer.files[0]); });
}

bindDrop($('#imageDrop'), $('#imageFile'), useImageFile);

document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  $$('#sourceTabs .seg-btn')[0].click();
  useImageFile(item.getAsFile());
});

// 视频
const video = $('#videoEl');
let videoUrl = null;

function useVideoSource(url, label, { revokeLater = false } = {}) {
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = revokeLater ? url : null;
  video.dataset.label = label;
  video.src = url;
  video.load();
  $('#videoBox').hidden = false;
  setStatus('拖动进度条选择画面后，点「截取当前帧」');
}

bindDrop($('#videoDrop'), $('#videoFile'), (file) => {
  if (!file.type.startsWith('video/')) { setStatus('请选择视频文件', true); return; }
  useVideoSource(URL.createObjectURL(file), file.name, { revokeLater: true });
});

video.addEventListener('error', () => setStatus('视频无法播放，浏览器可能不支持该编码，请转为 MP4 (H.264) 后重试', true));

const scrub = $('#scrub');
function syncScrub() {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  scrub.max = String(duration || 1);
  scrub.value = String(video.currentTime);
  $('#scrubTime').textContent = `${fmt(video.currentTime, 1)} / ${fmt(duration, 1)}s`;
}
['loadedmetadata', 'timeupdate', 'seeked', 'durationchange'].forEach((ev) => video.addEventListener(ev, syncScrub));
scrub.addEventListener('input', () => { video.pause(); video.currentTime = Number(scrub.value); });
const stepVideo = (delta) => {
  video.pause();
  video.currentTime = Math.min(video.duration || 0, Math.max(0, video.currentTime + delta));
};
$('#stepBack').addEventListener('click', () => stepVideo(-0.1));
$('#stepFwd').addEventListener('click', () => stepVideo(0.1));

$('#captureFrame').addEventListener('click', () => {
  if (!video.videoWidth) { setStatus('视频尚未加载完成', true); return; }
  video.pause();
  setStatus('');
  drawToStage(video, video.videoWidth, video.videoHeight, `${video.dataset.label || '视频'} @${fmt(video.currentTime, 1)}s`);
});

// 链接
async function apiJson(path, url) {
  const res = await fetch(`${path}?url=${encodeURIComponent(url)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `请求失败 (${res.status})`);
  return body;
}

const proxied = (url) => `/api/proxy?url=${encodeURIComponent(url)}`;

async function useRemoteImage(url) {
  setStatus('正在载入图片…');
  try {
    const img = await loadImageElement(proxied(url));
    setStatus('');
    drawToStage(img, img.naturalWidth, img.naturalHeight, url);
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function useRemoteVideo(url) {
  setStatus('正在下载视频…（上限 80MB）');
  try {
    const res = await fetch(proxied(url));
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `下载失败 (${res.status})`);
    const blob = await res.blob();
    $$('#sourceTabs .seg-btn')[1].click();
    useVideoSource(URL.createObjectURL(blob), url, { revokeLater: true });
  } catch (err) {
    setStatus(err.message, true);
  }
}

$('#linkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#linkGo');
  const box = $('#linkCandidates');
  box.innerHTML = '';
  btn.disabled = true;
  setStatus('正在解析链接…');
  try {
    const info = await apiJson('/api/resolve', $('#linkInput').value.trim());
    if (info.kind === 'image') { await useRemoteImage(info.url); return; }
    if (info.kind === 'video') { await useRemoteVideo(info.url); return; }
    setStatus(`${info.title ? `「${info.title}」：` : ''}找到 ${info.images.length} 张图片、${info.videos.length} 个视频，选择一个用于取色`);
    box.innerHTML = info.images.map((u) => `<button class="cand" data-kind="image" data-url="${esc(u)}"><img loading="lazy" alt="" src="${esc(proxied(u))}"></button>`).join('')
      + info.videos.map((u, i) => `<button class="cand video" data-kind="video" data-url="${esc(u)}">视频 ${i + 1}<br>点击载入</button>`).join('');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('#linkCandidates').addEventListener('click', (e) => {
  const cand = e.target.closest('.cand');
  if (!cand) return;
  if (cand.dataset.kind === 'image') useRemoteImage(cand.dataset.url);
  else useRemoteVideo(cand.dataset.url);
});

// ---------- 配比求解 ----------

$('#maxPigments').value = String(state.settings.maxPigments);
$('#totalGrams').value = String(state.settings.totalGrams);
$('#maxPigments').addEventListener('change', persistSettings);
$('#totalGrams').addEventListener('input', () => { persistSettings(); renderResults(); if (state.draft) syncDraftTotal(); });

function persistSettings() {
  state.settings = {
    maxPigments: Number($('#maxPigments').value),
    totalGrams: Math.max(0.1, Number($('#totalGrams').value) || 2),
  };
  save(KEYS.settings, state.settings);
}

$('#solveBtn').addEventListener('click', async () => {
  const usable = state.pigments.filter((p) => HEX_RE.test(p.hex));
  if (!usable.some((p) => p.kind !== 'effect' && p.owned)) { toast('请先在「原料库」勾选已有的颜料'); return; }
  const btn = $('#solveBtn');
  btn.disabled = true;
  btn.textContent = '计算中…';
  await new Promise((r) => setTimeout(r, 30));
  try {
    const raw = solveWithPreference(state.targetHex, usable, { maxPigments: state.settings.maxPigments });
    const toItems = (r) => ({
      ...r,
      items: r.items.map((it) => ({ pigment: pigmentSnapshot(usable.find((p) => p.id === it.id)), parts: it.pct, extra: !!it.extra })),
    });
    state.results = { preferred: raw.preferred.map(toItems), supplement: raw.supplement.map(toItems) };
    state.effectRecs = recommendEffects(state.targetHex, usable);
    renderResults();
  } finally {
    btn.disabled = false;
    btn.textContent = '生成配比';
  }
});

function resultCard(r, key, recommended, tag) {
  const total = state.settings.totalGrams;
  const pcts = percentsOf(r.items);
  return `
    <div class="result ${recommended ? 'rec' : ''}">
      <div class="result-head">
        <strong>${r.count} 种颜料${recommended ? `<span class="tag">${tag}</span>` : ''}</strong>
        <button class="btn small primary" data-use="${key}">编辑并记录</button>
      </div>
      <div class="pair">
        <figure><div class="swatch" style="background:${state.targetHex}"></div>目标 ${state.targetHex}</figure>
        <figure><div class="swatch" style="background:${r.hex}"></div>预测 ${r.hex}</figure>
      </div>
      <div class="de">色差 ΔE00 <b>${fmt(r.deltaE, 1)}</b>：${describeDeltaE(r.deltaE)}</div>
      ${r.items.map((it, n) => `
        <div class="ing">
          <span class="dot" style="background:${it.pigment.hex}"></span>
          <span>${esc(it.pigment.name)}${it.extra ? '<span class="tag warn">需另购</span>' : ''}</span>
          <span class="bar"><i style="width:${pcts[n]}%"></i></span>
          <span class="num">${fmt(pcts[n], 0)}%</span>
          <span class="num muted">${fmt((total * pcts[n]) / 100)}g</span>
        </div>`).join('')}
    </div>`;
}

function effectCard() {
  if (!state.effectRecs.length) return '';
  const total = state.settings.totalGrams;
  return `
    <div class="result fx">
      <div class="result-head"><strong>效果粉建议（可选）</strong></div>
      <p class="hint">按正面 / 侧视色与目标色的接近程度排序；实际闪色效果取决于底色、粉量和观察角度，请先小样试色。</p>
      ${state.effectRecs.map((r) => `
        <div class="fx-row">
          <span class="dot" style="background:${r.pigment.hex}"></span>
          ${r.pigment.hex2 ? `<span class="dot" style="background:${r.pigment.hex2}"></span>` : ''}
          <span class="grow">${esc(r.pigment.name)}<br><span class="muted">ΔE00 ${fmt(r.deltaE, 1)} · 建议 ${fmt(r.pigment.dose, 0)}%（约 ${fmt((total * r.pigment.dose) / 100)}g）</span></span>
          <button class="btn small" data-fx="${esc(r.pigment.id)}">加到当前配方</button>
        </div>`).join('')}
    </div>`;
}

function renderResults() {
  const box = $('#results');
  const { preferred, supplement } = state.results;
  if (!preferred.length && !supplement.length) {
    box.innerHTML = '';
    return;
  }
  const best = preferred.length ? Math.min(...preferred.map((r) => r.deltaE)) : Infinity;
  const recP = pickRecommended(preferred);
  const recS = best > 6 ? pickRecommended(supplement) : -1;
  let html = '<h3 class="group-title">使用你的原料（首选）</h3>';
  html += preferred.length
    ? preferred.map((r, i) => resultCard(r, `p:${i}`, i === recP, '推荐')).join('')
    : '<p class="hint">没有勾选「已有 + 首选」的颜料，请到「原料库」设置。</p>';
  if (supplement.length) {
    html += `<h3 class="group-title">你的原料色域不足（最佳 ΔE00 ${fmt(best, 1)}），可选补充方案</h3>`;
    html += supplement.map((r, i) => resultCard(r, `s:${i}`, i === recS, '补充推荐')).join('');
  }
  if (preferred.length && best > 6 && !supplement.length) {
    html += `<p class="hint">你的原料最佳色差 ΔE00 为 ${fmt(best, 1)}，通用参考颜料里也没有明显更好的组合。高饱和的荧光 / 霓虹色通常超出颜料色域，建议选择接近的柔和色，或用效果粉叠加。</p>`;
  }
  box.innerHTML = html + effectCard();
}

$('#results').addEventListener('click', (e) => {
  const fx = e.target.closest('[data-fx]');
  if (fx) {
    if (!state.draft) { toast('先对某个方案点「编辑并记录」，再加效果粉'); return; }
    const p = state.pigments.find((x) => x.id === fx.dataset.fx);
    if (p && !state.draft.effects.some((it) => it.pigment.id === p.id)) {
      state.draft.effects.push({ pigment: pigmentSnapshot(p), pct: p.dose || 6 });
      renderEditor();
      toast(`已加入 ${p.name}`);
    }
    return;
  }
  const btn = e.target.closest('[data-use]');
  if (!btn) return;
  const [group, idx] = btn.dataset.use.split(':');
  const r = (group === 'p' ? state.results.preferred : state.results.supplement)[Number(idx)];
  startDraft({
    items: clone(r.items),
    note: `${r.count} 种颜料方案，预测色差 ΔE00 ${fmt(r.deltaE, 1)}${group === 's' ? '（含需另购的补充颜料）' : ''}`,
  });
  $('#editorCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function percentsOf(items) {
  const total = items.reduce((s, it) => s + (Number(it.parts) > 0 ? Number(it.parts) : 0), 0);
  return items.map((it) => (total ? ((Number(it.parts) > 0 ? Number(it.parts) : 0) / total) * 100 : 0));
}

// ---------- 配方编辑器 ----------

function startDraft({ items = [], note = '', base = null } = {}) {
  state.draft = base ? clone(base) : {
    id: null,
    name: '',
    targetHex: state.targetHex,
    items,
    effects: [],
    totalGrams: state.settings.totalGrams,
    note,
    actualHex: '',
    thumb: state.thumb,
    sourceLabel: state.sourceLabel,
  };
  renderEditor();
}

function syncDraftTotal() {
  state.draft.totalGrams = state.settings.totalGrams;
  const input = $('#dTotal');
  if (input) input.value = String(state.draft.totalGrams);
  refreshDraftDerived();
}

$('#newManual').addEventListener('click', () => {
  startDraft({ items: [] });
  $('#editorCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function renderEditor() {
  const box = $('#editor');
  const d = state.draft;
  if (!d) {
    box.innerHTML = '<div class="empty">生成配比后点「编辑并记录」，或点右上角「新建手动配方」。</div>';
    return;
  }
  if (!d.effects) d.effects = [];
  const addable = state.pigments.filter((p) => p.kind !== 'effect' && !d.items.some((it) => it.pigment.id === p.id));
  const addableFx = state.pigments.filter((p) => p.kind === 'effect' && !d.effects.some((it) => it.pigment.id === p.id));
  box.innerHTML = `
    <div class="edit-grid">
      <div>
        <label class="field">配方名称
          <input type="text" id="dName" placeholder="例如：雾霾蓝 01" value="${esc(d.name)}">
        </label>
        <h3>原料与份数</h3>
        <div class="edit-items" id="dItems">
          ${d.items.map((it, i) => `
            <div class="edit-item" data-i="${i}">
              <span class="dot" style="background:${it.pigment.hex}"></span>
              <span>${esc(it.pigment.name)} <span class="muted">${esc(it.pigment.code || '')}</span></span>
              <input type="number" min="0" step="any" value="${esc(it.parts)}" data-parts="${i}" aria-label="份数">
              <span class="num muted" data-pct="${i}"></span>
              <button class="x" data-remove="${i}" title="移除">×</button>
            </div>`).join('') || '<div class="hint">还没有原料，从下面添加。</div>'}
        </div>
        <div class="add-row">
          <select id="dAdd">${addable.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} ${esc(p.code || '')}</option>`).join('')}</select>
          <button class="btn" id="dAddBtn" ${addable.length ? '' : 'disabled'}>添加原料</button>
        </div>
        <p class="hint">份数可填任意正数（如 3 : 2 : 1，或直接填克数），会自动换算成百分比。</p>
        <h3>效果粉（珠光 / 变色龙，可选）</h3>
        <div class="edit-items">
          ${d.effects.map((it, i) => `
            <div class="edit-item fx" data-i="${i}">
              <span class="dot" style="background:${it.pigment.hex}"></span>
              <span>${esc(it.pigment.name)} ${it.pigment.hex2 ? `<span class="dot sm" style="background:${it.pigment.hex2}"></span>` : ''}</span>
              <input type="number" min="0" step="any" value="${esc(it.pct)}" data-fxpct="${i}" aria-label="占基础原料质量百分比">
              <span class="num muted">%</span>
              <button class="x" data-remove-fx="${i}" title="移除">×</button>
            </div>`).join('') || '<div class="hint">未添加。数值为占基础原料质量的百分比，不参与色相预测。</div>'}
        </div>
        <div class="add-row">
          <select id="dAddFx">${addableFx.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>
          <button class="btn" id="dAddFxBtn" ${addableFx.length ? '' : 'disabled'}>添加效果粉</button>
        </div>
        <label class="field">备注
          <textarea id="dNote" placeholder="纸张、干燥后变化、颗粒感、沉淀、使用感受…">${esc(d.note)}</textarea>
        </label>
      </div>
      <div>
        <div class="preview-row">
          <figure><div class="swatch" style="background:${esc(d.targetHex || '#cccccc')}"></div>目标</figure>
          <figure><div class="swatch" id="dPred"></div><span id="dPredLabel">预测（不含效果粉）</span></figure>
          <figure><div class="swatch" id="dActual"></div>实际成品</figure>
        </div>
        <div class="row">
          <label class="field grow">实际成品色（可选，做好后取色填入）
            <span class="row">
              <input type="color" id="dActualPicker" value="${HEX_RE.test(d.actualHex) ? d.actualHex.toLowerCase() : '#ffffff'}">
              <input type="text" id="dActualHex" maxlength="7" placeholder="#RRGGBB" value="${esc(d.actualHex)}">
              <button class="btn small" id="dActualUse" title="把当前目标色作为实际成品色">取当前目标色</button>
            </span>
          </label>
        </div>
        <div class="de" id="dDe"></div>
        <label class="field">每批基础原料总量（g）
          <input type="number" id="dTotal" min="0.1" step="0.1" value="${esc(d.totalGrams)}">
        </label>
        <table class="plan" id="dPlan"></table>
        <div class="row" style="margin-top:14px">
          <button class="btn primary grow" id="dSave">${d.id ? '保存修改' : '保存到配方记录'}</button>
          ${d.id ? '<button class="btn" id="dSaveCopy">另存为新配方</button>' : ''}
        </div>
      </div>
    </div>`;
  refreshDraftDerived();
}

function refreshDraftDerived() {
  const d = state.draft;
  if (!d || !$('#dPred')) return;
  const pcts = percentsOf(d.items);
  d.items.forEach((_, i) => {
    const el = $(`[data-pct="${i}"]`);
    if (el) el.textContent = `${fmt(pcts[i], 0)}%`;
  });

  const predicted = d.items.some((it) => Number(it.parts) > 0)
    ? mixHex(d.items.map((it) => ({ pigment: it.pigment, weight: Number(it.parts) || 0 })))
    : null;
  $('#dPred').style.background = predicted || 'transparent';
  $('#dPredLabel').textContent = predicted ? `预测 ${predicted}（不含效果粉）` : '预测（不含效果粉）';
  const actual = HEX_RE.test(d.actualHex) ? d.actualHex : null;
  $('#dActual').style.background = actual || 'transparent';

  const lines = [];
  if (predicted && d.targetHex) {
    lines.push(`预测 vs 目标 ΔE00 <b>${fmt(deltaE2000(hexToLab(predicted), hexToLab(d.targetHex)), 1)}</b>`);
  }
  if (actual && d.targetHex) {
    lines.push(`实际 vs 目标 ΔE00 <b>${fmt(deltaE2000(hexToLab(actual), hexToLab(d.targetHex)), 1)}</b>`);
  }
  $('#dDe').innerHTML = lines.join('　·　');
  d.predictedHex = predicted;

  const total = Number(d.totalGrams) > 0 ? Number(d.totalGrams) : 0;
  const active = d.items.map((it, i) => ({ pigment: it.pigment, pct: pcts[i] })).filter((it) => it.pct > 0);
  const fx = d.effects.filter((it) => Number(it.pct) > 0).map((it) => ({ pigment: it.pigment, pct: Number(it.pct) }));
  const plan = batchPlan(active, total, state.additives, fx);
  $('#dPlan').innerHTML = active.length ? `
    <thead><tr><th>原料</th><th class="num">占比</th><th class="num">颜料 g</th><th class="num">${esc(state.binderName)} g</th></tr></thead>
    <tbody>
      ${plan.pigments.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${fmt(p.pct, 1)}%</td><td class="num">${fmt(p.grams)}</td><td class="num">${fmt(p.binderGrams)}</td></tr>`).join('')}
      ${plan.effects.map((p) => `<tr><td>${esc(p.name)} <span class="muted">效果粉</span></td><td class="num">+${fmt(p.pct, 1)}%</td><td class="num">${fmt(p.grams)}</td><td class="num">${fmt(p.binderGrams)}</td></tr>`).join('')}
      ${plan.extras.map((x) => `<tr class="muted"><td>${esc(x.name)}</td><td></td><td class="num"></td><td class="num">${fmt(x.grams)}</td></tr>`).join('')}
    </tbody>
    <tfoot><tr><td>基础原料合计</td><td class="num">100%</td><td class="num">${fmt(total)}</td><td class="num">${fmt(plan.binderTotal)} + 辅料</td></tr></tfoot>` : '';
}

$('#editor').addEventListener('input', (e) => {
  const d = state.draft;
  const t = e.target;
  if (!d) return;
  if (t.dataset.parts !== undefined) d.items[Number(t.dataset.parts)].parts = t.value;
  else if (t.dataset.fxpct !== undefined) d.effects[Number(t.dataset.fxpct)].pct = t.value;
  else if (t.id === 'dName') d.name = t.value;
  else if (t.id === 'dNote') d.note = t.value;
  else if (t.id === 'dTotal') d.totalGrams = t.value;
  else if (t.id === 'dActualPicker') { d.actualHex = t.value.toUpperCase(); $('#dActualHex').value = d.actualHex; }
  else if (t.id === 'dActualHex') { d.actualHex = t.value.trim().toUpperCase(); if (HEX_RE.test(d.actualHex)) $('#dActualPicker').value = d.actualHex.toLowerCase(); }
  else return;
  refreshDraftDerived();
});

$('#editor').addEventListener('click', (e) => {
  const d = state.draft;
  const t = e.target.closest('button');
  if (!d || !t) return;
  if (t.dataset.remove !== undefined) {
    d.items.splice(Number(t.dataset.remove), 1);
    renderEditor();
  } else if (t.dataset.removeFx !== undefined) {
    d.effects.splice(Number(t.dataset.removeFx), 1);
    renderEditor();
  } else if (t.id === 'dAddFxBtn') {
    const p = state.pigments.find((x) => x.id === $('#dAddFx').value);
    if (p) { d.effects.push({ pigment: pigmentSnapshot(p), pct: p.dose || 6 }); renderEditor(); }
  } else if (t.id === 'dAddBtn') {
    const p = state.pigments.find((x) => x.id === $('#dAdd').value);
    if (p) { d.items.push({ pigment: pigmentSnapshot(p), parts: 1 }); renderEditor(); }
  } else if (t.id === 'dActualUse') {
    d.actualHex = state.targetHex;
    renderEditor();
  } else if (t.id === 'dSave') saveDraft(false);
  else if (t.id === 'dSaveCopy') saveDraft(true);
});

function saveDraft(asNew) {
  const d = state.draft;
  const items = d.items.filter((it) => Number(it.parts) > 0);
  if (!items.length) { toast('请至少添加一种份数大于 0 的原料'); return; }
  const pcts = percentsOf(items);
  const record = {
    id: d.id && !asNew ? d.id : uid(),
    name: d.name.trim() || `配方 ${new Date().toLocaleDateString('zh-CN')}`,
    createdAt: d.createdAt && !asNew ? d.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    targetHex: d.targetHex,
    predictedHex: d.predictedHex,
    actualHex: HEX_RE.test(d.actualHex) ? d.actualHex : '',
    totalGrams: Number(d.totalGrams) || state.settings.totalGrams,
    items: items.map((it, i) => ({ ...it.pigment, parts: Number(it.parts), pct: Math.round(pcts[i] * 10) / 10 })),
    effects: (d.effects || []).filter((it) => Number(it.pct) > 0).map((it) => ({ ...it.pigment, pct: Number(it.pct) })),
    note: d.note.trim(),
    thumb: d.thumb || null,
    sourceLabel: d.sourceLabel || '',
  };
  const idx = state.recipes.findIndex((r) => r.id === record.id);
  if (idx >= 0) state.recipes[idx] = record;
  else state.recipes.unshift(record);
  save(KEYS.recipes, state.recipes);
  renderRecords();
  toast(idx >= 0 ? '已保存修改' : '已保存到配方记录');
  state.draft = null;
  renderEditor();
  switchTab('records');
}

// ---------- 配方记录 ----------

const recipeMatches = (r, q) => !q || [r.name, r.note, r.sourceLabel, ...r.items.map((it) => it.name), ...(r.effects || []).map((it) => it.name)].some((s) => String(s || '').toLowerCase().includes(q));

function renderRecords() {
  $('#recordCount').textContent = state.recipes.length;
  const q = state.recordQuery.trim().toLowerCase();
  const list = state.recipes.filter((r) => recipeMatches(r, q));
  const box = $('#recordList');
  if (!list.length) {
    box.innerHTML = `<div class="empty" style="grid-column:1/-1">${state.recipes.length ? '没有匹配的配方' : '还没有记录。去「配色生成」创建第一个配方吧。'}</div>`;
    return;
  }
  box.innerHTML = list.map((r) => `
    <article class="rec-card">
      <div class="rec-top">
        ${r.thumb ? `<img alt="" src="${esc(r.thumb)}">` : ''}
        <div class="swatch" style="background:${esc(r.targetHex)}"><span>目标</span></div>
        <div class="swatch" style="background:${esc(r.predictedHex || r.targetHex)}"><span>预测</span></div>
        ${r.actualHex ? `<div class="swatch" style="background:${esc(r.actualHex)}"><span>实际</span></div>` : ''}
      </div>
      <div class="rec-body">
        <h3>${esc(r.name)}</h3>
        <div class="rec-meta">${new Date(r.createdAt).toLocaleString('zh-CN')} · 每批基础原料 ${fmt(r.totalGrams, 1)}g${r.sourceLabel ? ` · 来源 ${esc(r.sourceLabel.slice(0, 40))}` : ''}</div>
        ${r.items.map((it) => `
          <div class="ing" style="grid-template-columns:14px 1fr 46px 56px">
            <span class="dot" style="background:${esc(it.hex)}"></span><span>${esc(it.name)}</span>
            <span class="num">${fmt(it.pct, 0)}%</span><span class="num muted">${fmt((r.totalGrams * it.pct) / 100)}g</span>
          </div>`).join('')}
        ${(r.effects || []).map((it) => `
          <div class="ing" style="grid-template-columns:14px 1fr 56px 56px">
            <span class="dot" style="background:${esc(it.hex)}"></span><span>${esc(it.name)} <span class="muted">效果粉</span></span>
            <span class="num">+${fmt(it.pct, 1)}%</span><span class="num muted">${fmt((r.totalGrams * it.pct) / 100)}g</span>
          </div>`).join('')}
        ${r.note ? `<div class="rec-note">${esc(r.note)}</div>` : ''}
      </div>
      <div class="rec-actions">
        <button class="btn small" data-edit="${esc(r.id)}">编辑</button>
        <button class="btn small danger" data-del="${esc(r.id)}">删除</button>
      </div>
    </article>`).join('');
}

$('#recordSearch').addEventListener('input', (e) => { state.recordQuery = e.target.value; renderRecords(); });

$('#recordList').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit]');
  const del = e.target.closest('[data-del]');
  if (edit) {
    const r = state.recipes.find((x) => x.id === edit.dataset.edit);
    if (!r) return;
    startDraft({
      base: {
        id: r.id,
        createdAt: r.createdAt,
        name: r.name,
        targetHex: r.targetHex,
        items: r.items.map((it) => ({ pigment: { id: it.id, name: it.name, code: it.code, hex: it.hex, strength: it.strength, opacity: it.opacity, binder: it.binder }, parts: it.parts })),
        effects: (r.effects || []).map((it) => ({ pigment: { id: it.id, name: it.name, code: it.code, hex: it.hex, hex2: it.hex2, kind: 'effect', subtype: it.subtype, dose: it.dose, binder: it.binder }, pct: it.pct })),
        totalGrams: r.totalGrams,
        note: r.note,
        actualHex: r.actualHex,
        thumb: r.thumb,
        sourceLabel: r.sourceLabel,
      },
    });
    switchTab('make');
    $('#editorCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (del) {
    const r = state.recipes.find((x) => x.id === del.dataset.del);
    if (r && confirm(`删除配方「${r.name}」？此操作不可撤销。`)) {
      state.recipes = state.recipes.filter((x) => x.id !== r.id);
      save(KEYS.recipes, state.recipes);
      renderRecords();
    }
  }
});

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const stamp = () => new Date().toISOString().slice(0, 10);

$('#exportJson').addEventListener('click', () => {
  download(`watercolor-recipes-${stamp()}.json`, JSON.stringify({
    version: 1, exportedAt: new Date().toISOString(), recipes: state.recipes, pigments: state.pigments, additives: state.additives, binderName: state.binderName,
  }, null, 2), 'application/json');
});

$('#exportCsv').addEventListener('click', () => {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['名称', '日期', '目标色', '预测色', '实际成品色', '每批基础原料g', '原料(占比%)', '原料克数', '效果粉(占基础原料%)', '备注', '来源']];
  for (const r of state.recipes) {
    rows.push([
      r.name, r.createdAt.slice(0, 10), r.targetHex, r.predictedHex, r.actualHex, r.totalGrams,
      r.items.map((it) => `${it.name} ${fmt(it.pct, 1)}%`).join(' + '),
      r.items.map((it) => `${it.name} ${fmt((r.totalGrams * it.pct) / 100)}g`).join(' + '),
      (r.effects || []).map((it) => `${it.name} ${fmt(it.pct, 1)}% (${fmt((r.totalGrams * it.pct) / 100)}g)`).join(' + '),
      r.note, r.sourceLabel,
    ]);
  }
  download(`watercolor-recipes-${stamp()}.csv`, `\ufeff${rows.map((row) => row.map(cell).join(',')).join('\r\n')}`, 'text/csv');
});

$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = Array.isArray(data) ? data : data.recipes;
    if (!Array.isArray(incoming)) throw new Error('文件中没有 recipes 数组');
    const valid = incoming.filter((r) => r && Array.isArray(r.items) && HEX_RE.test(r.targetHex || ''));
    const known = new Set(state.recipes.map((r) => r.id));
    let added = 0;
    for (const r of valid) {
      if (r.id && known.has(r.id)) continue;
      state.recipes.push({ ...r, id: r.id || uid(), createdAt: r.createdAt || new Date().toISOString() });
      added += 1;
    }
    state.recipes.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    save(KEYS.recipes, state.recipes);
    renderRecords();
    toast(`导入 ${added} 条，跳过 ${incoming.length - added} 条（重复或格式不符）`, 3500);
  } catch (err) {
    toast(`导入失败：${err.message}`, 3500);
  }
});

// ---------- 原料库 ----------

const GROUP_TITLES = { mine: '我的原料（配色时首选）', generic: '通用参考颜料（仅在我的原料色域不足时作为补充建议）' };

function pigmentRow(p, i) {
  const isFx = p.kind === 'effect';
  const flag = p.calibrated === false ? '<span class="tag warn" title="色值仍是预设估计，请用实物色卡校准">待校准</span>' : '';
  const side = isFx
    ? `<span class="c-hex"><input type="color" data-f="hex2Pick" value="${esc((p.hex2 || '#ffffff').toLowerCase())}"><input type="text" data-f="hex2" maxlength="7" value="${esc(p.hex2 || '')}"></span>`
    : '<span class="muted">—</span>';
  const params = isFx
    ? `<td colspan="2"><span class="row">建议用量 <input class="w-num" type="number" data-f="dose" min="0" step="0.5" value="${esc(p.dose ?? 6)}"> %</span></td>`
    : `<td><input class="w-num" type="number" data-f="strength" min="0.1" step="0.1" value="${esc(p.strength)}"></td>
      <td><input class="w-num" type="number" data-f="opacity" min="0.05" max="1" step="0.05" value="${esc(p.opacity)}"></td>`;
  return `
    <tr data-i="${i}">
      <td><input type="checkbox" data-f="owned" ${p.owned ? 'checked' : ''} aria-label="已有"></td>
      <td><input type="checkbox" data-f="preferred" ${p.preferred ? 'checked' : ''} aria-label="首选"></td>
      <td><span class="c-hex"><input type="color" data-f="hexPick" value="${esc(p.hex.toLowerCase())}"><input type="text" data-f="hex" maxlength="7" value="${esc(p.hex)}"></span></td>
      <td>${side}</td>
      <td><input type="text" data-f="name" value="${esc(p.name)}">${flag}</td>
      <td><input class="w-code" type="text" data-f="code" value="${esc(p.code || '')}"></td>
      ${params}
      <td><input class="w-num" type="number" data-f="binder" min="0" step="0.1" value="${esc(p.binder)}"></td>
      <td class="acts">
        <button class="btn small" data-act="calib" title="用当前目标色作为${isFx ? '正面主色' : '色值'}">${isFx ? '取主色' : '取目标色'}</button>
        ${isFx ? '<button class="btn small" data-act="calib2" title="用当前目标色作为侧视色">取侧色</button>' : ''}
        <button class="btn small danger" data-act="del">删除</button>
      </td>
    </tr>`;
}

function renderLibrary() {
  let html = '';
  for (const group of ['mine', 'generic']) {
    const rows = state.pigments.map((p, i) => ({ p, i })).filter(({ p }) => (p.group || 'generic') === group);
    if (!rows.length) continue;
    const pending = rows.filter(({ p }) => p.calibrated === false).length;
    html += `<tr class="group-row"><td colspan="10">${GROUP_TITLES[group]}　<span class="muted">${rows.length} 项${pending ? `，${pending} 项待校准` : ''}</span></td></tr>`;
    html += rows.map(({ p, i }) => pigmentRow(p, i)).join('');
  }
  $('#pigmentRows').innerHTML = html;
  $('#binderName').value = state.binderName;
  $('#additiveRows').innerHTML = state.additives.map((a, i) => `
    <div class="additive" data-i="${i}">
      <input type="text" data-a="name" value="${esc(a.name)}" aria-label="辅料名称">
      <span class="row"><input type="number" data-a="ratio" min="0" step="0.5" value="${esc(a.ratio)}" aria-label="占基础原料质量百分比"> %</span>
      <button class="x" data-a-del="${i}" title="移除">×</button>
    </div>`).join('') || '<div class="hint">没有辅料。</div>';
  renderCalibSelect();
}

function persistLibrary() {
  save(KEYS.pigments, state.pigments);
  save(KEYS.additives, state.additives);
  save(KEYS.binder, state.binderName);
}

$('#pigmentRows').addEventListener('input', (e) => {
  const tr = e.target.closest('tr');
  const f = e.target.dataset.f;
  if (!tr || !f) return;
  const p = state.pigments[Number(tr.dataset.i)];
  if (f === 'owned' || f === 'preferred') p[f] = e.target.checked;
  else if (f === 'hexPick' || f === 'hex2Pick') {
    const key = f === 'hexPick' ? 'hex' : 'hex2';
    p[key] = e.target.value.toUpperCase();
    p.calibrated = true;
    $(`[data-f=${key}]`, tr).value = p[key];
  } else if (f === 'hex' || f === 'hex2') {
    const v = e.target.value.trim();
    if (HEX_RE.test(v)) {
      p[f] = v.toUpperCase();
      p.calibrated = true;
      $(`[data-f=${f}Pick]`, tr).value = v.toLowerCase();
    }
  } else if (['strength', 'opacity', 'binder', 'dose'].includes(f)) {
    const n = Number(e.target.value);
    if (Number.isFinite(n) && n >= 0) p[f] = n;
  } else p[f] = e.target.value;
  persistLibrary();
  if (f === 'name') renderCalibSelect();
});

$('#pigmentRows').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  const tr = e.target.closest('tr');
  if (!btn || !tr) return;
  const i = Number(tr.dataset.i);
  const p = state.pigments[i];
  if (btn.dataset.act === 'calib' || btn.dataset.act === 'calib2') {
    p[btn.dataset.act === 'calib' ? 'hex' : 'hex2'] = state.targetHex;
    p.calibrated = true;
    toast(`已将「${p.name}」设为 ${state.targetHex}`);
  } else if (confirm(`删除「${p.name}」？已保存的配方不受影响。`)) {
    state.pigments.splice(i, 1);
  } else return;
  persistLibrary();
  renderLibrary();
});

function addPigment(kind) {
  const isFx = kind === 'effect';
  state.pigments.push({
    id: `custom-${uid()}`,
    name: isFx ? '新效果粉' : '新颜料',
    code: '',
    hex: state.targetHex,
    ...(isFx ? { hex2: state.targetHex, dose: 6, subtype: 'pearl' } : {}),
    kind: isFx ? 'effect' : 'color',
    group: 'mine',
    preferred: true,
    owned: true,
    calibrated: true,
    strength: 1,
    opacity: isFx ? 0.2 : 0.4,
    binder: isFx ? 1 : 0,
  });
  persistLibrary();
  renderLibrary();
}

$('#addPigment').addEventListener('click', () => addPigment('color'));
$('#addEffect').addEventListener('click', () => addPigment('effect'));

$('#resetPigments').addEventListener('click', () => {
  if (!confirm('将原料库恢复为默认列表？你添加或修改的原料（包括已校准的色值）会丢失，已保存的配方不受影响。')) return;
  state.pigments = clone(DEFAULT_PIGMENTS);
  persistLibrary();
  renderLibrary();
});

// 色卡校准：载入色卡照片并点击某个色块后，把当前目标色写入所选原料，并自动跳到下一个待校准项。
function renderCalibSelect(selectedId) {
  const select = $('#calibSelect');
  const keep = selectedId || select.value;
  select.innerHTML = state.pigments.map((p) => `<option value="${esc(p.id)}">${p.calibrated === false ? '○' : '✓'} ${esc(p.name)}${p.kind === 'effect' ? '（效果粉）' : ''}</option>`).join('');
  if (state.pigments.some((p) => p.id === keep)) select.value = keep;
  const p = state.pigments.find((x) => x.id === select.value);
  $('#calibSide').hidden = !(p && p.kind === 'effect');
}

$('#calibSelect').addEventListener('change', () => renderCalibSelect());

function applyCalibration(key) {
  const select = $('#calibSelect');
  const idx = state.pigments.findIndex((p) => p.id === select.value);
  if (idx < 0) return;
  const p = state.pigments[idx];
  p[key] = state.targetHex;
  p.calibrated = true;
  persistLibrary();
  const order = [...state.pigments.slice(idx + 1), ...state.pigments.slice(0, idx)];
  const stay = p.kind === 'effect' && key === 'hex';
  const next = stay ? p : order.find((q) => q.calibrated === false && (q.group || 'generic') === (p.group || 'generic')) || p;
  renderLibrary();
  renderCalibSelect(next.id);
  toast(`已校准「${p.name}」→ ${state.targetHex}${next !== p ? `，下一个：${next.name}` : ''}`);
}

$('#calibMain').addEventListener('click', () => applyCalibration('hex'));
$('#calibSide').addEventListener('click', () => applyCalibration('hex2'));

$('#binderName').addEventListener('input', (e) => { state.binderName = e.target.value; persistLibrary(); refreshDraftDerived(); });

$('#additiveRows').addEventListener('input', (e) => {
  const row = e.target.closest('.additive');
  const key = e.target.dataset.a;
  if (!row || !key) return;
  const a = state.additives[Number(row.dataset.i)];
  if (key === 'ratio') a.ratio = Math.max(0, Number(e.target.value) || 0);
  else a.name = e.target.value;
  persistLibrary();
  refreshDraftDerived();
});

$('#additiveRows').addEventListener('click', (e) => {
  const del = e.target.closest('[data-a-del]');
  if (!del) return;
  state.additives.splice(Number(del.dataset.aDel), 1);
  persistLibrary();
  renderLibrary();
  refreshDraftDerived();
});

$('#addAdditive').addEventListener('click', () => {
  state.additives.push({ name: '新辅料', ratio: 1 });
  persistLibrary();
  renderLibrary();
});

// ---------- 初始化 ----------

setTarget(state.targetHex);
persistLibrary();
renderLibrary();
renderRecords();
renderEditor();
