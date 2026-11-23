'use strict';
/* global Image, document -- the drawing runs in the browser (page.evaluate) */
// Builds src/assets/icon-*.bin.gz, the templates the app paints its icons from in each site's own colour (src/icons.js).
// Run again after changing public/favicon.svg:  node scripts/make-icon-templates.js   (needs Playwright's Chromium)
//
// The car icon is drawn twice, its brand-coloured parts once in black and once in white. Per pixel and channel,
// black = rest and white = rest + share × 255, so any colour is  rest + share × colour  (exact, edges included).
// Stored per pixel: the black drawing's RGBA, then the brand share (0-255). 512 × 512, gzipped.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { chromium } = require('playwright');

const SIZE = 512;
const svg = fs.readFileSync(path.join(__dirname, '..', 'public', 'favicon.svg'), 'utf8').replace(/<title>[\s\S]*?<\/title>/, '');
const BRAND = '#0b7a63';
const variants = {
  // "any": the icon as it is, rounded corners and all.
  any: (s) => s,
  // "maskable": Android cuts its own shape (circle, squircle) from the middle 80%: a full square background, the car smaller.
  maskable: (s) => s.replace(/<rect width="64" height="64" rx="15"/, '<rect width="64" height="64"')
    .replace(/(<rect width="64" height="64"[^>]*\/>)([\s\S]*)<\/svg>/, '$1<g transform="translate(32 32) scale(0.78) translate(-32 -33)">$2</g></svg>'),
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
  const draw = async (s) => {
    await page.setContent(`<html><body style="margin:0;background:transparent">${s.replace('<svg ', `<svg width="${SIZE}" height="${SIZE}" `)}</body></html>`);
    return page.evaluate(async (size) => {
      const img = new Image();
      img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(document.querySelector('svg').outerHTML)))}`;
      await img.decode();
      const c = document.createElement('canvas'); c.width = size; c.height = size;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, size, size);
      return Array.from(ctx.getImageData(0, 0, size, size).data);
    }, SIZE);
  };
  for (const [name, make] of Object.entries(variants)) {
    const s = make(svg);
    const black = await draw(s.replaceAll(BRAND, '#000000'));
    const white = await draw(s.replaceAll(BRAND, '#ffffff'));
    const out = Buffer.alloc(SIZE * SIZE * 5);
    for (let i = 0, o = 0; i < black.length; i += 4, o += 5) {
      out[o] = black[i]; out[o + 1] = black[i + 1]; out[o + 2] = black[i + 2]; out[o + 3] = black[i + 3];
      out[o + 4] = Math.max(0, Math.min(255, white[i + 1] - black[i + 1])); // the green channel: the same in all three
    }
    const file = path.join(__dirname, '..', 'src', 'assets', `icon-${name}.bin.gz`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, zlib.gzipSync(out, { level: 9 }));
    console.log(file, fs.statSync(file).size, 'bytes');
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
