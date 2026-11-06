// Rule-based extraction: document → cards. No AI; only patterns in the user's own text.
//
// card = { id, type: 'qa'|'mcq'|'term'|'list', front, back, options?, answer?, context?, flag? }

import { normalizeText, keyOf, stripBullet, joinWrap, isGarbled } from './normalize.js';

let seq = 0;
export function newId() {
  seq = (seq + 1) % 1e6;
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + seq.toString(36);
}

// ---------- exam ----------

const Q_RE = /^\s*(?:ข้อ(?:ที่)?\s*)?(\d{1,3})\s*[.)]\s*(.*)$/;
const OPT_RE = /^\s*\(?\s*([ก-งA-Da-d])\s*[.)]\s*(.+)$/;
const OPT_NUM_RE = /^\s*\(\s*([1-4])\s*\)\s*(.+)$/;
const OPT_SPACE_RE = /^\s*([A-D])\s+(.+)$/;
const OPT_THAI_SPACE_RE = /^\s*([ก-ง])\s+(.+)$/;
const ANS_RE = /^\s*\(?\s*(?:ตอบ|เฉลย|คำตอบ|ans(?:wer)?)\s*(?:ข้อ)?\s*[:：.\-=]?\s*\(?\s*([ก-งA-Da-d1-4])\s*\)?\s*(?:[.)]\s*(.*))?$/i;
const ANS_TEXT_RE = /^\s*(?:ตอบ|เฉลย|คำตอบ)\s*[:：.\-=]?\s*(.{2,})$/;
const KEY_HEAD_RE = /^\s*(?:เฉลย(?:ข้อสอบ|คำตอบ)?|answer\s*key|answers|คำตอบ)\s*[:：]?\s*$/i;
const PAIR_RE = /(\d{1,3})\s*[.)\-:=]?\s*\(?\s*([ก-งA-Da-d])\s*\)?(?=$|[\s,;/|])/g;
const MARK_RE = /\s*[*✓✔]\s*$|^\s*[*✓✔]\s*/;

export const ALL_OF_ABOVE_RE = /ถูกทุกข้อ|ผิดทุกข้อ|ถูกทั้ง|ผิดทั้ง|ทุกข้อ(ที่กล่าว)?|ไม่มีข้อใด|ข้อ\s*[ก-งA-D]\s*(และ|,|หรือ)\s*[ก-งA-D]|^[ก-งA-D]\s*(และ|,)\s*[ก-งA-D]|all of the above|none of the above|both [a-d] and/i;

export function letterIndex(ch) {
  if (!ch) return -1;
  const th = 'กขคง'.indexOf(ch);
  if (th >= 0) return th;
  const la = 'abcd'.indexOf(ch.toLowerCase());
  if (la >= 0) return la;
  const nu = '1234'.indexOf(ch);
  return nu;
}

function splitInlineOptions(text) {
  // "ก. aaa ข. bbb ค. ccc" → [{l:'ก',t:'aaa'},...]
  const re = /(?:^|\s)\(?([ก-งA-D])\s*[.)]\s*/g;
  const marks = [];
  let m;
  while ((m = re.exec(text))) marks.push({ l: m[1], at: m.index, end: re.lastIndex });
  if (marks.length < 2) return null;
  // letters must be in sequence ก ข ค … or A B C …
  for (let i = 1; i < marks.length; i++) if (letterIndex(marks[i].l) !== letterIndex(marks[i - 1].l) + 1) return null;
  const head = text.slice(0, marks[0].at).trim();
  const opts = marks.map((mk, i) => ({ l: mk.l, t: text.slice(mk.end, i + 1 < marks.length ? marks[i + 1].at : undefined).trim() }));
  return { head, opts };
}

function matchOption(text, inQuestion) {
  let m = text.match(OPT_RE) || text.match(OPT_NUM_RE) || text.match(OPT_SPACE_RE);
  if (!m && inQuestion) m = text.match(OPT_THAI_SPACE_RE);
  if (!m) return null;
  return { l: m[1], t: m[2].trim() };
}

function parsePairs(text) {
  const pairs = [];
  let m;
  PAIR_RE.lastIndex = 0;
  while ((m = PAIR_RE.exec(text))) pairs.push([+m[1], m[2]]);
  return pairs;
}

function isKeyLine(text) {
  const pairs = parsePairs(text);
  if (pairs.length < 2) return false;
  const stripped = text.replace(PAIR_RE, '').replace(/[\s,;/|]/g, '');
  return stripped.length <= 4;
}

