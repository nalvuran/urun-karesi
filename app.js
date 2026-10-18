import { compose, parseTime, formatTime } from "./processing.js";
import { parseTranscript, classify, wantsPhoto } from "./transcript.js";
import {
  MODELS, writePattern, patternToSteps, buildChatPrompt, parseChatReply, linesToList, sizesToText, textToSizes, abbrToText, textToAbbr,
} from "./pattern.js";

// ---- Dış kaynaklar (hepsi tarayıcıda çalışır) ----
const MP_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1";
const IMGLY_URLS = [
  "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm",
  "https://esm.sh/@imgly/background-removal@1.7.0",
];
const HAND_MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const SKIN_MODEL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite";
const WORK_MAX = 1280; // İşleme çözünürlüğü (uzun kenar, piksel)

const $ = (id) => document.getElementById(id);
const video = $("video");
const els = Object.fromEntries([
  "file", "drop", "video-name", "transcript", "tfile", "parse", "msg",
  "steps-card", "steps-count", "frame-at", "add-step", "photo-none", "photo-auto", "steps",
  "extract", "extract-all", "cancel", "batch-msg",
  "editor-card", "editor-title", "editor-close", "editor-text", "time", "use-current", "reextract", "scan",
  "scan-strip", "progress", "editor-msg", "editor-body",
  "tab-result", "tab-edit", "view-result", "view-edit", "result-stage", "result", "editor",
  "brush-erase", "brush-keep", "brush-size", "brush-clear",
  "expand", "skin", "arm", "fill", "reach", "clean", "transparent",
  "dl-png", "dl-jpg", "dl-frame",
  "pdf-card", "pdf-title", "pdf-intro", "pdf-author", "pdf-cover", "pdf-size", "print", "booklet",
  "project-save", "project-open", "ai-card", "ai-status", "api-key", "ai-model", "api-remember", "ai-write", "ai-cancel",
  "pdf-subtitle", "pdf-skill", "pdf-materials", "pdf-tools", "pdf-sizes", "pdf-abbr", "pdf-notes", "pdf-copyright",
  "etsy-card", "etsy-title", "etsy-title-len", "etsy-desc", "etsy-tags",
  "chat-copy", "chat-paste-open", "chat-panel", "chat-reply", "chat-apply", "chat-close",
].map((id) => [id.replace(/-(\w)/g, (_, c) => c.toUpperCase()), $(id)]));

// ---- Durum ----
/** @type {{id:number,start:number,end:number,text:string,kind:string,include:boolean,photo:boolean,customT:number|null,img:string|null,status:string,erase?:Uint8Array,keep?:Uint8Array,maskT?:number}[]} */
let steps = [];
let nextId = 1;
let activeId = null;
let S = null; // Açık adımın tam işleme durumu
let cancelBatch = false;
let batchRunning = false;

// Video üzerinde aynı anda tek işlem (kare alma sırayla olmalı)
let chain = Promise.resolve();
function exclusive(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

// =============== Model yükleyiciler (ilk ihtiyaçta, bir kez) ===============
function once(fn) {
  let p = null;
  return () => (p ??= fn().catch((e) => { p = null; throw e; }));
}
const loadVision = once(async () => {
  const mod = await import(`${MP_URL}/vision_bundle.mjs`);
  const fileset = await mod.FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
  return { mod, fileset };
});
async function createTask(Cls, fileset, opts) {
  try {
    return await Cls.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: "GPU" } });
  } catch {
    return Cls.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: "CPU" } });
  }
}
const loadHands = once(async () => {
  const { mod, fileset } = await loadVision();
  return createTask(mod.HandLandmarker, fileset, {
    baseOptions: { modelAssetPath: HAND_MODEL },
    runningMode: "IMAGE", numHands: 2,
    minHandDetectionConfidence: 0.3, minHandPresenceConfidence: 0.3, minTrackingConfidence: 0.3,
  });
});
const loadSkin = once(async () => {
  const { mod, fileset } = await loadVision();
  return createTask(mod.ImageSegmenter, fileset, {
    baseOptions: { modelAssetPath: SKIN_MODEL },
    runningMode: "IMAGE", outputCategoryMask: false, outputConfidenceMasks: true,
  });
});
const loadImgly = once(async () => {
  let lastErr;
  for (const url of IMGLY_URLS) {
    try { return await import(url); } catch (e) { lastErr = e; }
  }
  throw lastErr;
});

// =============== Video ===============
function openVideo(file) {
  if (!file || (!file.type.startsWith("video/") && !/\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(file.name))) {
    return setMsg("Lütfen bir video dosyası seçin.", true);
  }
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(file);
  video.hidden = false;
  els.drop.classList.add("compact");
  els.videoName.textContent = file.name;
  if (!els.pdfTitle.value) els.pdfTitle.value = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
  for (const s of steps) { s.img = null; s.status = ""; s.erase = s.keep = undefined; }
  closeEditor();
  renderSteps();
}
video.addEventListener("loadedmetadata", () => setMsg(`Video yüklendi (${formatTime(Math.round(video.duration))}).`));
video.addEventListener("error", () =>
  setMsg("Bu video tarayıcıda açılamadı. Farklı bir tarayıcı deneyin ya da videoyu MP4 (H.264) olarak kaydedin.", true));
els.file.addEventListener("change", () => openVideo(els.file.files[0]));
["dragenter", "dragover"].forEach((ev) => els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.remove("over"); }));
els.drop.addEventListener("drop", (e) => openVideo(e.dataTransfer.files[0]));

function seek(t) {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("Videoda bu ana gidilemedi.")); };
    const cleanup = () => { video.removeEventListener("seeked", done); video.removeEventListener("error", fail); };
    video.addEventListener("seeked", done);
    video.addEventListener("error", fail);
    video.currentTime = t;
  });
}
async function grabFrame(t, maxSide) {
  if (!video.duration) throw new Error("Önce videoyu seçin.");
  video.pause();
  await seek(Math.min(Math.max(0, t), video.duration - 0.05));
  if (video.requestVideoFrameCallback) {
    await Promise.race([new Promise((r) => video.requestVideoFrameCallback(() => r())), sleep(150)]);
  }
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) throw new Error("Videodan görüntü okunamadı.");
  const s = Math.min(1, maxSide / Math.max(vw, vh));
  const c = document.createElement("canvas");
  c.width = Math.round(vw * s);
  c.height = Math.round(vh * s);
  c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
  return c;
}

