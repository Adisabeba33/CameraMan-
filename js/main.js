// Точка входа: связывает камеру, конвейер эффектов, интерфейс и съёмку.

import { Camera } from './camera.js';
import { Capture } from './capture.js';
import { Pipeline, QUALITY } from './pipeline.js';
import { MODES, MODE_BY_ID, paramList, defaults } from './modes.js';
import { el, icon, buildParams, row, switchBtn, select, makeHinter } from './ui.js';

const $ = (id) => document.getElementById(id);
const KEY = 'chronocam.v1';
const APP_VERSION = '1.2';

const dom = {
  stage: $('stage'), canvas: $('view'), video: $('src'), boot: $('boot'), bootErr: $('boot-err'), start: $('btn-start'),
  modes: $('modes'), modesMore: $('modes-more'), params: $('params'), title: $('mode-title'), sub: $('mode-sub'), hint: $('hint'),
  flip: $('btn-flip'), settings: $('btn-settings'), shot: $('btn-shot'), rec: $('btn-rec'), paramsBtn: $('btn-params'),
  recPill: $('rec-pill'), recTime: $('rec-time'), flash: $('flash'),
  gallery: $('btn-gallery'), thumb: $('gallery-thumb'), count: $('gallery-count'),
  sheet: $('sheet'), sheetTitle: $('sheet-title'), sheetBody: $('sheet-body'), sheetClose: $('sheet-close'),
};

const say = makeHinter(dom.hint);

const GRADE_PARAMS = [
  { type: 'range', key: 'contrast', label: 'Контраст', min: 0.6, max: 1.6, step: 0.02, fmt: (v) => v.toFixed(2) },
  { type: 'range', key: 'saturation', label: 'Насыщенность', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
  { type: 'range', key: 'vignette', label: 'Виньетка', min: 0, max: 1, step: 0.02, fmt: (v) => Math.round(v * 100) + '%' },
  { type: 'range', key: 'grain', label: 'Зерно', min: 0, max: 0.2, step: 0.005, fmt: (v) => Math.round(v * 500) + '%' },
];

const state = load();

function load() {
  const base = {
    modeId: 'slitscan',
    fit: 'cover',
    mirror: true,
    quality: 'medium',
    keepAwake: true,
    grade: { contrast: 1, saturation: 1, vignette: 0.22, grain: 0.02 },
    params: Object.fromEntries(MODES.map((m) => [m.id, defaults(m)])),
  };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    const s = { ...base, ...saved, grade: { ...base.grade, ...(saved.grade || {}) } };
    s.params = Object.fromEntries(MODES.map((m) => [m.id, { ...defaults(m), ...(saved.params?.[m.id] || {}) }]));
    if (!MODE_BY_ID[s.modeId]) s.modeId = base.modeId;
    if (!QUALITY[s.quality]) s.quality = base.quality;
    if (s.fit !== 'cover' && s.fit !== 'contain') s.fit = base.fit;
    return s;
  } catch {
    return base;
  }
}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* приватный режим */ }
  }, 250);
}

const camera = new Camera(dom.video);
const capture = new Capture(dom.canvas);
let pipe = null;
let running = false;
let wakeLock = null;

// ---------- режимы ----------

function renderModeChips() {
  dom.modes.replaceChildren();
  for (const m of MODES) {
    const chip = el('button', {
      class: 'mode-chip' + (m.id === state.modeId ? ' on' : ''),
      title: m.sub,
      onclick: () => setMode(m.id),
    }, [icon(m.icon), el('span', { text: m.name })]);
    chip.dataset.mode = m.id;
    dom.modes.appendChild(chip);
  }
  updateModesMore();
}

/** Стрелка-подсказка видна, пока лента режимов прокручена не до конца. */
function updateModesMore() {
  const n = dom.modes;
  dom.modesMore.hidden = n.scrollLeft + n.clientWidth >= n.scrollWidth - 8;
}

function setMode(id, quiet = false) {
  state.modeId = id;
  save();
  const m = MODE_BY_ID[id];
  pipe?.setMode(id);
  if (pipe) pipe.params = state.params[id];
  dom.title.textContent = m.name;
  dom.sub.textContent = m.sub;
  [...dom.modes.children].forEach((c) => c.classList.toggle('on', c.dataset.mode === id));
  document.querySelector('.mode-chip.on')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  renderParams();
  if (!quiet) say(m.hint, 4200);
}

function renderParams() {
  const m = MODE_BY_ID[state.modeId];
  const values = state.params[m.id];
  buildParams(dom.params, paramList(m), values, (k, v) => {
    values[k] = v;
    save();
  });
  if (m.resettable) {
    dom.params.prepend(el('div', { class: 'actions-row' }, [
      el('button', {
        class: 'pill-btn',
        onclick: () => { pipe?.reset(); say('Накопление сброшено'); },
      }, [icon('M3 12a9 9 0 1 0 3-6.7M3 4v5h5'), el('span', { text: 'Начать заново' })]),
    ]));
  }
  applyParamsVisibility();
}

