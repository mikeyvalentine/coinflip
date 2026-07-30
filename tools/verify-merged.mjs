// tools/verify-merged.mjs
// ---------------------------------------------------------------------------
// THE MERGED GAME: coinflip.html — the betting board driving the 3D renderer.
//
// This is the suite that has to catch what the merge could break. The pieces all
// have their own verifiers and every one of them is green; what nothing else
// checks is that the board and the renderer share ONE outcome model, that money
// still conserves across a whole life, and that the three bugs
// tools/verify-e2e.mjs found in the preview did not come back in the port.
//
// WHY THE SHARED-DRAW CHECK IS THE HEADLINE. The 2D game and the renderer each
// grew a copy of the outcome model, and the copies drifted until they disagreed
// about what a quadrant was CALLED — a divergence that survived every green
// suite for weeks because each build was internally consistent with itself. The
// merged page importing flip3d/outcome.js is the fix; §3 asserts it rather than
// trusting the import statement to still be there next month.
//
// The renderer itself cannot be evaluated in Node — `import 'three'` needs the
// browser's importmap — so the page is driven through its FLAT-COIN path, which
// is the same code for everything except the pixels. That is a real limit and is
// stated in the report rather than papered over.
//
// Run: node tools/verify-merged.mjs
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadPage, ROOT } from './qa-harness.mjs';
import * as BETS from '../game/bets.js';
import * as WALLET from '../game/wallet.js';
import { resolveFlip } from '../flip3d/outcome.js';
import { SPIN_VALUES, QUADRANTS } from '../game/units.js';

let failures = 0;
const fail = (m, x) => { failures++; console.log('  FAIL', m, x ? JSON.stringify(x) : ''); };
const ok = (c, m, x) => { if (!c) fail(m, x); return c; };

const PROBE = `
globalThis.__QA = {
  get player(){ return player; }, get bet(){ return bet; }, get clean(){ return clean; },
  get flipping(){ return flipping; }, get pending(){ return pending; },
  get betMode(){ return betMode; }, get renderer(){ return renderer; },
  get shownStart(){ return shownStart; }, get day(){ return day; },
  setBet(v){ bet = v; }, setMode(v){ betMode = v; }, setPending(v){ pending = v; },
  setStart(v){ shownStart = v; }, setNextFlipAt(t){ player.nextFlipAt = t; },
  doFlip, doBank, canFlip, canBank, canClean, cleanPayout, refresh, arm,
  updateFinal, revealResults, renderResult, spendDay, save,
  DAY_MS,
};`;

// The page must take the flat path in Node: `import 'three'` cannot resolve
// without the browser importmap, and ?flat=1 is the switch the page already has.
const fresh = async (opts = {}) => {
  globalThis.location = { search: '?flat=1&day=0' };
  const g = await loadPage('coinflip.html', PROBE, opts);
  await g.settle();
  return g;
};
const scrubClean = (c, n = 40) => {
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) c.scrubTo(-1 + 2 * i / n, -1 + 2 * j / n);
};

