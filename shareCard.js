// shareCard.js
// ---------------------------------------------------------------------------
// Plain-text, copyable daily-flip share card. No image, no flavor copy.
// Ultra-minimal "Wordle-tight" layout:
//
//   🪙 COINFLIP   10x
//   10 → 100 ₿
//
//   🎯 ✅ ❌
//   9 spins · under 10 · E side
//
//   ▰▰▰▰▰▰▰▰–– High-Roller
//   play.coinflip.xyz
//
// Mark tiers (rewards precision visibly):
//   🎯 exact  — nailed a precise value (exact spin count, Called Shot)
//   ✅ soft   — correct on a range/coarse bet (over/under, parity, bracket, side)
//   ❌ miss
//
// The glyph strip is the recognizable, screenshot-friendly row; the picks are
// listed below in the SAME order so each glyph maps to a pick left-to-right.
// ---------------------------------------------------------------------------

import { daringnessLabel } from './daringness.js';

const CUR = '\u20BF'; // ₿
const commas = (n) => Math.round(n).toLocaleString('en-US');

const MARK = {
  exact: '\uD83C\uDFAF', // 🎯
  soft:  '\u2705',       // ✅
  miss:  '\u274C',       // ❌
};

// --- coin tier by multiplier -----------------------------------------------
function coinFor(mult) {
  if (mult >= 4)   return '\uD83D\uDFE1'; // 🟡 gold
  if (mult >= 1.3) return '\u26AA';       // ⚪ silver
  return '\uD83D\uDFE0';                  // 🟠 copper
}

function multStr(before, after) {
  const m = before > 0 ? after / before : 0;
  return m.toFixed(2).replace(/\.?0+$/, '') + 'x';
}

// --- nerve meter ------------------------------------------------------------
function nerveMeter(daringness) {
  const cells = 10;
  const filled = Math.round(Math.max(0, Math.min(1, daringness)) * cells);
  return '\u25B0'.repeat(filled) + '\u2013'.repeat(cells - filled); // ▰ –
}

// --- classify each bet: which mark, and its short pick label ---------------
// "exact" bets are those where the player named a precise value and hit it.
// Everything else that wins is "soft". Losses are misses.
function classifyBet(bet) {
  const isExactKind = bet.kind === 'exactRot' || bet.kind === 'calledShot';
  let mark;
  if (!bet.won) mark = 'miss';
  else if (isExactKind) mark = 'exact';
  else mark = 'soft';

  let pick;
  switch (bet.kind) {
    case 'side':       pick = bet.side.toLowerCase(); break;
    case 'overUnder':  pick = `${bet.overUnder} ${bet.line}`; break;
    case 'parity':     pick = `${bet.parity}`; break;
    case 'bracket':    pick = `${bet.bracket} spins`; break;
    case 'exactRot':   pick = `${bet.rotations} spins`; break;
    case 'calledShot': pick = `${bet.side.toLowerCase()} · ${bet.rotations} spins`; break;
    case 'table':      pick = `${bet.table} side`; break; // PLACEHOLDER axis
    case 'edge':       pick = 'edge'; break;
    default:           pick = '?';
  }
  return { mark, pick };
}

// --- Broke Flip card --------------------------------------------------------
// A free 50/50 from zero has no meaningful multiplier, so it gets its own
// clean format instead of being forced through the profit template.
//   won:  🪙 BROKE FLIP  ·  won 50 ₿   (heads ✅)   → back in the game
//   lost: 🪙 BROKE FLIP  ·  0 ₿        (heads ❌)   → flip again tomorrow
export function buildBrokeFlipCard(result, options = {}) {
  const url = options.url ?? 'play.coinflip.xyz';
  const won = result.after > 0;
  const pick = (result.pick ?? 'heads').toLowerCase();
  const mark = won ? '\u2705' : '\u274C';
  const coin = '\uD83E\uDE99'; // 🪙 (no tier — it's a free flip)
  const head = won
    ? `${coin} BROKE FLIP \u00B7 won ${result.after} ${CUR}`
    : `${coin} BROKE FLIP \u00B7 0 ${CUR}`;
  const line = `${pick} ${mark}`;
  const tail = won ? 'back in the game' : 'flip again tomorrow';
  return [head, '', line, '', tail, url].join('\n');
}

// --- main -------------------------------------------------------------------
// result: { before, after, bets:[...], daringness, mode?, pick? }
export function buildShareCard(result, options = {}) {
  if (result.mode === 'brokeFlip') return buildBrokeFlipCard(result, options);
  const url = options.url ?? 'play.coinflip.xyz';
  const mult = result.before > 0 ? result.after / result.before : 0;

  const coin = coinFor(mult);
  const header = `${coin} COINFLIP   ${multStr(result.before, result.after)}`;
  const money = `${commas(result.before)} \u2192 ${commas(result.after)} ${CUR}`;

  const classified = (result.bets ?? []).map(classifyBet);
  const glyphs = classified.map((c) => MARK[c.mark]).join(' ');
  const picks = classified.map((c) => c.pick).join(' \u00B7 ');

  const nerve = `${nerveMeter(result.daringness)} ${daringnessLabel(result.daringness)}`;

  return [
    header,
    money,
    '',
    glyphs,
    picks,
    '',
    nerve,
    url,
  ].join('\n');
}
