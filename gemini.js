// Gemini'ye verilecek görsel düzenleme komutları ve dosya adı yardımcıları.

export const HAND_OPTIONS = [
  { id: "young_polish", label: "Değiştir: genç, bakımlı kadın eli, açık renk ojeli" },
  { id: "replace", label: "Değiştir: genç, bakımlı kadın eli, ojesiz" },
  { id: "keep", label: "Olduğu gibi bırak (sadece ışık ve fon)" },
  { id: "remove", label: "Kaldır (sadece sonuç fotoğraflarında)" },
];

const YOUNG =
  "IMPORTANT: clearly REPLACE the hands with the hands of a DIFFERENT, YOUNGER woman (mid-20s). The new hands must look visibly " +
  "different from the original: smooth, youthful, even-toned skin with no visible wrinkles, veins or spots; slim, elegant, " +
  "slightly longer fingers; soft and graceful. Do not just retouch the original hands — the result must not look like the same person. " +
  "No rings or jewelry.";
const HANDS_REPLACE = `${YOUNG} Nails: neatly shaped, clean, medium length, NO nail polish. Keep the same hand pose and grip.`;
const HANDS_POLISH = `${YOUNG} Nails: neatly shaped, medium length, with a glossy soft nude-pink nail polish. Keep the same hand pose and grip.`;
const handsText = (h) => (h === "young_polish" ? HANDS_POLISH : HANDS_REPLACE);
const HANDS_KEEP = "Keep the hands exactly as they are; you may only improve the lighting on them slightly.";
const HANDS_REMOVE =
  "Remove the hands completely and show the item resting on its own, naturally supported, as if photographed on a table.";

const KEEP_ITEM =
  "Do NOT change the crochet/knit item in any way: keep its exact shape, proportions, colors, yarn texture, stitch pattern, " +
  "number of rows, ribs or segments, and every part (stems, leaves, details). Do not add, remove or rearrange parts. " +
  "Do not invent stitches.";

const SHARPEN =
  "Make the existing stitches crisper and more clearly defined and bring out the yarn texture (clarity and sharpening only). " +
  "Do NOT redraw, add or remove any stitches.";
const descLine = (d) => (d ? `\nWhat the photo shows: ${d}\nIf this description conflicts with the photo in any way, follow the photo.` : "");

const QUALITY = "Photorealistic, sharp focus on the item, high resolution, same framing and aspect ratio as the original photo.";

/** @param {{type:"result"|"technique", text:string, hands:string, title?:string, desc?:string}} o */
export function buildGeminiPrompt(o) {
  const ctx = o.title ? `This photo is from a pattern for "${o.title}".` : "This photo is from a crochet/knitting pattern.";
  const step = o.text ? ` It illustrates this step: "${o.text.replace(/\s*\[CHECK:[^\]]*\]/gi, "").trim()}"` : "";
  if (o.type === "technique") {
    const hands = o.hands === "keep" || o.hands === "remove" ? HANDS_KEEP : handsText(o.hands);
    return [
      `Edit this photo. ${ctx}${step}${descLine(o.desc)}`,
      "",
      "It is a TECHNIQUE photo: it teaches the buyer how the hands, yarn and hook move, so the technique must stay 100% accurate.",
      `- ${hands}`,
      "- While the hands themselves change, keep the same finger positions, the same path of the yarn over and between the fingers, " +
        "the same hook position and angle, and the exact place where the hook enters the stitch.",
      `- ${KEEP_ITEM}`,
      `- ${SHARPEN}`,
      "- Simplify and soften the background (plain, light, uncluttered) and make the lighting soft, bright and even.",
      `- ${QUALITY}`,
    ].join("\n");
  }
  const hands = o.hands === "keep" ? HANDS_KEEP : o.hands === "remove" ? HANDS_REMOVE : handsText(o.hands);
  return [
    `Edit this photo. ${ctx}${step}${descLine(o.desc)}`,
    "",
    "It is a RESULT photo that shows how the work looks at this stage.",
    "- Remove clutter (yarn balls, scissors, other objects) and place the item on a clean, seamless, light off-white background " +
      "with soft, even studio light and a gentle natural shadow.",
    `- ${hands}`,
    `- ${KEEP_ITEM}`,
    `- ${SHARPEN}`,
    `- ${QUALITY}`,
  ].join("\n");
}

export function buildCoverPrompt({ title }) {
  return [
    `Edit this photo into the cover image for a crochet/knitting pattern${title ? ` called "${title}"` : ""}.`,
    "",
    "- Remove the hands completely and all clutter (yarn balls, tools, other objects).",
    "- Show the finished item(s) on a clean, seamless, light off-white background with soft, warm, even studio light and gentle natural shadows.",
    "- Keep the items' arrangement close to the original; make the composition balanced and attractive for an Etsy listing.",
    "- Do NOT add any text, titles, letters, logos or watermarks to the image.",
    `- ${KEEP_ITEM}`,
    `- ${SHARPEN}`,
    "- Photorealistic, sharp, high resolution, landscape 4:3 framing with generous space around the items (the image will be cropped slightly on a cover).",
  ].join("\n");
}

