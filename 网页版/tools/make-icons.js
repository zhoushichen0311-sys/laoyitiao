// 从 app 图标 SVG 生成 PWA 需要的 PNG：192 / 512 / apple-touch-icon 180 / maskable 512
// 用法：node tools/make-icons.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ICON = (size, maskable) => {
  const inner = `<g transform="rotate(12 60 48)"><circle cx="67" cy="12" r="4.5" stroke="#fff" stroke-width="5" fill="none"/><path d="M67 17 V43 a16 16 0 0 1 -32 0 V30" stroke="#fff" stroke-width="9" fill="none" stroke-linecap="round"/><path d="M35 34 L41 39" stroke="#fff" stroke-width="4.5" fill="none" stroke-linecap="round"/><rect x="36" y="56" width="52" height="12" rx="6" fill="#C94A24"/></g><path d="M20 92 q10 -8 20 0 t20 0 t20 0 t20 0" stroke="#fff" stroke-width="6" fill="none" stroke-linecap="round" opacity="0.35"/><path d="M20 105 q10 -8 20 0 t20 0 t20 0 t20 0" stroke="#fff" stroke-width="6" fill="none" stroke-linecap="round" opacity="0.18"/>`;
  if (maskable) {
    // maskable：安全区是中间 80%，所以图形缩到 80%，背景铺满不留圆角
    return `<svg width="${size}" height="${size}" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg"><rect width="120" height="120" fill="#1C1A16"/><g transform="translate(12 12) scale(0.8)">${inner}</g></svg>`;
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg"><rect width="120" height="120" rx="28" fill="#1C1A16"/>${inner}</svg>`;
};

(async () => {
  const out = path.join(__dirname, '..', 'icons');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const jobs = [
    ['icon-192.png', 192, false, true],
    ['icon-512.png', 512, false, true],
    ['apple-touch-icon.png', 180, false, false],
    ['icon-maskable-512.png', 512, true, false],
  ];
  for (const [name, size, maskable, transparent] of jobs) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:${transparent ? 'transparent' : '#1C1A16'}">${ICON(size, maskable)}</body></html>`);
    await page.screenshot({ path: path.join(out, name), omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
    console.log('wrote', name);
  }
  fs.writeFileSync(path.join(out, 'icon.svg'), ICON(512, false));
  await browser.close();
})();
