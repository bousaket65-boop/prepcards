import { MAX_BYTES, fileKind, readPdf, readDocx, readPptx, textToDoc } from './readers.js';
import { extractCards, newId, ALL_OF_ABOVE_RE } from './extract.js';
import { shuffle, requeue, isQuizzable, buildQuestion } from './quiz.js';
import { openStore } from './store.js';

const MODE = window.PREP_MODE || 'artifact'; // 'artifact' | 'offline' | 'pwa'
// Offline copies rebuild themselves from their own markup when exporting.
const SELF_HTML = MODE !== 'artifact' ? '<!DOCTYPE html>\n' + document.documentElement.outerHTML : null;
const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nl = s => esc(s).replace(/\n/g, '<br>');
const TYPE_LABEL = { qa: 'ถาม–ตอบ', mcq: 'ปรนัย', term: 'คำ–ความหมาย', list: 'หัวข้อ–รายการ' };

let store = null;
let S = { subjects: [], decks: [], cards: new Map(), progress: new Map() };
let loaded = false;
let route = { name: 'home' };
let history = [];
let draftQueue = [];  // drafts waiting for review after import
let session = null;   // flashcard or quiz session
let syncNote = '';

// ---------- helpers ----------

function go(name, params = {}, push = true) {
  if (push) history.push(route);
  route = { name, ...params };
  render();
  window.scrollTo(0, 0);
}
function back() {
  clearInterval(window.__mockTimer);
  route = history.pop() || { name: 'home' };
  session = null;
  render();
  window.scrollTo(0, 0);
}
const subjectById = id => S.subjects.find(s => s.id === id);
const deckById = id => S.decks.find(d => d.id === id);
const decksOf = sid => S.decks.filter(d => d.subjectId === sid);
const cardsOf = did => S.cards.get(did) || [];

function progressFor(deckIds) {
  let total = 0, known = 0;
  for (const id of deckIds) {
    const p = store ? store.progressOf(id) : {};
    for (const c of cardsOf(id)) { total++; if (p[c.id] && p[c.id].k) known++; }
  }
  return { total, known };
}

function bar(known, total) {
  const pct = total ? Math.round(known / total * 100) : 0;
  return `<div class="meter" role="img" aria-label="จำได้ ${known} จาก ${total} ใบ"><span style="width:${pct}%"></span></div>`;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('out'), 2200);
  setTimeout(() => t.remove(), 2700);
}