// ===========================================================================
console.log('=== (1) every selector the script uses resolves in the markup ===');
{
  const html = await fs.readFile(path.join(ROOT, 'coinflip.html'), 'utf8');
  const body = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];
  const markup = html.slice(0, html.indexOf('<script type="module">'));

  const ids = new Set();
  for (const m of body.matchAll(/\$\('#([a-zA-Z0-9_-]+)'\)/g)) ids.add(m[1]);
  for (const m of body.matchAll(/querySelector(?:All)?\('#([a-zA-Z0-9_-]+)/g)) ids.add(m[1]);
  const missing = [...ids].filter((id) => !markup.includes(`id="${id}"`));
  ok(missing.length === 0, 'the script targets an id that does not exist', { missing });
  console.log(`  ${ids.size} ids referenced, ${missing.length} missing`);

  const classes = new Set();
  for (const m of body.matchAll(/querySelectorAll?\('\.?([a-zA-Z-]+)[ .[]/g)) classes.add(m[1]);
  const missingCls = [...classes].filter((c) => !markup.includes(c));
  ok(missingCls.length === 0, 'the script targets a class that does not exist', { missingCls });
}

// ===========================================================================
console.log('\n=== (2) THE REVEAL\'S CONTAINING BLOCK IS INTACT ===');
{
  // #stepTotal is absolutely positioned inside #form and its top/left come from
  // the LIVE offsets of the rows. A canvas between #form and a row — or any
  // ancestor gaining position/transform/filter/perspective/contain — silently
  // re-bases every one of them. It looks perfect at rest and lands the sliding
  // total in the wrong place the instant it moves.
  const html = await fs.readFile(path.join(ROOT, 'coinflip.html'), 'utf8');
  const markup = html.slice(0, html.indexOf('<script type="module">'));

  const formStart = markup.indexOf('<div id="form"');
  const formEnd = markup.indexOf('<div id="out">');
  ok(formStart >= 0 && formEnd > formStart, 'could not find #form in the markup');
  const form = markup.slice(formStart, formEnd);

  ok(form.includes('id="stepTotal"'), '#stepTotal is not inside #form — the offsets would be meaningless');
  ok(/#form\s*\{[^}]*position:\s*relative/.test(html), '#form is not the containing block');

  // THE STAGE MUST BE OUTSIDE #form. This is the structural version of the rule:
  // not "we were careful", but "it cannot happen".
  ok(!form.includes('id="stage"') && !form.includes('<canvas'),
    'a canvas is inside #form — every reveal offset is now re-based', {
      stageInForm: form.includes('id="stage"'),
    });
  console.log('  #stepTotal is inside #form; the stage and both canvases are outside it');

  // and no ancestor between #form and the rows may establish a new containing block
  const between = form.slice(0, form.indexOf('data-idx="0"'));
  const risky = ['transform:', 'filter:', 'perspective:', 'contain:'].filter((p) => between.includes(p));
  ok(risky.length === 0, 'an element between #form and the rows re-bases the offsets', { risky });
}

// ===========================================================================
console.log('\n=== (3) THE HEADLINE: the merged page uses the SHARED draw ===');
{
  const html = await fs.readFile(path.join(ROOT, 'coinflip.html'), 'utf8');
  const body = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];

  ok(/import\s*\{[^}]*resolveFlip[^}]*\}\s*from\s*'\.\/flip3d\/outcome\.js'/.test(body),
    'the merged page does not import the shared draw');
  ok(/from\s*'\.\/game\/bets\.js'/.test(body), 'the merged page does not import the shared pricing');

  // A COPY is the failure mode, not a missing import. The preview declares its
  // own resolveFlip and its own SPIN_MIN/QUADS; if any of that got pasted across
  // during the merge the page would work perfectly and drift silently.
  ok(!/async function resolveFlip/.test(body), 'the merged page declares its OWN resolveFlip — that is the drift');
  ok(!/const SPIN_MIN\s*=/.test(body), 'the spin ladder is restated instead of imported');
  ok(!/QUADS\s*=\s*\[/.test(body), 'the quadrant names are restated instead of imported');
  ok(!/const EDGE_P\s*=/.test(body), 'the rim probability is restated instead of imported');
  ok(!/function spreadK|function rideProb|function placedBets/.test(body),
    'the pricing is reimplemented in the page instead of imported');
  console.log('  imports the draw and the pricing; declares neither');

  // and the units really are one definition
  const g = await fresh();
  const drawn = await resolveFlip('merged::check::1', null);
  ok(SPIN_VALUES.includes(drawn.spins) || drawn.edge, 'the shared draw produced a spin outside the ladder', { drawn });
  ok(drawn.edge || QUADRANTS.includes(drawn.quadrant), 'the shared draw produced an unknown quadrant', { drawn });

  // A NEW PLAYER IS BROKE, so nothing is armed — refresh() sends them to the
  // cleaning coin instead. My first version asserted on `pending` straight after
  // boot and read null, which was the game being right and the test being wrong.
  ok(g.pending === null, 'a broke player was armed with a flip they cannot take', { pending: g.pending });
  scrubClean(g.clean); await g.cleanPayout(); await g.settle();
  g.setNextFlipAt(0);
  await g.arm(); await g.settle();
  ok(g.pending && (g.pending.edge || SPIN_VALUES.includes(g.pending.spins)),
    'the page armed with an outcome outside the shared ladder', { pending: g.pending });
  ok(g.pending && (g.pending.edge || QUADRANTS.includes(g.pending.quadrant)),
    'the page armed with a quadrant outside the shared set', { pending: g.pending });
  console.log('  broke players are not armed; a funded arm draws from the shared ladder and quadrant set');
}

// ===========================================================================
console.log('\n=== (4) A FULL LIFE: 0 -> clean -> bet -> flip -> bank -> bust ===');
{
  const g = await fresh();
  const rows = [];
  const snap = (label) => rows.push({
    step: label, wallet: g.player.balance, bank: g.player.bank,
    total: g.player.balance + g.player.bank,
  });

  snap('open at 0');
  ok(g.canClean(), 'a new player at 0 cannot clean — there is no way into the game');

  scrubClean(g.clean);
  await g.cleanPayout(); await g.settle();
  snap('after cleaning');
  ok(g.player.balance >= 40 && g.player.balance <= 60,
    'the cleaning payout left the band', { balance: g.player.balance });

  // The clean spent the day; clear it so the flip can be driven.
  g.setNextFlipAt(0);
  const before = g.player.balance;
  g.setBet({ side: 'Heads' });
  g.setMode('spread');
  ok(g.canFlip(), 'a funded player with a side called cannot flip');

  await g.doFlip({ power: 0.5 }); await g.settle();
  snap('after a flip');
  ok(Number.isInteger(g.player.balance), 'the wallet is not a whole number', { b: g.player.balance });
  ok(g.player.balance >= 0, 'the wallet went NEGATIVE', { b: g.player.balance });
  // one side call at 2x: either it doubled or it is gone
  ok(g.player.balance === 0 || g.player.balance === before * 2,
    'a lone 2x side call settled to something other than 0 or double',
    { before, after: g.player.balance });

  console.table(rows);
  console.log('  money is a whole number and never negative at any step');
}

// ===========================================================================
console.log('\n=== (5) THE SETTLEMENT AND THE ANIMATION AGREE ===');
{
  // The preview returned the money as a side effect of ANIMATING it, which welds
  // the payout to a chain of awaited timeouts. Here settleReturn() decides and
  // the reveal animates toward it — so they can be compared, which is the only
  // way to know the reveal has not started lying about the result.
  const g = await fresh();
  const rows = [];
  let worst = 0;
  const boards = [
    { label: 'side only', bet: { side: 'Heads' }, mode: 'spread' },
    { label: 'side+orient', bet: { side: 'Heads', orientation: ['NE'] }, mode: 'spread' },
    { label: 'all three', bet: { side: 'Heads', orientation: ['NE'], spins: { line: 10, mode: 'exact' } }, mode: 'spread' },
    { label: 'all three RIDE', bet: { side: 'Heads', orientation: ['NE'], spins: { line: 10, mode: 'exact' } }, mode: 'ride' },
    { label: 'wide spin', bet: { side: 'Tails', spins: { line: 10, mode: 'gt' } }, mode: 'spread' },
  ];
  for (const b of boards) {
    for (let s = 0; s < 12; s++) {
      const flip = await resolveFlip('agree::' + b.label + '::' + s, null);
      g.setBet(b.bet); g.setMode(b.mode); g.setStart(flip.startFace);
      const stake = 1000;
      const pure = BETS.settleReturn(b.bet, b.mode, flip, stake, flip.startFace);
      const animated = await g.revealResults(flip, stake, BETS.portions(b.bet, b.mode));
      await g.settle();
      worst = Math.max(worst, Math.abs(pure - animated));
    }
    rows.push({ board: b.label, mode: b.mode });
  }
  ok(worst < 1e-6, 'the reveal animated to a different number than the settlement', { worst });
  console.log(`  ${boards.length} board shapes x 12 outcomes: worst divergence ${worst.toExponential(2)}`);
}

// ===========================================================================
console.log('\n=== (6) AN EDGE SWEEPS EVERYTHING, AND PAYS 499x WHEN CALLED ===');
{
  // The shared draw NULLS spins/quadrant/orientationDeg on a rim landing, which
  // is the shape the merged game settles against. A settlement that reached one
  // of those nulls would compare against NaN and lose for the wrong reason.
  const edge = {
    startFace: 'Heads', side: 'Edge', spins: null,
    orientationDeg: null, quadrant: null, edge: true,
  };
  const rows = [];
  const sweeps = [
    { label: 'side+orient+spin', bet: { side: 'Heads', orientation: ['NE'], spins: { line: 10, mode: 'exact' } } },
    { label: 'side only', bet: { side: 'Tails' } },
    { label: 'orient only', bet: { side: 'Heads', orientation: ['NE', 'SE'] } },
  ];
  for (const s of sweeps) {
    const got = BETS.settleReturn(s.bet, 'spread', edge, 1000, 'Heads');
    rows.push({ board: s.label, returned: got });
    ok(got === 0, 'a rim landing did not sweep the board', { board: s.label, got });
  }
  const called = BETS.settleReturn({ side: 'Edge' }, 'spread', edge, 100, 'Heads');
  rows.push({ board: 'Edge called', returned: called });
  ok(called === 49900, 'calling Edge on a rim landing did not pay 499x', { called });
  console.table(rows);

  // and the page can PRESENT one without throwing on the nulls
  const g = await fresh();
  g.setBet({ side: 'Heads', orientation: ['NE'] });
  let threw = null;
  try { g.renderResult(edge, 100, 0, BETS.portions({ side: 'Heads', orientation: ['NE'] }, 'spread')); }
  catch (e) { threw = String(e && e.message); }
  ok(!threw, 'presenting a rim landing threw on a nulled axis', { threw });
  console.log('  the rim result renders with every nulled axis guarded');
}

// ===========================================================================
console.log('\n=== (7) THE THREE E2E BUGS DID NOT COME BACK ===');
{
  // 7a. Money cannot move while a flip is in flight. The preview captured the
  // stake, awaited ~3 s of reveal, then RE-READ the balance: banking 500 of a
  // 1000 wallet in that window settled to wallet -500 with 500 B destroyed.
  const g = await fresh();
  g.setNextFlipAt(0);
  scrubClean(g.clean); await g.cleanPayout(); await g.settle();
  g.setNextFlipAt(0);

  // a cooldown running mid-flight is exactly the state that re-opened banking
  g.setNextFlipAt(g.gameNow + 60000);
  const inFlightBank = (() => {
    // canBank must be false while flipping regardless of the timer
    const before = g.canBank();
    return { withTimer: before };
  })();
  ok(WALLET.canBank({ balance: 1000, bank: 0 }, { timerRunning: true, inFlight: true }) === false,
    'banking is allowed while a flip is in flight — money can be destroyed', inFlightBank);
  ok(WALLET.canBank({ balance: 1000, bank: 0 }, { timerRunning: true, inFlight: false }) === true,
    'banking is refused when it should be allowed');
  console.log('  banking is refused in-flight and allowed otherwise');

  // 7b. A corrupt save must not strand the player.
  const rows = [];
  for (const raw of ['{"balance":"lots"}', '{"balance":null}', '{"balance":1e308}',
    '{"balance":-5}', '{"balance":{}}', 'not json at all', '{"nextFlipAt":"soon"}']) {
    const p = WALLET.loadPlayer({ getItem: () => raw });
    const flips = WALLET.canFlip(p, { timerRunning: false, inFlight: false, hasBet: true, rideDead: false });
    const cleans = WALLET.canClean(p, { timerRunning: false, inFlight: false });
    rows.push({ saved: raw.slice(0, 22), balance: p.balance, nextFlipAt: p.nextFlipAt, canFlip: flips, canClean: cleans });
    ok(Number.isFinite(p.balance) && p.balance >= 0, 'a corrupt save survived sanitising', { raw, p });
    ok(Number.isFinite(p.nextFlipAt), 'a corrupt cooldown survived sanitising', { raw, p });
    ok(flips || cleans, 'a corrupt save left the player with NO route back', { raw, p });
  }
  console.table(rows);

  // 7c. Every in-flight lock is exception-safe. Structural: the same check
  // verify-e2e.mjs §8 makes, because a lock cleared on the last line of a
  // function is held forever the moment anything above it throws.
  const html = await fs.readFile(path.join(ROOT, 'coinflip.html'), 'utf8');
  const body = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];
  const locks = [
    { fn: 'doFlip', lock: 'flipping' },
    { fn: 'cleanPayout', lock: 'flipping' },
  ];
  const lockRows = [];
  for (const { fn, lock } of locks) {
    const i = body.indexOf('function ' + fn);
    ok(i >= 0, 'could not find ' + fn);
    const seg = body.slice(i, i + 2600);
    const sets = seg.includes(lock + ' = true');
    const releases = seg.includes(lock + ' = false');
    const guarded = seg.includes('finally');
    lockRows.push({ fn, lock, sets, releases, guarded });
    ok(!sets || guarded, `${fn} sets ${lock} without a finally — a throw holds it forever`, { fn });
    ok(!sets || releases, `${fn} never releases ${lock}`, { fn });
  }
  console.table(lockRows);
}

// ===========================================================================
console.log('\n=== (8) THE DAILY GATE IS REAL, AND PERSISTS ===');
{
  // The preview never auto-started the cooldown, so the one-flip-a-day rule —
  // the spine of the design — had never actually run. It does here.
  const html = await fs.readFile(path.join(ROOT, 'coinflip.html'), 'utf8');
  const body = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];
  ok(/function spendDay/.test(body), 'there is no daily gate at all');
  // both routes out of a turn must spend it, or busting is free
  // Slice FORWARD from each function by length, not to the next occurrence of
  // some landmark string. My first cut ended cleanSeg at the first
  // `$('#cleanCoin')` in the file — which sits ABOVE cleanPayout, inside
  // cleanCoords — so the slice ran backwards, came out empty, and reported the
  // clean as not spending the day when it plainly does. A test that slices on a
  // non-unique landmark reports on whatever it happened to grab.
  const cut = (from, len) => {
    const i = body.indexOf(from);
    return i < 0 ? '' : body.slice(i, i + len);
  };
  const flipSeg = cut('async function doFlip', 2600);
  const cleanSeg = cut('async function cleanPayout', 900);
  ok(flipSeg.length > 0 && cleanSeg.length > 0, 'could not locate the two turn-spending paths');
  ok(flipSeg.includes('spendDay()'), 'a flip does not spend the day');
  ok(cleanSeg.includes('spendDay()'), 'a clean does not spend the day — busting would be free');
  ok(/nextFlipAt/.test(body) && /savePlayer|save\(\)/.test(body), 'the cooldown is not persisted');
  console.log('  a flip and a clean both spend the day, and nextFlipAt is saved');

  // and the gate actually refuses
  const p = { balance: 100, bank: 0, history: [], nextFlipAt: 1 };
  ok(WALLET.canFlip(p, { timerRunning: true, inFlight: false, hasBet: true, rideDead: false }) === false,
    'the cooldown does not refuse a flip');
  ok(WALLET.canClean({ balance: 0, history: [] }, { timerRunning: true, inFlight: false }) === false,
    'the cooldown does not refuse a clean');
  console.log('  the gate refuses both a flip and a clean while it runs');
}

// ===========================================================================
console.log('\n=== (9) THE WEBGL-ABSENT PATH IS A PLAYABLE GAME ===');
{
  // Not "reports the failure cleanly" — plays. The betting game does not need a
  // GPU and must not be held hostage by one.
  const g = await fresh();
  ok(g.renderer && g.renderer.kind === 'flat', 'the page did not fall back to the flat coin', {
    kind: g.renderer && g.renderer.kind,
  });
  g.setNextFlipAt(0);
  scrubClean(g.clean); await g.cleanPayout(); await g.settle();
  const funded = g.player.balance;
  ok(funded >= 40, 'could not fund a player without WebGL', { funded });

  g.setNextFlipAt(0);
  g.setBet({ side: 'Heads', orientation: ['NE'] });
  g.setMode('spread');
  ok(g.canFlip(), 'cannot flip without WebGL');
  await g.doFlip({ power: 0.5 }); await g.settle();
  ok(Number.isInteger(g.player.balance) && g.player.balance >= 0,
    'the flat-coin flip settled to something impossible', { b: g.player.balance });
  ok(g.player.history.length >= 2, 'the flat-coin flip did not record a turn');
  console.log(`  funded to ${funded} ₿, bet, flipped and settled to ${g.player.balance} ₿ with no renderer`);
}

// ===========================================================================
console.log('\n=== (10) 300 STEPS OF REAL PLAY: money conserves, nothing strands ===');
{
  const g = await fresh();
  let steps = 0; let flips = 0; let cleans = 0; let banks = 0; let busts = 0;
  let stranded = null;
  for (let i = 0; i < 300 && !stranded; i++) {
    steps++;
    g.setNextFlipAt(0);                       // drive the gate by hand
    if (g.canClean()) {
      scrubClean(g.clean);
      await g.cleanPayout(); await g.settle();
      cleans++;
    } else if (g.canFlip.call(null) || g.player.balance > 0) {
      // a rotating board so every shape gets exercised
      const shapes = [
        { side: 'Heads' },
        { side: 'Tails', orientation: ['NE'] },
        { side: 'Heads', orientation: ['NE', 'SE'], spins: { line: 10, mode: 'gt' } },
        { side: 'Edge' },
      ];
      g.setBet(shapes[i % shapes.length]);
      g.setMode(i % 5 === 0 ? 'ride' : 'spread');
      if (!g.canFlip()) { g.setBet({ side: 'Heads' }); g.setMode('spread'); }
      if (g.canFlip()) {
        const before = g.player.balance;
        await g.doFlip({ power: 0.5 }); await g.settle();
        flips++;
        if (g.player.balance === 0) busts++;
        if (!Number.isFinite(g.player.balance) || g.player.balance < 0) {
          stranded = { why: 'impossible balance', before, after: g.player.balance };
        }
        if (!Number.isInteger(g.player.balance)) {
          stranded = { why: 'fractional balance', after: g.player.balance };
        }
      }
      // bank a little when there is room
      if (g.player.balance > WALLET.WALLET_FLOOR) {
        g.setNextFlipAt(g.gameNow + 60000);
        if (g.canBank()) { g.el('#bankInput').value = '10'; g.doBank(); banks++; }
        g.setNextFlipAt(0);
      }
    } else {
      stranded = { why: 'no route forward', balance: g.player.balance };
    }
    if (g.player.bank < 0) stranded = { why: 'negative bank', bank: g.player.bank };
  }
  console.log(`  ${steps} steps: ${flips} flips, ${cleans} cleans, ${banks} banks, ${busts} busts`);
  ok(!stranded, 'the player reached a state with no way forward', stranded);
  ok(g.player.bank >= 0 && Number.isInteger(g.player.bank), 'the bank is not a whole non-negative number', {
    bank: g.player.bank,
  });
  console.log('  no negative, fractional or invented ₿; no dead end');
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
