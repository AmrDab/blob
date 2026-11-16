// Speech in the page: Whisper (multilingual base, 8-bit) through transformers.js on onnxruntime-web (wasm).
// Nothing is fetched until load() is called, which the UI does only after the user clicks Download (or once it is cached).

const MODEL = 'onnx-community/whisper-base';
const FILES = ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'];
/** encoder 23.2 MB + decoder 53.7 MB + tokenizer and config files 4.4 MB, as listed on the Hub. */
export const DOWNLOAD_MB = 81;

type Asr = (audio: Float32Array, options?: Record<string, unknown>) => Promise<unknown>;
let asr: Promise<Asr> | null = null;

/** True when both model files are already in the WebView's cache (transformers.js keys them by their Hub URL). */
export async function isDownloaded(): Promise<boolean> {
  try {
    const cache = await caches.open('transformers-cache');
    for (const f of FILES) if (!(await cache.match(`https://huggingface.co/${MODEL}/resolve/main/${f}`))) return false;
    return true;
  } catch { return false; }
}

export function load(onProgress: (percent: number) => void): Promise<Asr> {
  asr ??= (async () => {
    const t = await import('@huggingface/transformers');
    t.env.allowLocalModels = false;
    // onnxruntime's wasm comes from this app (dist/ort), not from a CDN.
    const wasm = t.env.backends.onnx.wasm!;
    wasm.wasmPaths = { mjs: '/ort/ort-wasm-simd-threaded.asyncify.mjs', wasm: '/ort/ort-wasm-simd-threaded.asyncify.wasm' };
    const pipe = await t.pipeline('automatic-speech-recognition', MODEL, {
      device: 'wasm',
      dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
      progress_callback: (p: { status: string; progress?: number }) => {
        if (p.status === 'progress_total' && typeof p.progress === 'number') onProgress(Math.round(p.progress));
      },
    });
    return pipe as unknown as Asr;
  })();
  asr.catch(() => { asr = null; });
  return asr;
}

/** Whisper here has no language detection: it takes the system language, else English. */
export async function transcribe(audio: Float32Array): Promise<string> {
  const run = await load(() => {});
  const language = navigator.language.slice(0, 2).toLowerCase();
  let out: unknown;
  try { out = await run(audio, { language, task: 'transcribe' }); } catch { out = await run(audio); }
  const text = (Array.isArray(out) ? out[0] : out) as { text?: string };
  return (text?.text ?? '').trim();
}

/** What the card says when the microphone could not be opened. On macOS a refusal comes with no system prompt:
 *  the microphone belongs to the app Blob was started from, and WebKit keeps its answer until Blob restarts. */
export function micProblemText(err: { name?: string; message?: string }, mac: boolean): string {
  if (err.name === 'NotFoundError') return 'No microphone found. Plug one in, then try Speak again.';
  if (mac && err.name === 'NotAllowedError') {
    return 'macOS has not given the microphone to the app Blob was started from. In System Settings, Privacy & Security, ' +
      'Microphone, turn it on for that app (Terminal or iTerm), then restart Blob.';
  }
  return `Blob can't use the microphone (${err.message ?? err.name ?? 'unknown error'}).`;
}

/** Records from the microphone; stop() gives 16 kHz mono samples. */
export class Recorder {
  /** The live microphone stream while recording (the voice ring reads its level). */
  stream?: MediaStream;
  private rec?: MediaRecorder;
  private chunks: Blob[] = [];

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true } });
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream);
    this.rec.ondataavailable = e => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start();
  }

  async stop(): Promise<Float32Array> {
    const rec = this.rec;
    if (!rec) return new Float32Array();
    const stopped = new Promise(r => { rec.onstop = r; });
    rec.stop();
    await stopped;
    this.stream?.getTracks().forEach(t => t.stop());
    this.rec = undefined;
    const blob = new Blob(this.chunks, { type: rec.mimeType });
    if (!blob.size) return new Float32Array();
    const ctx = new AudioContext({ sampleRate: 16000 });   // decodeAudioData resamples to the context's rate
    try { return (await ctx.decodeAudioData(await blob.arrayBuffer())).getChannelData(0); }
    finally { void ctx.close(); }
  }
}
