// File readers: turn a file into a common "document" structure.
//
// doc = {
//   kind: 'slides' | 'lines',
//   slides?: [{ title, items: [{ text, bullet, level }], tables: [[[cell]]] }],
//   lines?:  [{ text, heading, bullet, level, para }],   // para: true = real paragraph (no wrap joining)
//   tables?: [[[cell]]],
//   pages?: number,
// }

import { normalizeText, isBullet, joinWrap, isGarbled } from './normalize.js';

export const MAX_BYTES = 50 * 1024 * 1024;

export function fileKind(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'pptx') return 'pptx';
  if (['txt', 'md', 'text', 'csv'].includes(ext)) return 'txt';
  if (ext === 'doc') return 'old-doc';
  if (ext === 'ppt') return 'old-ppt';
  if (['jpg', 'jpeg', 'png', 'heic', 'webp', 'gif'].includes(ext)) return 'image';
  return 'unknown';
}

// ---------- PDF ----------

function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

// Group pdf.js text items into visual lines.
export function itemsToLines(items) {
  const parts = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const size = Math.abs(it.height || it.transform[3] || 0) || 10;
    parts.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, size });
  }
  parts.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const p of parts) {
    const line = lines.find(l => Math.abs(l.y - p.y) < Math.max(2, Math.min(l.size, p.size) * 0.45));
    if (line) { line.parts.push(p); line.size = Math.max(line.size, p.size); }
    else lines.push({ y: p.y, size: p.size, parts: [p] });
  }
  for (const l of lines) {
    l.parts.sort((a, b) => a.x - b.x);
    let text = '';
    let end = null;
    for (const p of l.parts) {
      if (end !== null && p.x - end > l.size * 0.18 && !text.endsWith(' ') && !p.str.startsWith(' ')) text += ' ';
      text += p.str;
      end = p.x + p.w;
    }
    l.x = l.parts[0].x;
    l.text = normalizeText(text);
    delete l.parts;
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.filter(l => l.text);
}

export async function readPdf(pdfjsLib, data, onProgress) {
  const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    pages.push({ width: vp.width, height: vp.height, lines: itemsToLines(tc.items) });
    page.cleanup && page.cleanup();
    onProgress && onProgress(i, pdf.numPages);
  }
  try { await pdf.destroy(); } catch (e) { /* ignore */ }
  return pdfPagesToDoc(pages);
}

const stripNums = s => s.replace(/[0-9๐-๙]+/g, '#').replace(/\s+/g, '');

export function pdfPagesToDoc(pages) {
  const n = pages.length;
  const totalChars = pages.reduce((s, p) => s + p.lines.reduce((t, l) => t + l.text.length, 0), 0);
  // remove page numbers and headers/footers repeated on many pages
  const freq = new Map();
  for (const p of pages) {
    const seen = new Set(p.lines.map(l => stripNums(l.text)));
    for (const k of seen) freq.set(k, (freq.get(k) || 0) + 1);
  }
  const repeated = new Set();
  if (n >= 3) for (const [k, c] of freq) if (c >= Math.max(3, n * 0.3)) repeated.add(k);
  pages.forEach((p, pi) => {
    for (const l of p.lines) {
      const m = l.text.match(/^(.*\S)\s+(\d{1,3})$/);
      if (m && Math.abs(+m[2] - (pi + 1)) <= 3 && l.text.length > 6) l.text = m[1];
    }
  });
  for (const p of pages) {
    p.lines = p.lines.filter(l => !isGarbled(l.text)).filter(l => !/^[0-9๐-๙]{1,4}$/.test(l.text) && !repeated.has(stripNums(l.text)) && !/^หน้า\s*\d+\s*(ใน|\/|จาก)\s*\d+/.test(l.text));
  }
  const landscape = pages.filter(p => p.width > p.height).length > n / 2;
  const scanned = totalChars < n * 15; // almost no text → scanned images
  if (landscape) return { kind: 'slides', slides: pages.map(slideFromPdfPage), pages: n, scanned };

  const sizes = pages.flatMap(p => p.lines.map(l => l.size));
  const body = median(sizes);
  const lines = [];
  pages.forEach((p, pi) => {
    for (const l of p.lines) {
      if (l.size < body * 0.6) continue;
      lines.push({
        text: l.text,
        heading: l.size > body * 1.2 && l.text.length < 80,
        bullet: isBullet(l.text),
        level: 0,
        para: false,
        page: pi + 1,
      });
    }
  });
  return { kind: 'lines', lines, tables: [], pages: n, scanned };
}

