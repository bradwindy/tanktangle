import type { CrtLevel } from '../view';

/**
 * Presents the low-res scene canvas and the display-res overlay canvas on the stage. WebGL path: phosphor trails
 * (kept at scene res and aligned to the world), bloom and glass halation (bright pass + separable blur at half res),
 * sharp-bilinear upscale with a CRT softness, line wobble and sync jitter, chromatic aberration that grows toward
 * the edges, the overlay composited in the same pass so text wobbles and fringes with the world, flashes and a hurt
 * vignette. Scanlines, the aperture mask, noise and the vignette are not drawn here: crt.ts draws them once over the
 * game and the UI together. Fallback: Canvas 2D nearest-neighbour drawImage with flashes, and the overlay canvas
 * stays a separate element above the stage.
 */

export interface PresentParams {
  /** Scene texel rect mapped onto the whole stage. Fractional for smooth sub-pixel scrolling. */
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
  /** Device px per scene texel. */
  scale: number;
  /** World px at scene texel (0, 0). Whole numbers, so trails stay on the world while the camera moves. */
  originX: number;
  originY: number;
  dpr: number;
  /** Seconds since the last present. */
  dt: number;
  crt: CrtLevel;
  /** False for reduced motion: no line wobble. */
  motion: boolean;
  /** Horizontal sync kick in CSS px, from hsyncJitter. */
  jitter: number;
  flash: number;
  flashColor: readonly [number, number, number];
  hurt: number;
  aberration: number;
  time: number;
}

export interface Presenter {
  readonly kind: 'webgl' | '2d';
  /** overlay: the display-res text layer to composite, or null when nothing was drawn on it. */
  present(scene: HTMLCanvasElement, p: PresentParams, overlay: HTMLCanvasElement | null): void;
  /** Drops phosphor trails, so a new maze does not fade in over the old one. */
  clearTrails?(): void;
}

interface Look {
  /** Bloom added on top. 0 skips the bloom passes. */
  bloom: number;
  /** Brightness where bloom starts. */
  threshold: number;
  /** Share of every pixel that glows, bright or not: light scattered in the glass. */
  halo: number;
  /** Width of the blend between scene pixels in CSS px, never under the crisp 1 device px. */
  soft: number;
  /** Colour split at the corners, in CSS px. */
  edgeAberration: number;
  /** Constant horizontal colour bleed, in CSS px. */
  bleed: number;
  /** Share of a frame's light still showing one 60 Hz frame later. 0 turns trails off. */
  ghost: number;
  /** Line wobble amplitude in CSS px. */
  wobble: number;
}

const LOOKS: Record<CrtLevel, Look> = {
  full: { bloom: 1.05, threshold: 0.55, halo: 0.09, soft: 1.2, edgeAberration: 1.6, bleed: 0.45, ghost: 0.55, wobble: 0.4 },
  soft: { bloom: 0.9, threshold: 0.65, halo: 0.05, soft: 0.9, edgeAberration: 0.45, bleed: 0.3, ghost: 0, wobble: 0 },
  off: { bloom: 0.9, threshold: 0.7, halo: 0, soft: 0, edgeAberration: 0, bleed: 0, ghost: 0, wobble: 0 },
};

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

/** Phosphor persistence: the brighter of this frame and the last result faded, shifted so trails stay on the world. */
const GHOST = `${PRECISION}
uniform sampler2D uTex;
uniform sampler2D uPrev;
uniform vec2 uShift;
uniform float uKeep;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb;
  vec2 p = vUv + uShift;
  float inside = step(0.0, p.x) * step(p.x, 1.0) * step(0.0, p.y) * step(p.y, 1.0);
  vec3 g = texture2D(uPrev, p).rgb * uKeep * inside;
  gl_FragColor = vec4(max(c, g), 1.0);
}`;

const BRIGHT = `${PRECISION}
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uHalo;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(uTex, vUv + uTexel * vec2(-0.25, -0.25)).rgb;
  c += texture2D(uTex, vUv + uTexel * vec2(0.25, -0.25)).rgb;
  c += texture2D(uTex, vUv + uTexel * vec2(-0.25, 0.25)).rgb;
  c += texture2D(uTex, vUv + uTexel * vec2(0.25, 0.25)).rgb;
  c *= 0.25;
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float peak = max(c.r, max(c.g, c.b));
  float k = smoothstep(uThreshold, 1.0, max(luma, peak * 0.6));
  gl_FragColor = vec4(c * (k + uHalo), 1.0);
}`;

