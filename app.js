import { removeBackground } from "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/dist/index.mjs";

const CDN = "https://cdn.jsdelivr.net/npm/";
const $ = (sel, root = document) => root.querySelector(sel);
const lazy = (fn) => { let p = null; return () => (p ??= fn().catch((e) => { p = null; throw e; })); };

const getGifuct = lazy(() => import(CDN + "gifuct-js@2.1.2/+esm"));
const getHeicTo = lazy(async () => (await import(CDN + "heic-to@1.5.2/dist/heic-to.js")).heicTo);
const getFflate = lazy(() => import(CDN + "fflate@0.8.3/esm/browser.js"));
const getGifWorker = lazy(async () => {
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = CDN + "gif.js@0.2.0/dist/gif.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't load the GIF encoder."));
    document.head.append(s);
  });
  // Workers can't be created from a cross-origin URL, so run the CDN script from a same-origin blob.
  const src = await (await fetch(CDN + "gif.js@0.2.0/dist/gif.worker.js")).text();
  return URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
});

class UserError extends Error {}

// ---------- settings ----------
// fp16 costs a bigger one-time download than the quantized model but runs just as fast
// and leaves far fewer stray specks in the background.
const DEFAULTS = { model: "isnet_fp16", gpu: true, cutoff: 128 };
const settings = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("peel.settings") || "{}") }; }
  catch { return { ...DEFAULTS }; }
})();
for (const input of document.querySelectorAll("[data-setting]")) {
  const key = input.dataset.setting;
  if (input.type === "checkbox") input.checked = settings[key];
  else input.value = settings[key];
  const sync = (persist) => {
    settings[key] = input.type === "checkbox" ? input.checked : input.type === "range" ? +input.value : input.value;
    if (key === "cutoff") $("#cutoffVal").textContent = settings.cutoff;
    if (!persist) return;
    const changed = Object.fromEntries(Object.entries(settings).filter(([k, v]) => v !== DEFAULTS[k]));
    try { localStorage.setItem("peel.settings", JSON.stringify(changed)); } catch {}
  };
  input.addEventListener("input", () => sync(true));
  sync(false);
}
$("#settingsBtn").addEventListener("click", () => {
  const panel = $("#settings");
  panel.hidden = !panel.hidden;
  $("#settingsBtn").setAttribute("aria-expanded", String(!panel.hidden));
});

// ---------- model ----------
// The library memoizes its first config, so progress is reported through one global callback.
const fetches = new Map();
let current = null;
let bannerTimer = null;
function onProgress(key, done, total) {
  if (key.startsWith("fetch:")) {
    fetches.set(key, [done, total]);
    let d = 0, t = 0;
    for (const [a, b] of fetches.values()) { d += a; t += b; }
    const finished = d >= t;
    if (finished) {
      clearTimeout(bannerTimer);
      bannerTimer = null;
      $("#model").hidden = true;
    } else if (!bannerTimer && $("#model").hidden) {
      bannerTimer = setTimeout(() => { if (fetches.size) $("#model").hidden = false; }, 400);
    }
    $("#modelMsg").textContent = `Downloading the AI model (${Math.round(t / 1e6)} MB, first time only)… ${Math.round((d / t) * 100)}%`;
    $("#modelBar").style.width = `${(d / t) * 100}%`;
  } else if (key.startsWith("compute:") && current?.kind === "still") {
    setProgress(current, done / total);
  }
}

let gpuBroken = false;
async function cutout(blob) {
  const device = settings.gpu && !gpuBroken && "gpu" in navigator ? "gpu" : "cpu";
  try {
    return await removeBackground(blob, { model: settings.model, device, output: { format: "image/png" }, progress: onProgress });
  } catch (e) {
    if (device !== "gpu") throw e;
    console.warn("GPU inference failed, retrying on the CPU", e);
    gpuBroken = true;
    return cutout(blob);
  }
}

// ---------- image helpers ----------
const canvasBlob = (c, type = "image/png", quality) => c.convertToBlob({ type, quality });

// Draws a cutout onto its own canvas and drops the faint haze (<~9% opacity) the model
// leaves in background areas; it's invisible on its own but shows up as specks.
async function cleanCutout(blob, w, h) {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 24) d[i] = 0;
  ctx.putImageData(img, 0, 0);
  return c;
}
const supportsFilter = (() => {
  const ctx = new OffscreenCanvas(1, 1).getContext("2d");
  ctx.filter = "blur(1px)";
  return ctx.filter === "blur(1px)";
})();

