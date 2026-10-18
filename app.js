import { parseTime, formatTime, autoLevels, thumbDescriptor, descDistance, greedyMatch, DESC_W, DESC_H } from "./processing.js?v=20261018g";
import { parseTranscript, classify, wantsPhoto } from "./transcript.js?v=20261018g";
import {
  MODELS, writePattern, patternToSteps, buildChatPrompt, parseChatReply,
  linesToList, sizesToText, textToSizes, abbrToText, textToAbbr,
} from "./pattern.js?v=20261018g";
import { HAND_OPTIONS, buildGeminiPrompt, buildCoverPrompt, fileNameFor, numberFromFileName } from "./gemini.js?v=20261018g";

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
  "gemini-card", "hands", "enhance", "dl-zip", "gem-status", "gem-drop", "gem-files", "gem-msg", "gem-review",
  "pdf-card", "pdf-title", "pdf-intro", "pdf-author", "pdf-size", "print", "booklet",
  "cover-img", "cover-empty", "cover-time", "cover-use-current", "cover-grab", "cover-dl", "cover-prompt", "cover-file",
  "project-save", "project-open", "ai-card", "ai-status", "api-key", "ai-model", "api-remember", "ai-write", "ai-cancel",
  "pdf-subtitle", "pdf-skill", "pdf-materials", "pdf-tools", "pdf-sizes", "pdf-abbr", "pdf-notes", "pdf-copyright",
  "etsy-card", "etsy-title", "etsy-title-len", "etsy-desc", "etsy-tags",
  "chat-copy", "chat-paste-open", "chat-panel", "chat-reply", "chat-apply", "chat-close",
].map((id) => [id.replace(/-(\w)/g, (_, c) => c.toUpperCase()), $(id)]));

// ---- Durum ----
// Adım: { id, section, text, kind, start, end, include, photo, photoType, customT, crop,
//         rawBlob (tam kare), outBlob/outURL (kırpılmış ham), gemBlob/gemURL (Gemini), fileNo, status }
let steps = [];
let nextId = 1;
let activeId = null;
let cancelBatch = false;
let batchRunning = false;
const cover = { t: null, rawBlob: null, crop: null, outBlob: null, outURL: null, gemBlob: null, gemURL: null };

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
  for (const s of steps) { s.rawBlob = null; setOut(s, null); s.status = ""; }
  cover.rawBlob = null; setOut(cover, null);
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
  const c0 = item.crop || { x: 0, y: 0, w: 1, h: 1 };
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
function releaseStep(s) { setOut(s, null); setGem(s, null); s.rawBlob = null; }
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
  steps = patternToSteps(p, video.duration || 0, () => nextId++);
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
  renderCover();
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


