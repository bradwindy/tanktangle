/**
 * Presents the low-res scene canvas on the stage. WebGL path: sharp-bilinear upscale (square pixels at any
 * scale), bloom (bright pass + separable blur at half res), CRT scanlines and vignette, chromatic aberration,
 * flashes and a hurt vignette. Fallback: Canvas 2D nearest-neighbour drawImage with flashes.
 */

export interface PresentParams {
  /** Scene texel rect mapped onto the whole stage. Fractional for smooth sub-pixel scrolling. */
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
  /** Device px per scene texel. */
  scale: number;
  crt: boolean;
  bloom: number;
  flash: number;
  flashColor: readonly [number, number, number];
  hurt: number;
  aberration: number;
  time: number;
}

export interface Presenter {
  readonly kind: 'webgl' | '2d';
  present(scene: HTMLCanvasElement, p: PresentParams): void;
}

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

const BRIGHT = `${PRECISION}
uniform sampler2D uTex;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(uTex, vUv + uTexel * vec2(-0.25, -0.25)).rgb;
  c += texture2D(uTex, vUv + uTexel * vec2(0.25, -0.25)).rgb;
  c += texture2D(uTex, vUv + uTexel * vec2(-0.25, 0.25)).rgb;
  c += texture2D(uTex, vUv + uTexel * vec2(0.25, 0.25)).rgb;
  c *= 0.25;
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float peak = max(c.r, max(c.g, c.b));
  float k = smoothstep(0.7, 1.0, max(luma, peak * 0.6));
  gl_FragColor = vec4(c * k, 1.0);
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

const COMPOSITE = `${PRECISION}
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uSceneSize;
uniform vec4 uSrc;
uniform vec2 uScreen;
uniform float uScale;
uniform float uBloomAmt;
uniform float uCrt;
uniform float uAberr;
uniform vec3 uFlashColor;
uniform float uFlash;
uniform float uHurt;
uniform float uTime;

vec3 sharp(vec2 texel) {
  vec2 fl = floor(texel);
  vec2 cd = texel - fl - 0.5;
  float region = 0.5 - 0.5 / max(uScale, 1.0);
  vec2 f = (cd - clamp(cd, -region, region)) * max(uScale, 1.0) + 0.5;
  return texture2D(uScene, (fl + f) / uSceneSize).rgb;
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uScreen.y - gl_FragCoord.y);
  vec2 uv = px / uScreen;
  vec2 texel = uSrc.xy + uv * uSrc.zw;
  vec3 col;
  if (uAberr > 0.01) {
    vec2 d = (uv - 0.5) * uAberr;
    col = vec3(sharp(texel + d).r, sharp(texel).g, sharp(texel - d).b);
  } else {
    col = sharp(texel);
  }
  col += texture2D(uBloom, texel / uSceneSize).rgb * uBloomAmt;
  vec2 q = uv - 0.5;
  if (uCrt > 0.0) {
    float aligned = smoothstep(2.4, 4.0, uScale);
    float rowScan = 1.0 - 0.32 * aligned * (0.5 + 0.5 * cos(6.2831853 * fract(texel.y)));
    float lineScan = 1.0 - 0.1 * (1.0 - aligned) * step(2.0, mod(gl_FragCoord.y, 3.0));
    col *= rowScan * lineScan * (1.0 + 0.16 * aligned + 0.06);
    col *= 1.0 - dot(q, q) * 0.95;
    col += (hash(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) * 0.035;
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
  private composite!: WebGLProgram;
  private sceneTex!: WebGLTexture;
  private a: Target | null = null;
  private b: Target | null = null;
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
      this.init();
      this.lost = false;
    });
  }

  private init(): void {
    const gl = this.gl;
    this.bright = program(gl, VERT, BRIGHT);
    this.blur = program(gl, VERT, BLUR);
    this.composite = program(gl, VERT, COMPOSITE);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    for (const p of [this.bright, this.blur, this.composite]) {
      const loc = gl.getAttribLocation(p, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
    this.sceneTex = texture(gl);
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

  present(scene: HTMLCanvasElement, p: PresentParams): void {
    if (this.lost || this.gl.isContextLost()) return;
    const gl = this.gl;
    const sw = scene.width;
    const sh = scene.height;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, scene);

    const bw = Math.max(1, Math.ceil(sw / 2));
    const bh = Math.max(1, Math.ceil(sh / 2));
    this.a = this.target(this.a, bw, bh);
    this.b = this.target(this.b, bw, bh);

    gl.useProgram(this.bright);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.a.fb);
    gl.viewport(0, 0, bw, bh);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.uniform1i(this.u(this.bright, 'uTex'), 0);
    gl.uniform2f(this.u(this.bright, 'uTexel'), 1 / sw, 1 / sh);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(this.blur);
    gl.uniform1i(this.u(this.blur, 'uTex'), 0);
    for (let pass = 0; pass < 2; pass++) {
      const spread = pass + 1;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.b.fb);
      gl.bindTexture(gl.TEXTURE_2D, this.a.tex);
      gl.uniform2f(this.u(this.blur, 'uDir'), spread / bw, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.a.fb);
      gl.bindTexture(gl.TEXTURE_2D, this.b.tex);
      gl.uniform2f(this.u(this.blur, 'uDir'), 0, spread / bh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const c = this.composite;
    gl.useProgram(c);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.a.tex);
    gl.uniform1i(this.u(c, 'uScene'), 0);
    gl.uniform1i(this.u(c, 'uBloom'), 1);
    gl.uniform2f(this.u(c, 'uSceneSize'), sw, sh);
    gl.uniform4f(this.u(c, 'uSrc'), p.srcX, p.srcY, p.srcW, p.srcH);
    gl.uniform2f(this.u(c, 'uScreen'), this.canvas.width, this.canvas.height);
    gl.uniform1f(this.u(c, 'uScale'), p.scale);
    gl.uniform1f(this.u(c, 'uBloomAmt'), p.bloom);
    gl.uniform1f(this.u(c, 'uCrt'), p.crt ? 1 : 0);
    gl.uniform1f(this.u(c, 'uAberr'), p.aberration);
    gl.uniform3f(this.u(c, 'uFlashColor'), p.flashColor[0] / 255, p.flashColor[1] / 255, p.flashColor[2] / 255);
    gl.uniform1f(this.u(c, 'uFlash'), p.flash);
    gl.uniform1f(this.u(c, 'uHurt'), p.hurt);
    gl.uniform1f(this.u(c, 'uTime'), p.time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
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
  private scan: CanvasPattern | null = null;

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
    if (p.crt) {
      if (!this.scan) {
        const c = document.createElement('canvas');
        c.width = 1;
        c.height = 3;
        const g = c.getContext('2d');
        if (g) {
          g.fillStyle = 'rgba(0,0,0,0.22)';
          g.fillRect(0, 2, 1, 1);
          this.scan = ctx.createPattern(c, 'repeat');
        }
      }
      if (this.scan) {
        ctx.fillStyle = this.scan;
        ctx.fillRect(0, 0, w, h);
      }
    }
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
