// Transkript okuma: YouTube "transkripti göster" kopyası, "0:12 metin" satırları, SRT ve VTT.
import { parseTime } from "./processing.js?v=20261018e";

const TS_ONLY = /^\s*\d{1,2}(?::\d{2}){1,2}\s*$/;
const TS_LEAD = /^\s*(\d{1,2}(?::\d{2}){1,2})\s+(.+)$/;
const CUE = /^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/;

const clean = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

/** @returns {{start:number, end:number, text:string}[]} */
export function parseTranscript(text) {
  const lines = String(text).replace(/\r/g, "").split("\n");
  let segs = [];

  if (lines.some((l) => CUE.test(l))) {
    // SRT / VTT
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(CUE);
      if (!m) continue;
      const txt = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "") txt.push(lines[i++]);
      segs.push({ start: parseTime(m[1]), end: parseTime(m[2]), text: clean(txt.join(" ")) });
    }
  } else {
    let cur = null;
    for (const raw of lines) {
      const s = raw.trim();
      if (!s) continue;
      if (TS_ONLY.test(s)) { cur = { start: parseTime(s), text: "" }; segs.push(cur); continue; }
      const m = s.match(TS_LEAD);
      if (m) { cur = { start: parseTime(m[1]), text: m[2] }; segs.push(cur); continue; }
      if (cur) cur.text += (cur.text ? " " : "") + s;
    }
    segs.forEach((g) => (g.text = clean(g.text)));
  }

  segs = segs.filter((g) => g.text && !Number.isNaN(g.start)).sort((a, b) => a.start - b.start);
  // Otomatik altyazılarda art arda tekrar eden satırları birleştir
  segs = segs.filter((g, i) => i === 0 || g.text !== segs[i - 1].text);
  segs.forEach((g, i) => {
    if (!(g.end > g.start)) g.end = segs[i + 1] ? segs[i + 1].start : g.start + 5;
  });
  return segs;
}

const NOISE = /abone|kanal[ıi]m|hoş ?geldin|hoşça ?kal|beğenmeyi|yorumlarda|paylaşmayı|web ?site|www\.|https?:|görüşene|faydalı bir video|anlatacaklarım bunlardan|subscribe/i;
const STEP = /sıra|zincir|kroşe|dikiş|ilme[kğ]|ilmi[kğ]|büz|boğum|elyaf|halka|yaprak|\bsap|birleştir|katla|ipi kes|renge geç|çevir|\btur|örg|şiş|bağla|arttır|artır|azalt|ilmek|kapat|doldur/i;

// Sonucun göründüğü anlar: fotoğraf için varsayılan olarak bunlar seçilir
const RESULT = /yaptım|yaptık|oluştu|katlayalım|birleştirelim|keselim|büzme|dolduralım|çıkartalım|boğum|renge geç|gizleyelim|dikebilir|yapıştırabilir/i;

/** Bu satır için varsayılan olarak fotoğraf çıkarılsın mı? */
export function wantsPhoto(text) {
  return classify(text) === "step" && RESULT.test(text);
}

/** "step" = yapılış adımı, "info" = bilgi/malzeme, "noise" = selamlama, abone çağrısı vb. */
export function classify(text) {
  if (NOISE.test(text)) return "noise";
  if (STEP.test(text)) return "step";
  return "info";
}
