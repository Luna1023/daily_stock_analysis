import {
  batchPlan, describeDeltaE, deltaE2000, extractPalette, hexToLab, mixHex, pickRecommended, rgbToHex, solveRecipe,
} from './engine.js';
import { DEFAULT_ADDITIVES, DEFAULT_BINDER_NAME, DEFAULT_PIGMENTS } from './pigments.js';

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
  pigments: load(KEYS.pigments, DEFAULT_PIGMENTS),
  additives: load(KEYS.additives, DEFAULT_ADDITIVES),
  binderName: load(KEYS.binder, DEFAULT_BINDER_NAME),
  recipes: load(KEYS.recipes, []),
  settings: load(KEYS.settings, { maxPigments: 3, totalGrams: 2 }),
  targetHex: '#6C8EBF',
  thumb: null,
  sourceLabel: '',
  results: [],
  draft: null,
  imageData: null,
  recordQuery: '',
};

const pigmentSnapshot = (p) => ({ id: p.id, name: p.name, code: p.code, hex: p.hex, strength: p.strength, opacity: p.opacity, binder: p.binder });

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

const ownedPigments = () => state.pigments.filter((p) => p.owned && HEX_RE.test(p.hex));

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
  const owned = ownedPigments();
  if (owned.length < 2) { toast('请先在「原料库」勾选至少 2 种已有颜料'); return; }
  const btn = $('#solveBtn');
  btn.disabled = true;
  btn.textContent = '计算中…';
  await new Promise((r) => setTimeout(r, 30));
  try {
    const raw = solveRecipe(state.targetHex, owned, { maxPigments: state.settings.maxPigments });
    state.results = raw.map((r) => ({ ...r, items: r.items.map((it) => ({ pigment: pigmentSnapshot(owned.find((p) => p.id === it.id)), parts: it.pct })) }));
    renderResults();
  } finally {
    btn.disabled = false;
    btn.textContent = '生成配比';
  }
});

function renderResults() {
  const box = $('#results');
  if (!state.results.length) { box.innerHTML = ''; return; }
  const rec = pickRecommended(state.results);
  const total = state.settings.totalGrams;
  box.innerHTML = state.results.map((r, i) => {
    const pcts = percentsOf(r.items);
    return `
    <div class="result ${i === rec ? 'rec' : ''}">
      <div class="result-head">
        <strong>${r.count} 种颜料${i === rec ? '<span class="tag">推荐</span>' : ''}</strong>
        <button class="btn small primary" data-use="${i}">编辑并记录</button>
      </div>
      <div class="pair">
        <figure><div class="swatch" style="background:${state.targetHex}"></div>目标 ${state.targetHex}</figure>
        <figure><div class="swatch" style="background:${r.hex}"></div>预测 ${r.hex}</figure>
      </div>
      <div class="de">色差 ΔE00 <b>${fmt(r.deltaE, 1)}</b>：${describeDeltaE(r.deltaE)}</div>
      ${r.items.map((it, n) => `
        <div class="ing">
          <span class="dot" style="background:${it.pigment.hex}"></span>
          <span>${esc(it.pigment.name)}</span>
          <span class="bar"><i style="width:${pcts[n]}%"></i></span>
          <span class="num">${fmt(pcts[n], 0)}%</span>
          <span class="num muted">${fmt((total * pcts[n]) / 100)}g</span>
        </div>`).join('')}
    </div>`;
  }).join('');
}

