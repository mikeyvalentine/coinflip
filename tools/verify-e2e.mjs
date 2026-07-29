// tools/verify-e2e.mjs
// ---------------------------------------------------------------------------
// END TO END. Every other suite verifies a part in isolation and they are good
// at it — but a part can be correct while the SEQUENCE is wrong, and that is
// the class this file exists for:
//
//   * money that balances inside every function but not across a flip
//   * a gate that holds alone and not while something else is in flight
//   * a flow that dead-ends, leaving the player with no way forward
//
// It plays the real game: the page's own script, its own handlers, its own
// state, driven in the order a player would drive it. See tools/qa-harness.mjs
// for how the DOM and both clocks are stubbed.
//
// TWO REAL BUGS CAME OUT OF THIS FILE, and sections (2) and (3) are their
// regressions. Both were invisible to a maths test because both functions were
// individually correct.
//
// Run: node tools/verify-e2e.mjs
// ---------------------------------------------------------------------------
import { loadPage } from './qa-harness.mjs';

let failures = 0;
const fail = (m, x) => { failures++; console.log('  FAIL', m, x ? JSON.stringify(x) : ''); };
const ok = (c, m, x) => { if (!c) fail(m, x); return c; };

const PROBE = `
globalThis.__QA = {
  get player(){ return player; }, get clean(){ return clean; },
  get flipping(){ return flipping; }, get day(){ return day; },
  setBet(v){ bet = v; }, setMode(v){ betMode = v; },
  setStart(v){ shownStart = v; }, setTimerEnd(t){ timerEnd = t; },
  doFlip, doBank, canFlip, canBank, canClean, cleanPayout, refresh,
  placedBets, rideMult, spreadK, load, save, WALLET_FLOOR,
  // Induce a fault inside the flip, to prove the lock is released on the way
  // out. Swapping the real function is the only way to reach the failure path
  // without waiting for a genuine render bug to turn up.
  breakReveal(){ this._reveal = revealResults; revealResults = async () => { throw new Error('induced render fault'); }; },
  restoreReveal(){ revealResults = this._reveal; },
};`;

const fresh = async (opts) => {
  const g = await loadPage('coinflip-preview.html', PROBE, opts);
  await g.settle();
  return g;
};
/** Scrub the coin to completion, the way a player finishing the job would. */
const scrubClean = (c, n = 40) => {
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) c.scrubTo(-1 + 2 * i / n, -1 + 2 * j / n);
};

// ===========================================================================
console.log('=== (1) a full life: broke -> clean -> bet -> flip -> bank -> bust ===');
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
    'the clean did not pay inside its band', { paid: g.player.balance });

  g.setBet({ side: 'Heads', orientation: ['NE'], spins: { line: 10, mode: 'exact' } });
  g.setMode('spread');
  ok(g.canFlip(), 'a funded player with a board cannot flip');
  await g.doFlip(); await g.settle();
  snap('after a flip');

  if (g.player.balance > g.WALLET_FLOOR) {
    g.setTimerEnd(g.gameNow + 60000);
    g.el('#bankInput').value = String(g.player.balance - g.WALLET_FLOOR);
    const before = g.player.balance + g.player.bank;
    g.doBank();
    snap('after banking to the floor');
    ok(g.player.balance + g.player.bank === before, 'banking changed the total money', { before });
    ok(g.player.balance >= g.WALLET_FLOOR, 'banking breached the floor', { w: g.player.balance });
    g.setTimerEnd(0);
  }
  console.table(rows);
  ok(rows.every((r) => Number.isInteger(r.wallet) && Number.isInteger(r.bank)),
    'a balance went non-integer somewhere in the life');
  console.log('  every step settles to whole B, and the total only moves when the coin does');
  g.restoreDate();
}

