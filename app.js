import { removeBackground } from "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/dist/index.mjs";

const GIFUCT_URL = "https://cdn.jsdelivr.net/npm/gifuct-js@2.1.2/+esm";
const GIFJS_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.js";
const GIFJS_WORKER_URL = "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js";

// A chroma-key color used to mark "removed" pixels before GIF quantization,
// since GIF transparency is a single palette color, not a real alpha channel.
const KEY_COLOR = [255, 0, 220];
const KEY_COLOR_HEX = 0xff00dc;

const el = (id) => document.getElementById(id);
const dropzone = el("dropzone");
const fileInput = el("fileInput");
const optionsPanel = el("options");
const qualitySelect = el("quality");
const formatSelect = el("format");
const gpuCheckbox = el("gpu");
const thresholdRow = el("thresholdRow");
const thresholdInput = el("threshold");
const thresholdVal = el("thresholdVal");
const runBtn = el("runBtn");
const progressPanel = el("progressPanel");
const progressBar = el("progressBar");
const statusText = el("statusText");
const cancelBtn = el("cancelBtn");
const previewSection = el("previewSection");
const originalImg = el("originalImg");
const resultImg = el("resultImg");
const downloadBtn = el("downloadBtn");

let currentFile = null;
let cancelled = false;
let gifuctModule = null;
let gifJsReady = null;
let workerBlobUrl = null;

thresholdInput.addEventListener("input", () => {
  thresholdVal.textContent = thresholdInput.value;
});

formatSelect.addEventListener("change", () => {
  thresholdRow.hidden = formatSelect.value !== "gif";
});

["dragover", "dragenter"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files?.[0];
  if (file) selectFile(file);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files?.[0]) selectFile(fileInput.files[0]);
});

const pngOption = formatSelect.querySelector('option[value="png"]');

async function selectFile(file) {
  currentFile = file;
  optionsPanel.hidden = false;
  previewSection.hidden = true;
  downloadBtn.hidden = true;
  originalImg.src = URL.createObjectURL(file);

  pngOption.disabled = false;
  pngOption.textContent = "PNG (smoother edges, static images only)";
  if (looksLikeGif(file)) {
    setStatus("Checking GIF…");
    try {
      const { parseGIF, decompressFrames } = await ensureGifuct();
      const buf = await file.arrayBuffer();
      const parsed = parseGIF(buf);
      const count = decompressFrames(parsed, false).length;
      if (count > 1) {
        formatSelect.value = "gif";
        pngOption.disabled = true;
        pngOption.textContent = "PNG (unavailable — this GIF is animated)";
      }
    } catch (e) {
      console.warn("Could not pre-check GIF frame count", e);
    }
  }
  thresholdRow.hidden = formatSelect.value !== "gif";
}

runBtn.addEventListener("click", () => {
  if (!currentFile) return;
  run(currentFile).catch((err) => {
    console.error(err);
    setStatus("Error: " + (err?.message || String(err)));
    progressPanel.hidden = true;
    runBtn.disabled = false;
  });
});

cancelBtn.addEventListener("click", () => {
  cancelled = true;
  setStatus("Cancelling…");
});

function setStatus(msg) {
  statusText.textContent = msg;
}

function setProgress(fraction) {
  progressBar.style.width = Math.max(0, Math.min(1, fraction)) * 100 + "%";
}

async function loadScriptOnce(url) {
  if (document.querySelector(`script[src="${url}"]`)) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load " + url));
    document.head.appendChild(s);
  });
}

async function ensureGifuct() {
  if (!gifuctModule) gifuctModule = await import(GIFUCT_URL);
  return gifuctModule;
}

async function ensureGifJs() {
  if (!gifJsReady) {
    gifJsReady = loadScriptOnce(GIFJS_SCRIPT_URL);
  }
  await gifJsReady;
  if (!workerBlobUrl) {
    const src = await (await fetch(GIFJS_WORKER_URL)).text();
    workerBlobUrl = URL.createObjectURL(new Blob([src], { type: "application/javascript" }));
  }
}

function looksLikeGif(file) {
  return file.type === "image/gif" || /\.gif$/i.test(file.name);
}

// Reconstructs each frame as a full, standalone RGBA canvas by applying
// GIF disposal rules, since GIF frames usually only encode the changed region.
function buildFullFrames(frames, width, height) {
  const full = [];
  const composite = document.createElement("canvas");
  composite.width = width;
  composite.height = height;
  const cctx = composite.getContext("2d", { willReadFrequently: true });
  let savedForRestore = null;

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];

    if (i > 0) {
      const prev = frames[i - 1];
      if (prev.disposalType === 2) {
        cctx.clearRect(prev.dims.left, prev.dims.top, prev.dims.width, prev.dims.height);
      } else if (prev.disposalType === 3 && savedForRestore) {
        cctx.putImageData(savedForRestore, 0, 0);
      }
    }

    if (frame.disposalType === 3) {
      savedForRestore = cctx.getImageData(0, 0, width, height);
    }

    const patchCanvas = document.createElement("canvas");
    patchCanvas.width = frame.dims.width;
    patchCanvas.height = frame.dims.height;
    patchCanvas
      .getContext("2d")
      .putImageData(new ImageData(frame.patch, frame.dims.width, frame.dims.height), 0, 0);
    cctx.drawImage(patchCanvas, frame.dims.left, frame.dims.top);

    const frameCanvas = document.createElement("canvas");
    frameCanvas.width = width;
    frameCanvas.height = height;
    frameCanvas.getContext("2d").drawImage(composite, 0, 0);
    full.push({ canvas: frameCanvas, delay: frame.delay || 100 });
  }

  return full;
}

