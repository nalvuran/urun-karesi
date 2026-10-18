// Transkripti Claude API ile satışa hazır İngilizce (US terimli) tarife çevirir.
import { parseTime, formatTime } from "./processing.js?v=20261018b";

export const MODELS = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (önerilen, hızlı ve ekonomik)" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (daha dikkatli, yaklaşık 2 kat fiyat)" },
];

const SYSTEM = `You are an expert crochet and knitting technical editor. You turn a timestamped, spoken Turkish video transcript, in which a maker demonstrates a project, into a professional, sellable English PDF pattern using US terminology.

FAITHFULNESS (most important)
- Every number (chain counts, stitch counts, row/round counts, sizes, hook/needle size, yarn details) must come from the transcript. Never invent or "fix" counts.
- If something a buyer needs is missing, unclear or contradictory, write your best reading AND put a marker in that text: [CHECK: short reason]. Do not hide uncertainty.
- Do not add techniques, materials or steps that the maker did not describe. You may add brief standard clarifications (e.g. "turn") when clearly implied.

TERMINOLOGY (Turkish → US)
zincir = chain (ch); kayma dikişi = slip stitch (sl st); tek kroşe = single crochet (sc); yarım ikili kroşe / yarım çubuk = half double crochet (hdc); ikili kroşe / çubuk = double crochet (dc); sihirli halka = magic ring (MR); arttırma = increase (inc, 2 sc in same st); azaltma = decrease (dec); arka ilmek / ilmeğin arkası = back loop only (BLO) — judge from context; ön ilmek = front loop only (FLO); sıra = row; tur = round (Rnd); deseni çevirmek = turn; elyaf = fiberfill stuffing; tığ = crochet hook; iğne = tapestry needle; büzmek = cinch / gather closed. Knitting: şiş = needles; düz = knit (k); ters = purl (p); ilmek = stitch (st); ilmek almak = cast on (CO); ilmek kapatmak = bind off (BO).
Use US conventions throughout (e.g. "sc" not "dc" for UK double crochet). Only list abbreviations that are actually used.

STYLE
- Standard pattern style: "Row 1: Starting in 3rd ch from hook, hdc in each ch across. (24 hdc)". Put the stitch count in parentheses at the end of rows/rounds.
- Collapse repeats: "Rows 3–36: Repeat Row 2." Use "S (M, L)" notation when the maker gives several sizes, and also put all sizes in the finished_sizes table.
- Organise steps into logical sections (e.g. "Pumpkin Body", "Assembly", "Stem", "Leaves", "Finishing").
- Include the maker's useful tips as notes (e.g. "chain count and row count must both be even").
- Remove greetings, subscribe requests and channel/website promotion.

PHOTOS
- Set photo=true where a photo genuinely helps a buyer: the result of a stage (finished panel, joined piece, stuffed body, finished stem) and key technique moments. Roughly one photo every 2–4 steps, at most about 25.
- photo_time: a moment where the RESULT of that step is visible in the video — usually 1–2 seconds before the next instruction in the transcript starts. Format m:ss. It must lie inside the video.
- source_time: the transcript timestamp where this step is explained. Format m:ss.

ETSY LISTING
- listing_title: up to 140 characters, natural and keyword-rich (e.g. "Crochet Pumpkin Pattern, 3 Sizes, Easy Fall Decor PDF ...").
- description: friendly; what the buyer gets, skill level, finished sizes, materials, US terms, and a clear line that this is a digital PDF pattern, not a finished item.
- tags: exactly 13 tags, each at most 20 characters.`;

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Pattern title, e.g. 'Crochet Pumpkins in 3 Sizes'" },
    subtitle: { type: "string", description: "Short tagline for the cover" },
    description: { type: "string", description: "2–4 sentence introduction for the first page" },
    skill_level: { type: "string", enum: ["Beginner", "Easy", "Intermediate", "Experienced"] },
    materials: { type: "array", items: { type: "string" }, description: "Yarn and other materials" },
    tools: { type: "array", items: { type: "string" }, description: "Hook/needles, tapestry needle, scissors, etc." },
    finished_sizes: {
      type: "object",
      properties: {
        headers: { type: "array", items: { type: "string" } },
        rows: { type: "array", items: { type: "array", items: { type: "string" } } },
      },
      required: ["headers", "rows"],
    },
    abbreviations: {
      type: "array",
      items: { type: "object", properties: { abbr: { type: "string" }, meaning: { type: "string" } }, required: ["abbr", "meaning"] },
    },
    notes: { type: "array", items: { type: "string" } },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                source_time: { type: "string" },
                photo: { type: "boolean" },
                photo_time: { type: "string" },
              },
              required: ["text", "source_time", "photo"],
            },
          },
        },
        required: ["heading", "steps"],
      },
    },
    etsy: {
      type: "object",
      properties: {
        listing_title: { type: "string" },
        description: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["listing_title", "description", "tags"],
    },
  },
  required: ["title", "description", "skill_level", "materials", "tools", "abbreviations", "notes", "sections", "etsy"],
};

