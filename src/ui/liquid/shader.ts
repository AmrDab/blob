// The liquid's shader: the website's lit height field (site/gl.ts: the same light, highlight, far-edge glow and soft
// contact shadow), at the bubble's size. One draw shades one cluster's box with only that cluster's bodies.
export const NB = 40;     // bodies in one draw: Speak, the caption, 3 + 12 small blobs and their remove-x's, the cards
export const NT = 8;      // strand halves in one draw (two per strand)
export const FAR = 34;    // beyond this many px from the liquid there is no shadow either: nothing to shade

export const VERT = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0., 1.); }';
export const FRAG = `precision highp float;
uniform vec2 uRes; uniform float uPx, uTime, uShadeT, uKs, uKb;
uniform int uN, uNT;
uniform vec4 uB[${NB}];   // centre x, y, half sizes x, y
uniform vec4 uA[${NB}];   // stretch frame cos, sin; wobble mode 2 as (cos, sin) parts
uniform vec2 uC[${NB}];   // corner radius (> 0 makes a rounded box), neck distance K (0: a small blob)
uniform vec4 uT[${NT}];   // strand half: from x, y to tip x, y
uniform vec2 uR[${NT}];   // strand half: radius at the body, radius at the tip
const float B = 64.;      // how deep the rounded edge runs before the top goes flat
const float E = 3.;
const float FAR = ${FAR}.;
float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.) / k; return min(a, b) - h * h * k * .25; }
// x: distance to the liquid edge in px; y: how deep the rounded edge runs here. t: the ripple clock
vec2 field(vec2 p, float t) {
  float d = 1e4, ds = 1e4, ws = 0., bs = 0.;
  for (int i = 0; i < ${NB}; i++) {
    if (i >= uN) break;
    vec4 b = uB[i]; vec4 a = uA[i]; vec2 c = uC[i];
    vec2 o = p - b.xy;
    // too far to matter here (its shadow, the widest join and the slope's taps all end well inside 80 px): skipped
    float R = (c.x > 0. ? length(b.zw) : max(b.z, b.w) * 1.13) + 80.;
    if (dot(o, o) > R * R) continue;
    vec2 q = vec2(a.x * o.x + a.y * o.y, a.x * o.y - a.y * o.x);
    float di;
    if (c.x > 0.) {
      vec2 e = abs(q) - b.zw + c.x;
      di = length(max(e, 0.)) + min(max(e.x, e.y), 0.) - c.x;
    } else {
      float k0 = length(q / b.zw), k1 = length(q / (b.zw * b.zw));
      di = k1 > 1e-5 ? k0 * (k0 - 1.) / k1 : -min(b.z, b.w);
      vec2 n = o / max(length(o), 1e-3);
      float wob = a.z * (n.x * n.x - n.y * n.y) + a.w * (2. * n.x * n.y);
      di -= min(b.z, b.w) * wob * smoothstep(0., .5, k0);
    }
    // a box (a card, the caption) rounds off over 16 px only, so its text lies on the flat top
    float w = exp(-max(di, 0.) * .15); ws += w; bs += min(c.x > 0. ? 16. : B, min(b.z, b.w)) * w;
    // the small blobs join each other with a narrow blend, so they stay separate at rest
    if (c.y > 0.) d = smin(d, di, c.y); else ds = smin(ds, di, uKs);
  }
  d = smin(d, ds, uKb);          // ... and join the big blob with the wide one
  for (int i = 0; i < ${NT}; i++) {
    if (i >= uNT) break;
    vec2 r = uR[i];
    vec2 pa = p - uT[i].xy, ba = uT[i].zw - uT[i].xy;
    float bb = dot(ba, ba); if (bb < 1e-3) continue;
    float h = clamp(dot(pa, ba) / bb, 0., 1.);
    float rad = mix(r.x, r.y, sin(h * 1.5708));
    float dc = length(pa - ba * h) - rad;
    float w = exp(-max(dc, 0.) * .15); ws += w; bs += max(rad, 2.) * w;
    d = smin(d, dc, 10.);
  }
  d += sin(p.x * .045 + t * .5 + sin(p.y * .04 - t * .35) * 1.6) * 1.2 + sin(p.y * .06 + t * .4 + p.x * .02) * .8;
  return vec2(d, max(bs / max(ws, 1e-4), 1.));
}
void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uPx;
  vec2 f = field(p, uTime);
  if (f.x > FAR) { gl_FragColor = vec4(0.); return; }          // too far for even the shadow
  float a = smoothstep(.8, -.8, f.x * uPx);
  float sh = 0.;
  if (a < 1.) {                                                // the shadow only shows outside the liquid
    float soft = (1. - smoothstep(-14.4, 20.8, field(p - vec2(6., 10.), uShadeT).x)) * .15;
    float near = (1. - smoothstep(-1.2, 5.2, field(p - vec2(1.5, 3.), uShadeT).x)) * .1;
    sh = soft + near - soft * near;
  }
  if (a <= 0.) { gl_FragColor = vec4(0., 0., 0., sh); return; }  // no surface here: skip the slope and the lighting
  // the slope, measured wide: where two blobs meet it cancels out, so the join is a soft valley, not a crease
  vec2 g = vec2(field(p + vec2(E, 0.), uTime).x - field(p - vec2(E, 0.), uTime).x, field(p + vec2(0., E), uTime).x - field(p - vec2(0., E), uTime).x) / (2. * E);
  float u = 1. - clamp(-f.x / f.y, 0., 1.);
  u = u * u * (3. - 2. * u) * .35 + u * .65;
  vec3 n = normalize(vec3(g * u, sqrt(max(1. - u * u, 0.)) + .04));
  vec3 L = normalize(vec3(-.5, -.62, .6));
  float diff = dot(n, L);
  vec3 col = mix(vec3(.68, .68, .695), vec3(.93), smoothstep(-.9, 1., diff));
  float s = max(dot(n, normalize(L + vec3(0., 0., 1.))), 0.);
  col += pow(s, 70.) * .55 + pow(s, 14.) * .06;
  col += pow(u, 5.) * max(dot(g, vec2(.63, .78)), 0.) * .3;
  gl_FragColor = vec4(min(col, 1.) * a, a + sh * (1. - a));   // premultiplied: no fringe over any desktop
}`;