export function extractExam(lines, tables = []) {
  const qs = [];
  const key = new Map();
  let cur = null;
  let inKey = false;
  let contCount = 0;
  const close = () => { if (cur) qs.push(cur); cur = null; };

  lines.forEach((ln, i) => {
    const text = ln.text;
    if (KEY_HEAD_RE.test(text)) { close(); inKey = true; ln._used = true; return; }
    if (inKey || isKeyLine(text)) {
      const pairs = parsePairs(text);
      if (pairs.length) { pairs.forEach(([n, l]) => key.set(n, l)); ln._used = true; return; }
      if (inKey && !Q_RE.test(text)) return;
      inKey = false;
    }
    // numeric options "1) ... 2) ..." inside a question
    const no = cur && text.match(/^\s*\(?\s*([1-4])\s*\)\s*(.+)$/);
    if (no && cur.answer == null && +no[1] === cur.options.length + 1 && (cur.options.length === 0 || /\d/.test(cur.options[0].l))) {
      cur.options.push({ l: no[1], t: no[2].trim() }); cur.lineIdx.push(i); contCount = 0; return;
    }
    const q = text.match(Q_RE);
    if (q && q[2]) {
      close();
      cur = { num: +q[1], text: q[2].trim(), options: [], answer: null, answerText: null, lineIdx: [i] };
      const inl = splitInlineOptions(cur.text);
      if (inl && inl.head) { cur.text = inl.head; cur.options.push(...inl.opts); }
      contCount = 0;
      return;
    }
    if (!cur) return;
    const a = text.match(ANS_RE);
    if (a) {
      cur.answer = a[1];
      if (a[2]) cur.answerText = a[2].trim();
      cur.lineIdx.push(i);
      return;
    }
    const inl = splitInlineOptions(text);
    if (inl && !inl.head) { cur.options.push(...inl.opts); cur.lineIdx.push(i); return; }
    const o = matchOption(text, true);
    if (o) {
      if (MARK_RE.test(o.t)) { o.t = o.t.replace(MARK_RE, '').trim(); cur.answer = o.l; }
      cur.options.push(o); cur.lineIdx.push(i); contCount = 0; return;
    }
    const at = text.match(ANS_TEXT_RE);
    if (at && cur.options.length === 0) { cur.answerText = at[1].trim(); cur.lineIdx.push(i); return; }
    if (ln.heading) { close(); return; }
    // continuation of question text (wrapped line) or of the last option
    if (contCount < 6) {
      if (cur.options.length === 0) cur.text = ln.para ? cur.text + '\n' + text : joinWrap(cur.text, text);
      else { const o = cur.options[cur.options.length - 1]; o.t = joinWrap(o.t, text); }
      cur.lineIdx.push(i); contCount++;
      return;
    }
    close();
  });
  close();

  for (const t of tables) for (const row of t) {
    if (row.length >= 2 && /^\d{1,3}$/.test(row[0].trim()) && /^[ก-งA-Da-d]$/.test(row[1].trim())) key.set(+row[0], row[1].trim());
  }

  const cards = [];
  let skippedNoKey = 0;
  for (const q of qs) {
    const front = normalizeText(q.text.replace(/\n/g, ' ')).replace(/\s*\?\s*$/, ' ?').trim();
    if (!front) continue;
    const ansLetter = q.answer || key.get(q.num) || null;
    let card = null;
    if (q.options.length >= 2) {
      const opts = q.options.map(o => normalizeText(o.t));
      let idx = -1;
      if (ansLetter) {
        const li = letterIndex(ansLetter);
        idx = q.options.findIndex(o => letterIndex(o.l) === li);
        if (idx < 0 && li < opts.length) idx = li;
      }
      if (idx >= 0) card = { type: 'mcq', front, back: opts[idx], options: opts, answer: idx };
      else { skippedNoKey++; continue; }
    } else if (q.options.length === 1) {
      card = { type: 'qa', front, back: normalizeText(q.options[0].t) };
    } else if (q.answerText) {
      card = { type: 'qa', front, back: normalizeText(q.answerText) };
    } else {
      continue; // not a question (e.g. numbered list in lesson text)
    }
    if (card.type === 'qa' && ALL_OF_ABOVE_RE.test(card.back)) card.flag = 'คำตอบนี้อ้างถึงตัวเลือกที่ไม่มีในไฟล์ — พิมพ์คำตอบจริงเพิ่มเอง';
    card.context = `ข้อ ${q.num}`;
    q.lineIdx.forEach(i => { lines[i]._used = true; });
    cards.push(card);
  }
  return { cards, skippedNoKey };
}

// ---------- terms ----------

const TERM_PATTERNS = [
  /^(.{1,60}?)\s*[:：]\s*(.{2,})$/,
  /^(.{1,60}?)\s+[–—-]\s+(.{2,})$/,
  /^(.{1,60}?)\s*=\s*(.{2,})$/,
  /^(.{2,50}?)\s*หมายถึง\s*(.{2,})$/,
  /^(.{2,40}?)\s*(?<!หรือ|ก็)คือ\s*(.{2,})$/,
];