// =============== Algılama ===============
async function detectRaw(canvas) {
  const [hands, skinSeg, { mod }] = await Promise.all([loadHands(), loadSkin(), loadVision()]);
  const w = canvas.width, h = canvas.height;
  const hr = hands.detect(canvas);
  const sr = skinSeg.segment(canvas);
  const masks = sr.confidenceMasks || [];
  const skin = new Float32Array(w * h);
  if (masks[2]) {
    const mw = masks[2].width, mh = masks[2].height;
    const body = masks[2].getAsFloat32Array();
    const face = masks[3] ? masks[3].getAsFloat32Array() : null;
    for (let y = 0; y < h; y++) {
      const sy = Math.min(mh - 1, Math.floor((y * mh) / h));
      for (let x = 0; x < w; x++) {
        const j = sy * mw + Math.min(mw - 1, Math.floor((x * mw) / w));
        skin[y * w + x] = face ? Math.max(body[j], face[j]) : body[j];
      }
    }
  }
  masks.forEach((m) => m.close?.());
  sr.close?.();
  return { landmarks: hr.landmarks || [], skin, connections: mod.HandLandmarker.HAND_CONNECTIONS };
}

function skinThreshold() {
  const sens = +els.skin.value;
  return sens === 0 ? Infinity : 0.9 - (sens / 100) * 0.6;
}

function buildHandMask(raw, w, h, arm) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = g.strokeStyle = "#fff";
  g.lineCap = g.lineJoin = "round";
  for (const lm of raw.landmarks) {
    const P = lm.map((p) => [p.x * w, p.y * h]);
    const size = Math.hypot(P[9][0] - P[0][0], P[9][1] - P[0][1]);
    if (size < 3) continue;
    g.lineWidth = size * 0.28;
    g.beginPath();
    for (const { start, end } of raw.connections) { g.moveTo(...P[start]); g.lineTo(...P[end]); }
    for (const [tip, dip] of [[4, 3], [8, 7], [12, 11], [16, 15], [20, 19]]) {
      g.moveTo(...P[tip]);
      g.lineTo(P[tip][0] + (P[tip][0] - P[dip][0]) * 0.45, P[tip][1] + (P[tip][1] - P[dip][1]) * 0.45);
    }
    g.stroke();
    g.beginPath();
    [0, 1, 2, 5, 9, 13, 17].forEach((k, i) => (i ? g.lineTo(...P[k]) : g.moveTo(...P[k])));
    g.closePath();
    g.fill();
    if (arm) {
      const dx = P[0][0] - P[9][0], dy = P[0][1] - P[9][1];
      g.lineWidth = size * 0.85;
      g.beginPath();
      g.moveTo(...P[0]);
      g.lineTo(P[0][0] + dx * 4, P[0][1] + dy * 4);
      g.stroke();
    }
  }
  const px = g.getImageData(0, 0, w, h).data;
  const thr = skinThreshold();
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4 + 3] > 127 || raw.skin[i] > thr ? 1 : 0;
  return mask;
}

async function removeBackground(canvas, onProgress) {
  const imgly = await loadImgly();
  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  const out = await imgly.removeBackground(blob, {
    output: { format: "image/png" },
    progress: (key, cur, total) => {
      if (key.startsWith("fetch") && total) onProgress?.(Math.round((cur / total) * 100));
    },
  });
  const bmp = await createImageBitmap(out);
  const c = document.createElement("canvas");
  c.width = canvas.width; c.height = canvas.height;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const fg = new Float32Array(c.width * c.height);
  for (let i = 0; i < fg.length; i++) fg[i] = d[i * 4 + 3] / 255;
  return fg;
}

/** Bir zamandan tam işleme durumu üretir (kare + el + arka plan). */
async function extractState(t, onStage) {
  onStage?.(0);
  const frame = await grabFrame(t, WORK_MAX);
  const w = frame.width, h = frame.height;
  onStage?.(1, "ilk seferde model indirilir");
  const raw = await detectRaw(frame);
  onStage?.(2, "ilk seferde model indirilir");
  const fg = await removeBackground(frame, (pct) => onStage?.(2, `model indiriliyor %${pct}`));
  onStage?.(3);
  return {
    t, w, h, frame, raw, fg,
    rgba: frame.getContext("2d").getImageData(0, 0, w, h).data,
    erase: new Uint8Array(w * h), keep: new Uint8Array(w * h),
  };
}

function composeState(st) {
  const big = Math.max(st.w, st.h);
  const hand = buildHandMask(st.raw, st.w, st.h, els.arm.checked);
  return compose({
    w: st.w, h: st.h, rgba: st.rgba, fg: st.fg, hand, erase: st.erase, keep: st.keep,
    expand: (+els.expand.value / 100) * big,
    fill: els.fill.checked,
    fillReach: (+els.reach.value / 100) * big,
    minPart: els.clean.checked ? 0.04 : 0,
    transparent: els.transparent.checked,
  });
}

function drawResult(r, canvas, st) {
  if (r.empty) {
    canvas.width = st.w; canvas.height = st.h;
    const g = canvas.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, st.w, st.h);
  } else {
    canvas.width = r.cropW; canvas.height = r.cropH;
    canvas.getContext("2d").putImageData(new ImageData(r.data, r.cropW, r.cropH), 0, 0);
  }
}

function canvasToURL(canvas) {
  return new Promise((res) => canvas.toBlob((b) => res(URL.createObjectURL(b)), "image/png"));
}

function setStepImg(step, url) {
  if (step.img) URL.revokeObjectURL(step.img);
  step.img = url;
}

// =============== Transkript → adımlar ===============
els.tfile.addEventListener("change", async () => {
  const f = els.tfile.files[0];
  if (!f) return;
  els.transcript.value = await f.text();
  els.parse.click();
});

