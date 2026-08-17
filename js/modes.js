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
      SEG('mask', 'Окуляры', [
        { v: 0, label: 'Нет' },
        { v: 1, label: 'Один' },
        { v: 2, label: 'Два' },
      ], 2),
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
        uMask: p.mask,
        uBloom: p.bloom,
        uTime: ctx.time,
        uAspect: ctx.w / ctx.h,
      });
      return ctx.scene.tex;
    },
  },
];

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
