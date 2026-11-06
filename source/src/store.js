// Storage: the artifact's database (private per user, synced across devices) with a localStorage fallback.
//
// Every record is one document in a flat map keyed by id:
//   subject  { kind:'subject', name, created }
//   deck     { kind:'deck', subjectId, name, source, created, chunks, count }
//   chunk    { kind:'chunk', deckId, n, cards:[...] }        id: c_<deckId>_<n>
//   progress { kind:'progress', deckId, c:{ cardId:{k,r,w} } } id: p_<deckId>

const LS_KEY = 'prepcards:v1';
const CHUNK_BYTES = 180000;
const enc = new TextEncoder();

function withTimeout(p, ms) {
  return Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);
}

async function remoteBackend() {
  if (!window.claude || typeof window.claude.use !== 'function') return null;
  try {
    const [db, user] = await withTimeout(Promise.all([window.claude.use('db'), window.claude.use('user')]), 10000) || [];
    if (!db || !user) return null;
    const uid = await withTimeout(user.id(), 8000);
    if (!uid) return null;
    const col = db.collection('data/users/' + uid);
    const chains = new Map();
    const serial = (id, fn) => {
      const next = (chains.get(id) || Promise.resolve()).catch(() => {}).then(fn);
      chains.set(id, next);
      return next;
    };
    return {
      mode: 'cloud',
      subscribe(onDocs, onError) {
        return col.onSnapshot(snap => {
          const docs = new Map();
          for (const d of snap.docs) if (d.exists) docs.set(d.id, d.data());
          onDocs(docs, snap.metadata);
        }, onError);
      },
      set: (id, data) => serial(id, () => col.doc(id).set(data)),
      del: id => serial(id, () => col.doc(id).delete()),
    };
  } catch (e) {
    console.warn('db unavailable', e);
    return null;
  }
}

function localBackend() {
  let docs = new Map();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) docs = new Map(Object.entries(JSON.parse(raw)));
  } catch (e) { /* storage blocked */ }
  let listener = null;
  let ok = true;
  const persist = () => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(Object.fromEntries(docs))); }
    catch (e) { ok = false; }
  };
  const emit = () => listener && listener(new Map(docs), { fromCache: false });
  return {
    mode: 'local',
    get persistent() { return ok; },
    subscribe(onDocs) { listener = onDocs; setTimeout(emit, 0); return () => { listener = null; }; },
    async set(id, data) { docs.set(id, JSON.parse(JSON.stringify(data))); persist(); emit(); },
    async del(id) { docs.delete(id); persist(); emit(); },
  };
}

const SEED_KEY = 'prepcards:seed';

