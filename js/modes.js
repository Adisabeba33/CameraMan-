// Режимы съёмки. Каждый режим — это способ превратить историю кадров
// в одно изображение. render() возвращает текстуру, которую надо показать.

const S = (key, label, min, max, step, def, fmt) => ({ type: 'range', key, label, min, max, step, def, fmt });
const SEG = (key, label, options, def) => ({ type: 'seg', key, label, options, def });
const TOG = (key, label, def) => ({ type: 'toggle', key, label, def });

const pct = (v) => Math.round(v * 100) + '%';
const sec = (v) => (v >= 1 ? v.toFixed(1) + ' с' : Math.round(v * 1000) + ' мс');

// направление развёртки: [ось, реверс]
const DIRS = [
  { v: 0, label: '→' },
  { v: 1, label: '←' },
  { v: 2, label: '↓' },
  { v: 3, label: '↑' },
];
const axisOf = (d) => (d >= 2 ? 1 : 0);
const revOf = (d) => (d === 1 || d === 3 ? 1 : 0);

// затухание, независимое от частоты кадров
const decayDt = (perFrame, dt) => Math.pow(perFrame, Math.min(dt, 0.1) * 60);

export const MODES = [
  {
    id: 'slitscan',
    name: 'Слит-скан',
    sub: 'каждый столбец кадра — свой момент',
    hint: 'Медленно веди камерой или двигайся сам — время «размажется» поперёк кадра.',
    icon: 'M4 4v16M8 4v16M12 4v16M16 4v16M20 4v16',
    usesStride: true,
    params: [
      SEG('dir', 'Направление', DIRS, 0),
      S('spread', 'Глубина времени', 0.1, 1, 0.01, 1, pct),
      TOG('smooth', 'Плавные переходы', 1),
    ],
    render(ctx) {
      const p = ctx.params;
      ctx.draw(ctx.P('slitscan'), ctx.scene, {
        uHist: ctx.hist.tex,
        uHead: ctx.hist.head,
        uCount: ctx.hist.layers,
        uSpread: p.spread * (ctx.hist.layers - 1),
        uAxis: axisOf(p.dir),
        uReverse: revOf(p.dir),
        uSmooth: p.smooth,
      });
      return ctx.scene.tex;
    },
  },

  {
    id: 'timewarp',
    name: 'Скан времени',
    sub: 'линия проходит и замораживает кадр',
    hint: 'Линия идёт по кадру и «запекает» всё, что уже прошла. Успевай менять позу.',
    icon: 'M12 3v18M4 7h4M4 12h4M4 17h4M16 7h4M16 12h4M16 17h4',
    accum: true,
    resettable: true,
    params: [
      SEG('dir', 'Направление', DIRS, 0),
      S('speed', 'Проход за', 1, 12, 0.5, 5, (v) => v + ' с'),
    ],
    render(ctx) {
      const p = ctx.params;
      if (ctx.reset) ctx.mem.pos = 0;
      const prev = ctx.mem.pos ?? 0;
      ctx.draw(ctx.P('timewarp'), ctx.accum.write, {
        uHist: ctx.hist.tex,
        uHead: ctx.hist.head,
        uPrev: ctx.accum.read.tex,
        uAxis: axisOf(p.dir),
        uReverse: revOf(p.dir),
        uPrevPos: prev,
      });
      ctx.accum.swap();
      const pos = Math.min(1, prev + ctx.dt / p.speed);
      ctx.mem.pos = pos;
      if (pos < 1) {
        ctx.line = { on: 1, pos: revOf(p.dir) ? 1 - pos : pos, axis: axisOf(p.dir) };
      } else if (prev < 1) {
        ctx.say('Кадр готов — жми затвор');
      }
      return ctx.accum.read.tex;
    },
  },

  {
    id: 'lightpaint',
    name: 'Световая кисть',
    sub: 'длинная выдержка в реальном времени',
    hint: 'Свети фонариком или экраном телефона в кадре — след останется. Сброс стирает холст.',
    icon: 'M4 19c3-9 8 1 11-8M17 6l2-2 2 2-2 2z',
    accum: true,
    accumFloat: true,
    resettable: true,
    params: [
      SEG('blend', 'Тип выдержки', [
        { v: 0, label: 'Следы света' },
        { v: 1, label: 'Шёлк' },
        { v: 2, label: 'Сложение' },
      ], 0),
      S('decay', 'Стойкость следа', 0.9, 1, 0.002, 0.996, (v) => (v >= 0.9995 ? '∞' : pct((v - 0.9) * 10))),
      S('amount', 'Сила', 0.004, 0.3, 0.002, 0.04, (v) => v.toFixed(3)),
    ],
    render(ctx) {
      const p = ctx.params;
      ctx.draw(ctx.P('lightpaint'), ctx.accum.write, {
        uHist: ctx.hist.tex,
        uHead: ctx.hist.head,
        uPrev: ctx.accum.read.tex,
        uMode: p.blend,
        uDecay: p.decay >= 0.9995 ? 1 : decayDt(p.decay, ctx.dt),
        uAmount: p.amount,
        uInit: ctx.reset ? 1 : 0,
      });
      ctx.accum.swap();
      return ctx.accum.read.tex;
    },
  },

  {
    id: 'strobe',
    name: 'Стробо-серия',
    sub: 'несколько поз в одном кадре',
    hint: 'Отойди на секунду, чтобы камера запомнила фон, потом двигайся — останутся отпечатки.',
    icon: 'M6 20v-3M6 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4M12 20v-3M12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4M18 20v-3M18 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
    accum: true,
    bg: true,
    bgRate: 0.02,
    resettable: true,
    params: [
      S('interval', 'Интервал отпечатка', 0.15, 3, 0.05, 0.6, sec),
      S('thr', 'Порог движения', 0.05, 0.6, 0.01, 0.2, (v) => v.toFixed(2)),
      S('live', 'Показывать себя', 0, 1, 0.05, 0.9, pct),
    ],
    render(ctx) {
      const p = ctx.params;
      if (ctx.reset) ctx.mem.last = -1e9;
      const stamp = ctx.time - (ctx.mem.last ?? -1e9) >= p.interval;
      if (stamp) ctx.mem.last = ctx.time;
      const common = { uThr: p.thr, uSoft: 0.12 };
      ctx.draw(ctx.P('strobeStamp'), ctx.accum.write, {
        ...common,
        uHist: ctx.hist.tex,
        uHead: ctx.hist.head,
        uPrev: ctx.accum.read.tex,
        uBg: ctx.bg.read.tex,
        uStamp: stamp ? 1 : 0,
        uInit: ctx.reset ? 1 : 0,
      });
      ctx.accum.swap();
      ctx.draw(ctx.P('strobeView'), ctx.scene, {
        ...common,
        uHist: ctx.hist.tex,
        uHead: ctx.hist.head,
        uAccum: ctx.accum.read.tex,
        uBg: ctx.bg.read.tex,
        uLive: p.live,
      });
      return ctx.scene.tex;
    },
  },

  {
    id: 'echo',
    name: 'Эхо',
    sub: 'прошлое тянется за настоящим',
    hint: 'Резкие движения дают самый заметный шлейф. Попробуй стиль «RGB» — цвета разъедутся во времени.',
    icon: 'M4 8a5 5 0 0 1 0 8M9 6a8 8 0 0 1 0 12M14 4a10 10 0 0 1 0 16',
    usesStride: true,
    params: [
      SEG('style', 'Стиль', [
        { v: 0, label: 'Призраки' },
        { v: 1, label: 'Смаз' },
        { v: 2, label: 'Радуга' },
        { v: 3, label: 'RGB' },
      ], 0),
      S('copies', 'Копий', 1, 8, 1, 5, (v) => String(v)),
      S('step', 'Шаг во времени', 1, 8, 1, 3, (v) => String(v)),
      S('falloff', 'Затухание', 0.4, 0.98, 0.02, 0.86, pct),
    ],
    render(ctx) {
      const p = ctx.params;
      ctx.draw(ctx.P('echo'), ctx.scene, {
        uHist: ctx.hist.tex,
        uHead: ctx.hist.head,
        uCount: ctx.hist.layers,
        uStep: p.step,
        uCopies: p.copies,
        uFalloff: p.falloff,
        uStyle: p.style,
      });
      return ctx.scene.tex;
    },
  },

  {
    id: 'motion',
    name: 'Только движение',
    sub: 'видно лишь то, что изменилось',
    hint: 'Замри и заморозь фон — дальше в кадре останется только то, что двигалось.',
    icon: 'M3 12h3.5l2-5.5 3 11 2.5-7.5 1.8 4H21',
    bg: true,
    bgRate: 0.01,
    aux: true,
    resettable: true,
    params: [
      SEG('style', 'Стиль', [
        { v: 0, label: 'Вырез' },
        { v: 1, label: 'На фоне' },
        { v: 2, label: 'Усиление' },
        { v: 3, label: 'Тепло' },
      ], 1),
      TOG('freeze', 'Заморозить фон', 0),
      S('thr', 'Порог', 0.04, 0.6, 0.01, 0.16, (v) => v.toFixed(2)),
      S('boost', 'Усиление разницы', 1, 8, 0.5, 3, (v) => '×' + v),
      S('heat', 'Память тепла', 0.9, 1, 0.002, 0.994, (v) => (v >= 0.9995 ? '∞' : pct((v - 0.9) * 10))),
    ],
    render(ctx) {
      const p = ctx.params;
      const common = { uThr: p.thr, uSoft: 0.1 };
      if (p.style === 3) {
        ctx.draw(ctx.P('motionHeat'), ctx.aux.write, {
          ...common,
          uHist: ctx.hist.tex,
          uHead: ctx.hist.head,
          uPrev: ctx.aux.read.tex,
          uBg: ctx.bg.read.tex,
          uDecay: p.heat >= 0.9995 ? 1 : decayDt(p.heat, ctx.dt),
          uInit: ctx.reset ? 1 : 0,
        });
        ctx.aux.swap();
      }
      ctx.draw(ctx.P('motionView'), ctx.scene, {
        ...common,
        uHist: ctx.hist.tex,
        uHead: ctx.hist.head,
        uBg: ctx.bg.read.tex,
        uHeat: ctx.aux.read.tex,
        uStyle: p.style,
        uBoost: p.boost,
      });
      return ctx.scene.tex;
    },
  },

  {
    id: 'nightvision',
    name: 'Ночное видение',
    sub: 'зелёный свет, как в приборе',
    hint: 'Для полутьмы: прибор копит свет нескольких кадров и усиливает его. Темно — подними усиление и накопление.',
    icon: 'M2 12a4 4 0 1 0 8 0 4 4 0 1 0-8 0M14 12a4 4 0 1 0 8 0 4 4 0 1 0-8 0M10 12h4M3 8l1.5-3h15L21 8',
    aux: true,
    params: [
      SEG('phosphor', 'Люминофор', [
        { v: 0, label: 'Зелёный' },
        { v: 1, label: 'Белый' },
        { v: 2, label: 'Янтарный' },
      ], 0),
      S('gain', 'Усиление света', 1, 12, 0.5, 4, (v) => '×' + v),
      S('stack', 'Накопление кадров', 1, 16, 1, 8, (v) => String(v)),
      S('bloom', 'Свечение огней', 0, 1, 0.05, 0.5, pct),
      S('noise', 'Шум прибора', 0, 0.4, 0.01, 0.12, pct),
      SEG('eyepieces', 'Окуляры прибора', [
        { v: 0, label: 'Без них' },
        { v: 1, label: 'Круг' },
        { v: 2, label: 'Бинокль' },
      ], 0),
    ],
    render(ctx) {
      const p = ctx.params;
      // проход 1: накопление света из истории + усиление
      ctx.draw(ctx.P('nvStack'), ctx.aux.write, {
        uHist: ctx.hist.tex,
        uHead: ctx.hist.head,
        uCount: ctx.hist.layers,
        uStack: p.stack,
        uGain: p.gain,
      });
      ctx.aux.swap();
      // проход 2: люминофор, шум, ореолы, окуляры
      ctx.draw(ctx.P('nvView'), ctx.scene, {
        uSrc: ctx.aux.read.tex,
        uPhosphor: p.phosphor,
        uNoise: p.noise,
        uMask: p.eyepieces,
        uBloom: p.bloom,
        uTime: ctx.time,
        uAspect: ctx.w / ctx.h,
      });
      return ctx.scene.tex;
    },
  },

  {
    id: 'magnify',
    name: 'Микроскоп движения',
    sub: 'видно то, что глазу не заметно',
    hint: 'Держи камеру неподвижно и не шевелись. Наведи на лицо — проступит пульс, на грудь — дыхание.',
    icon: 'M3 12h3l2-4 2.5 8 2-6 1.5 3 2-5 2 4h3M5 5h14M5 19h14',
    resettable: true,
    // границы полосы пропускания в герцах
    bands: [[0.7, 3.2], [0.12, 0.6], [3, 12]],
    params: [
      SEG('band', 'Что ищем', [
        { v: 0, label: 'Пульс' },
        { v: 1, label: 'Дыхание' },
        { v: 2, label: 'Вибрацию' },
      ], 0),
      S('gain', 'Усиление', 5, 120, 5, 40, (v) => '×' + v),
      S('blur', 'Сглаживание', 0.5, 6, 0.5, 2.5, (v) => v.toFixed(1)),
      SEG('style', 'Показ', [
        { v: 0, label: 'Поверх кадра' },
        { v: 1, label: 'Только сигнал' },
        { v: 2, label: 'Карта' },
      ], 0),
      TOG('pulse', 'Считать пульс', 1),
    ],
    render(ctx) {
      const p = ctx.params;
      const [fLo, fHi] = this.bands[p.band] || this.bands[0];
      const alpha = (f) => 1 - Math.exp(-2 * Math.PI * f * Math.min(ctx.dt, 0.1));

      const blurred = ctx.get('mgBlur', 'target');
      const slow = ctx.get('mgSlow', 'pp');
      const fast = ctx.get('mgFast', 'pp');

      ctx.draw(ctx.P('blurHist'), blurred, {
        uHist: ctx.hist.tex,
        uHead: ctx.hist.head,
        uTexel: ctx.texel,
        uRadius: p.blur,
      });
      for (const [pp, f] of [[slow, fLo], [fast, fHi]]) {
        ctx.draw(ctx.P('iir'), pp.write, {
          uSrc: blurred.tex,
          uPrev: pp.read.tex,
          uAlpha: alpha(f),
          uInit: ctx.reset ? 1 : 0,
        });
        pp.swap();
      }

      ctx.draw(ctx.P('magnifyView'), ctx.scene, {
        uHist: ctx.hist.tex,
        uHead: ctx.hist.head,
        uFast: fast.read.tex,
        uSlow: slow.read.tex,
        uGain: p.gain,
        uStyle: p.style,
      });

      if (p.pulse) measurePulse(ctx, fast.read, slow.read);
      return ctx.scene.tex;
    },
  },

  {
    id: 'photofinish',
    name: 'Фотофиниш',
    sub: 'время вытягивается в длинную ленту',
    hint: 'Пусть объект пересекает щель — поезд, рука, бегун. Затвор сохранит всю ленту целиком.',
    icon: 'M3 5v14M7 5v14M11 5v14M15 5v14M19 5v14M3 12h16',
    resettable: true,
    params: [
      S('pos', 'Где щель', 0, 1, 0.01, 0.5, pct),
      S('slit', 'Ширина щели', 0.002, 0.06, 0.002, 0.01, (v) => (v * 100).toFixed(1) + '%'),
      S('speed', 'Колонок за кадр', 1, 8, 1, 2, (v) => String(v)),
      S('length', 'Длина ленты', 1024, 8192, 512, 4096, (v) => v + ' px'),
    ],
    render(ctx) {
      const p = ctx.params;
      const total = Math.round(p.length);
      const strip = ctx.get('strip', 'target8', total, ctx.h);
      // смена длины пересоздаёт ленту — счётчик записанного надо обнулить вместе с ней
      if (ctx.reset || ctx.mem.total !== total) {
        ctx.mem.wrote = 0;
        ctx.mem.total = total;
      }
      let wrote = ctx.mem.wrote ?? 0;

      // колонки привязаны к кадрам камеры, а не к перерисовкам экрана:
      // иначе лента растягивалась бы по-разному при разной частоте кадров
      const step = Math.max(1, p.speed | 0);
      if (ctx.fresh && wrote < total) {
        const width = Math.min(step, total - wrote);
        ctx.draw(ctx.P('stripWrite'), strip, {
          uHist: ctx.hist.tex,
          uHead: ctx.hist.head,
          uPos: p.pos,
          uSlit: p.slit,
        }, [wrote, 0, width, ctx.h]);
        wrote += width;
        ctx.mem.wrote = wrote;
        if (wrote >= total) ctx.say('Лента заполнена — жми затвор, чтобы сохранить');
      }

      ctx.draw(ctx.P('stripView'), ctx.scene, {
        uStrip: strip.tex,
        uHist: ctx.hist.tex,
        uHead: ctx.hist.head,
        uWrote: wrote,
        uWindow: ctx.w,
        uTotal: total,
        uPos: p.pos,
        uInset: 0.3,
      });
      return ctx.scene.tex;
    },
    /** Затвор сохраняет всю ленту целиком, а не её видимый кусок. */
    exportFrame(ctx) {
      const total = Math.round(ctx.params.length);
      const wrote = Math.max(2, Math.round(ctx.mem.wrote ?? 0));
      const strip = ctx.get('strip', 'target8', total, ctx.h);
      if (wrote >= total) return { tex: strip.tex, w: total, h: ctx.h };
      // лента заполнена не до конца — вырезаем записанную часть, без чёрного хвоста
      const out = ctx.get('stripOut', 'target8', wrote, ctx.h);
      ctx.draw(ctx.P('stripView'), out, {
        uStrip: strip.tex, uWrote: wrote, uWindow: wrote, uTotal: total,
        uHist: ctx.hist.tex, uHead: ctx.hist.head, uPos: 0, uInset: 0,  // во врезке снимок не нуждается
      });
      return { tex: out.tex, w: wrote, h: ctx.h };
    },
  },

  {
    id: 'liquid',
    name: 'Жидкая реальность',
    sub: 'движение искажает пространство',
    hint: 'Двигай рукой перед камерой. «Датамош» тянет цвета за движением — как глитч в клипах.',
    icon: 'M3 8c3-3 6 3 9 0s6-3 9 0M3 14c3-3 6 3 9 0s6-3 9 0M3 20c3-3 6 3 9 0s6-3 9 0',
    accum: true,
    resettable: true,
    params: [
      SEG('style', 'Стиль', [
        { v: 0, label: 'Марево' },
        { v: 1, label: 'Датамош' },
        { v: 2, label: 'Поток' },
      ], 0),
      S('amount', 'Сила искажения', 0.2, 6, 0.2, 2, (v) => '×' + v.toFixed(1)),
      S('viscosity', 'Вязкость', 0.05, 0.95, 0.05, 0.6, pct),
      S('spread', 'Растекание', 1, 6, 0.5, 3, (v) => v.toFixed(1)),
      S('refresh', 'Обновление цвета', 0, 0.3, 0.01, 0.04, (v) => (v <= 0.001 ? 'нет' : pct(v * 3))),
    ],
    render(ctx) {
      const p = ctx.params;
      const raw = ctx.get('flowRaw', 'target');
      const flow = ctx.get('flow', 'pp');

      ctx.draw(ctx.P('flowRaw'), raw, {
        uHist: ctx.hist.tex,
        uHead: ctx.hist.head,
        uCount: ctx.hist.layers,
        uBack: 2,
        uTexel: ctx.texel,
      });
      ctx.draw(ctx.P('flowSmooth'), flow.write, {
        uSrc: raw.tex,
        uPrev: flow.read.tex,
        uTexel: ctx.texel,
        uRadius: p.spread,
        uMix: 1 - p.viscosity,
        uInit: ctx.reset ? 1 : 0,   // поле потока переживает смену стиля
      });
      flow.swap();

      // смена стиля тоже требует пересева: иначе датамош стартует с пустого холста
      const init = ctx.reset || ctx.mem.style !== p.style;
      ctx.mem.style = p.style;

      // датамош копит цвета сам в себе, остальным стилям хватает обычной сцены
      const target = p.style === 1 ? ctx.accum.write : ctx.scene;
      ctx.draw(ctx.P('liquidView'), target, {
        uHist: ctx.hist.tex,
        uHead: ctx.hist.head,
        uFlow: flow.read.tex,
        uPrevColor: ctx.accum.read.tex,
        uAmount: p.amount,
        uStyle: p.style,
        uRefresh: p.refresh,
        uInit: init ? 1 : 0,
      });
      if (p.style !== 1) return ctx.scene.tex;
      ctx.accum.swap();
      return ctx.accum.read.tex;
    },
  },
];