function applyFit() {
  dom.stage.classList.toggle('cover', state.fit === 'cover');
  if (pipe) {
    pipe.fit = state.fit;
    const r = dom.stage.getBoundingClientRect();
    pipe.setDisplaySize(r.width, r.height);
  }
}

let paramsOpen = true;
function applyParamsVisibility() {
  const has = dom.params.childElementCount > 0;
  dom.params.hidden = !has || !paramsOpen;
  dom.paramsBtn.classList.toggle('on', paramsOpen);
  dom.paramsBtn.setAttribute('aria-pressed', paramsOpen ? 'true' : 'false');
}

// ---------- цикл ----------

function loop(now) {
  if (!running) return;
  requestAnimationFrame(loop);
  if (!camera.tracksFrames) pipe.newFrame = true;
  try {
    pipe.frame(now);
  } catch (e) {
    running = false;
    console.error(e);
    fail(e.message || String(e));
    return;
  }
  if (capture.recording) {
    const t = capture.elapsed();
    dom.recTime.textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  }
}

// ---------- запуск ----------

async function boot() {
  dom.start.disabled = true;
  dom.start.textContent = 'Подключаюсь…';
  try {
    pipe = new Pipeline(dom.canvas, dom.video);
    pipe.onHint = say;
    pipe.quality = state.quality;
    pipe.grade = state.grade;
    pipe.mirror = state.mirror;
    applyFit();

    const info = await camera.start({ facing: 'user' });
    camera.onFrame = () => { if (pipe) pipe.newFrame = true; };

    setMode(state.modeId, true);
    pipe.params = state.params[state.modeId];

    dom.boot.classList.add('gone');
    running = true;
    requestAnimationFrame(loop);
    say(MODE_BY_ID[state.modeId].hint, 5000);
    if (state.keepAwake) requestWakeLock();
    console.info('Камера:', info.label, info.width + '×' + info.height);
  } catch (e) {
    console.error(e);
    dom.start.disabled = false;
    dom.start.textContent = 'Попробовать снова';
    fail(describeError(e));
  }
}

function describeError(e) {
  const n = e?.name || '';
  if (n === 'NotAllowedError') return 'Доступ к камере запрещён. Разреши его в настройках сайта и попробуй снова.';
  if (n === 'NotFoundError') return 'Камера не найдена.';
  if (n === 'NotReadableError') return 'Камеру занял другой процесс — закрой другие приложения с камерой.';
  return e?.message || 'Не удалось запустить камеру.';
}

function fail(msg) {
  dom.bootErr.textContent = msg;
  dom.bootErr.hidden = false;
  dom.boot.classList.remove('gone');
}

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* не поддерживается */ }
}

// ---------- съёмка ----------

async function takePhoto() {
  if (!running) return;
  dom.flash.classList.remove('on');
  void dom.flash.offsetWidth;
  dom.flash.classList.add('on');
  try {
    await capture.photo(state.modeId);
    say('Снимок в галерее приложения — там его можно сохранить');
  } catch (e) {
    say('Не удалось сохранить кадр');
    console.error(e);
  }
}

function toggleRecord() {
  if (!running) return;
  if (capture.recording) {
    capture.stopRecording();
    dom.rec.classList.remove('on');
    dom.recPill.hidden = true;
    say('Видео сохранено в галерею приложения');
  } else {
    try {
      capture.startRecording(state.modeId);
      dom.rec.classList.add('on');
      dom.recPill.hidden = false;
      dom.recTime.textContent = '0:00';
    } catch (e) {
      say(e.message);
    }
  }
}

capture.onChange = () => {
  const n = capture.shots.length;
  dom.count.hidden = n === 0;
  dom.count.textContent = String(n);
  const firstPhoto = capture.shots.find((s) => s.kind === 'photo');
  dom.thumb.style.backgroundImage = firstPhoto ? `url(${firstPhoto.url})` : '';
};

// ---------- шторки ----------

function openSheet(title, build) {
  dom.sheetTitle.textContent = title;
  dom.sheetBody.replaceChildren();
  build(dom.sheetBody);
  dom.sheet.hidden = false;
}
const closeSheet = () => { dom.sheet.hidden = true; };