export function buildRequest({ model, transcript, videoName, duration }) {
  const header = [
    videoName ? `Video file: ${videoName}` : "",
    duration ? `Video length: ${formatTime(Math.floor(duration))}` : "",
  ].filter(Boolean).join("\n");
  return {
    model,
    max_tokens: 16000,
    system: SYSTEM,
    tools: [{ name: "write_pattern", description: "Return the finished pattern.", input_schema: SCHEMA }],
    tool_choice: { type: "tool", name: "write_pattern" },
    messages: [{
      role: "user",
      content: `${header}\n\nTranscript (Turkish, timestamped):\n\n${transcript.trim()}`,
    }],
  };
}

export async function writePattern({ apiKey, model, transcript, videoName, duration, signal }) {
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(buildRequest({ model, transcript, videoName, duration })),
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new Error("Claude API'ye bağlanılamadı. İnternet bağlantınızı kontrol edin.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    if (res.status === 401) throw new Error("API anahtarı geçersiz. Ayarlardan kontrol edin.");
    if (res.status === 429) throw new Error("Çok fazla istek ya da kredi limiti doldu. Biraz bekleyip tekrar deneyin.");
    if (/credit|balance|billing/i.test(msg)) throw new Error("API hesabında yeterli kredi yok. Claude Console'dan kredi yükleyin.");
    throw new Error(`Claude API hatası: ${msg}`);
  }
  return parseResponse(data);
}

export function parseResponse(data) {
  const block = (data.content || []).find((b) => b.type === "tool_use" && b.name === "write_pattern");
  if (!block) throw new Error("Yapay zekâdan beklenen biçimde yanıt gelmedi. Tekrar deneyin.");
  if (data.stop_reason === "max_tokens") throw new Error("Tarif çok uzun olduğu için yanıt yarıda kesildi. Transkripti ikiye bölüp deneyin.");
  return normalize(block.input);
}

/** Eksik alanları tamamla, tipleri düzelt. */
export function normalize(p) {
  const arr = (x) => (Array.isArray(x) ? x.filter((v) => v != null && String(v).trim()) : []);
  return {
    title: String(p.title || "").trim(),
    subtitle: String(p.subtitle || "").trim(),
    description: String(p.description || "").trim(),
    skill_level: String(p.skill_level || "").trim(),
    materials: arr(p.materials).map(String),
    tools: arr(p.tools).map(String),
    finished_sizes: {
      headers: arr(p.finished_sizes?.headers).map(String),
      rows: (p.finished_sizes?.rows || []).filter(Array.isArray).map((r) => r.map((c) => String(c ?? ""))),
    },
    abbreviations: (p.abbreviations || []).filter((a) => a && a.abbr).map((a) => ({ abbr: String(a.abbr), meaning: String(a.meaning || "") })),
    notes: arr(p.notes).map(String),
    sections: (p.sections || []).filter((s) => s && Array.isArray(s.steps)).map((s) => ({
      heading: String(s.heading || "").trim(),
      steps: s.steps.filter((st) => st && st.text).map((st) => ({
        text: String(st.text).trim(),
        source_time: String(st.source_time || ""),
        photo: !!st.photo,
        photo_time: st.photo_time ? String(st.photo_time) : "",
      })),
    })),
    etsy: {
      listing_title: String(p.etsy?.listing_title || "").slice(0, 140),
      description: String(p.etsy?.description || ""),
      tags: arr(p.etsy?.tags).map((t) => String(t).slice(0, 20)).slice(0, 13),
    },
  };
}