// =============== Adım listesi ===============
function frameTime(s) {
  if (s.customT != null) return s.customT;
  const mode = els.frameAt.value;
  if (mode === "start") return s.start + 1;
  if (mode === "mid") return (s.start + s.end) / 2;
  return Math.max(s.start, s.end - 0.7);
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const stepById = (id) => steps.find((s) => s.id === +id);

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
const fileNoOf = (s) => s.fileNo ?? stepNumbers().get(s.id);

function picHTML(s) {
  const url = finalURL(s);
  if (url) return `<img alt="" src="${url}"><span class="badge ${s.gemURL ? "gem" : "raw"}">${s.gemURL ? "Gemini" : "ham"}</span>`;
  if (s.status === "working") return "";
  if (s.status === "error") return "hata";
  return s.photo ? "bekliyor" : "—";
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
  return `step ${s.kind}${s.include ? "" : " off"}${s.id === activeId ? " active" : ""}${/\[CHECK/i.test(s.text) ? " check" : ""}`;
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
  const ph = steps.filter((s) => s.include && s.photo);
  const missing = ph.filter((s) => !s.rawBlob && !s.gemURL).length;
  const gem = ph.filter((s) => s.gemURL).length;
  const checks = steps.filter((s) => s.include && /\[CHECK/i.test(s.text)).length;
  els.stepsCount.textContent = `${inc} adım PDF'te · ${ph.length} fotoğraf` + (checks ? ` · ${checks} [CHECK] notu` : "");
  els.extract.textContent = missing ? `Kareleri al (${missing})` : "Kareler hazır ✓";
  els.extract.disabled = batchRunning || !missing;
  els.extractAll.disabled = batchRunning || !ph.length;
  els.gemStatus.textContent = ph.length ? `${gem}/${ph.length} fotoğrafın Gemini görseli yüklendi${cover.gemURL ? " · kapak ✓" : ""}` : "";
}

els.steps.addEventListener("click", (e) => {
  const li = e.target.closest("li.step");
  if (!li) return;
  const s = stepById(li.dataset.id);
  if (e.target.closest(".ts")) {
    if (video.duration) video.currentTime = s.start;
  } else if (e.target.closest(".pic")) {
    openStep(s);
  } else if (e.target.closest(".merge")) {
    mergeUp(s);
  } else if (e.target.closest(".ptype")) {
    s.photoType = s.photoType === "technique" ? "result" : "technique";
    updateRow(s);
    if (s.id === activeId) els.photoType.value = s.photoType;
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
  if (prev.kind !== "step" && s.kind === "step") prev.kind = "step";
  // Birleşen adımın karesi (işin bittiği an) daha anlamlı: onu taşı
  if (s.photo && (s.rawBlob || s.gemURL)) {
    releaseStep(prev);
    Object.assign(prev, {
      photo: true, photoType: s.photoType, customT: s.customT, crop: s.crop,
      rawBlob: s.rawBlob, outBlob: s.outBlob, outURL: s.outURL, gemBlob: s.gemBlob, gemURL: s.gemURL,
    });
    s.outURL = s.gemURL = null;
  } else {
    prev.photo = prev.photo || s.photo;
    releaseStep(s);
  }
  steps.splice(i, 1);
  if (activeId === s.id) closeEditor();
  renderSteps();
}

els.addStep.onclick = () => {
  if (!video.duration) return setMsg("Önce videoyu seçin.", true);
  const t = Math.round(video.currentTime * 10) / 10;
  const at = steps.findIndex((x) => x.start > t);
  const before = steps[(at < 0 ? steps.length : at) - 1];
  const s = {
    id: nextId++, section: before?.section || "", start: t, end: t + 3, text: "", kind: "step",
    include: true, photo: true, photoType: "result", customT: t, crop: null, status: "",
  };
  steps.splice(at < 0 ? steps.length : at, 0, s);
  showWorkCards();
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

// =============== Kareleri toplu alma ===============
async function grabStep(s) {
  const t = frameTime(s);
  s.rawBlob = await exclusive(() => grabFrameBlob(t));
  s.rawT = t;
  await renderOut(s);
}

async function runBatch(redoAll) {
  if (!video.duration) return setMsg("Önce videoyu seçin.", true);
  const list = steps.filter((s) => s.include && s.photo && (redoAll || (!s.rawBlob && !s.gemURL)));
  if (!list.length) return;
  batchRunning = true;
  cancelBatch = false;
  els.cancel.hidden = false;
  updateCounts();
  let done = 0;
  for (const s of list) {
    if (cancelBatch) break;
    s.status = "working";
    updateRow(s);
    els.batchMsg.textContent = `${done + 1}/${list.length} kare alınıyor…`;
    try {
      await grabStep(s);
      s.status = "";
    } catch (e) {
      console.error(e);
      s.status = "error";
    }
    done++;
    updateRow(s);
    updateCounts();
  }
  if (cover.t != null && !cover.rawBlob && !cancelBatch) await grabCover().catch(() => {});
  batchRunning = false;
  els.cancel.hidden = true;
  els.batchMsg.textContent = cancelBatch ? "Durduruldu." :
    `${done} kare hazır. Fotoğrafa dokunarak kırpabilir, sonra 3. bölümden Gemini için indirebilirsiniz.`;
  updateCounts();
}
els.extract.onclick = () => runBatch(false);
els.extractAll.onclick = () => runBatch(true);
els.cancel.onclick = () => { cancelBatch = true; els.batchMsg.textContent = "Durduruluyor…"; };

// =============== Tek adım: kırpma ve Gemini görseli ===============
let cropBmp = null;   // Açık adımın ham karesi (çizim için)
let dragStart = null;
let dragRect = null;

function activeStep() { return stepById(activeId); }

async function openStep(s) {
  activeId = s.id;
  els.editorCard.hidden = false;
  const n = stepNumbers().get(s.id);
  els.editorTitle.textContent = `${n ? `Adım ${n}` : "Adım"} · ${formatTime(Math.floor(s.start))}`;
  els.editorText.textContent = s.text;
  els.time.value = formatTime(Math.round(frameTime(s) * 10) / 10);
  els.photoType.value = s.photoType;
  setEditorMsg("");
  for (const li of els.steps.querySelectorAll("li.step")) li.classList.toggle("active", +li.dataset.id === s.id);
  renderGem(s);
  els.editorCard.scrollIntoView({ behavior: "smooth", block: "start" });
  if (!s.rawBlob && video.duration) {
    setEditorMsg("Kare alınıyor…");
    try { await grabStep(s); setEditorMsg(""); updateRow(s); updateCounts(); }
    catch (e) { setEditorMsg(e.message, true); }
  } else if (!s.rawBlob) {
    setEditorMsg("Ham kare için önce videoyu seçin.", true);
  }
  if (activeId === s.id) await loadCropCanvas(s);
}

function closeEditor() {
  activeId = null;
  cropBmp?.close?.();
  cropBmp = null;
  els.editorCard.hidden = true;
  for (const li of els.steps.querySelectorAll("li.step")) li.classList.remove("active");
}
els.editorClose.onclick = closeEditor;

async function loadCropCanvas(s) {
  cropBmp?.close?.();
  cropBmp = s.rawBlob ? await createImageBitmap(s.rawBlob) : null;
  drawCrop(s.crop);
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

function canvasPoint(e) {
  const r = els.cropCanvas.getBoundingClientRect();
  return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
}
els.cropCanvas.addEventListener("pointerdown", (e) => {
  if (!cropBmp) return;
  els.cropCanvas.setPointerCapture(e.pointerId);
  dragStart = canvasPoint(e);
  dragRect = null;
});
els.cropCanvas.addEventListener("pointermove", (e) => {
  if (!dragStart) return;
  const p = canvasPoint(e);
  dragRect = { x: Math.min(p[0], dragStart[0]), y: Math.min(p[1], dragStart[1]), w: Math.abs(p[0] - dragStart[0]), h: Math.abs(p[1] - dragStart[1]) };
  drawCrop(dragRect);
});
async function endCrop() {
  if (!dragStart) return;
  dragStart = null;
  const s = activeStep();
  if (!s) return;
  if (!dragRect || dragRect.w < 0.05 || dragRect.h < 0.05) { drawCrop(s.crop); return; }
  s.crop = dragRect;
  await renderOut(s);
  updateRow(s);
  setEditorMsg("Kırpıldı. Gemini'ye bu kırpılmış hali gider.");
}
els.cropCanvas.addEventListener("pointerup", endCrop);
els.cropCanvas.addEventListener("pointercancel", endCrop);
els.cropReset.onclick = async () => {
  const s = activeStep();
  if (!s) return;
  s.crop = null;
  drawCrop(null);
  await renderOut(s);
  updateRow(s);
};

els.useCurrent.onclick = () => { els.time.value = formatTime(Math.round(video.currentTime * 10) / 10); };
els.regrab.onclick = async () => {
  const s = activeStep();
  if (!s) return;
  const t = parseTime(els.time.value);
  if (Number.isNaN(t)) return setEditorMsg("Zamanı dakika:saniye olarak yazın, ör. 03:15", true);
  if (video.duration && t > video.duration) return setEditorMsg("Bu zaman videonun süresinden uzun.", true);
  s.customT = t;
  setEditorMsg("Kare alınıyor…");
  try {
    await grabStep(s);
    await loadCropCanvas(s);
    updateRow(s);
    updateCounts();
    setEditorMsg(s.gemURL ? "Yeni kare alındı. Gemini görseli eski kareden; gerekirse yeniden yükleyin." : "Yeni kare alındı.");
  } catch (e) { setEditorMsg(e.message, true); }
};
els.time.addEventListener("keydown", (e) => { if (e.key === "Enter") els.regrab.click(); });
els.photoType.onchange = () => {
  const s = activeStep();
  if (!s) return;
  s.photoType = els.photoType.value;
  updateRow(s);
};

function renderGem(s) {
  const has = !!s?.gemURL;
  els.gemImg.hidden = !has;
  els.gemEmpty.hidden = has;
  els.gemRemove.hidden = !has;
  if (has) els.gemImg.src = s.gemURL; else els.gemImg.removeAttribute("src");
}

function geminiPromptFor(s) {
  return buildGeminiPrompt({ type: s.photoType, text: s.text, desc: s.photoDesc, hands: els.hands.value, title: els.pdfTitle.value.trim() });
}

els.copyPrompt.onclick = async () => {
  const s = activeStep();
  if (!s) return;
  await copyText(geminiPromptFor(s), els.copyPrompt);
};
els.dlRaw.onclick = () => {
  const s = activeStep();
  if (!s?.outBlob) return setEditorMsg("Önce kare alınmalı.", true);
  saveBlob(s.outBlob, `${fileNameFor(fileNoOf(s) || 0)}.jpg`);
};
els.gemFile.addEventListener("change", () => {
  const s = activeStep();
  const f = els.gemFile.files[0];
  els.gemFile.value = "";
  if (!s || !f) return;
  setGem(s, f);
  renderGem(s);
  updateRow(s);
  updateCounts();
  setEditorMsg("Gemini görseli bu adıma eklendi. Ham kareyle karşılaştırıp ilmeklerin ve tekniğin değişmediğini kontrol edin.");
});
els.gemRemove.onclick = () => {
  const s = activeStep();
  if (!s) return;
  setGem(s, null);
  renderGem(s);
  updateRow(s);
  updateCounts();
};

// =============== Gemini: toplu indirme ve yükleme ===============
els.hands.innerHTML = HAND_OPTIONS.map((h) => `<option value="${h.id}">${h.label}</option>`).join("");
els.hands.value = store.get("uk_hands2") || "young_polish";
els.hands.onchange = () => store.set("uk_hands2", els.hands.value);
els.enhance.checked = store.get("uk_enhance") !== "0";
els.enhance.onchange = async () => {
  store.set("uk_enhance", els.enhance.checked ? "1" : "0");
  for (const s of steps) if (s.rawBlob) { await renderOut(s); updateRow(s); }
  if (cover.rawBlob) { await renderOut(cover); renderCover(); }
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

els.dlZip.onclick = async () => {
  const list = steps.filter((s) => s.include && s.photo);
  if (!list.length) return setGemMsg("Fotoğraflı adım yok.", true);
  const missing = list.filter((s) => !s.outBlob).length;
  if (missing) {
    if (!video.duration) return setGemMsg("Önce videoyu seçip kareleri alın.", true);
    setGemMsg(`Önce ${missing} kare alınıyor…`);
    await runBatch(false);
  }
  if (cover.t != null && !cover.outBlob && video.duration) await grabCover().catch(() => {});
  try {
    setGemMsg("Zip hazırlanıyor…");
    const JSZip = await loadJSZip();
    const zip = new JSZip();
    const nums = stepNumbers();
    const title = els.pdfTitle.value.trim();
    const lines = [
      `GEMINI KOMUTLARI — ${title || "tarif"}`,
      "Her görseli Gemini'ye yükleyin, altındaki komutu yapıştırın ve sonucu indirin.",
      "Dosya adlarını değiştirmenize gerek yok: uygulama Gemini görsellerini ham karelere bakarak doğru adıma yerleştirir.",
      "",
    ];
    if (cover.outBlob) {
      zip.file("kapak.jpg", cover.outBlob);
      lines.push("==================== kapak.jpg ====================", buildCoverPrompt({ title }), "");
    }
    for (const s of list) {
      if (!s.outBlob) continue;
      s.fileNo = nums.get(s.id);
      const name = fileNameFor(s.fileNo);
      zip.file(`${name}.jpg`, s.outBlob);
      lines.push(`==================== ${name}.jpg (${s.photoType === "technique" ? "teknik" : "sonuç"}) ====================`,
        geminiPromptFor(s), "");
    }
    zip.file("GEMINI-KOMUTLARI.txt", lines.join("\n"));
    const blob = await zip.generateAsync({ type: "blob" });
    saveBlob(blob, `${(title || "tarif").replace(/[\\/:*?"<>|]+/g, "").slice(0, 60)}-kareler.zip`);
    setGemMsg("İndirildi. Zip'i açın; GEMINI-KOMUTLARI.txt her görselin komutunu içeriyor.");
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

const targetKey = (t) => (t === cover ? "cover" : String(t.id));
const targetByKey = (k) => (k === "cover" ? cover : stepById(k));
function targetLabel(t) {
  if (t === cover) return "Kapak";
  const n = stepNumbers().get(t.id);
  return `Adım ${n ?? "?"} — ${t.text.replace(/\s*\[CHECK:[^\]]*\]/gi, "").slice(0, 38)}`;
}

let review = []; // [{ file, url, target, how }]

async function assignGeminiFiles(files) {
  const nums = stepNumbers();
  const photoSteps = steps.filter((s) => s.include && s.photo);
  const byNo = new Map(photoSteps.map((s) => [s.fileNo ?? nums.get(s.id), s]));
  const taken = new Set();
  const result = [];
  const rest = [];
  // 1) Dosya adında numara varsa (adim-05, kapak) doğrudan
  for (const f of files) {
    const no = numberFromFileName(f.name);
    const t = no === 0 ? cover : no != null ? byNo.get(no) : null;
    if (t && !taken.has(t)) { taken.add(t); result.push({ file: f, target: t, how: "dosya adı" }); }
    else rest.push(f);
  }
  // 2) Görüntü benzerliği: Gemini kadrajı koruduğu için her görsel kendi ham karesine en çok benzer
  const cands = [cover, ...photoSteps].filter((t) => t.outBlob && !taken.has(t));
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
  // 3) Kalanlar: değiştirilme zamanına göre, görseli olmayan adımlara sırayla
  unmatched.sort((x, y) => (x.lastModified || 0) - (y.lastModified || 0));
  const free = photoSteps.filter((s) => !s.gemURL && !taken.has(s));
  let leftover = 0;
  for (const f of unmatched) {
    const t = free.shift();
    if (t) { taken.add(t); result.push({ file: f, target: t, how: "sıra" }); } else leftover++;
  }
  for (const r of result) setGem(r.target, r.file);
  review.forEach((r) => URL.revokeObjectURL(r.url));
  review = result.map((r) => ({ ...r, url: URL.createObjectURL(r.file) }));
  renderSteps();
  renderCover();
  renderReview();
  const s = activeStep();
  if (s) renderGem(s);
  return { placed: result.length, leftover, noRaw: rest.length && !cands.length };
}

function renderReview() {
  const box = els.gemReview;
  if (!review.length) { box.hidden = true; box.innerHTML = ""; return; }
  const targets = [cover, ...steps.filter((s) => s.include && s.photo)];
  box.hidden = false;
  box.innerHTML = `<p class="label">Eşleştirmeyi kontrol edin <span class="muted small">— yanlışsa sağdaki listeden doğru adımı seçin</span></p>` +
    review.map((r, i) => `
      <div class="rv-row">
        <img class="rv-gem" alt="" src="${r.url}">
        <span class="rv-arrow">→</span>
        ${r.target.outURL ? `<img class="rv-raw" alt="" src="${r.target.outURL}">` : `<span class="rv-raw rv-none">ham kare yok</span>`}
        <div class="rv-pick">
          <select data-i="${i}">${targets.map((t) => `<option value="${targetKey(t)}" ${t === r.target ? "selected" : ""}>${esc(targetLabel(t))}</option>`).join("")}</select>
          <span class="muted small">${r.how === "görüntü" ? "görüntüye göre eşleşti" : r.how === "dosya adı" ? "dosya adına göre" : "sıraya göre (kontrol edin)"}</span>
        </div>
      </div>`).join("");
}

els.gemReview.addEventListener("change", (e) => {
  const sel = e.target.closest("select[data-i]");
  if (!sel) return;
  const r = review[+sel.dataset.i];
  const next = targetByKey(sel.value);
  if (!next || next === r.target) return;
  const other = review.find((x) => x.target === next);
  const prev = r.target;
  if (prev.gemBlob === r.file) setGem(prev, null);
  if (other) { setGem(prev, other.file); other.target = prev; other.how = "elle"; }
  setGem(next, r.file);
  r.target = next;
  r.how = "elle";
  renderSteps();
  renderCover();
  renderReview();
  const s = activeStep();
  if (s) renderGem(s);
});

async function handleGemFiles(list) {
  const files = [...list].filter((f) => f.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(f.name));
  if (!files.length) return;
  setGemMsg("Görseller eşleştiriliyor…");
  const r = await assignGeminiFiles(files);
  setGemMsg(`${r.placed} görsel yerleştirildi. Aşağıdaki listeden kontrol edin.` +
    (r.noRaw ? " (Ham kareler alınmadığı için görüntüyle eşleştirme yapılamadı; önce \"Kareleri al\".)" : "") +
    (r.leftover ? ` ${r.leftover} görsel için boş adım kalmadı.` : ""), !!r.leftover);
}
els.gemFiles.addEventListener("change", () => { handleGemFiles(els.gemFiles.files); els.gemFiles.value = ""; });
["dragenter", "dragover"].forEach((ev) => els.gemDrop.addEventListener(ev, (e) => { e.preventDefault(); els.gemDrop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => els.gemDrop.addEventListener(ev, (e) => { e.preventDefault(); els.gemDrop.classList.remove("over"); }));
els.gemDrop.addEventListener("drop", (e) => handleGemFiles(e.dataTransfer.files));

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
els.coverUseCurrent.onclick = () => { els.coverTime.value = formatTime(Math.round(video.currentTime * 10) / 10); };
els.coverGrab.onclick = async () => {
  try { await grabCover(); setMsg(""); } catch (e) { setMsg(e.message, true); els.pdfCard.scrollIntoView({ block: "nearest" }); }
};
els.coverTime.addEventListener("change", () => { const t = parseTime(els.coverTime.value); if (!Number.isNaN(t)) cover.t = t; });
els.coverDl.onclick = () => cover.outBlob ? saveBlob(cover.outBlob, "kapak.jpg") : setMsg("Önce kapak karesini alın.", true);
els.coverPrompt.onclick = () => copyText(buildCoverPrompt({ title: els.pdfTitle.value.trim() }), els.coverPrompt);
els.coverFile.addEventListener("change", () => {
  const f = els.coverFile.files[0];
  els.coverFile.value = "";
  if (!f) return;
  setGem(cover, f);
  renderCover();
});

// =============== PDF ===============
function buildBooklet() {
  const inc = steps.filter((s) => s.include && s.text.trim());
  const nums = stepNumbers();
  const clean = (t) => esc(String(t).replace(/\s*\[CHECK:[^\]]*\]/gi, "")); // Kontrol notları PDF'e girmez
  const title = els.pdfTitle.value.trim() || "Pattern";
  const author = els.pdfAuthor.value.trim();
  const list = (t) => linesToList(t).map((l) => `<li>${clean(l)}</li>`).join("");
  const sizes = textToSizes(els.pdfSizes.value);
  const abbr = textToAbbr(els.pdfAbbr.value);
  const coverURL = finalURL(cover);

  const infoBlocks = [
    els.pdfMaterials.value.trim() && `<div class="b-box"><h3>Materials</h3><ul>${list(els.pdfMaterials.value)}</ul></div>`,
    els.pdfTools.value.trim() && `<div class="b-box"><h3>Tools</h3><ul>${list(els.pdfTools.value)}</ul></div>`,
  ].filter(Boolean).join("");
  const sizesHTML = sizes.headers.length ? `
    <h3>Finished Sizes</h3>
    <table class="b-table"><thead><tr>${sizes.headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${sizes.rows.map((r) => `<tr>${r.map((c) => `<td>${clean(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : "";
  const abbrHTML = abbr.length ? `
    <h3>Abbreviations (US terms)</h3>
    <table class="b-table b-abbr"><tbody>${abbr.map((a) => `<tr><th>${esc(a.abbr)}</th><td>${esc(a.meaning)}</td></tr>`).join("")}</tbody></table>` : "";
  const notesHTML = els.pdfNotes.value.trim()
    ? `<h3>Notes</h3><ul class="b-notes">${linesToList(els.pdfNotes.value).map((l) => `<li>${clean(l)}</li>`).join("")}</ul>` : "";

  let lastSec;
  const stepsHTML = inc.map((s) => {
    let head = "";
    if (s.section && s.section !== lastSec) head = `<h2 class="b-sec">${esc(s.section)}</h2>`;
    lastSec = s.section;
    const url = s.photo ? finalURL(s) : null;
    const img = url ? `<img alt="" src="${url}">` : "";
    const n = nums.get(s.id);
    if (!n) return `${head}<div class="b-note">${clean(s.text)}</div>`;
    return `${head}<div class="b-step"><div class="b-num">${n}</div><div class="b-body"><p>${clean(s.text)}</p>${img}</div></div>`;
  }).join("");

  els.booklet.className = `size-${els.pdfSize.value}`;
  els.booklet.innerHTML = `
    <section class="b-cover">
      ${els.pdfSkill.value ? `<div class="b-skill">${esc(els.pdfSkill.value)}</div>` : ""}
      <h1>${esc(title)}</h1>
      ${els.pdfSubtitle.value.trim() ? `<p class="b-subtitle">${esc(els.pdfSubtitle.value.trim())}</p>` : ""}
      ${coverURL ? `<img alt="" src="${coverURL}">` : ""}
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
  const ph = steps.filter((s) => s.include && s.photo);
  const missing = ph.filter((s) => !finalURL(s)).length;
  const raw = ph.filter((s) => !s.gemURL && s.outURL).length;
  const checks = steps.filter((s) => s.include && /\[CHECK/i.test(s.text)).length;
  const warns = [
    missing && `${missing} adımın fotoğrafı yok.`,
    raw && `${raw} adımda Gemini görseli yok, ham kare kullanılacak.`,
    !finalURL(cover) && "Kapak fotoğrafı yok.",
    checks && `${checks} adımda hâlâ [CHECK] notu var (notlar PDF'e yazılmaz ama içerik kontrol edilmeli).`,
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
const FIELD_KEYS = ["pdfTitle", "pdfSubtitle", "pdfIntro", "pdfSkill", "pdfAuthor", "pdfMaterials", "pdfTools",
  "pdfSizes", "pdfAbbr", "pdfNotes", "pdfCopyright", "pdfSize", "etsyTitle", "etsyDesc", "etsyTags", "coverTime"];

els.projectSave.onclick = () => {
  if (!steps.length && !els.transcript.value.trim()) return setMsg("Kaydedilecek bir şey yok.", true);
  const project = {
    app: "urun-karesi", version: 2, savedAt: new Date().toISOString(),
    videoName: els.videoName.textContent,
    transcript: els.transcript.value,
    frameAt: els.frameAt.value,
    hands: els.hands.value,
    fields: Object.fromEntries(FIELD_KEYS.map((k) => [k, els[k].value])),
    cover: { t: cover.t, crop: cover.crop },
    steps: steps.map(({ section, text, kind, start, end, include, photo, photoType, photoDesc, customT, crop, fileNo }) =>
      ({ section, text, kind, start, end, include, photo, photoType, photoDesc, customT, crop, fileNo })),
  };
  const name = (els.pdfTitle.value.trim() || els.videoName.textContent || "proje").replace(/[\\/:*?"<>|]+/g, "").slice(0, 80);
  saveBlob(new Blob([JSON.stringify(project, null, 2)], { type: "application/json" }), `${name}.json`);
  setMsg("Proje kaydedildi. Görseller dosyaya girmez: açınca aynı videoyu seçip \"Kareleri al\"a basın ve Gemini görsellerini 3. bölüme yeniden sürükleyin.");
};

els.projectOpen.addEventListener("change", async () => {
  const f = els.projectOpen.files[0];
  els.projectOpen.value = "";
  if (!f) return;
  try {
    const p = JSON.parse(await f.text());
    if (p.app !== "urun-karesi" || !Array.isArray(p.steps)) throw new Error();
    steps.forEach(releaseStep);
    setOut(cover, null); setGem(cover, null); cover.rawBlob = null;
    els.transcript.value = p.transcript || "";
    els.frameAt.value = p.frameAt || "end";
    if (p.hands) els.hands.value = p.hands;
    for (const [k, v] of Object.entries(p.fields || {})) if (els[k]) els[k].value = v ?? "";
    cover.t = p.cover?.t ?? null;
    cover.crop = p.cover?.crop ?? null;
    steps = p.steps.map((s) => ({ photoType: "result", crop: null, ...s, id: nextId++, status: "" }));
    if (steps.length) showWorkCards();
    els.etsyCard.hidden = !(els.etsyTitle.value || els.etsyDesc.value);
    updateEtsyLen();
    closeEditor();
    renderSteps();
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
function setGemMsg(text, isErr = false) { els.gemMsg.textContent = text; els.gemMsg.className = "msg" + (isErr ? " err" : ""); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
