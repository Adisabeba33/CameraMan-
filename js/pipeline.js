// Конвейер рендеринга: видео → история кадров → режим → вывод на канвас.

import { createGL, createProgram, createQuad, Target, PingPong, History } from './gl/glcore.js';
import * as SH from './gl/shaders.js';
import { MODE_BY_ID, defaults } from './modes.js';

const PROGRAM_SRC = {
  ingest: SH.INGEST,
  bg: SH.BG,
  slitscan: SH.SLITSCAN,
  timewarp: SH.TIMEWARP,
  lightpaint: SH.LIGHTPAINT,
  strobeStamp: SH.STROBE_STAMP,
  strobeView: SH.STROBE_VIEW,
  echo: SH.ECHO,
  motionHeat: SH.MOTION_HEAT,
  motionView: SH.MOTION_VIEW,
  nvStack: SH.NV_STACK,
  nvView: SH.NV_VIEW,
  blurHist: SH.BLUR_HIST,
  iir: SH.IIR,
  magnifyView: SH.MAGNIFY_VIEW,
  pulseProbe: SH.PULSE_PROBE,
  stripWrite: SH.STRIP_WRITE,
  stripView: SH.STRIP_VIEW,
  flowRaw: SH.FLOW_RAW,
  flowSmooth: SH.FLOW_SMOOTH,
  liquidView: SH.LIQUID_VIEW,
  present: SH.PRESENT,
};

export const QUALITY = {
  low: { cap: 640, layers: 24, label: 'Экономный (640p, 24 кадра истории)' },
  medium: { cap: 960, layers: 36, label: 'Обычный (960p, 36 кадров истории)' },
  high: { cap: 1280, layers: 48, label: 'Максимум (1280p, 48 кадров истории)' },
};

export class Pipeline {
  constructor(canvas, video) {
    this.canvas = canvas;
    this.video = video;
    this.gl = createGL(canvas);
    this.quad = createQuad(this.gl);
    this.programs = new Map();

    this.w = 0; this.h = 0;
    this.hist = null;
    this.scene = null;
    this.accum = null;
    this.bg = null;
    this.aux = null;
    this.extra = new Map();   // буферы, которые нужны лишь отдельным режимам

    this.fit = 'cover';
    this.dispW = 0;
    this.dispH = 0;
    this.crop = [1, 1];

    this.modeId = 'slitscan';
    this.params = {};
    this.mirror = true;
    this.quality = 'medium';
    this.grade = { contrast: 1, saturation: 1, vignette: 0.22, grain: 0.02 };

    this.mem = {};
    this.pendingReset = true;
    this.time = 0;
    this.last = 0;
    this.strideCounter = 0;
    this.newFrame = false;
    this.lastCtx = null;
    this.lastTex = null;
    this.onHint = () => {};

    this.videoTex = this.gl.createTexture();
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  }

  get mode() { return MODE_BY_ID[this.modeId]; }

  P(name) {
    let p = this.programs.get(name);
    if (!p) {
      p = createProgram(this.gl, PROGRAM_SRC[name]);
      this.programs.set(name, p);
    }
    return p;
  }

  /** Размер области показа — от него зависят пропорции кадра в режиме «во весь экран». */
  setDisplaySize(w, h) {
    this.dispW = w;
    this.dispH = h;
  }

  /**
   * Подгоняет буферы под источник, качество и пропорции экрана.
   * В режиме «cover» рабочий кадр получает пропорции экрана, а лишнее
   * обрезается ещё при захвате — что видно на экране, то и попадёт в снимок.
   */
  ensureTargets(vw, vh) {
    const { cap, layers } = QUALITY[this.quality];
    const va = vw / vh;
    const cover = this.fit === 'cover' && this.dispW > 0 && this.dispH > 0;
    const ta = cover ? this.dispW / this.dispH : va;

    // обрезка по короткой стороне, без растягивания картинки
    this.crop = va > ta ? [ta / va, 1] : [1, va / ta];

    const side = Math.min(cap, Math.max(vw, vh));
    const w = Math.max(2, Math.round((ta >= 1 ? side : side * ta) / 2) * 2);
    const h = Math.max(2, Math.round((ta >= 1 ? side / ta : side) / 2) * 2);
    if (w === this.w && h === this.h && this.hist && this.hist.layers === layers) return;

    this.dispose();
    const gl = this.gl;
    this.w = w; this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.hist = new History(gl, w, h, layers);
    this.scene = new Target(gl, w, h, false);
    this.accum = new PingPong(gl, w, h, true);
    this.bg = new PingPong(gl, w, h, false);
    this.aux = new PingPong(gl, w, h, false);
    this.pendingReset = true;
  }

  /**
   * Буфер по требованию: тяжёлые цели вроде ленты фотофиниша или поля потока
   * создаются только тогда, когда режим их действительно просит.
   */
  getTarget(name, kind, w = this.w, h = this.h) {
    const key = `${kind}:${w}x${h}`;
    const cached = this.extra.get(name);
    if (cached && cached.key === key) return cached.obj;
    cached?.obj.dispose();
    const gl = this.gl;
    const obj = kind === 'pp' ? new PingPong(gl, w, h, true)
      : kind === 'pp8' ? new PingPong(gl, w, h, false)
      : kind === 'target8' ? new Target(gl, w, h, false)
      : new Target(gl, w, h, true);
    // чистим сразу: сброс режима здесь недопустим — он стёр бы уже накопленное
    for (const t of obj instanceof PingPong ? [obj.a, obj.b] : [obj]) this.clearTarget(t);
    this.extra.set(name, { key, obj });
    return obj;
  }