export async function openStore(onChange, { offline = false, seed = null } = {}) {
  let backend = offline ? null : await remoteBackend();
  if (!backend) backend = localBackend();
  let docs = new Map();
  const state = () => assemble(docs);
  const unsub = backend.subscribe((d, meta) => { docs = d; onChange(state(), meta); }, err => {
    console.warn('db error', err);
    onChange(state(), { error: err && err.code });
  });

  const progressTimers = new Map();
  const pendingProgress = new Map();

  const api = {
    mode: backend.mode,
    state,
    async saveSubject(subject) {
      await backend.set(subject.id, { kind: 'subject', name: subject.name, created: subject.created || Date.now() });
    },
    async deleteSubject(subjectId) {
      const st = state();
      for (const d of st.decks.filter(d => d.subjectId === subjectId)) await api.deleteDeck(d.id);
      await backend.del(subjectId);
    },
    async saveDeck(deck, cards) {
      const chunks = [];
      let cur = [], size = 0;
      for (const c of cards) {
        const b = enc.encode(JSON.stringify(c)).length + 1;
        if (cur.length && size + b > CHUNK_BYTES) { chunks.push(cur); cur = []; size = 0; }
        cur.push(c); size += b;
      }
      chunks.push(cur);
      const old = docs.get(deck.id);
      const oldChunks = old ? old.chunks || 0 : 0;
      for (let n = 0; n < chunks.length; n++) await backend.set(`c_${deck.id}_${n}`, { kind: 'chunk', deckId: deck.id, n, cards: chunks[n] });
      for (let n = chunks.length; n < oldChunks; n++) await backend.del(`c_${deck.id}_${n}`);
      await backend.set(deck.id, {
        kind: 'deck', subjectId: deck.subjectId, name: deck.name, source: deck.source || '',
        created: deck.created || Date.now(), chunks: chunks.length, count: cards.length,
      });
    },
    async deleteDeck(deckId) {
      const d = docs.get(deckId);
      const n = d ? d.chunks || 1 : 1;
      await backend.del(deckId);
      for (let i = 0; i < n; i++) await backend.del(`c_${deckId}_${i}`);
      await backend.del('p_' + deckId);
    },
    // progress updates are coalesced: one write per deck per pause
    markCard(deckId, cardId, change) {
      const base = pendingProgress.get(deckId) || JSON.parse(JSON.stringify((docs.get('p_' + deckId) || {}).c || {}));
      const e = base[cardId] || { k: 0, r: 0, w: 0 };
      if (change.known !== undefined) e.k = change.known ? 1 : 0;
      if (change.right) e.r = (e.r || 0) + 1;
      if (change.wrong) e.w = (e.w || 0) + 1;
      base[cardId] = e;
      pendingProgress.set(deckId, base);
      clearTimeout(progressTimers.get(deckId));
      progressTimers.set(deckId, setTimeout(() => api.flushProgress(deckId), 1500));
    },
    progressOf(deckId) {
      return pendingProgress.get(deckId) || ((docs.get('p_' + deckId) || {}).c) || {};
    },
    async flushProgress(deckId) {
      const ids = deckId ? [deckId] : [...pendingProgress.keys()];
      for (const id of ids) {
        const c = pendingProgress.get(id);
        if (!c) continue;
        pendingProgress.delete(id);
        clearTimeout(progressTimers.get(id));
        try { await backend.set('p_' + id, { kind: 'progress', deckId: id, c }); }
        catch (e) { console.warn('progress save failed', e); }
      }
    },
    async resetProgress(deckIds) {
      for (const id of deckIds) { pendingProgress.delete(id); await backend.del('p_' + id); }
    },
    // whole-library backup: used for the offline file and for moving data between copies
    async exportAll() {
      await api.flushProgress();
      return { app: 'prepcards', v: 1, exportedAt: Date.now(), docs: Object.fromEntries(docs) };
    },
    async importAll(payload) {
      if (!payload || payload.app !== 'prepcards' || !payload.docs) throw new Error('ไม่ใช่ไฟล์ข้อมูลของแอปนี้');
      const entries = Object.entries(payload.docs);
      const order = { subject: 0, chunk: 1, deck: 2, progress: 3 };
      entries.sort((a, b) => (order[a[1].kind] ?? 9) - (order[b[1].kind] ?? 9));
      let decks = 0;
      for (const [id, d] of entries) {
        if (!d || !order.hasOwnProperty(d.kind)) continue;
        if (d.kind === 'progress') {
          const mine = (docs.get(id) || {}).c || {};
          await backend.set(id, { kind: 'progress', deckId: d.deckId, c: { ...mine, ...(d.c || {}) } });
        } else {
          await backend.set(id, d);
          if (d.kind === 'deck') decks++;
        }
      }
      return { decks };
    },
    close: unsub,
  };
  if (backend.mode === 'local' && seed && seed.exportedAt) {
    let had = null;
    try { had = localStorage.getItem(SEED_KEY); } catch (e) { /* ignore */ }
    if (had !== String(seed.exportedAt)) {
      await api.importAll(seed);
      try { localStorage.setItem(SEED_KEY, String(seed.exportedAt)); } catch (e) { /* ignore */ }
    }
  }
  return api;
}

function assemble(docs) {
  const subjects = [], decks = [], chunks = new Map(), progress = new Map();
  for (const [id, d] of docs) {
    if (d.kind === 'subject') subjects.push({ id, ...d });
    else if (d.kind === 'deck') decks.push({ id, ...d });
    else if (d.kind === 'chunk') { if (!chunks.has(d.deckId)) chunks.set(d.deckId, []); chunks.get(d.deckId).push(d); }
    else if (d.kind === 'progress') progress.set(d.deckId, d.c || {});
  }
  subjects.sort((a, b) => (a.created || 0) - (b.created || 0));
  decks.sort((a, b) => (a.created || 0) - (b.created || 0));
  const cards = new Map();
  for (const dk of decks) {
    const parts = (chunks.get(dk.id) || []).filter(c => c.n < (dk.chunks || 1)).sort((a, b) => a.n - b.n);
    cards.set(dk.id, parts.flatMap(p => p.cards || []));
  }
  return { subjects, decks, cards, progress };
}
