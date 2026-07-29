// tools/verify-responsive.mjs
// ---------------------------------------------------------------------------
// STATIC analysis of coinflip-preview.html's layout. Node, no DOM, no browser.
//
// BE CLEAR ABOUT WHAT THIS CAN AND CANNOT DO. There is no headless browser on
// this machine (node_modules holds three and nothing else) and the preview pane
// is usually hidden, where screenshots fail, rAF never fires and CSS transitions
// never advance. So NOTHING here proves the page LOOKS right. What it proves is
// that the layout's stated invariants still hold in the source, and — the part
// that actually matters — that making it pretty did not break the game.
//
// The sections, in order of how much they are worth:
//
//   (3) EVERY SELECTOR THE SCRIPT USES STILL RESOLVES against the markup. The
//       script block is the source of truth for gameplay and was not touched;
//       this is what catches a layout edit that renamed or dropped something
//       out from under it. Worth more than every width check combined.
//   (4) The staged reveal's anchors survive. revealResults() positions
//       #stepTotal from live offsetLeft/offsetTop resolved against #form, so
//       the containing block and the amount column have to keep existing.
//   (1,2) Media queries are coherent and the width budget closes at 360px.
//   (5) The dial can still be painted on touch.
//
// Run: node tools/verify-responsive.mjs
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'coinflip-preview.html');

let failures = 0;
const fail = (msg, extra) => { failures++; console.log('  FAIL', msg, extra ? JSON.stringify(extra) : ''); };
const ok = (cond, msg, extra) => { if (!cond) fail(msg, extra); return cond; };

const src = await fs.readFile(FILE, 'utf8');

// --- carve the file into its three parts -----------------------------------
const styleM = src.match(/<style>([\s\S]*?)<\/style>/);
const scriptM = src.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!styleM || !scriptM) {
  console.log('  FAIL could not find the <style> and <script type="module"> blocks');
  process.exit(1);
}
const css = styleM[1];
const script = scriptM[1];
// markup = everything between </head> and the module script
const markup = src.slice(src.indexOf('<body>'), src.indexOf('<script type="module">'));

// --- a small CSS reader ----------------------------------------------------
// Regex, not a real parser, and that is a deliberate trade: the input is one
// known hand-written file, so brace-matching over comment-stripped text is
// enough, and a dependency would buy accuracy this file cannot use.
function stripComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); }

