import { parseTime, formatTime, autoLevels, thumbDescriptor, descDistance, greedyMatch, DESC_W, DESC_H } from "./processing.js?v=20261019e";
import { parseTranscript, classify, wantsPhoto } from "./transcript.js?v=20261019e";
import {
  MODELS, writePattern, patternToSteps, buildChatPrompt, parseChatReply,
  linesToList, sizesToText, textToSizes, abbrToText, textToAbbr,
} from "./pattern.js?v=20261019e";
import { HAND_OPTIONS, buildGeminiPrompt, buildCoverPrompt, buildMasterPrompt, GEMINI_MODELS, editImageWithGemini, nearestAspect } from "./gemini.js?v=20261019e";
import { drawAnnotations } from "./annot.js?v=20261019e";

const JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
const FRAME_MAX = 2400; // Ham karenin en fazla uzun kenarı (piksel)
const OUT_MAX = 2000;   // Kırpılmış çıktının en fazla uzun kenarı

const $ = (id) => document.getElementById(id);
const video = $("video");
const els = Object.fromEntries([
  "file", "drop", "video-name", "transcript", "tfile", "parse", "msg",
  "steps-card", "steps-count", "frame-at", "add-step", "photo-none", "photo-auto", "steps",
  "extract", "extract-all", "cancel", "batch-msg",
  "editor-card", "editor-title", "editor-close", "editor-text", "time", "use-current", "regrab", "photo-type",
  "editor-msg", "crop-canvas", "crop-reset", "dl-raw", "gem-stage", "gem-img", "gem-empty", "copy-prompt", "gem-file", "gem-remove",
  "gemini-card", "hands", "enhance", "dl-zip", "gem-status", "gem-drop", "gem-files", "gem-msg", "gem-review", "gem-key", "gem-model", "gem-remember", "gem-auto", "gem-auto-all", "gem-stop", "gem-auto-msg", "gem-one", "cover-auto",
  "pdf-card", "pdf-title", "pdf-intro", "pdf-author", "pdf-size", "print", "booklet",
  "cover-img", "cover-empty", "cover-time", "cover-use-current", "cover-grab", "cover-dl", "cover-prompt", "cover-file",
  "project-save", "project-open", "ai-card", "ai-status", "api-key", "ai-model", "api-remember", "ai-write", "ai-cancel",
  "pdf-subtitle", "pdf-kicker", "pdf-color", "pdf-skill", "pdf-materials", "pdf-tools", "pdf-sizes", "pdf-abbr", "pdf-notes", "pdf-copyright",
  "etsy-card", "etsy-title", "etsy-title-len", "etsy-desc", "etsy-tags",
  "chat-copy", "chat-paste-open", "chat-panel", "chat-reply", "chat-apply", "chat-close",
  "ann-canvas", "ann-arrow", "ann-circle", "ann-label", "ann-undo", "ann-clear", "seq-box", "seq-list", "seq-add", "editor-back",
  "guide-box", "guide-list", "copy-master",
].map((id) => [id.replace(/-(\w)/g, (_, c) => c.toUpperCase()), $(id)]));

// ---- Durum ----
// Adım: { id, section, text, kind, start, end, include, photo, photoType, customT, crop,
//         rawBlob (tam kare), outBlob/outURL (kırpılmış ham), gemBlob/gemURL (Gemini), fileNo, status }
// Sıra fotoğrafı (s.extras[i]): { owner: adım, t, crop, rawBlob, outBlob, gemBlob, ann }
// İlmek rehberi (guide[i]): { guide: true, id, name, abbr, steps[], t, include, crop, rawBlob, outBlob, gemBlob, ann }
let steps = [];
let guide = [];
let nextId = 1;
let active = null; // Düzenleyicide açık fotoğraf öğesi (adım, sıra fotoğrafı, rehber)
let cancelBatch = false;
let batchRunning = false;
const cover = { isCover: true, t: null, rawBlob: null, crop: null, outBlob: null, outURL: null, gemBlob: null, gemURL: null, ann: [] };
const DEFAULT_TECH_CROP = { x: 0.12, y: 0.06, w: 0.76, h: 0.88 }; // Teknik fotoğraflarda varsayılan yakın kadraj

// Video üzerinde aynı anda tek işlem (kare alma sırayla olmalı)
let chain = Promise.resolve();
function exclusive(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

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
  // Yeni video: eski ham kareler geçersiz (Gemini görselleri kalır)
  for (const it of [...steps, ...steps.flatMap((s) => s.extras || []), ...guide, cover]) { it.rawBlob = null; setOut(it, null); it.status = ""; }
  closeEditor();
  renderSteps();
  renderCover();
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

/** Videodan t anındaki kareyi JPEG Blob olarak alır. */
async function grabFrameBlob(t) {
  if (!video.duration) throw new Error("Önce videoyu seçin.");
  video.pause();
  await seek(Math.min(Math.max(0, t), video.duration - 0.05));
  if (video.requestVideoFrameCallback) {
    await Promise.race([new Promise((r) => video.requestVideoFrameCallback(() => r())), sleep(150)]);
  }
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) throw new Error("Videodan görüntü okunamadı.");
  const s = Math.min(1, FRAME_MAX / Math.max(vw, vh));
  const c = document.createElement("canvas");
  c.width = Math.round(vw * s);
  c.height = Math.round(vh * s);
  c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, "image/jpeg", 0.95));
}

/** Ham kareyi kırpar, isteğe bağlı ışık düzeltir; item.outBlob/outURL'i günceller. */
async function renderOut(item) {
  if (!item.rawBlob) { setOut(item, null); return; }
  const bmp = await createImageBitmap(item.rawBlob);
  const c0 = effectiveCrop(item) || { x: 0, y: 0, w: 1, h: 1 };
  const sx = Math.round(c0.x * bmp.width), sy = Math.round(c0.y * bmp.height);
  const sw = Math.max(8, Math.round(c0.w * bmp.width)), sh = Math.max(8, Math.round(c0.h * bmp.height));
  const k = Math.min(1, OUT_MAX / Math.max(sw, sh));
  const c = document.createElement("canvas");
  c.width = Math.round(sw * k); c.height = Math.round(sh * k);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
  bmp.close?.();
  if (els.enhance.checked) {
    const img = g.getImageData(0, 0, c.width, c.height);
    autoLevels(img.data, 0.7);
    g.putImageData(img, 0, 0);
  }
  setOut(item, await new Promise((r) => c.toBlob(r, "image/jpeg", 0.92)));
}

function setOut(item, blob) {
  if (item.outURL) URL.revokeObjectURL(item.outURL);
  item._desc = null;
  item.outBlob = blob;
  item.outURL = blob ? URL.createObjectURL(blob) : null;
}
function setGem(item, blob) {
  if (item.gemURL) URL.revokeObjectURL(item.gemURL);
  item.gemBlob = blob;
  item.gemURL = blob ? URL.createObjectURL(blob) : null;
}
function releaseItem(it) { setOut(it, null); setGem(it, null); it.rawBlob = null; }
function releaseStep(s) { releaseItem(s); (s.extras || []).forEach(releaseItem); }
function effectiveCrop(it) { return it.crop || (it.cropTouched ? null : itemType(it) === "technique" ? DEFAULT_TECH_CROP : null); }
const finalURL = (item) => item.gemURL || item.outURL;

