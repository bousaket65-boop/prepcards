// Thai text cleanup for text extracted from PDF / Office files.

const COMBINING = 'ัิ-ฺ็-๎';
const reSpaceBeforeMark = new RegExp(`\\s+([${COMBINING}])`, 'g');

export function normalizeText(s) {
  if (!s) return '';
  let t = String(s).normalize('NFC');
  t = t.replace(/[  -​　]/g, ' ');
  t = t.replace(/‌|‍|﻿/g, '');
  // nikhahit + sara aa  ->  sara am  (PDFs from PowerPoint often split ำ)
  t = t.replace(/ํา/g, 'ำ');
  // tone mark placed between nikhahit and sara aa: ํ่า -> ่ำ
  t = t.replace(/ํ([่-๋])า/g, '$1ำ');
  t = t.replace(reSpaceBeforeMark, '$1');
  // stray / doubled marks
  t = t.replace(/([0-9\s])[\u0E48-\u0E4B]+/g, '$1');
  t = t.replace(/([\u0E31\u0E34-\u0E3A\u0E47-\u0E4E])\1+/g, '$1');
  t = t.replace(/[ \t]+/g, ' ');
  return t.trim();
}

// Key for duplicate detection / comparison.
export function keyOf(s) {
  return normalizeText(s).toLowerCase().replace(/[\s"'“”‘’.,:;!?()\[\]\-–—]/g, '');
}

export const BULLET_RE = /^\s*(?:[•‣⁃∙■□▪▫▶►●◦★☆✓✔➢➤➜➔◆◇♦-]|[o\-–*•>]\s)\s*/;

export function stripBullet(s) {
  return s.replace(BULLET_RE, '').trim();
}

export function isBullet(s) {
  return BULLET_RE.test(s);
}

export function hasDigit(s) {
  return /[0-9๐-๙]/.test(s);
}

// Join a wrapped line. Thai has no spaces between words, so Thai–Thai wraps join directly.
export function joinWrap(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (/[\u0E01-\u0E4E]$/.test(a) && /^[\u0E01-\u0E4E]/.test(b)) return a + b;
  return a + ' ' + b;
}

// Text from a PDF font with a broken unicode map comes out as Latin-extended/Greek junk.
export function isGarbled(s) {
  const bad = (s.match(/[\u0100-\u024F\u0370-\u03FF\u2070-\u209F\uFFFD]/g) || []).length;
  return bad >= 2 && bad / s.replace(/\s/g, '').length > 0.15;
}