function cleanTerm(t) {
  return stripBullet(t).replace(/^\s*(?:\d{1,2}|[ก-ฮ]|[a-zA-Z])\s*[.)]\s+/, '').replace(/^["“'‘]|["”'’]$/g, '').trim();
}

export function matchTerm(text) {
  if (/[?？]\s*$/.test(text) || /ข้อใด|อย่างไร\s*$/.test(text)) return null;
  for (const re of TERM_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const term = cleanTerm(m[1]);
    const def = m[2].trim();
    if (!/[\p{L}]/u.test(term) || /https?$/i.test(term) || term.length < 1) continue;
    if (/^\d+$/.test(def.replace(/\s/g, '')) && def.length < 3) continue;
    if (/[:：]$/.test(def)) continue;
    return { term, def };
  }
  return null;
}

const LIST_HEAD_RE = /([:：]|ได้แก่|ดังนี้|ดังต่อไปนี้|ประกอบด้วย|มี\s*\d+\s*(ประการ|ประเภท|ชนิด|ข้อ|อย่าง|แบบ|ขั้น(ตอน)?|ส่วน|ลักษณะ|วิธี|กลุ่ม|ระดับ))\s*$/;

function extractFromLines(lines) {
  const cards = [];
  const live = lines.filter(l => !l._used);
  for (let i = 0; i < live.length; i++) {
    const ln = live[i];
    // list: heading/lead line followed by ≥2 bullets
    if (ln.heading || LIST_HEAD_RE.test(ln.text)) {
      const items = [];
      let j = i + 1;
      while (j < live.length) {
        const l = live[j];
        if (l.heading) break;
        if (l.bullet || /^\s*\d{1,2}\s*[.)]\s/.test(l.text)) { items.push(l); j++; continue; }
        if (!l.para && items.length && !matchTerm(l.text)) { items[items.length - 1] = { ...items[items.length - 1], text: joinWrap(items[items.length - 1].text, l.text) }; j++; continue; }
        break;
      }
      if (items.length >= 2) {
        const parts = items.map(it => {
          const t = cleanTerm(it.text);
          const tm = matchTerm(t);
          if (tm) cards.push({ type: 'term', front: tm.term, back: tm.def, context: stripHead(ln.text) });
          return tm ? tm.term : t;
        });
        cards.push({ type: 'list', front: stripHead(ln.text), back: parts.map(p => '• ' + p).join('\n'), context: '' });
        i = j - 1;
        continue;
      }
    }
    const tm = matchTerm(ln.text);
    if (tm) {
      let def = tm.def;
      // wrapped PDF lines continue the definition
      let j = i + 1;
      while (!ln.para && j < live.length && j - i <= 4) {
        const l = live[j];
        if (l.heading || l.bullet || matchTerm(l.text) || Q_RE.test(l.text) || LIST_HEAD_RE.test(l.text)) break;
        def = joinWrap(def, l.text); j++;
      }
      cards.push({ type: 'term', front: tm.term, back: def, context: '' });
      i = j - 1;
    }
  }
  return cards;
}

function stripHead(t) {
  return cleanTerm(t).replace(/\s*[:：]\s*$/, '').trim();
}

// ---------- tables ----------

const HEADER_WORDS = /^(คำ(ศัพท์)?|ความหมาย|ชื่อ|รายการ|หัวข้อ|ลำดับ(ที่)?|ที่|ข้อ|term|word|definition|meaning|รายละเอียด|คำอธิบาย|หมายเหตุ|no\.?)$/i;

export function extractTables(tables, context = '') {
  const cards = [];
  for (const rows0 of tables) {
    const rows = rows0.map(r => r.map(c => normalizeText(c))).filter(r => r.some(Boolean));
    if (!rows.length) continue;
    const width = Math.max(...rows.map(r => r.length));
    let header = null;
    if (rows.length > 1 && rows[0].some(c => HEADER_WORDS.test(c))) header = rows.shift();
    // drop a leading "ลำดับ" / numbers column
    let start = 0;
    if (width >= 3 && rows.every(r => /^\d{0,3}\.?$/.test(r[0] || ''))) start = 1;
    for (const r of rows) {
      const cells = r.slice(start);
      if (cells.length < 2 || !cells[0] || !cells.slice(1).some(Boolean)) continue;
      if (/^\d{1,3}$/.test(cells[0]) && /^[ก-งA-Da-d]$/.test(cells[1])) continue; // answer key
      let back;
      if (cells.length === 2) back = cells[1];
      else back = cells.slice(1).map((c, k) => c && (header && header[k + 1 + start] ? `${header[k + 1 + start]}: ${c}` : c)).filter(Boolean).join('\n');
      cards.push({ type: 'term', front: cells[0], back, context });
    }
  }
  return cards;
}

