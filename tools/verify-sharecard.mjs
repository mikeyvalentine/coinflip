// tools/verify-sharecard.mjs
// ---------------------------------------------------------------------------
// The share card is the only artefact of this game that leaves the game. It
// gets pasted into a chat where nobody can see the board that produced it, so
// anything wrong on it is wrong in public and uncorrectable.
//
// What this is here to prove, in order of how much it matters:
//
//   1. A HALF-FLIP NEVER REACHES A PLAYER. The internal spin unit is half-flips
//      (8..40); the player-facing unit is rotations = half-flips / 2. The old
//      card printed "9 spins", which was the internal number under the internal
//      name. Section (1) sweeps every spin value for it.
//   2. The reserved cardinal names/arrows mean what they claim. A straight
//      arrow must mean an exact 90-degree multiple — 1 of 9000 orientations —
//      and never "roughly northish".
//   3. The glyph count matches the bet the settlement actually resolves. SPREAD
//      settles per call; RIDE lands whole or not at all. Three glyphs on a RIDE
//      would advertise a partial result that cannot exist.
//   4. The columns layout is honest about where it works. Section (6) MEASURES
//      the proportional-font drift instead of asserting the choice was fine.
//
// Run: node tools/verify-sharecard.mjs
// ---------------------------------------------------------------------------

import {
  buildShareCard, buildRecoveryCard, describeBet, arrowFor, arrowsForPicks,
  multStr, strWidth, MARK, QUAD_ARROW, CARD_ARROW,
} from '../shareCard.js';
import {
  SPIN_VALUES, toRotations, QUADRANTS, CARDINALS, exactCardinal, roundOrientation,
} from '../flip3d/contract.js';

let failures = 0;
const fail = (m, x) => { failures++; console.log('  FAIL', m, x ? JSON.stringify(x) : ''); };
const ok = (c, m, x) => { if (!c) fail(m, x); return c; };

const spread = (bets, extra = {}) => ({
  before: 100, after: 256, mode: 'spread', daringness: 0.5, bets, ...extra,
});
const ride = (bets, extra = {}) => ({
  before: 100, after: 12800, mode: 'ride', daringness: 0.5, bets, ...extra,
});
/** The body lines — everything between the money line and the nerve meter. */
const bodyOf = (card) => card.split('\n').slice(3, -3).filter((l) => l.trim().length);

// ===========================================================================
console.log('=== (1) A HALF-FLIP NEVER REACHES THE CARD ===');
{
  // The rule the old card broke, and the one the user cares about most. Swept
  // over EVERY spin value rather than a sample, because the failure is a single
  // wrong number on a single outcome and a sample is exactly how that survives.
  let bad = 0; const examples = [];
  for (const hf of SPIN_VALUES) {
    const rot = toRotations(hf);
    for (const lineMode of ['exact', 'gt', 'lt']) {
      const d = describeBet({ kind: 'spins', line: rot, lineMode, won: true });
      // the label must carry the ROTATION to one decimal, and nothing else numeric
      const nums = d.label.match(/[\d.]+/g) ?? [];
      const okLabel = nums.length === 1 && nums[0] === rot.toFixed(1);
      if (!okLabel) { bad++; if (examples.length < 3) examples.push({ hf, rot, label: d.label }); }
      // and the half-flip integer must never appear as a standalone token
      if (new RegExp(`(^|\\D)${hf}(\\D|$)`).test(d.label) && hf !== Number(rot.toFixed(1))) {
        bad++; if (examples.length < 3) examples.push({ hf, leaked: d.label });
      }
    }
  }
  ok(bad === 0, 'a half-flip value reached a card label', { bad, examples });
  console.log(`  ${SPIN_VALUES.length} spin values x 3 line modes: every label is the ROTATION, one decimal`);

  // the internal WORD is as forbidden as the internal number
  let wordy = 0;
  for (const hf of SPIN_VALUES) {
    const card = buildShareCard(spread([
      { kind: 'spins', line: toRotations(hf), lineMode: 'exact', won: true },
    ]));
    if (/\bspins?\b|half.?flip/i.test(card)) wordy++;
  }
  ok(wordy === 0, 'a card said "spin" or "half-flip"', { wordy });
  console.log('  no card contains the word "spin" or "half-flip" — the unit is never named');

  // rotations are 4.0..20.0 in half steps, median 12 unattainable
  const rots = SPIN_VALUES.map(toRotations);
  ok(Math.min(...rots) === 4 && Math.max(...rots) === 20 && !rots.includes(12),
    'the rotation ladder is not 4..20 with 12 excluded');
  console.log(`  rotation ladder ${Math.min(...rots)}..${Math.max(...rots)}, 12 unattainable, ${rots.length} values`);
}

