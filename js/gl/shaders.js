// Все фрагментные шейдеры. Каждый эффект работает с историей кадров
// (sampler2DArray) — это и есть «ось времени» приложения.

const HEAD = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUv;
out vec4 fragColor;

const float PI2 = 6.28318530718;
// Поле потока живёт со сдвигом в [0..1]: на устройствах без float-целей
// беззнаковая текстура иначе обрезала бы отрицательные скорости в ноль.
const float FLOW_RANGE = 0.05;
vec2 encodeFlow(vec2 f){ return clamp(f, -FLOW_RANGE, FLOW_RANGE) / FLOW_RANGE * 0.5 + 0.5; }
vec2 decodeFlow(vec2 e){ return (e - 0.5) * 2.0 * FLOW_RANGE; }

float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

const fs = (body) => HEAD + '\n' + body;

/**
 * Захват кадра камеры в историю: кадрирование под пропорции экрана,
 * зеркалирование и приведение к рабочему разрешению.
 */
export const INGEST = fs(`
uniform sampler2D uVideo;
uniform float uMirror;
uniform vec2 uCrop;
void main(){
  vec2 uv = (vUv - 0.5) * uCrop + 0.5;
  if (uMirror > 0.5) uv.x = 1.0 - uv.x;
  fragColor = vec4(texture(uVideo, uv).rgb, 1.0);
}`);

/** Медленно обновляемая модель фона (для «стробо» и «движения»). */
export const BG = fs(`
uniform sampler2DArray uHist;
uniform float uHead;
uniform sampler2D uPrev;
uniform float uRate;
uniform float uInit;
void main(){
  vec3 live = texture(uHist, vec3(vUv, uHead)).rgb;
  vec3 prev = texture(uPrev, vUv).rgb;
  fragColor = vec4(uInit > 0.5 ? live : mix(prev, live, uRate), 1.0);
}`);

/**
 * Слит-скан: координата поперёк кадра отображается в возраст кадра.
 * Столбец слева — «сейчас», справа — прошлое (или наоборот).
 */
export const SLITSCAN = fs(`
uniform sampler2DArray uHist;
uniform float uHead, uCount, uSpread, uAxis, uReverse, uSmooth;
void main(){
  float t = mix(vUv.x, vUv.y, uAxis);
  t = mix(t, 1.0 - t, uReverse);
  float f = uHead - t * uSpread;
  float b = floor(f);
  float fr = (f - b) * uSmooth;
  vec3 c0 = texture(uHist, vec3(vUv, mod(b, uCount))).rgb;
  vec3 c1 = texture(uHist, vec3(vUv, mod(b + 1.0, uCount))).rgb;
  fragColor = vec4(mix(c0, c1, fr), 1.0);
}`);

/**
 * Time-warp scan: бегущая линия «замораживает» уже пройденную часть кадра.
 * Всё, что за линией, остаётся живым.
 */
export const TIMEWARP = fs(`
uniform sampler2DArray uHist;
uniform float uHead, uAxis, uReverse, uPrevPos;
uniform sampler2D uPrev;
void main(){
  float c = mix(vUv.x, vUv.y, uAxis);
  c = mix(c, 1.0 - c, uReverse);
  vec3 live = texture(uHist, vec3(vUv, uHead)).rgb;
  vec3 prev = texture(uPrev, vUv).rgb;
  fragColor = vec4(c < uPrevPos ? prev : live, 1.0);
}`);

/**
 * Световая кисть / длинная выдержка.
 * 0 — «светлее» (следы света), 1 — усреднение (шёлковая вода), 2 — сложение.
 */
export const LIGHTPAINT = fs(`
uniform sampler2DArray uHist;
uniform float uHead, uMode, uDecay, uAmount, uInit;
uniform sampler2D uPrev;
void main(){
  vec3 live = texture(uHist, vec3(vUv, uHead)).rgb;
  vec3 prev = texture(uPrev, vUv).rgb;
  if (uInit > 0.5) { fragColor = vec4(live, 1.0); return; }
  vec3 outc;
  if (uMode < 0.5)      outc = max(prev * uDecay, live);
  else if (uMode < 1.5) outc = mix(prev, live, uAmount);
  else                  outc = prev * uDecay + live * uAmount;
  fragColor = vec4(outc, 1.0);
}`);