// ---------- slides ----------

const SKIP_TITLES = /^(แนะนำ(ตัว)?ผู้(บรรยาย|สอน)|ขอบคุณ|thank\s*you|คำถาม|q\s*&\s*a|ถาม\s*-?\s*ตอบ|จบ(การบรรยาย)?|the end)$/i;

function extractSlides(slides) {
  const groups = [];
  for (const s of slides) {
    const last = groups[groups.length - 1];
    if (last && s.title && keyOf(last.title) === keyOf(s.title)) {
      last.items.push(...s.items); last.tables.push(...s.tables);
    } else groups.push({ title: s.title, items: [...s.items], tables: [...s.tables] });
  }
  const cards = [];
  for (const g of groups) {
    const title = stripHead(g.title || '');
    if (SKIP_TITLES.test(title)) continue;
    if (!g.items.length && !g.tables.length) {
      // statement slide such as "วิธีการเอาชนะ ขศ.ที่ดีที่สุดคือ / การเป็นฝ่ายรุก"
      const tm = matchTerm(title);
      if (tm && tm.def.length >= 2) cards.push({ type: 'term', front: tm.term, back: tm.def, context: '' });
      continue;
    }
    cards.push(...extractTables(g.tables, title));
    const seenItems = new Set();
    const items = g.items.map(it => ({ ...it, text: normalizeText(it.text) }))
      .filter(it => it.text && !/^[0-9๐-๙]{1,4}$/.test(it.text) && !isGarbled(it.text))
      .filter(it => { const k = keyOf(it.text); if (seenItems.has(k)) return false; seenItems.add(k); return true; });
    if (!items.length) continue;
    const parts = [];
    for (const it of items) {
      const t = cleanTerm(it.text);
      const tm = matchTerm(t);
      if (tm) { cards.push({ type: 'term', front: tm.term, back: tm.def, context: title }); parts.push(tm.term); }
      else parts.push(t);
    }
    if (!title) continue;
    if (items.length === 1) {
      if (!matchTerm(cleanTerm(items[0].text)) && parts[0].length >= 4) cards.push({ type: 'term', front: title, back: parts[0], context: '' });
    } else {
      cards.push({ type: 'list', front: title, back: parts.map(p => '• ' + p).join('\n'), context: '' });
    }
  }
  return cards;
}

// ---------- main ----------

export function extractCards(doc, mode = 'auto') {
  const stats = { qa: 0, mcq: 0, term: 0, list: 0, skippedNoKey: 0, flagged: 0, dupes: 0 };
  let cards = [];
  if (doc.kind === 'slides') {
    if (mode !== 'content') {
      // slides can hold exam questions too
      const lines = doc.slides.flatMap(s => [s.title, ...s.items.map(i => i.text)].filter(Boolean).map(text => ({ text, para: true })));
      const ex = extractExam(lines, doc.slides.flatMap(s => s.tables));
      if (ex.cards.length >= 3 || mode === 'exam') { cards.push(...ex.cards); stats.skippedNoKey = ex.skippedNoKey; }
    }
    if (mode !== 'exam' && !(mode === 'auto' && cards.length >= 3 && cards.length * 2 > doc.slides.length)) cards.push(...extractSlides(doc.slides));
  } else {
    const lines = doc.lines.map(l => ({ ...l, _used: false }));
    if (mode !== 'content') {
      const ex = extractExam(lines, doc.tables);
      if (ex.cards.length >= 2 || mode === 'exam') { cards.push(...ex.cards); stats.skippedNoKey = ex.skippedNoKey; }
      else lines.forEach(l => { l._used = false; });
    }
    if (mode !== 'exam') {
      cards.push(...extractFromLines(lines));
      cards.push(...extractTables(doc.tables));
    }
  }
  // clean, dedupe, id
  const seen = new Set();
  const out = [];
  for (const c of cards) {
    c.front = normalizeText(c.front);
    c.back = c.type === 'list' ? c.back.split('\n').map(normalizeText).join('\n') : normalizeText(c.back);
    if (!c.front || !c.back) continue;
    const k = c.type + '|' + keyOf(c.front) + '|' + keyOf(c.back);
    if (seen.has(k)) { stats.dupes++; continue; }
    seen.add(k);
    c.id = newId();
    stats[c.type]++;
    if (c.flag) stats.flagged++;
    out.push(c);
  }
  return { cards: out, stats };
}
