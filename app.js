'use strict';
/*
 * Probe Tracker — offline PWA for AFM probes.
 * All data lives in IndexedDB on this device only (nothing is uploaded anywhere).
 */
const APP_VERSION = '1.0.0';

/* =========================================================
 * Definitions — edit here to change probe types or fields
 * ========================================================= */
const STATUS = ['new', 'great', 'good', 'bad', 'dead'];
const STATUS_LABEL = { new: 'New', great: 'Great', good: 'Good', bad: 'Bad', dead: 'Dead' };
const RANK = { dead: 0, bad: 1, good: 2, great: 3, new: 4 }; // used for the "worst of" box summary

// Type-specific parameters. `col` is the spreadsheet column header.
const FIELDS = {
  length:   { label: 'Length',       unit: 'µm',    num: true,  col: 'Length (µm)' },
  f0:       { label: 'f₀',           unit: 'kHz',   num: true,  col: 'f0 (kHz)' },
  q:        { label: 'Q factor',     unit: '',      num: true,  col: 'Q' },
  k:        { label: 'Stiffness k',  unit: 'N/m',   num: true,  col: 'k (N/m)' },
  sens:     { label: 'Sensitivity',  unit: 'mV/nm', num: true,  col: 'Sensitivity (mV/nm)' },
  tipMat:   { label: 'Tip material', unit: '',      num: false, col: 'Tip material', list: ['Pt', 'PtIr', 'W', 'Au', 'Diamond', 'Si'] },
  leakR:    { label: 'Leakage R',    unit: 'Ω',     num: true,  col: 'Leakage R (Ohm)' },
  contactR: { label: 'Contact R',    unit: 'Ω',     num: true,  col: 'Contact R (Ohm)' },
  variant:  { label: 'Variant',      unit: '',      num: false, col: 'Variant', list: [
    'PRS-L70-F900-Si-PCB', 'PRSA-L100-F500-Si-PCB', 'PRSA-L300-F50-Si-PCB', 'PRSA-L300-F80-Si-PCB',
    'PRSA-L400-F30-Si-PCB', 'PRS-L100-F500-SCD-PCB', 'PRSA-L300-F50-SCD-PCB', 'PRSA-L400-F30-SCD-PCB', 'PRS/A-NenoCarrier'] },
  prep:     { label: 'Preparation',  unit: '',      num: false, col: 'Preparation', list: ['etched', 'cut', 'commercial'] },
};

// elec: true → two statuses (mechanical + electrical)
const TYPES = {
  'NPC':           { elec: true,  fields: ['length', 'f0', 'q', 'k', 'sens', 'contactR'] },
  '3LP':           { elec: true,  fields: ['length', 'tipMat', 'f0', 'q', 'k', 'leakR', 'contactR'] },
  'ADAMA-cdt-fmr': { elec: true,  fields: ['f0', 'k', 'contactR'] },
  'ADAMA-cone':    { elec: true,  fields: ['f0', 'k', 'contactR'] },
  'STM':           { elec: true,  fields: ['tipMat', 'prep'] },
  'Akiyama':       { elec: false, fields: ['f0', 'q', 'k'] },
  'PRSA':          { elec: false, fields: ['variant', 'f0', 'q'] },
};
const TYPE_ALIASES = {
  npc: 'NPC', '3lp': '3LP', trilayer: '3LP',
  adamacdtfmr: 'ADAMA-cdt-fmr', cdtfmr: 'ADAMA-cdt-fmr', adamacdt: 'ADAMA-cdt-fmr',
  adamacone: 'ADAMA-cone', cone: 'ADAMA-cone',
  akiyama: 'Akiyama', akyiama: 'Akiyama', prsa: 'PRSA', prs: 'PRSA', stm: 'STM',
};
const typeDef = (t) => TYPES[t] || { elec: true, fields: Object.keys(FIELDS), unknown: true };

/* =========================================================
 * Small helpers
 * ========================================================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => new Date().toISOString();
const pad = (n) => String(n).padStart(2, '0');
const day = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const cmp = (a, b) => coll.compare(a ?? '', b ?? '');
const norm = (s) => String(s ?? '').toLowerCase().replace(/₀/g, '0').replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');
const normFull = (s) => String(s ?? '').toLowerCase().replace(/₀/g, '0').replace(/[^a-z0-9]/g, '');
const str = (v) => (v == null ? '' : String(v).replace(/[\u200b\u00a0]/g, ' ').trim());

function fmtNum(v, unit) {
  if (v == null || v === '') return '';
  if (unit === 'Ω') {
    for (const [m, p] of [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k']]) if (Math.abs(v) >= m) return `${+(v / m).toPrecision(3)} ${p}Ω`;
    return `${+v.toPrecision(3)} Ω`;
  }
  const a = Math.abs(v);
  const s = a !== 0 && (a >= 1e6 || a < 1e-3) ? v.toExponential(2) : String(+v.toPrecision(6));
  return unit ? `${s} ${unit}` : s;
}

function parseNum(v, si = false) {
  if (v == null) return { v: null };
  if (typeof v === 'number') return Number.isFinite(v) ? { v } : { v: null, bad: true };
  let s = String(v).replace(/[\s\u00a0\u200b]/g, '');
  if (s === '' || /^[-–_?]+$/.test(s) || /^(n\/?a|none)$/i.test(s)) return { v: null };
  let mult = 1;
  if (si) { // resistances: accept 2G, 1.07M, 500k, optional Ω / Ohm
    s = s.replace(/(Ω|ohms?)$/i, '');
    const m = s.match(/^(.*?)([kMGT])$/);
    if (m) { mult = { k: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2]]; s = m[1]; }
  }
  if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, ''); else s = s.replace(',', '.');
  const n = Number(s) * mult;
  return s !== '' && Number.isFinite(n) ? { v: +n.toPrecision(12) } : { v: null, bad: true };
}

const STATUS_SYN = { new: 'new', great: 'great', excellent: 'great', 'very good': 'great', good: 'good', ok: 'good', bad: 'bad', weak: 'bad', blunt: 'bad', dead: 'dead', broken: 'dead', none: 'dead' };
function normStatus(v) {
  const s = str(v).toLowerCase();
  if (!s || ['unknown', '?', '-', '–'].includes(s)) return { v: null };
  return s in STATUS_SYN ? { v: STATUS_SYN[s] } : { v: null, bad: true };
}

function resolveType(s) {
  const t = str(s);
  if (!t) return '';
  return TYPE_ALIASES[norm(t)] || TYPES[t] && t || t;
}

// worst of mech/ele (only set values count)
function overall(p) {
  const vals = [p.status];
  if (typeDef(p.type).elec) vals.push(p.ele);
  const set = vals.filter(Boolean);
  if (!set.length) return null;
  return set.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
}

function incLabel(s) {
  const m = String(s).match(/^(.*?)(\d+)(\D*)$/);
  if (!m) return s ? s + '-2' : '';
  const n = String(Number(m[2]) + 1).padStart(m[2].length, '0');
  return m[1] + n + m[3];
}

let toastTimer;
function toast(msg, ms = 2600, action) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (action ? `<button type="button">${esc(action.label)}</button>` : '');
  if (action) t.querySelector('button').onclick = () => { t.classList.remove('show'); action.fn(); };
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

async function act(fn) {
  try { await fn(); } catch (e) {
    console.error(e);
    toast('Error: ' + (e && e.message || e), 6000);
    try { await loadAll(); render(); } catch { /* ignore */ } // keep screen in sync with what is really saved
  }
}