function showWorkCards() {
  els.stepsCard.hidden = false;
  els.geminiCard.hidden = false;
  els.pdfCard.hidden = false;
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
  steps.forEach(releaseStep);
  steps = segs.map((g, i) => {
    const kind = classify(g.text);
    const isIntro = i < firstStep && kind === "info";
    if (isIntro) intro.push(g.text);
    return {
      id: nextId++, start: g.start, end: g.end, text: g.text, kind,
      include: kind !== "noise" && !isIntro,
      photo: wantsPhoto(g.text), photoType: "result", customT: null, status: "",
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
  showWorkCards();
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
  steps.forEach(releaseStep);
  guide.forEach(releaseItem);
  steps = patternToSteps(p, video.duration || 0, () => nextId++);
  steps.forEach(wireExtras);
  guide = (p.stitch_guide || []).map((g) => {
    const t = parseTime(g.photo_time);
    return { guide: true, id: `g${nextId++}`, name: g.name, abbr: g.abbr, steps: g.steps, include: true,
      t: Number.isNaN(t) ? null : Math.min(t, Math.max(0, (video.duration || 1e9) - 0.1)), crop: null, ann: [] };
  });
  const ct = parseTime(p.cover_time);
  if (!Number.isNaN(ct)) { els.coverTime.value = formatTime(ct); cover.t = ct; setOut(cover, null); cover.rawBlob = null; }
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
  showWorkCards();
  closeEditor();
  renderSteps();
  renderGuide();
  renderCover();
}
function wireExtras(s) { s.extras = (s.extras || []).map((x) => Object.assign(x, { owner: s, ann: x.ann || [] })); s.ann = s.ann || []; }

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
els.pdfColor.addEventListener("input", () => { els.pdfColor.dataset.auto = "0"; });
els.pdfAuthor.addEventListener("change", () => {
  if (!els.pdfCopyright.value || /\[Your shop name\]/.test(els.pdfCopyright.value)) {
    els.pdfCopyright.value = DEFAULT_COPYRIGHT(els.pdfAuthor.value.trim());
  }
});


// =============== Fotoğraf öğeleri (adım, sıra fotoğrafı, ilmek rehberi, kapak) ===============
function frameTime(s) {
  if (s.customT != null) return s.customT;
  const mode = els.frameAt.value;
  if (mode === "start") return s.start + 1;
  if (mode === "mid") return (s.start + s.end) / 2;
  return Math.max(s.start, s.end - 0.7);
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const stepById = (id) => steps.find((s) => s.id === +id);
const guideById = (id) => guide.find((g) => g.id === id);

/** PDF'teki adım numaraları (dosya adları da bunu kullanır). */
function stepNumbers() {
  const map = new Map();
  let n = 0;
  for (const s of steps) {
    if (!s.include || !s.text.trim()) continue;
    if (s.kind === "info" && !(s.photo && finalURL(s))) continue;
    map.set(s.id, ++n);
  }
  return map;
}

const isExtra = (it) => !!it.owner;
const isGuide = (it) => !!it.guide;
const isCover = (it) => it === cover;
function itemType(it) {
  if (isCover(it)) return "result";
  if (isExtra(it) || isGuide(it)) return "technique";
  return it.photoType || "result";
}
function itemTime(it) {
  if (isCover(it) || isExtra(it) || isGuide(it)) return it.t;
  return frameTime(it);
}
function setItemTime(it, t) {
  if (isCover(it) || isExtra(it) || isGuide(it)) it.t = t; else it.customT = t;
}
function stepItems(s) { return s.include && s.photo ? [s, ...(s.extras || [])] : []; }
/** Gemini ve kareler için tüm fotoğraf öğeleri: kapak, adımlar (+ sıra fotoğrafları), ilmek rehberi */
function allItems() {
  const out = [];
  if (cover.t != null || cover.outBlob || cover.gemBlob) out.push(cover);
  for (const s of steps) out.push(...stepItems(s));
  for (const g of guide) if (g.include && (g.t != null || g.outBlob || g.gemBlob)) out.push(g);
  return out;
}
function itemLabel(it, nums = stepNumbers()) {
  if (isCover(it)) return "Kapak";
  if (isGuide(it)) return `İlmek rehberi: ${it.name}`;
  if (isExtra(it)) return `Adım ${nums.get(it.owner.id) ?? "?"} · sıra ${it.owner.extras.indexOf(it) + 2}`;
  return `Adım ${nums.get(it.id) ?? "?"} — ${it.text.replace(/\s*\[CHECK:[^\]]*\]/gi, "").slice(0, 36)}`;
}
/** Kanonik dosya anahtarı: kapak, adim:5, adim:5:2, ilmek:1 */
function itemKey(it, nums = stepNumbers()) {
  if (isCover(it)) return "kapak";
  if (isGuide(it)) return `ilmek:${guide.indexOf(it) + 1}`;
  if (isExtra(it)) return `adim:${nums.get(it.owner.id)}:${it.owner.extras.indexOf(it) + 2}`;
  return `adim:${nums.get(it.id)}`;
}
function itemFileName(it, nums) {
  const k = itemKey(it, nums).split(":");
  const base = k[0] === "kapak" ? "kapak" : `${k[0]}-${String(k[1]).padStart(2, "0")}${k[2] ? `-${k[2]}` : ""}`;
  const suffix = isCover(it) ? "" : itemType(it) === "technique" ? "-teknik" : "-sonuc";
  return base + suffix;
}
function keyFromFileName(name) {
  const b = String(name).toLowerCase().replace(/\.[a-z0-9]+$/, "");
  if (/kapak|cover/.test(b)) return "kapak";
  let m = b.match(/(?:adim|adım|step)[\s_-]*0*(\d{1,3})(?:[\s_-]+0*(\d))?(?!\d)/);
  if (m) return m[2] ? `adim:${+m[1]}:${+m[2]}` : `adim:${+m[1]}`;
  m = b.match(/(?:ilmek|stitch)[\s_-]*0*(\d{1,2})/);
  return m ? `ilmek:${+m[1]}` : null;
}
function itemPrompt(it) {
  const title = els.pdfTitle.value.trim();
  const hands = els.hands.value;
  if (isCover(it)) return buildCoverPrompt({ title });
  if (isGuide(it)) return buildGeminiPrompt({ type: "technique", text: `How to work: ${it.name}${it.abbr ? ` (${it.abbr})` : ""}`, desc: it.steps.join(" "), hands, title });
  if (isExtra(it)) return buildGeminiPrompt({ type: "technique", text: it.owner.text, desc: it.owner.photoDesc, hands, title });
  return buildGeminiPrompt({ type: it.photoType, text: it.text, desc: it.photoDesc, hands, title });
}

// =============== Adım listesi ===============
function picHTML(s) {
  const url = finalURL(s);
  const extra = (s.extras || []).length ? `<span class="badge seq">+${s.extras.length}</span>` : "";
  const ann = (s.ann || []).length ? `<span class="badge annb">➚</span>` : "";
  if (url) return `<img alt="" src="${url}"><span class="badge ${s.gemURL ? "gem" : "raw"}">${s.gemURL ? "Gemini" : "ham"}</span>${extra}${ann}`;
  if (s.status === "working") return "";
  if (s.status === "error") return "hata";
  return (s.photo ? "bekliyor" : "—") + extra;
}

function stepRowHTML(s) {
  return `
    <label class="chk" title="PDF'e ekle"><input type="checkbox" class="inc" ${s.include ? "checked" : ""}></label>
    <button type="button" class="ts" title="Videoda bu ana git">${formatTime(Math.floor(s.start))}</button>
    <textarea class="txt" rows="2">${esc(s.text)}</textarea>
    <div class="ph">
      <div class="ph-top">
        <label class="photo-lbl" title="Fotoğraf olsun"><input type="checkbox" class="photo" ${s.photo ? "checked" : ""}>📷</label>
        <button type="button" class="ptype ${s.photoType}" title="Sonuç / teknik">${s.photoType === "technique" ? "teknik" : "sonuç"}</button>
      </div>
      <button type="button" class="pic ${s.status || ""}" title="Fotoğrafı aç / düzenle">${picHTML(s)}</button>
    </div>
    <button type="button" class="merge" title="Üstteki adımla birleştir">⤒</button>`;
}

function rowClass(s) {
  return `step ${s.kind}${s.include ? "" : " off"}${active === s || active?.owner === s ? " active" : ""}${/\[CHECK/i.test(s.text) ? " check" : ""}`;
}

function renderSteps() {
  let html = "";
  let lastSec;
  for (const s of steps) {
    if (s.section && s.section !== lastSec) {
      html += `<li class="sec" data-first="${s.id}"><input class="sec-input" value="${esc(s.section)}" aria-label="Bölüm başlığı"></li>`;
    }
    lastSec = s.section;
    html += `<li class="${rowClass(s)}" data-id="${s.id}">${stepRowHTML(s)}</li>`;
  }
  els.steps.innerHTML = html;
  updateCounts();
}

function updateRow(s) {
  if (!s || isCover(s)) return;
  if (isExtra(s)) s = s.owner;
  if (isGuide(s)) { renderGuide(); return; }
  const li = els.steps.querySelector(`li.step[data-id="${s.id}"]`);
  if (!li) return;
  li.className = rowClass(s);
  const pic = li.querySelector(".pic");
  pic.className = `pic ${s.status || ""}`;
  pic.innerHTML = picHTML(s);
  li.querySelector(".photo").checked = s.photo;
  li.querySelector(".inc").checked = s.include;
  const pt = li.querySelector(".ptype");
  pt.className = `ptype ${s.photoType}`;
  pt.textContent = s.photoType === "technique" ? "teknik" : "sonuç";
}

function updateCounts() {
  const inc = steps.filter((s) => s.include).length;
  const items = allItems();
  const missing = items.filter((it) => !it.rawBlob && !it.gemURL && itemTime(it) != null).length;
  const gem = items.filter((it) => it.gemURL).length;
  const ph = steps.filter((s) => s.include && s.photo).length;
  const checks = steps.filter((s) => s.include && /\[CHECK/i.test(s.text)).length;
  els.stepsCount.textContent = `${inc} adım PDF'te · ${ph} adım fotoğraflı · toplam ${items.length} görsel` + (checks ? ` · ${checks} [CHECK] notu` : "");
  els.extract.textContent = missing ? `Kareleri al (${missing})` : "Kareler hazır ✓";
  els.extract.disabled = batchRunning || !missing;
  els.extractAll.disabled = batchRunning || !items.length;
  els.gemStatus.textContent = items.length ? `${gem}/${items.length} görselin Gemini hali hazır` : "";
}

els.steps.addEventListener("click", (e) => {
  const li = e.target.closest("li.step");
  if (!li) return;
  const s = stepById(li.dataset.id);
  if (e.target.closest(".ts")) {
    if (video.duration) video.currentTime = s.start;
  } else if (e.target.closest(".pic")) {
    openItem(s);
  } else if (e.target.closest(".merge")) {
    mergeUp(s);
  } else if (e.target.closest(".ptype")) {
    s.photoType = s.photoType === "technique" ? "result" : "technique";
    if (!s.crop && !s.cropTouched && s.rawBlob) renderOut(s).then(() => updateRow(s));
    updateRow(s);
    if (active === s) els.photoType.value = s.photoType;
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
  if (e.target.classList.contains("sec-input")) {
    const first = stepById(e.target.closest("li.sec").dataset.first);
    const old = first.section;
    for (let k = steps.indexOf(first); k < steps.length && steps[k].section === old; k++) steps[k].section = e.target.value;
    return;
  }
  if (!e.target.classList.contains("txt")) return;
  const li = e.target.closest("li.step");
  const s = stepById(li.dataset.id);
  const hadCheck = /\[CHECK/i.test(s.text);
  s.text = e.target.value;
  if (active === s) els.editorText.textContent = s.text;
  if (hadCheck !== /\[CHECK/i.test(s.text)) { li.className = rowClass(s); updateCounts(); }
});

function mergeUp(s) {
  const i = steps.indexOf(s);
  if (i <= 0) return;
  const prev = steps[i - 1];
  prev.text = `${prev.text} ${s.text}`.trim();
  prev.end = s.end;
  prev.include = prev.include || s.include;
  if (prev.kind !== "step" && s.kind === "step") prev.kind = "step";
  // Birleşen adımın karesi (işin bittiği an) daha anlamlı: onu taşı
  if (s.photo && (s.rawBlob || s.gemURL)) {
    releaseStep(prev);
    Object.assign(prev, {
      photo: true, photoType: s.photoType, customT: s.customT, crop: s.crop, cropTouched: s.cropTouched, ann: s.ann,
      rawBlob: s.rawBlob, outBlob: s.outBlob, outURL: s.outURL, gemBlob: s.gemBlob, gemURL: s.gemURL,
      extras: (s.extras || []).map((x) => Object.assign(x, { owner: prev })),
    });
    s.outURL = s.gemURL = null;
    s.extras = [];
  } else {
    prev.photo = prev.photo || s.photo;
    releaseStep(s);
  }
  steps.splice(i, 1);
  if (active === s || active?.owner === s) closeEditor();
  renderSteps();
}

els.addStep.onclick = () => {
  if (!video.duration) return setMsg("Önce videoyu seçin.", true);
  const t = Math.round(video.currentTime * 10) / 10;
  const at = steps.findIndex((x) => x.start > t);
  const before = steps[(at < 0 ? steps.length : at) - 1];
  const s = {
    id: nextId++, section: before?.section || "", start: t, end: t + 3, text: "", kind: "step",
    include: true, photo: true, photoType: "result", customT: t, crop: null, status: "", extras: [], ann: [],
  };
  steps.splice(at < 0 ? steps.length : at, 0, s);
  showWorkCards();
  renderSteps();
  els.steps.querySelector(`[data-id="${s.id}"] .txt`)?.focus();
  openItem(s);
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

// =============== İlmek rehberi listesi ===============
function renderGuide() {
  els.guideBox.hidden = !guide.length;
  els.guideList.innerHTML = guide.map((g) => {
    const url = finalURL(g);
    return `<li class="guide-row${g.include ? "" : " off"}" data-gid="${g.id}">
      <label class="chk" title="PDF'e ekle"><input type="checkbox" class="ginc" ${g.include ? "checked" : ""}></label>
      <div class="guide-name"><b>${esc(g.name)}</b>${g.abbr ? ` <span class="muted">(${esc(g.abbr)})</span>` : ""}<div class="muted small">${esc(g.steps.join(" · "))}</div></div>
      <button type="button" class="ts gts">${g.t != null ? formatTime(Math.floor(g.t)) : "—"}</button>
      <button type="button" class="pic gpic ${g.status || ""}">${url ? `<img alt="" src="${url}"><span class="badge ${g.gemURL ? "gem" : "raw"}">${g.gemURL ? "Gemini" : "ham"}</span>` : g.status === "working" ? "" : "bekliyor"}</button>
    </li>`;
  }).join("");
  updateCounts();
}
els.guideList.addEventListener("click", (e) => {
  const li = e.target.closest("li.guide-row");
  if (!li) return;
  const g = guideById(li.dataset.gid);
  if (e.target.closest(".gts")) { if (video.duration && g.t != null) video.currentTime = g.t; }
  else if (e.target.closest(".gpic")) openItem(g);
});
els.guideList.addEventListener("change", (e) => {
  const li = e.target.closest("li.guide-row");
  if (!li || !e.target.classList.contains("ginc")) return;
  guideById(li.dataset.gid).include = e.target.checked;
  renderGuide();
});

// =============== Kareleri toplu alma ===============
async function grabItem(it) {
  const t = itemTime(it);
  if (t == null) throw new Error("Bu fotoğrafın zamanı yok.");
  it.rawBlob = await exclusive(() => grabFrameBlob(t));
  it.rawT = t;
  await renderOut(it);
}
function refreshItemUI(it) {
  if (isCover(it)) renderCover();
  else if (isGuide(it)) renderGuide();
  else updateRow(it);
  if (active === it) { renderGem(it); drawAnn(); }
  if (active && isExtra(it) && active === it.owner) renderSeq();
  if (active && !isExtra(active) && it.owner === active) renderSeq();
}

async function runBatch(redoAll) {
  if (!video.duration) return setMsg("Önce videoyu seçin.", true);
  const list = allItems().filter((it) => itemTime(it) != null && (redoAll || (!it.rawBlob && !it.gemURL)));
  if (!list.length) return;
  batchRunning = true;
  cancelBatch = false;
  els.cancel.hidden = false;
  updateCounts();
  let done = 0;
  for (const it of list) {
    if (cancelBatch) break;
    it.status = "working";
    refreshItemUI(it);
    els.batchMsg.textContent = `${done + 1}/${list.length} kare alınıyor…`;
    try { await grabItem(it); it.status = ""; }
    catch (e) { console.error(e); it.status = "error"; }
    done++;
    refreshItemUI(it);
    updateCounts();
  }
  batchRunning = false;
  els.cancel.hidden = true;
  els.batchMsg.textContent = cancelBatch ? "Durduruldu." :
    `${done} kare hazır. Fotoğrafa dokunarak kırpabilir ve ok/daire ekleyebilirsiniz.`;
  updateCounts();
}
els.extract.onclick = () => runBatch(false);
els.extractAll.onclick = () => runBatch(true);
els.cancel.onclick = () => { cancelBatch = true; els.batchMsg.textContent = "Durduruluyor…"; };

// =============== Düzenleyici: kırpma, Gemini görseli, işaretler, sıra fotoğrafları ===============
let cropBmp = null;
let dragStart = null;
let dragRect = null;

async function openItem(it) {
  active = it;
  els.editorCard.hidden = false;
  const nums = stepNumbers();
  els.editorTitle.textContent = itemLabel(it, nums).replace(/ — .*/, "") + (itemTime(it) != null ? ` · ${formatTime(Math.floor(itemTime(it)))}` : "");
  els.editorText.textContent = isGuide(it) ? it.steps.join(" · ") : isExtra(it) ? it.owner.text : isCover(it) ? "" : it.text;
  els.time.value = itemTime(it) != null ? formatTime(Math.round(itemTime(it) * 10) / 10) : "";
  els.photoType.value = itemType(it);
  els.photoType.disabled = isExtra(it) || isGuide(it) || isCover(it);
  els.editorBack.hidden = !isExtra(it);
  els.seqBox.hidden = isExtra(it) || isGuide(it) || isCover(it);
  setEditorMsg("");
  for (const li of els.steps.querySelectorAll("li.step")) {
    const s = stepById(li.dataset.id);
    li.classList.toggle("active", it === s || it.owner === s);
  }
  renderGem(it);
  renderSeq();
  els.editorCard.scrollIntoView({ behavior: "smooth", block: "start" });
  if (!it.rawBlob && video.duration && itemTime(it) != null) {
    setEditorMsg("Kare alınıyor…");
    try { await grabItem(it); setEditorMsg(""); refreshItemUI(it); updateCounts(); }
    catch (e) { setEditorMsg(e.message, true); }
  } else if (!it.rawBlob && !video.duration) {
    setEditorMsg("Ham kare için önce videoyu seçin.", true);
  }
  if (active === it) { await loadCropCanvas(it); drawAnn(); }
}
// Eski adla çağrılan yerler için
const openStep = openItem;

function closeEditor() {
  active = null;
  cropBmp?.close?.();
  cropBmp = null;
  els.editorCard.hidden = true;
  for (const li of els.steps.querySelectorAll("li.step")) li.classList.remove("active");
}
els.editorClose.onclick = closeEditor;
els.editorBack.onclick = () => { if (active?.owner) openItem(active.owner); };

async function loadCropCanvas(it) {
  cropBmp?.close?.();
  cropBmp = it.rawBlob ? await createImageBitmap(it.rawBlob) : null;
  drawCrop(effectiveCrop(it));
}

function drawCrop(rect) {
  const c = els.cropCanvas;
  const g = c.getContext("2d");
  if (!cropBmp) { c.width = 320; c.height = 180; g.clearRect(0, 0, c.width, c.height); return; }
  const k = Math.min(1, 1100 / cropBmp.width);
  c.width = Math.round(cropBmp.width * k);
  c.height = Math.round(cropBmp.height * k);
  g.drawImage(cropBmp, 0, 0, c.width, c.height);
  if (rect) {
    const x = rect.x * c.width, y = rect.y * c.height, w = rect.w * c.width, h = rect.h * c.height;
    g.fillStyle = "rgba(0,0,0,.55)";
    g.fillRect(0, 0, c.width, y);
    g.fillRect(0, y + h, c.width, c.height - y - h);
    g.fillRect(0, y, x, h);
    g.fillRect(x + w, y, c.width - x - w, h);
    g.strokeStyle = "#fff";
    g.lineWidth = 2;
    g.strokeRect(x, y, w, h);
  }
}

function canvasPoint(e, canvas) {
  const r = canvas.getBoundingClientRect();
  return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
}
els.cropCanvas.addEventListener("pointerdown", (e) => {
  if (!cropBmp) return;
  els.cropCanvas.setPointerCapture(e.pointerId);
  dragStart = canvasPoint(e, els.cropCanvas);
  dragRect = null;
});
els.cropCanvas.addEventListener("pointermove", (e) => {
  if (!dragStart) return;
  const p = canvasPoint(e, els.cropCanvas);
  dragRect = { x: Math.min(p[0], dragStart[0]), y: Math.min(p[1], dragStart[1]), w: Math.abs(p[0] - dragStart[0]), h: Math.abs(p[1] - dragStart[1]) };
  drawCrop(dragRect);
});
async function endCrop() {
  if (!dragStart) return;
  dragStart = null;
  const it = active;
  if (!it) return;
  if (!dragRect || dragRect.w < 0.05 || dragRect.h < 0.05) { drawCrop(effectiveCrop(it)); return; }
  it.crop = dragRect;
  await renderOut(it);
  refreshItemUI(it);
  setEditorMsg("Kırpıldı. Gemini'ye bu kırpılmış hali gider.");
}
els.cropCanvas.addEventListener("pointerup", endCrop);
els.cropCanvas.addEventListener("pointercancel", endCrop);
els.cropReset.onclick = async () => {
  const it = active;
  if (!it) return;
  it.crop = null;
  it.cropTouched = true;
  drawCrop(null);
  await renderOut(it);
  refreshItemUI(it);
};

els.useCurrent.onclick = () => { els.time.value = formatTime(Math.round(video.currentTime * 10) / 10); };
els.regrab.onclick = async () => {
  const it = active;
  if (!it) return;
  const t = parseTime(els.time.value);
  if (Number.isNaN(t)) return setEditorMsg("Zamanı dakika:saniye olarak yazın, ör. 03:15", true);
  if (video.duration && t > video.duration) return setEditorMsg("Bu zaman videonun süresinden uzun.", true);
  setItemTime(it, t);
  setEditorMsg("Kare alınıyor…");
  try {
    await grabItem(it);
    await loadCropCanvas(it);
    refreshItemUI(it);
    updateCounts();
    setEditorMsg(it.gemURL ? "Yeni kare alındı. Gemini görseli eski kareden; gerekirse yeniden düzenleyin." : "Yeni kare alındı.");
  } catch (e) { setEditorMsg(e.message, true); }
};
els.time.addEventListener("keydown", (e) => { if (e.key === "Enter") els.regrab.click(); });
els.photoType.onchange = async () => {
  const it = active;
  if (!it || isExtra(it) || isGuide(it) || isCover(it)) return;
  it.photoType = els.photoType.value;
  if (!it.crop && !it.cropTouched && it.rawBlob) { await renderOut(it); await loadCropCanvas(it); }
  refreshItemUI(it);
};

function renderGem(it) {
  const has = !!it?.gemURL;
  els.gemImg.hidden = !has;
  els.gemEmpty.hidden = has;
  els.gemRemove.hidden = !has;
  if (has) els.gemImg.src = it.gemURL; else els.gemImg.removeAttribute("src");
}

els.copyPrompt.onclick = async () => { if (active) await copyText(itemPrompt(active), els.copyPrompt); };
els.dlRaw.onclick = () => {
  if (!active?.outBlob) return setEditorMsg("Önce kare alınmalı.", true);
  saveBlob(active.outBlob, `${itemFileName(active)}.jpg`);
};
els.gemFile.addEventListener("change", () => {
  const it = active;
  const f = els.gemFile.files[0];
  els.gemFile.value = "";
  if (!it || !f) return;
  setGem(it, f);
  refreshItemUI(it);
  updateCounts();
  setEditorMsg("Gemini görseli eklendi. Ham kareyle karşılaştırıp ilmeklerin ve tekniğin değişmediğini kontrol edin.");
});
els.gemRemove.onclick = () => {
  if (!active) return;
  setGem(active, null);
  refreshItemUI(active);
  updateCounts();
};

// ---- Ok / daire / yazı işaretleri ----
let annTool = "arrow";
let annBmp = null, annBmpFor = null;
let annDrag = null;
function setAnnTool(t) {
  annTool = t;
  els.annArrow.classList.toggle("active", t === "arrow");
  els.annCircle.classList.toggle("active", t === "circle");
}
els.annArrow.onclick = () => setAnnTool("arrow");
els.annCircle.onclick = () => setAnnTool("circle");

async function drawAnn(preview) {
  const it = active;
  const c = els.annCanvas;
  const g = c.getContext("2d");
  const blob = it && (it.gemBlob || it.outBlob);
  if (!blob) { c.width = 320; c.height = 180; g.clearRect(0, 0, c.width, c.height); return; }
  if (annBmpFor !== blob) { annBmp?.close?.(); annBmp = await createImageBitmap(blob); annBmpFor = blob; }
  const k = Math.min(1, 1100 / annBmp.width);
  c.width = Math.round(annBmp.width * k);
  c.height = Math.round(annBmp.height * k);
  g.drawImage(annBmp, 0, 0, c.width, c.height);
  drawAnnotations(g, c.width, c.height, preview ? [...(it.ann || []), preview] : it.ann || []);
}
els.annCanvas.addEventListener("pointerdown", (e) => {
  if (!active || !(active.gemBlob || active.outBlob)) return;
  els.annCanvas.setPointerCapture(e.pointerId);
  annDrag = { start: canvasPoint(e, els.annCanvas), cur: null };
});
els.annCanvas.addEventListener("pointermove", (e) => {
  if (!annDrag) return;
  annDrag.cur = canvasPoint(e, els.annCanvas);
  const [x1, y1] = annDrag.start, [x2, y2] = annDrag.cur;
  drawAnn({ type: annTool, x1, y1, x2, y2, label: els.annLabel.value.trim() });
});
function endAnn() {
  if (!annDrag) return;
  const d = annDrag;
  annDrag = null;
  if (!d.cur || Math.hypot(d.cur[0] - d.start[0], d.cur[1] - d.start[1]) < 0.03) { drawAnn(); return; }
  const it = active;
  it.ann = it.ann || [];
  it.ann.push({ type: annTool, x1: d.start[0], y1: d.start[1], x2: d.cur[0], y2: d.cur[1], label: els.annLabel.value.trim() });
  drawAnn();
  refreshItemUI(it);
}
els.annCanvas.addEventListener("pointerup", endAnn);
els.annCanvas.addEventListener("pointercancel", endAnn);
els.annUndo.onclick = () => { if (active?.ann?.length) { active.ann.pop(); drawAnn(); refreshItemUI(active); } };
els.annClear.onclick = () => { if (active) { active.ann = []; drawAnn(); refreshItemUI(active); } };

// ---- Sıra fotoğrafları (bir adım için 2–3 ardışık kare) ----
function renderSeq() {
  const s = active && !isExtra(active) && !isGuide(active) && !isCover(active) ? active : null;
  if (!s) { els.seqList.innerHTML = ""; return; }
  const items = [s, ...(s.extras || [])];
  els.seqList.innerHTML = items.map((it, i) => {
    const url = finalURL(it);
    return `<div class="seq-item${active === it ? " on" : ""}" data-i="${i}">
      <button type="button" class="seq-pic">${url ? `<img alt="" src="${url}">` : `<span class="muted small">${it.status === "working" ? "…" : "kare yok"}</span>`}<span class="seq-no">${i + 1}</span></button>
      <span class="muted small">${itemTime(it) != null ? formatTime(Math.round(itemTime(it) * 10) / 10) : ""}${it.gemURL ? " · Gemini" : ""}</span>
      ${i > 0 ? `<button type="button" class="seq-del ghost small-btn" title="Kaldır">✕</button>` : ""}
    </div>`;
  }).join("");
}
els.seqList.addEventListener("click", (e) => {
  const box = e.target.closest(".seq-item");
  if (!box || !active) return;
  const s = isExtra(active) ? active.owner : active;
  const i = +box.dataset.i;
  if (e.target.closest(".seq-del")) {
    const x = s.extras[i - 1];
    releaseItem(x);
    s.extras.splice(i - 1, 1);
    renderSeq();
    updateRow(s);
    updateCounts();
    return;
  }
  if (e.target.closest(".seq-pic")) openItem(i === 0 ? s : s.extras[i - 1]);
});
els.seqAdd.onclick = async () => {
  const s = active && !isExtra(active) ? active : active?.owner;
  if (!s) return;
  if (!video.duration) return setEditorMsg("Önce videoyu seçin.", true);
  if ((s.extras || []).length >= 2) return setEditorMsg("Bir adım için en fazla 3 fotoğraf (1 + 2 sıra) eklenebilir.", true);
  const t = Math.round(video.currentTime * 10) / 10;
  const x = { owner: s, t, crop: s.crop || null, cropTouched: s.cropTouched, ann: [] };
  s.extras = [...(s.extras || []), x];
  setEditorMsg("Sıra fotoğrafı ekleniyor…");
  try { await grabItem(x); setEditorMsg("Sıra fotoğrafı eklendi. Videoyu bir sonraki ana getirip tekrar ekleyebilirsiniz."); }
  catch (err) { setEditorMsg(err.message, true); }
  renderSeq();
  updateRow(s);
  updateCounts();
};

// =============== Gemini: ayarlar, toplu indirme ve yükleme ===============
els.hands.innerHTML = HAND_OPTIONS.map((h) => `<option value="${h.id}">${h.label}</option>`).join("");
els.hands.value = store.get("uk_hands2") || "young_polish";
els.hands.onchange = () => store.set("uk_hands2", els.hands.value);
els.enhance.checked = store.get("uk_enhance") !== "0";
els.enhance.onchange = async () => {
  store.set("uk_enhance", els.enhance.checked ? "1" : "0");
  for (const it of [cover, ...steps.flatMap((s) => [s, ...(s.extras || [])]), ...guide]) {
    if (it.rawBlob) { await renderOut(it); refreshItemUI(it); }
  }
};

let jszipP = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  return (jszipP ??= new Promise((res, rej) => {
    const sc = document.createElement("script");
    sc.src = JSZIP_URL;
    sc.onload = () => res(window.JSZip);
    sc.onerror = () => { jszipP = null; rej(new Error("Zip aracı yüklenemedi. İnternet bağlantınızı kontrol edin.")); };
    document.head.appendChild(sc);
  }));
}

function masterPrompt() { return buildMasterPrompt({ title: els.pdfTitle.value.trim(), hands: els.hands.value }); }
els.copyMaster.onclick = () => copyText(masterPrompt(), els.copyMaster);

els.dlZip.onclick = async () => {
  const items = allItems();
  if (!items.length) return setGemMsg("Fotoğraflı adım yok.", true);
  if (items.some((it) => !it.outBlob && itemTime(it) != null)) {
    if (!video.duration) return setGemMsg("Önce videoyu seçip kareleri alın.", true);
    setGemMsg("Önce eksik kareler alınıyor…");
    await runBatch(false);
  }
  try {
    setGemMsg("Zip hazırlanıyor…");
    const JSZip = await loadJSZip();
    const zip = new JSZip();
    const nums = stepNumbers();
    const title = els.pdfTitle.value.trim();
    zip.file("1-ONCE-BUNU-YAPISTIR.txt", [
      "GEMINI'DE NASIL YAPILIR",
      "1) Gemini'de bu tarif için YENİ bir sohbet açın ve aşağıdaki ana komutu bir kez yapıştırıp gönderin.",
      "2) Sonra görselleri sırayla tek tek yükleyin. Her görselin yanına dosya adının sonundaki kelimeye göre yazın:",
      "   ...-sonuc.jpg  →  RESULT      ...-teknik.jpg  →  TECHNIQUE      kapak.jpg  →  COVER",
      "3) Gemini'nin verdiği görselleri indirin ve hepsini birden uygulamaya sürükleyin. Dosya adlarını değiştirmenize gerek yok.",
      "",
      "==================== ANA KOMUT ====================",
      masterPrompt(),
    ].join("\n"));
    const lines = ["İSTEĞE BAĞLI: Her görsel için ayrı, ayrıntılı komutlar (ana komut yetersiz kalırsa kullanın).", ""];
    for (const it of items) {
      if (!it.outBlob) continue;
      const name = itemFileName(it, nums);
      zip.file(`${name}.jpg`, it.outBlob);
      lines.push(`==================== ${name}.jpg ====================`, itemPrompt(it), "");
    }
    zip.file("2-TEK-TEK-KOMUTLAR.txt", lines.join("\n"));
    const blob = await zip.generateAsync({ type: "blob" });
    saveBlob(blob, `${(title || "tarif").replace(/[\\/:*?"<>|]+/g, "").slice(0, 60)}-kareler.zip`);
    setGemMsg("İndirildi. Zip'teki 1-ONCE-BUNU-YAPISTIR.txt dosyasını açın.");
  } catch (e) {
    setGemMsg(e.message, true);
  }
};

/** Küçük resim parmak izi (benzerlik eşleştirmesi için). */
async function descOf(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = DESC_W; c.height = DESC_H;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, DESC_W, DESC_H);
  bmp.close?.();
  return thumbDescriptor(g.getImageData(0, 0, DESC_W, DESC_H).data);
}
async function rawDesc(item) {
  if (!item.outBlob) return null;
  return (item._desc ??= await descOf(item.outBlob));
}

let review = []; // [{ file, url, target, how }]
let reviewTargets = [];

async function assignGeminiFiles(files) {
  const nums = stepNumbers();
  const targets = allItems();
  const byKey = new Map(targets.map((t) => [itemKey(t, nums), t]));
  const taken = new Set();
  const result = [];
  const rest = [];
  for (const f of files) {
    const k = keyFromFileName(f.name);
    const t = k ? byKey.get(k) : null;
    if (t && !taken.has(t)) { taken.add(t); result.push({ file: f, target: t, how: "dosya adı" }); }
    else rest.push(f);
  }
  const cands = targets.filter((t) => t.outBlob && !taken.has(t));
  let unmatched = rest;
  if (rest.length && cands.length) {
    try {
      const fd = await Promise.all(rest.map(descOf));
      const cd = await Promise.all(cands.map(rawDesc));
      const m = greedyMatch(fd.map((d) => cd.map((c) => descDistance(d, c))));
      unmatched = [];
      rest.forEach((f, i) => {
        if (m.has(i)) { const t = cands[m.get(i)]; taken.add(t); result.push({ file: f, target: t, how: "görüntü" }); }
        else unmatched.push(f);
      });
    } catch (e) { console.error(e); unmatched = rest; }
  }
  unmatched.sort((x, y) => (x.lastModified || 0) - (y.lastModified || 0));
  const free = targets.filter((t) => !t.gemURL && !taken.has(t));
  let leftover = 0;
  for (const f of unmatched) {
    const t = free.shift();
    if (t) { taken.add(t); result.push({ file: f, target: t, how: "sıra" }); } else leftover++;
  }
  for (const r of result) setGem(r.target, r.file);
  setReview(result, targets);
  return { placed: result.length, leftover, noRaw: rest.length && !cands.length };
}

function setReview(result, targets = allItems()) {
  review.forEach((r) => URL.revokeObjectURL(r.url));
  review = result.map((r) => ({ ...r, url: URL.createObjectURL(r.file) }));
  reviewTargets = targets;
  renderSteps();
  renderGuide();
  renderCover();
  renderReview();
  if (active) { renderGem(active); drawAnn(); renderSeq(); }
}

function renderReview() {
  const box = els.gemReview;
  if (!review.length) { box.hidden = true; box.innerHTML = ""; return; }
  const nums = stepNumbers();
  box.hidden = false;
  box.innerHTML = `<p class="label">Eşleştirmeyi kontrol edin <span class="muted small">— yanlışsa sağdaki listeden doğru yeri seçin</span></p>` +
    review.map((r, i) => `
      <div class="rv-row">
        <img class="rv-gem" alt="" src="${r.url}">
        <span class="rv-arrow">→</span>
        ${r.target.outURL ? `<img class="rv-raw" alt="" src="${r.target.outURL}">` : `<span class="rv-raw rv-none">ham kare yok</span>`}
        <div class="rv-pick">
          <select data-i="${i}">${reviewTargets.map((t, j) => `<option value="${j}" ${t === r.target ? "selected" : ""}>${esc(itemLabel(t, nums))}</option>`).join("")}</select>
          <span class="muted small">${{ "görüntü": "görüntüye göre eşleşti", "dosya adı": "dosya adına göre", "otomatik": "Gemini API ile düzenlendi", "elle": "elle seçildi" }[r.how] || "sıraya göre (kontrol edin)"}</span>
        </div>
      </div>`).join("");
}

els.gemReview.addEventListener("change", (e) => {
  const sel = e.target.closest("select[data-i]");
  if (!sel) return;
  const r = review[+sel.dataset.i];
  const next = reviewTargets[+sel.value];
  if (!next || next === r.target) return;
  const other = review.find((x) => x.target === next);
  const prev = r.target;
  if (prev.gemBlob === r.file) setGem(prev, null);
  if (other) { setGem(prev, other.file); other.target = prev; other.how = "elle"; }
  setGem(next, r.file);
  r.target = next;
  r.how = "elle";
  renderSteps();
  renderGuide();
  renderCover();
  renderReview();
  if (active) { renderGem(active); drawAnn(); renderSeq(); }
});

async function handleGemFiles(list) {
  const files = [...list].filter((f) => f.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(f.name));
  if (!files.length) return;
  setGemMsg("Görseller eşleştiriliyor…");
  const r = await assignGeminiFiles(files);
  setGemMsg(`${r.placed} görsel yerleştirildi. Aşağıdaki listeden kontrol edin.` +
    (r.noRaw ? " (Ham kareler alınmadığı için görüntüyle eşleştirme yapılamadı; önce \"Kareleri al\".)" : "") +
    (r.leftover ? ` ${r.leftover} görsel için boş yer kalmadı.` : ""), !!r.leftover);
}
els.gemFiles.addEventListener("change", () => { handleGemFiles(els.gemFiles.files); els.gemFiles.value = ""; });
["dragenter", "dragover"].forEach((ev) => els.gemDrop.addEventListener(ev, (e) => { e.preventDefault(); els.gemDrop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => els.gemDrop.addEventListener(ev, (e) => { e.preventDefault(); els.gemDrop.classList.remove("over"); }));
els.gemDrop.addEventListener("drop", (e) => handleGemFiles(e.dataTransfer.files));

// =============== Gemini API ile otomatik düzenleme ===============
els.gemModel.innerHTML = GEMINI_MODELS.map((m) => `<option value="${m.id}">${m.label}</option>`).join("");
els.gemKey.value = store.get("uk_gem_key") || "";
els.gemModel.value = store.get("uk_gem_model") || GEMINI_MODELS[0].id;
els.gemRemember.checked = store.get("uk_gem_remember") !== "0";
function saveGemSettings() {
  store.set("uk_gem_remember", els.gemRemember.checked ? "1" : "0");
  store.set("uk_gem_key", els.gemRemember.checked && els.gemKey.value.trim() ? els.gemKey.value.trim() : null);
  store.set("uk_gem_model", els.gemModel.value);
}
for (const el of [els.gemKey, els.gemModel, els.gemRemember]) el.addEventListener("change", saveGemSettings);

let gemAbort = null;
function gemKeyOrWarn(msgFn) {
  const k = els.gemKey.value.trim();
  if (!k) { els.gemKey.focus(); msgFn("Önce Gemini API anahtarını girin.", true); }
  return k;
}
async function aspectOf(blob) {
  const b = await createImageBitmap(blob);
  const r = nearestAspect(b.width, b.height);
  b.close?.();
  return r;
}
async function gemEdit(item, signal) {
  if (!item.outBlob) throw new Error("Ham kare yok.");
  const blob = await editImageWithGemini({
    apiKey: els.gemKey.value.trim(), model: els.gemModel.value, prompt: itemPrompt(item),
    blob: item.outBlob, aspect: isCover(item) ? "4:3" : await aspectOf(item.outBlob), signal,
  });
  setGem(item, blob);
  return blob;
}
const FATAL = /anahtar|faturalandırma|reddedildi|bağlanılamadı|kota/i;

async function runGeminiBatch(redoAll) {
  if (!gemKeyOrWarn(setGemAutoMsg)) return;
  let items = allItems();
  if (!items.length) return setGemAutoMsg("Fotoğraflı adım yok.", true);
  if (items.some((it) => !it.outBlob && itemTime(it) != null)) {
    if (!video.duration) return setGemAutoMsg("Önce videoyu seçin; Gemini'ye ham kareler gönderiliyor.", true);
    setGemAutoMsg("Önce eksik kareler alınıyor…");
    await runBatch(false);
    items = allItems();
  }
  const nums = stepNumbers();
  const jobs = items.filter((it) => it.outBlob && (redoAll || !it.gemURL));
  if (!jobs.length) return setGemAutoMsg("Düzenlenecek fotoğraf kalmadı ✓");
  gemAbort = new AbortController();
  els.gemAuto.disabled = els.gemAutoAll.disabled = true;
  els.gemStop.hidden = false;
  const done = [];
  let failed = 0, fatal = null;
  for (const [i, it] of jobs.entries()) {
    if (gemAbort.signal.aborted) break;
    const label = itemLabel(it, nums).replace(/ — .*/, "");
    setGemAutoMsg(`${i + 1}/${jobs.length} · ${label} Gemini'de düzenleniyor… (görsel başına 10–40 sn)`);
    it.status = "working";
    refreshItemUI(it);
    try {
      await gemEdit(it, gemAbort.signal);
      done.push({ file: it.gemBlob, target: it, how: "otomatik" });
    } catch (e) {
      if (e.name === "AbortError") { it.status = ""; break; }
      console.error(e);
      failed++;
      if (FATAL.test(e.message)) { fatal = e.message; it.status = ""; refreshItemUI(it); break; }
      setGemAutoMsg(`${label}: ${e.message}`, true);
      await sleep(800);
    }
    it.status = "";
    refreshItemUI(it);
    updateCounts();
  }
  setReview(done, items);
  els.gemAuto.disabled = els.gemAutoAll.disabled = false;
  els.gemStop.hidden = true;
  const stopped = gemAbort.signal.aborted;
  gemAbort = null;
  if (fatal) return setGemAutoMsg(fatal, true);
  setGemAutoMsg(stopped ? `Durduruldu. ${done.length} görsel düzenlendi.` :
    `${done.length} görsel düzenlendi${failed ? `, ${failed} tanesinde hata oldu (tekrar deneyebilirsiniz)` : ""}. ` +
    "Fotoğraflara dokunup ham kareyle karşılaştırın; teknik fotoğraflarda ip ve tığın yeri değişmemiş olmalı.", !!failed);
}
els.gemAuto.onclick = () => runGeminiBatch(false);
els.gemAutoAll.onclick = () => { if (confirm("Gemini görseli olan fotoğraflar da yeniden düzenlenecek (yeniden ücretlenir). Devam edilsin mi?")) runGeminiBatch(true); };
els.gemStop.onclick = () => gemAbort?.abort();

els.gemOne.onclick = async () => {
  const it = active;
  if (!it || !gemKeyOrWarn(setEditorMsg)) return;
  if (!it.outBlob) return setEditorMsg("Önce kare alınmalı.", true);
  els.gemOne.disabled = true;
  setEditorMsg("Gemini'de düzenleniyor… (10–40 sn)");
  try {
    await gemEdit(it);
    refreshItemUI(it);
    updateCounts();
    setEditorMsg("Gemini görseli hazır. Ham kareyle karşılaştırın; beğenmezseniz tekrar basabilirsiniz.");
  } catch (e) { setEditorMsg(e.message, true); }
  finally { els.gemOne.disabled = false; }
};

els.coverAuto.onclick = async () => {
  if (!gemKeyOrWarn(setMsg)) return;
  els.coverAuto.disabled = true;
  try {
    if (!cover.outBlob) await grabCover();
    els.coverAuto.textContent = "Düzenleniyor…";
    await gemEdit(cover);
    renderCover();
    setMsg("Kapak Gemini ile düzenlendi.");
  } catch (e) { setMsg(e.message, true); els.pdfCard.scrollIntoView({ block: "nearest" }); }
  finally { els.coverAuto.disabled = false; els.coverAuto.textContent = "✨ Kapağı Gemini ile düzenle"; }
};

// =============== Kapak ===============
async function grabCover() {
  const t = parseTime(els.coverTime.value || els.coverTime.placeholder);
  if (Number.isNaN(t)) throw new Error("Kapak zamanını dakika:saniye olarak yazın, ör. 0:03");
  cover.t = t;
  cover.rawBlob = await exclusive(() => grabFrameBlob(t));
  await renderOut(cover);
  renderCover();
}
function renderCover() {
  const url = finalURL(cover);
  els.coverImg.hidden = !url;
  els.coverEmpty.hidden = !!url;
  if (url) els.coverImg.src = url; else els.coverImg.removeAttribute("src");
  els.coverEmpty.textContent = cover.t != null && !url ? "Kareyi alın" : "Kapak yok";
  updateCounts();
}
els.coverImg.addEventListener("click", () => openItem(cover));
els.coverUseCurrent.onclick = () => { els.coverTime.value = formatTime(Math.round(video.currentTime * 10) / 10); };
els.coverGrab.onclick = async () => {
  try { await grabCover(); setMsg(""); } catch (e) { setMsg(e.message, true); els.pdfCard.scrollIntoView({ block: "nearest" }); }
};
els.coverTime.addEventListener("change", () => { const t = parseTime(els.coverTime.value); if (!Number.isNaN(t)) cover.t = t; });
els.coverDl.onclick = () => cover.outBlob ? saveBlob(cover.outBlob, "kapak.jpg") : setMsg("Önce kapak karesini alın.", true);
els.coverPrompt.onclick = () => copyText(itemPrompt(cover), els.coverPrompt);
els.coverFile.addEventListener("change", () => {
  const f = els.coverFile.files[0];
  els.coverFile.value = "";
  if (!f) return;
  setGem(cover, f);
  renderCover();
});

// =============== PDF ===============
// Görseller küçültülüp JPEG'e çevrilir ve ok/daire işaretleri görselin üzerine işlenir.
const PDF_MAX = 1600;
const pdfCache = new WeakMap(); // Blob → Map(işaret anahtarı → URL)
async function compressForPdf(blob, ann) {
  const key = JSON.stringify(ann || []);
  let m = pdfCache.get(blob);
  if (!m) { m = new Map(); pdfCache.set(blob, m); }
  if (m.has(key)) return m.get(key);
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, PDF_MAX / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  drawAnnotations(g, c.width, c.height, ann);
  const out = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
  const url = URL.createObjectURL(out);
  m.set(key, url);
  return url;
}
async function preparePdfImages() {
  for (const it of allItems()) {
    const b = it.gemBlob || it.outBlob;
    if (b) { try { await compressForPdf(b, it.ann); } catch (e) { console.error(e); } }
  }
}
function pdfSrc(item) {
  const b = item.gemBlob || item.outBlob;
  return (b && pdfCache.get(b)?.get(JSON.stringify(item.ann || []))) || finalURL(item);
}

// ---- Kitapçık yardımcıları ----
const ICONS = {
  yarn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="11" cy="12" r="8"/><path d="M5 8.5c4 0 9 2 12.5 6M4 13c4.5-.5 9 1 12 4.5M8 4.8c1.5 3 5.5 6 11 6.5M19 18.5l3 2.5"/></svg>',
  hook: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5 21 17.5 5.5"/><path d="M17.5 5.5c1-1.3 3.2-.6 2.6 1.1-.4 1-1.6 1.1-2.1.4"/><path d="M4 20l2.2 1.6"/></svg>',
};

/** "Row 1: ... (24 (34, 44) hdc)" → etiket, gövde, sondaki ilmek sayısı */
function splitStep(text) {
  let t = text.trim();
  let lbl = "";
  const m = t.match(/^((?:Rows?|Rnds?|Rounds?|Row|Rnd)\s[0-9][0-9\s–\-,()&]*?|Small leaf|Large leaf|Leaf|Stem|Step \d+)\s*:\s*/i);
  if (m) { lbl = m[1].trim() + ":"; t = t.slice(m[0].length); }
  let count = "";
  const end = t.replace(/\.\s*$/, "");
  if (end.endsWith(")")) {
    let depth = 0, k = end.length - 1;
    for (; k >= 0; k--) {
      if (end[k] === ")") depth++;
      else if (end[k] === "(" && --depth === 0) break;
    }
    const inner = k >= 0 ? end.slice(k + 1, -1) : "";
    if (k > 0 && /\d/.test(inner) && /\b(sc|hdc|dc|tr|sts?|ch|sl st|hdc per row|sc per round|stitches)\b/i.test(inner)) {
      count = inner;
      t = end.slice(0, k).trim();
    }
  }
  return { lbl, body: t, count };
}

/** Kapak görselinden canlı bir tema rengi seç (en sık görülen doygun ton). */
async function themeFromImage(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = 48; c.height = 48;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, 48, 48);
    bmp.close?.();
    const d = g.getImageData(0, 0, 48, 48).data;
    const buckets = new Array(36).fill(0);
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), l = (mx + mn) / 2, ch = mx - mn;
      if (ch < 0.25 || l < 0.18 || l > 0.85) continue;
      let h = mx === r ? ((gg - b) / ch) % 6 : mx === gg ? (b - r) / ch + 2 : (r - gg) / ch + 4;
      h = (h * 60 + 360) % 360;
      buckets[Math.floor(h / 10)] += ch;
    }
    const top = buckets.indexOf(Math.max(...buckets));
    if (buckets[top] === 0) return null;
    return top * 10 + 5;
  } catch { return null; }
}
function themeVars(hue) {
  const l = hue > 40 && hue < 170 ? 36 : 44;
  return `--b-accent:hsl(${hue} 58% ${l}%);--b-deep:hsl(${hue} 55% ${l - 14}%);--b-soft:hsl(${hue} 70% 96%);--b-line:hsl(${hue} 30% 88%)`;
}
function hexToHue(hex) {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), ch = mx - mn;
  if (!ch) return 20;
  const h = mx === r ? ((g - b) / ch) % 6 : mx === g ? (b - r) / ch + 2 : (r - g) / ch + 4;
  return Math.round((h * 60 + 360) % 360);
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const f = (n) => { const k = (n + h / 30) % 12; const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(c * 255).toString(16).padStart(2, "0"); };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function buildBooklet(hue = 18) {
  const inc = steps.filter((s) => s.include && s.text.trim());
  const nums = stepNumbers();
  const strip = (t) => String(t).replace(/\s*\[CHECK:[^\]]*\]/gi, "").trim();
  const clean = (t) => esc(strip(t));
  const lines = (t) => linesToList(t).map(strip).filter(Boolean);
  const ul = (t) => lines(t).map((l) => `<li>${esc(l)}</li>`).join("");
  const title = els.pdfTitle.value.trim() || "Pattern";
  const author = els.pdfAuthor.value.trim();
  const sizes = textToSizes(els.pdfSizes.value);
  const abbr = textToAbbr(els.pdfAbbr.value).filter((x) => x.abbr);
  const coverURL = pdfSrc(cover);
  const kicker = els.pdfKicker.value.trim() || "Crochet Pattern";

  const hookLine = lines(els.pdfTools.value).find((l) => /\d\s*mm/i.test(l));
  const chips = [
    els.pdfSkill.value && `Skill: ${els.pdfSkill.value}`,
    hookLine && `Hook: ${(hookLine.match(/[\d.,]+\s*mm/i) || [hookLine])[0]}`,
    sizes.rows.length > 1 && `${sizes.rows.length} sizes`,
    guide.some((g) => g.include) && "Stitch guide included",
    "US terms",
  ].filter(Boolean);

  const cards = [
    els.pdfMaterials.value.trim() && `<div class="b-card"><h3>${ICONS.yarn}Materials</h3><ul>${ul(els.pdfMaterials.value)}</ul></div>`,
    els.pdfTools.value.trim() && `<div class="b-card"><h3>${ICONS.hook}Tools</h3><ul>${ul(els.pdfTools.value)}</ul></div>`,
  ].filter(Boolean).join("");
  const sizesHTML = sizes.headers.length ? `
    <h3 class="b-h3">Finished sizes</h3>
    <table class="b-table"><thead><tr>${sizes.headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${sizes.rows.map((r) => `<tr>${sizes.headers.map((_, i) => `<td>${clean(r[i] ?? "") || "—"}</td>`).join("")}</tr>`).join("")}</tbody></table>` : "";
  const abbrHTML = abbr.length ? `<h3 class="b-h3">Abbreviations (US terms)</h3>
    <div class="b-abbr">${abbr.map((x) => `<div><b>${esc(x.abbr)}</b><span>${esc(x.meaning)}</span></div>`).join("")}</div>` : "";
  const tips = lines(els.pdfNotes.value);
  const tipsHTML = tips.length ? `<h3 class="b-h3">Good to know</h3><div class="b-tips">${tips.map((t) => `<div class="b-tip"><span>${esc(t)}</span></div>`).join("")}</div>` : "";

  const guideOn = guide.filter((g) => g.include);
  const guideHTML = guideOn.length ? `
    <section class="b-guide">
      <h1 class="b-page-title">Stitch guide</h1>
      <p class="b-guide-intro">New to crochet? These are the stitches and techniques used in this pattern. Come back to this page whenever you need a reminder.</p>
      <div class="b-guide-grid">${guideOn.map((g) => {
        const url = pdfSrc(g);
        return `<div class="b-gcard">
          ${url ? `<figure class="b-gphoto"><img alt="" src="${url}"></figure>` : ""}
          <h3>${esc(g.name)}${g.abbr ? ` <span class="b-gabbr">${esc(g.abbr)}</span>` : ""}</h3>
          <ol>${g.steps.map((x) => `<li>${esc(strip(x))}</li>`).join("")}</ol>
        </div>`;
      }).join("")}</div>
    </section>` : "";

  let lastSec, secNo = 0;
  const stepsHTML = inc.map((s) => {
    let head = "";
    if (s.section && s.section !== lastSec) {
      secNo++;
      head = `<div class="b-sec"><span class="b-sec-no">${String(secNo).padStart(2, "0")}</span><h2>${esc(s.section)}</h2></div>`;
    }
    lastSec = s.section;
    const n = nums.get(s.id);
    if (!n) return `${head}<div class="b-note">${clean(s.text)}</div>`;
    const { lbl, body, count } = splitStep(strip(s.text));
    const p = `<p>${lbl ? `<span class="b-lbl">${esc(lbl)}</span> ` : ""}${esc(body)}${count ? ` <span class="b-count">${esc(count)}</span>` : ""}</p>`;
    const photos = s.photo ? [s, ...(s.extras || [])].map(pdfSrc).filter(Boolean) : [];
    let img = "";
    let cls = "";
    if (photos.length > 1) {
      cls = " has-seq";
      img = `<div class="b-seq b-seq-${photos.length}">${photos.map((u, i) => `<figure class="b-photo"><img alt="" src="${u}"><span class="b-seq-no">${i + 1}</span></figure>`).join("")}</div>`;
    } else if (photos.length) {
      cls = " has-img";
      img = `<figure class="b-photo"><img alt="" src="${photos[0]}"></figure>`;
    }
    return `${head}<div class="b-step${cls}"><div class="b-num">${n}</div><div class="b-body">${p}${img}</div></div>`;
  }).join("");

  els.booklet.className = `size-${els.pdfSize.value}`;
  els.booklet.setAttribute("style", themeVars(hue));
  els.booklet.innerHTML = `
    <section class="b-cover">
      <div class="b-cover-photo">${coverURL ? `<img alt="" src="${coverURL}">` : ""}</div>
      <div class="b-cover-body">
        <div class="b-kicker">${esc(kicker)}</div>
        <h1>${esc(title)}</h1>
        ${els.pdfSubtitle.value.trim() ? `<p class="b-subtitle">${esc(els.pdfSubtitle.value.trim())}</p>` : ""}
        <div class="b-chips">${chips.map((c) => `<span class="b-chip">${esc(c)}</span>`).join("")}</div>
        <div class="b-cover-foot"><span>${author ? `Designed by <b>${esc(author)}</b>` : ""}</span><span>Digital PDF pattern</span></div>
      </div>
    </section>
    <section class="b-info">
      <h1 class="b-page-title">Before you begin</h1>
      ${els.pdfIntro.value.trim() ? `<p class="b-intro">${esc(els.pdfIntro.value.trim())}</p>` : ""}
      ${cards ? `<div class="b-cards">${cards}</div>` : ""}
      ${sizesHTML}${abbrHTML}${tipsHTML}
    </section>
    ${guideHTML}
    <section class="b-steps">
      <h1 class="b-steps-title">Instructions</h1>
      ${stepsHTML}
      <div class="b-end">
        <h2>You did it!</h2>
        <p>Thank you for making this pattern. If you enjoyed it, a short review on Etsy means the world to a small shop — and a photo of your finished piece is always a joy to see.</p>
        ${els.pdfCopyright.value.trim() ? `<p class="b-copy">${esc(els.pdfCopyright.value.trim())}</p>` : ""}
      </div>
    </section>`;
  let hs = document.getElementById("booklet-page-style");
  if (!hs) { hs = document.createElement("style"); hs.id = "booklet-page-style"; document.head.appendChild(hs); }
  const q = (t) => `"${t.replace(/["\\]/g, "")}"`;
  hs.textContent = `@media print { @page { @top-left { content: ${q(title)}; font: 600 8.5pt "Nunito Sans", sans-serif; color: #9a8f86; }
    @top-right { content: ${q(author)}; font: 600 8.5pt "Nunito Sans", sans-serif; color: #9a8f86; } } }`;
  return els.booklet.querySelectorAll("img");
}

async function bookletHue() {
  if (els.pdfColor.dataset.auto !== "0") {
    const b = cover.gemBlob || cover.outBlob;
    const h = b ? await themeFromImage(b) : null;
    if (h != null) {
      els.pdfColor.value = hslToHex(h, 58, h > 40 && h < 170 ? 36 : 44);
      return h;
    }
  }
  return hexToHue(els.pdfColor.value) ?? 18;
}
els.pdfColor.addEventListener("input", () => { els.pdfColor.dataset.auto = "0"; });

els.print.onclick = async () => {
  if (!steps.some((s) => s.include)) return setMsg("PDF'e eklenecek adım yok.", true);
  const items = allItems();
  const missing = items.filter((it) => !finalURL(it)).length;
  const raw = items.filter((it) => !it.gemURL && it.outURL).length;
  const checks = steps.filter((s) => s.include && /\[CHECK/i.test(s.text)).length;
  const warns = [
    missing && `${missing} görsel eksik.`,
    raw && `${raw} görselde Gemini hali yok, ham kare kullanılacak.`,
    !finalURL(cover) && "Kapak fotoğrafı yok.",
    checks && `${checks} adımda hâlâ [CHECK] notu var (notlar PDF'e yazılmaz ama içerik kontrol edilmeli).`,
  ].filter(Boolean);
  if (warns.length && !confirm(`${warns.join("\n")}\n\nYine de devam edilsin mi?`)) return;
  setMsg("PDF hazırlanıyor (görseller küçültülüyor)…");
  await preparePdfImages();
  setMsg("");
  const imgs = buildBooklet(await bookletHue());
  await Promise.all([...imgs].map((im) => (im.complete ? null : new Promise((r) => { im.onload = im.onerror = r; }))));
  try { await document.fonts?.ready; } catch { /* yok say */ }
  const oldTitle = document.title;
  document.title = els.pdfTitle.value.trim() || "pattern";
  window.print();
  document.title = oldTitle;
};

// =============== Proje kaydet / aç ===============
const FIELD_KEYS = ["pdfTitle", "pdfSubtitle", "pdfKicker", "pdfColor", "pdfIntro", "pdfSkill", "pdfAuthor", "pdfMaterials", "pdfTools",
  "pdfSizes", "pdfAbbr", "pdfNotes", "pdfCopyright", "pdfSize", "etsyTitle", "etsyDesc", "etsyTags", "coverTime"];

els.projectSave.onclick = () => {
  if (!steps.length && !els.transcript.value.trim()) return setMsg("Kaydedilecek bir şey yok.", true);
  const pick = (it) => ({ crop: it.crop || null, cropTouched: !!it.cropTouched, ann: it.ann || [] });
  const project = {
    app: "urun-karesi", version: 3, savedAt: new Date().toISOString(),
    videoName: els.videoName.textContent,
    transcript: els.transcript.value,
    frameAt: els.frameAt.value,
    hands: els.hands.value,
    fields: Object.fromEntries(FIELD_KEYS.map((k) => [k, els[k].value])),
    cover: { t: cover.t, ...pick(cover) },
    steps: steps.map((s) => ({
      section: s.section, text: s.text, kind: s.kind, start: s.start, end: s.end, include: s.include, photo: s.photo,
      photoType: s.photoType, photoDesc: s.photoDesc, customT: s.customT, ...pick(s),
      extras: (s.extras || []).map((x) => ({ t: x.t, ...pick(x) })),
    })),
    guide: guide.map((g) => ({ name: g.name, abbr: g.abbr, steps: g.steps, t: g.t, include: g.include, ...pick(g) })),
  };
  const name = (els.pdfTitle.value.trim() || els.videoName.textContent || "proje").replace(/[\\/:*?"<>|]+/g, "").slice(0, 80);
  saveBlob(new Blob([JSON.stringify(project, null, 2)], { type: "application/json" }), `${name}.json`);
  setMsg("Proje kaydedildi (metin, zamanlar, kırpmalar ve işaretler). Görseller dosyaya girmez: açınca aynı videoyu seçip \"Kareleri al\"a basın, Gemini görsellerini 3. bölüme sürükleyin.");
};

els.projectOpen.addEventListener("change", async () => {
  const f = els.projectOpen.files[0];
  els.projectOpen.value = "";
  if (!f) return;
  try {
    const p = JSON.parse(await f.text());
    if (p.app !== "urun-karesi" || !Array.isArray(p.steps)) throw new Error();
    steps.forEach(releaseStep);
    guide.forEach(releaseItem);
    releaseItem(cover);
    els.transcript.value = p.transcript || "";
    els.frameAt.value = p.frameAt || "end";
    if (p.hands) els.hands.value = p.hands;
    for (const [k, v] of Object.entries(p.fields || {})) if (els[k]) els[k].value = v ?? "";
    Object.assign(cover, { t: p.cover?.t ?? null, crop: p.cover?.crop ?? null, cropTouched: !!p.cover?.cropTouched, ann: p.cover?.ann || [] });
    steps = p.steps.map((s) => ({ photoType: "result", crop: null, ann: [], extras: [], ...s, id: nextId++, status: "" }));
    steps.forEach(wireExtras);
    guide = (p.guide || []).map((g) => ({ guide: true, crop: null, ann: [], include: true, ...g, id: `g${nextId++}` }));
    if (steps.length) showWorkCards();
    els.etsyCard.hidden = !(els.etsyTitle.value || els.etsyDesc.value);
    updateEtsyLen();
    closeEditor();
    renderSteps();
    renderGuide();
    renderCover();
    setMsg(`Proje açıldı: ${steps.length} adım. ` + (video.duration ? "\"Kareleri al\"a basın, " :
      `Videoyu seçin${p.videoName ? ` (${p.videoName})` : ""}, "Kareleri al"a basın, `) + "Gemini görsellerini 3. bölüme sürükleyin.");
  } catch {
    setMsg("Bu dosya bir Ürün Karesi projesi değil.", true);
  }
});

// =============== Yardımcılar ===============
function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = "✓ Kopyalandı";
    setTimeout(() => (btn.textContent = old), 1800);
  } catch {
    prompt("Kopyalayın:", text);
  }
}
function setMsg(text, isErr = false) { els.msg.textContent = text; els.msg.className = "msg" + (isErr ? " err" : ""); }
function setEditorMsg(text, isErr = false) { els.editorMsg.textContent = text; els.editorMsg.className = "msg" + (isErr ? " err" : ""); }
function setGemAutoMsg(text, isErr = false) { els.gemAutoMsg.textContent = text; els.gemAutoMsg.className = "msg" + (isErr ? " err" : ""); }
function setGemMsg(text, isErr = false) { els.gemMsg.textContent = text; els.gemMsg.className = "msg" + (isErr ? " err" : ""); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
