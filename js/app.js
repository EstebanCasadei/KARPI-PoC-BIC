(() => {
  'use strict';

  // -------------------------------------------------------------------------
  // Output specs
  // -------------------------------------------------------------------------
  const OUTPUTS = [
    { key: 'thumbnail', title: 'Thumbnail', format: 'AVIF', note: '800 px wide, height auto, never upscaled' },
    { key: 'main',      title: 'Main',      format: 'AVIF', note: 'Fits inside 1920 × 2800 px, keeps proportions, never upscaled' },
    { key: 'og',        title: 'Open Graph', format: 'JPEG', note: 'Exactly 1200 × 630 px, centre crop, white behind transparency' },
  ];

  const $ = (id) => document.getElementById(id);
  const lib = window.imageCompression;

  // -------------------------------------------------------------------------
  // Worker bridge
  // -------------------------------------------------------------------------
  const worker = new Worker('./js/avif-worker.js', { type: 'module' });
  const pending = new Map();
  let nextJobId = 1;
  let codecReady = false;
  let resolveCodec, rejectCodec;
  const codecReadyPromise = new Promise((res, rej) => { resolveCodec = res; rejectCodec = rej; });
  codecReadyPromise.catch(() => {});

  worker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === 'ready') {
      codecReady = true;
      setCodecStatus('ready', `AVIF encoder ready (loaded in ${formatMs(msg.ms)}).`);
      resolveCodec();
      return;
    }
    if (msg.type === 'init-error') {
      setCodecStatus('error', `The AVIF encoder didn’t load: ${msg.message}`);
      rejectCodec(new Error(msg.message));
      return;
    }
    const job = pending.get(msg.id);
    if (!job) return;
    if (msg.type === 'progress') job.onProgress?.(msg.text);
    if (msg.type === 'result') { pending.delete(msg.id); job.resolve(msg.result); }
    if (msg.type === 'error')  { pending.delete(msg.id); job.reject(new Error(msg.message)); }
  };
  worker.onerror = (event) => {
    const text = event.message || 'The worker script failed to start. Serve this folder over http://, not file://.';
    setCodecStatus('error', `The AVIF encoder didn’t load: ${text}`);
    rejectCodec(new Error(text));
  };

  function runInWorker(type, payload, transfer = [], onProgress) {
    const id = nextJobId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ id, type, payload }, transfer);
    });
  }

  function setCodecStatus(state, text) {
    $('codecStatus').dataset.state = state;
    $('codecStatusText').textContent = text;
  }

  // -------------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------------
  function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  function formatMs(ms) {
    return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
  }
  function formatRatio(r) {
    return `${r >= 10 ? r.toFixed(1) : r.toFixed(2)} : 1`;
  }
  function ssimLabel(v) {
    if (v >= 0.98) return 'visually identical';
    if (v >= 0.95) return 'excellent';
    if (v >= 0.90) return 'good';
    return 'visible loss';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // -------------------------------------------------------------------------
  // Canvas helpers (native canvas only)
  // -------------------------------------------------------------------------
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function ctx2d(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return ctx;
  }

  /**
   * High-quality resize. Big reductions are done in halving steps so the result
   * doesn't alias, then one final draw lands on the exact size.
   */
  function resizeCanvas(src, w, h) {
    let current = src;
    let cw = src.width;
    let ch = src.height;
    while (cw / 2 >= w && ch / 2 >= h) {
      cw = Math.round(cw / 2);
      ch = Math.round(ch / 2);
      const step = makeCanvas(cw, ch);
      ctx2d(step).drawImage(current, 0, 0, cw, ch);
      current = step;
    }
    const out = makeCanvas(w, h);
    ctx2d(out).drawImage(current, 0, 0, w, h);
    return out;
  }

  /** Scale to cover the target box, then crop the centre. Fills white first for JPEG. */
  function coverCrop(src, tw, th) {
    const scale = Math.max(tw / src.width, th / src.height);
    const sw = Math.max(tw, Math.round(src.width * scale));
    const sh = Math.max(th, Math.round(src.height * scale));
    const scaled = scale < 1 ? resizeCanvas(src, sw, sh) : src;
    const out = makeCanvas(tw, th);
    const ctx = ctx2d(out);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, tw, th);
    if (scale < 1) {
      ctx.drawImage(scaled, Math.round((sw - tw) / 2), Math.round((sh - th) / 2), tw, th, 0, 0, tw, th);
    } else {
      // Source is smaller than 1200 × 630: OG needs the exact size, so this one does upscale.
      const cropW = tw / scale;
      const cropH = th / scale;
      ctx.drawImage(src, (src.width - cropW) / 2, (src.height - cropH) / 2, cropW, cropH, 0, 0, tw, th);
    }
    return out;
  }

  function readPixels(canvas) {
    return ctx2d(canvas).getImageData(0, 0, canvas.width, canvas.height);
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(`Canvas could not export ${type}`))), type, quality)
    );
  }

  /** Target size for "max width, height auto, no upscaling". */
  function fitWidth(src, maxW) {
    const scale = Math.min(1, maxW / src.width);
    return { w: Math.max(1, Math.round(src.width * scale)), h: Math.max(1, Math.round(src.height * scale)) };
  }

  /** Target size for "fit inside a box, keep proportions, no upscaling". */
  function fitInside(src, maxW, maxH) {
    const scale = Math.min(1, maxW / src.width, maxH / src.height);
    return { w: Math.max(1, Math.round(src.width * scale)), h: Math.max(1, Math.round(src.height * scale)) };
  }

  // -------------------------------------------------------------------------
  // Decoding the input with browser-image-compression
  // -------------------------------------------------------------------------
  async function decodeInput(file) {
    let canvas;
    try {
      [, canvas] = await lib.drawFileInCanvas(file);
    } catch {
      const kind = file.type || file.name.split('.').pop().toUpperCase() || 'this file';
      throw new Error(
        `This browser can’t decode ${kind}. HEIC and TIFF open only in Safari; RAW formats aren’t supported by any browser. Convert the file to JPEG or PNG and try again.`
      );
    }
    // Modern browsers apply EXIF orientation themselves. For older ones, use the library's fix.
    if (!(await lib.isAutoOrientationInBrowser())) {
      const orientation = await lib.getExifOrientation(file);
      if (orientation > 1) canvas = lib.followExifOrientation(canvas, orientation);
    }
    return canvas;
  }

  // -------------------------------------------------------------------------
  // UI building
  // -------------------------------------------------------------------------
  function buildVariantCards() {
    const wrap = $('variants');
    wrap.innerHTML = '';
    const cards = {};
    for (const spec of OUTPUTS) {
      const el = document.createElement('article');
      el.className = 'variant';
      el.dataset.state = 'waiting';
      el.innerHTML = `
        <header>
          <h3>${spec.title} · ${spec.format}</h3>
          <p>${spec.note}</p>
        </header>
        <div>
          <div class="frame"><img alt="${spec.title} output preview"></div>
          <div class="dims">Waiting…</div>
        </div>
        <ul class="log" aria-live="polite"><li>Waiting for its turn.</li></ul>
        <dl class="facts" hidden></dl>
        <a class="download" hidden>Download</a>`;
      wrap.appendChild(el);
      cards[spec.key] = {
        root: el,
        img: el.querySelector('img'),
        dims: el.querySelector('.dims'),
        log: el.querySelector('.log'),
        facts: el.querySelector('.facts'),
        download: el.querySelector('.download'),
      };
    }
    return cards;
  }

  function logLine(card, text, reset = false) {
    if (reset) card.log.innerHTML = '';
    const li = document.createElement('li');
    li.textContent = text;
    card.log.appendChild(li);
    card.log.scrollTop = card.log.scrollHeight;
  }

  function showFacts(dl, rows) {
    dl.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('');
    dl.hidden = false;
  }

  // -------------------------------------------------------------------------
  // Pipelines
  // -------------------------------------------------------------------------
  async function makeAvif(spec, src, size, settings, card, originalBytes) {
    const t0 = performance.now();
    card.root.dataset.state = 'running';
    logLine(card, `Resizing to ${size.w} × ${size.h} px…`, true);

    const resized = resizeCanvas(src, size.w, size.h);
    const reference = readPixels(resized);
    const resizeMs = performance.now() - t0;

    const result = await runInWorker(
      'avif',
      {
        image: { data: reference.data, width: reference.width, height: reference.height },
        maxBytes: settings.maxBytes,
        startQuality: settings.avifQuality,
        speed: settings.avifSpeed,
      },
      [reference.data.buffer],
      (text) => logLine(card, text)
    );

    const blob = new Blob([result.buffer], { type: 'image/avif' });
    const totalMs = performance.now() - t0;

    return {
      key: spec.key,
      title: spec.title,
      format: 'AVIF',
      width: size.w,
      height: size.h,
      blob,
      bytes: blob.size,
      withinLimit: result.fits,
      quality: result.quality,
      attempts: result.attempts.length,
      ratioOriginal: originalBytes / blob.size,
      ratioRaw: (size.w * size.h * 4) / blob.size,
      ssim: result.ssim,
      compressionMs: result.encodeMs,
      resizeMs,
      decodeMs: result.decodeMs,
      ssimMs: result.ssimMs,
      totalMs,
    };
  }

  async function makeOgJpeg(spec, src, settings, card, originalBytes) {
    const W = 1200, H = 630;
    const t0 = performance.now();
    card.root.dataset.state = 'running';
    logLine(card, `Cropping the centre to ${W} × ${H} px…`, true);

    const cropped = coverCrop(src, W, H);
    const reference = readPixels(cropped);
    // Lossless hand-off to the library (native PNG, so no colour quantisation).
    const pngBlob = await canvasToBlob(cropped, 'image/png');
    const pngFile = new File([pngBlob], 'og-source.png', { type: 'image/png', lastModified: Date.now() });
    const resizeMs = performance.now() - t0;

    logLine(card, `Compressing with browser-image-compression from quality ${settings.jpegQuality}…`);
    const tc = performance.now();
    const jpeg = await lib(pngFile, {
      fileType: 'image/jpeg',
      maxSizeMB: settings.maxBytes / (1024 * 1024),
      initialQuality: settings.jpegQuality / 100,
      alwaysKeepResolution: true, // never shrink the OG below 1200 × 630
      maxIteration: 30,
      useWebWorker: false,        // the heavy work already runs in our own worker
    });
    const compressionMs = performance.now() - tc;
    logLine(card, `JPEG: ${formatBytes(jpeg.size)} in ${formatMs(compressionMs)}`);

    logLine(card, 'Decoding JPEG to measure SSIM…');
    const td = performance.now();
    const bitmap = await createImageBitmap(jpeg);
    const back = makeCanvas(bitmap.width, bitmap.height);
    ctx2d(back).drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const decoded = readPixels(back);
    const decodeMs = performance.now() - td;

    const { ssim, ssimMs } = await runInWorker(
      'ssim',
      {
        a: { data: reference.data, width: reference.width, height: reference.height },
        b: { data: decoded.data, width: decoded.width, height: decoded.height },
      },
      [reference.data.buffer, decoded.data.buffer]
    );

    const blob = jpeg.type === 'image/jpeg' ? jpeg : new Blob([jpeg], { type: 'image/jpeg' });
    return {
      key: spec.key,
      title: spec.title,
      format: 'JPEG',
      width: W,
      height: H,
      blob,
      bytes: blob.size,
      withinLimit: blob.size <= settings.maxBytes,
      quality: null,
      attempts: null,
      ratioOriginal: originalBytes / blob.size,
      ratioRaw: (W * H * 4) / blob.size,
      ssim,
      compressionMs,
      resizeMs,
      decodeMs,
      ssimMs,
      totalMs: performance.now() - t0,
    };
  }

  function renderVariant(card, r, baseName) {
    const url = URL.createObjectURL(r.blob);
    card.img.src = url;
    card.dims.textContent = `${r.width} × ${r.height} px`;
    card.root.dataset.state = 'done';
    logLine(card, `Done in ${formatMs(r.totalMs)}.`);

    const limitText = r.withinLimit
      ? '<span class="ok">Under the limit</span>'
      : '<span class="over">Over the limit even at the lowest quality</span>';

    const rows = [
      ['Final size', `${formatBytes(r.bytes)} · ${limitText}`],
      ['Ratio vs original', formatRatio(r.ratioOriginal)],
      ['Ratio vs raw bitmap', formatRatio(r.ratioRaw)],
      ['SSIM', `${r.ssim.toFixed(4)} (${ssimLabel(r.ssim)})`],
      ['Compression time', formatMs(r.compressionMs)],
      ['Total time', formatMs(r.totalMs)],
    ];
    if (r.quality !== null) rows.splice(1, 0, ['AVIF quality used', `${r.quality} (${r.attempts} ${r.attempts === 1 ? 'attempt' : 'attempts'})`]);
    showFacts(card.facts, rows);

    const ext = r.format === 'AVIF' ? 'avif' : 'jpg';
    card.download.href = url;
    card.download.download = `${baseName}-${r.key}.${ext}`;
    card.download.textContent = `Download ${r.title.toLowerCase()} (.${ext})`;
    card.download.hidden = false;
  }

  function renderSummary(results, pipelineMs, original) {
    const body = $('summaryBody');
    body.innerHTML = results
      .map(
        (r) => `<tr>
          <td>${r.title}<span class="sub">${r.format}</span></td>
          <td>${r.width} × ${r.height}</td>
          <td>${formatBytes(r.bytes)}<span class="sub ${r.withinLimit ? 'ok' : 'over'}">${r.withinLimit ? 'under limit' : 'over limit'}</span></td>
          <td>${formatRatio(r.ratioOriginal)}</td>
          <td>${formatRatio(r.ratioRaw)}</td>
          <td>${r.ssim.toFixed(4)}<span class="sub">${ssimLabel(r.ssim)}</span></td>
          <td>${formatMs(r.compressionMs)}</td>
          <td>${formatMs(r.totalMs)}</td>
        </tr>`
      )
      .join('');

    const totalBytes = results.reduce((s, r) => s + r.bytes, 0);
    const totalCompression = results.reduce((s, r) => s + r.compressionMs, 0);
    const meanSsim = results.reduce((s, r) => s + r.ssim, 0) / results.length;
    $('summaryFoot').innerHTML = `<tr>
        <td>All three<span class="sub">original decode ${formatMs(original.decodeMs)}</span></td>
        <td></td>
        <td>${formatBytes(totalBytes)}</td>
        <td>${formatRatio(original.bytes / totalBytes)}<span class="sub">all outputs combined</span></td>
        <td></td>
        <td>${meanSsim.toFixed(4)}<span class="sub">mean</span></td>
        <td>${formatMs(totalCompression)}</td>
        <td>${formatMs(pipelineMs)}<span class="sub">wall-clock</span></td>
      </tr>`;
  }

  // -------------------------------------------------------------------------
  // Main flow
  // -------------------------------------------------------------------------
  let currentFile = null;
  let lastReport = null;
  let busy = false;
  let objectUrls = [];

  function readSettings() {
    const clamp = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
    const limitKB = clamp(parseFloat($('limitKB').value), 10, 10000, 600);
    return {
      limitKB,
      maxBytes: Math.floor(limitKB * 1024),
      avifQuality: Math.round(clamp(parseFloat($('avifQuality').value), 1, 100, 60)),
      avifSpeed: Math.round(clamp(parseFloat($('avifSpeed').value), 0, 10, 6)),
      jpegQuality: Math.round(clamp(parseFloat($('jpegQuality').value), 1, 100, 85)),
    };
  }

  function showError(text) {
    $('errorBox').textContent = text;
    $('errorBox').hidden = false;
  }

  async function run(file) {
    if (busy) return;
    busy = true;
    $('rerunBtn').disabled = true;
    $('errorBox').hidden = true;
    $('summarySection').hidden = true;
    objectUrls.forEach(URL.revokeObjectURL);
    objectUrls = [];

    const settings = readSettings();
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';

    try {
      if (!codecReady) {
        setCodecStatus('loading', 'Waiting for the AVIF encoder to finish loading…');
        await codecReadyPromise;
      }

      const t0 = performance.now();

      // 1. Decode the original
      const src = await decodeInput(file);
      const decodeMs = performance.now() - t0;

      const previewUrl = URL.createObjectURL(file);
      objectUrls.push(previewUrl);
      $('originalImg').src = previewUrl;
      $('originalDims').textContent = `${src.width} × ${src.height} px`;
      showFacts($('originalFacts'), [
        ['File', escapeHtml(file.name)],
        ['Type', escapeHtml(file.type || 'unknown')],
        ['Size', formatBytes(file.size)],
        ['Dimensions', `${src.width} × ${src.height} px (after EXIF orientation)`],
        ['Raw bitmap', formatBytes(src.width * src.height * 4)],
        ['Decode time', formatMs(decodeMs)],
        ['Size limit', `${settings.limitKB} KB (${settings.maxBytes.toLocaleString('en-US')} bytes)`],
      ]);
      $('originalSection').hidden = false;

      // 2. Produce the three outputs, one after another so timings don't overlap
      const cards = buildVariantCards();
      $('variantsSection').hidden = false;

      const results = [];
      const thumb = await makeAvif(OUTPUTS[0], src, fitWidth(src, 800), settings, cards.thumbnail, file.size);
      renderVariant(cards.thumbnail, thumb, baseName);
      results.push(thumb);

      const main = await makeAvif(OUTPUTS[1], src, fitInside(src, 1920, 2800), settings, cards.main, file.size);
      renderVariant(cards.main, main, baseName);
      results.push(main);

      const og = await makeOgJpeg(OUTPUTS[2], src, settings, cards.og, file.size);
      renderVariant(cards.og, og, baseName);
      results.push(og);

      objectUrls.push(...results.map((r) => cards[r.key].img.src));
      const pipelineMs = performance.now() - t0;

      // 3. Summary
      renderSummary(results, pipelineMs, { bytes: file.size, decodeMs });
      $('summarySection').hidden = false;

      lastReport = {
        file: { name: file.name, type: file.type, bytes: file.size, width: src.width, height: src.height },
        settings,
        decodeMs: +decodeMs.toFixed(1),
        pipelineMs: +pipelineMs.toFixed(1),
        outputs: results.map(({ blob, ...r }) => ({
          ...r,
          ssim: +r.ssim.toFixed(5),
          ratioOriginal: +r.ratioOriginal.toFixed(3),
          ratioRaw: +r.ratioRaw.toFixed(3),
          compressionMs: +r.compressionMs.toFixed(1),
          resizeMs: +r.resizeMs.toFixed(1),
          decodeMs: +r.decodeMs.toFixed(1),
          ssimMs: +r.ssimMs.toFixed(1),
          totalMs: +r.totalMs.toFixed(1),
        })),
        userAgent: navigator.userAgent,
      };
    } catch (err) {
      console.error(err);
      document.querySelectorAll('.variant[data-state="running"]').forEach((el) => {
        el.dataset.state = 'error';
        const li = document.createElement('li');
        li.textContent = `Stopped: ${err.message}`;
        el.querySelector('.log').appendChild(li);
      });
      showError(err.message || String(err));
    } finally {
      busy = false;
      $('rerunBtn').disabled = !currentFile;
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------
  function accept(file) {
    if (!file) return;
    currentFile = file;
    run(file);
  }

  const SAMPLE_URL = './assets/sample.jpg';

  async function loadSample() {
    const btn = $('sampleBtn');
    btn.disabled = true;
    try {
      const response = await fetch(SAMPLE_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      accept(new File([blob], 'sample.jpg', { type: blob.type || 'image/jpeg', lastModified: Date.now() }));
    } catch (err) {
      showError(`The sample photo couldn’t be loaded (${err.message}). Serve this folder over http://, not file://.`);
    } finally {
      btn.disabled = false;
    }
  }

  $('sampleBtn').addEventListener('click', loadSample);
  $('settings').addEventListener('submit', (e) => e.preventDefault());
  $('fileInput').addEventListener('change', (e) => accept(e.target.files[0]));
  $('rerunBtn').addEventListener('click', () => currentFile && run(currentFile));

  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((t) =>
    drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('is-over'); })
  );
  ['dragleave', 'drop'].forEach((t) =>
    drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('is-over'); })
  );
  drop.addEventListener('drop', (e) => accept(e.dataTransfer.files[0]));

  $('copyBtn').addEventListener('click', async () => {
    if (!lastReport) return;
    const btn = $('copyBtn');
    try {
      await navigator.clipboard.writeText(JSON.stringify(lastReport, null, 2));
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Copy failed — see console';
      console.log(lastReport);
    }
    setTimeout(() => (btn.textContent = 'Copy results as JSON'), 1600);
  });

  if (!lib) {
    showError('browser-image-compression didn’t load from the CDN. Check your connection and reload.');
  }
})();
