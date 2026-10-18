// Görüntü işleme yardımcıları — tarayıcı API'si kullanmaz, Node'da da test edilebilir.
// Tüm maskeler: Uint8Array (0/1), uzunluk w*h.

/** Kare yapı elemanıyla genişletme (dilation). O(n), r'den bağımsız. */
export function dilate(src, w, h, r) {
  r = Math.round(r);
  if (r <= 0) return src.slice();
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) count += src[row + x];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = count > 0 ? 1 : 0;
      const add = x + r + 1, rem = x - r;
      if (add < w) count += src[row + add];
      if (rem >= 0) count -= src[row + rem];
    }
  }
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) count += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = count > 0 ? 1 : 0;
      const add = y + r + 1, rem = y - r;
      if (add < h) count += tmp[add * w + x];
      if (rem >= 0) count -= tmp[rem * w + x];
    }
  }
  return out;
}

/** Aşındırma (erosion). */
export function erode(src, w, h, r) {
  const inv = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) inv[i] = src[i] ? 0 : 1;
  const d = dilate(inv, w, h, r);
  for (let i = 0; i < d.length; i++) d[i] = d[i] ? 0 : 1;
  return d;
}

/** Kapama: önce genişlet sonra aşındır — boşlukları/girintileri kapatır. */
export function close(src, w, h, r) {
  return erode(dilate(src, w, h, r), w, h, r);
}

/** En büyük parçanın `minFrac` katından küçük bağlı parçaları siler (4-komşuluk). */
export function removeSmallParts(mask, w, h, minFrac) {
  const n = w * h;
  const labels = new Int32Array(n);
  const sizes = [0];
  const stack = new Int32Array(n);
  let next = 1;
  for (let i = 0; i < n; i++) {
    if (!mask[i] || labels[i]) continue;
    let sp = 0, size = 0;
    stack[sp++] = i;
    labels[i] = next;
    while (sp) {
      const p = stack[--sp];
      size++;
      const x = p % w;
      if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = next; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = next; stack[sp++] = p + 1; }
      if (p >= w && mask[p - w] && !labels[p - w]) { labels[p - w] = next; stack[sp++] = p - w; }
      if (p < n - w && mask[p + w] && !labels[p + w]) { labels[p + w] = next; stack[sp++] = p + w; }
    }
    sizes.push(size);
    next++;
  }
  const largest = Math.max(0, ...sizes);
  const out = new Uint8Array(n);
  const min = largest * minFrac;
  for (let i = 0; i < n; i++) if (labels[i] && sizes[labels[i]] >= min) out[i] = 1;
  return out;
}

/**
 * Basit "soğan kabuğu" boşluk doldurma: delik kenardan içeri doğru katman katman,
 * yakındaki bilinen piksellerin ağırlıklı ortalamasıyla doldurulur.
 * rgba yerinde değiştirilir. Ulaşılamayan delik pikselleri beyaz yapılır.
 */
export function inpaint(rgba, w, h, hole, known, radius = 4) {
  const n = w * h;
  const K = new Uint8Array(n);
  for (let i = 0; i < n; i++) K[i] = known[i] && !hole[i] ? 1 : 0;
  const queued = new Uint8Array(n);
  let layer = [];
  const touchesKnown = (p) => {
    const x = p % w;
    return (x > 0 && K[p - 1]) || (x < w - 1 && K[p + 1]) || (p >= w && K[p - w]) || (p < n - w && K[p + w]);
  };
  for (let i = 0; i < n; i++) if (hole[i] && touchesKnown(i)) { layer.push(i); queued[i] = 1; }

  const R = radius;
  const vals = new Float32Array(4);
  while (layer.length) {
    const colors = new Float32Array(layer.length * 3);
    const ok = new Uint8Array(layer.length);
    for (let k = 0; k < layer.length; k++) {
      const p = layer[k];
      const px = p % w, py = (p - px) / w;
      vals[0] = vals[1] = vals[2] = vals[3] = 0;
      for (let dy = -R; dy <= R; dy++) {
        const y = py + dy;
        if (y < 0 || y >= h) continue;
        for (let dx = -R; dx <= R; dx++) {
          const x = px + dx;
          if (x < 0 || x >= w) continue;
          const q = y * w + x;
          if (!K[q]) continue;
          const d2 = dx * dx + dy * dy;
          if (d2 === 0 || d2 > R * R) continue;
          const wt = 1 / d2;
          vals[0] += rgba[q * 4] * wt;
          vals[1] += rgba[q * 4 + 1] * wt;
          vals[2] += rgba[q * 4 + 2] * wt;
          vals[3] += wt;
        }
      }
      if (vals[3] > 0) {
        colors[k * 3] = vals[0] / vals[3];
        colors[k * 3 + 1] = vals[1] / vals[3];
        colors[k * 3 + 2] = vals[2] / vals[3];
        ok[k] = 1;
      }
    }
    const nextLayer = [];
    for (let k = 0; k < layer.length; k++) {
      const p = layer[k];
      if (!ok[k]) continue;
      rgba[p * 4] = colors[k * 3];
      rgba[p * 4 + 1] = colors[k * 3 + 1];
      rgba[p * 4 + 2] = colors[k * 3 + 2];
      K[p] = 1;
    }
    for (let k = 0; k < layer.length; k++) {
      const p = layer[k];
      const x = p % w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < n - w ? p + w : -1];
      for (const q of nb) {
        if (q >= 0 && hole[q] && !K[q] && !queued[q]) { queued[q] = 1; nextLayer.push(q); }
      }
    }
    layer = nextLayer;
  }
  for (let i = 0; i < n; i++) {
    if (hole[i] && !K[i]) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 255; }
  }
}