/** Стробо-хронофотография: «штампует» движущийся объект на статичный план. */
export const STROBE_STAMP = fs(`
uniform sampler2DArray uHist;
uniform float uHead, uThr, uSoft, uStamp, uInit;
uniform sampler2D uPrev, uBg;
void main(){
  vec3 live = texture(uHist, vec3(vUv, uHead)).rgb;
  vec3 prev = texture(uPrev, vUv).rgb;
  if (uInit > 0.5) { fragColor = vec4(live, 1.0); return; }
  if (uStamp < 0.5) { fragColor = vec4(prev, 1.0); return; }
  vec3 bg = texture(uBg, vUv).rgb;
  float d = length(live - bg);
  float m = smoothstep(uThr, uThr + uSoft, d);
  fragColor = vec4(mix(prev, live, m), 1.0);
}`);

/** Показ для «стробо»: накопленные отпечатки + живой силуэт сверху. */
export const STROBE_VIEW = fs(`
uniform sampler2DArray uHist;
uniform float uHead, uThr, uSoft, uLive;
uniform sampler2D uAccum, uBg;
void main(){
  vec3 live = texture(uHist, vec3(vUv, uHead)).rgb;
  vec3 acc  = texture(uAccum, vUv).rgb;
  vec3 bg   = texture(uBg, vUv).rgb;
  float m = smoothstep(uThr, uThr + uSoft, length(live - bg)) * uLive;
  fragColor = vec4(mix(acc, live, m), 1.0);
}`);

/**
 * Эхо: несколько копий из прошлого поверх настоящего.
 * Стили: 0 — призраки, 1 — смаз, 2 — радужный шлейф, 3 — RGB-сдвиг во времени.
 */
export const ECHO = fs(`
uniform sampler2DArray uHist;
uniform float uHead, uCount, uStep, uCopies, uFalloff, uStyle;
vec3 at(float back){ return texture(uHist, vec3(vUv, mod(uHead - back, uCount))).rgb; }
void main(){
  vec3 base = at(0.0);
  if (uStyle > 2.5) {
    fragColor = vec4(at(uStep).r, at(uStep * 2.0).g, at(uStep * 3.0).b, 1.0);
    return;
  }
  vec3 acc = base;
  for (int i = 1; i < 9; i++) {
    if (float(i) > uCopies) break;
    vec3 c = at(float(i) * uStep);
    float w = pow(uFalloff, float(i));
    if (uStyle < 0.5)      acc = max(acc, c * w);
    else if (uStyle < 1.5) acc = mix(acc, c, w * 0.55);
    else {
      vec3 tint = 0.5 + 0.5 * cos(PI2 * (float(i) / max(uCopies, 1.0)) + vec3(0.0, 2.1, 4.2));
      acc = max(acc, c * w * tint);
    }
  }
  fragColor = vec4(acc, 1.0);
}`);

/** Накопление карты активности для стиля «тепло». */
export const MOTION_HEAT = fs(`
uniform sampler2DArray uHist;
uniform float uHead, uThr, uSoft, uDecay, uInit;
uniform sampler2D uPrev, uBg;
void main(){
  if (uInit > 0.5) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec3 live = texture(uHist, vec3(vUv, uHead)).rgb;
  vec3 bg = texture(uBg, vUv).rgb;
  float m = smoothstep(uThr, uThr + uSoft, length(live - bg));
  float prev = texture(uPrev, vUv).r;
  fragColor = vec4(vec3(max(prev * uDecay, m)), 1.0);
}`);

/**
 * Выделение движения: показываем только то, что изменилось относительно фона.
 * Стили: 0 — вырез на чёрном, 1 — вырез на приглушённом фоне, 2 — усиление разницы, 3 — тепловая карта.
 */
