// Минимальный слой над WebGL2: программы с авто-униформами, рендер-таргеты,
// пинг-понг и массив текстур для истории кадров.

export function createGL(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true, // нужно для toBlob() при съёмке
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('WebGL2 не поддерживается этим браузером');
  gl.floatOK = !!gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('OES_texture_float_linear');
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  return gl;
}

const VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Ошибка компиляции шейдера:\n' + log + '\n' + src);
  }
  return sh;
}

export function createProgram(gl, fsSrc) {
  const p = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, VS);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('Ошибка линковки программы: ' + gl.getProgramInfoLog(p));
  }

  const uniforms = new Map();
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    uniforms.set(name, { loc: gl.getUniformLocation(p, name), type: info.type });
  }

  let unit = 0;
  return {
    program: p,
    use() {
      gl.useProgram(p);
      unit = 0;
    },
    set(name, value) {
      const u = uniforms.get(name);
      if (!u) return; // униформ вырезан оптимизатором — молча пропускаем
      switch (u.type) {
        case gl.SAMPLER_2D:
        case gl.SAMPLER_2D_ARRAY: {
          const target = u.type === gl.SAMPLER_2D ? gl.TEXTURE_2D : gl.TEXTURE_2D_ARRAY;
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(target, value);
          gl.uniform1i(u.loc, unit);
          unit++;
          break;
        }
        case gl.FLOAT: gl.uniform1f(u.loc, value); break;
        case gl.INT: case gl.BOOL: gl.uniform1i(u.loc, value | 0); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, value); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, value); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, value); break;
        default: break;
      }
    },
  };
}

export function createQuad(gl) {
  const vao = gl.createVertexArray();
  const buf = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

function makeTex(gl, w, h, float) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  const useFloat = float && gl.floatOK;
  gl.texImage2D(
    gl.TEXTURE_2D, 0,
    useFloat ? gl.RGBA16F : gl.RGBA8,
    w, h, 0, gl.RGBA,
    useFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
    null
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/** Одна цветная цель рендеринга. */
export class Target {
  constructor(gl, w, h, float = false) {
    this.gl = gl; this.w = w; this.h = h; this.float = float;
    this.tex = makeTex(gl, w, h, float);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  dispose() {
    this.gl.deleteTexture(this.tex);
    this.gl.deleteFramebuffer(this.fbo);
  }
}

/** Пара целей для накопительных эффектов (читаем прошлый кадр, пишем новый). */
export class PingPong {
  constructor(gl, w, h, float = false) {
    this.a = new Target(gl, w, h, float);
    this.b = new Target(gl, w, h, float);
  }
  get read() { return this.a; }
  get write() { return this.b; }
  swap() { const t = this.a; this.a = this.b; this.b = t; }
  dispose() { this.a.dispose(); this.b.dispose(); }
}

/** Кольцевой буфер кадров как TEXTURE_2D_ARRAY — сердце всех временных эффектов. */
export class History {
  constructor(gl, w, h, layers) {
    this.gl = gl; this.w = w; this.h = h; this.layers = layers; this.head = 0;
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, w, h, layers, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fbo = gl.createFramebuffer();
  }
  /** Возвращает FBO, привязанный к указанному слою. */
  layerFbo(layer) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.tex, 0, layer);
    return this.fbo;
  }
  advance() { this.head = (this.head + 1) % this.layers; }
  dispose() {
    this.gl.deleteTexture(this.tex);
    this.gl.deleteFramebuffer(this.fbo);
  }
}