els.parse.onclick = () => {
  const segs = parseTranscript(els.transcript.value);
  if (!segs.length) return setMsg("Transkriptte zaman bilgisi bulunamadı. Satırlar \"0:12\" gibi zamanlarla başlamalı.", true);
  const firstStep = segs.findIndex((g) => classify(g.text) === "step");
  const intro = [];
  steps = segs.map((g, i) => {
    const kind = classify(g.text);
    const isIntro = i < firstStep && kind === "info";
    if (isIntro) intro.push(g.text);
    return {
      id: nextId++, start: g.start, end: g.end, text: g.text, kind,
      include: kind !== "noise" && !isIntro,
      photo: wantsPhoto(g.text), customT: null, img: null, status: "",
    };
  });
  // Aynı cümle tekrar ediyorsa yalnızca ilkinin fotoğrafı
  const seen = new Set();
  for (const s of steps) {
    if (!s.photo) continue;
    const key = s.text.toLowerCase();
    if (seen.has(key)) s.photo = false;
    seen.add(key);
  }
  if (!els.pdfIntro.value && intro.length) els.pdfIntro.value = intro.join("\n");
  els.stepsCard.hidden = false;
  els.pdfCard.hidden = false;
  closeEditor();
  renderSteps();
  const ph = steps.filter((s) => s.photo).length;
  setMsg(`${steps.length} satır bulundu. Fotoğraf için ${ph} adım önerildi; listeden değiştirebilirsiniz.`);
  els.stepsCard.scrollIntoView({ behavior: "smooth", block: "start" });
};

// =============== Yapay zekâ ile tarif ===============
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* yok say */ } },
};
els.aiModel.innerHTML = MODELS.map((m) => `<option value="${m.id}">${m.label}</option>`).join("");
els.apiKey.value = store.get("uk_api_key") || "";
els.aiModel.value = store.get("uk_model") || MODELS[0].id;
els.apiRemember.checked = store.get("uk_remember") !== "0";
function saveAiSettings() {
  store.set("uk_remember", els.apiRemember.checked ? "1" : "0");
  store.set("uk_api_key", els.apiRemember.checked && els.apiKey.value.trim() ? els.apiKey.value.trim() : null);
  store.set("uk_model", els.aiModel.value);
  els.aiStatus.textContent = els.apiKey.value.trim() ? "· anahtar girildi ✓" : "· anahtar gerekli";
}
for (const el of [els.apiKey, els.aiModel, els.apiRemember]) el.addEventListener("change", saveAiSettings);
saveAiSettings();