function keyOutTransparency(imageData, threshold) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < threshold) {
      d[i] = KEY_COLOR[0];
      d[i + 1] = KEY_COLOR[1];
      d[i + 2] = KEY_COLOR[2];
      d[i + 3] = 255;
    } else {
      d[i + 3] = 255;
    }
  }
  return imageData;
}

async function blobToCanvas(blob, width, height) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  return canvas;
}

function canvasToBlob(canvas, type = "image/png") {
  return new Promise((resolve) => canvas.toBlob(resolve, type));
}

async function encodeGif(frames, width, height) {
  await ensureGifJs();
  return new Promise((resolve, reject) => {
    const gif = new window.GIF({
      workers: 2,
      quality: 10,
      workerScript: workerBlobUrl,
      width,
      height,
      transparent: KEY_COLOR_HEX,
      repeat: 0,
    });
    gif.on("finished", (blob) => resolve(blob));
    gif.on("abort", () => reject(new Error("GIF encoding aborted")));
    for (const f of frames) {
      gif.addFrame(f.canvas, { delay: f.delay, copy: true });
    }
    gif.render();
  });
}

async function run(file) {
  cancelled = false;
  runBtn.disabled = true;
  optionsPanel.hidden = true;
  progressPanel.hidden = false;
  previewSection.hidden = true;
  cancelBtn.hidden = false;
  setProgress(0);

  const model = qualitySelect.value;
  const device = gpuCheckbox.checked ? "gpu" : "cpu";
  const outputFormat = formatSelect.value;
  const threshold = parseInt(thresholdInput.value, 10);

  const removalConfig = {
    model,
    device,
    output: { format: "image/png", quality: 1 },
  };

  let resultBlob;
  let isAnimated = false;

  if (looksLikeGif(file)) {
    setStatus("Decoding GIF…");
    const { parseGIF, decompressFrames } = await ensureGifuct();
    const buf = await file.arrayBuffer();
    const parsed = parseGIF(buf);
    const rawFrames = decompressFrames(parsed, true);
    const width = parsed.lsd.width;
    const height = parsed.lsd.height;

    if (rawFrames.length > 1) {
      isAnimated = true;
      const fullFrames = buildFullFrames(rawFrames, width, height);
      const processed = [];

      for (let i = 0; i < fullFrames.length; i++) {
        if (cancelled) throw new Error("Cancelled");
        setStatus(`Removing background — frame ${i + 1} of ${fullFrames.length}`);
        setProgress(i / fullFrames.length);

        const srcBlob = await canvasToBlob(fullFrames[i].canvas);
        const cutBlob = await removeBackground(srcBlob, removalConfig);
        const outCanvas = await blobToCanvas(cutBlob, width, height);
        const ctx = outCanvas.getContext("2d", { willReadFrequently: true });
        const imgData = keyOutTransparency(ctx.getImageData(0, 0, width, height), threshold);
        ctx.putImageData(imgData, 0, 0);
        processed.push({ canvas: outCanvas, delay: fullFrames[i].delay });
      }

      setStatus("Encoding animated GIF…");
      setProgress(0.97);
      resultBlob = await encodeGif(processed, width, height);
    } else {
      setStatus("Removing background…");
      const srcBlob = await canvasToBlob(fullFrames0(rawFrames, width, height));
      resultBlob = await finishStatic(srcBlob, width, height, removalConfig, outputFormat, threshold);
    }
  } else {
    setStatus("Removing background…");
    resultBlob = await finishStatic(file, null, null, removalConfig, outputFormat, threshold, (key, cur, total) => {
      if (key.startsWith("fetch")) {
        setStatus(`Downloading model… ${Math.round((cur / total) * 100)}%`);
      } else {
        setStatus("Removing background…");
      }
    });
  }

  if (cancelled) throw new Error("Cancelled");

  setProgress(1);
  setStatus(isAnimated ? "Done" : "Done");
  cancelBtn.hidden = true;
  progressPanel.hidden = true;
  runBtn.disabled = false;

  previewSection.hidden = false;
  const url = URL.createObjectURL(resultBlob);
  resultImg.src = url;
  downloadBtn.hidden = false;
  downloadBtn.onclick = () => {
    const a = document.createElement("a");
    a.href = url;
    const ext = resultBlob.type === "image/gif" ? "gif" : "png";
    a.download = (file.name.replace(/\.[^.]+$/, "") || "result") + "-nobg." + ext;
    a.click();
  };
}

function fullFrames0(rawFrames, width, height) {
  return buildFullFrames(rawFrames, width, height)[0].canvas;
}

async function finishStatic(srcBlob, width, height, removalConfig, outputFormat, threshold, onProgress) {
  const cfg = onProgress ? { ...removalConfig, progress: onProgress } : removalConfig;
  const cutBlob = await removeBackground(srcBlob, cfg);
  if (outputFormat === "png") return cutBlob;

  const bitmap = await createImageBitmap(cutBlob);
  const w = width || bitmap.width;
  const h = height || bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const imgData = keyOutTransparency(ctx.getImageData(0, 0, w, h), threshold);
  ctx.putImageData(imgData, 0, 0);
  return encodeGif([{ canvas, delay: 100 }], w, h);
}