/** [{ media: null|maxWidth, selector, decls: {prop: value} }] in source order */
function readRules(text) {
  const out = [];
  const s = stripComments(text);
  let i = 0;
  const readBlock = (start) => {                 // start = index of '{'
    let depth = 0;
    for (let j = start; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}') { depth--; if (depth === 0) return j; }
    }
    return -1;
  };
  const parseDecls = (body) => {
    const d = {};
    for (const part of body.split(';')) {
      const c = part.indexOf(':');
      if (c < 0) continue;
      const prop = part.slice(0, c).trim();
      const val = part.slice(c + 1).trim();
      if (prop) d[prop] = val;
    }
    return d;
  };
  const scan = (text2, media) => {
    let k = 0;
    while (k < text2.length) {
      const brace = text2.indexOf('{', k);
      if (brace < 0) break;
      const sel = text2.slice(k, brace).trim();
      // find matching close within text2
      let depth = 0, end = -1;
      for (let j = brace; j < text2.length; j++) {
        if (text2[j] === '{') depth++;
        else if (text2[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
      }
      if (end < 0) break;
      const body = text2.slice(brace + 1, end);
      if (sel.startsWith('@media')) {
        const mm = sel.match(/max-width\s*:\s*(\d+)px/);
        scan(body, mm ? Number(mm[1]) : Infinity);
      } else if (sel) {
        for (const one of sel.split(',')) out.push({ media, selector: one.trim(), decls: parseDecls(body) });
      }
      k = end + 1;
    }
  };
  scan(s, null);
  return out;
}
const rules = readRules(css);

/**
 * The value a property takes at viewport width W, later-wins across the rules
 * whose media applies. Specificity is ignored on purpose — every selector this
 * checks is an exact repeat of an earlier one, where source order IS the winner.
 */
function effective(selector, prop, W) {
  let val = null;
  for (const r of rules) {
    if (r.selector !== selector) continue;
    if (r.media !== null && W > r.media) continue;
    if (r.decls[prop] !== undefined) val = r.decls[prop];
  }
  return val;
}
const px = (v) => (v && /^-?[\d.]+px$/.test(v) ? parseFloat(v) : null);

// ===========================================================================
console.log('=== (1) the media queries are coherent ===');
{
  const mqs = [...stripComments(css).matchAll(/@media([^{]+)\{/g)].map((m) => m[1].trim());
  ok(mqs.length > 0, 'no media queries were added at all');
  const bad = mqs.filter((q) => !/^\(\s*max-width\s*:\s*\d+px\s*\)$/.test(q));
  ok(bad.length === 0, 'a media query is malformed or uses an unexpected form', { bad });
  const widths = mqs.map((q) => Number(q.match(/(\d+)px/)[1]));
  // Nested max-width breakpoints must be strictly ordered and appear in
  // narrowing order, or a wider block would override a narrower one.
  const sorted = [...widths].sort((a, b) => b - a);
  ok(JSON.stringify(widths) === JSON.stringify(sorted),
    'breakpoints are not in narrowing source order — a wider block would win over a narrower one',
    { widths });
  ok(new Set(widths).size === widths.length, 'duplicate breakpoint', { widths });
  console.log(`  breakpoints: ${widths.map((w) => `max-width:${w}px`).join(', ')}`);
  console.log('  max-width only, strictly narrowing, no duplicates — so they nest rather than fight');
}

// ===========================================================================
console.log('\n=== (2) the width budget closes on a 360px phone ===');
{
  const rows = [];
  let worst = null;
  for (const W of [360, 390, 414, 560]) {
    const pad = px((effective('body', 'padding', W) || '').split(/\s+/)[1]) ?? 24;
    const fieldX = px(effective('body', '--field-x', W)) ?? 260;
    const gap = px(effective('#grid', 'column-gap', W)) ?? 16;
    // the dial is an SVG with a width ATTRIBUTE; CSS beats it where present
    const dialCss = px(effective('#dial', 'width', W));
    const dialAttr = Number((markup.match(/<svg id="dial"[^>]*width="(\d+)"/) || [])[1] ?? 160);
    const dial = dialCss ?? dialAttr;
    const DOT = 14, MULT = 44;            // .dot is 14px; ".33×" measures ~44px
    const avail = W - 2 * pad;
    const content = avail - (DOT + gap) - (MULT + gap);
    const amount = content - fieldX;
    rows.push({ viewport: W, pad, fieldX, dial, contentCol: +content.toFixed(0), amountCol: +amount.toFixed(0) });
    // the two invariants that actually matter
    if (!(dial <= fieldX)) fail('the dial is wider than the column it sits in', { W, dial, fieldX });
    if (!(amount >= 60)) fail('no room left for the staked amount', { W, amount });
    if (worst === null || amount < worst) worst = amount;
  }
  console.table(rows);
  console.log(`  dial always fits --field-x; narrowest amount column ${worst.toFixed(0)}px (floor 60)`);

  // and nothing may declare a hard width wider than the phone's content box
  const W = 360, pad = 14;
  const tooWide = [];
  for (const r of rules) {
    if (r.media !== null && W > r.media) continue;
    const w = px(r.decls.width) ?? px(r.decls['min-width']);
    if (w !== null && w > W - 2 * pad) {
      // only report if it is still the winning value at this width
      const eff = px(effective(r.selector, r.decls.width !== undefined ? 'width' : 'min-width', W));
      if (eff !== null && eff > W - 2 * pad) tooWide.push({ selector: r.selector, width: eff });
    }
  }
  ok(tooWide.length === 0, 'a declared width overflows a 360px phone', { tooWide });
  console.log(`  no effective fixed width exceeds the ${W - 2 * pad}px content box at 360px`);
}

// ===========================================================================
console.log('\n=== (3) THE ONE THAT MATTERS: the script still finds everything ===');
{
  // Classes the script ADDS at runtime are legitimately absent from markup.
  // Harvesting them from the source keeps this list correct by construction
  // instead of by a hand-maintained whitelist that rots.
  const dynamic = new Set();
  for (const m of script.matchAll(/classList\.(?:add|remove|toggle)\(([^)]*)\)/g)) {
    for (const s of m[1].matchAll(/'([^']+)'/g)) dynamic.add(s[1]);
  }

  const ids = new Set([...markup.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const classes = new Set();
  for (const m of markup.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach((c) => c && classes.add(c));
  const dataAttrs = new Set([...markup.matchAll(/\sdata-([\w-]+)=/g)].map((m) => m[1]));

  // Selectors are taken from the CALL SITES that consume them, not from every
  // string literal in the file. Scanning all literals looks equivalent and is
  // not: apostrophes inside comments ("the coin's up-axis") desynchronise quote
  // pairing, so the scan starts capturing CODE as strings and reports `.padStart`
  // as a missing class and the colour '#d12d2d' as a missing id. Worse, once
  // desynchronised it also stops seeing the real selectors, so it fails loudly
  // while checking nothing.
  const wantIds = new Set(), wantClasses = new Set(), wantData = new Set();
  const CALL = /(?:\$|document\.querySelectorAll|document\.querySelector|querySelectorAll|querySelector|closest|getElementById)\(\s*'([^']*)'/g;
  let dynamicPrefixes = 0;
  for (const m of script.matchAll(CALL)) {
    const s = m[1];
    for (const x of s.matchAll(/#([A-Za-z][\w-]*)/g)) {
      // A trailing hyphen is a concatenation prefix ('#a-' + suffix), not an id.
      // Those families are enumerated explicitly in section (4) instead.
      if (x[1].endsWith('-')) { dynamicPrefixes++; continue; }
      wantIds.add(x[1]);
    }
    for (const x of s.matchAll(/\.([A-Za-z][\w-]*)/g)) wantClasses.add(x[1]);
    for (const x of s.matchAll(/\[data-([\w-]+)/g)) wantData.add(x[1]);
  }
  ok(wantIds.size > 15, 'the selector scan found suspiciously few ids — it is probably broken',
    { found: wantIds.size });

  const missingIds = [...wantIds].filter((i) => !ids.has(i));
  const missingClasses = [...wantClasses].filter((c) => !classes.has(c) && !dynamic.has(c));
  const missingData = [...wantData].filter((d) => !dataAttrs.has(d));

  ok(missingIds.length === 0, 'the script queries an id the markup no longer has', { missingIds });
  ok(missingClasses.length === 0, 'the script queries a class that is neither in markup nor added at runtime', { missingClasses });
  ok(missingData.length === 0, 'the script queries a data attribute the markup no longer has', { missingData });
  console.log(`  ${wantIds.size} ids, ${wantClasses.size} classes, ${wantData.size} data attributes referenced`);
  console.log(`  markup provides ${ids.size} ids / ${classes.size} classes / ${dataAttrs.size} data attributes`);
  console.log(`  ${dynamic.size} classes are added at runtime and correctly absent from markup`);
  console.log(`  ${dynamicPrefixes} selectors are built by concatenation — enumerated in (4)`);
  console.log('  unresolved: 0');
}

// ===========================================================================
console.log('\n=== (4) the staged reveal can still find its column ===');
{
  // revealResults() does:
  //   tot.style.left = $('#stake').closest('.row-amt').offsetLeft
  //   tot.style.top  = rowEl.offsetTop
  // Both are read against #form as offsetParent, so #form must stay positioned
  // and #stepTotal must stay inside it.
  const formIdx = markup.indexOf('<div id="form"');
  const stepIdx = markup.indexOf('<div id="stepTotal"');
  const gridIdx = markup.indexOf('<div id="grid"');
  ok(formIdx >= 0 && stepIdx > formIdx, '#stepTotal is no longer inside #form', { formIdx, stepIdx });
  ok(stepIdx < gridIdx, '#stepTotal moved after #grid');
  ok(effective('#form', 'position', 360) === 'relative',
    '#form stopped being the positioned ancestor the reveal measures against');
  ok(effective('#stepTotal', 'position', 360) === 'absolute', '#stepTotal is no longer absolutely positioned');

  // the Total row must still hold a .row-amt wrapping #stake
  const totalRow = markup.slice(markup.indexOf('total-content'), markup.indexOf('total-mult'));
  ok(/class="row-amt"[^>]*>[^<]*<span id="stake"/.test(totalRow),
    '#stake is no longer inside a .row-amt in the Total row');
  console.log('  #stepTotal is inside #form; #form is position:relative; #stake sits in a .row-amt');

  // The concatenation-built id families the scan in (3) deliberately skipped.
  // The suffixes are the four aspect keys the script switches on; every
  // combination it can produce has to exist or a row silently stops resolving.
  const missingFamily = [];
  for (const [prefix, suffixes] of [
    ['a-', ['side', 'orient', 'spins', 'spread']],
    ['m-', ['side', 'orient', 'spins', 'spread']],
    ['amt-', ['side', 'orient', 'spins']],
  ]) {
    for (const s of suffixes) {
      if (!markup.includes(`id="${prefix}${s}"`)) missingFamily.push(prefix + s);
    }
  }
  ok(missingFamily.length === 0, 'a runtime-composed id has no element', { missingFamily });
  console.log('  composed ids a-{side,orient,spins,spread}, m-{...}, amt-{...} all present');

  // NOTHING between #form and the rows may become a containing block, or the
  // offsets the reveal is computed from silently re-base. #form itself is the
  // intended one and is excluded.
  const ancestors = ['#grid', '.aspect-cell', '.field-row', '.row-choices', '.total-content'];
  const offenders = [];
  for (const sel of ancestors) {
    for (const prop of ['position', 'transform', 'filter', 'perspective', 'contain']) {
      const v = effective(sel, prop, 360);
      if (v && !(prop === 'position' && v === 'static')) offenders.push({ sel, prop, v });
    }
  }
  ok(offenders.length === 0,
    'an ancestor between #form and the rows became a containing block — offsetLeft/offsetTop would re-base',
    { offenders });
  console.log(`  no containing block introduced on ${ancestors.join(', ')}`);

  // the amount column must remain a COLUMN at every width, not a stacked row
  for (const W of [360, 390, 560, 1200]) {
    const tpl = effective('.field-row', 'grid-template-columns', W);
    ok(tpl === 'var(--field-x) auto',
      'the amount stopped being its own column — the sliding total would land wrong', { W, tpl });
  }
  console.log('  .field-row is `var(--field-x) auto` at 360/390/560/1200 — the amount is always a column');
}

// ===========================================================================
console.log('\n=== (5) the dial is still paintable, and the animation rules hold ===');
{
  ok((effective('#dial', 'touch-action', 360) || '') === 'none',
    'touch-action:none was lost — a drag on the dial would scroll the page instead of painting');
  console.log('  #dial keeps touch-action:none at phone width');

  // §4: never animate font-weight, and never scale a whole row container
  const animatesWeight = rules.filter((r) => /font-weight/.test(r.decls.transition || ''));
  ok(animatesWeight.length === 0, 'something animates font-weight', { animatesWeight });

  const rowContainers = ['#grid', '.aspect-cell', '.field-row', '.row-choices'];
  const scaled = [];
  for (const r of rules) {
    if (!rowContainers.includes(r.selector)) continue;
    if (/scale/.test(r.decls.transform || '')) scaled.push(r.selector);
  }
  ok(scaled.length === 0, 'a whole row container is being scaled', { scaled });

  // §4's origin rule is about THE RESULT REVEAL, where a value grows in place
  // beside text that must not appear to shift — a centre origin would move the
  // element's visual left edge and drag the eye. It is NOT a blanket ban on
  // centre-origin scaling: `.dot.clickable:hover` scales a 14px circle from its
  // own centre, which is symmetric, affects no layout, and is correct as it is.
  // So the assertion is scoped to the reveal, which is where the rule came from.
  const scalers = rules.filter((r) => /scale\(/.test(r.decls.transform || ''));
  const revealScalers = scalers.filter((r) => /res-/.test(r.selector));
  const pinned = (r) => r.decls['transform-origin']
    || rules.some((o) => o !== r && r.selector.startsWith(o.selector) && o.decls['transform-origin']);
  const unpinned = revealScalers.filter((r) => !pinned(r));
  ok(unpinned.length === 0, 'a reveal animation scales without a pinned transform-origin',
    { unpinned: unpinned.map((r) => r.selector) });
  ok(revealScalers.length >= 3, 'the reveal scalers vanished — is this still the same file?',
    { found: revealScalers.length });
  const centred = scalers.filter((r) => !revealScalers.includes(r)).map((r) => r.selector);
  console.log(`  ${revealScalers.length} reveal scaling rules, every one with a pinned origin`);
  console.log(`  ${centred.length} non-reveal scale(s) left on a centre origin, by design: ${centred.join(', ')}`);
  console.log('  no row container scales; nothing animates font-weight');
}

// ===========================================================================
console.log('\n=== (6) touch ergonomics that static analysis can actually check ===');
{
  const W = 390;
  const rows = [];
  const coin = px(effective('#coinVis, #coinVisBroke', 'width', W)) ?? px(effective('#coinVis', 'width', W));
  const optPad = effective('.opt', 'padding', W);
  const padTop = optPad ? px(optPad.split(/\s+/)[0]) : 0;
  // a bare inline-block span of ~19px line box plus vertical padding
  const optHeight = 19 + 2 * (padTop ?? 0);
  rows.push({ control: 'coin (#coinVis)', px: coin });
  rows.push({ control: '.opt tap height', px: optHeight });
  console.table(rows);
  ok(coin !== null && coin >= 72, 'the coin is too small to tap comfortably', { coin });
  ok(optHeight >= 32, 'the text options have too little vertical hit area', { optHeight });
  console.log('  NOTE: these are DECLARED sizes. Whether they are comfortable in the hand');
  console.log('        is not something this file can know, and it does not claim to.');

  ok(/viewport/.test(src) && /width=device-width/.test(src), 'the viewport meta tag is missing');
  console.log('  viewport meta present (width=device-width)');
}

// ===========================================================================
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
