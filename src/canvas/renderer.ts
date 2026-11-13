// WebGL2 renderer. Every box, image, placeholder and dot is one instance of a
// unit quad, so a board of thousands of images is a handful of draw calls:
// small thumbnails come from one texture array (the atlas) and share a call;
// only images big on screen bind their own texture.

export interface Camera {
  /** World coordinate at the top-left of the view. */
  x: number;
  y: number;
  zoom: number;
}

export const MODE_SOLID = 0;
export const MODE_ATLAS = 1;
export const MODE_SINGLE = 2;
export const MODE_DOT = 3;

const STRIDE = 17; // floats per instance

const VS = `#version 300 es
layout(location=0) in vec2 corner;
layout(location=1) in vec4 rect;      // center xy, half size wh
layout(location=2) in vec3 xf;        // rotation (rad), flip x, flip y
layout(location=3) in vec4 uv;        // u0 v0 u1 v1
layout(location=4) in vec2 kind;      // atlas layer, mode
layout(location=5) in vec4 color;
layout(location=6) in float radius;
uniform vec2 uView;   // viewport size in css px
uniform vec3 uCam;    // cam x, y, zoom
out vec2 vUv;
out vec2 vLocal;
out vec2 vHalf;
flat out float vLayer;
flat out float vMode;
out vec4 vColor;
flat out float vRadius;
void main() {
  vec2 local = corner * rect.zw;
  float c = cos(xf.x), s = sin(xf.x);
  vec2 world = rect.xy + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 screen = (world - uCam.xy) * uCam.z;
  gl_Position = vec4(screen / uView * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
  vec2 t = (corner * vec2(xf.y, xf.z) + 1.0) * 0.5;
  vUv = mix(uv.xy, uv.zw, t);
  vLocal = local;
  vHalf = rect.zw;
  vLayer = kind.x;
  vMode = kind.y;
  vColor = color;
  vRadius = radius;
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uAtlas;
uniform sampler2D uSingle;
in vec2 vUv;
in vec2 vLocal;
in vec2 vHalf;
flat in float vLayer;
flat in float vMode;
in vec4 vColor;
flat in float vRadius;
out vec4 outColor;
float roundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  if (vMode > 2.5) {
    float d = length(vLocal) - vHalf.x;
    float aa = fwidth(d);
    outColor = vec4(vColor.rgb, vColor.a * (1.0 - smoothstep(-aa, aa, d)));
    return;
  }
  vec4 c;
  if (vMode < 0.5) c = vColor;
  else if (vMode < 1.5) c = texture(uAtlas, vec3(vUv, vLayer)) * vec4(1.0, 1.0, 1.0, vColor.a);
  else c = texture(uSingle, vUv) * vec4(1.0, 1.0, 1.0, vColor.a);
  if (vRadius > 0.0) {
    float d = roundBox(vLocal, vHalf, vRadius);
    float aa = fwidth(d);
    c.a *= 1.0 - smoothstep(-aa, aa, d);
  }
  outColor = vec4(c.rgb * c.a, c.a);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader");
  return sh;
}

export type RGBA = [number, number, number, number];

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private instanceBuf: WebGLBuffer;
  private data = new Float32Array(STRIDE * 4096);
  private count = 0;
  private runs: { start: number; tex: WebGLTexture | null }[] = [];
  private uView: WebGLUniformLocation;
  private uCam: WebGLUniformLocation;
  private emptyTex: WebGLTexture;
  atlasTex: WebGLTexture | null = null;
  width = 1;
  height = 1;
  dpr = 1;
  drawCalls = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: true, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    this.program = p;
    this.uView = gl.getUniformLocation(p, "uView")!;
    this.uCam = gl.getUniformLocation(p, "uCam")!;
    gl.useProgram(p);
    gl.uniform1i(gl.getUniformLocation(p, "uAtlas"), 0);
    gl.uniform1i(gl.getUniformLocation(p, "uSingle"), 1);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instanceBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    const attrs: [number, number, number][] = [
      [1, 4, 0], [2, 3, 4], [3, 4, 7], [4, 2, 11], [5, 4, 13], [6, 1, 17 - 1]
    ];
    // radius sits at float 16 (after color 13..16)
    attrs[5] = [6, 1, 16];
    for (const [loc, size, offset] of attrs) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, offset * 4);
      gl.vertexAttribDivisor(loc, 1);
    }
    this.emptyTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  resize(cssW: number, cssH: number, dpr: number) {
    this.width = cssW;
    this.height = cssH;
    this.dpr = dpr;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  begin() {
    this.count = 0;
    this.runs = [];
  }

  /** Queue one quad. `tex` is only used for MODE_SINGLE. */
  push(
    cx: number, cy: number, hw: number, hh: number, rot: number, fx: boolean, fy: boolean,
    uv: [number, number, number, number] | null, layer: number, mode: number, color: RGBA, radius: number,
    tex: WebGLTexture | null = null
  ) {
    if ((this.count + 1) * STRIDE > this.data.length) {
      const bigger = new Float32Array(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    const runTex = mode === MODE_SINGLE ? tex : null;
    const last = this.runs[this.runs.length - 1];
    if (!last || last.tex !== runTex) this.runs.push({ start: this.count, tex: runTex });
    const d = this.data;
    let o = this.count * STRIDE;
    d[o++] = cx; d[o++] = cy; d[o++] = hw; d[o++] = hh;
    d[o++] = rot; d[o++] = fx ? -1 : 1; d[o++] = fy ? -1 : 1;
    if (uv) { d[o++] = uv[0]; d[o++] = uv[1]; d[o++] = uv[2]; d[o++] = uv[3]; }
    else { d[o++] = 0; d[o++] = 0; d[o++] = 1; d[o++] = 1; }
    d[o++] = layer; d[o++] = mode;
    d[o++] = color[0]; d[o++] = color[1]; d[o++] = color[2]; d[o++] = color[3];
    d[o++] = radius;
    this.count += 1;
  }

  flush(cam: Camera, bg: RGBA) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform2f(this.uView, this.width, this.height);
    gl.uniform3f(this.uCam, cam.x, cam.y, cam.zoom);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, this.count * STRIDE), gl.STREAM_DRAW);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasTex);
    this.drawCalls = 0;
    this.runs.forEach((run, i) => {
      const end = i + 1 < this.runs.length ? this.runs[i + 1].start : this.count;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, run.tex ?? this.emptyTex);
      // Instanced draw starting at `run.start`: rebind the attribute offsets.
      this.bindOffset(run.start);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, end - run.start);
      this.drawCalls += 1;
    });
  }

  private bindOffset(start: number) {
    const gl = this.gl;
    const base = start * STRIDE * 4;
    const layout: [number, number, number][] = [[1, 4, 0], [2, 3, 4], [3, 4, 7], [4, 2, 11], [5, 4, 13], [6, 1, 16]];
    for (const [loc, size, offset] of layout) {
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, base + offset * 4);
    }
  }
}

export function parseColor(css: string, alpha = 1): RGBA {
  const s = css.trim();
  if (s.startsWith("#")) {
    const hex = s.length === 4 ? s.slice(1).split("").map((c) => c + c).join("") : s.slice(1, 7);
    const n = parseInt(hex, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b, a] = m[1].split(",").map((v) => parseFloat(v));
    return [r / 255, g / 255, b / 255, (a ?? 1) * alpha];
  }
  return [0.5, 0.5, 0.5, alpha];
}