function buildSettings(body) {
  const camOptions = camera.devices.length
    ? camera.devices.map((d, i) => ({ value: d.deviceId, label: d.label || `Камера ${i + 1}` }))
    : [{ value: '', label: 'Камера по умолчанию' }];

  body.append(
    el('h3', { text: 'Камера' }),
    row('Устройство', null, select(camOptions, camera.deviceId || '', async (id) => {
      if (id) await camera.start({ deviceId: id });
    })),
    row('Зеркальный кадр', 'как в зеркале — удобно для селфи', switchBtn(state.mirror, (v) => {
      state.mirror = v; pipe.mirror = v; pipe.reset(); save();
    })),
    row('Кадр', 'во весь экран — как в обычной камере', select(
      [{ value: 'cover', label: 'Во весь экран' }, { value: 'contain', label: 'Целиком, с полями' }],
      state.fit,
      (v) => { state.fit = v; applyFit(); save(); }
    )),
    row('Качество', QUALITY[state.quality].label, select(
      Object.entries(QUALITY).map(([k, q]) => ({ value: k, label: q.label })),
      state.quality,
      (k) => { state.quality = k; pipe.quality = k; save(); closeSheet(); }
    )),
    row('Не гасить экран', null, switchBtn(state.keepAwake, (v) => {
      state.keepAwake = v; save();
      if (v) requestWakeLock(); else { wakeLock?.release?.(); wakeLock = null; }
    })),
    el('h3', { text: 'Картинка' }),
  );

  const grade = el('div', { class: 'sheet-body' });
  buildParams(grade, GRADE_PARAMS, state.grade, (k, v) => { state.grade[k] = v; save(); });
  body.appendChild(grade);

  body.append(
    el('h3', { text: 'О приложении' }),
    row(`Хроно-камера ${APP_VERSION}`, `${MODES.length} режимов · всё считается на устройстве`, null),
    el('h3', { text: 'Горячие клавиши' }),
    el('div', { class: 'row' }, [el('small', {
      text: 'Пробел — снимок · R — запись · C — сброс накопления · F — сменить камеру · P — панель режима · 1…7 — режимы',
    })]),
  );
}

function buildGallery(body) {
  if (!capture.shots.length) {
    body.appendChild(el('div', { class: 'empty', text: 'Пока пусто. Снимай — кадры появятся здесь.' }));
    return;
  }
  const grid = el('div', { class: 'shots' });
  for (const item of capture.shots) {
    const media = item.kind === 'photo'
      ? el('img', { src: item.url, alt: item.name })
      : el('video', { src: item.url, muted: true, loop: true, playsinline: true, autoplay: true });
    const canShare = !!navigator.canShare?.({ files: [new File([], item.name, { type: item.blob.type })] });
    grid.appendChild(el('div', { class: 'shot' }, [
      media,
      el('span', { class: 'tag', text: item.kind === 'photo' ? 'фото' : 'видео' }),
      el('button', {
        class: 'dl', title: canShare ? 'Поделиться / сохранить' : 'Сохранить',
        'aria-label': canShare ? 'Поделиться' : 'Сохранить',
        onclick: async () => { if (!canShare || !(await capture.share(item))) capture.download(item); },
      }, [icon(canShare ? 'M12 4v11M8 8l4-4 4 4M5 14v5h14v-5' : 'M12 4v10M8 11l4 4 4-4M5 19h14')]),
    ]));
  }
  body.appendChild(grid);
  body.appendChild(el('div', { class: 'empty', text: 'Кадры живут до перезагрузки страницы — сохраняй нужные.' }));
}

// ---------- события ----------

dom.start.addEventListener('click', boot);
dom.shot.addEventListener('click', takePhoto);
dom.rec.addEventListener('click', toggleRecord);
dom.gallery.addEventListener('click', () => openSheet('Снимки', buildGallery));
dom.settings.addEventListener('click', () => openSheet('Настройки', buildSettings));
dom.paramsBtn.addEventListener('click', () => { paramsOpen = !paramsOpen; applyParamsVisibility(); });
dom.modes.addEventListener('scroll', updateModesMore, { passive: true });
window.addEventListener('resize', () => { updateModesMore(); applyFit(); });
if ('ResizeObserver' in window) new ResizeObserver(applyFit).observe(dom.stage);
dom.modesMore.addEventListener('click', () => {
  dom.modes.scrollBy({ left: dom.modes.clientWidth * 0.75, behavior: 'smooth' });
});
dom.sheetClose.addEventListener('click', closeSheet);
dom.sheet.addEventListener('click', (e) => { if (e.target === dom.sheet) closeSheet(); });

dom.flip.addEventListener('click', async () => {
  if (!running) return;
  try {
    await camera.next();
    state.mirror = camera.facing !== 'environment';
    pipe.mirror = state.mirror;
    pipe.reset();
    save();
  } catch (e) {
    say('Другая камера недоступна');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if (e.code === 'Space') { e.preventDefault(); takePhoto(); }
  else if (k === 'r') toggleRecord();
  else if (k === 'c') { pipe?.reset(); say('Накопление сброшено'); }
  else if (k === 'f') dom.flip.click();
  else if (k === 'escape') closeSheet();
  else if (k === 'p') dom.paramsBtn.click();
  else if (/^[1-9]$/.test(k) && MODES[+k - 1]) setMode(MODES[+k - 1].id);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.keepAwake && running) requestWakeLock();
});

renderModeChips();
setMode(state.modeId, true);
dom.params.hidden = true; // до запуска камеры панель не нужна

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  // Новая версия должна доезжать сама: без этого установленное PWA живёт
  // на старых файлах, пока пользователь не переустановит его вручную.
  // Перезагружаемся только при СМЕНЕ версии. При самой первой регистрации
  // контроллер тоже меняется (null → sw), и без этой проверки страница
  // перезагрузилась бы прямо во время запуска камеры.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      reg.update();
      setInterval(() => reg.update(), 60 * 60 * 1000);
    } catch { /* офлайн или заблокировано настройками — не критично */ }
  });
}