function dialog({ title, body = '', confirm = 'ตกลง', cancel = 'ยกเลิก', danger = false, input = null }) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h2>${esc(title)}</h2>${body ? `<p>${esc(body)}</p>` : ''}
      ${input !== null ? `<input class="field" value="${esc(input)}" maxlength="80">` : ''}
      <div class="row end">${cancel ? `<button class="btn ghost" data-r="0">${esc(cancel)}</button>` : ''}<button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(confirm)}</button></div></div>`;
    document.body.appendChild(wrap);
    const inp = wrap.querySelector('input');
    (inp || wrap.querySelector('[data-r="1"]')).focus();
    if (inp) inp.select();
    const done = ok => { wrap.remove(); resolve(input !== null ? (ok ? inp.value.trim() : null) : ok); };
    wrap.addEventListener('click', e => {
      if (e.target === wrap) done(false);
      const r = e.target.closest('[data-r]');
      if (r) done(r.dataset.r === '1');
    });
    wrap.addEventListener('keydown', e => {
      if (e.key === 'Escape') done(false);
      if (e.key === 'Enter' && inp) done(true);
    });
  });
}

function topbar(title, { backBtn = true, sub = '' } = {}) {
  return `<header class="top">${backBtn ? '<button class="iconbtn" data-a="back" aria-label="ย้อนกลับ">‹</button>' : '<span class="brand">เตรียมสอบ</span>'}
    <div class="ttl"><h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div></header>`;
}

// ---------- screens ----------

function viewHome() {
  const list = S.subjects.map(s => {
    const ids = decksOf(s.id).map(d => d.id);
    const { total, known } = progressFor(ids);
    return `<button class="item" data-a="open-subject" data-id="${s.id}">
      <span class="item-main"><b>${esc(s.name)}</b><small>${ids.length} ชุด ${total} ใบ${total ? `, จำได้ ${known}` : ''}</small></span>
      ${bar(known, total)}</button>`;
  }).join('');
  return `${topbar('วิชาของฉัน', { backBtn: false })}
  <main>
    ${syncNote ? `<p class="note">${esc(syncNote)}</p>` : ''}
    ${!loaded ? '<p class="muted center">กำลังโหลดข้อมูล…</p>' : S.subjects.length ? `<div class="list">${list}</div>` :
      `<div class="empty"><p>ยังไม่มีวิชา</p><p class="muted">เพิ่มวิชาก่อน แล้วนำเข้าชีทเรียน สไลด์ หรือข้อสอบที่มีเฉลย แอปจะทำแฟลชการ์ดและแบบทดสอบให้</p></div>`}
    <div class="stack">
      <button class="btn primary big" data-a="import" ${loaded ? '' : 'disabled'}>นำเข้าไฟล์</button>
      <button class="btn ghost" data-a="new-subject" ${loaded ? '' : 'disabled'}>เพิ่มวิชา</button>
    </div>
    ${S.subjects.length ? `<div class="study">
      <button class="btn accent big" data-a="mock-setup">สอบจำลอง<small>คละทุกวิชา จับเวลา</small></button>
      <button class="btn ghost big" data-a="weak">ข้อที่ผิดบ่อย<small>${weakCards().length} ใบ</small></button>
    </div>` : ''}
    <section class="offline">
      <h2 class="sec">ใช้แบบไม่มีเน็ต</h2>
      <p class="muted small">${MODE === 'artifact'
        ? 'ดาวน์โหลดเป็นไฟล์ .html ที่มีแอปและการ์ดทุกวิชาอยู่ข้างใน บน Android และคอมเปิดไฟล์ได้เลยโดยไม่ต้องมีเน็ต บน iPhone ให้เปิดแอปฉบับติดตั้ง แล้วกด "นำเข้าข้อมูลจากไฟล์" เลือกไฟล์นี้'
        : 'ฉบับนี้ใช้ได้โดยไม่ต้องมีเน็ต ข้อมูลเก็บในเครื่องนี้ กด "ดาวน์โหลดสำเนา" เพื่อย้ายการ์ดและความคืบหน้าไปเครื่องอื่น หรือนำกลับไปเข้าฉบับออนไลน์'}</p>
      <div class="row">
        <button class="btn ghost" data-a="download-offline" ${loaded ? '' : 'disabled'}>${MODE === 'artifact' ? 'ดาวน์โหลดไว้ใช้ออฟไลน์' : 'ดาวน์โหลดสำเนา'}</button>
        <button class="btn ghost" data-a="import-data" ${loaded ? '' : 'disabled'}>นำเข้าข้อมูลจากไฟล์</button>
      </div>
      <input type="file" id="data-file" accept=".html,.htm,.json,text/html,application/json" hidden>
    </section>
  </main>`;
}

const DATA_RE = /<script type="application\/json" id="prep-data">[\s\S]*?<\/script>/;

function embedData(template, payload) {
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  const id = ['prep', 'data'].join('-'), sc = ['scr', 'ipt'].join('');
  const tag = `<${sc} type="application/json" id="${id}">${json}</${sc}>`;
  if (DATA_RE.test(template)) return template.replace(DATA_RE, () => tag);
  return template.replace('<!--PREP_DATA-->', () => tag);
}

function readEmbedded(text) {
  const t = text.trim();
  if (t.startsWith('{')) return JSON.parse(t);
  const m = t.match(/<script type="application\/json" id="prep-data">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('ไม่พบข้อมูลการ์ดในไฟล์นี้');
  return JSON.parse(m[1]);
}

async function downloadOffline(btn) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'กำลังเตรียมไฟล์…';
  try {
    const payload = await store.exportAll();
    const day = new Date().toISOString().slice(0, 10);
    const filename = `เตรียมสอบ-ออฟไลน์-${day}.html`;
    if (MODE === 'artifact') {
      const dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null;
      if (!dl) throw new Error('หน้านี้ดาวน์โหลดไฟล์ไม่ได้ ลองเปิดแอปจากเว็บ claude.ai');
      const res = await fetch('offline-template.txt');
      if (!res.ok) throw new Error('โหลดตัวแอปฉบับออฟไลน์ไม่สำเร็จ');
      const html = embedData(await res.text(), payload);
      await dl.save({ filename, data: new Blob([html], { type: 'text/html' }) });
      toast('ดาวน์โหลดแล้ว');
    } else {
      const html = embedData(SELF_HTML, payload);
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  } catch (e) {
    console.error(e);
    if (!(e && e.code === 'declined')) toast(e && e.message && !e.code ? e.message : 'ดาวน์โหลดไม่สำเร็จ ลองอีกครั้ง');
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

async function importData(file) {
  try {
    if (file.size > MAX_BYTES) throw new Error('ไฟล์ใหญ่เกิน 50 MB');
    const payload = readEmbedded(await file.text());
    const { decks } = await store.importAll(payload);
    toast(`นำเข้าแล้ว ${decks} ชุดการ์ด`);
  } catch (e) {
    console.error(e);
    toast(e.message && /[ก-๙]/.test(e.message) ? e.message : 'ไฟล์นี้ไม่ใช่ข้อมูลของแอปเตรียมสอบ');
  }
}

function studyButtons(scope) {
  const cards = scope.deckIds.flatMap(cardsOf);
  const quizN = cards.filter(isQuizzable).length;
  return `<div class="study">
    <button class="btn primary big" data-a="flash" ${cards.length ? '' : 'disabled'}>ทบทวนแฟลชการ์ด<small>${cards.length} ใบ</small></button>
    <button class="btn accent big" data-a="quiz" ${quizN >= 2 ? '' : 'disabled'}>ทำข้อสอบ<small>${quizN} ข้อ</small></button>
  </div>`;
}

function viewSubject() {
  const s = subjectById(route.id);
  if (!s) return viewMissing();
  const decks = decksOf(s.id);
  const { total, known } = progressFor(decks.map(d => d.id));
  return `${topbar(s.name, { sub: `${decks.length} ชุด ${total} ใบ, จำได้ ${known}` })}
  <main>
    ${bar(known, total)}
    ${studyButtons({ deckIds: decks.map(d => d.id) })}
    <h2 class="sec">ชุดการ์ดในวิชานี้</h2>
    ${decks.length ? `<div class="list">${decks.map(d => {
      const p = progressFor([d.id]);
      return `<button class="item" data-a="open-deck" data-id="${d.id}"><span class="item-main"><b>${esc(d.name)}</b><small>${p.total} ใบ, จำได้ ${p.known}</small></span>${bar(p.known, p.total)}</button>`;
    }).join('')}</div>` : '<p class="muted">ยังไม่มีชุดการ์ด นำเข้าไฟล์เพื่อสร้างชุดแรก</p>'}
    <div class="stack">
      <button class="btn ghost" data-a="import" data-sid="${s.id}">นำเข้าไฟล์เข้าวิชานี้</button>
      <div class="row">
        <button class="btn ghost" data-a="rename-subject">เปลี่ยนชื่อวิชา</button>
        <button class="btn ghost danger-text" data-a="delete-subject">ลบวิชา</button>
      </div>
    </div>
  </main>`;
}

function viewDeck() {
  const d = deckById(route.id);
  if (!d) return viewMissing();
  const cards = cardsOf(d.id);
  const p = store.progressOf(d.id);
  const counts = {};
  cards.forEach(c => { counts[c.type] = (counts[c.type] || 0) + 1; });
  const s = subjectById(d.subjectId);
  return `${topbar(d.name, { sub: s ? s.name : '' })}
  <main>
    <p class="chips">${Object.entries(counts).map(([t, n]) => `<span class="chip">${TYPE_LABEL[t]} ${n}</span>`).join('')}</p>
    ${studyButtons({ deckIds: [d.id] })}
    <div class="row">
      <button class="btn ghost" data-a="edit-deck">แก้ไขการ์ด</button>
      <button class="btn ghost" data-a="reset-progress">เริ่มนับใหม่</button>
      <button class="btn ghost danger-text" data-a="delete-deck">ลบชุดนี้</button>
    </div>
    <h2 class="sec">การ์ดทั้งหมด</h2>
    <ol class="cardlist">${cards.map(c => `<li class="${p[c.id] && p[c.id].k ? 'known' : ''}">
      <span class="kind">${TYPE_LABEL[c.type]}${p[c.id] && p[c.id].k ? ', จำได้แล้ว' : ''}</span>
      <b>${nl(c.front)}</b><span>${nl(c.back)}</span>${c.flag ? `<em class="flag">${esc(c.flag)}</em>` : ''}</li>`).join('')}</ol>
  </main>`;
}

function viewMissing() {
  return `${topbar('ไม่พบข้อมูล')}<main><p class="muted">รายการนี้ถูกลบไปแล้ว</p><button class="btn primary" data-a="home">กลับหน้าแรก</button></main>`;
}

// ----- import -----

function viewImport() {
  const opts = S.subjects.map(s => `<option value="${s.id}" ${s.id === route.sid ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  return `${topbar('นำเข้าไฟล์')}
  <main>
    <label class="lbl" for="imp-subject">วิชา</label>
    <select id="imp-subject" class="field">${opts}<option value="__new" ${S.subjects.length ? '' : 'selected'}>+ วิชาใหม่…</option></select>
    <input id="imp-newname" class="field ${S.subjects.length ? 'hide' : ''}" placeholder="ชื่อวิชาใหม่ เช่น การพราง" maxlength="80">

    <fieldset class="seg"><legend class="lbl">ไฟล์นี้เป็น</legend>
      <label><input type="radio" name="mode" value="auto" checked><span>ให้แอปดูเอง</span></label>
      <label><input type="radio" name="mode" value="content"><span>เนื้อหา/ชีท</span></label>
      <label><input type="radio" name="mode" value="exam"><span>ข้อสอบมีเฉลย</span></label>
    </fieldset>

    <label class="drop" id="drop">
      <input type="file" id="imp-file" accept=".pdf,.docx,.pptx,.txt,.md" multiple>
      <b>เลือกไฟล์</b>
      <small>PDF, Word (.docx), PowerPoint (.pptx), .txt ไม่เกิน 50 MB ต่อไฟล์ เลือกได้หลายไฟล์</small>
    </label>

    <details class="paste"><summary>หรือวางข้อความ / โน้ตที่พิมพ์เอง</summary>
      <textarea id="imp-text" class="field" rows="8" placeholder="เช่น&#10;การพราง : การปกปิดที่ตั้งจากการตรวจการณ์ของข้าศึก&#10;1. ลวดหีบเพลงคลี่ได้ยาวกี่เมตร&#10;ตอบ 15 เมตร"></textarea>
      <button class="btn primary" data-a="import-text">สร้างการ์ดจากข้อความ</button>
    </details>
    <div id="imp-status" class="status" aria-live="polite"></div>
    <p class="muted small">แอปอ่านเฉพาะข้อความที่มีในไฟล์ ไม่ใช้ AI และไม่ส่งไฟล์ไปที่ใด ไฟล์สแกนหรือรูปถ่ายยังอ่านไม่ได้</p>
  </main>`;
}

