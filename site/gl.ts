// The blobs as one glossy liquid: a single fragment shader. A 2D smooth-union field (so blobs neck and merge),
// lit as a soft height field: light from the top left, a highlight, shade to the bottom right, a contact shadow.
export type Box = { x: number; y: number; w: number; h: number; r: number };
export type Scene = { hero: Box; blobs: Box[]; breath: number };

const N = 7;   // budding blobs (the hero is a rounded box, so it can become the last card)
const VERT = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0., 1.); }';
const FRAG = `
precision highp float;
uniform vec2 uRes; uniform float uPx, uTime, uHeroR, uGloss;
uniform vec4 uHero; uniform vec3 uBlob[${N}];
const float K = 44.;      // how far apart two blobs start to neck
const float B = 64.;      // how deep the rounded edge runs before the top goes flat
const float E = 6.;
float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.) / k; return min(a, b) - h * h * k * .25; }
// x: distance to the liquid's edge in px; y: how deep the rounded edge runs here (small drops are round all over)
vec2 field(vec2 p) {
  vec2 q = abs(p - uHero.xy) - uHero.zw + uHeroR;
  float d = length(max(q, 0.)) + min(max(q.x, q.y), 0.) - uHeroR;
  float w = exp(-max(d, 0.) * .06), ws = w, bs = min(B, min(uHero.z, uHero.w)) * w;
  for (int i = 0; i < ${N}; i++) {
    float di = length(p - uBlob[i].xy) - uBlob[i].z;
    w = exp(-max(di, 0.) * .06); ws += w; bs += min(B, uBlob[i].z) * w;
    d = smin(d, di, K);
  }
  d += sin(p.x * .013 + uTime * .5 + sin(p.y * .011 - uTime * .35) * 1.6) * 3.5 + sin(p.y * .017 + uTime * .4 + p.x * .006) * 2.5;
  return vec2(d, bs / max(ws, 1e-4));
}
void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uPx;
  vec2 f = field(p);
  // the slope, measured wide: where two blobs meet it cancels out, so the join is a soft valley, not a crease
  vec2 g = vec2(field(p + vec2(E, 0.)).x - field(p - vec2(E, 0.)).x, field(p + vec2(0., E)).x - field(p - vec2(0., E)).x) / (2. * E);
  float u = 1. - clamp(-f.x / f.y, 0., 1.);                  // 1 at the edge, 0 on the flat top
  u = u * u * (3. - 2. * u) * .35 + u * .65;                 // a softer shoulder
  vec3 n = normalize(vec3(g * u, sqrt(max(1. - u * u, 0.)) + .04));
  vec3 L = normalize(vec3(-.5, -.62, .6));
  float diff = dot(n, L);
  vec3 col = mix(vec3(.68, .68, .695), vec3(.93), smoothstep(-.9, 1., diff));
  float s = max(dot(n, normalize(L + vec3(0., 0., 1.))), 0.);
  col += (pow(s, 70.) * .55 + pow(s, 14.) * .06) * uGloss;   // the highlight, and its soft bloom
  col += pow(u, 5.) * max(dot(g, vec2(.63, .78)), 0.) * .3;  // light gathering on the far edge, as in a drop
  float a = smoothstep(.8, -.8, f.x * uPx);
  float soft = (1. - smoothstep(-36., 52., field(p - vec2(16., 26.)).x)) * .15;
  float near = (1. - smoothstep(-3., 13., field(p - vec2(3., 6.)).x)) * .1;
  float sh = soft + near - soft * near;
  gl_FragColor = vec4(min(col, 1.) * a, a + sh * (1. - a));
}`;

/** Starts drawing; returns a stop function, or null when WebGL is not there (the page then uses the 2D goo). */
export function startLiquid(canvas: HTMLCanvasElement, read: () => Scene): (() => void) | null {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, antialias: false, alpha: true });
  if (!gl) return null;
  const prog = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(sh)); return null; }
    gl.attachShader(prog, sh);
  }
  gl.bindAttribLocation(prog, 0, 'p');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);   // one big triangle
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const U = (name: string) => gl.getUniformLocation(prog, name);
  const uRes = U('uRes'), uPx = U('uPx'), uTime = U('uTime'), uHero = U('uHero'), uHeroR = U('uHeroR'), uBlob = U('uBlob'), uGloss = U('uGloss');
  const blobs = new Float32Array(N * 3);
  let raf = 0;
  const draw = (ms: number) => {
    raf = requestAnimationFrame(draw);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const px = Math.min(devicePixelRatio || 1, w < 760 ? 1.5 : 2);   // phones draw fewer pixels
    if (canvas.width !== Math.round(w * px) || canvas.height !== Math.round(h * px)) {
      canvas.width = Math.round(w * px); canvas.height = Math.round(h * px);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    const { hero, blobs: bs, breath } = read(), t = ms / 1000;
    const swell = 1 + .03 * Math.sin(t * 1.3) * breath;               // the hero breathes
    bs.forEach((b, i) => blobs.set([b.x, b.y, b.w / 2], i * 3));
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uPx, px);
    gl.uniform1f(uTime, t);
    gl.uniform4f(uHero, hero.x, hero.y, hero.w / 2 * swell, hero.h / 2 * swell);
    gl.uniform1f(uHeroR, hero.r * swell);
    gl.uniform1f(uGloss, .12 + .88 * breath);                           // the last card is calmer
    gl.uniform3fv(uBlob, blobs);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  raf = requestAnimationFrame(draw);
  return () => cancelAnimationFrame(raf);
}
