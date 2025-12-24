/**
 * Generates a simple data: URL placeholder image (SVG).
 * You can replace this with your own artwork pipeline.
 */
export function makePlaceholderSvgDataUrl({ title = "External Player", subtitle = "", theme = "dark" } = {}) {
  const bg = theme === "dark" ? "#0f1218" : "#f2f4f8";
  const fg = theme === "dark" ? "#e6e9ef" : "#121521";
  const sub = theme === "dark" ? "#aab2c3" : "#4b5568";
  const safeTitle = escapeXml(title);
  const safeSub = escapeXml(subtitle);

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs>
    <linearGradient id="g" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="${bg}" stop-opacity="1"/>
      <stop offset="1" stop-color="${bg}" stop-opacity="1"/>
    </linearGradient>
  </defs>
  <rect width="1280" height="720" fill="url(#g)"/>
  <rect x="40" y="40" width="1200" height="640" rx="18" fill="none" stroke="${fg}" stroke-opacity="0.18"/>
  <g font-family="system-ui, -apple-system, Segoe UI, sans-serif">
    <text x="80" y="120" font-size="44" fill="${fg}" font-weight="700">${safeTitle}</text>
    <text x="80" y="168" font-size="24" fill="${sub}" font-weight="500">${safeSub}</text>
    <g transform="translate(80,230)">
      <rect x="0" y="0" width="560" height="360" rx="12" fill="${fg}" fill-opacity="0.06" stroke="${fg}" stroke-opacity="0.14"/>
      <polygon points="235,110 235,250 365,180" fill="${fg}" fill-opacity="0.55"/>
      <text x="0" y="410" font-size="20" fill="${sub}">Video is rendered outside the browser (e.g. VLC).</text>
      <text x="0" y="440" font-size="20" fill="${sub}">This pane is a placeholder supplied by the adapter.</text>
    </g>
  </g>
</svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

function escapeXml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