async function ensureSubject() {
  const sel = document.getElementById('imp-subject');
  if (sel.value !== '__new') return sel.value;
  const name = document.getElementById('imp-newname').value.trim();
  if (!name) { toast('ใส่ชื่อวิชาใหม่ก่อน'); document.getElementById('imp-newname').focus(); return null; }
  const s = { id: 's' + newId(), name, created: Date.now() };
  await store.saveSubject(s);
  return s.id;
}

const modeValue = () => (document.querySelector('input[name=mode]:checked') || {}).value || 'auto';

function setStatus(html) {
  const el = document.getElementById('imp-status');
  if (el) el.innerHTML = html;
}

const libPromises = {};
function loadScript(url) {
  if (!libPromises[url]) libPromises[url] = new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = url; sc.onload = res; sc.onerror = () => { delete libPromises[url]; rej(new Error('load ' + url)); };
    document.head.appendChild(sc);
  });
  return libPromises[url];
}
function inlineLib(name) {
  const el = document.getElementById('lib-' + name);
  if (!el) return false;
  if (!el.dataset.done) {
    const sc = document.createElement('script');
    sc.textContent = el.textContent;
    document.head.appendChild(sc);
    el.dataset.done = '1';
  }
  return true;
}
async function ensureLib(kind) {
  const L = window.PREP_LIBS || {};
  if (document.getElementById('lib-pdf')) {
    if (kind === 'pdf') { inlineLib('pdf'); inlineLib('pdfworker'); }
    if (kind === 'docx') inlineLib('mammoth');
    if (kind === 'pptx') inlineLib('jszip');
    return;
  }
  try {
    if (kind === 'pdf' && !window.pdfjsLib) { await loadScript(L.pdf); await loadScript(L.pdfWorker); }
    if (kind === 'docx' && !window.mammoth) await loadScript(L.mammoth);
    if (kind === 'pptx' && !window.JSZip) await loadScript(L.jszip);
  } catch (e) { console.error(e); }
}