// ===========================================================================
console.log('\n=== (2) REGRESSION: money cannot move while a flip is in flight ===');
{
  // THE BUG. doFlip captured the stake, awaited ~3 s of reveal, then RE-READ
  // player.balance as the starting balance and computed
  // `startBalance - totalRisk + returned`. Bank during that window and it
  // subtracted the original stake from a reduced balance: a 1000 B wallet with
  // 500 banked mid-reveal settled to a NEGATIVE wallet and destroyed 500 B.
  //
  // The game's own rule is that the stake freezes when the flip goes live, but
  // only canFlip() enforced it and only against the timer — so any cooldown
  // starting during a reveal re-opened banking mid-settlement.
  const g = await fresh();
  g.player.balance = 1000; g.player.bank = 0;
  g.setBet({ side: 'Heads', orientation: ['NE'], spins: { line: 10, mode: 'exact' } });
  g.setMode('spread');

  const inFlight = g.doFlip();
  ok(g.flipping, 'the flip did not report itself as in flight');
  g.setTimerEnd(g.gameNow + 60000);          // a cooldown begins mid-reveal
  ok(!g.canBank(), 'banking is still allowed while a flip is in flight');
  g.el('#bankInput').value = '500';
  g.doBank();
  ok(g.player.bank === 0, 'money moved to the bank during a flip', { bank: g.player.bank });

  await inFlight; await g.settle();
  const total = g.player.balance + g.player.bank;
  ok(g.player.balance >= 0, 'the wallet went NEGATIVE', { wallet: g.player.balance });
  ok(Number.isInteger(total) && Number.isFinite(total), 'the total is not a finite integer', { total });
  console.log(`  wallet ${g.player.balance}, bank ${g.player.bank} — no negative wallet, nothing destroyed`);
  g.restoreDate();
}

// ===========================================================================
console.log('\n=== (3) REGRESSION: a corrupt save cannot strand the player ===');
{
  // THE BUG. localStorage is not trusted input. `{"balance":"lots"}` is valid
  // JSON, and a string balance passed canFlip() because `"lots" <= 0` is false.
  // One flip later the wallet was NaN — and NaN fails every comparison, so
  // canFlip() AND canClean() were both false. No route back, permanently,
  // rescued only by a debug button that will not ship.
  const g = await fresh();
  const rows = [];
  for (const [raw, label] of [
    ['{"balance":"lots","bank":0,"history":[]}', 'string balance'],
    ['{"balance":-500,"bank":-10,"history":[]}', 'negative'],
    ['{"balance":1e308,"bank":1e308,"history":[]}', 'absurdly large'],
    ['{"balance":12.7,"bank":3.9,"history":[]}', 'fractional'],
    ['{"balance":null,"history":null}', 'nulls'],
    ['[]', 'an array'],
    ['{ broken', 'not JSON at all'],
  ]) {
    g.store.set('coinflip', raw);
    const r = g.load();
    const clean = r === null || (
      Number.isInteger(r.balance) && r.balance >= 0 && r.balance <= Number.MAX_SAFE_INTEGER
      && Number.isInteger(r.bank) && r.bank >= 0
      && Array.isArray(r.history));
    rows.push({ saved: label, loaded: r === null ? 'null' : `${r.balance} / ${r.bank}`, usable: clean });
    ok(clean, 'a corrupt save loaded into an unusable state', { label, r });
  }
  console.table(rows);

  // and the gates must catch a broken wallet even if one reaches them
  for (const bad of [NaN, Infinity, -Infinity, 'lots', null, undefined]) {
    g.player.balance = bad;
    g.setBet({ side: 'Heads' }); g.setMode('spread'); g.setTimerEnd(0);
    ok(g.canFlip() === false, 'a broken wallet was allowed to flip', { bad, canFlip: g.canFlip() });
    ok(g.canClean() === true, 'a broken wallet cannot be recovered — DEAD END', { bad });
  }
  console.log('  every broken wallet refuses to flip AND offers the clean — no dead end');
  g.restoreDate();
}