/**
 * Считает пульс по колебанию зелёного канала в центре кадра.
 * Сигнал сворачивается в один пиксель на GPU, дальше — автокорреляция на CPU.
 */
function measurePulse(ctx, fast, slow) {
  const m = ctx.mem;
  if (!m.pulse || ctx.reset) m.pulse = { buf: [], t: [], bpm: 0, last: 0 };
  const st = m.pulse;

  st.tick = (st.tick ?? 0) + 1;
  if (st.tick % 2) return;      // чтение пикселя синхронизирует GPU — хватит и половины кадров

  const probe = ctx.get('pulseProbe', 'target8', 1, 1);
  ctx.draw(ctx.P('pulseProbe'), probe, { uFast: fast.tex, uSlow: slow.tex, uScale: 60 });
  st.buf.push(ctx.readPixel(probe)[0] / 255 - 0.5);
  st.t.push(ctx.time);
  while (st.buf.length > 400) { st.buf.shift(); st.t.shift(); }

  const span = st.t[st.t.length - 1] - st.t[0];
  if (span < 6 || ctx.time - st.last < 1) return;
  st.last = ctx.time;

  const n = st.buf.length;
  const rate = (n - 1) / span;                       // кадров в секунду
  const mean = st.buf.reduce((a, b) => a + b, 0) / n;
  const x = st.buf.map((v) => v - mean);
  const norm = x.reduce((a, v) => a + v * v, 0);
  if (norm < 1e-6) return;

  // ищем период в диапазоне 40…180 ударов в минуту
  let best = 0;
  let bestLag = 0;
  for (let lag = Math.floor(rate * 60 / 180); lag <= Math.ceil(rate * 60 / 40) && lag < n - 4; lag++) {
    let sum = 0;
    for (let i = lag; i < n; i++) sum += x[i] * x[i - lag];
    const r = sum / norm;
    if (r > best) { best = r; bestLag = lag; }
  }
  st.bpm = bestLag && best > 0.28 ? Math.round((rate * 60) / bestLag) : 0;
  st.quality = best;
  ctx.say(st.bpm ? `Пульс ≈ ${st.bpm} уд/мин` : 'Пульс не читается — замри и добавь света', 1400);
}

export const STRIDE_PARAM = S('_stride', 'Темп времени', 1, 8, 1, 2, (v) => '1/' + v);

export function paramList(mode) {
  return mode.usesStride ? [...mode.params, STRIDE_PARAM] : mode.params;
}

export function defaults(mode) {
  const o = {};
  for (const p of paramList(mode)) o[p.key] = p.def;
  return o;
}

export const MODE_BY_ID = Object.fromEntries(MODES.map((m) => [m.id, m]));