function paintBackground(ctx, bg, source, w, h) {
  if (bg === "transparent") return;
  if (bg !== "blur") {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    return;
  }
  const r = Math.max(6, Math.round(Math.max(w, h) / 45));
  ctx.save();
  ctx.imageSmoothingQuality = "high";
  if (supportsFilter) {
    ctx.filter = `blur(${r}px)`;
    // Overscan so the blur doesn't fade to transparent at the edges.
    ctx.drawImage(source, -r * 2, -r * 2, w + r * 4, h + r * 4);
  } else {
    const small = new OffscreenCanvas(Math.max(1, Math.round(w / r)), Math.max(1, Math.round(h / r)));
    small.getContext("2d").drawImage(source, 0, 0, small.width, small.height);
    ctx.drawImage(small, 0, 0, w, h);
  }
  ctx.restore();
}

// GIF has no alpha channel, only one "transparent" palette entry, so removed pixels
// are painted a rare key color that gif.js maps to that entry.
const KEY = [255, 0, 220];
function keyOut(data, cutoff) {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < cutoff) { data[i] = KEY[0]; data[i + 1] = KEY[1]; data[i + 2] = KEY[2]; }
    data[i + 3] = 255;
  }
}

async function encodeGif(frames, w, h, keyed) {
  const workerScript = await getGifWorker();
  return new Promise((resolve, reject) => {
    const gif = new window.GIF({ workers: 2, quality: 10, workerScript, width: w, height: h, repeat: 0, transparent: keyed ? 0xff00dc : null });
    for (const f of frames) {
      const img = f.getContext("2d").getImageData(0, 0, w, h);
      if (keyed) keyOut(img.data, settings.cutoff);
      gif.addFrame(img, { delay: f.delay });
    }
    gif.on("finished", resolve);
    gif.on("abort", () => reject(new Error("GIF encoding was aborted.")));
    gif.render();
  });
}

// Reconstructs full frames from GIF patches by applying each frame's disposal method.
function fullFrames(frames, w, h) {
  const comp = new OffscreenCanvas(w, h);
  const cctx = comp.getContext("2d", { willReadFrequently: true });
  let saved = null;
  return frames.map((f, i) => {
    const prev = frames[i - 1];
    if (prev?.disposalType === 2) cctx.clearRect(prev.dims.left, prev.dims.top, prev.dims.width, prev.dims.height);
    else if (prev?.disposalType === 3 && saved) cctx.putImageData(saved, 0, 0);
    if (f.disposalType === 3) saved = cctx.getImageData(0, 0, w, h);
    const patch = new OffscreenCanvas(f.dims.width, f.dims.height);
    patch.getContext("2d").putImageData(new ImageData(f.patch, f.dims.width, f.dims.height), 0, 0);
    cctx.drawImage(patch, f.dims.left, f.dims.top);
    const out = new OffscreenCanvas(w, h);
    out.getContext("2d").drawImage(comp, 0, 0);
    return { orig: out, delay: f.delay || 100 };
  });
}

const isHeic = (f) => /\.(heic|heif)$/i.test(f.name) || /image\/hei[cf]/.test(f.type);
const isGif = (f) => f.type === "image/gif" || /\.gif$/i.test(f.name);
const isImage = (f) => f.type.startsWith("image/") || isHeic(f);
const stem = (n) => n.replace(/\.[^.]+$/, "") || "image";
const fmtBytes = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

async function prepare(it) {
  const { file } = it;
  let blob = file;
  if (isHeic(file)) {
    setMessage(it, "Reading iPhone photo…");
    try { blob = await (await getHeicTo())({ blob: file, type: "image/png" }); }
    catch { throw new UserError("This HEIC photo couldn't be read."); }
  }
  if (isGif(file)) {
    const { parseGIF, decompressFrames } = await getGifuct();
    let parsed;
    let raw;
    try {
      parsed = parseGIF(await file.arrayBuffer());
      raw = decompressFrames(parsed, true);
    } catch {
      throw new UserError("This GIF couldn't be read.");
    }
    const w = parsed.lsd.width;
    const h = parsed.lsd.height;
    const frames = fullFrames(raw, w, h);
    if (frames.length > 1) return { kind: "anim", frames, w, h, preview: file };
    blob = await canvasBlob(frames[0].orig);
  }
  let bmp;
  try { bmp = await createImageBitmap(blob); }
  catch { throw new UserError("This file couldn't be read as an image."); }
  return { kind: "still", blob, bitmap: bmp, w: bmp.width, h: bmp.height, preview: blob };
}

