/**
 * avif-worker.js — runs off the main thread so the page never freezes.
 *
 * Jobs:
 *   "avif" → encodes ImageData with @jsquash/avif, searching for the highest
 *            quality that stays under the size limit, then decodes the result
 *            and measures SSIM against the uncompressed reference.
 *   "ssim" → measures SSIM between two ImageData-like objects (used for the JPEG).
 */

const JSQUASH_VERSION = '2.1.1';
const JSQUASH_BASE = `https://cdn.jsdelivr.net/npm/@jsquash/avif@${JSQUASH_VERSION}`;

let encodeAvif;
let decodeAvif;

// ---------------------------------------------------------------------------
// Codec setup
// ---------------------------------------------------------------------------

async function compileWasm(url) {
  try {
    return await WebAssembly.compileStreaming(fetch(url));
  } catch {
    // Some servers send the wrong MIME type for .wasm; compile from bytes instead.
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not download ${url} (HTTP ${response.status})`);
    return WebAssembly.compile(await response.arrayBuffer());
  }
}

async function initCodecs() {
  const t0 = performance.now();

  if (self.crossOriginIsolated) {
    // In a cross-origin isolated page jSquash switches to its multi-threaded build,
    // which needs extra files that the CDN build can't locate.
    throw new Error(
      'This page is cross-origin isolated (COOP/COEP headers). Serve it without those headers so the single-threaded AVIF encoder is used.'
    );
  }

  const [encModule, decModule, encWasm, decWasm] = await Promise.all([
    import(`${JSQUASH_BASE}/encode.js/+esm`),
    import(`${JSQUASH_BASE}/decode.js/+esm`),
    compileWasm(`${JSQUASH_BASE}/codec/enc/avif_enc.wasm`),
    compileWasm(`${JSQUASH_BASE}/codec/dec/avif_dec.wasm`),
  ]);

  // Passing the compiled WebAssembly.Module explicitly means the codec never
  // has to guess where its .wasm file lives.
  await encModule.init(encWasm);
  await decModule.init(decWasm);

  encodeAvif = encModule.default;
  decodeAvif = decModule.default;

  return performance.now() - t0;
}

const ready = initCodecs();
ready
  .then((ms) => self.postMessage({ type: 'ready', ms }))
  .catch((err) => self.postMessage({ type: 'init-error', message: err.message || String(err) }));

// ---------------------------------------------------------------------------
// SSIM
// ---------------------------------------------------------------------------

/**
 * Converts RGBA to luma (BT.601). Transparent pixels are composited over white
 * so both images are compared the way they would look on a white page.
 */
function toLuma({ data, width, height }) {
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const a = data[p + 3] / 255;
    const bg = 255 * (1 - a);
    const r = data[p] * a + bg;
    const g = data[p + 1] * a + bg;
    const b = data[p + 2] * a + bg;
    out[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return out;
}

/**
 * Mean SSIM over 8×8 windows with a stride of 4 px, computed on luma.
 * Constants follow Wang et al. (2004): K1 = 0.01, K2 = 0.03, L = 255.
 */
function ssim(imgA, imgB) {
  const { width, height } = imgA;
  if (width !== imgB.width || height !== imgB.height) {
    throw new Error(`SSIM needs equal sizes (${width}×${height} vs ${imgB.width}×${imgB.height})`);
  }

  const a = toLuma(imgA);
  const b = toLuma(imgB);

  const win = Math.max(1, Math.min(8, width, height));
  const step = Math.max(1, win >> 1);
  const n = win * win;
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;

  let total = 0;
  let windows = 0;

  for (let y0 = 0; y0 + win <= height; y0 += step) {
    for (let x0 = 0; x0 + win <= width; x0 += step) {
      let sumA = 0, sumB = 0, sumAA = 0, sumBB = 0, sumAB = 0;
      for (let y = y0; y < y0 + win; y++) {
        let i = y * width + x0;
        for (let x = 0; x < win; x++, i++) {
          const va = a[i];
          const vb = b[i];
          sumA += va;
          sumB += vb;
          sumAA += va * va;
          sumBB += vb * vb;
          sumAB += va * vb;
        }
      }
      const muA = sumA / n;
      const muB = sumB / n;
      const varA = sumAA / n - muA * muA;
      const varB = sumBB / n - muB * muB;
      const cov = sumAB / n - muA * muB;

      total +=
        ((2 * muA * muB + C1) * (2 * cov + C2)) /
        ((muA * muA + muB * muB + C1) * (varA + varB + C2));
      windows++;
    }
  }

  return windows ? total / windows : 1;
}

// ---------------------------------------------------------------------------
// AVIF encode with size limit
// ---------------------------------------------------------------------------

async function encodeUnderLimit(job, report) {
  const { image, maxBytes, startQuality, speed } = job;
  const attempts = [];
  let encodeMs = 0;

  const tryQuality = async (quality) => {
    const t0 = performance.now();
    const buffer = await encodeAvif(image, { quality, speed });
    const ms = performance.now() - t0;
    encodeMs += ms;
    const fits = buffer.byteLength <= maxBytes;
    attempts.push({ quality, bytes: buffer.byteLength, ms, fits });
    report(`Quality ${quality}: ${formatKB(buffer.byteLength)} in ${Math.round(ms)} ms${fits ? '' : ' (over limit)'}`);
    return { quality, buffer, fits };
  };

  // 1. Try the starting quality. If it already fits, keep it — no reason to spend more bytes.
  let best = await tryQuality(startQuality);

  // 2. Otherwise binary-search downwards for the highest quality that fits.
  if (!best.fits) {
    let smallest = best;
    best = null;
    let lo = 0;
    let hi = startQuality - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const attempt = await tryQuality(mid);
      if (attempt.buffer.byteLength < smallest.buffer.byteLength) smallest = attempt;
      if (attempt.fits) {
        best = attempt;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // Nothing fits even at quality 0: return the smallest file and flag it.
    if (!best) best = smallest;
  }

  return { ...best, attempts, encodeMs };
}

function formatKB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

self.onmessage = async (event) => {
  const { id, type, payload } = event.data;
  const report = (text) => self.postMessage({ type: 'progress', id, text });

  try {
    await ready;

    if (type === 'avif') {
      const encoded = await encodeUnderLimit(payload, report);

      report('Decoding AVIF to measure SSIM…');
      const tDec = performance.now();
      const decoded = await decodeAvif(encoded.buffer);
      const decodeMs = performance.now() - tDec;

      const tSsim = performance.now();
      const score = ssim(payload.image, decoded);
      const ssimMs = performance.now() - tSsim;

      self.postMessage(
        {
          type: 'result',
          id,
          result: {
            buffer: encoded.buffer,
            quality: encoded.quality,
            fits: encoded.fits,
            attempts: encoded.attempts,
            encodeMs: encoded.encodeMs,
            decodeMs,
            ssimMs,
            ssim: score,
          },
        },
        [encoded.buffer]
      );
      return;
    }

    if (type === 'ssim') {
      const t0 = performance.now();
      const score = ssim(payload.a, payload.b);
      self.postMessage({ type: 'result', id, result: { ssim: score, ssimMs: performance.now() - t0 } });
      return;
    }

    throw new Error(`Unknown job type "${type}"`);
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err.message || String(err) });
  }
};