function slideFromPdfPage(p) {
  const lines = p.lines;
  if (!lines.length) return { title: '', items: [], tables: [] };
  const body = median(lines.map(l => l.size));
  const titleLines = [lines[0]];
  let i = 1;
  while (i < lines.length && titleLines.length < 3) {
    const prev = titleLines[titleLines.length - 1];
    const l = lines[i];
    if (Math.abs(l.size - prev.size) <= 1.5 && prev.y - l.y < prev.size * 2.2 && !isBullet(l.text) && prev.size > body + 1.5) {
      titleLines.push(l); i++;
    } else break;
  }
  // Single title line of the same size as the body is still the top line.
  const title = titleLines.map(l => l.text).join(' ');
  const items = [];
  for (const l of lines.slice(i)) {
    if (l.size < body * 0.6) continue; // tiny labels in diagrams
    const bullet = isBullet(l.text);
    const prev = items[items.length - 1];
    const startsNew = bullet || !prev || looksLikeTermLine(l.text) || (prev && /[:：]$/.test(prev.text));
    if (startsNew) items.push({ text: l.text, bullet, level: 0, size: l.size });
    else prev.text = joinWrap(prev.text, l.text);
  }
  // Section / statement slides: a few lines all at the title's size, no bullets → it is all title.
  const tsize = titleLines[0].size;
  if (items.length && items.length <= 2 && items.every(it => !it.bullet && Math.abs(it.size - tsize) <= 1.5)) {
    return { title: [title, ...items.map(it => it.text)].reduce(joinWrap), items: [], tables: [], statement: true };
  }
  return { title, items, tables: [] };
}

function looksLikeTermLine(t) {
  const m = t.match(/^(.{1,60}?)\s*[:：]\s*(.+)$/);
  return !!(m && /[\p{L}]/u.test(m[1]) && !/^\d+$/.test(m[1]));
}

// ---------- PPTX ----------

export async function readPptx(JSZip, parseXml, data) {
  const zip = await JSZip.loadAsync(data);
  const names = Object.keys(zip.files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => +a.match(/(\d+)\.xml$/)[1] - +b.match(/(\d+)\.xml$/)[1]);
  const slides = [];
  for (const name of names) {
    const xml = parseXml(await zip.file(name).async('string'));
    slides.push(slideFromPptxXml(xml));
  }
  return { kind: 'slides', slides, pages: slides.length, scanned: false };
}

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';

function byTag(el, ns, tag) { return Array.from(el.getElementsByTagNameNS(ns, tag)); }

function paraText(p) {
  let s = '';
  const walk = node => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      if (c.localName === 't') s += c.textContent;
      else if (c.localName === 'br') s += ' ';
      else walk(c);
    }
  };
  walk(p);
  return normalizeText(s);
}