// ---------- items ----------
const items = [];
const grid = $("#grid");
const tpl = $("#cardTpl");

function setState(it, state, msg) {
  it.state = state;
  it.el.dataset.state = state;
  if (msg != null) setMessage(it, msg);
  refresh();
}
function setMessage(it, msg) { $(".busy-msg", it.el).textContent = msg; }
function setProgress(it, p) { $(".busy-bar i", it.el).style.width = `${Math.round(p * 100)}%`; }

function addFiles(files) {
  for (const file of files) {
    const it = { file, state: "queued", bg: "transparent", urls: [] };
    it.el = tpl.content.firstElementChild.cloneNode(true);
    $(".name", it.el).textContent = file.name;
    $(".name", it.el).title = file.name;
    $(".meta", it.el).textContent = fmtBytes(file.size);
    $(".rm", it.el).addEventListener("click", () => removeItem(it));
    $(".cmp-range", it.el).addEventListener("input", (e) => $(".cmp", it.el).style.setProperty("--pos", `${e.target.value}%`));
    for (const sw of it.el.querySelectorAll(".sw[data-bg]")) sw.addEventListener("click", () => setBackground(it, sw.dataset.bg));
    const picker = $(".sw-pick input", it.el);
    picker.addEventListener("input", () => setBackground(it, picker.value, true));
    $(".dl", it.el).addEventListener("click", () => download(it));
    grid.append(it.el);
    items.push(it);
    if (!isImage(file)) setState(it, "error", "This isn't an image file.");
    else setState(it, "queued", "Waiting…");
    setBackground(it, "transparent");
  }
  pump();
}

function removeItem(it) {
  it.removed = true;
  it.urls.forEach(URL.revokeObjectURL);
  it.el.remove();
  items.splice(items.indexOf(it), 1);
  refresh();
}

function objectUrl(it, blob) {
  const u = URL.createObjectURL(blob);
  it.urls.push(u);
  return u;
}

function setBackground(it, bg, custom = false) {
  it.bg = bg;
  for (const sw of it.el.querySelectorAll(".sw")) {
    const on = custom ? sw.classList.contains("sw-pick") : sw.dataset.bg === bg;
    sw.setAttribute("aria-checked", String(on));
  }
  const layer = $(".cmp-bg", it.el);
  layer.classList.toggle("blur", bg === "blur");
  layer.style.background = bg === "transparent" || bg === "blur" ? "" : bg;
}

function fillFormats(it) {
  const select = $(".fmt", it.el);
  const opts = it.kind === "anim" ? [["gif", "GIF (animated)"]] : [["png", "PNG"], ["webp", "WEBP"], ["jpg", "JPG"], ["gif", "GIF"]];
  select.replaceChildren(...opts.map(([v, t]) => new Option(t, v)));
  if (it.kind === "anim") $(".sw-blur", it.el).hidden = true;
}

let running = false;
async function pump() {
  if (running) return;
  running = true;
  try {
    let it;
    while ((it = items.find((i) => i.state === "queued"))) await processItem(it);
  } finally {
    running = false;
  }
}

async function processItem(it) {
  setState(it, "working", "Preparing…");
  current = it;
  setProgress(it, 0);
  try {
    const src = await prepare(it);
    Object.assign(it, src);
    const cmp = $(".cmp", it.el);
    cmp.style.setProperty("--ar", it.w / it.h);
    const previewUrl = objectUrl(it, src.preview);
    $(".cmp-before", it.el).src = previewUrl;
    $(".cmp-bg", it.el).style.setProperty("--orig", `url("${previewUrl}")`);
    $(".meta", it.el).textContent = `${fmtBytes(it.file.size)} · ${it.w}×${it.h}${it.kind === "anim" ? ` · ${it.frames.length} frames` : ""}`;
    fillFormats(it);

    if (it.kind === "still") {
      setMessage(it, "Removing background…");
      const cut = await cutout(src.blob);
      if (it.removed) return;
      it.cut = await cleanCutout(cut, it.w, it.h);
      $(".cmp-after", it.el).src = objectUrl(it, await canvasBlob(it.cut));
    } else {
      const n = it.frames.length;
      for (const [i, f] of it.frames.entries()) {
        if (it.removed) return;
        setMessage(it, `Removing background · frame ${i + 1} of ${n}`);
        setProgress(it, i / n);
        f.cut = await cleanCutout(await cutout(await canvasBlob(f.orig)), it.w, it.h);
      }
      setMessage(it, "Building the GIF…");
      setProgress(it, 1);
      it.transparentGif = await renderAnim(it, "transparent");
      if (it.removed) return;
      $(".cmp-after", it.el).src = objectUrl(it, it.transparentGif);
    }
    setState(it, "done");
  } catch (e) {
    if (!(e instanceof UserError)) console.error(e);
    if (!it.removed) setState(it, "error", e instanceof UserError ? e.message : `Something went wrong: ${e.message}`);
  } finally {
    current = null;
  }
}