// ===========================================================================
console.log('\n=== (4) 400 steps of real play: money conserves, nothing strands ===');
{
  const g = await fresh();
  let seed = 20260729;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const SIDES = ['Heads', 'Tails']; const QS = ['NE', 'SE', 'SW', 'NW'];
  const bad = [];
  const check = (where) => {
    const b = g.player.balance; const k = g.player.bank;
    if (!Number.isFinite(b) || !Number.isInteger(b) || b < 0) bad.push({ where, why: 'wallet', b });
    if (!Number.isFinite(k) || !Number.isInteger(k) || k < 0) bad.push({ where, why: 'bank', k });
  };
  let flips = 0; let cleans = 0; let banks = 0; let busts = 0;

  for (let step = 0; step < 400 && bad.length === 0; step++) {
    if (g.player.balance <= 0) {
      g.setTimerEnd(0);
      if (!g.canClean() || !g.clean) { bad.push({ where: 'broke', why: 'DEAD END: no way back from 0' }); break; }
      const n = 3 + Math.floor(rnd() * 40);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) g.clean.scrubTo(-1 + 2 * i / n, -1 + 2 * j / n);
      // a player who stops short is rescued by the 20 s cap, fired from the
      // page's own 500 ms tick
      g.advanceGame(25000); g.tick(2); await g.settle();
      await g.cleanPayout(); await g.settle();
      cleans++; check('after clean');
      if (g.player.balance <= 0) { bad.push({ where: 'after clean', why: 'DEAD END: still 0' }); break; }
      continue;
    }
    if (rnd() < 0.35) {
      g.setTimerEnd(g.gameNow + 60000);
      if (g.canBank()) {
        g.el('#bankInput').value = String(Math.ceil(rnd() * g.player.balance));
        const before = g.player.balance + g.player.bank;
        g.doBank(); banks++; check('after bank');
        if (g.player.balance + g.player.bank !== before) bad.push({ where: 'bank', why: 'total money changed', before });
        if (g.player.balance > 0 && g.player.balance < g.WALLET_FLOOR) bad.push({ where: 'bank', why: 'floor breached', b: g.player.balance });
      }
      g.setTimerEnd(0);
    }
    const b = { side: SIDES[Math.floor(rnd() * 2)] };
    if (rnd() < 0.6) b.orientation = QS.slice(0, 1 + Math.floor(rnd() * 3));
    if (rnd() < 0.6) { const line = 4 + Math.round(rnd() * 32) / 2; if (line !== 12) b.spins = { line, mode: rnd() < 0.5 ? 'exact' : (rnd() < 0.5 ? 'gt' : 'lt') }; }
    g.setBet(b); g.setMode(rnd() < 0.5 ? 'spread' : 'ride');
    if (!g.canFlip()) continue;
    await g.doFlip(); await g.settle();
    flips++; check('after flip');
    if (g.player.balance <= 0) busts++;
  }
  console.log(`  ${flips} flips, ${cleans} cleans, ${banks} banks, ${busts} busts`);
  ok(bad.length === 0, 'an invariant broke during play', bad.slice(0, 4));
  ok(flips > 100, 'the session stalled — too few flips to be a real exercise', { flips });
  console.log('  no negative or fractional money, no floor breach, no dead end');
  g.restoreDate();
}

// ===========================================================================
console.log('\n=== (5) the gates hold in LOGIC, not only in CSS ===');
{
  const g = await fresh();
  g.player.balance = 500; g.player.bank = 0;

  // concurrent flips must settle exactly once
  g.setBet({ side: 'Heads' }); g.setMode('spread');
  const before = g.player.balance;
  await Promise.all([g.doFlip(), g.doFlip(), g.doFlip()]);
  await g.settle();
  ok(g.player.balance === before * 2 || g.player.balance === 0,
    'three concurrent flips did not settle as exactly one', { before, after: g.player.balance });

  // banking with the timer at 00 is refused — the stake is live
  g.player.balance = 500; g.setTimerEnd(0);
  g.el('#bankInput').value = '100';
  const t0 = g.player.balance + g.player.bank;
  g.doBank();
  ok(g.player.balance + g.player.bank === t0 && g.player.bank === 0,
    'banked while the flip was live (timer at 00)', { bank: g.player.bank });

  // cleaning is refused while funded — it is a recovery, not an income
  ok(!g.canClean(), 'a funded player can still farm the cleaning payout');

  // and refused while the cooldown runs, exactly like the flip
  g.player.balance = 0; g.setTimerEnd(g.gameNow + 60000);
  ok(!g.canClean(), 'cleaning is allowed during the cooldown');
  g.setTimerEnd(0);
  ok(g.canClean(), 'cleaning is refused at 0 with no cooldown — that is the dead end');
  console.log('  concurrent flips, banking gates and the clean gate all hold in logic');
  g.restoreDate();
}