  clearTarget(t) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  dispose() {
    for (const t of [this.hist, this.scene, this.accum, this.bg, this.aux]) t?.dispose();
    for (const { obj } of this.extra.values()) obj.dispose();
    this.extra.clear();
    this.hist = this.scene = this.accum = this.bg = this.aux = null;
  }

  setMode(id) {
    if (!MODE_BY_ID[id]) return;
    this.modeId = id;
    this.mem = {};
    this.pendingReset = true;
  }

  reset() {
    this.mem = {};
    this.pendingReset = true;
  }

  /** Один рисунок: программа + цель + униформы. target === null → канвас. */
  draw(prog, target, uniforms, vp = null) {
    const gl = this.gl;
    if (target === null) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.w, target.h);
    }
    if (vp) gl.viewport(vp[0], vp[1], vp[2], vp[3]);
    prog.use();
    for (const k in uniforms) prog.set(k, uniforms[k]);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Кладёт текущий кадр камеры в указанный слой истории. */
  ingestTo(layer) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.hist.layerFbo(layer));
    gl.viewport(0, 0, this.w, this.h);
    const prog = this.P('ingest');
    prog.use();
    prog.set('uVideo', this.videoTex);
    prog.set('uMirror', this.mirror ? 1 : 0);
    prog.set('uCrop', this.crop);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Один пиксель из цели — для замеров на стороне JS. Вызывать не чаще, чем нужно. */
  readPixel(target, x = 0, y = 0) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    const px = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  }

  uploadVideo() {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
  }

  frame(nowMs) {
    const v = this.video;
    if (!v.videoWidth || !v.videoHeight) return;
    this.ensureTargets(v.videoWidth, v.videoHeight);

    const now = nowMs / 1000;
    this.dt = this.last ? Math.min(0.1, now - this.last) : 1 / 60;
    this.last = now;
    this.time = now;

    const mode = this.mode;
    const params = this.params;
    const reset = this.pendingReset;

    // 1. Загрузка кадра камеры и запись в историю
    const fresh = reset || this.newFrame;
    this.uploadVideo();
    if (reset) {
      for (let i = 0; i < this.hist.layers; i++) this.ingestTo(i);
      this.hist.head = 0;
      this.strideCounter = 0;
    } else if (this.newFrame) {
      const stride = mode.usesStride ? Math.max(1, params._stride | 0) : 1;
      if (++this.strideCounter >= stride) {
        this.strideCounter = 0;
        this.hist.advance();
      }
      this.ingestTo(this.hist.head);
    }
    this.newFrame = false;

    // 2. Модель фона (для «стробо» и «только движение»)
    if (mode.bg) {
      const frozen = params.freeze === 1;
      const rate = frozen ? 0 : Math.min(1, (mode.bgRate ?? 0.02) * this.dt * 60);
      this.draw(this.P('bg'), this.bg.write, {
        uHist: this.hist.tex,
        uHead: this.hist.head,
        uPrev: this.bg.read.tex,
        uRate: rate,
        uInit: reset ? 1 : 0,
      });
      this.bg.swap();
    }

    // 3. Собственно эффект
    const ctx = {
      w: this.w, h: this.h,
      texel: [1 / this.w, 1 / this.h],
      hist: this.hist,
      scene: this.scene,
      accum: this.accum,
      bg: this.bg,
      aux: this.aux,
      params,
      mem: this.mem,
      dt: this.dt,
      time: this.time,
      reset,
      fresh,   // пришёл ли новый кадр камеры именно сейчас
      line: null,
      P: (n) => this.P(n),
      draw: (p, t, u, vp) => this.draw(p, t, u, vp),
      get: (n, kind, w, h) => this.getTarget(n, kind, w, h),
      readPixel: (t, x, y) => this.readPixel(t, x, y),
      say: (m) => this.onHint(m),
    };
    const tex = mode.render(ctx) || this.scene.tex;
    this.pendingReset = false;
    this.lastCtx = ctx;
    this.lastTex = tex;

    // 4. Вывод на экран
    this.present(tex, ctx.line);
  }

  /** Финальный проход: тон, виньетка, зерно и линия сканирования. */
  present(tex, line) {
    const g = this.grade;
    this.draw(this.P('present'), null, {
      uScene: tex,
      uContrast: g.contrast,
      uSaturation: g.saturation,
      uVignette: g.vignette,
      uGrain: g.grain,
      uTime: this.time % 100,
      uLineOn: line ? line.on : 0,
      uLinePos: line ? line.pos : 0,
      uLineAxis: line ? line.axis : 0,
    });
  }

  /**
   * Снимок для сохранения. Обычно это то, что на экране, но режим может отдать
   * собственное изображение другого размера — так фотофиниш выгружает всю ленту,
   * которая в экран не помещается.
   */
  snapshot() {
    const out = document.createElement('canvas');
    const ex = this.lastCtx && this.mode.exportFrame?.(this.lastCtx);
    if (ex && ex.w > 0 && ex.h > 0) {
      const prevW = this.canvas.width;
      const prevH = this.canvas.height;
      this.canvas.width = ex.w;
      this.canvas.height = ex.h;
      this.present(ex.tex, null);
      out.width = ex.w;
      out.height = ex.h;
      out.getContext('2d').drawImage(this.canvas, 0, 0);
      this.canvas.width = prevW;
      this.canvas.height = prevH;
      this.present(this.lastTex, this.lastCtx.line);   // вернуть экран как было
    } else {
      out.width = this.canvas.width;
      out.height = this.canvas.height;
      out.getContext('2d').drawImage(this.canvas, 0, 0);
    }
    return out;
  }
}

export { defaults };