// ===========================================================================
console.log('\n=== (2) the reserved cardinals stay reserved ===');
{
  // Quadrant picks must render as DIAGONALS. A straight arrow is the reserved
  // signal for an exact 90-degree multiple, so if one shows up on an ordinary
  // bucket the reservation is worthless.
  const straight = new Set(Object.values(CARD_ARROW));
  let leaked = 0;
  for (const q of QUADRANTS) {
    const a = arrowFor(q);
    if (straight.has(a)) { leaked++; fail('a bucket renders as a straight arrow', { q, a }); }
  }
  ok(leaked === 0, 'a quadrant used a reserved cardinal arrow');
  console.log(`  buckets -> ${QUADRANTS.map((q) => q + ' ' + arrowFor(q)).join('  ')}`);
  console.log(`  reserved -> ${CARDINALS.map((c) => c + ' ' + arrowFor(c)).join('  ')}`);

  // and exactCardinal must be as rare as the reservation claims
  let hits = 0;
  for (let i = 0; i < 36000; i++) if (exactCardinal(i / 100)) hits++;
  ok(hits === 4, 'exactCardinal does not fire on exactly 4 of 36000 orientations', { hits });
  console.log(`  exactCardinal fires on ${hits} of 36000 orientations — 1 per bucket edge`);

  // no card ever prints a bare single-letter compass name
  let named = 0;
  for (const qs of [['NE'], ['SE', 'SW'], ['NE', 'SE', 'SW'], QUADRANTS]) {
    const card = buildShareCard(spread([{ kind: 'orient', quadrants: qs, won: true }]));
    for (const line of bodyOf(card)) {
      if (/(^|[^A-Za-z])[NESW]([^A-Za-z]|$)/.test(line)) { named++; fail('a bare cardinal name appeared', { qs, line }); }
    }
  }
  ok(named === 0, 'a card printed a bare cardinal name');
  console.log('  no card prints a bare N/E/S/W — orientation is arrows only');

  // multi-quadrant picks render in compass order, one arrow each
  const rows = [];
  for (const qs of [['NE'], ['NE', 'SE'], ['SE', 'SW', 'NW'], ['NW', 'NE']]) {
    const s = arrowsForPicks(qs);
    rows.push({ picks: qs.join(','), arrows: s, count: [...s].length });
    ok([...s].length === qs.length, 'arrow count does not match the picks', { qs, s });
  }
  console.table(rows);
  ok(arrowsForPicks(['NW', 'NE']) === arrowsForPicks(['NE', 'NW']),
    'arrow order depends on the order the picks were listed');
  console.log('  order is compass order, not click order — the same bet renders identically');
}

// ===========================================================================
console.log('\n=== (3) the glyph count matches what the settlement resolves ===');
{
  const glyphsIn = (card) => {
    const marks = Object.values(MARK);
    return bodyOf(card).join('').split('').filter(() => false).length
      || [...bodyOf(card).join('')].reduce((n, ch) => n + (marks.includes(ch) ? 1 : 0), 0);
  };
  const countMarks = (card) => {
    let n = 0;
    for (const m of Object.values(MARK)) n += (card.split(m).length - 1);
    return n;
  };

  const rows = [];
  for (const nBets of [1, 2, 3]) {
    const bets = [
      { kind: 'side', pick: 'Heads', won: true },
      { kind: 'orient', quadrants: ['NE'], won: false },
      { kind: 'spins', line: 10, lineMode: 'exact', won: true },
    ].slice(0, nBets);
    const sCard = buildShareCard(spread(bets));
    const rCard = buildShareCard(ride(bets));
    const sN = countMarks(sCard); const rN = countMarks(rCard);
    rows.push({ bets: nBets, 'SPREAD glyphs': sN, 'RIDE glyphs': rN });
    ok(sN === nBets, 'SPREAD did not mark every call', { nBets, sN });
    ok(rN === 1, 'RIDE marked more than the one compound call', { nBets, rN });
  }
  console.table(rows);
  console.log('  SPREAD settles per call, so one glyph each. RIDE lands whole or');
  console.log('  not at all, so ONE glyph — three would advertise a partial result');
  console.log('  the settlement cannot produce.');

  // a RIDE with one losing leg is a miss overall, however many legs won
  const partial = buildShareCard(ride([
    { kind: 'side', pick: 'Heads', won: true },
    { kind: 'spins', line: 16, lineMode: 'gt', won: false },
  ], { after: 0 }));
  ok(partial.includes(MARK.miss) && !partial.includes(MARK.exact),
    'a RIDE with a losing leg did not read as a miss');
  console.log('  a RIDE with one leg down reads as a miss, not as two-thirds of a win');

  // the Edge earns the precision mark on its own
  const edge = buildShareCard(spread([{ kind: 'side', pick: 'Edge', won: true }], { after: 49900 }));
  ok(edge.includes(MARK.exact), 'the Edge did not earn the precision mark');
  console.log('  the Edge is a 1-in-500 called shot and marks as exact');
}

