// Draws a QR code as SVG. The generator library loads only when a code is shown.
import { loadScript } from './ui.js';

const QR_LIBRARY = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';

export async function qrSvg(text, label = 'QR code') {
  await loadScript(QR_LIBRARY);
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();

  const n = qr.getModuleCount();
  let path = '';
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
    }
  }
  // 2-module white margin so phones can find the code.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges" role="img" aria-label="${label}">`
    + `<rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#FFFFFF"/>`
    + `<path fill="#0C2340" d="${path}"/></svg>`;
}