const ICON = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5-9 8"/></svg>',
};

/* =========================================================
 * Storage (IndexedDB)
 * ========================================================= */
let idb;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('probe-tracker', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('boxes')) d.createObjectStore('boxes', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('probes')) d.createObjectStore('probes', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos'); // key = probe id, value = Blob
    };
    r.onsuccess = () => { idb = r.result; res(); };
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('Storage is blocked by another open tab of this app'));
  });
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const getAll = (store) => reqP(idb.transaction(store).objectStore(store).getAll());
const getPhoto = (id) => reqP(idb.transaction('photos').objectStore('photos').get(id));

// ops: [{store, op:'put'|'delete'|'clear', value, key}] — all in ONE transaction (all-or-nothing)
function write(ops) {
  return new Promise((res, rej) => {
    const t = idb.transaction([...new Set(ops.map((o) => o.store))], 'readwrite');
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Save aborted'));
    for (const o of ops) {
      const s = t.objectStore(o.store);
      if (o.op === 'put') (o.key !== undefined ? s.put(o.value, o.key) : s.put(o.value));
      else if (o.op === 'delete') s.delete(o.key);
      else if (o.op === 'clear') s.clear();
    }
  });
}

const S = { boxes: new Map(), probes: new Map(), search: '' };
async function loadAll() {
  S.boxes = new Map((await getAll('boxes')).map((b) => [b.id, b]));
  S.probes = new Map((await getAll('probes')).map((p) => [p.id, p]));
}
const probesIn = (boxId) => [...S.probes.values()].filter((p) => p.boxId === boxId);
const byPos = (a, b) => (a.position ? 0 : 1) - (b.position ? 0 : 1) || cmp(a.position, b.position) || cmp(a.label, b.label);
const boxByName = (name) => [...S.boxes.values()].find((b) => b.name.trim().toLowerCase() === name.trim().toLowerCase());

async function saveBox(b) { b.updated = now(); await write([{ store: 'boxes', op: 'put', value: b }]); S.boxes.set(b.id, b); }
async function saveProbe(p, extraOps = []) { p.updated = now(); await write([{ store: 'probes', op: 'put', value: p }, ...extraOps]); S.probes.set(p.id, p); }
function addLog(p, msg) { (p.log ||= []).push({ t: now(), msg }); }

const photoURLs = new Map();
function dropPhotoURL(id) { const u = photoURLs.get(id); if (u) URL.revokeObjectURL(u); photoURLs.delete(id); }
async function photoURL(id) {
  if (photoURLs.has(id)) return photoURLs.get(id);
  const blob = await getPhoto(id);
  if (!blob) return null;
  const u = URL.createObjectURL(blob);
  photoURLs.set(id, u);
  return u;
}

/* =========================================================
 * Modal dialogs
 * ========================================================= */
