// Study logic: flashcard queue and multiple-choice questions built only from the user's cards.

import { keyOf, hasDigit } from './normalize.js';
import { ALL_OF_ABOVE_RE } from './extract.js';

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Flashcards: "ยังไม่ได้" puts the card back a few places later in the same round.
export function requeue(queue, id) {
  const q = queue.filter(x => x !== id);
  const at = Math.min(q.length, 3 + Math.floor(Math.random() * 3));
  q.splice(at, 0, id);
  return q;
}

export function isQuizzable(card) {
  if (card.type === 'mcq') return Array.isArray(card.options) && card.options.length >= 2;
  if (card.type === 'qa' || card.type === 'term') return !card.flag && !ALL_OF_ABOVE_RE.test(card.back) && card.back.length <= 300;
  return false;
}

function pickDistractors(correct, candidates, n = 3) {
  const ck = keyOf(correct);
  const num = hasDigit(correct);
  const seen = new Set([ck]);
  const scored = [];
  for (const c of candidates) {
    const k = keyOf(c);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const score = Math.abs(c.length - correct.length) + (hasDigit(c) === num ? 0 : 1000) + Math.random() * (correct.length * 0.5 + 10);
    scored.push({ c, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, n).map(s => s.c);
}

// pool: all quizzable cards in the current scope (deck or subject)
export function buildQuestion(card, pool) {
  if (card.type === 'mcq') {
    const order = shuffle(card.options.map((t, i) => i));
    return { cardId: card.id, prompt: card.front, context: card.context || '', options: order.map(i => card.options[i]), answer: order.indexOf(card.answer) };
  }
  let prompt = card.front, correct = card.back, cands;
  const others = pool.filter(c => c.id !== card.id);
  if (card.type === 'term' && card.back.length > 60 && card.back.length > card.front.length * 2) {
    // long definition → show the definition, choose the term
    prompt = card.back;
    correct = card.front;
    cands = others.filter(c => c.type === 'term').map(c => c.front);
  } else {
    cands = others.filter(c => c.type === card.type || (card.type === 'qa' && c.type === 'mcq')).map(c => c.back);
    if (cands.length < 3) cands = cands.concat(others.map(c => c.back));
  }
  const options = shuffle([correct, ...pickDistractors(correct, cands)]);
  return {
    cardId: card.id,
    prompt,
    context: card.type === 'term' && prompt === card.back ? 'คำนี้คืออะไร' : (card.context || ''),
    options,
    answer: options.indexOf(correct),
  };
}