$('#results').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-use]');
  if (!btn) return;
  const r = state.results[Number(btn.dataset.use)];
  startDraft({
    items: clone(r.items),
    note: `${r.count} 种颜料方案，预测色差 ΔE00 ${fmt(r.deltaE, 1)}`,
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
  const addable = state.pigments.filter((p) => !d.items.some((it) => it.pigment.id === p.id));
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
        <label class="field">备注
          <textarea id="dNote" placeholder="纸张、干燥后变化、颗粒感、沉淀、使用感受…">${esc(d.note)}</textarea>
        </label>
      </div>
      <div>
        <div class="preview-row">
          <figure><div class="swatch" style="background:${esc(d.targetHex || '#cccccc')}"></div>目标</figure>
          <figure><div class="swatch" id="dPred"></div><span id="dPredLabel">预测</span></figure>
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
        <label class="field">每批颜料总量（g）
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
  $('#dPredLabel').textContent = predicted ? `预测 ${predicted}` : '预测';
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
  const plan = batchPlan(active, total, state.additives);
  $('#dPlan').innerHTML = active.length ? `
    <thead><tr><th>原料</th><th class="num">占比</th><th class="num">颜料 g</th><th class="num">${esc(state.binderName)} g</th></tr></thead>
    <tbody>
      ${plan.pigments.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${fmt(p.pct, 1)}%</td><td class="num">${fmt(p.grams)}</td><td class="num">${fmt(p.binderGrams)}</td></tr>`).join('')}
      ${plan.extras.map((x) => `<tr class="muted"><td>${esc(x.name)}</td><td></td><td class="num"></td><td class="num">${fmt(x.grams)}</td></tr>`).join('')}
    </tbody>
    <tfoot><tr><td>合计</td><td class="num">100%</td><td class="num">${fmt(total)}</td><td class="num">${fmt(plan.binderTotal)} + 辅料</td></tr></tfoot>` : '';
}

$('#editor').addEventListener('input', (e) => {
  const d = state.draft;
  const t = e.target;
  if (!d) return;
  if (t.dataset.parts !== undefined) d.items[Number(t.dataset.parts)].parts = t.value;
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

const recipeMatches = (r, q) => !q || [r.name, r.note, r.sourceLabel, ...r.items.map((it) => it.name)].some((s) => String(s || '').toLowerCase().includes(q));

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
        <div class="rec-meta">${new Date(r.createdAt).toLocaleString('zh-CN')} · 每批颜料 ${fmt(r.totalGrams, 1)}g${r.sourceLabel ? ` · 来源 ${esc(r.sourceLabel.slice(0, 40))}` : ''}</div>
        ${r.items.map((it) => `
          <div class="ing" style="grid-template-columns:14px 1fr 46px 56px">
            <span class="dot" style="background:${esc(it.hex)}"></span><span>${esc(it.name)}</span>
            <span class="num">${fmt(it.pct, 0)}%</span><span class="num muted">${fmt((r.totalGrams * it.pct) / 100)}g</span>
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
  const rows = [['名称', '日期', '目标色', '预测色', '实际成品色', '每批颜料g', '原料(占比%)', '原料克数', '备注', '来源']];
  for (const r of state.recipes) {
    rows.push([
      r.name, r.createdAt.slice(0, 10), r.targetHex, r.predictedHex, r.actualHex, r.totalGrams,
      r.items.map((it) => `${it.name} ${fmt(it.pct, 1)}%`).join(' + '),
      r.items.map((it) => `${it.name} ${fmt((r.totalGrams * it.pct) / 100)}g`).join(' + '),
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

function renderLibrary() {
  $('#pigmentRows').innerHTML = state.pigments.map((p, i) => `
    <tr data-i="${i}">
      <td><input type="checkbox" data-f="owned" ${p.owned ? 'checked' : ''} aria-label="已有"></td>
      <td><span class="c-hex"><input type="color" data-f="hexPick" value="${esc(p.hex.toLowerCase())}"><input type="text" data-f="hex" maxlength="7" value="${esc(p.hex)}"></span></td>
      <td><input type="text" data-f="name" value="${esc(p.name)}"></td>
      <td><input class="w-code" type="text" data-f="code" value="${esc(p.code || '')}"></td>
      <td><input class="w-num" type="number" data-f="strength" min="0.1" step="0.1" value="${esc(p.strength)}"></td>
      <td><input class="w-num" type="number" data-f="opacity" min="0.05" max="1" step="0.05" value="${esc(p.opacity)}"></td>
      <td><input class="w-num" type="number" data-f="binder" min="0" step="0.1" value="${esc(p.binder)}"></td>
      <td><button class="btn small" data-act="calib" title="用当前目标色作为这种颜料的色值">取当前目标色</button>
          <button class="btn small danger" data-act="del">删除</button></td>
    </tr>`).join('');
  $('#binderName').value = state.binderName;
  $('#additiveRows').innerHTML = state.additives.map((a, i) => `
    <div class="additive" data-i="${i}">
      <input type="text" data-a="name" value="${esc(a.name)}" aria-label="辅料名称">
      <span class="row"><input type="number" data-a="ratio" min="0" step="0.5" value="${esc(a.ratio)}" aria-label="占颜料质量百分比"> %</span>
      <button class="x" data-a-del="${i}" title="移除">×</button>
    </div>`).join('') || '<div class="hint">没有辅料。</div>';
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
  if (f === 'owned') p.owned = e.target.checked;
  else if (f === 'hexPick') {
    p.hex = e.target.value.toUpperCase();
    $('[data-f=hex]', tr).value = p.hex;
  } else if (f === 'hex') {
    const v = e.target.value.trim();
    if (HEX_RE.test(v)) { p.hex = v.toUpperCase(); $('[data-f=hexPick]', tr).value = v.toLowerCase(); }
  } else if (['strength', 'opacity', 'binder'].includes(f)) {
    const n = Number(e.target.value);
    if (Number.isFinite(n) && n >= 0) p[f] = n;
  } else p[f] = e.target.value;
  persistLibrary();
});

$('#pigmentRows').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  const tr = e.target.closest('tr');
  if (!btn || !tr) return;
  const i = Number(tr.dataset.i);
  if (btn.dataset.act === 'calib') {
    state.pigments[i].hex = state.targetHex;
    toast(`已将「${state.pigments[i].name}」色值设为 ${state.targetHex}`);
  } else if (confirm(`删除颜料「${state.pigments[i].name}」？已保存的配方不受影响。`)) {
    state.pigments.splice(i, 1);
  } else return;
  persistLibrary();
  renderLibrary();
});

$('#addPigment').addEventListener('click', () => {
  state.pigments.push({ id: `custom-${uid()}`, name: '新颜料', code: '', hex: state.targetHex, strength: 1, opacity: 0.4, binder: 1, owned: true });
  persistLibrary();
  renderLibrary();
});

$('#resetPigments').addEventListener('click', () => {
  if (!confirm('将颜料库恢复为默认列表？你添加或修改的颜料会丢失（已保存的配方不受影响）。')) return;
  state.pigments = clone(DEFAULT_PIGMENTS);
  persistLibrary();
  renderLibrary();
});

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
renderLibrary();
renderRecords();
renderEditor();