async function renderAnim(it, bg) {
  const frames = it.frames.map((f) => {
    const c = new OffscreenCanvas(it.w, it.h);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    paintBackground(ctx, bg, f.orig, it.w, it.h);
    ctx.drawImage(f.cut, 0, 0);
    c.delay = f.delay;
    return c;
  });
  return encodeGif(frames, it.w, it.h, bg === "transparent");
}

async function render(it) {
  const format = $(".fmt", it.el).value;
  if (it.kind === "anim") return it.bg === "transparent" ? it.transparentGif : renderAnim(it, it.bg);
  const bg = it.bg === "transparent" && format === "jpg" ? "#ffffff" : it.bg;
  const c = new OffscreenCanvas(it.w, it.h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  paintBackground(ctx, bg, it.bitmap, it.w, it.h);
  ctx.drawImage(it.cut, 0, 0);
  if (format === "gif") { c.delay = 100; return encodeGif([c], it.w, it.h, bg === "transparent"); }
  return canvasBlob(c, { png: "image/png", webp: "image/webp", jpg: "image/jpeg" }[format], 0.92);
}

const outName = (it) => `${stem(it.file.name)}-peeled.${it.kind === "anim" ? "gif" : $(".fmt", it.el).value}`;

function save(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function download(it) {
  const btn = $(".dl", it.el);
  btn.disabled = true;
  btn.textContent = "Preparing…";
  try { save(await render(it), outName(it)); }
  catch (e) { console.error(e); setMessage(it, `Couldn't export: ${e.message}`); }
  finally { btn.disabled = false; btn.textContent = "Download"; }
}

$("#dlAll").addEventListener("click", async () => {
  const btn = $("#dlAll");
  btn.disabled = true;
  btn.textContent = "Zipping…";
  try {
    const { zip } = await getFflate();
    const entries = {};
    const taken = new Set();
    for (const it of items.filter((i) => i.state === "done")) {
      let name = outName(it);
      for (let n = 2; taken.has(name); n++) name = outName(it).replace(/(\.\w+)$/, ` (${n})$1`);
      taken.add(name);
      entries[name] = [new Uint8Array(await (await render(it)).arrayBuffer()), { level: 0 }];
    }
    const data = await new Promise((res, rej) => zip(entries, (err, out) => (err ? rej(err) : res(out))));
    save(new Blob([data], { type: "application/zip" }), "peeled-images.zip");
  } finally {
    btn.textContent = "Download all";
    refresh();
  }
});

$("#clear").addEventListener("click", () => [...items].forEach(removeItem));

function refresh() {
  const done = items.filter((i) => i.state === "done").length;
  const working = items.filter((i) => i.state === "working" || i.state === "queued").length;
  $("#work").hidden = !items.length;
  $("#drop").classList.toggle("compact", items.length > 0);
  $("#summary").textContent = `${items.length} file${items.length === 1 ? "" : "s"}${done ? ` · ${done} done` : ""}${working ? ` · ${working} in progress` : ""}`;
  $("#dlAll").disabled = done < 2;
}

// ---------- input ----------
const fileInput = $("#fileInput");
$("#pick").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => { addFiles([...fileInput.files]); fileInput.value = ""; });

let depth = 0;
const overlay = $("#overlay");
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; overlay.hidden = false; });
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; overlay.hidden = true; } });
window.addEventListener("drop", (e) => {
  e.preventDefault();
  depth = 0;
  overlay.hidden = true;
  if (e.dataTransfer?.files.length) addFiles([...e.dataTransfer.files]);
});
window.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])].filter(isImage);
  if (!files.length) return;
  e.preventDefault();
  addFiles(files.map((f, i) => new File([f], f.name && f.name !== "image.png" ? f.name : `pasted-${Date.now()}-${i}.png`, { type: f.type })));
});