export const MOTION_VIEW = fs(`
uniform sampler2DArray uHist;
uniform float uHead, uThr, uSoft, uStyle, uBoost;
uniform sampler2D uBg, uHeat;
vec3 heatmap(float t){
  t = clamp(t, 0.0, 1.0);
  return clamp(vec3(1.5 * t - 0.15, 1.6 * t * t - 0.25, 3.0 * t * t * t - 0.35), 0.0, 1.0)
       + vec3(0.0, 0.0, 0.35 * smoothstep(0.0, 0.35, t) * (1.0 - t));
}
void main(){
  vec3 live = texture(uHist, vec3(vUv, uHead)).rgb;
  vec3 bg = texture(uBg, vUv).rgb;
  float d = length(live - bg);
  float m = smoothstep(uThr, uThr + uSoft, d);
  vec3 outc;
  if (uStyle < 0.5)      outc = live * m;
  else if (uStyle < 1.5) outc = mix(bg * 0.22, live, m);
  else if (uStyle < 2.5) outc = clamp(bg + (live - bg) * uBoost, 0.0, 1.0);
  else {
    float h = texture(uHeat, vUv).r;
    outc = mix(vec3(luma(bg) * 0.28), heatmap(h), smoothstep(0.02, 0.25, h));
  }
  fragColor = vec4(outc, 1.0);
}`);

/**
 * Ночное видение, проход 1: складываем несколько последних кадров
 * (реальное накопление света, как в ночных приборах) и мягко усиливаем.
 */
export const NV_STACK = fs(`
uniform sampler2DArray uHist;
uniform float uHead, uCount, uStack, uGain;
void main(){
  vec3 acc = vec3(0.0);
  float n = 0.0;
  for (int i = 0; i < 16; i++) {
    if (float(i) >= uStack) break;
    acc += texture(uHist, vec3(vUv, mod(uHead - float(i), uCount))).rgb;
    n += 1.0;
  }
  acc /= max(n, 1.0);
  // мягкое усиление: тени тянутся вверх, света не выгорают
  fragColor = vec4(1.0 - exp(-acc * uGain), 1.0);
}`);

/** Ночное видение, проход 2: люминофор, шум фотонов, свечение огней, окуляры. */
export const NV_VIEW = fs(`
uniform sampler2D uSrc;
uniform float uPhosphor, uNoise, uMask, uBloom, uTime, uAspect;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  float l = luma(texture(uSrc, vUv).rgb);

  // ореолы вокруг ярких источников света
  if (uBloom > 0.001) {
    float b = 0.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7854;
      vec2 off = vec2(cos(a) / uAspect, sin(a)) * 0.012;
      b += max(0.0, luma(texture(uSrc, vUv + off).rgb) - 0.55);
    }
    l += b * 0.125 * uBloom * 1.6;
  }

  // шум фотонов: сильнее в темноте, мерцает каждый кадр
  vec2 seed = vUv * vec2(917.0, 533.0) + fract(uTime * 7.31) * 61.7;
  l += (hash(seed) - 0.5) * uNoise * (1.15 - l);
  // редкие «искры» усилителя
  l += step(0.9985, hash(seed + 47.1)) * (1.0 - l) * uNoise * 2.5;
  l = clamp(l, 0.0, 1.0);

  // люминофор: зелёный P43, белый или янтарный
  vec3 c;
  if (uPhosphor < 0.5)      c = vec3(0.10, 1.00, 0.28) * l;
  else if (uPhosphor < 1.5) c = vec3(0.86, 1.00, 0.94) * l;
  else                      c = vec3(1.00, 0.72, 0.22) * l;
  c = mix(c, vec3(l), smoothstep(0.72, 1.0, l) * 0.6); // яркое выцветает в белый

  // маска окуляров (координаты нормированы по ширине кадра)
  if (uMask > 0.5) {
    vec2 p = (vUv - 0.5) * vec2(1.0, 1.0 / uAspect);
    float m;
    if (uMask < 1.5) {
      float r = 0.47 * min(1.0, 1.0 / uAspect);
      m = 1.0 - smoothstep(r - 0.04, r, length(p));
    } else {
      float r = 0.19;
      float m1 = 1.0 - smoothstep(r - 0.035, r, length(p - vec2(0.145, 0.0)));
      float m2 = 1.0 - smoothstep(r - 0.035, r, length(p + vec2(0.145, 0.0)));
      m = max(m1, m2);
    }
    c *= mix(0.02, 1.0, m);
  }
  fragColor = vec4(c, 1.0);
}`);

// ---------- Микроскоп движения ----------
// Метод Эйлера: два временных фильтра нижних частот с разными постоянными,
// их разница — полоса частот, которую и усиливаем. Так видно пульс и вибрацию.

