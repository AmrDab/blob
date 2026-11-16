// Draws a Scene with WebGL: one scissored draw for each cluster of liquid, so the cost follows the liquid, not the window.
import { clusters, type Cluster, type Scene } from './scene.ts';
import { K_BODY, K_SAT } from './sim.ts';
import { FAR, FRAG, NB, NT, VERT } from './shader.ts';

const PAD = FAR + 6;                   // room around each cluster for its shadow
const WRAP = 40 * Math.PI;             // the ripple repeats after this many seconds: the GPU's clock stays small and exact

export interface Renderer {
  /** `part` 'core': only Speak's cluster, without its cards, is redrawn (the breath, the slow resting ripple: nothing
      else changes then). `shadeT`: the shadow's clock, held still by the caller while only the core is drawn. */
  draw(scene: Scene, clock: number, part: 'all' | 'core', shadeT: number): void;
  /** The canvas has a new size: `px` canvas pixels for each CSS px. */
  resized(px: number): void;
  /** Frees the GPU context at once (a page that mounts canvases again and again would otherwise pile them up). */
  release(): void;
}

/** Undefined when there is no WebGL here, or only a software one (the page then keeps the 2D liquid). */
export function createRenderer(canvas: HTMLCanvasElement): Renderer | undefined {
  // preserveDrawingBuffer: the resting ripple redraws only Speak's box and leaves the rest of the picture alone.
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true,
    failIfMajorPerformanceCaveat: true });
  if (!gl || gl.isContextLost()) return undefined;
  const prog = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(sh)); return undefined; }
    gl.attachShader(prog, sh);
  }
  gl.bindAttribLocation(prog, 0, 'p');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn(gl.getProgramInfoLog(prog)); return undefined; }
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const loc = Object.fromEntries(['uRes', 'uPx', 'uTime', 'uShadeT', 'uKs', 'uKb', 'uN', 'uNT', 'uB', 'uA', 'uC', 'uT', 'uR']
    .map(n => [n, gl.getUniformLocation(prog, n)]));
  gl.clearColor(0, 0, 0, 0);
  gl.uniform1f(loc.uKs, K_SAT); gl.uniform1f(loc.uKb, K_BODY);

  const uB = new Float32Array(NB * 4), uA = new Float32Array(NB * 4), uC = new Float32Array(NB * 2);
  const uT = new Float32Array(NT * 4), uR = new Float32Array(NT * 2);
  let px = 1, prev: number[][] = [], fullClear = true;

  // CSS px box -> scissor rectangle in canvas pixels [x, y, w, h]
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    const sx0 = Math.max(0, Math.floor(x0 * px)), sx1 = Math.min(canvas.width, Math.ceil(x1 * px));
    const sy0 = Math.max(0, Math.floor(y0 * px)), sy1 = Math.min(canvas.height, Math.ceil(y1 * px));
    return [sx0, canvas.height - sy1, Math.max(0, sx1 - sx0), Math.max(0, sy1 - sy0)];
  };
  // Shade one rectangle with only the bodies and strands that belong to its cluster.
  const shade = (r: number[], c: Cluster, scene: Scene) => {
    let n = 0, t = 0;
    for (const s of scene.shapes) {
      if (n === NB || !c.groups.includes(s.group)) continue;
      uB.set([s.x, s.y, s.rx, s.ry], n * 4); uA.set([s.cos, s.sin, s.a2c, s.a2s], n * 4); uC.set([s.corner, s.k], n * 2);
      n++;
    }
    for (const s of scene.strands) {
      if (t === NT || !c.groups.includes(s.group)) continue;
      uT.set([s.ax, s.ay, s.bx, s.by], t * 4); uR.set([s.rb, s.rt], t * 2);
      t++;
    }
    gl.scissor(r[0], r[1], r[2], r[3]);
    gl.uniform1i(loc.uN, n); gl.uniform1i(loc.uNT, t);
    gl.uniform4fv(loc.uB, uB); gl.uniform4fv(loc.uA, uA); gl.uniform2fv(loc.uC, uC);
    gl.uniform4fv(loc.uT, uT); gl.uniform2fv(loc.uR, uR);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  return {
    resized(p) { px = p; gl.viewport(0, 0, canvas.width, canvas.height); fullClear = true; prev = []; },
    draw(scene, clock, part, shadeT) {
      const cl = clusters(scene, PAD);
      gl.uniform2f(loc.uRes, canvas.width, canvas.height);
      gl.uniform1f(loc.uPx, px);
      gl.uniform1f(loc.uTime, clock % WRAP);
      gl.uniform1f(loc.uShadeT, shadeT % WRAP);
      if (part === 'core' && !fullClear) {
        // only Speak's cluster, tight around the liquid: the rest of the picture is kept as it is
        const c = cl[0], b = c.core ?? c, r = rect(b.x0 - 8, b.y0 - 8, b.x1 + 8, b.y1 + 8);     // the cards hold still: Speak's part only
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(r[0], r[1], r[2], r[3]); gl.clear(gl.COLOR_BUFFER_BIT);
        shade(r, c, scene);
        return;
      }
      const rects = cl.map(c => rect(c.x0 - PAD, c.y0 - PAD, c.x1 + PAD, c.y1 + PAD));
      if (fullClear) { gl.disable(gl.SCISSOR_TEST); gl.clear(gl.COLOR_BUFFER_BIT); fullClear = false; }
      gl.enable(gl.SCISSOR_TEST);
      for (const r of [...prev, ...rects]) { gl.scissor(r[0], r[1], r[2], r[3]); gl.clear(gl.COLOR_BUFFER_BIT); }   // where the liquid was, and where it is now
      cl.forEach((c, i) => shade(rects[i], c, scene));
      prev = rects;
    },
    release() { gl.getExtension('WEBGL_lose_context')?.loseContext(); },
  };
}
