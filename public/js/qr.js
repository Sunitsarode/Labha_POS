// QR codes as crisp SVG (black on white, also in dark mode, so phones can scan it).
import qrcode from './vendor/qrcode.mjs';

export function qrSvg(text, { size = 168, margin = 2, label = 'QR code' } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const total = n + margin * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
  }
  const safeLabel = String(label).replace(/[<>&"]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="${safeLabel}"><rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