/** Размытие живого кадра: без него усиление вытащит наружу шум сенсора. */
export const BLUR_HIST = fs(`
uniform sampler2DArray uHist;
uniform float uHead;
uniform vec2 uTexel;
uniform float uRadius;
void main(){
  vec3 c = vec3(0.0);
  float wsum = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      float w = exp(-float(x * x + y * y) * 0.35);
      c += texture(uHist, vec3(vUv + vec2(float(x), float(y)) * uTexel * uRadius, uHead)).rgb * w;
      wsum += w;
    }
  }
  fragColor = vec4(c / wsum, 1.0);
}`);

/** Один фильтр нижних частот: lo = lo + a * (src - lo). */
export const IIR = fs(`
uniform sampler2D uSrc, uPrev;
uniform float uAlpha, uInit;
void main(){
  vec3 s = texture(uSrc, vUv).rgb;
  vec3 p = texture(uPrev, vUv).rgb;
  fragColor = vec4(uInit > 0.5 ? s : mix(p, s, uAlpha), 1.0);
}`);

export const MAGNIFY_VIEW = fs(`
uniform sampler2DArray uHist;
uniform float uHead;
uniform sampler2D uFast, uSlow;
uniform float uGain, uStyle;
void main(){
  vec3 live = texture(uHist, vec3(vUv, uHead)).rgb;
  vec3 amp = (texture(uFast, vUv).rgb - texture(uSlow, vUv).rgb) * uGain;
  vec3 outc;
  if (uStyle < 0.5) {
    outc = live + amp;
  } else if (uStyle < 1.5) {
    outc = vec3(0.5) + amp;
  } else {
    float m = clamp(length(amp) * 1.4, 0.0, 1.0);
    outc = mix(vec3(luma(live) * 0.3), vec3(1.0, 0.42, 0.12), m)
         + vec3(0.0, 0.1, 0.45) * m * (1.0 - m);
  }
  fragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}`);

/** Свёртка сигнала центра кадра в один пиксель — его читает измеритель пульса. */
export const PULSE_PROBE = fs(`
uniform sampler2D uFast, uSlow;
uniform float uScale;
void main(){
  float s = 0.0;
  for (int y = 0; y < 8; y++) {
    for (int x = 0; x < 8; x++) {
      vec2 uv = vec2(0.32 + float(x) * 0.36 / 7.0, 0.30 + float(y) * 0.40 / 7.0);
      s += texture(uFast, uv).g - texture(uSlow, uv).g;
    }
  }
  fragColor = vec4(clamp(0.5 + (s / 64.0) * uScale, 0.0, 1.0), 0.0, 0.0, 1.0);
}`);

// ---------- Фотофиниш ----------

/** Пишет одну колонку ленты; рисуется в узкий вьюпорт. */
export const STRIP_WRITE = fs(`
uniform sampler2DArray uHist;
uniform float uHead, uPos, uSlit;
void main(){
  vec2 src = vec2(uPos + (vUv.x - 0.5) * uSlit, vUv.y);
  fragColor = vec4(texture(uHist, vec3(clamp(src, 0.0, 1.0), uHead)).rgb, 1.0);
}`);

/**
 * Показывает последние колонки ленты — окно, которое едет вслед за записью.
 * В углу врезка с живым кадром и меткой щели: без неё непонятно, куда целиться.
 */
export const STRIP_VIEW = fs(`
uniform sampler2D uStrip;
uniform sampler2DArray uHist;
uniform float uWrote, uWindow, uTotal, uHead, uPos, uInset;
void main(){
  float x = uWrote - uWindow + vUv.x * uWindow;
  vec3 c = x < 0.0 ? vec3(0.04) : texture(uStrip, vec2(min(x, uWrote) / uTotal, vUv.y)).rgb;

  if (uInset > 0.001) {
    // равные доли uv по обеим осям сохраняют пропорции кадра
    vec2 q = (vUv - vec2(1.0 - uInset - 0.03)) / uInset;
    if (q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0) {
      vec3 live = texture(uHist, vec3(q, uHead)).rgb;
      live = mix(live, vec3(0.45, 0.95, 1.0), smoothstep(0.014, 0.0, abs(q.x - uPos)));
      float edge = min(min(q.x, 1.0 - q.x), min(q.y, 1.0 - q.y));
      c = mix(vec3(0.45, 0.95, 1.0), live, smoothstep(0.0, 0.012, edge));
    }
  }
  fragColor = vec4(c, 1.0);
}`);