/** Adım numarası → dosya adı (adim-05.jpg) */
export const fileNameFor = (no) => (no === 0 ? "kapak" : `adim-${String(no).padStart(2, "0")}`);

/** Dosya adından numara: "adim-05.png" → 5, "kapak.jpg" → 0, numarasızsa null */
export function numberFromFileName(name) {
  const base = String(name).toLowerCase().replace(/\.[a-z0-9]+$/, "");
  if (/kapak|cover/.test(base)) return 0;
  const m = base.match(/(?:adim|adım|step)[\s_-]*0*(\d{1,3})/) || base.match(/^0*(\d{1,3})$/);
  return m ? +m[1] : null;
}

// ---- Gemini API ile otomatik düzenleme ----
export const GEMINI_MODELS = [
  { id: "gemini-nano-banana-2.1", label: "Nano Banana 2.1 (önerilen)" },
  { id: "gemini-3-pro-image", label: "Nano Banana Pro (en kaliteli, daha pahalı)" },
  { id: "gemini-3.1-flash-image", label: "Nano Banana 2" },
  { id: "gemini-3.1-flash-lite-image", label: "Nano Banana 2 Lite (en ucuz)" },
];

const RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
/** Görselin en/boy oranına en yakın desteklenen oran */
export function nearestAspect(w, h) {
  const r = w / h;
  let best = "4:3", bd = Infinity;
  for (const s of RATIOS) {
    const [a, b] = s.split(":").map(Number);
    const d = Math.abs(Math.log(r / (a / b)));
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

/** Yanıtın içinde nerede olursa olsun ilk görsel verisini bulur (API sürümleri arasında yapı farklı olabilir). */
export function findImage(node) {
  if (!node || typeof node !== "object") return null;
  const mime = node.mime_type || node.mimeType;
  if (typeof node.data === "string" && node.data.length > 100 && (!mime || /^image\//.test(mime))) {
    return { data: node.data, mime: mime || "image/png" };
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === "object") { const f = findImage(v); if (f) return f; }
  }
  return null;
}
export function findText(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (typeof node.text === "string") out.push(node.text);
  for (const v of Object.values(node)) if (v && typeof v === "object") findText(v, out);
  return out;
}

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function apiError(status, data) {
  const msg = data?.error?.message || data?.message || `HTTP ${status}`;
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(msg)) return new Error("Gemini API anahtarı geçersiz.");
  if (status === 403) return new Error(/billing|free tier|not available/i.test(msg)
    ? "Bu model için projede faturalandırma açık olmalı (AI Studio → API Keys → Billing)."
    : `Gemini erişimi reddedildi: ${msg}`);
  if (status === 429) return new Error("Gemini kota/hız sınırına takıldı. Biraz bekleyip tekrar deneyin.");
  if (/billing|free tier/i.test(msg)) return new Error("Bu model için projede faturalandırma açık olmalı (AI Studio → API Keys → Billing).");
  const e = new Error(`Gemini hatası: ${msg}`);
  e.status = status;
  return e;
}

async function postJSON(url, apiKey, body, signal) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST", signal,
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new Error("Gemini'ye bağlanılamadı. İnternet bağlantınızı kontrol edin.");
  }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/**
 * Bir görseli komutla Gemini'ye düzenletir, düzenlenmiş görseli Blob olarak döndürür.
 * Önce generateContent, olmazsa Interactions uç noktası denenir.
 */
export async function editImageWithGemini({ apiKey, model, prompt, blob, aspect, signal }) {
  const data = await blobToBase64(blob);
  const mime = blob.type || "image/jpeg";
  const base = "https://generativelanguage.googleapis.com/v1beta";
  const attempts = [
    () => postJSON(`${base}/models/${model}:generateContent`, apiKey, {
      contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: mime, data } }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: aspect, imageSize: "2K" } },
    }, signal),
    () => postJSON(`${base}/models/${model}:generateContent`, apiKey, {
      contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: mime, data } }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    }, signal),
    () => postJSON(`${base}/interactions`, apiKey, {
      model,
      input: [{ type: "text", text: prompt }, { type: "image", mime_type: mime, data }],
      response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: aspect, image_size: "2K" },
    }, signal),
  ];
  let lastErr;
  for (const attempt of attempts) {
    const r = await attempt();
    if (r.ok) {
      const img = findImage(r.data);
      if (img) return base64ToBlob(img.data, img.mime);
      const said = findText(r.data).join(" ").trim();
      const reason = r.data?.candidates?.[0]?.finishReason || r.data?.promptFeedback?.blockReason;
      throw new Error(`Gemini görsel döndürmedi${reason ? ` (${reason})` : ""}${said ? `: "${said.slice(0, 160)}"` : ""}.`);
    }
    const err = apiError(r.status, r.data);
    // Anahtar/faturalandırma/kota hataları diğer yollarla da düzelmez
    if (!err.status || ![400, 404].includes(r.status)) throw err;
    lastErr = err;
  }
  throw lastErr;
}
