// Fotoğraf üzerine ok, daire ve kısa yazı işaretleri.
// Koordinatlar 0–1 aralığında (görselin genişliğine/yüksekliğine göre) saklanır.

export const ANN_COLOR = "#ff4d2e";

/** @param {CanvasRenderingContext2D} g @param {{type:"arrow"|"circle", x1:number,y1:number,x2:number,y2:number,label?:string}[]} anns */
export function drawAnnotations(g, w, h, anns, color = ANN_COLOR) {
  if (!anns?.length) return;
  const lw = Math.max(3, Math.round(Math.min(w, h) * 0.008));
  g.save();
  g.lineCap = "round";
  g.lineJoin = "round";
  for (const a of anns) {
    const x1 = a.x1 * w, y1 = a.y1 * h, x2 = a.x2 * w, y2 = a.y2 * h;
    const strokeBoth = (path) => {
      g.strokeStyle = "rgba(255,255,255,.95)"; g.lineWidth = lw * 2.4; path(); g.stroke();
      g.strokeStyle = color; g.lineWidth = lw; path(); g.stroke();
    };
    if (a.type === "circle") {
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      const rx = Math.max(lw * 3, Math.abs(x2 - x1) / 2), ry = Math.max(lw * 3, Math.abs(y2 - y1) / 2);
      strokeBoth(() => { g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); });
    } else {
      // Ok: başlangıçtan uca, uçta dolu ok başı
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const head = lw * 4.5;
      const bx = x2 - Math.cos(ang) * head * 0.8, by = y2 - Math.sin(ang) * head * 0.8;
      strokeBoth(() => { g.beginPath(); g.moveTo(x1, y1); g.lineTo(bx, by); });
      const tri = () => {
        g.beginPath();
        g.moveTo(x2, y2);
        g.lineTo(x2 - Math.cos(ang - 0.45) * head, y2 - Math.sin(ang - 0.45) * head);
        g.lineTo(x2 - Math.cos(ang + 0.45) * head, y2 - Math.sin(ang + 0.45) * head);
        g.closePath();
      };
      g.fillStyle = "rgba(255,255,255,.95)"; g.lineWidth = lw * 1.4; g.strokeStyle = "rgba(255,255,255,.95)"; tri(); g.stroke();
      g.fillStyle = color; tri(); g.fill();
    }
    if (a.label) {
      const fs = Math.max(14, Math.round(Math.min(w, h) * 0.045));
      g.font = `800 ${fs}px "Nunito Sans", system-ui, sans-serif`;
      const tw = g.measureText(a.label).width;
      const pad = fs * 0.45;
      // Yazı: okta başlangıcın yanında, dairede üstünde
      let tx = a.type === "circle" ? (x1 + x2) / 2 - tw / 2 : x1 - tw / 2;
      let ty = a.type === "circle" ? Math.min(y1, y2) - fs * 0.9 : y1 + (y1 < y2 ? -fs * 0.9 : fs * 0.9);
      tx = Math.min(Math.max(pad, tx), w - tw - pad);
      ty = Math.min(Math.max(pad + fs * 0.6, ty), h - pad);
      const bw = tw + pad * 2, bh = fs * 1.35;
      g.fillStyle = color;
      roundRect(g, tx - pad, ty - bh * 0.72, bw, bh, bh / 2);
      g.fill();
      g.fillStyle = "#fff";
      g.textBaseline = "alphabetic";
      g.fillText(a.label, tx, ty + fs * 0.08);
    }
  }
  g.restore();
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