let aiAbort = null;
els.aiWrite.onclick = async () => {
  const key = els.apiKey.value.trim();
  if (!key) { els.aiCard.open = true; els.apiKey.focus(); return setMsg("Önce yapay zekâ ayarlarından API anahtarını girin.", true); }
  if (!parseTranscript(els.transcript.value).length) return setMsg("Transkriptte zaman bilgisi bulunamadı. Satırlar \"0:12\" gibi zamanlarla başlamalı.", true);
  if (steps.length && !confirm("Mevcut adım listesi yapay zekânın yazacağı tarifle değiştirilsin mi?")) return;
  aiAbort = new AbortController();
  els.aiWrite.disabled = els.parse.disabled = true;
  els.aiCancel.hidden = false;
  const started = Date.now();
  const tick = setInterval(() => setMsg(`Tarif yazılıyor… ${Math.round((Date.now() - started) / 1000)} sn (uzun videolarda 1–3 dakika sürebilir)`), 1000);
  try {
    const pattern = await writePattern({
      apiKey: key, model: els.aiModel.value, transcript: els.transcript.value,
      videoName: els.videoName.textContent, duration: video.duration || 0, signal: aiAbort.signal,
    });
    applyPattern(pattern);
    const n = steps.filter((s) => s.photo).length;
    const checks = steps.filter((s) => /\[CHECK/i.test(s.text)).length;
    setMsg(`Tarif hazır: ${pattern.sections.length} bölüm, ${steps.length} adım, ${n} fotoğraf anı seçildi.` +
      (checks ? ` ${checks} adımda [CHECK] notu var; bunları mutlaka kontrol edin.` : ""));
    els.stepsCard.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    if (e.name === "AbortError") setMsg("Durduruldu.");
    else { console.error(e); setMsg(e.message, true); }
  } finally {
    clearInterval(tick);
    aiAbort = null;
    els.aiWrite.disabled = els.parse.disabled = false;
    els.aiCancel.hidden = true;
  }
};
els.aiCancel.onclick = () => aiAbort?.abort();

// ---- API'siz yol: claude.ai ile kopyala-yapıştır ----
els.chatCopy.onclick = async () => {
  if (!parseTranscript(els.transcript.value).length) return setMsg("Önce transkripti yapıştırın (satırlar \"0:12\" gibi zamanlarla başlamalı).", true);
  const prompt = buildChatPrompt({ transcript: els.transcript.value, videoName: els.videoName.textContent, duration: video.duration || 0 });
  try {
    await navigator.clipboard.writeText(prompt);
  } catch {
    // Pano izni yoksa metni yanıt kutusuna koyup seçtir
    els.chatPanel.hidden = false;
    els.chatReply.value = prompt;
    els.chatReply.select();
    return setMsg("Otomatik kopyalanamadı: kutudaki metni seçip kopyalayın, sonra kutuyu temizleyip Claude'un yanıtını yapıştırın.", true);
  }
  const old = els.chatCopy.textContent;
  els.chatCopy.textContent = "✓ Kopyalandı";
  setTimeout(() => (els.chatCopy.textContent = old), 2000);
  setMsg("Komut kopyalandı. Claude'da yeni bir sohbet açıp yapıştırın ve gönderin. Yanıt bitince 3. adıma geçin." +
    (video.duration ? "" : " (Fotoğraf zamanlarının doğru olması için videoyu da seçmeniz iyi olur.)"));
};
els.chatPasteOpen.onclick = async () => {
  els.chatPanel.hidden = false;
  try {
    const t = await navigator.clipboard.readText();
    if (/"sections"\s*:/.test(t)) els.chatReply.value = t;
  } catch { /* izin yoksa kullanıcı kendisi yapıştırır */ }
  els.chatReply.focus();
};
els.chatClose.onclick = () => { els.chatPanel.hidden = true; };
els.chatApply.onclick = () => {
  try {
    const p = parseChatReply(els.chatReply.value);
    if (steps.length && !confirm("Mevcut adım listesi bu tarifle değiştirilsin mi?")) return;
    applyPattern(p);
    els.chatPanel.hidden = true;
    els.chatReply.value = "";
    const n = steps.filter((s) => s.photo).length;
    const checks = steps.filter((s) => /\[CHECK/i.test(s.text)).length;
    setMsg(`Tarif uygulandı: ${p.sections.length} bölüm, ${steps.length} adım, ${n} fotoğraf anı.` +
      (checks ? ` ${checks} adımda [CHECK] notu var; bunları mutlaka kontrol edin.` : "") +
      (video.duration ? "" : " Fotoğraflar için videoyu seçin."));
    els.stepsCard.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    setMsg(e.message, true);
  }
};

const DEFAULT_COPYRIGHT = (author) =>
  `© ${new Date().getFullYear()} ${author || "[Your shop name]"}. All rights reserved. This pattern is for personal use only. ` +
  `Please do not copy, share, resell or distribute this PDF. You are welcome to sell items you make from it; please credit the designer.`;

function applyPattern(p) {
  for (const s of steps) if (s.img) URL.revokeObjectURL(s.img);
  steps = patternToSteps(p, video.duration || 0, () => nextId++);
  els.pdfTitle.value = p.title;
  els.pdfSubtitle.value = p.subtitle;
  els.pdfIntro.value = p.description;
  els.pdfSkill.value = p.skill_level;
  els.pdfMaterials.value = p.materials.join("\n");
  els.pdfTools.value = p.tools.join("\n");
  els.pdfSizes.value = sizesToText(p.finished_sizes);
  els.pdfAbbr.value = abbrToText(p.abbreviations);
  els.pdfNotes.value = p.notes.join("\n");
  if (!els.pdfCopyright.value) els.pdfCopyright.value = DEFAULT_COPYRIGHT(els.pdfAuthor.value.trim());
  setEtsy(p.etsy);
  els.stepsCard.hidden = false;
  els.pdfCard.hidden = false;
  closeEditor();
  renderSteps();
}

// =============== Etsy ilanı ===============
function setEtsy(e) {
  els.etsyTitle.value = e?.listing_title || "";
  els.etsyDesc.value = e?.description || "";
  els.etsyTags.value = (e?.tags || []).join(", ");
  els.etsyCard.hidden = !(e && (e.listing_title || e.description));
  updateEtsyLen();
}
function updateEtsyLen() { els.etsyTitleLen.textContent = `(${els.etsyTitle.value.length}/140)`; }
els.etsyTitle.addEventListener("input", updateEtsyLen);
document.querySelectorAll(".copy").forEach((b) => (b.onclick = async () => {
  const t = $(b.dataset.target);
  try { await navigator.clipboard.writeText(t.value); } catch { t.select(); document.execCommand?.("copy"); }
  const old = b.textContent;
  b.textContent = "Kopyalandı ✓";
  setTimeout(() => (b.textContent = old), 1500);
}));
els.pdfAuthor.addEventListener("change", () => {
  if (!els.pdfCopyright.value || /\[Your shop name\]/.test(els.pdfCopyright.value)) {
    els.pdfCopyright.value = DEFAULT_COPYRIGHT(els.pdfAuthor.value.trim());
  }
});

function frameTime(s) {
  if (s.customT != null) return s.customT;
  const mode = els.frameAt.value;
  if (mode === "start") return s.start + 1;
  if (mode === "mid") return (s.start + s.end) / 2;
  return Math.max(s.start, s.end - 0.7);
}

const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function picHTML(s) {
  if (s.img) return `<img alt="" src="${s.img}">${s.status === "warn" ? '<span class="warn-badge" title="Kontrol edin">⚠</span>' : ""}`;
  if (s.status === "working") return "";
  if (s.status === "error") return "hata";
  return s.photo ? "bekliyor" : "—";
}

function stepRowHTML(s) {
  const pic = picHTML(s);
  return `
    <label class="chk" title="PDF'e ekle"><input type="checkbox" class="inc" ${s.include ? "checked" : ""}></label>
    <button type="button" class="ts" title="Videoda bu ana git">${formatTime(Math.floor(s.start))}</button>
    <textarea class="txt" rows="2">${esc(s.text)}</textarea>
    <div class="ph">
      <label class="photo-lbl" title="Fotoğraf çıkar"><input type="checkbox" class="photo" ${s.photo ? "checked" : ""}>📷</label>
      <button type="button" class="pic ${s.status}" title="Fotoğrafı aç / düzenle">${pic}</button>
    </div>
    <button type="button" class="merge" title="Üstteki adımla birleştir">⤒</button>`;
}

function rowClass(s) {
  return `step ${s.kind}${s.include ? "" : " off"}${s.id === activeId ? " active" : ""}${/\[CHECK/i.test(s.text) ? " check" : ""}`;
}

function renderSteps() {
  let html = "";
  let lastSec;
  steps.forEach((s, i) => {
    if (s.section && s.section !== lastSec) {
      html += `<li class="sec" data-first="${s.id}"><input class="sec-input" value="${esc(s.section)}" aria-label="Bölüm başlığı"></li>`;
    }
    lastSec = s.section;
    html += `<li class="${rowClass(s)}" data-id="${s.id}">${stepRowHTML(s)}</li>`;
  });
  els.steps.innerHTML = html;
  updateCounts();
}

// Bölüm başlığını düzenleme: aynı bölümdeki ardışık adımların hepsine uygula
els.steps.addEventListener("input", (e) => {
  if (!e.target.classList.contains("sec-input")) return;
  const first = stepById(e.target.closest("li.sec").dataset.first);
  const i = steps.indexOf(first);
  const old = first.section;
  for (let k = i; k < steps.length && steps[k].section === old; k++) steps[k].section = e.target.value;
});

function updateRow(s) {
  const li = els.steps.querySelector(`[data-id="${s.id}"]`);
  if (!li) return;
  li.className = rowClass(s);
  const pic = li.querySelector(".pic");
  pic.className = `pic ${s.status}`;
  pic.innerHTML = picHTML(s);
  li.querySelector(".photo").checked = s.photo;
  li.querySelector(".inc").checked = s.include;
}

function updateCounts() {
  const inc = steps.filter((s) => s.include).length;
  const ph = steps.filter((s) => s.include && s.photo);
  const missing = ph.filter((s) => !s.img).length;
  const warn = ph.filter((s) => s.img && (s.status === "warn" || s.status === "error")).length;
  const checks = steps.filter((s) => s.include && /\[CHECK/i.test(s.text)).length;
  els.stepsCount.textContent = `${inc} adım PDF'te · ${ph.length} fotoğraf` +
    (warn ? ` · ⚠ ${warn} fotoğrafa bakın` : "") + (checks ? ` · ${checks} [CHECK] notu` : "");
  els.extract.textContent = missing ? `Fotoğrafları çıkar (${missing})` : "Fotoğraflar hazır ✓";
  els.extract.disabled = batchRunning || !missing;
  els.extractAll.disabled = batchRunning || !ph.length;
  updateCoverOptions();
}

const stepById = (id) => steps.find((s) => s.id === +id);

els.steps.addEventListener("click", (e) => {
  const li = e.target.closest("li.step");
  if (!li) return;
  const s = stepById(li.dataset.id);
  if (e.target.closest(".ts")) {
    if (video.duration) { video.currentTime = s.start; }
  } else if (e.target.closest(".pic")) {
    openStep(s);
  } else if (e.target.closest(".merge")) {
    mergeUp(s);
  }
});
els.steps.addEventListener("change", (e) => {
  const li = e.target.closest("li.step");
  if (!li) return;
  const s = stepById(li.dataset.id);
  if (e.target.classList.contains("inc")) s.include = e.target.checked;
  if (e.target.classList.contains("photo")) s.photo = e.target.checked;
  updateRow(s);
  updateCounts();
});
els.steps.addEventListener("input", (e) => {
  if (!e.target.classList.contains("txt")) return;
  const li = e.target.closest("li.step");
  const s = stepById(li.dataset.id);
  const hadCheck = /\[CHECK/i.test(s.text);
  s.text = e.target.value;
  if (s.id === activeId) els.editorText.textContent = s.text;
  if (hadCheck !== /\[CHECK/i.test(s.text)) { li.className = rowClass(s); updateCounts(); }
});

function mergeUp(s) {
  const i = steps.indexOf(s);
  if (i <= 0) return;
  const prev = steps[i - 1];
  prev.text = `${prev.text} ${s.text}`.trim();
  prev.end = s.end;
  prev.include = prev.include || s.include;
  prev.photo = prev.photo || s.photo;
  if (prev.kind !== "step" && s.kind === "step") prev.kind = "step";
  if (s.img) { setStepImg(prev, s.img); s.img = null; prev.customT = s.customT; prev.erase = s.erase; prev.keep = s.keep; prev.maskT = s.maskT; }
  steps.splice(i, 1);
  if (activeId === s.id) closeEditor();
  renderSteps();
}

els.addStep.onclick = () => {
  if (!video.duration) return setMsg("Önce videoyu seçin.", true);
  const t = Math.round(video.currentTime * 10) / 10;
  const s = { id: nextId++, start: t, end: t + 3, text: "", kind: "step", include: true, photo: true, customT: t, img: null, status: "" };
  const at = steps.findIndex((x) => x.start > t);
  steps.splice(at < 0 ? steps.length : at, 0, s);
  els.stepsCard.hidden = false;
  els.pdfCard.hidden = false;
  renderSteps();
  els.steps.querySelector(`[data-id="${s.id}"] .txt`)?.focus();
  openStep(s);
};
els.photoNone.onclick = () => { steps.forEach((s) => (s.photo = false)); renderSteps(); };
els.photoAuto.onclick = () => {
  const seen = new Set();
  for (const s of steps) {
    const key = s.text.toLowerCase();
    s.photo = s.include && wantsPhoto(s.text) && !seen.has(key);
    if (s.photo) seen.add(key);
  }
  renderSteps();
};
els.frameAt.onchange = () => updateCounts();

// =============== Toplu çıkarma ===============
async function runBatch(redoAll) {
  if (!video.duration) return setMsg("Önce videoyu seçin.", true);
  const list = steps.filter((s) => s.include && s.photo && (redoAll || !s.img));
  if (!list.length) return;
  batchRunning = true;
  cancelBatch = false;
  els.cancel.hidden = false;
  updateCounts();
  let done = 0, failed = 0;
  for (const s of list) {
    if (cancelBatch) break;
    s.status = "working";
    updateRow(s);
    els.batchMsg.textContent = `${done + 1}/${list.length} işleniyor… (${formatTime(Math.floor(frameTime(s)))})`;
    try {
      await exclusive(async () => {
        const st = await extractState(frameTime(s), (i, note) => {
          if (i === 2 && note?.includes("%")) els.batchMsg.textContent = `Arka plan modeli indiriliyor… ${note.match(/%\d+/)[0]}`;
        });
        s.erase = st.erase; s.keep = st.keep; s.maskT = st.t;
        const r = composeState(st);
        const c = document.createElement("canvas");
        drawResult(r, c, st);
        setStepImg(s, await canvasToURL(c));
        s.status = r.empty ? "error" : r.suspicious ? "warn" : "";
        if (r.empty || r.suspicious) failed++;
      });
    } catch (e) {
      console.error(e);
      s.status = "error";
      failed++;
      if (/indirilemedi|fetch|import/i.test(friendly(e))) { setMsg(friendly(e), true); break; }
    }
    done++;
    updateRow(s);
    updateCounts();
  }
  batchRunning = false;
  els.cancel.hidden = true;
  els.batchMsg.textContent = cancelBatch ? "Durduruldu." :
    `${done} fotoğraf hazır${failed ? `. ⚠ ${failed} tanesine bakmanız iyi olur (işaretli olanlara dokunun)` : ""}.`;
  updateCounts();
}
els.extract.onclick = () => runBatch(false);
els.extractAll.onclick = () => runBatch(true);
els.cancel.onclick = () => { cancelBatch = true; els.batchMsg.textContent = "Durduruluyor…"; };

// =============== Tek adım düzenleyici ===============
const STEPS_UI = ["Kare alınıyor", "Eller aranıyor", "Arka plan kaldırılıyor", "Sonuç hazırlanıyor"];
function showProgress(active, note = "") {
  els.progress.hidden = false;
  els.progress.innerHTML = STEPS_UI.map((s, i) =>
    `<li class="${i < active ? "done" : i === active ? "active" : ""}">${s}${i === active && note ? ` — ${note}` : ""}</li>`
  ).join("");
}

function activeStep() { return stepById(activeId); }

function openStep(s) {
  activeId = s.id;
  S = null;
  els.editorCard.hidden = false;
  els.editorBody.hidden = true;
  els.scanStrip.hidden = true;
  const n = steps.filter((x) => x.include).indexOf(s) + 1;
  els.editorTitle.textContent = `${n ? `Adım ${n}` : "Adım"} · ${formatTime(Math.floor(s.start))}`;
  els.editorText.textContent = s.text;
  els.time.value = formatTime(Math.round(frameTime(s) * 10) / 10);
  setEditorMsg("");
  for (const li of els.steps.children) li.classList.toggle("active", +li.dataset.id === s.id);
  els.editorCard.scrollIntoView({ behavior: "smooth", block: "start" });
  if (video.duration) loadIntoEditor(s, frameTime(s));
  else setEditorMsg("Fotoğraf çıkarmak için önce videoyu seçin.", true);
}

function closeEditor() {
  activeId = null;
  S = null;
  els.editorCard.hidden = true;
  for (const li of els.steps.children) li.classList.remove("active");
}
els.editorClose.onclick = closeEditor;

async function loadIntoEditor(s, t) {
  setEditorMsg("");
  try {
    await exclusive(async () => {
      if (activeId !== s.id) return;
      const st = await extractState(t, showProgress);
      if (activeId !== s.id) return;
      if (s.erase && s.maskT === t && s.erase.length === st.erase.length) { st.erase = s.erase; st.keep = s.keep; }
      s.erase = st.erase; s.keep = st.keep; s.maskT = t;
      S = st;
      els.progress.hidden = true;
      els.editorBody.hidden = false;
      recompose();
      const n = st.raw.landmarks.length;
      if (!lastResult?.empty) {
        setEditorMsg(n ? `${n} el bulundu ve silindi.` : `Karede el işareti bulunamadı. El kaldıysa "Elle düzelt" sekmesinden silin.`);
      }
    });
  } catch (e) {
    console.error(e);
    els.progress.hidden = true;
    setEditorMsg(friendly(e), true);
  }
}

let lastResult = null;
function recompose() {
  if (!S) return;
  lastResult = composeState(S);
  drawResult(lastResult, els.result, S);
  els.resultStage.classList.toggle("checker", els.transparent.checked);
  if (lastResult.empty) setEditorMsg("Karede ürün bulunamadı. Başka bir an deneyin ya da \"Elle düzelt\" ile ürünü geri getirin.", true);
  if (!els.viewEdit.hidden) renderEditor();
  scheduleSave();
}

let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  const s = activeStep();
  if (!s || !S) return;
  saveTimer = setTimeout(async () => {
    if (activeStep() !== s || !lastResult) return;
    setStepImg(s, await canvasToURL(els.result));
    s.status = lastResult.empty ? "error" : "";  // Elle bakıldığı için uyarı kaldırılır
    if (S.t !== frameTimeAuto(s)) s.customT = S.t;
    updateRow(s);
    updateCounts();
  }, 250);
}
function frameTimeAuto(s) { const c = s.customT; s.customT = null; const t = frameTime(s); s.customT = c; return t; }

let recomposeTimer;
function scheduleRecompose() { clearTimeout(recomposeTimer); recomposeTimer = setTimeout(recompose, 120); }

els.useCurrent.onclick = () => { els.time.value = formatTime(Math.round(video.currentTime * 10) / 10); };
els.reextract.onclick = () => {
  const s = activeStep();
  if (!s) return;
  const t = parseTime(els.time.value);
  if (Number.isNaN(t)) return setEditorMsg("Zamanı dakika:saniye olarak yazın, ör. 03:15", true);
  if (video.duration && t > video.duration) return setEditorMsg("Bu zaman videonun süresinden uzun.", true);
  s.customT = t;
  loadIntoEditor(s, t);
};
els.time.addEventListener("keydown", (e) => { if (e.key === "Enter") els.reextract.click(); });

els.scan.onclick = async () => {
  const s = activeStep();
  if (!s) return;
  const t0 = parseTime(els.time.value);
  if (Number.isNaN(t0)) return setEditorMsg("Zamanı dakika:saniye olarak yazın, ör. 03:15", true);
  els.scanStrip.hidden = false;
  els.scanStrip.innerHTML = "";
  els.scan.disabled = true;
  try {
    await exclusive(async () => {
      const times = [];
      for (let d = -3; d <= 3.001; d += 0.5) {
        const tt = Math.round((t0 + d) * 10) / 10;
        if (tt >= 0 && tt <= video.duration - 0.05) times.push(tt);
      }
      const items = [];
      for (const [i, tt] of times.entries()) {
        setEditorMsg(`Yakındaki kareler taranıyor… ${i + 1}/${times.length}`);
        const c = await grabFrame(tt, 480);
        const raw = await detectRaw(c);
        const hand = buildHandMask(raw, c.width, c.height, false);
        let count = 0;
        for (const v of hand) count += v;
        const cover = count / hand.length;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "thumb";
        btn.innerHTML = `<img alt="" src="${c.toDataURL("image/jpeg", 0.7)}"><span>${formatTime(tt)} · el %${Math.round(cover * 100)}</span>`;
        btn.onclick = () => { els.time.value = formatTime(tt); s.customT = tt; loadIntoEditor(s, tt); };
        els.scanStrip.appendChild(btn);
        items.push({ btn, cover, tt });
      }
      const best = items.reduce((a, b) => (b.cover < a.cover ? b : a), items[0]);
      if (best) {
        best.btn.classList.add("best");
        best.btn.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
        setEditorMsg(`Ellerin en az göründüğü an: ${formatTime(best.tt)}. Bir kareye dokunarak onu kullanın.`);
      }
    });
  } catch (e) {
    console.error(e);
    setEditorMsg(friendly(e), true);
  } finally {
    els.scan.disabled = false;
  }
};

// ---- Elle düzeltme ----
let brush = "erase";
let editorFrame = 0;
function renderEditor() {
  if (!S || !lastResult) return;
  const c = els.editor;
  if (c.width !== S.w || c.height !== S.h) { c.width = S.w; c.height = S.h; }
  const img = new ImageData(S.w, S.h);
  const d = img.data, src = S.rgba, rem = lastResult.remove, al = lastResult.alpha;
  for (let i = 0; i < S.w * S.h; i++) {
    const k = i * 4;
    let r = src[k], g = src[k + 1], b = src[k + 2];
    if (S.keep[i]) { r = r * 0.45 + 40; g = g * 0.45 + 160; b = b * 0.45 + 60; }
    else if (S.erase[i] || rem[i]) { r = r * 0.45 + 200; g = g * 0.45 + 30; b = b * 0.45 + 30; }
    else if (al[i] < 0.5) { r = r * 0.35 + 150; g = g * 0.35 + 150; b = b * 0.35 + 150; }
    d[k] = r; d[k + 1] = g; d[k + 2] = b; d[k + 3] = 255;
  }
  c.getContext("2d").putImageData(img, 0, 0);
}
function requestEditorRender() {
  if (editorFrame) return;
  editorFrame = requestAnimationFrame(() => { editorFrame = 0; renderEditor(); });
}
function paintDot(cx, cy, r) {
  const target = brush === "erase" ? S.erase : S.keep;
  const other = brush === "erase" ? S.keep : S.erase;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(S.w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(S.h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) { const i = y * S.w + x; target[i] = 1; other[i] = 0; }
    }
  }
}
let lastPt = null;
function toImage(e) {
  const rect = els.editor.getBoundingClientRect();
  return [((e.clientX - rect.left) * S.w) / rect.width, ((e.clientY - rect.top) * S.h) / rect.height];
}
function brushRadius() { return (+els.brushSize.value * Math.max(S.w, S.h)) / 200; }
els.editor.addEventListener("pointerdown", (e) => {
  if (!S) return;
  els.editor.setPointerCapture(e.pointerId);
  lastPt = toImage(e);
  paintDot(...lastPt, brushRadius());
  requestEditorRender();
});
els.editor.addEventListener("pointermove", (e) => {
  if (!lastPt || !S) return;
  const p = toImage(e), r = brushRadius();
  const steps_ = Math.max(1, Math.ceil(Math.hypot(p[0] - lastPt[0], p[1] - lastPt[1]) / (r / 2)));
  for (let i = 1; i <= steps_; i++) {
    paintDot(lastPt[0] + ((p[0] - lastPt[0]) * i) / steps_, lastPt[1] + ((p[1] - lastPt[1]) * i) / steps_, r);
  }
  lastPt = p;
  requestEditorRender();
});
const endStroke = () => { if (lastPt) { lastPt = null; recompose(); } };
els.editor.addEventListener("pointerup", endStroke);
els.editor.addEventListener("pointercancel", endStroke);

function setBrush(b) {
  brush = b;
  els.brushErase.classList.toggle("active", b === "erase");
  els.brushKeep.classList.toggle("active", b === "keep");
}
els.brushErase.onclick = () => setBrush("erase");
els.brushKeep.onclick = () => setBrush("keep");
els.brushClear.onclick = () => { if (!S) return; S.erase.fill(0); S.keep.fill(0); recompose(); };

function showTab(edit) {
  els.viewEdit.hidden = !edit;
  els.viewResult.hidden = edit;
  els.tabEdit.classList.toggle("active", edit);
  els.tabResult.classList.toggle("active", !edit);
  if (edit) renderEditor();
}
els.tabResult.onclick = () => showTab(false);
els.tabEdit.onclick = () => showTab(true);

// ---- Ayarlar ----
function updateOutputs() {
  $("expand-out").textContent = `%${(+els.expand.value).toLocaleString("tr")}`;
  $("skin-out").textContent = +els.skin.value === 0 ? "Kapalı" : els.skin.value;
  $("reach-out").textContent = `%${(+els.reach.value).toLocaleString("tr")}`;
  els.reach.disabled = !els.fill.checked;
}
for (const el of [els.expand, els.skin, els.reach]) el.addEventListener("input", () => { updateOutputs(); scheduleRecompose(); });
for (const el of [els.arm, els.fill, els.clean, els.transparent]) el.addEventListener("change", () => { updateOutputs(); recompose(); });
updateOutputs();

// ---- Tek fotoğraf indirme ----
function fileBase() { return `urun_${formatTime(S?.t ?? 0).replace(/[:.]/g, "-")}`; }
function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function saveCanvas(canvas, type, name, quality) { canvas.toBlob((b) => saveBlob(b, name), type, quality); }
els.dlPng.onclick = () => S && saveCanvas(els.result, "image/png", `${fileBase()}.png`);
els.dlJpg.onclick = () => {
  if (!S) return;
  const c = document.createElement("canvas");
  c.width = els.result.width; c.height = els.result.height;
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(els.result, 0, 0);
  saveCanvas(c, "image/jpeg", `${fileBase()}.jpg`, 0.92);
};
els.dlFrame.onclick = () => {
  if (!S) return;
  exclusive(async () => {
    const c = await grabFrame(S.t, 100000);
    saveCanvas(c, "image/jpeg", `kare_${formatTime(S.t).replace(/[:.]/g, "-")}.jpg`, 0.95);
  }).catch((e) => setEditorMsg(friendly(e), true));
};

// =============== PDF ===============
function updateCoverOptions() {
  const sel = els.pdfCover;
  const prev = sel.value;
  const withImg = steps.filter((s) => s.include && s.img);
  sel.innerHTML = `<option value="">Kapak fotoğrafı yok</option>` +
    withImg.map((s) => `<option value="${s.id}">${formatTime(Math.floor(s.start))} · ${esc(s.text.slice(0, 40))}</option>`).join("");
  if (withImg.some((s) => String(s.id) === prev)) sel.value = prev;
  else if (withImg.length) sel.value = String(withImg[withImg.length - 1].id); // Varsayılan: bitmiş ürün (son fotoğraf)
}

function buildBooklet() {
  const inc = steps.filter((s) => s.include && s.text.trim());
  const cover = stepById(els.pdfCover.value);
  const title = els.pdfTitle.value.trim() || "Pattern";
  const author = els.pdfAuthor.value.trim();
  const list = (t) => linesToList(t).map((l) => `<li>${esc(l)}</li>`).join("");
  const sizes = textToSizes(els.pdfSizes.value);
  const abbr = textToAbbr(els.pdfAbbr.value);
  const clean = (t) => esc(t.replace(/\s*\[CHECK:[^\]]*\]/gi, "")); // Kontrol notları PDF'e girmez

  const infoBlocks = [
    els.pdfMaterials.value.trim() && `<div class="b-box"><h3>Materials</h3><ul>${list(els.pdfMaterials.value)}</ul></div>`,
    els.pdfTools.value.trim() && `<div class="b-box"><h3>Tools</h3><ul>${list(els.pdfTools.value)}</ul></div>`,
  ].filter(Boolean).join("");
  const sizesHTML = sizes.headers.length ? `
    <h3>Finished Sizes</h3>
    <table class="b-table"><thead><tr>${sizes.headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${sizes.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : "";
  const abbrHTML = abbr.length ? `
    <h3>Abbreviations (US terms)</h3>
    <table class="b-table b-abbr"><tbody>${abbr.map((a) => `<tr><th>${esc(a.abbr)}</th><td>${esc(a.meaning)}</td></tr>`).join("")}</tbody></table>` : "";
  const notesHTML = els.pdfNotes.value.trim() ? `<h3>Notes</h3><ul class="b-notes">${list(els.pdfNotes.value)}</ul>` : "";

  let n = 0;
  let lastSec;
  const stepsHTML = inc.map((s) => {
    let head = "";
    if (s.section && s.section !== lastSec) head = `<h2 class="b-sec">${esc(s.section)}</h2>`;
    lastSec = s.section;
    const img = s.photo && s.img ? `<img alt="" src="${s.img}">` : "";
    if (s.kind === "info" && !img) return `${head}<div class="b-note">${clean(s.text)}</div>`;
    n++;
    return `${head}<div class="b-step"><div class="b-num">${n}</div><div class="b-body"><p>${clean(s.text)}</p>${img}</div></div>`;
  }).join("");

  els.booklet.className = `size-${els.pdfSize.value}`;
  els.booklet.innerHTML = `
    <section class="b-cover">
      ${els.pdfSkill.value ? `<div class="b-skill">${esc(els.pdfSkill.value)}</div>` : ""}
      <h1>${esc(title)}</h1>
      ${els.pdfSubtitle.value.trim() ? `<p class="b-subtitle">${esc(els.pdfSubtitle.value.trim())}</p>` : ""}
      ${cover?.img ? `<img alt="" src="${cover.img}">` : ""}
      <div class="b-cover-foot">${author ? `Designed by ${esc(author)}` : ""}<span>PDF Pattern · US terms</span></div>
    </section>
    <section class="b-info">
      ${els.pdfIntro.value.trim() ? `<p class="b-intro">${esc(els.pdfIntro.value.trim())}</p>` : ""}
      ${infoBlocks ? `<div class="b-boxes">${infoBlocks}</div>` : ""}
      ${sizesHTML}${abbrHTML}${notesHTML}
    </section>
    <section class="b-steps">
      <h1 class="b-steps-title">Instructions</h1>
      ${stepsHTML}
      <div class="b-end">
        <p class="b-enjoy">Enjoy your finished project!</p>
        ${els.pdfCopyright.value.trim() ? `<p class="b-copy">${esc(els.pdfCopyright.value.trim())}</p>` : ""}
      </div>
    </section>`;
  return els.booklet.querySelectorAll("img");
}

els.print.onclick = async () => {
  if (!steps.some((s) => s.include)) return setMsg("PDF'e eklenecek adım yok.", true);
  const missing = steps.filter((s) => s.include && s.photo && !s.img).length;
  const checks = steps.filter((s) => s.include && /\[CHECK/i.test(s.text)).length;
  const warns = [
    missing && `${missing} adımın fotoğrafı henüz çıkarılmadı.`,
    checks && `${checks} adımda hâlâ [CHECK] notu var (bu notlar PDF'e yazılmaz ama içerik kontrol edilmeli).`,
  ].filter(Boolean);
  if (warns.length && !confirm(`${warns.join("\n")}\n\nYine de devam edilsin mi?`)) return;
  const imgs = buildBooklet();
  await Promise.all([...imgs].map((im) => (im.complete ? null : new Promise((r) => { im.onload = im.onerror = r; }))));
  const oldTitle = document.title;
  document.title = els.pdfTitle.value.trim() || "pattern"; // PDF dosya adı olarak önerilir
  window.print();
  document.title = oldTitle;
};

// =============== Proje kaydet / aç ===============
els.projectSave.onclick = () => {
  if (!steps.length && !els.transcript.value.trim()) return setMsg("Kaydedilecek bir şey yok.", true);
  const project = {
    app: "urun-karesi", version: 1, savedAt: new Date().toISOString(),
    videoName: els.videoName.textContent,
    transcript: els.transcript.value,
    frameAt: els.frameAt.value,
    fields: Object.fromEntries(["pdfTitle", "pdfSubtitle", "pdfIntro", "pdfSkill", "pdfAuthor", "pdfMaterials", "pdfTools",
      "pdfSizes", "pdfAbbr", "pdfNotes", "pdfCopyright", "pdfSize", "etsyTitle", "etsyDesc", "etsyTags"].map((k) => [k, els[k].value])),
    steps: steps.map(({ id, section, text, kind, start, end, include, photo, customT }) => ({ id, section, text, kind, start, end, include, photo, customT })),
  };
  const name = (els.pdfTitle.value.trim() || els.videoName.textContent || "proje").replace(/[\\/:*?"<>|]+/g, "").slice(0, 80);
  saveBlob(new Blob([JSON.stringify(project, null, 2)], { type: "application/json" }), `${name}.json`);
  setMsg("Proje kaydedildi. Fotoğraflar dosyaya girmez; projeyi açınca aynı videoyu seçip \"Fotoğrafları çıkar\"a basın.");
};

els.projectOpen.addEventListener("change", async () => {
  const f = els.projectOpen.files[0];
  els.projectOpen.value = "";
  if (!f) return;
  try {
    const p = JSON.parse(await f.text());
    if (p.app !== "urun-karesi" || !Array.isArray(p.steps)) throw new Error();
    for (const s of steps) if (s.img) URL.revokeObjectURL(s.img);
    els.transcript.value = p.transcript || "";
    els.frameAt.value = p.frameAt || "end";
    for (const [k, v] of Object.entries(p.fields || {})) if (els[k]) els[k].value = v ?? "";
    steps = p.steps.map((s) => ({ ...s, id: nextId++, img: null, status: "" }));
    els.stepsCard.hidden = els.pdfCard.hidden = !steps.length;
    els.etsyCard.hidden = !(els.etsyTitle.value || els.etsyDesc.value);
    updateEtsyLen();
    closeEditor();
    renderSteps();
    const sameVideo = p.videoName && p.videoName === els.videoName.textContent;
    setMsg(`Proje açıldı: ${steps.length} adım.` + (video.duration && sameVideo ? " \"Fotoğrafları çıkar\" ile fotoğrafları yeniden oluşturun." :
      ` Fotoğraflar için videoyu seçin${p.videoName ? ` (${p.videoName})` : ""}, sonra "Fotoğrafları çıkar"a basın.`));
  } catch {
    setMsg("Bu dosya bir Ürün Karesi projesi değil.", true);
  }
});

// =============== Yardımcılar ===============
function friendly(e) {
  const m = String(e?.message || e);
  if (/fetch|network|Failed to load|import|dynamically imported/i.test(m)) return "Yapay zekâ modelleri indirilemedi. İnternet bağlantınızı kontrol edip tekrar deneyin.";
  return m.length < 160 ? m : "Bir hata oluştu. Sayfayı yenileyip tekrar deneyin.";
}
function setMsg(text, isErr = false) { els.msg.textContent = text; els.msg.className = "msg" + (isErr ? " err" : ""); }
function setEditorMsg(text, isErr = false) { els.editorMsg.textContent = text; els.editorMsg.className = "msg" + (isErr ? " err" : ""); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