// ===========================================================================
console.log('\n=== (4) the card never claims a multiplier the settlement would not pay ===');
{
  const rows = [];
  let bad = 0;
  for (const [before, after] of [[100, 256], [50, 24950], [1000, 0], [100, 100], [1, 499], [100, 12800]]) {
    const s = multStr(before, after);
    const claimed = parseFloat(s);
    const real = before > 0 ? after / before : 0;
    // printed to 2dp under 10 and 0dp above, so tolerance scales with the value
    const tol = real >= 10 ? 0.5 : 0.005;
    const okv = Math.abs(claimed - real) <= tol;
    if (!okv) { bad++; }
    rows.push({ before, after, printed: s, actual: +real.toFixed(4), ok: okv });
  }
  console.table(rows);
  ok(bad === 0, 'a printed multiplier disagrees with before/after', { bad });
  ok(multStr(100, 0) === '0x', 'a wipeout does not print as 0x', { got: multStr(100, 0) });
  console.log('  a wipeout prints 0x, not 0.00x — the card states the result, not its precision');
}

// ===========================================================================
console.log('\n=== (5) degenerate boards ===');
{
  const cases = [
    ['total loss', spread([
      { kind: 'side', pick: 'Tails', won: false },
      { kind: 'orient', quadrants: ['SE', 'SW'], won: false },
      { kind: 'spins', line: 12.5, lineMode: 'lt', won: false },
    ], { after: 0 })],
    ['499x Edge', spread([{ kind: 'side', pick: 'Edge', won: true }], { before: 50, after: 24950 })],
    ['no bets on the board', spread([])],
    ['recovery (cleaning)', { before: 0, after: 47, mode: 'clean', daringness: 0.24 }],
  ];
  const rows = [];
  for (const [name, r] of cases) {
    let card = null; let threw = null;
    try { card = buildShareCard(r); } catch (e) { threw = e.message; }
    ok(!threw, 'a degenerate board threw', { name, threw });
    const lines = card ? card.split('\n') : [];
    rows.push({ case: name, lines: lines.length, 'ends with url': lines[lines.length - 1] === 'play.coinflip.xyz' });
    ok(card && lines[lines.length - 1] === 'play.coinflip.xyz', 'the card does not end with the url', { name });
  }
  console.table(rows);

  // THE README'S LOGGED DEFECT: the free-bet card used the profit template, so
  // it divided by a zero balance and printed a fictional multiplier.
  const rec = buildRecoveryCard({ before: 0, after: 47, daringness: 0.3 });
  ok(!/x\b/.test(rec.split('\n')[0]), 'the recovery card still prints a multiplier', { head: rec.split('\n')[0] });
  ok(!/NaN|Infinity/.test(rec), 'the recovery card leaked a divide-by-zero', { rec });
  ok(rec.includes('+47'), 'the recovery card does not state what it paid');
  console.log('  recovery card states the PAYOUT, no multiplier — you came from zero,');
  console.log('  so after/before is a division by zero and any "x" is a fiction.');
  console.log(`  ${rec.split('\n')[0]}`);

  // an empty board must not invent a glyph for a call nobody made
  const empty = buildShareCard(spread([]));
  let marks = 0;
  for (const m of Object.values(MARK)) marks += (empty.split(m).length - 1);
  ok(marks === 0, 'an empty board still printed a glyph', { marks });
  console.log('  an empty board prints no glyph — it claims no call');
}