async function readFile(file, onProgress) {
  const kind = fileKind(file.name);
  if (file.size > MAX_BYTES) throw new Error(`ไฟล์ใหญ่ ${(file.size / 1048576).toFixed(1)} MB เกินขีดจำกัด 50 MB`);
  if (kind === 'old-doc') throw new Error('ไฟล์ Word แบบเก่า (.doc) ให้เปิดใน Word แล้วบันทึกเป็น .docx ก่อน');
  if (kind === 'old-ppt') throw new Error('ไฟล์ PowerPoint แบบเก่า (.ppt) ให้บันทึกเป็น .pptx ก่อน');
  if (kind === 'image') throw new Error('รูปภาพยังอ่านไม่ได้ในเวอร์ชันนี้ (ต้องใช้การแปลงภาพเป็นข้อความ)');
  if (kind === 'unknown') throw new Error('ยังไม่รองรับไฟล์ชนิดนี้ ใช้ PDF, .docx, .pptx หรือ .txt');
  if (kind === 'txt') return textToDoc(await file.text());
  await ensureLib(kind);
  const buf = await file.arrayBuffer();
  if (kind === 'pdf') {
    if (!window.pdfjsLib) throw new Error('โหลดตัวอ่าน PDF ไม่สำเร็จ ลองรีเฟรชหน้า');
    return readPdf(window.pdfjsLib, new Uint8Array(buf), onProgress);
  }
  if (kind === 'docx') {
    if (!window.mammoth) throw new Error('โหลดตัวอ่าน Word ไม่สำเร็จ ลองรีเฟรชหน้า');
    return readDocx(window.mammoth, html => { const d = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html'); return d.body; }, buf);
  }
  if (kind === 'pptx') {
    if (!window.JSZip) throw new Error('โหลดตัวอ่าน PowerPoint ไม่สำเร็จ ลองรีเฟรชหน้า');
    return readPptx(window.JSZip, s => new DOMParser().parseFromString(s, 'application/xml'), buf);
  }
}

async function handleFiles(files) {
  if (!files.length) return;
  const sid = await ensureSubject();
  if (!sid) return;
  const mode = modeValue();
  const errors = [];
  for (const [i, f] of [...files].entries()) {
    const label = files.length > 1 ? `(${i + 1}/${files.length}) ` : '';
    setStatus(`<span class="spin"></span> ${label}กำลังอ่าน ${esc(f.name)}…`);
    try {
      const doc = await readFile(f, (p, n) => setStatus(`<span class="spin"></span> ${label}กำลังอ่าน ${esc(f.name)} หน้า ${p}/${n}`));
      if (doc.scanned) throw new Error('ไฟล์นี้แทบไม่มีข้อความ น่าจะเป็นไฟล์สแกนหรือรูปภาพ ซึ่งยังอ่านไม่ได้ในเวอร์ชันนี้');
      const res = extractCards(doc, mode);
      draftQueue.push({ subjectId: sid, name: f.name.replace(/\.[^.]+$/, ''), source: f.name, cards: res.cards, stats: res.stats });
    } catch (e) {
      console.error(e);
      errors.push(`${f.name}: ${e.message || e}`);
    }
  }
  setStatus(errors.map(e => `<p class="err">${esc(e)}</p>`).join(''));
  if (draftQueue.length) nextDraft(); else if (!errors.length) setStatus('<p class="err">ไม่พบเนื้อหาที่ทำการ์ดได้</p>');
}

async function handleText() {
  const text = document.getElementById('imp-text').value;
  if (!text.trim()) { toast('วางข้อความก่อน'); return; }
  const sid = await ensureSubject();
  if (!sid) return;
  const res = extractCards(textToDoc(text), modeValue());
  draftQueue.push({ subjectId: sid, name: 'โน้ต ' + new Date().toLocaleDateString('th-TH'), source: 'ข้อความที่วาง', cards: res.cards, stats: res.stats });
  nextDraft();
}

function nextDraft() {
  const d = draftQueue.shift();
  if (!d) return;
  go('review', { draft: d, editing: false }, route.name !== 'review');
}

// ----- review / edit -----

function editorRows(pairs) {
  return pairs.map(([c, i]) => `<li class="ed ${c.flag ? 'flagged' : ''}" data-i="${i}">
    <div class="ed-head"><span class="kind">${TYPE_LABEL[c.type]}${c.context ? ` (${esc(c.context)})` : ''}</span>
      <button class="iconbtn sm" data-a="ed-del" data-i="${i}" aria-label="ลบการ์ดนี้">✕</button></div>
    <label class="sr">ด้านหน้า</label><textarea class="field" data-f="front" data-i="${i}" rows="${Math.min(6, Math.ceil(c.front.length / 38) + 1)}">${esc(c.front)}</textarea>
    ${c.type === 'mcq'
      ? `<ol class="opts">${c.options.map((o, k) => `<li class="${k === c.answer ? 'right' : ''}">${esc(o)}${k === c.answer ? ' ✓' : ''}</li>`).join('')}</ol>`
      : `<label class="sr">ด้านหลัง</label><textarea class="field back" data-f="back" data-i="${i}" rows="${Math.min(10, c.back.split('\n').length + Math.ceil(c.back.length / 40))}">${esc(c.back)}</textarea>`}
    ${c.flag ? `<em class="flag">${esc(c.flag)}</em>` : ''}
  </li>`).join('');
}

function viewReview() {
  const d = route.draft;
  const flagged = d.cards.filter(c => c.flag).length;
  const counts = {};
  d.cards.forEach(c => { counts[c.type] = (counts[c.type] || 0) + 1; });
  const s = subjectById(d.subjectId);
  const filter = route.filter || 'all';
  const shown = filter === 'flag' ? d.cards.map((c, i) => [c, i]).filter(([c]) => c.flag) : d.cards.map((c, i) => [c, i]);
  return `${topbar(route.editing ? 'แก้ไขการ์ด' : 'ตรวจการ์ดก่อนบันทึก', { sub: s ? s.name : '' })}
  <main class="review">
    <label class="lbl" for="rv-name">ชื่อชุดการ์ด</label>
    <input id="rv-name" class="field" value="${esc(d.name)}" maxlength="100">
    <p class="chips">${d.cards.length ? Object.entries(counts).map(([t, n]) => `<span class="chip">${TYPE_LABEL[t]} ${n}</span>`).join('') : ''}
      ${flagged ? `<span class="chip warn">ต้องแก้ ${flagged}</span>` : ''}
      ${d.stats && d.stats.skippedNoKey ? `<span class="chip">ข้ามข้อที่ไม่มีเฉลย ${d.stats.skippedNoKey}</span>` : ''}
      ${d.stats && d.stats.dupes ? `<span class="chip">รวมข้อซ้ำ ${d.stats.dupes}</span>` : ''}</p>
    ${!d.cards.length ? '<div class="empty"><p>ไม่พบเนื้อหาที่ทำการ์ดได้</p><p class="muted">แอปหาคู่ "คำ : ความหมาย", หัวข้อที่มีรายการย่อย และข้อสอบที่มีเฉลย ลองเลือกชนิดไฟล์ใหม่ หรือเพิ่มการ์ดเอง</p></div>' : ''}
    ${flagged ? `<div class="seg small" role="tablist"><button class="${filter === 'all' ? 'on' : ''}" data-a="rv-filter" data-v="all">ทั้งหมด ${d.cards.length}</button><button class="${filter === 'flag' ? 'on' : ''}" data-a="rv-filter" data-v="flag">ต้องแก้ ${flagged}</button></div>` : ''}
    <ol class="editor">${editorRows(shown)}</ol>
    <button class="btn ghost" data-a="ed-add">เพิ่มการ์ดเอง</button>
    <div class="savebar">
      ${route.editing ? '<button class="btn ghost" data-a="back">ยกเลิก</button>' : '<button class="btn ghost" data-a="rv-discard">ไม่บันทึก</button>'}
      <button class="btn primary" data-a="rv-save" ${d.cards.length ? '' : 'disabled'}>บันทึก ${d.cards.length} ใบ</button>
    </div>
  </main>`;
}

function onEditorInput(e) {
  const t = e.target;
  if (!t.dataset || t.dataset.f === undefined || route.name !== 'review') return;
  const c = route.draft.cards[+t.dataset.i];
  c[t.dataset.f] = t.value;
  if (c.flag && t.dataset.f === 'back' && !ALL_OF_ABOVE_RE.test(c.back)) {
    delete c.flag;
    const li = t.closest('li');
    li.classList.remove('flagged');
    const fl = li.querySelector('.flag');
    if (fl) fl.remove();
  }
}

async function saveDraft() {
  const d = route.draft;
  d.name = document.getElementById('rv-name').value.trim() || d.name;
  const cards = d.cards.map(c => ({ ...c, front: c.front.trim(), back: c.back.trim() })).filter(c => c.front && c.back);
  const btn = document.querySelector('[data-a="rv-save"]');
  if (btn) { btn.disabled = true; btn.textContent = 'กำลังบันทึก…'; }
  try {
    const deck = d.deckId ? { ...deckById(d.deckId), name: d.name } : { id: 'd' + newId(), subjectId: d.subjectId, name: d.name, source: d.source, created: Date.now() };
    await store.saveDeck(deck, cards);
    toast(`บันทึกแล้ว ${cards.length} ใบ`);
    if (draftQueue.length) { nextDraft(); return; }
    history = [{ name: 'home' }];
    route = { name: 'subject', id: d.subjectId };
    if (d.deckId) { history.push(route); route = { name: 'deck', id: d.deckId }; }
    render();
    window.scrollTo(0, 0);
  } catch (e) {
    console.error(e);
    if (btn) { btn.disabled = false; btn.textContent = `บันทึก ${cards.length} ใบ`; }
    toast(e && e.code === 'quota_exceeded' ? 'พื้นที่เก็บข้อมูลเต็ม ลบชุดที่ไม่ใช้แล้วลองใหม่' : 'บันทึกไม่สำเร็จ ลองอีกครั้ง');
  }
}

// ----- flashcards -----

function startFlash(deckIds, onlyUnknown, onlyIds = null) {
  const all = deckIds.flatMap(id => cardsOf(id).map(c => ({ ...c, deckId: id })));
  let pick = onlyUnknown ? all.filter(c => !(store.progressOf(c.deckId)[c.id] || {}).k) : all;
  if (onlyIds) pick = all.filter(c => onlyIds.includes(c.id));
  if (!pick.length) { toast('จำได้ครบทุกใบแล้ว'); return; }
  const byId = new Map(pick.map(c => [c.id, c]));
  session = { kind: 'flash', deckIds, byId, queue: shuffle(pick.map(c => c.id)), total: pick.length, known: 0, again: 0, flipped: false, onlyUnknown };
  go('flash', {}, route.name !== 'flash');
}

function viewFlashSetup() {
  const ids = route.deckIds;
  const all = ids.flatMap(cardsOf).length;
  const { known } = progressFor(ids);
  return `${topbar('ทบทวนแฟลชการ์ด', { sub: route.title })}
  <main><div class="stack">
    <button class="btn primary big" data-a="flash-go" data-v="unknown" ${all - known ? '' : 'disabled'}>เฉพาะใบที่ยังไม่จำ<small>${all - known} ใบ</small></button>
    <button class="btn ghost big" data-a="flash-go" data-v="all">ทุกใบ<small>${all} ใบ</small></button>
  </div>
  <p class="muted small">แตะการ์ดเพื่อดูคำตอบ ใบที่กด "ยังไม่ได้" จะกลับมาอีกในรอบเดียวกันจนกว่าจะจำได้ บนคอมใช้ Space พลิก, ← ยังไม่ได้, → จำได้</p></main>`;
}

function cardFace(c, flipped) {
  if (!flipped) return `<div class="face front"><span class="kind">${TYPE_LABEL[c.type]}${c.context ? ` (${esc(c.context)})` : ''}</span><p class="q">${nl(c.front)}</p><span class="hint">แตะเพื่อดูคำตอบ</span></div>`;
  let backHtml;
  if (c.type === 'mcq') backHtml = `<ol class="opts">${c.options.map((o, k) => `<li class="${k === c.answer ? 'right' : ''}">${esc(o)}</li>`).join('')}</ol>`;
  else if (c.type === 'list') backHtml = `<ul class="bul">${c.back.split('\n').map(l => `<li>${esc(l.replace(/^•\s*/, ''))}</li>`).join('')}</ul>`;
  else backHtml = `<p class="a">${nl(c.back)}</p>`;
  return `<div class="face back"><p class="q small">${nl(c.front)}</p>${backHtml}${c.flag ? `<em class="flag">${esc(c.flag)}</em>` : ''}</div>`;
}

function viewFlash() {
  const s = session;
  if (!s.queue.length) {
    return `${topbar('ทบทวนครบแล้ว')}<main class="done">
      <p class="bignum">${s.total}</p><p>ใบในรอบนี้ จำได้ครบแล้ว</p>
      <p class="muted">กด "ยังไม่ได้" ไปทั้งหมด ${s.again} ครั้ง</p>
      <div class="stack"><button class="btn primary" data-a="flash-again">ทบทวนอีกรอบ</button><button class="btn ghost" data-a="back">กลับ</button></div></main>`;
  }
  const c = s.byId.get(s.queue[0]);
  const left = s.queue.length;
  return `${topbar('แฟลชการ์ด', { sub: `เหลือ ${left} ใบ จำได้แล้ว ${s.known}` })}
  <main class="flash">
    <div class="meter thin"><span style="width:${Math.round(s.known / s.total * 100)}%"></span></div>
    <button class="card ${s.flipped ? 'is-back' : ''}" data-a="flip" aria-label="${s.flipped ? 'ด้านคำตอบ' : 'แตะเพื่อดูคำตอบ'}">${cardFace(c, s.flipped)}</button>
    <div class="answerbar">
      <button class="btn no" data-a="again" ${s.flipped ? '' : 'disabled'}>ยังไม่ได้</button>
      <button class="btn yes" data-a="known" ${s.flipped ? '' : 'disabled'}>จำได้</button>
    </div>
  </main>`;
}

function flashAnswer(known) {
  const s = session;
  if (!s || !s.flipped || !s.queue.length) return;
  const id = s.queue[0];
  const c = s.byId.get(id);
  if (known) { s.queue.shift(); s.known++; store.markCard(c.deckId, id, { known: true }); }
  else { s.queue = requeue(s.queue, id); s.again++; store.markCard(c.deckId, id, { known: false, wrong: true }); }
  s.flipped = false;
  render();
  if (!s.queue.length) store.flushProgress();
}

// ----- quiz -----

function viewQuizSetup() {
  const ids = route.deckIds;
  const n = ids.flatMap(cardsOf).filter(isQuizzable).length;
  const sizes = [10, 20, 50].filter(x => x < n);
  return `${topbar('ทำข้อสอบ', { sub: route.title })}
  <main><p class="muted">มีทั้งหมด ${n} ข้อ เลือกจำนวนข้อ</p><div class="stack">
    ${sizes.map(x => `<button class="btn ghost big" data-a="quiz-go" data-v="${x}">สุ่ม ${x} ข้อ</button>`).join('')}
    <button class="btn primary big" data-a="quiz-go" data-v="${n}">ทั้งหมด ${n} ข้อ</button>
  </div>
  <p class="muted small">ข้อสอบที่มีตัวเลือกครบใช้ตัวเลือกจริงจากไฟล์ ข้อที่มีแค่คำตอบ แอปจะใช้คำตอบของข้ออื่นในวิชาเดียวกันเป็นตัวเลือกหลอก</p></main>`;
}

function startQuiz(deckIds, n, onlyIds = null) {
  const all = deckIds.flatMap(id => cardsOf(id).map(c => ({ ...c, deckId: id }))).filter(isQuizzable);
  let pick = onlyIds ? all.filter(c => onlyIds.includes(c.id)) : shuffle(all).slice(0, n);
  if (onlyIds) pick = shuffle(pick);
  const questions = pick.map(c => ({ ...buildQuestion(c, all), deckId: c.deckId, card: c }));
  session = { kind: 'quiz', deckIds, questions, i: 0, chosen: null, right: 0, wrong: [] };
  go('quiz', { title: route.title }, route.name !== 'quiz');
}

// ----- mock exam (all subjects) -----

function viewMockSetup() {
  const subs = S.subjects.map(sb => ({ sb, n: decksOf(sb.id).flatMap(d => cardsOf(d.id)).filter(isQuizzable).length })).filter(x => x.n);
  const total = subs.reduce((a, x) => a + x.n, 0);
  const sel = route.sel || new Set(subs.map(x => x.sb.id));
  route.sel = sel;
  const n = route.n || Math.min(50, total);
  const mins = route.mins ?? 30;
  const chosenTotal = subs.filter(x => sel.has(x.sb.id)).reduce((a, x) => a + x.n, 0);
  return `${topbar('สอบจำลอง', { sub: 'สุ่มข้อสอบคละวิชา' })}
  <main>
    <h2 class="sec">วิชาที่สอบ</h2>
    <div class="checks">${subs.map(x => `<label class="check"><input type="checkbox" data-a="mock-sub" data-id="${x.sb.id}" ${sel.has(x.sb.id) ? 'checked' : ''}><span>${esc(x.sb.name)}</span><small>${x.n} ข้อ</small></label>`).join('')}</div>
    <h2 class="sec">จำนวนข้อ</h2>
    <div class="seg small">${[20, 50, 100].filter(v => v < chosenTotal).concat([chosenTotal]).map(v => `<button class="${v === Math.min(n, chosenTotal) ? 'on' : ''}" data-a="mock-n" data-v="${v}">${v === chosenTotal ? 'ทั้งหมด ' + v : v}</button>`).join('')}</div>
    <h2 class="sec">เวลา</h2>
    <div class="seg small">${[0, 15, 30, 60].map(v => `<button class="${v === mins ? 'on' : ''}" data-a="mock-min" data-v="${v}">${v ? v + ' นาที' : 'ไม่จับเวลา'}</button>`).join('')}</div>
    <div class="stack"><button class="btn primary big" data-a="mock-go" ${chosenTotal ? '' : 'disabled'}>เริ่มสอบ</button></div>
    <p class="muted small">แต่ละวิชาได้จำนวนข้อใกล้เคียงกัน ระหว่างสอบจะไม่เฉลยทันที เหมือนสอบจริง เฉลยและคะแนนแยกรายวิชาจะแสดงตอนจบ</p>
  </main>`;
}

function startMock(subjectIds, n, mins) {
  const bySub = subjectIds.map(sid => {
    const pool = decksOf(sid).flatMap(d => cardsOf(d.id).map(c => ({ ...c, deckId: d.id }))).filter(isQuizzable);
    return { sid, pool, queue: shuffle(pool) };
  }).filter(x => x.pool.length);
  const picked = [];
  // round-robin so every subject gets a fair share
  while (picked.length < n && bySub.some(x => x.queue.length)) {
    for (const x of bySub) { if (picked.length >= n) break; const c = x.queue.pop(); if (c) picked.push({ c, x }); }
  }
  const subName = id => (subjectById(id) || {}).name || '';
  const questions = shuffle(picked).map(({ c, x }) => ({ ...buildQuestion(c, x.pool), deckId: c.deckId, card: c, subject: subName(x.sid) }));
  clearInterval(window.__mockTimer);
  session = { kind: 'quiz', mock: { subjectIds, n, mins, deadline: mins ? Date.now() + mins * 60000 : 0 }, deckIds: subjectIds.flatMap(id => decksOf(id).map(d => d.id)), questions, i: 0, chosen: null, right: 0, wrong: [], answers: [] };
  if (mins) window.__mockTimer = setInterval(tickMock, 1000);
  go('quiz', { title: 'สอบจำลอง' }, route.name !== 'quiz');
}

function fmtLeft(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function tickMock() {
  const s = session;
  if (!s || !s.mock || !s.mock.deadline || route.name !== 'quiz') { clearInterval(window.__mockTimer); return; }
  const left = s.mock.deadline - Date.now();
  const el = document.getElementById('mock-timer');
  if (el) { el.textContent = 'เหลือเวลา ' + fmtLeft(left); el.classList.toggle('late', left < 60000); }
  if (left <= 0) { clearInterval(window.__mockTimer); s.timedOut = true; s.i = s.questions.length; store.flushProgress(); render(); }
}

function weakCards() {
  const out = [];
  for (const d of S.decks) {
    const p = store ? store.progressOf(d.id) : {};
    for (const c of cardsOf(d.id)) {
      const e = p[c.id];
      if (e && e.w > 0 && (e.w > (e.r || 0) || !e.k)) out.push({ ...c, deckId: d.id, w: e.w, r: e.r || 0 });
    }
  }
  return out.sort((a, b) => (b.w - b.r) - (a.w - a.r) || b.w - a.w);
}

function viewWeak() {
  const list = weakCards();
  const quizN = list.filter(isQuizzable).length;
  const deckName = id => (deckById(id) || {}).name || '';
  return `${topbar('ข้อที่ผิดบ่อย', { sub: `${list.length} ใบ จากประวัติการตอบ` })}
  <main>
    ${list.length ? `<div class="study">
      <button class="btn primary big" data-a="weak-flash">ทบทวนแฟลชการ์ด<small>${list.length} ใบ</small></button>
      <button class="btn accent big" data-a="weak-quiz" ${quizN ? '' : 'disabled'}>ทำข้อสอบ<small>${quizN} ข้อ</small></button>
    </div>
    <ol class="cardlist" style="margin-top:16px">${list.slice(0, 80).map(c => `<li><span class="kind">${esc(deckName(c.deckId))}: ผิด ${c.w} ครั้ง ถูก ${c.r} ครั้ง</span><b>${nl(c.front)}</b><span>${nl(c.back)}</span></li>`).join('')}</ol>`
    : '<div class="empty"><p>ยังไม่มีข้อที่ผิด</p><p class="muted">ทำข้อสอบหรือทบทวนแฟลชการ์ดก่อน ข้อที่ตอบผิดหรือกด "ยังไม่ได้" จะมารวมไว้ที่นี่</p></div>'}
  </main>`;
}

function mockBreakdown(s) {
  const by = new Map();
  for (const a of s.answers) {
    const e = by.get(a.subject) || { right: 0, total: 0 };
    e.total++; if (a.ok) e.right++;
    by.set(a.subject, e);
  }
  for (const q of s.questions.slice(s.answers.length)) { const e = by.get(q.subject) || { right: 0, total: 0 }; e.total++; by.set(q.subject, e); }
  const rows = [...by.entries()].map(([name, e]) => ({ name, ...e, pct: e.total ? Math.round(e.right / e.total * 100) : 0 })).sort((a, b) => a.pct - b.pct);
  return `<h2 class="sec">คะแนนรายวิชา (อ่อนสุดอยู่บน)</h2><div class="bars">${rows.map(r => `<div class="barrow"><span class="bname">${esc(r.name)}</span><span class="bval">${r.right}/${r.total} (${r.pct}%)</span><div class="meter ${r.pct < 60 ? 'low' : ''}"><span style="width:${r.pct}%"></span></div></div>`).join('')}</div>`;
}

function viewQuiz() {
  const s = session;
  if (s.i >= s.questions.length) {
    clearInterval(window.__mockTimer);
    const n = s.questions.length;
    const pct = n ? Math.round(s.right / n * 100) : 0;
    return `${topbar(s.mock ? 'ผลสอบจำลอง' : 'ผลการทำข้อสอบ')}<main class="done">
      <p class="bignum">${s.right}<span>/${n}</span></p><p>ถูก ${pct}%${s.timedOut ? ' (หมดเวลา ข้อที่ไม่ได้ทำนับเป็นผิด)' : ''}</p>
      ${s.mock ? mockBreakdown(s) : ''}
      ${s.wrong.length ? `<h2 class="sec">ข้อที่ตอบผิด</h2><ol class="cardlist">${s.wrong.map(q => `<li><b>${nl(q.prompt)}</b><span>คำตอบ: ${esc(q.options[q.answer])}</span><span class="muted">คุณตอบ: ${esc(q.options[q.picked])}</span></li>`).join('')}</ol>` : '<p>ถูกทุกข้อ</p>'}
      <div class="stack">
        ${s.wrong.length ? `<button class="btn primary" data-a="quiz-wrong">ทำเฉพาะข้อที่ผิด (${s.wrong.length})</button>` : ''}
        <button class="btn ghost" data-a="quiz-new">สุ่มชุดใหม่</button>
        <button class="btn ghost" data-a="back">กลับ</button>
      </div></main>`;
  }
  const q = s.questions[s.i];
  const answered = s.chosen !== null;
  const sub = s.mock ? `ข้อ ${s.i + 1} จาก ${s.questions.length}` : `ข้อ ${s.i + 1} จาก ${s.questions.length} ถูก ${s.right}`;
  return `${topbar(s.mock ? 'สอบจำลอง' : 'ทำข้อสอบ', { sub })}
  <main class="quiz">
    ${s.mock && s.mock.deadline ? `<p class="timer" id="mock-timer">เหลือเวลา ${fmtLeft(s.mock.deadline - Date.now())}</p>` : ''}
    ${s.mock ? `<button class="btn ghost small-btn" data-a="mock-end">ส่งข้อสอบตอนนี้</button>` : ''}
    <div class="meter thin"><span style="width:${Math.round(s.i / s.questions.length * 100)}%"></span></div>
    <div class="qcard">${q.subject ? `<span class="kind">${esc(q.subject)}</span>` : ''}${q.context ? `<span class="kind">${esc(q.context)}</span>` : ''}<p class="q">${nl(q.prompt)}</p></div>
    <ol class="choices">${q.options.map((o, k) => {
      let cls = '';
      if (answered) { if (k === q.answer) cls = 'right'; else if (k === s.chosen) cls = 'wrong'; else cls = 'dim'; }
      return `<li><button class="choice ${cls}" data-a="choose" data-k="${k}" ${answered ? 'disabled' : ''}><span class="letter">${'กขคงจฉ'[k]}</span><span>${esc(o)}</span></button></li>`;
    }).join('')}</ol>
    ${answered ? `<div class="answerbar"><p class="verdict ${s.chosen === q.answer ? 'ok' : 'bad'}">${s.chosen === q.answer ? 'ถูกต้อง' : 'ยังไม่ถูก คำตอบคือ ' + esc(q.options[q.answer])}</p><button class="btn primary" data-a="quiz-next">${s.i + 1 < s.questions.length ? 'ข้อถัดไป' : 'ดูผล'}</button></div>` : ''}
  </main>`;
}

function choose(k) {
  const s = session;
  if (!s || s.chosen !== null) return;
  const q = s.questions[s.i];
  s.chosen = k;
  const ok = k === q.answer;
  if (ok) { s.right++; store.markCard(q.deckId, q.cardId, { right: true }); }
  else { s.wrong.push({ ...q, picked: k }); store.markCard(q.deckId, q.cardId, { wrong: true, known: false }); }
  if (s.answers) s.answers.push({ subject: q.subject, ok });
  if (s.mock) { s.i++; s.chosen = null; if (s.i >= s.questions.length) store.flushProgress(); render(); window.scrollTo(0, 0); return; }
  render();
}

// ---------- render & events ----------

function render() {
  const views = { home: viewHome, subject: viewSubject, deck: viewDeck, import: viewImport, review: viewReview, flashSetup: viewFlashSetup, flash: viewFlash, quizSetup: viewQuizSetup, quiz: viewQuiz, mockSetup: viewMockSetup, weak: viewWeak };
  if ((route.name === 'flash' || route.name === 'quiz') && !session) route = { name: 'home' };
  $app.innerHTML = (views[route.name] || viewHome)();
  if (route.name === 'import') bindImport();
}

function bindImport() {
  const sel = document.getElementById('imp-subject');
  const nn = document.getElementById('imp-newname');
  sel.addEventListener('change', () => { nn.classList.toggle('hide', sel.value !== '__new'); if (sel.value === '__new') nn.focus(); });
  const fi = document.getElementById('imp-file');
  fi.addEventListener('change', () => { handleFiles(fi.files); });
  const drop = document.getElementById('drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); handleFiles(e.dataTransfer.files); });
}

function scopeFromRoute() {
  if (route.name === 'deck') { const d = deckById(route.id); return { deckIds: [d.id], title: d.name }; }
  if (route.name === 'subject') { const s = subjectById(route.id); return { deckIds: decksOf(s.id).map(d => d.id), title: s.name }; }
  return { deckIds: route.deckIds, title: route.title };
}

$app.addEventListener('click', async e => {
  const el = e.target.closest('[data-a]');
  if (!el || el.disabled) return;
  const a = el.dataset.a;
  switch (a) {
    case 'back': back(); break;
    case 'home': history = []; go('home', {}, false); break;
    case 'open-subject': go('subject', { id: el.dataset.id }); break;
    case 'open-deck': go('deck', { id: el.dataset.id }); break;
    case 'import': go('import', { sid: el.dataset.sid || (S.subjects[S.subjects.length - 1] || {}).id }); break;
    case 'import-text': handleText(); break;
    case 'download-offline': downloadOffline(el); break;
    case 'import-data': {
      const fi = document.getElementById('data-file');
      fi.onchange = () => { if (fi.files[0]) importData(fi.files[0]); fi.value = ''; };
      fi.click();
      break;
    }
    case 'new-subject': {
      const name = await dialog({ title: 'เพิ่มวิชา', input: '', confirm: 'เพิ่ม' });
      if (name) { const s = { id: 's' + newId(), name, created: Date.now() }; await store.saveSubject(s); go('subject', { id: s.id }); }
      break;
    }
    case 'rename-subject': {
      const s = subjectById(route.id);
      const name = await dialog({ title: 'เปลี่ยนชื่อวิชา', input: s.name, confirm: 'บันทึก' });
      if (name) await store.saveSubject({ ...s, name });
      break;
    }
    case 'delete-subject': {
      const s = subjectById(route.id);
      const n = decksOf(s.id).length;
      if (await dialog({ title: `ลบวิชา "${s.name}"`, body: n ? `ชุดการ์ด ${n} ชุดในวิชานี้จะถูกลบด้วย` : '', confirm: 'ลบวิชา', danger: true })) {
        await store.deleteSubject(s.id); history = []; go('home', {}, false); toast('ลบวิชาแล้ว');
      }
      break;
    }
    case 'delete-deck': {
      const d = deckById(route.id);
      if (await dialog({ title: `ลบชุด "${d.name}"`, body: `การ์ด ${cardsOf(d.id).length} ใบจะถูกลบ`, confirm: 'ลบชุดนี้', danger: true })) {
        await store.deleteDeck(d.id); back(); toast('ลบชุดการ์ดแล้ว');
      }
      break;
    }
    case 'reset-progress': {
      const d = deckById(route.id);
      if (await dialog({ title: 'เริ่มนับใหม่', body: 'ทุกใบในชุดนี้จะกลับเป็น "ยังไม่จำ"', confirm: 'เริ่มนับใหม่' })) { await store.resetProgress([d.id]); render(); }
      break;
    }
    case 'edit-deck': {
      const d = deckById(route.id);
      go('review', { draft: { deckId: d.id, subjectId: d.subjectId, name: d.name, source: d.source, cards: cardsOf(d.id).map(c => ({ ...c })), stats: null }, editing: true });
      break;
    }
    case 'rv-filter': route.filter = el.dataset.v; render(); break;
    case 'ed-del': route.draft.cards.splice(+el.dataset.i, 1); render(); break;
    case 'ed-add': route.draft.cards.push({ id: newId(), type: 'term', front: '', back: '', context: 'เพิ่มเอง' }); route.filter = 'all'; render(); {
      const t = document.querySelectorAll('.editor textarea[data-f="front"]'); if (t.length) { t[t.length - 1].focus(); }
    } break;
    case 'rv-save': saveDraft(); break;
    case 'rv-discard':
      if (await dialog({ title: 'ไม่บันทึกชุดนี้', body: 'การ์ดที่ดึงมาจากไฟล์นี้จะหายไป', confirm: 'ไม่บันทึก', danger: true })) {
        if (draftQueue.length) nextDraft(); else back();
      }
      break;
    case 'flash': { const sc = scopeFromRoute(); go('flashSetup', sc); break; }
    case 'flash-go': startFlash(route.deckIds, el.dataset.v === 'unknown'); break;
    case 'flash-again': startFlash(session.deckIds, false); break;
    case 'flip': session.flipped = !session.flipped; render(); break;
    case 'again': flashAnswer(false); break;
    case 'known': flashAnswer(true); break;
    case 'quiz': { const sc = scopeFromRoute(); go('quizSetup', sc); break; }
    case 'quiz-go': startQuiz(route.deckIds, +el.dataset.v); break;
    case 'choose': choose(+el.dataset.k); break;
    case 'quiz-next': session.i++; session.chosen = null; render(); window.scrollTo(0, 0); if (session.i >= session.questions.length) store.flushProgress(); break;
    case 'quiz-wrong': { const s = session; startQuiz(s.deckIds, 0, s.wrong.map(q => q.cardId)); break; }
    case 'quiz-new': { const s = session; if (s.mock) startMock(s.mock.subjectIds, s.mock.n, s.mock.mins); else startQuiz(s.deckIds, s.questions.length); break; }
    case 'mock-setup': go('mockSetup', {}); break;
    case 'mock-end': if (await dialog({ title: 'ส่งข้อสอบตอนนี้', body: 'ข้อที่ยังไม่ได้ทำจะนับเป็นผิด', confirm: 'ส่งข้อสอบ' })) { clearInterval(window.__mockTimer); session.i = session.questions.length; store.flushProgress(); render(); } break;
    case 'mock-sub': { const id = el.dataset.id; if (el.checked) route.sel.add(id); else route.sel.delete(id); route.n = 0; render(); break; }
    case 'mock-n': route.n = +el.dataset.v; render(); break;
    case 'mock-min': route.mins = +el.dataset.v; render(); break;
    case 'mock-go': { const total = [...route.sel].reduce((a, id) => a + decksOf(id).flatMap(d => cardsOf(d.id)).filter(isQuizzable).length, 0); startMock([...route.sel], Math.min(route.n || Math.min(50, total), total), route.mins ?? 30); break; }
    case 'weak': go('weak', {}); break;
    case 'weak-flash': { const l = weakCards(); startFlash([...new Set(l.map(c => c.deckId))], false, l.map(c => c.id)); break; }
    case 'weak-quiz': { const l = weakCards().filter(isQuizzable); startQuiz([...new Set(l.map(c => c.deckId))], 0, l.map(c => c.id)); break; }
  }
});

$app.addEventListener('input', onEditorInput);

document.addEventListener('keydown', e => {
  if (e.target.matches && e.target.matches('input, textarea, select')) return;
  if (document.querySelector('.modal')) return;
  if (route.name === 'flash' && session && session.queue.length) {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); session.flipped = !session.flipped; render(); }
    else if (e.key === 'ArrowLeft' || e.key === '1') flashAnswer(false);
    else if (e.key === 'ArrowRight' || e.key === '2') flashAnswer(true);
  } else if (route.name === 'quiz' && session && session.i < session.questions.length) {
    const k = '1234'.indexOf(e.key);
    if (session.chosen === null && k >= 0 && k < session.questions[session.i].options.length) choose(k);
    else if (session.chosen !== null && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); document.querySelector('[data-a="quiz-next"]').click(); }
  }
});

window.addEventListener('pagehide', () => store && store.flushProgress());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && store) store.flushProgress(); });

// ---------- boot ----------

render();
(async () => {
  let seed = null;
  const seedEl = document.getElementById('prep-data');
  if (seedEl) { try { seed = JSON.parse(seedEl.textContent); } catch (e) { console.warn('bad embedded data', e); } }
  store = await openStore((state, meta) => {
    S = state;
    loaded = true;
    if (meta && meta.error) syncNote = 'เชื่อมต่อที่เก็บข้อมูลไม่ได้ชั่วคราว การเปลี่ยนแปลงล่าสุดอาจยังไม่ถูกบันทึก';
    // don't wipe the screen while someone is typing in the editor or studying
    if (['review', 'flash', 'quiz', 'import'].includes(route.name)) return;
    render();
  }, { offline: MODE !== 'artifact', seed });
  if (MODE !== 'artifact') syncNote = 'ฉบับออฟไลน์: ข้อมูลบันทึกในเครื่องนี้';
  else if (store.mode === 'local') syncNote = 'ตอนนี้บันทึกไว้ในเบราว์เซอร์เครื่องนี้เท่านั้น';
  if (MODE === 'pwa' && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('sw', e));
  }
  render();
})();