// ===========================================================================
console.log('\n=== (7) REGRESSION: a throw mid-flip does not lock the game forever ===');
{
  // THE BUG. doFlip and cleanPayout set `flipping = true` and cleared it on the
  // last line — with no try/finally. Any throw in between (a render error, a
  // missing element, a clip that fails to load) left the lock ON permanently.
  // Every later flip then became a SILENT no-op while the coin still looked
  // enabled, and because the player kept their money the cleaning game would
  // not offer itself either: a funded account that can never play again.
  const g = await fresh();
  g.player.balance = 500; g.player.bank = 0;
  g.setBet({ side: 'Heads' }); g.setMode('spread');

  g.breakReveal();
  let threw = false;
  try { await g.doFlip(); } catch { threw = true; }
  await g.settle();
  ok(threw, 'the induced fault did not actually reach doFlip — the test proves nothing');
  ok(g.flipping === false, 'the flip lock is still held after a throw — the game is bricked',
    { flipping: g.flipping });

  // and once the fault clears, play must resume
  g.restoreReveal();
  const before = g.player.balance;
  await g.doFlip(); await g.settle();
  ok(g.player.balance !== before || before === 0,
    'play did not resume after the fault cleared', { before, after: g.player.balance });
  console.log(`  lock released, and the next flip settled ${before} -> ${g.player.balance}`);
  g.restoreDate();
}

// ===========================================================================
console.log('\n=== (8) STRUCTURAL: every in-flight lock is exception-safe ===');
{
  // The bug in section (7) exists once per lock, and there are locks in both
  // pages. A behavioural test can only reach the ones it can induce a fault in,
  // and the 3D page cannot even be evaluated here (its `three` import needs the
  // browser's importmap). So this reads the SOURCE: any function that sets an
  // in-flight lock must clear it on a path that a throw cannot skip.
  //
  // The 3D page's flip was the worse case — its reset button is only revealed
  // on success, so a throw left the canvas dead with no visible way out.
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { ROOT } = await import('./qa-harness.mjs');

  /** Slice a function body out by matching braces from its declaration. */
  const bodyOf = (src, anchor) => {
    const at = src.indexOf(anchor);
    if (at < 0) return null;
    const open = src.indexOf('{', at);
    if (open < 0) return null;
    let depth = 0;
    for (let k = open; k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(at, k + 1); }
    }
    return null;
  };

  const rows = [];
  for (const [file, lock, anchor, label] of [
    ['coinflip-preview.html', 'flipping', 'async function doFlip(', 'doFlip'],
    ['coinflip-preview.html', 'flipping', 'async function cleanPayout(', 'cleanPayout'],
    ['coinflip-3d.html', 'locked', 'async function flip(', 'flip'],
    ['coinflip-3d.html', 'dropping', 'onCancel: async (reason)', 'onCancel'],
  ]) {
    const src = await fs.readFile(path.join(ROOT, file), 'utf8');
    const page = /<script type="module">([\s\S]*?)<\/script>/.exec(src)[1];
    const chunk = bodyOf(page, anchor);
    ok(chunk !== null, 'could not find the function to check — the anchor has drifted',
      { file, anchor });
    if (!chunk) continue;
    // PLAIN STRING MATCHING, no regex. The first version built the release
    // pattern with a template literal — and inside one,  is a BACKSPACE
    // character (0x08), not a word boundary. The pattern could never match, so
    // every lock silently reported itself unguarded and the table looked
    // plausible for three runs. That is the same 'a test that cannot fire'
    // class this very section exists to catch, written into the catcher.
    const flat = chunk.replace(/\s+/g, ' ');
    const sets = flat.includes(lock + ' = true') || flat.includes(lock + '=true');
    const guarded = flat.includes('finally {') || flat.includes('catch (');
    const releases = flat.includes(lock + ' = false') || flat.includes(lock + '=false');
    rows.push({ file: file.replace('coinflip-', ''), fn: label, lock, sets, guarded, releases });
    if (sets) {
      ok(guarded && releases,
        'an in-flight lock can be left held by a throw — the game bricks',
        { file, fn: label, lock, guarded, releases });
    }
  }
  console.table(rows);
  console.log('  a lock held by a throw is permanent: the control still LOOKS live,');
  console.log('  every later attempt is a silent no-op, and no reset is offered.');
}

// ===========================================================================
console.log('\n=== (6) the cleaning payout cannot be farmed ===');
{
  const g = await fresh();
  scrubClean(g.clean);
  const paid = g.clean.payout;
  await g.cleanPayout(); await g.settle();
  const afterFirst = g.player.balance;
  ok(afterFirst === paid, 'the clean did not pay what it showed', { paid, afterFirst });

  // a second call must not pay again — the player is funded now
  await g.cleanPayout(); await g.settle();
  ok(g.player.balance === afterFirst, 'the clean paid twice', { afterFirst, now: g.player.balance });
  console.log(`  paid ${paid} once; a second call is refused because the player is funded`);
  g.restoreDate();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