/**
 * Tüm adımları birleştirir.
 * @returns {{ data: Uint8ClampedArray, cropW, cropH, remove: Uint8Array, alpha: Float32Array, empty: boolean }}
 */
export function compose(o) {
  const { w, h, rgba, fg, hand, erase, keep } = o;
  const n = w * h;
  const handD = dilate(hand, w, h, o.expand);
  const remove = new Uint8Array(n);
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    remove[i] = (handD[i] || erase[i]) && !keep[i] ? 1 : 0;
    alpha[i] = keep[i] ? 1 : remove[i] ? 0 : fg[i];
  }
  let prod = new Uint8Array(n);
  for (let i = 0; i < n; i++) prod[i] = alpha[i] > 0.5 ? 1 : 0;

  if (o.minPart > 0) {
    const cleaned = removeSmallParts(prod, w, h, o.minPart);
    for (let i = 0; i < n; i++) if (prod[i] && !cleaned[i] && !keep[i]) alpha[i] = 0;
    prod = cleaned;
    for (let i = 0; i < n; i++) if (keep[i]) prod[i] = 1;
  }

  const img = new Uint8ClampedArray(rgba);
  let filledPx = 0;
  if (o.fill && o.fillReach > 0) {
    const closed = close(prod, w, h, o.fillReach);
    const region = new Uint8Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      if (closed[i] && remove[i] && !prod[i]) { region[i] = 1; any = true; filledPx++; }
    }
    if (any) {
      inpaint(img, w, h, region, prod, 4);
      for (let i = 0; i < n; i++) if (region[i]) { alpha[i] = 1; prod[i] = 1; }
    }
  }

  // Ürünün kapladığı alan + kenar boşluğu
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] > 0.05) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { empty: true, remove, alpha, filledPx: 0, productPx: 0, suspicious: true };
  let productPx = 0;
  for (let i = 0; i < n; i++) if (prod[i]) productPx++;
  // Şüpheli: doldurulan (tahmin edilen) alan ürünün %18'inden fazla ya da ürün çok küçük
  const suspicious = filledPx / Math.max(1, productPx) > 0.18 || productPx < n * 0.01;
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.08);
  const cropW = x1 - x0 + 1 + pad * 2, cropH = y1 - y0 + 1 + pad * 2;
  const out = new Uint8ClampedArray(cropW * cropH * 4);
  for (let i = 0; i < cropW * cropH; i++) {
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255;
    out[i * 4 + 3] = o.transparent ? 0 : 255;
  }
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const si = y * w + x;
      const a = alpha[si];
      if (a <= 0) continue;
      const di = ((y - y0 + pad) * cropW + (x - x0 + pad)) * 4;
      if (o.transparent) {
        out[di] = img[si * 4]; out[di + 1] = img[si * 4 + 1]; out[di + 2] = img[si * 4 + 2];
        out[di + 3] = Math.round(a * 255);
      } else {
        out[di] = img[si * 4] * a + 255 * (1 - a);
        out[di + 1] = img[si * 4 + 1] * a + 255 * (1 - a);
        out[di + 2] = img[si * 4 + 2] * a + 255 * (1 - a);
      }
    }
  }
  return { data: out, cropW, cropH, remove, alpha, empty: false, filledPx, productPx, suspicious };
}

/** "03:15", "3:15", "1:02:03", "195", "03:15,5" → saniye (geçersizse NaN). */
export function parseTime(str) {
  const s = String(str).trim().replace(",", ".");
  if (!s) return NaN;
  if (!/^\d+(\.\d+)?(:\d{1,2}(\.\d+)?){0,2}$/.test(s)) return NaN;
  const parts = s.split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function formatTime(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = (Number.isInteger(s) ? String(s) : s.toFixed(1)).padStart(Number.isInteger(s) ? 2 : 4, "0");
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m).padStart(2, "0")) + ":" + ss;
}