/** Tarifin adımlarını uygulamanın adım nesnelerine çevirir. */
export function patternToSteps(pattern, duration, makeId) {
  const flat = [];
  for (const sec of pattern.sections) {
    for (const st of sec.steps) flat.push({ sec: sec.heading, st });
  }
  const clamp = (t) => (duration ? Math.min(Math.max(0, t), Math.max(0, duration - 0.1)) : Math.max(0, t));
  const steps = flat.map(({ sec, st }) => {
    const start = parseTime(st.source_time);
    const pt = parseTime(st.photo_time);
    return {
      id: makeId(), section: sec, text: st.text, kind: "step",
      start: Number.isNaN(start) ? 0 : clamp(start), end: 0,
      include: true, photo: st.photo,
      customT: Number.isNaN(pt) ? null : clamp(pt),
      img: null, status: "",
    };
  });
  steps.forEach((s, i) => {
    const next = steps.slice(i + 1).find((n) => n.start > s.start);
    s.end = next ? next.start : s.start + 5;
  });
  return steps;
}

// ---- Tarif bilgisi alanları ↔ düz metin (düzenleme kutuları için) ----
export const linesToList = (t) => String(t).split("\n").map((l) => l.trim()).filter(Boolean);
export const sizesToText = (fs) => (fs?.headers?.length ? [fs.headers, ...fs.rows].map((r) => r.join(" | ")).join("\n") : "");
export function textToSizes(t) {
  const rows = linesToList(t).map((l) => l.split("|").map((c) => c.trim()));
  return rows.length ? { headers: rows[0], rows: rows.slice(1) } : { headers: [], rows: [] };
}
export const abbrToText = (list) => list.map((a) => `${a.abbr} = ${a.meaning}`).join("\n");
export const textToAbbr = (t) => linesToList(t).map((l) => {
  const i = l.search(/\s*[=:–-]\s*/);
  return i > 0 ? { abbr: l.slice(0, i).trim(), meaning: l.slice(i).replace(/^\s*[=:–-]\s*/, "").trim() } : { abbr: l, meaning: "" };
});

// ---- API'siz yol: claude.ai sohbetine yapıştırılacak komut ve gelen yanıtın okunması ----
const TEMPLATE = {
  title: "Crochet Pumpkins in 3 Sizes",
  subtitle: "Short cover tagline",
  description: "2–4 sentence introduction",
  skill_level: "Beginner | Easy | Intermediate | Experienced",
  materials: ["..."],
  tools: ["..."],
  finished_sizes: { headers: ["Size", "..."], rows: [["S", "..."]] },
  abbreviations: [{ abbr: "ch", meaning: "chain" }],
  notes: ["..."],
  sections: [{
    heading: "Pumpkin Body",
    steps: [{ text: "Row 1: ... (24 hdc)", source_time: "1:38", photo: true, photo_time: "2:00" }],
  }],
  etsy: { listing_title: "...", description: "...", tags: ["13 tags, max 20 chars each"] },
};

export function buildChatPrompt({ transcript, videoName, duration }) {
  const header = [
    videoName ? `Video file: ${videoName}` : "",
    duration ? `Video length: ${formatTime(Math.floor(duration))}` : "",
  ].filter(Boolean).join("\n");
  return `${SYSTEM}

OUTPUT FORMAT
Reply with ONE JSON object only, inside a single \`\`\`json code block, with no other text before or after it. Do not create an artifact or file. Use exactly these keys (photo_time only when photo is true):
${JSON.stringify(TEMPLATE, null, 2)}

${header}

Transcript (Turkish, timestamped):

${transcript.trim()}`;
}

/** claude.ai'den kopyalanan yanıttan JSON'u çıkarır (kod bloğu, önünde/arkasında metin olsa bile). */
export function parseChatReply(text) {
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1];
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b <= a) throw new Error("Yanıt yarıda kesilmiş görünüyor. Claude'a \"devam et\" yazın, sonra yanıtın tamamını kopyalayın.");
  if (a < 0) throw new Error("Yapıştırılan metinde tarif bulunamadı. Claude'un yanıtındaki kod bloğunu baştan sona kopyalayın.");
  s = s.slice(a, b + 1);
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    try {
      // Yaygın küçük hatalar: sondaki virgüller, akıllı tırnaklar
      obj = JSON.parse(s.replace(/,\s*([}\]])/g, "$1").replace(/[“”]/g, '"'));
    } catch {
      throw new Error("Yanıt eksik ya da bozuk görünüyor. Yanıt yarıda kesildiyse Claude'a \"devam et\" yazın ve tamamını kopyalayın.");
    }
  }
  if (!obj || !Array.isArray(obj.sections)) throw new Error("Yanıtta adımlar (sections) yok. Komutu yeniden deneyin.");
  return normalize(obj);
}