const BLUR = `${PRECISION}
uniform sampler2D uTex;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb * 0.227027;
  c += texture2D(uTex, vUv + uDir * 1.384615).rgb * 0.316216;
  c += texture2D(uTex, vUv - uDir * 1.384615).rgb * 0.316216;
  c += texture2D(uTex, vUv + uDir * 3.230769).rgb * 0.070270;
  c += texture2D(uTex, vUv - uDir * 3.230769).rgb * 0.070270;
  gl_FragColor = vec4(c, 1.0);
}`;

/** Screen lengths (uScreen, uWobble, uShift, uEdgeAberr, uBleed, uSoft) are device px. */
const COMPOSITE = `${PRECISION}
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uOverlay;
uniform vec2 uSceneSize;
uniform vec4 uSrc;
uniform vec2 uScreen;
uniform float uScale;
uniform float uSoft;
uniform float uBloomAmt;
uniform float uWobble;
uniform float uShift;
uniform float uEdgeAberr;
uniform float uBleed;
uniform float uAberr;
uniform float uOverlayOn;
uniform vec3 uFlashColor;
uniform float uFlash;
uniform float uHurt;
uniform float uTime;

vec3 sharp(vec2 texel) {
  vec2 fl = floor(texel);
  vec2 cd = texel - fl - 0.5;
  float s = max(uScale / uSoft, 1.0);
  float region = 0.5 - 0.5 / s;
  vec2 f = (cd - clamp(cd, -region, region)) * s + 0.5;
  return texture2D(uScene, (fl + f) / uSceneSize).rgb;
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uScreen.y - gl_FragCoord.y);
  vec2 uv = px / uScreen;
  float wobble = uWobble * (sin(uv.y * 23.0 + uTime * 1.9) * 0.6 + sin(uv.y * 131.0 - uTime * 7.3) * 0.4);
  uv.x -= (uShift + wobble) / uScreen.x;
  vec2 q = uv - 0.5;
  vec2 off = (q * 4.0 * dot(q, q) * uEdgeAberr + vec2(uBleed, 0.0)) / uScreen + q * uAberr / uSrc.zw;
  bool split = dot(off * uScreen, off * uScreen) > 0.04;
  vec2 texel = uSrc.xy + uv * uSrc.zw;
  vec3 col;
  if (split) {
    vec2 d = off * uSrc.zw;
    col = vec3(sharp(texel + d).r, sharp(texel).g, sharp(texel - d).b);
  } else {
    col = sharp(texel);
  }
  col += texture2D(uBloom, texel / uSceneSize).rgb * uBloomAmt;
  if (uOverlayOn > 0.5) {
    vec4 o = texture2D(uOverlay, uv);
    if (split) {
      vec4 oR = texture2D(uOverlay, uv + off);
      vec4 oB = texture2D(uOverlay, uv - off);
      col = vec3(col.r * (1.0 - oR.a) + oR.r, col.g * (1.0 - o.a) + o.g, col.b * (1.0 - oB.a) + oB.b);
    } else {
      col = col * (1.0 - o.a) + o.rgb;
    }
  }
  float edge = smoothstep(0.22, 0.72, length(q * vec2(1.0, 1.15)));
  col = mix(col, vec3(1.0, 0.08, 0.12), uHurt * edge * 0.55);
  col = mix(col, uFlashColor, uFlash);
  gl_FragColor = vec4(col, 1.0);
}`;

interface Target {
  tex: WebGLTexture;
  fb: WebGLFramebuffer;
  w: number;
  h: number;
}

class GlPresenter implements Presenter {
  readonly kind = 'webgl' as const;
  private gl: WebGLRenderingContext;
  private lost = false;
  private bright!: WebGLProgram;
  private blur!: WebGLProgram;
  private ghost!: WebGLProgram;
  private composite!: WebGLProgram;
  private sceneTex!: WebGLTexture;
  private overlayTex!: WebGLTexture;
  private a: Target | null = null;
  private b: Target | null = null;
  /** Trails ping-pong: next frame writes trailA and reads trailB, the latest result. */
  private trailA: Target | null = null;
  private trailB: Target | null = null;
  private trailLive = false;
  private trailX = 0;
  private trailY = 0;
  private uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();