// ===========================================================================
console.log('\n=== (6) LAYOUT: monospace holds, proportional does not ===');
{
  const r = spread([
    { kind: 'side', pick: 'Heads', won: true },
    { kind: 'orient', quadrants: ['NE'], won: false },
    { kind: 'spins', line: 10, lineMode: 'exact', won: true },
  ]);
  const cols = bodyOf(buildShareCard(r, { layout: 'columns' }));
  ok(cols.length === 2, 'the columns layout is not two rows', { got: cols.length });

  // --- monospace: assert the CELL positions, do not eyeball the output -----
  const cellCentres = (line) => {
    const out = []; let x = 0; let start = null; let runW = 0;
    for (const ch of line) {
      const w = strWidth(ch);
      if (ch === ' ') {
        if (start !== null) { out.push(start + runW / 2); start = null; runW = 0; }
      } else {
        if (start === null) start = x;
        runW += w;
      }
      x += w;
    }
    if (start !== null) out.push(start + runW / 2);
    return out;
  };
  const topC = cellCentres(cols[0]);
  const botC = cellCentres(cols[1]);
  ok(topC.length === 3 && botC.length === 3, 'the columns layout did not produce 3 cells a row',
    { top: topC.length, bottom: botC.length });
  const monoDrift = topC.map((c, i) => Math.abs(c - botC[i]));
  const worstMono = Math.max(...monoDrift);
  ok(worstMono <= 0.5, 'the columns drift even in MONOSPACE', { monoDrift });
  console.log(`  monospace: glyph centres ${topC.map((v) => v.toFixed(1)).join(' / ')} cells`);
  console.log(`             label centres ${botC.map((v) => v.toFixed(1)).join(' / ')} cells`);
  console.log(`             worst drift ${worstMono.toFixed(2)} cells — aligned, as designed`);

  // --- proportional: MEASURE the drift, do not assume it ------------------
  // Helvetica advance widths, units per 1000 em. Emoji and arrows are given a
  // full em, which is generous to the columns layout — a narrower emoji would
  // make the drift worse, not better, so this is the optimistic case.
  const W = {
    ' ': 278, '.': 278, '·': 278, '→': 1000, '₿': 556,
    0: 556, 1: 556, 2: 556, 3: 556, 4: 556, 5: 556, 6: 556, 7: 556, 8: 556, 9: 556,
    a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222,
    k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
    u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  };
  const adv = (ch) => {
    const cp = ch.codePointAt(0);
    if (cp >= 0x1f300 || (cp >= 0x2190 && cp <= 0x21ff) || cp === 0x2705 || cp === 0x274c) return 1000;
    return W[ch] ?? 556;
  };
  const propCentres = (line) => {
    const out = []; let x = 0; let start = null; let runW = 0;
    for (const ch of line) {
      const w = adv(ch) / 1000;
      if (ch === ' ') {
        if (start !== null) { out.push(start + runW / 2); start = null; runW = 0; }
      } else {
        if (start === null) start = x;
        runW += w;
      }
      x += w;
    }
    if (start !== null) out.push(start + runW / 2);
    return out;
  };
  const pTop = propCentres(cols[0]);
  const pBot = propCentres(cols[1]);
  const propDrift = pTop.map((c, i) => Math.abs(c - pBot[i]));
  const worstProp = Math.max(...propDrift);
  console.table(pTop.map((c, i) => ({
    column: i + 1,
    'glyph centre (em)': +c.toFixed(2),
    'label centre (em)': +pBot[i].toFixed(2),
    'drift (em)': +propDrift[i].toFixed(2),
  })));

  // THIS IS THE POINT OF THE SECTION. The columns layout is expected to drift
  // proportionally — asserting it does NOT would be asserting the bug away, and
  // asserting nothing would leave the default choice unjustified.
  ok(worstProp > 0.5,
    'the columns layout does NOT drift proportionally — then it should be the default',
    { worstProp });
  console.log(`  proportional: worst drift ${worstProp.toFixed(2)} em — over half a character`);
  console.log('  off, and it grows with the number of columns. This is WHY inline is');
  console.log('  the default; columns remain for monospace destinations only.');

  // --- the default layout has nothing to drift ----------------------------
  const inline = bodyOf(buildShareCard(r));
  ok(inline.length === 1, 'the inline layout is not a single row', { got: inline.length });
  ok(!/\s{2,}(?=\S)/.test(inline[0].replace(/\s{3}/g, '|')),
    'the inline layout is padding to align something');
  // every glyph is immediately followed by its own label
  const pairs = inline[0].split('   ');
  ok(pairs.length === 3, 'the inline row did not produce one pair per call', { pairs });
  for (const p of pairs) {
    const m = [...p][0];
    ok(Object.values(MARK).includes(m), 'a pair does not start with its glyph', { p });
    ok(p.length > 2, 'a pair carries no label', { p });
  }
  console.log('  inline: each glyph is adjacent to its own label, so there is no');
  console.log('  alignment to lose — it renders the same in any font.');
}

// ===========================================================================
console.log('\n=== (7) the mode is stated, because it changes what the result MEANS ===');
{
  const bets = [
    { kind: 'side', pick: 'Heads', won: true },
    { kind: 'spins', line: 10, lineMode: 'exact', won: true },
  ];
  const s = buildShareCard(spread(bets));
  const r = buildShareCard(ride(bets));
  ok(s.includes('SPREAD') && !s.includes('RIDE'), 'a SPREAD card does not say SPREAD');
  ok(r.includes('RIDE') && !r.includes('SPREAD'), 'a RIDE card does not say RIDE');
  console.log('  "I rode it and hit 128x" is the share-worthy story, and the card can');
  console.log('  now tell it — the old card had no idea which bet had been placed.');
  console.log(`  ${s.split('\n')[0]}`);
  console.log(`  ${r.split('\n')[0]}`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
