import * as esbuild from 'esbuild';
import fs from 'fs';
import { execSync } from 'child_process';
const CDN = 'https://cdn.jsdelivr.net/npm/';
const LIB = {
  pdf: 'node_modules/pdfjs-dist/build/pdf.min.js', pdfworker: 'node_modules/pdfjs-dist/build/pdf.worker.min.js',
  mammoth: 'node_modules/mammoth/mammoth.browser.min.js', jszip: 'node_modules/jszip/dist/jszip.min.js',
};
const VERSION = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
const js = (await esbuild.build({ entryPoints: ['src/app.js'], bundle: true, format: 'iife', target: 'es2020', minify: true, write: false })).outputFiles[0].text;
const css = fs.readFileSync('src/style.css', 'utf8');
const safe = t => t.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\x21--');

function page({ mode, libs = null, inline = false, pwa = false }) {
  const inlineLibs = inline ? Object.entries(LIB).map(([k, f]) => `<script type="text/plain" id="lib-${k}">${safe(fs.readFileSync(f, 'utf8'))}</script>`).join('\n') : '';
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#E6EAEE">
<title>เตรียมสอบ</title>
${pwa ? `<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icon-192.png">
<link rel="icon" href="icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="เตรียมสอบ">
<meta name="apple-mobile-web-app-status-bar-style" content="default">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;500;600&family=IBM+Plex+Sans+Thai+Looped:wght@400;500&display=swap" rel="stylesheet">
<style>${css}</style>
${mode !== 'artifact' ? '<!--PREP_DATA-->' : ''}
</head>
<body>
<div id="app"></div>
${inlineLibs}
<script>window.PREP_MODE = ${JSON.stringify(mode)}; window.PREP_VERSION = ${JSON.stringify(VERSION)};${libs ? ` window.PREP_LIBS = ${JSON.stringify(libs)};` : ''}</script>
<script>${safe(js)}</script>
</body>
</html>`;
}

fs.mkdirSync('dist/pwa', { recursive: true });
const cdnLibs = {
  pdf: CDN + 'pdfjs-dist@3.11.174/build/pdf.min.js', pdfWorker: CDN + 'pdfjs-dist@3.11.174/build/pdf.worker.min.js',
  mammoth: CDN + 'mammoth@1.8.0/mammoth.browser.min.js', jszip: CDN + 'jszip@3.10.1/dist/jszip.min.js',
};
const localLibs = { pdf: 'lib/pdf.min.js', pdfWorker: 'lib/pdf.worker.min.js', mammoth: 'lib/mammoth.browser.min.js', jszip: 'lib/jszip.min.js' };
fs.writeFileSync('dist/index.html', page({ mode: 'artifact', libs: cdnLibs }));
fs.writeFileSync('dist/test.html', page({ mode: 'artifact', libs: localLibs }));
fs.writeFileSync('dist/offline-template.txt', page({ mode: 'offline', inline: true }));
fs.writeFileSync('dist/pwa/index.html', page({ mode: 'pwa', inline: true, pwa: true }));
fs.writeFileSync('dist/pwa/manifest.webmanifest', JSON.stringify({
  name: 'เตรียมสอบ', short_name: 'เตรียมสอบ', start_url: './', scope: './', display: 'standalone',
  background_color: '#E6EAEE', theme_color: '#E6EAEE', lang: 'th',
  icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }],
}, null, 2));
fs.writeFileSync('dist/pwa/sw.js', `// offline cache for the installed app
const CACHE = 'prepcards-${VERSION}';
const CORE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin && req.mode === 'navigate') {
    // newest app when online, cached app when offline
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put('./index.html', c)); return r; }).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
    if (r.ok || r.type === 'opaque') { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); }
    return r;
  }).catch(() => hit)));
});
`);
execSync('python3 tools/icon.py dist/pwa');
for (const f of ['dist/index.html', 'dist/offline-template.txt', 'dist/pwa/index.html']) console.log(f, fs.statSync(f).size);