  constructor(
    private canvas: HTMLCanvasElement,
    gl: WebGLRenderingContext,
  ) {
    this.gl = gl;
    this.init();
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.uniforms.clear();
      this.a = null;
      this.b = null;
      this.trailA = null;
      this.trailB = null;
      this.trailLive = false;
      this.init();
      this.lost = false;
    });
  }

  private init(): void {
    const gl = this.gl;
    this.bright = program(gl, VERT, BRIGHT);
    this.blur = program(gl, VERT, BLUR);
    this.ghost = program(gl, VERT, GHOST);
    this.composite = program(gl, VERT, COMPOSITE);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    for (const p of [this.bright, this.blur, this.ghost, this.composite]) {
      const loc = gl.getAttribLocation(p, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
    this.sceneTex = texture(gl);
    this.overlayTex = texture(gl);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }

  private u(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.uniforms.get(p);
    if (!m) {
      m = new Map();
      this.uniforms.set(p, m);
    }
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(p, name));
    return m.get(name) ?? null;
  }

  private bind(unit: number, tex: WebGLTexture): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
  }

  private target(old: Target | null, w: number, h: number): Target {
    const gl = this.gl;
    if (old && old.w === w && old.h === h) return old;
    if (old) {
      gl.deleteTexture(old.tex);
      gl.deleteFramebuffer(old.fb);
    }
    const tex = texture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h };
  }

  present(scene: HTMLCanvasElement, p: PresentParams, overlay: HTMLCanvasElement | null): void {
    if (this.lost || this.gl.isContextLost()) return;
    const gl = this.gl;
    const look = LOOKS[p.crt];
    const sw = scene.width;
    const sh = scene.height;
    this.bind(0, this.sceneTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, scene);

    let picture = this.sceneTex;
    if (look.ghost > 0) picture = this.trails(sw, sh, look.ghost, p);
    else this.trailLive = false;
    const bloom = look.bloom > 0 ? this.bloom(picture, sw, sh, look) : picture;
    if (overlay) {
      this.bind(2, this.overlayTex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, overlay);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const c = this.composite;
    gl.useProgram(c);
    this.bind(0, picture);
    this.bind(1, bloom);
    this.bind(2, overlay ? this.overlayTex : picture);
    gl.uniform1i(this.u(c, 'uScene'), 0);
    gl.uniform1i(this.u(c, 'uBloom'), 1);
    gl.uniform1i(this.u(c, 'uOverlay'), 2);
    gl.uniform2f(this.u(c, 'uSceneSize'), sw, sh);
    gl.uniform4f(this.u(c, 'uSrc'), p.srcX, p.srcY, p.srcW, p.srcH);
    gl.uniform2f(this.u(c, 'uScreen'), this.canvas.width, this.canvas.height);
    gl.uniform1f(this.u(c, 'uScale'), p.scale);
    gl.uniform1f(this.u(c, 'uSoft'), Math.max(1, look.soft * p.dpr));
    gl.uniform1f(this.u(c, 'uBloomAmt'), look.bloom);
    gl.uniform1f(this.u(c, 'uWobble'), p.motion ? look.wobble * p.dpr : 0);
    gl.uniform1f(this.u(c, 'uShift'), p.jitter * p.dpr);
    gl.uniform1f(this.u(c, 'uEdgeAberr'), look.edgeAberration * p.dpr);
    gl.uniform1f(this.u(c, 'uBleed'), look.bleed * p.dpr);
    gl.uniform1f(this.u(c, 'uAberr'), p.aberration);
    gl.uniform1f(this.u(c, 'uOverlayOn'), overlay ? 1 : 0);
    gl.uniform3f(this.u(c, 'uFlashColor'), p.flashColor[0] / 255, p.flashColor[1] / 255, p.flashColor[2] / 255);
    gl.uniform1f(this.u(c, 'uFlash'), p.flash);
    gl.uniform1f(this.u(c, 'uHurt'), p.hurt);
    gl.uniform1f(this.u(c, 'uTime'), p.time % 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Blends this frame's scene with the faded last result and returns the texture holding the blend. */
  clearTrails(): void {
    this.trailLive = false;
  }

  private trails(sw: number, sh: number, ghost: number, p: PresentParams): WebGLTexture {
    const gl = this.gl;
    const resized = !this.trailA || this.trailA.w !== sw || this.trailA.h !== sh;
    const write = this.target(this.trailA, sw, sh);
    const prev = this.target(this.trailB, sw, sh);
    const dt = Math.min(0.1, Math.max(1 / 240, p.dt));
    const keep = this.trailLive && !resized ? Math.pow(ghost, dt * 60) : 0;
    gl.useProgram(this.ghost);
    gl.bindFramebuffer(gl.FRAMEBUFFER, write.fb);
    gl.viewport(0, 0, sw, sh);
    this.bind(0, this.sceneTex);
    this.bind(1, prev.tex);
    gl.uniform1i(this.u(this.ghost, 'uTex'), 0);
    gl.uniform1i(this.u(this.ghost, 'uPrev'), 1);
    gl.uniform2f(this.u(this.ghost, 'uShift'), (p.originX - this.trailX) / sw, (p.originY - this.trailY) / sh);
    gl.uniform1f(this.u(this.ghost, 'uKeep'), keep);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.trailA = prev;
    this.trailB = write;
    this.trailX = p.originX;
    this.trailY = p.originY;
    this.trailLive = true;
    return write.tex;
  }

  /** Bright pass and blur at half the scene's resolution. Returns the bloom texture. */
  private bloom(picture: WebGLTexture, sw: number, sh: number, look: Look): WebGLTexture {
    const gl = this.gl;
    const bw = Math.max(1, Math.ceil(sw / 2));
    const bh = Math.max(1, Math.ceil(sh / 2));
    const a = (this.a = this.target(this.a, bw, bh));
    const b = (this.b = this.target(this.b, bw, bh));

    gl.useProgram(this.bright);
    gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb);
    gl.viewport(0, 0, bw, bh);
    this.bind(0, picture);
    gl.uniform1i(this.u(this.bright, 'uTex'), 0);
    gl.uniform2f(this.u(this.bright, 'uTexel'), 1 / sw, 1 / sh);
    gl.uniform1f(this.u(this.bright, 'uThreshold'), look.threshold);
    gl.uniform1f(this.u(this.bright, 'uHalo'), look.halo);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(this.blur);
    gl.uniform1i(this.u(this.blur, 'uTex'), 0);
    for (let pass = 0; pass < 2; pass++) {
      const spread = pass + 1;
      gl.bindFramebuffer(gl.FRAMEBUFFER, b.fb);
      this.bind(0, a.tex);
      gl.uniform2f(this.u(this.blur, 'uDir'), spread / bw, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb);
      this.bind(0, b.tex);
      gl.uniform2f(this.u(this.blur, 'uDir'), 0, spread / bh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    return a.tex;
  }
}

function texture(gl: WebGLRenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('WebGL texture unavailable');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function program(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error('WebGL program unavailable');
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const s = gl.createShader(type);
    if (!s) throw new Error('WebGL shader unavailable');
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      throw new Error(`shader compile failed: ${gl.getShaderInfoLog(s) ?? ''}`);
    }
    gl.attachShader(p, s);
  }
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`shader link failed: ${gl.getProgramInfoLog(p) ?? ''}`);
  }
  return p;
}