function modal({ title, html = '', actions, sheet = false, onOpen }) {
  return new Promise((resolve) => {
    const dlg = $('#modal');
    dlg.className = '';
    dlg.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${html ? `<div class="m-body">${html}</div>` : ''}
      <div class="m-actions ${sheet ? 'sheet' : ''}">${actions.map((a, i) =>
        `<button value="${i}" class="btn ${a.kind || ''}" ${a.primary ? '' : 'formnovalidate'}>${esc(a.label)}</button>`).join('')}</div></form>`;
    const form = dlg.querySelector('form');
    dlg.returnValue = '';
    dlg.addEventListener('close', () => {
      const a = actions[Number(dlg.returnValue)];
      const data = Object.fromEntries(new FormData(form));
      resolve(dlg.returnValue !== '' && a ? { value: a.value, data } : { value: null, data });
    }, { once: true });
    dlg.showModal();
    if (onOpen) onOpen(dlg);
  });
}
async function promptText(title, value = '', placeholder = '', multiline = false) {
  const input = multiline
    ? `<textarea name="v" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
    : `<input name="v" value="${esc(value)}" placeholder="${esc(placeholder)}" required autocomplete="off">`;
  const r = await modal({
    title, html: input,
    actions: [{ label: 'OK', value: 'ok', kind: 'primary', primary: true }, { label: 'Cancel', value: null }],
    onOpen: (d) => { const i = d.querySelector('[name=v]'); i.focus(); if (i.select) i.select(); },
  });
  return r.value === 'ok' ? str(r.data.v) : null;
}
async function confirmBox(title, text, okLabel = 'Delete', kind = 'danger') {
  const r = await modal({ title, html: `<p>${text}</p>`, actions: [{ label: okLabel, value: true, kind }, { label: 'Cancel', value: false }] });
  return r.value === true;
}
async function message(title, html) { await modal({ title, html, actions: [{ label: 'OK', value: true, kind: 'primary' }] }); }

/* =========================================================
 * Navigation (hash router; Android back button works)
 * ========================================================= */
const app = $('#app');
const navStack = [];
let lastView = '';
function onHash() {
  const h = location.hash || '#/';
  if (navStack.length > 1 && navStack[navStack.length - 2] === h) navStack.pop();
  else if (navStack[navStack.length - 1] !== h) navStack.push(h);
  render();
}
const go = (h) => { location.hash = h; };
function replace(h) { navStack.pop(); location.replace(h); }
function back(fallback) { if (navStack.length > 1) history.back(); else replace(fallback); }

function render() {
  const h = (location.hash || '#/').slice(1);
  const [path, query = ''] = h.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query);
  if (h !== lastView) window.scrollTo(0, 0);
  lastView = h;
  if ($('#modal').open) $('#modal').close();
  const [v, id] = parts;
  if (!v) return viewHome();
  if (v === 'box') return viewBox(id);
  if (v === 'probe') return viewProbe(id);
  if (v === 'new') return viewForm(null, id, params.get('copy'));
  if (v === 'edit') return viewForm(id);
  if (v === 'settings') return viewSettings();
  return viewHome();
}

function header({ title, back: fb, right = '' }) {
  return `<header class="top">${fb ? `<button class="icon-btn" id="hBack" data-fb="${esc(fb)}" aria-label="Back">${ICON.back}</button>` : ''}
    <h1>${esc(title)}</h1>${right}</header>`;
}
function bindHeader() { const b = $('#hBack'); if (b) b.onclick = () => back(b.dataset.fb); }
function notFound() {
  app.innerHTML = header({ title: 'Not found', back: '#/' }) + '<main><div class="empty"><p>This item no longer exists.</p></div></main>';
  bindHeader();
}

/* =========================================================
 * UI pieces
 * ========================================================= */
const chip = (st, prefix) => `<span class="chip s-${st || 'none'}">${prefix ? `<i>${prefix}</i>` : ''}${st ? STATUS_LABEL[st] : '–'}</span>`;

function probeChips(p) {
  return typeDef(p.type).elec ? chip(p.status, 'M') + chip(p.ele, 'E') : chip(p.status);
}

function summary(probes) {
  const c = { new: 0, great: 0, good: 0, bad: 0, dead: 0, none: 0 };
  for (const p of probes) c[overall(p) || 'none']++;
  const n = probes.length;
  if (!n) return '';
  const keys = [...STATUS, 'none'].filter((k) => c[k]);
  return `<div class="bar">${keys.map((k) => `<span class="s-${k}" style="width:${(100 * c[k]) / n}%"></span>`).join('')}</div>
    <div class="counts">${keys.map((k) => `<span class="chip s-${k}">${c[k]} ${k === 'none' ? 'unset' : STATUS_LABEL[k].toLowerCase()}</span>`).join('')}</div>`;
}

function probeRow(p, showBox) {
  const f0 = p.data && p.data.f0 != null ? ` · ${fmtNum(p.data.f0, 'kHz')}` : '';
  const box = showBox ? ` · ${esc(S.boxes.get(p.boxId)?.name || '?')}` : '';
  return `<a class="row" href="#/probe/${encodeURIComponent(p.id)}">
    <span class="slot">${esc(p.position || '·')}</span>
    <span class="row-main"><b>${esc(p.label)}</b><small>${esc(p.type || 'Other')}${f0}${box}</small></span>
    <span class="chips">${probeChips(p)}</span></a>`;
}

function backupBanner() {
  if (!S.probes.size) return '';
  const last = localStorage.getItem('pt.lastBackup');
  if (last && Date.now() - Date.parse(last) < 30 * 864e5) return '';
  return `<div class="banner"><span>${last ? 'Last backup over 30 days ago.' : 'No backup yet.'} Data lives only on this device.</span><a href="#/settings">Back up</a></div>`;
}

/* =========================================================
 * View: home (box list + search)
 * ========================================================= */
function viewHome() {
  app.innerHTML = header({ title: 'Probe boxes', right: `<a class="icon-btn" href="#/settings" aria-label="Settings">${ICON.gear}</a>` }) + `
    <main>${backupBanner()}
      <input id="search" class="search" type="search" placeholder="Search all probes (ID, batch, note…)" value="${esc(S.search)}" autocomplete="off">
      <div id="results"></div>
    </main>
    <button class="fab" id="addBox">${ICON.plus}<span>Box</span></button>`;
  const res = $('#results');
  const draw = () => {
    const q = S.search.trim().toLowerCase();
    if (q) {
      const hits = [...S.probes.values()]
        .filter((p) => [p.label, p.batch, p.note, p.type, p.position].some((x) => String(x || '').toLowerCase().includes(q)))
        .sort((a, b) => cmp(a.label, b.label));
      res.innerHTML = hits.length
        ? `<div class="list">${hits.slice(0, 200).map((p) => probeRow(p, true)).join('')}</div>`
        : '<div class="empty"><p class="muted">No probe matches.</p></div>';
      return;
    }
    const boxes = [...S.boxes.values()].sort((a, b) => cmp(a.name, b.name));
    if (!boxes.length) {
      res.innerHTML = '<div class="empty"><p><b>No boxes yet.</b></p><p class="muted">Add a box with the button below, or import a spreadsheet in Settings.</p></div>';
      return;
    }
    res.innerHTML = boxes.map((b) => {
      const ps = probesIn(b.id);
      const types = [...new Set(ps.map((p) => p.type || 'Other'))].sort(cmp).join(', ');
      return `<a class="card box-card" href="#/box/${encodeURIComponent(b.id)}">
        <div class="box-top"><span class="box-name">${esc(b.name)}</span><span class="muted">${ps.length} probe${ps.length === 1 ? '' : 's'}</span></div>
        ${types ? `<div class="box-sub">${esc(types)}</div>` : ''}
        ${summary(ps)}</a>`;
    }).join('');
  };
  draw();
  $('#search').addEventListener('input', (e) => { S.search = e.target.value; draw(); });
  $('#addBox').onclick = () => act(addBox);
}

async function addBox() {
  const name = await promptText('New box', '', 'e.g. NPC box 1');
  if (!name) return;
  if (boxByName(name)) return toast('A box with this name already exists');
  const b = { id: uid(), name, note: '', created: now(), updated: now() };
  await saveBox(b);
  go('#/box/' + encodeURIComponent(b.id));
}

/* =========================================================
 * View: box
 * ========================================================= */
function viewBox(id) {
  const b = S.boxes.get(id);
  if (!b) return notFound();
  const ps = probesIn(id).sort(byPos);
  app.innerHTML = header({ title: b.name, back: '#/', right: `<button class="icon-btn" id="more" aria-label="Box options">${ICON.more}</button>` }) + `
    <main>
      ${b.note ? `<p class="muted" style="white-space:pre-wrap;margin-top:0">${esc(b.note)}</p>` : ''}
      ${ps.length ? `<div class="card">${summary(ps)}</div>` : ''}
      ${ps.length ? `<div class="list">${ps.map((p) => probeRow(p, false)).join('')}</div>`
        : '<div class="empty"><p><b>Empty box.</b></p><p class="muted">Add a probe with the button below.</p></div>'}
    </main>
    <button class="fab" id="addProbe">${ICON.plus}<span>Probe</span></button>`;
  bindHeader();
  $('#addProbe').onclick = () => go('#/new/' + encodeURIComponent(id));
  $('#more').onclick = () => act(() => boxMenu(b));
}

async function boxMenu(b) {
  const r = await modal({
    title: b.name, sheet: true,
    actions: [
      { label: 'Rename', value: 'rename' },
      { label: b.note ? 'Edit note' : 'Add note', value: 'note' },
      { label: 'Delete box', value: 'delete', kind: 'danger-text' },
      { label: 'Cancel', value: null },
    ],
  });
  if (r.value === 'rename') {
    const name = await promptText('Rename box', b.name);
    if (!name || name === b.name) return;
    const other = boxByName(name);
    if (other && other.id !== b.id) return toast('A box with this name already exists');
    b.name = name; await saveBox(b); render();
  } else if (r.value === 'note') {
    const note = await promptText('Box note', b.note || '', 'Location, purpose…', true);
    if (note === null) return;
    b.note = note; await saveBox(b); render();
  } else if (r.value === 'delete') {
    const ps = probesIn(b.id);
    const ok = await confirmBox('Delete box?', ps.length
      ? `Box <b>${esc(b.name)}</b> and its <b>${ps.length} probe${ps.length === 1 ? '' : 's'}</b> (incl. photos) will be deleted. This cannot be undone.`
      : `Delete empty box <b>${esc(b.name)}</b>?`);
    if (!ok) return;
    await write([{ store: 'boxes', op: 'delete', key: b.id },
      ...ps.flatMap((p) => [{ store: 'probes', op: 'delete', key: p.id }, { store: 'photos', op: 'delete', key: p.id }])]);
    S.boxes.delete(b.id);
    ps.forEach((p) => { S.probes.delete(p.id); dropPhotoURL(p.id); });
    toast('Box deleted');
    back('#/');
  }
}

/* =========================================================
 * View: probe detail
 * ========================================================= */
function statusLine(key, label, cur) {
  return `<div class="stat-line"><div class="stat-lbl">${label}</div>
    <div class="seg" data-k="${key}">${STATUS.map((s) => `<button type="button" class="segb s-${s} ${cur === s ? 'on' : ''}" data-s="${s}">${STATUS_LABEL[s]}</button>`).join('')}</div></div>`;
}
function fieldValue(p, k) {
  const f = FIELDS[k]; const v = p.data?.[k];
  if (v == null || v === '') return '';
  return f.num ? fmtNum(v, f.unit) : esc(v);
}

function viewProbe(id) {
  const p = S.probes.get(id);
  if (!p) return notFound();
  const b = S.boxes.get(p.boxId);
  const td = typeDef(p.type);
  const shown = td.fields.filter((k) => !td.unknown || fieldValue(p, k));
  const kv = [
    ...shown.map((k) => [FIELDS[k].label, fieldValue(p, k)]),
    ['Batch / origin', esc(p.batch || '')],
    ['Last change', day(p.updated)],
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v || '<span class="muted">—</span>'}</dd>`).join('');

  app.innerHTML = header({ title: p.label, back: '#/box/' + encodeURIComponent(p.boxId), right: `<button class="icon-btn" id="more" aria-label="Probe options">${ICON.more}</button>` }) + `
    <main>
      <div class="sub">${esc(p.type || 'Other')} · ${esc(b?.name || '?')}${p.position ? ` · slot ${esc(p.position)}` : ''}</div>
      <section class="card">
        ${statusLine('status', td.elec ? 'Mechanical' : 'Status', p.status)}
        ${td.elec ? statusLine('ele', 'Electrical', p.ele) : ''}
      </section>
      <section class="card"><dl class="kv">${kv}</dl></section>
      ${p.note ? `<section class="card"><h3>Note</h3><p class="note">${esc(p.note)}</p></section>` : ''}
      <section class="card">
        <div class="photo" id="photo">${p.hasPhoto ? '<div class="ph-empty">Loading photo…</div>' : '<div class="ph-empty">No photo</div>'}</div>
        <div class="btn-row">
          <button class="btn" id="cam">${ICON.camera}Camera</button>
          <button class="btn" id="gal">${ICON.image}Gallery</button>
          ${p.hasPhoto ? '<button class="btn danger-text" id="delPh">Remove</button>' : ''}
        </div>
        <input type="file" id="camIn" accept="image/*" capture="environment" hidden>
        <input type="file" id="galIn" accept="image/*" hidden>
      </section>
      <button class="btn primary wide" id="edit">Edit details</button>
      <details class="card log"><summary>History (${(p.log || []).length})</summary>
        <ul>${(p.log || []).slice().reverse().map((e) => `<li><time>${day(e.t)}</time>${esc(e.msg)}</li>`).join('')}</ul></details>
    </main>`;
  bindHeader();

  $$('.seg').forEach((seg) => seg.addEventListener('click', (e) => {
    const btn = e.target.closest('.segb'); if (!btn) return;
    act(async () => {
      const key = seg.dataset.k; const old = p[key] || null;
      const val = old === btn.dataset.s ? null : btn.dataset.s; // tapping the active one clears it
      p[key] = val;
      addLog(p, `${key === 'ele' ? 'Electrical' : td.elec ? 'Mechanical' : 'Status'}: ${old || '–'} → ${val || '–'}`);
      await saveProbe(p);
      render();
    });
  }));

  if (p.hasPhoto) {
    photoURL(p.id).then((u) => {
      const el = $('#photo'); if (!el) return;
      if (!u) { el.innerHTML = '<div class="ph-empty">Photo missing</div>'; return; }
      el.innerHTML = `<img src="${u}" alt="Photo of ${esc(p.label)}">`;
      el.querySelector('img').onclick = () => viewImage(u);
    }).catch((e) => toast('Photo error: ' + e.message));
  }
  $('#cam').onclick = () => $('#camIn').click();
  $('#gal').onclick = () => $('#galIn').click();
  const onFile = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) act(() => setPhoto(p, f)); };
  $('#camIn').onchange = onFile;
  $('#galIn').onchange = onFile;
  if ($('#delPh')) $('#delPh').onclick = () => act(async () => {
    if (!(await confirmBox('Remove photo?', 'The photo of this probe will be deleted.', 'Remove'))) return;
    p.hasPhoto = false; addLog(p, 'Photo removed');
    await saveProbe(p, [{ store: 'photos', op: 'delete', key: p.id }]);
    dropPhotoURL(p.id); render();
  });
  $('#edit').onclick = () => go('#/edit/' + encodeURIComponent(p.id));
  $('#more').onclick = () => act(() => probeMenu(p));
}

function viewImage(url) {
  const dlg = $('#modal');
  dlg.className = 'imgview';
  dlg.innerHTML = `<form method="dialog"><img src="${url}" alt=""><div class="m-actions" style="margin-top:10px"><button class="btn" value="x">Close</button></div></form>`;
  dlg.showModal();
}

async function resizeImage(file, max = 1600) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { bmp = await createImageBitmap(file); }
  const sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * sc), h = Math.round(bmp.height * sc);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Image encoding failed'))), 'image/jpeg', 0.85));
}

async function setPhoto(p, file) {
  toast('Saving photo…');
  const blob = await resizeImage(file);
  const had = p.hasPhoto;
  p.hasPhoto = true;
  addLog(p, had ? 'Photo replaced' : 'Photo added');
  await saveProbe(p, [{ store: 'photos', op: 'put', value: blob, key: p.id }]);
  dropPhotoURL(p.id);
  toast('Photo saved');
  render();
}

async function probeMenu(p) {
  const others = [...S.boxes.values()].filter((b) => b.id !== p.boxId).sort((a, b) => cmp(a.name, b.name));
  const r = await modal({
    title: p.label, sheet: true,
    actions: [
      { label: 'Edit details', value: 'edit' },
      { label: 'Add similar probe (copy)', value: 'copy' },
      ...(others.length ? [{ label: 'Move to another box', value: 'move' }] : []),
      { label: 'Delete probe', value: 'delete', kind: 'danger-text' },
      { label: 'Cancel', value: null },
    ],
  });
  if (r.value === 'edit') go('#/edit/' + encodeURIComponent(p.id));
  else if (r.value === 'copy') go(`#/new/${encodeURIComponent(p.boxId)}?copy=${encodeURIComponent(p.id)}`);
  else if (r.value === 'move') {
    const m = await modal({
      title: 'Move to box',
      html: `<select name="box">${others.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select>`,
      actions: [{ label: 'Move', value: 'ok', kind: 'primary', primary: true }, { label: 'Cancel', value: null }],
    });
    if (m.value !== 'ok') return;
    const from = S.boxes.get(p.boxId)?.name || '?'; const to = S.boxes.get(m.data.box);
    if (!to) return;
    p.boxId = to.id; addLog(p, `Moved: ${from} → ${to.name}`);
    await saveProbe(p);
    toast(`Moved to ${to.name}`);
    render();
  } else if (r.value === 'delete') {
    if (!(await confirmBox('Delete probe?', `Probe <b>${esc(p.label)}</b> (incl. photo and history) will be deleted. This cannot be undone.`))) return;
    await write([{ store: 'probes', op: 'delete', key: p.id }, { store: 'photos', op: 'delete', key: p.id }]);
    S.probes.delete(p.id); dropPhotoURL(p.id);
    toast('Probe deleted');
    back('#/box/' + encodeURIComponent(p.boxId));
  }
}

/* =========================================================
 * View: add / edit probe form
 * ========================================================= */
function draftFor(boxId, copyId) {
  const src = copyId && S.probes.get(copyId);
  if (src) {
    return {
      id: null, boxId, label: incLabel(src.label), type: src.type,
      position: /^\d+$/.test(src.position || '') ? String(Number(src.position) + 1) : '',
      status: 'new', ele: typeDef(src.type).elec ? 'new' : null,
      batch: src.batch || '', note: '', data: { ...(src.data || {}) }, copyOf: src.label,
    };
  }
  const inBox = probesIn(boxId);
  const counts = {};
  inBox.forEach((p) => { counts[p.type] = (counts[p.type] || 0) + 1; });
  const common = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const type = common || localStorage.getItem('pt.lastType') || 'NPC';
  return { id: null, boxId, label: '', type, position: '', status: 'new', ele: typeDef(type).elec ? 'new' : null, batch: '', note: '', data: {} };
}

function viewForm(editId, boxId, copyId) {
  const orig = editId ? S.probes.get(editId) : null;
  if (editId && !orig) return notFound();
  if (!editId && !S.boxes.get(boxId)) return notFound();
  const d = orig ? structuredClone(orig) : draftFor(boxId, copyId);
  const raw = {}; // field inputs as typed strings, kept across type switches
  for (const [k, v] of Object.entries(d.data || {})) raw[k] = v == null ? '' : String(v);

  const typeOpts = [...Object.keys(TYPES), ...(d.type && !TYPES[d.type] ? [d.type] : [])];
  const statusOpts = (cur) => ['', ...STATUS].map((s) => `<option value="${s}" ${(cur || '') === s ? 'selected' : ''}>${s ? STATUS_LABEL[s] : '– not set –'}</option>`).join('');
  const boxes = [...S.boxes.values()].sort((a, b) => cmp(a.name, b.name));
  const title = orig ? 'Edit ' + orig.label : d.copyOf ? 'New probe (copy)' : 'New probe';
  const fb = orig ? '#/probe/' + encodeURIComponent(orig.id) : '#/box/' + encodeURIComponent(boxId);

  app.innerHTML = header({ title, back: fb }) + `
    <main><form id="pf" class="card form" novalidate autocomplete="off">
      <label>Probe ID <input name="label" value="${esc(d.label)}" placeholder="e.g. X451" required></label>
      <div class="grid2">
        <label>Type <select name="type">${typeOpts.map((t) => `<option ${t === d.type ? 'selected' : ''}>${esc(t)}</option>`).join('')}
          <option value="" ${!d.type ? 'selected' : ''}>Other</option></select></label>
        <label>Slot in box <input name="position" value="${esc(d.position || '')}" placeholder="e.g. 3"></label>
      </div>
      <label>Box <select name="boxId">${boxes.map((b) => `<option value="${esc(b.id)}" ${b.id === d.boxId ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
      <div class="grid2">
        <label><span id="stLbl">Status</span><select name="status">${statusOpts(d.status)}</select></label>
        <label id="eleWrap">Electrical<select name="ele">${statusOpts(d.ele)}</select></label>
      </div>
      <div id="typed" class="grid2"></div>
      <label>Batch / origin <input name="batch" value="${esc(d.batch || '')}" placeholder="wafer, original box, order…"></label>
      <label>Note <textarea name="note" rows="3">${esc(d.note || '')}</textarea></label>
      <p class="err" id="err"></p>
      <div class="btn-row"><button type="button" class="btn" id="cancel">Cancel</button><button class="btn primary" type="submit">Save</button></div>
    </form></main>`;
  bindHeader();
  const form = $('#pf');
  const F = form.elements;

  const drawTyped = () => {
    const td = typeDef(F.type.value);
    $('#stLbl').textContent = td.elec ? 'Mechanical' : 'Status';
    $('#eleWrap').style.display = td.elec ? '' : 'none';
    $('#typed').innerHTML = td.fields.map((k) => {
      const f = FIELDS[k];
      return `<label>${esc(f.label)}${f.unit ? ` <small>(${esc(f.unit)})</small>` : ''}
        <input name="f_${k}" value="${esc(raw[k] ?? '')}" ${f.unit === 'Ω' ? 'placeholder="e.g. 2G, 1.07M"' : f.num ? 'inputmode="decimal"' : ''} ${f.list ? `list="dl_${k}"` : ''}>
        ${f.list ? `<datalist id="dl_${k}">${f.list.map((o) => `<option value="${esc(o)}">`).join('')}</datalist>` : ''}</label>`;
    }).join('');
  };
  drawTyped();
  F.type.onchange = () => {
    $$('#typed input').forEach((i) => { raw[i.name.slice(2)] = i.value; });
    drawTyped();
    if (typeDef(F.type.value).elec && !F.ele.value && !orig) F.ele.value = 'new';
  };
  $('#cancel').onclick = () => back(fb);

  form.onsubmit = (e) => {
    e.preventDefault();
    act(async () => {
      const err = $('#err'); err.textContent = '';
      const label = str(F.label.value);
      if (!label) { err.textContent = 'Probe ID is required.'; F.label.focus(); return; }
      const type = F.type.value;
      const td = typeDef(type);
      const data = {};
      for (const k of td.fields) {
        const inp = F['f_' + k]; const v = inp.value;
        if (FIELDS[k].num) {
          const r = parseNum(v, FIELDS[k].unit === 'Ω');
          if (r.bad) { err.textContent = `${FIELDS[k].label}: "${v}" is not a number.`; inp.focus(); return; }
          if (r.v != null) data[k] = r.v;
        } else if (str(v)) data[k] = str(v);
      }
      const targetBox = F.boxId.value;
      const dup = probesIn(targetBox).find((p) => p.id !== d.id && p.label.toLowerCase() === label.toLowerCase());
      if (dup && !(await confirmBox('Duplicate ID', `Box already contains a probe <b>${esc(label)}</b>. Save anyway?`, 'Save anyway', 'primary'))) return;

      const p = orig ? structuredClone(S.probes.get(orig.id)) : { id: uid(), created: now(), log: [], hasPhoto: false };
      const before = orig ? structuredClone(orig) : null;
      Object.assign(p, {
        label, type, boxId: targetBox, position: str(F.position.value),
        status: F.status.value || null, ele: td.elec ? F.ele.value || null : null,
        batch: str(F.batch.value), note: F.note.value.trim(), data,
      });
      if (!before) addLog(p, d.copyOf ? `Created (copy of ${d.copyOf})` : 'Created');
      else {
        const sl = td.elec ? 'Mechanical' : 'Status';
        if (before.status !== p.status) addLog(p, `${sl}: ${before.status || '–'} → ${p.status || '–'}`);
        if ((before.ele || null) !== p.ele && td.elec) addLog(p, `Electrical: ${before.ele || '–'} → ${p.ele || '–'}`);
        if (before.boxId !== p.boxId) addLog(p, `Moved: ${S.boxes.get(before.boxId)?.name || '?'} → ${S.boxes.get(p.boxId)?.name || '?'}`);
        const changed = [];
        if (before.label !== p.label) changed.push('ID');
        if ((before.type || '') !== p.type) changed.push('type');
        if ((before.position || '') !== p.position) changed.push('slot');
        if ((before.batch || '') !== p.batch) changed.push('batch');
        if ((before.note || '') !== p.note) changed.push('note');
        const keys = new Set([...Object.keys(before.data || {}), ...Object.keys(data)]);
        for (const k of keys) if ((before.data || {})[k] !== data[k]) changed.push(FIELDS[k]?.label || k);
        if (changed.length) addLog(p, 'Edited: ' + changed.join(', '));
      }
      await saveProbe(p);
      if (type) localStorage.setItem('pt.lastType', type);
      toast('Saved');
      if (orig) back('#/probe/' + encodeURIComponent(p.id));
      else replace('#/probe/' + encodeURIComponent(p.id));
    });
  };
  if (!orig && !d.label) F.label.focus();
}

/* =========================================================
 * Spreadsheet import / export
 * ========================================================= */
let xlsxP;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return (xlsxP ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'vendor/xlsx.full.min.js';
    s.onload = () => res(window.XLSX);
    s.onerror = () => { xlsxP = null; rej(new Error('Could not load the spreadsheet library')); };
    document.head.appendChild(s);
  }));
}

const FIELD_KEYS = Object.keys(FIELDS);
const COLS = [
  { h: 'Box', get: (p) => S.boxes.get(p.boxId)?.name || '' },
  { h: 'ID', get: (p) => p.label },
  { h: 'Type', get: (p) => p.type || '' },
  { h: 'Slot', get: (p) => p.position || '' },
  { h: 'Status (mech.)', get: (p) => p.status || '' },
  { h: 'Status (ele.)', get: (p) => (typeDef(p.type).elec ? p.ele || '' : '') },
  ...FIELD_KEYS.map((k) => ({ h: FIELDS[k].col, num: FIELDS[k].num, get: (p) => p.data?.[k] ?? '' })),
  { h: 'Batch', get: (p) => p.batch || '' },
  { h: 'Note', get: (p) => p.note || '' },
  { h: 'Updated', get: (p) => day(p.updated) },
];
const HEADER_MAP = {
  box: ['box', 'boxname'],
  label: ['id', 'probeid', 'probe', 'label', 'name'],
  type: ['type', 'probetype'],
  position: ['slot', 'position', 'pos', 'number', 'no'],
  status: ['statusmech', 'status', 'mech', 'mechanical', 'mechstatus', 'mechanicalstatus', 'state', 'tipstate'],
  ele: ['statusele', 'ele', 'electrical', 'elestatus', 'electricalstatus', 'current'],
  length: ['length'], f0: ['f0', 'freso', 'fr', 'fres', 'resonance', 'frequency', 'resonancefrequency'],
  q: ['q', 'qfactor'], k: ['k', 'stiffness', 'springconstant'], sens: ['sensitivity', 'sens'],
  tipMat: ['tipmaterial', 'material'], leakR: ['leakager', 'leakageres', 'leakage', 'leakageresistance'],
  contactR: ['contactr', 'contactres', 'contact', 'contactresistance'], variant: ['variant'], prep: ['preparation', 'prep'],
  batch: ['batch', 'origin', 'batchorigin', 'originalbox', 'originalboxid', 'lot'],
  note: ['note', 'notes', 'history', 'comment', 'comments'],
};
const HEADER_LOOKUP = {};
for (const [key, names] of Object.entries(HEADER_MAP)) names.forEach((n) => { HEADER_LOOKUP[n] = key; });

function sortedProbes() {
  return [...S.probes.values()].sort((a, b) => cmp(S.boxes.get(a.boxId)?.name, S.boxes.get(b.boxId)?.name) || byPos(a, b));
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function shareOrDownload(blob, name, type) {
  const file = new File([blob], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  download(blob, name);
}

async function exportXLSX(template = false) {
  const XLSX = await loadXLSX();
  const rows = template ? [] : sortedProbes().map((p) => COLS.map((c) => { const v = c.get(p); return v === '' ? null : v; }));
  const ws = XLSX.utils.aoa_to_sheet([COLS.map((c) => c.h), ...rows]);
  ws['!cols'] = COLS.map((c) => ({ wch: Math.max(8, Math.min(40, c.h.length + 2)) }));
  if (ws['!ref']) ws['!autofilter'] = { ref: ws['!ref'] };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Probes');
  if (template) {
    const help = [
      ['Column', 'Allowed values / notes'],
      ['Box', 'Box name. Boxes are created automatically on import.'],
      ['ID', 'Probe ID (required). A row without ID is skipped.'],
      ['Type', Object.keys(TYPES).join(', ')],
      ['Slot', 'Position in the box (optional)'],
      ['Status (mech.)', STATUS.join(', ') + ' — for non-electrical types this is the only status'],
      ['Status (ele.)', STATUS.join(', ') + ' — only for ' + Object.keys(TYPES).filter((t) => TYPES[t].elec).join(', ')],
      ...Object.entries(TYPES).map(([t, d]) => [`Fields for ${t}`, d.fields.map((k) => FIELDS[k].col).join('; ')]),
      ['Numbers', 'Decimal point or comma both accepted. Resistances in Ohm (e.g. 2E9).'],
    ];
    const hs = XLSX.utils.aoa_to_sheet(help);
    hs['!cols'] = [{ wch: 22 }, { wch: 90 }];
    XLSX.utils.book_append_sheet(wb, hs, 'Help');
  }
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const name = template ? 'probes-template.xlsx' : `probes-${day(now())}.xlsx`;
  download(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name);
}

// CSV for Czech Excel: ";" separator, decimal comma, UTF-8 BOM
function exportCSV() {
  const q = (v) => { const s = String(v ?? ''); return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const cell = (c, v) => (c.num && typeof v === 'number' ? String(v).replace('.', ',') : v);
  const lines = [COLS.map((c) => q(c.h)).join(';'),
    ...sortedProbes().map((p) => COLS.map((c) => q(cell(c, c.get(p)))).join(';'))];
  download(new Blob(['\ufeff' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }), `probes-${day(now())}.csv`);
}

function parseCSV(text) {
  text = text.replace(/^\ufeff/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : (first.includes('\t') ? '\t' : ',');
  const rows = []; let row = []; let f = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else inQ = false; } else f += c;
    } else if (c === '"') inQ = true;
    else if (c === sep) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

async function readText(file) { // UTF-8, or windows-1250 from Czech Excel "CSV (oddělený středníkem)"
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1250').decode(buf); }
}
async function readRows(file) {
  if (/\.csv$|\.txt$/i.test(file.name) || file.type === 'text/csv') return parseCSV(await readText(file));
  const XLSX = await loadXLSX();
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const name = wb.SheetNames.find((n) => n.toLowerCase() === 'probes') || wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null, raw: true, blankrows: true });
}

async function importFile(file) {
  const rows = await readRows(file);
  // find header row within first 10 rows: needs an ID-like column
  let hi = -1, map = null;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const m = {};
    (rows[i] || []).forEach((h, ci) => { // exact name first ("Status (ele.)"), then without units ("f0 (kHz)" → f0)
      const key = HEADER_LOOKUP[normFull(h)] || HEADER_LOOKUP[norm(h)];
      if (key && !(key in m)) m[key] = ci;
    });
    if ('label' in m) { hi = i; map = m; break; }
  }
  if (!map) {
    return message('Import failed', '<p>No <b>ID</b> column found in the first 10 rows.</p><p class="muted">Tip: download the template in Settings to see the expected columns.</p>');
  }
  const ignored = (rows[hi] || []).filter((h, ci) => str(h) && !Object.values(map).includes(ci) && !/^updated$/i.test(norm(h)));
  const data = rows.slice(hi + 1).filter((r) => r && r.some((c) => str(c) !== ''));
  const ids = data.filter((r) => str(r[map.label]));
  const boxNames = new Set(ids.map((r) => str(r[map.box]) || 'Imported'));
  if (!ids.length) return message('Nothing to import', '<p>The file has a header row but no rows with a probe ID.</p>');

  const r = await modal({
    title: 'Import ' + file.name,
    html: `<p>Found <b>${ids.length}</b> probe${ids.length === 1 ? '' : 's'} in <b>${boxNames.size}</b> box${boxNames.size === 1 ? '' : 'es'}.</p>
      <p><b>Merge</b>: adds new probes and updates probes with the same Box + ID. Photos and history are kept.</p>
      <p><b>Replace all</b>: deletes everything on this device first (incl. photos).</p>`,
    sheet: true,
    actions: [{ label: 'Merge', value: 'merge', kind: 'primary' }, { label: 'Replace all', value: 'replace', kind: 'danger-text' }, { label: 'Cancel', value: null }],
  });
  if (!r.value) return;
  if (r.value === 'replace' && !(await confirmBox('Replace everything?', `All ${S.boxes.size} boxes and ${S.probes.size} probes on this device will be deleted and replaced by the file. Make a backup first if unsure.`, 'Replace'))) return;

  const replaceAll = r.value === 'replace';
  const boxes = replaceAll ? new Map() : new Map([...S.boxes].map(([k, v]) => [k, structuredClone(v)]));
  const probes = replaceAll ? new Map() : new Map([...S.probes].map(([k, v]) => [k, structuredClone(v)]));
  const warn = []; let added = 0, updated = 0, newBoxes = 0, skipped = data.length - ids.length;
  const t = now();
  const findBox = (name) => [...boxes.values()].find((b) => b.name.trim().toLowerCase() === name.toLowerCase());
  const has = (key) => key in map;
  const cell = (row, key) => row[map[key]];

  ids.forEach((row) => {
    const line = rows.indexOf(row) + 1;
    const label = str(cell(row, 'label'));
    const bname = str(cell(row, 'box')) || 'Imported';
    let box = findBox(bname);
    if (!box) { box = { id: uid(), name: bname, note: '', created: t, updated: t }; boxes.set(box.id, box); newBoxes++; }
    let p = [...probes.values()].find((x) => x.boxId === box.id && x.label.toLowerCase() === label.toLowerCase());
    const isNew = !p;
    if (isNew) p = { id: uid(), boxId: box.id, label, type: '', position: '', status: null, ele: null, batch: '', note: '', data: {}, log: [], hasPhoto: false, created: t };
    const before = { status: p.status, ele: p.ele };
    if (has('type')) {
      const ty = resolveType(cell(row, 'type'));
      if (ty && !TYPES[ty]) warn.push(`Row ${line}: unknown type "${ty}" (kept, all fields shown)`);
      p.type = ty;
    }
    if (has('position')) p.position = str(cell(row, 'position'));
    for (const key of ['status', 'ele']) {
      if (!has(key)) continue;
      const s = normStatus(cell(row, key));
      if (s.bad) warn.push(`Row ${line}: status "${str(cell(row, key))}" not recognised → not set`);
      p[key] = s.v;
    }
    if (!typeDef(p.type).elec) p.ele = null;
    for (const k of FIELD_KEYS) {
      if (!has(k)) continue;
      const v = cell(row, k);
      if (FIELDS[k].num) {
        const n = parseNum(v, FIELDS[k].unit === 'Ω');
        if (n.bad) warn.push(`Row ${line}: ${FIELDS[k].label} "${str(v)}" is not a number → empty`);
        if (n.v == null) delete p.data[k]; else p.data[k] = n.v;
      } else if (str(v)) p.data[k] = str(v); else delete p.data[k];
    }
    if (has('batch')) p.batch = str(cell(row, 'batch'));
    if (has('note')) p.note = str(cell(row, 'note'));
    if (isNew) { addLog(p, 'Imported from ' + file.name); added++; }
    else {
      const ch = [];
      if (before.status !== p.status) ch.push(`status ${before.status || '–'} → ${p.status || '–'}`);
      if ((before.ele || null) !== (p.ele || null)) ch.push(`ele. ${before.ele || '–'} → ${p.ele || '–'}`);
      addLog(p, 'Updated from ' + file.name + (ch.length ? ' (' + ch.join(', ') + ')' : ''));
      updated++;
    }
    p.updated = t;
    probes.set(p.id, p);
  });

  const touched = new Set([...probes.values()].filter((p) => p.updated === t).map((p) => p.id));
  const ops = replaceAll ? [{ store: 'boxes', op: 'clear' }, { store: 'probes', op: 'clear' }, { store: 'photos', op: 'clear' }] : [];
  for (const b of boxes.values()) if (replaceAll || b.updated === t) ops.push({ store: 'boxes', op: 'put', value: b });
  for (const p of probes.values()) if (replaceAll || touched.has(p.id)) ops.push({ store: 'probes', op: 'put', value: p });
  await write(ops);
  if (replaceAll) { for (const id of [...photoURLs.keys()]) dropPhotoURL(id); }
  await loadAll();

  await message('Import done', `<p>${added} probe${added === 1 ? '' : 's'} added, ${updated} updated, ${newBoxes} new box${newBoxes === 1 ? '' : 'es'}.${skipped ? ` ${skipped} row${skipped === 1 ? '' : 's'} without ID skipped.` : ''}</p>
    ${ignored.length ? `<p class="muted">Ignored columns: ${ignored.map((h) => esc(str(h))).join(', ')}</p>` : ''}
    ${warn.length ? `<p><b>${warn.length} warning${warn.length === 1 ? '' : 's'}:</b></p><ul>${warn.slice(0, 50).map((w) => `<li>${esc(w)}</li>`).join('')}${warn.length > 50 ? `<li>…and ${warn.length - 50} more</li>` : ''}</ul>` : ''}`);
  render();
}

/* =========================================================
 * Full backup (JSON incl. photos)
 * ========================================================= */
const blobToDataURL = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });

async function makeBackup() {
  const t = idb.transaction('photos'); const st = t.objectStore('photos');
  const [keys, vals] = await Promise.all([reqP(st.getAllKeys()), reqP(st.getAll())]);
  const photos = {};
  for (let i = 0; i < keys.length; i++) photos[keys[i]] = await blobToDataURL(vals[i]);
  const json = JSON.stringify({ app: 'probe-tracker', format: 1, appVersion: APP_VERSION, exported: now(), boxes: [...S.boxes.values()], probes: [...S.probes.values()], photos });
  return new Blob([json], { type: 'application/json' });
}

async function restoreBackup(file) {
  let b;
  try { b = JSON.parse(await file.text()); } catch { return message('Restore failed', '<p>This is not a valid backup file.</p>'); }
  if (!b || b.app !== 'probe-tracker' || !Array.isArray(b.boxes) || !Array.isArray(b.probes)) return message('Restore failed', '<p>This is not a Probe Tracker backup file.</p>');
  const nPh = Object.keys(b.photos || {}).length;
  if (!(await confirmBox('Restore backup?', `Backup from <b>${esc(day(b.exported))}</b>: ${b.boxes.length} boxes, ${b.probes.length} probes, ${nPh} photos.<br><br>Everything currently on this device will be <b>replaced</b>.`, 'Restore'))) return;
  const photoBlobs = [];
  for (const [id, url] of Object.entries(b.photos || {})) photoBlobs.push([id, await (await fetch(url)).blob()]);
  await write([
    { store: 'boxes', op: 'clear' }, { store: 'probes', op: 'clear' }, { store: 'photos', op: 'clear' },
    ...b.boxes.map((x) => ({ store: 'boxes', op: 'put', value: x })),
    ...b.probes.map((x) => ({ store: 'probes', op: 'put', value: x })),
    ...photoBlobs.map(([id, blob]) => ({ store: 'photos', op: 'put', value: blob, key: id })),
  ]);
  for (const id of [...photoURLs.keys()]) dropPhotoURL(id);
  await loadAll();
  toast('Backup restored');
  render();
}

/* =========================================================
 * View: settings
 * ========================================================= */
function viewSettings() {
  const last = localStorage.getItem('pt.lastBackup');
  app.innerHTML = header({ title: 'Settings', back: '#/' }) + `
    <main>
      <div class="section-title">Spreadsheet</div>
      <section class="card">
        <p class="muted" style="margin-top:0">One row per probe with a Box column. Edit it in Excel and import it back. Photos are not included.</p>
        <div class="btn-col">
          <button class="btn" id="expX">Export .xlsx</button>
          <button class="btn" id="expC">Export .csv (Czech Excel: ; and decimal comma)</button>
          <button class="btn primary" id="imp">Import .xlsx / .csv</button>
          <button class="btn" id="tpl">Download empty template (.xlsx)</button>
        </div>
        <input type="file" id="impIn" accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
      </section>

      <div class="section-title">Backup (everything incl. photos)</div>
      <section class="card">
        <p class="muted" style="margin-top:0">Data is stored only in this browser/device. A backup file moves everything between devices (PC ↔ phone) and keeps you safe if the phone is lost or reset.</p>
        <p>Last backup: <b>${last ? day(last) : 'never'}</b></p>
        <div class="btn-col">
          <button class="btn primary" id="bak">Save backup file</button>
          ${navigator.share ? '<button class="btn" id="bakShare">Share backup (Drive, e-mail…)</button>' : ''}
          <button class="btn" id="rest">Restore from backup…</button>
        </div>
        <input type="file" id="restIn" accept=".json,application/json" hidden>
      </section>

      <div class="section-title">Storage</div>
      <section class="card"><p id="stor" style="margin:0">${S.boxes.size} boxes · ${S.probes.size} probes</p></section>

      <div class="section-title">Danger zone</div>
      <section class="card"><button class="btn danger" id="wipe" style="width:100%">Delete all data on this device</button></section>
      <p class="muted center">Probe Tracker v${APP_VERSION}</p>
    </main>`;
  bindHeader();

  $('#expX').onclick = () => act(() => exportXLSX(false));
  $('#expC').onclick = () => act(() => exportCSV());
  $('#tpl').onclick = () => act(() => exportXLSX(true));
  $('#imp').onclick = () => $('#impIn').click();
  $('#impIn').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) act(() => importFile(f)); };

  const markBackup = () => { localStorage.setItem('pt.lastBackup', now()); };
  $('#bak').onclick = () => act(async () => { download(await makeBackup(), `probe-tracker-backup-${day(now())}.json`); markBackup(); viewSettings(); });
  if ($('#bakShare')) $('#bakShare').onclick = () => act(async () => {
    await shareOrDownload(await makeBackup(), `probe-tracker-backup-${day(now())}.json`, 'application/json'); markBackup(); viewSettings();
  });
  $('#rest').onclick = () => $('#restIn').click();
  $('#restIn').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) act(() => restoreBackup(f)); };

  $('#wipe').onclick = () => act(async () => {
    if (!(await confirmBox('Delete all data?', `All ${S.boxes.size} boxes, ${S.probes.size} probes and photos on this device will be deleted.`, 'Continue'))) return;
    if (!(await confirmBox('Really delete everything?', 'This cannot be undone.', 'Delete all'))) return;
    await write([{ store: 'boxes', op: 'clear' }, { store: 'probes', op: 'clear' }, { store: 'photos', op: 'clear' }]);
    for (const id of [...photoURLs.keys()]) dropPhotoURL(id);
    await loadAll(); toast('All data deleted'); viewSettings();
  });

  (async () => {
    const parts = [`${S.boxes.size} boxes · ${S.probes.size} probes`];
    try {
      if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); parts.push(`${(e.usage / 1048576).toFixed(1)} MB used`); }
      if (navigator.storage?.persisted) {
        parts.push((await navigator.storage.persisted())
          ? 'protected storage: yes'
          : 'protected storage: no (install the app to the home screen so Android does not clear it)');
      }
    } catch { /* ignore */ }
    const el = $('#stor'); if (el) el.textContent = parts.join(' · ');
  })();
}

/* =========================================================
 * Start
 * ========================================================= */
(async function init() {
  try {
    await openDB();
    await loadAll();
  } catch (e) {
    app.innerHTML = `<main><div class="empty"><p><b>Could not open storage.</b></p><p class="muted">${esc(e.message || e)}</p></div></main>`;
    return;
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  window.addEventListener('hashchange', onHash);
  onHash();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('App updated', 8000, { label: 'Reload', fn: () => location.reload() });
      hadController = true;
    });
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
})();