// ---------- Оптический поток: жидкая реальность и датамош ----------

/**
 * Нормальный поток из уравнения переноса яркости: Ix*u + Iy*v + It = 0.
 * Точности хватает с запасом — поле идёт не в измерения, а в искажение картинки.
 */
export const FLOW_RAW = fs(`
uniform sampler2DArray uHist;
uniform float uHead, uCount, uBack;
uniform vec2 uTexel;
float at(vec2 uv, float back){
  return luma(texture(uHist, vec3(uv, mod(uHead - back, uCount))).rgb);
}
void main(){
  float ix = (at(vUv + vec2(uTexel.x, 0.0), 0.0) - at(vUv - vec2(uTexel.x, 0.0), 0.0)) * 0.5;
  float iy = (at(vUv + vec2(0.0, uTexel.y), 0.0) - at(vUv - vec2(0.0, uTexel.y), 0.0)) * 0.5;
  float it = at(vUv, 0.0) - at(vUv, uBack);
  vec2 f = -it * vec2(ix, iy) / (ix * ix + iy * iy + 0.0015);
  fragColor = vec4(encodeFlow(f), 0.0, 1.0);
}`);

/** Размазывает поле потока по пространству и сглаживает во времени. */
export const FLOW_SMOOTH = fs(`
uniform sampler2D uSrc, uPrev;
uniform vec2 uTexel;
uniform float uRadius, uMix, uInit;
void main(){
  vec2 acc = vec2(0.0);
  float wsum = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      float w = exp(-float(x * x + y * y) * 0.3);
      acc += texture(uSrc, vUv + vec2(float(x), float(y)) * uTexel * uRadius).rg * w;
      wsum += w;
    }
  }
  // кодирование линейно, поэтому усреднять и смешивать можно прямо в нём
  vec2 f = acc / wsum;
  vec2 p = texture(uPrev, vUv).rg;
  fragColor = vec4(uInit > 0.5 ? f : mix(p, f, uMix), 0.0, 1.0);
}`);

export const LIQUID_VIEW = fs(`
uniform sampler2DArray uHist;
uniform float uHead;
uniform sampler2D uFlow, uPrevColor;
uniform float uAmount, uStyle, uRefresh, uInit;
void main(){
  vec2 f = decodeFlow(texture(uFlow, vUv).rg);
  vec3 outc;
  if (uStyle < 0.5) {
    outc = texture(uHist, vec3(clamp(vUv + f * uAmount, 0.0, 1.0), uHead)).rgb;
  } else if (uStyle < 1.5) {
    vec3 live = texture(uHist, vec3(vUv, uHead)).rgb;
    vec3 adv = texture(uPrevColor, clamp(vUv - f * uAmount, 0.0, 1.0)).rgb;
    outc = uInit > 0.5 ? live : mix(adv, live, uRefresh);
  } else {
    float m = clamp(length(f) * 90.0, 0.0, 1.0);
    outc = (0.5 + 0.5 * cos(atan(f.y, f.x) + vec3(0.0, 2.1, 4.2))) * m;
  }
  fragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}`);

/** Финальный вывод: тон, виньетка, зерно и линия сканирования. */
export const PRESENT = fs(`
uniform sampler2D uScene;
uniform float uContrast, uSaturation, uVignette, uGrain, uTime;
uniform float uLineOn, uLinePos, uLineAxis;
void main(){
  vec3 c = texture(uScene, vUv).rgb;

  c = (c - 0.5) * uContrast + 0.5;
  c = mix(vec3(luma(c)), c, uSaturation);

  vec2 d = vUv - 0.5;
  c *= 1.0 - uVignette * dot(d, d) * 1.9;

  if (uGrain > 0.001) {
    float n = fract(sin(dot(vUv * vec2(1234.5, 987.6) + uTime, vec2(12.9898, 78.233))) * 43758.5453);
    c += (n - 0.5) * uGrain;
  }

  if (uLineOn > 0.5) {
    float p = mix(vUv.x, vUv.y, uLineAxis);
    float g = smoothstep(0.012, 0.0, abs(p - uLinePos));
    c = mix(c, vec3(0.45, 0.95, 1.0), g * 0.85);
  }

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`);