class CanvasPresenter implements Presenter {
  readonly kind = '2d' as const;

  constructor(
    private canvas: HTMLCanvasElement,
    private ctx: CanvasRenderingContext2D,
  ) {}

  present(scene: HTMLCanvasElement, p: PresentParams): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(scene, p.srcX, p.srcY, p.srcW, p.srcH, 0, 0, w, h);
    if (p.hurt > 0.01) {
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.7);
      g.addColorStop(0, 'rgba(255,20,30,0)');
      g.addColorStop(1, `rgba(255,20,30,${(p.hurt * 0.55).toFixed(3)})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    if (p.flash > 0.01) {
      ctx.globalAlpha = p.flash;
      ctx.fillStyle = `rgb(${p.flashColor[0]},${p.flashColor[1]},${p.flashColor[2]})`;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }
  }
}

const GL_OPTIONS: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
};

/** Compiles the shaders on a throwaway canvas first, because once the stage has a WebGL context it can never get a 2D one. */
function webglWorks(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl', GL_OPTIONS);
    if (!gl) return false;
    program(gl, VERT, BRIGHT);
    program(gl, VERT, BLUR);
    program(gl, VERT, GHOST);
    program(gl, VERT, COMPOSITE);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch (err) {
    console.error(JSON.stringify({ event: 'webgl_unavailable', error: String(err) }));
    return false;
  }
}

class NullPresenter implements Presenter {
  readonly kind = '2d' as const;
  present(): void {}
}

export function createPresenter(stage: HTMLCanvasElement, preferWebgl = true): Presenter {
  if (preferWebgl && webglWorks()) {
    try {
      const gl = stage.getContext('webgl', GL_OPTIONS);
      if (gl) return new GlPresenter(stage, gl);
    } catch (err) {
      console.error(JSON.stringify({ event: 'webgl_init_failed', error: String(err) }));
      return new NullPresenter();
    }
  }
  const ctx = stage.getContext('2d', { alpha: false });
  return ctx ? new CanvasPresenter(stage, ctx) : new NullPresenter();
}
