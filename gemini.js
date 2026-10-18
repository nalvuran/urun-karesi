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

const QUALITY = "Photorealistic, sharp focus on the item, high resolution, same framing and aspect ratio as the original photo.";

/** @param {{type:"result"|"technique", text:string, hands:string, title?:string}} o */
export function buildGeminiPrompt(o) {
  const ctx = o.title ? `This photo is from a pattern for "${o.title}".` : "This photo is from a crochet/knitting pattern.";
  const step = o.text ? ` It illustrates this step: "${o.text.replace(/\s*\[CHECK:[^\]]*\]/gi, "").trim()}"` : "";
  if (o.type === "technique") {
    const hands = o.hands === "keep" || o.hands === "remove" ? HANDS_KEEP : handsText(o.hands);
    return [
      `Edit this photo. ${ctx}${step}`,
      "",
      "It is a TECHNIQUE photo: it teaches the buyer how the hands, yarn and hook move, so the technique must stay 100% accurate.",
      `- ${hands}`,
      "- While the hands themselves change, keep the same finger positions, the same path of the yarn over and between the fingers, " +
        "the same hook position and angle, and the exact place where the hook enters the stitch.",
      `- ${KEEP_ITEM}`,
      "- Simplify and soften the background (plain, light, uncluttered) and make the lighting soft, bright and even.",
      `- ${QUALITY}`,
    ].join("\n");
  }
  const hands = o.hands === "keep" ? HANDS_KEEP : o.hands === "remove" ? HANDS_REMOVE : handsText(o.hands);
  return [
    `Edit this photo. ${ctx}${step}`,
    "",
    "It is a RESULT photo that shows how the work looks at this stage.",
    "- Remove clutter (yarn balls, scissors, other objects) and place the item on a clean, seamless, light off-white background " +
      "with soft, even studio light and a gentle natural shadow.",
    `- ${hands}`,
    `- ${KEEP_ITEM}`,
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
    `- ${KEEP_ITEM}`,
    "- Photorealistic, sharp, high resolution, landscape 4:3 framing with a little space around the items.",
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