function slideFromPptxXml(xml) {
  let title = '';
  const items = [];
  const tables = [];
  for (const sp of byTag(xml, P, 'sp')) {
    const ph = byTag(sp, P, 'ph')[0];
    const phType = ph ? (ph.getAttribute('type') || 'body') : null;
    const paras = byTag(sp, A, 'p');
    if (phType === 'title' || phType === 'ctrTitle') {
      title = normalizeText(paras.map(paraText).filter(Boolean).join(' '));
      continue;
    }
    if (phType === 'sldNum' || phType === 'dt' || phType === 'ftr') continue;
    for (const p of paras) {
      const text = paraText(p);
      if (!text) continue;
      const pPr = byTag(p, A, 'pPr')[0];
      const level = pPr ? +(pPr.getAttribute('lvl') || 0) : 0;
      const noBullet = pPr && byTag(pPr, A, 'buNone').length > 0;
      const bullet = (phType !== null && !noBullet) || (pPr && (byTag(pPr, A, 'buChar').length || byTag(pPr, A, 'buAutoNum').length) > 0) || isBullet(text);
      items.push({ text, bullet: !!bullet, level });
    }
  }
  for (const tbl of byTag(xml, A, 'tbl')) {
    const rows = byTag(tbl, A, 'tr').map(tr => byTag(tr, A, 'tc').map(tc => normalizeText(byTag(tc, A, 'p').map(paraText).join(' '))));
    if (rows.length) tables.push(rows);
  }
  // table text also appears inside graphicFrame, not p:sp, so items are clean.
  if (!title && items.length) {
    // no title placeholder: use the first short line
    if (items[0].text.length <= 80) title = items.shift().text;
  }
  return { title, items, tables };
}

// ---------- DOCX (via mammoth → HTML) ----------

export async function readDocx(mammoth, parseHtml, data) {
  const res = await mammoth.convertToHtml(data instanceof ArrayBuffer ? { arrayBuffer: data } : { buffer: data });
  return htmlToDoc(parseHtml(res.value));
}

export function htmlToDoc(root) {
  const lines = [];
  const tables = [];
  const walkList = (list, level, numbered) => {
    let idx = 0;
    for (const li of Array.from(list.children)) {
      if (li.tagName !== 'LI') continue;
      idx++;
      let own = '';
      for (const c of Array.from(li.childNodes)) {
        if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) continue;
        own += c.textContent;
      }
      own = normalizeText(own);
      if (own) {
        const text = numbered && level === 0 && !/^\s*(ข้อ\s*)?\d+\s*[.)]/.test(own) ? `${idx}. ${own}` : own;
        lines.push({ text, heading: false, bullet: true, level, para: true, listIndex: idx, numbered });
      }
      for (const c of Array.from(li.children)) {
        if (c.tagName === 'UL' || c.tagName === 'OL') walkList(c, level + 1, c.tagName === 'OL');
      }
    }
  };
  for (const el of Array.from(root.children)) {
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const text = normalizeText(el.textContent);
      if (text) lines.push({ text, heading: true, bullet: false, level: +tag[1], para: true });
    } else if (tag === 'P') {
      const text = normalizeText(el.textContent);
      if (!text) continue;
      const strong = el.querySelector('strong');
      const allBold = strong && normalizeText(strong.textContent) === text;
      lines.push({ text, heading: !!allBold && text.length < 80, bullet: isBullet(text), level: 0, para: true });
    } else if (tag === 'UL' || tag === 'OL') {
      walkList(el, 0, tag === 'OL');
    } else if (tag === 'TABLE') {
      const rows = Array.from(el.querySelectorAll('tr')).map(tr => Array.from(tr.children).map(td => normalizeText(td.textContent)));
      if (rows.length) tables.push(rows);
    } else {
      const text = normalizeText(el.textContent);
      if (text) lines.push({ text, heading: false, bullet: false, level: 0, para: true });
    }
  }
  return { kind: 'lines', lines, tables, pages: 0, scanned: false };
}

// ---------- plain text ----------

export function textToDoc(text) {
  const lines = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const t = normalizeText(raw);
    if (!t) { lines.push({ text: '', blank: true }); continue; }
    const md = t.match(/^(#{1,6})\s+(.*)$/);
    if (md) { lines.push({ text: md[2], heading: true, bullet: false, level: md[1].length, para: true }); continue; }
    lines.push({ text: t, heading: false, bullet: isBullet(t), level: 0, para: true });
  }
  return { kind: 'lines', lines: lines.filter(l => !l.blank), tables: [], pages: 0, scanned: false };
}
