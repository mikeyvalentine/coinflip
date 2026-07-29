// shareCard.js
// ---------------------------------------------------------------------------
// The plain-text card a player pastes into a chat. No image, no flavour copy.
//
//   🟡 COINFLIP · SPREAD   2.56x
//   50 → 128 ₿
//
//   ✅ heads   ❌ ↗   🎯 10.0
//
//   ▰▰▰▰▰▰▰▰–– High-Roller
//   play.coinflip.xyz
//
// WHY THE GLYPH SITS BESIDE ITS CALL AND NOT ABOVE IT
// ---------------------------------------------------
// The ask was columns — each glyph directly over the guess it refers to. The
// GOAL behind that (you can tell which mark belongs to which call) is right,
// and is exactly what this preserves. The MECHANISM cannot be columns.
//
// Share cards get pasted into chat apps, which render PROPORTIONAL fonts.
// Wordle's grid survives because it is PURE emoji: one glyph class, uniform
// advance width, no text mixed in. The moment text of varying width appears,
// alignment built from padding spaces drifts — 'W' is wider than 'i', and a
// space is narrower than both.
//
// MEASURED, in tools/verify-sharecard.mjs §6, on a real card with Helvetica
// advance widths. Offset between each glyph's centre and the centre of the call
// it labels:
//
//   column          1       2       3
//   monospace     0.50    0.00    0.00  cells   <- aligned, as designed
//   proportional  0.58    0.89    1.08  em      <- drifts, and GROWS
//
// The drift compounds with every column, so the failure is worst exactly where
// the card is busiest. It looks perfect in a terminal right up until it is
// pasted somewhere real.
//
// ADJACENCY NEEDS NO ALIGNMENT. A glyph immediately followed by its own label
// carries the same mapping and cannot drift, because nothing is being lined up.
// `layout: 'columns'` remains available for monospace-only destinations, and
// tools/verify-sharecard.mjs measures the drift of both rather than taking this
// paragraph's word for it.
//
// MARK TIERS — precision is what gets rewarded visibly:
//   🎯 exact  a precise call landed: an exact rotation line, a single quadrant,
//             the Edge, or a RIDE (a called shot by construction)
//   ✅ soft   a range call landed: a side, a widened spin line, several quadrants
//   ❌ miss
//
// SPREAD AND RIDE RENDER DIFFERENTLY, because they ARE different bets. SPREAD
// settles each call on its own, so it gets one glyph per call. RIDE is a single
// compound call — you cannot win two of three — so it gets ONE glyph for the
// whole board. Three glyphs on a RIDE would advertise a partial result the
// settlement can never produce.
//
// NEVER PRINT A HALF-FLIP. The internal spin unit is half-flips (8..40); the
// player-facing unit is ROTATIONS = half-flips / 2, to one decimal. That rule
// is absolute, and tools/verify-sharecard.mjs sweeps for violations.
// ---------------------------------------------------------------------------

import { daringnessLabel } from './daringness.js';
import { toRotations, exactCardinal, QUADRANTS } from './flip3d/contract.js';

const CUR = '₿'; // ₿
const commas = (n) => Math.round(n).toLocaleString('en-US');

export const MARK = {
  exact: '🎯', // 🎯
  soft: '✅',        // ✅
  miss: '❌',        // ❌
};

/**
 * Quadrant -> arrow. A bucket runs FROM its first letter TO its second, so the
 * arrow points into the sector rather than at one of its edges: NE spans north
 * round to east, and the diagonal is exactly that direction.
 */
export const QUAD_ARROW = { NE: '↗', SE: '↘', SW: '↙', NW: '↖' };

/**
 * Cardinal -> arrow, RESERVED for exact 90-degree multiples.
 *
 * Orientation is true to two decimals, so a bucket edge is 1 of its 9000
 * values. A STRAIGHT arrow therefore means the coin landed exactly on a
 * cardinal — the same reservation contract.js#exactCardinal() makes for the
 * single-letter names, restated here so the two cannot drift apart.
 */
export const CARD_ARROW = { N: '↑', E: '→', S: '↓', W: '←' };

/** Arrow for a bucket name or a reserved cardinal. Throws on anything else. */
export function arrowFor(name) {
  if (QUAD_ARROW[name]) return QUAD_ARROW[name];
  if (CARD_ARROW[name]) return CARD_ARROW[name];
  throw new Error('not a quadrant or cardinal: ' + name);
}

/**
 * The picked quadrants as arrows, in compass order.
 *
 * A multi-quadrant bet renders as several arrows rather than a name or a count.
 * It is what the player actually did — they covered those sectors — and it
 * stays honest as the price moves: the arrow count IS the 4/k denominator, so a
 * three-arrow row visibly reads as the cheaper bet without printing a
 * multiplier beside it.
 */
export function arrowsForPicks(quadrants) {
  const set = new Set(quadrants ?? []);
  return QUADRANTS.filter((q) => set.has(q)).map(arrowFor).join('');
}

// --- coin tier by multiplier -----------------------------------------------
function coinFor(mult) {
  if (mult >= 4) return '🟡';   // 🟡 gold
  if (mult >= 1.3) return '⚪';       // ⚪ silver
  return '🟠';                  // 🟠 copper
}

/** Multiplier, trimmed. `0x` on a wipeout rather than a solemn `0.00x`. */
export function multStr(before, after) {
  const m = before > 0 ? after / before : 0;
  if (m === 0) return '0x';
  return (m >= 10 ? m.toFixed(0) : m.toFixed(2).replace(/\.?0+$/, '')) + 'x';
}

// --- nerve meter ------------------------------------------------------------
function nerveMeter(daringness) {
  const cells = 10;
  const d = Number.isFinite(daringness) ? daringness : 0.5;
  const filled = Math.round(Math.max(0, Math.min(1, d)) * cells);
  return '▰'.repeat(filled) + '–'.repeat(cells - filled); // ▰ –
}

/**
 * The player-facing label for one call, and whether it was a PRECISE call.
 *
 * `bet` shapes, matching the board:
 *   { kind:'side',   pick:'Heads'|'Tails'|'Edge',              won }
 *   { kind:'orient', quadrants:['NE',...],                     won }
 *   { kind:'spins',  line:10, lineMode:'exact'|'gt'|'lt',      won }
 */
export function describeBet(bet) {
  switch (bet.kind) {
    case 'side': {
      const pick = String(bet.pick ?? '').toLowerCase();
      // The Edge is a 1-in-500 called shot, so it earns the precision mark on
      // its own — there is nothing coarse about naming the rim.
      return { label: pick, precise: pick === 'edge' };
    }
    case 'orient': {
      const qs = bet.quadrants ?? [];
      return { label: arrowsForPicks(qs), precise: qs.length === 1 };
    }
    case 'spins': {
      // The line is ALREADY in rotations — the player types 4..20 in 0.5 steps.
      // Nothing converts here, because nothing here is ever handed half-flips.
      const line = Number(bet.line).toFixed(1);
      if (bet.lineMode === 'gt') return { label: `over ${line}`, precise: false };
      if (bet.lineMode === 'lt') return { label: `under ${line}`, precise: false };
      return { label: line, precise: true };
    }
    default:
      throw new Error('unknown bet kind: ' + bet.kind);
  }
}

function markFor(bet) {
  if (!bet.won) return MARK.miss;
  return describeBet(bet).precise ? MARK.exact : MARK.soft;
}

/**
 * Terminal cell width. Emoji and the arrows occupy two cells in a monospace
 * grid; ASCII occupies one. Counting UTF-16 code units instead would make an
 * emoji 2 by accident of encoding and an arrow 1, which lines up neither.
 */
export function strWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x1f300 || (cp >= 0x2190 && cp <= 0x21ff) || cp === 0x2705 || cp === 0x274c) w += 2;
    else w += 1;
  }
  return w;
}

// --- layouts ----------------------------------------------------------------
// Three spaces reads as a deliberate gap between pairs without inviting the eye
// to treat it as a column boundary.
const GAP = '   ';

function inlineRow(cells) {
  return cells.map(({ mark, label }) => `${mark} ${label}`).join(GAP);
}

/**
 * Glyph over label, centred and padded.
 *
 * MONOSPACE ONLY — see the header. Kept because a terminal, a fenced code
 * block, or a fixed-width bot destination renders it correctly, and it is what
 * was originally asked for.
 */
function columnRows(cells) {
  const widths = cells.map(({ mark, label }) => Math.max(strWidth(mark), strWidth(label)));
  const pad = (s, w) => {
    const total = w - strWidth(s);
    const left = Math.floor(total / 2);
    return ' '.repeat(Math.max(0, left)) + s + ' '.repeat(Math.max(0, total - left));
  };
  const top = cells.map(({ mark }, i) => pad(mark, widths[i])).join(GAP);
  const bottom = cells.map(({ label }, i) => pad(label, widths[i])).join(GAP);
  return [top.replace(/\s+$/, ''), bottom.replace(/\s+$/, '')];
}

// --- recovery card ----------------------------------------------------------
/**
 * Cleaning a coin back into the game has NO multiplier: you came from zero, so
 * after/before divides by zero and any "x" figure is a fiction. The old card
 * forced the free flip through the profit template and printed exactly that
 * fiction — the README logged it as a known defect. Hence a shape of its own.
 */
export function buildRecoveryCard(result, options = {}) {
  const url = options.url ?? 'play.coinflip.xyz';
  const paid = Math.round(result.after ?? 0);
  const head = `🪙 COINFLIP · CLEANED   +${commas(paid)} ${CUR}`;
  const nerve = `${nerveMeter(result.daringness)} ${daringnessLabel(result.daringness ?? 0.5)}`;
  return [head, '', nerve, url].join('\n');
}

// --- main -------------------------------------------------------------------
/**
 * @param {object} result
 *   { before, after, mode:'spread'|'ride'|'clean', bets:[...], daringness }
 * @param {object} [options] { url, layout:'inline'|'columns' }
 */
export function buildShareCard(result, options = {}) {
  // 'brokeFlip' is the SUPERSEDED name for the same thing — recovery from zero,
  // which is now a coin-cleaning minigame rather than a free 50/50. Aliased
  // rather than dropped: an un-migrated caller passing the old mode would
  // otherwise fall through to the betting path and be handed a card with no
  // glyphs and a divide-by-zero multiplier, which is a worse failure than a
  // slightly out-of-date name.
  if (result.mode === 'clean' || result.mode === 'brokeFlip') {
    return buildRecoveryCard(result, options);
  }

  const url = options.url ?? 'play.coinflip.xyz';
  const layout = options.layout ?? 'inline';
  const bets = result.bets ?? [];
  const ride = result.mode === 'ride';
  const mult = result.before > 0 ? result.after / result.before : 0;

  const modeTag = ride ? 'RIDE' : 'SPREAD';
  const header = `${coinFor(mult)} COINFLIP · ${modeTag}   ${multStr(result.before, result.after)}`;
  const money = `${commas(result.before)} → ${commas(result.after)} ${CUR}`;

  let body;
  if (!bets.length) {
    // No live call on the board. Nothing to mark, and inventing a glyph would
    // claim a call the player never made.
    body = [];
  } else if (ride) {
    // ONE glyph: a RIDE lands whole or not at all, and it is a called shot by
    // construction, so a win is always the precision mark.
    const won = bets.every((b) => b.won);
    const label = bets.map((b) => describeBet(b).label).join(' · ');
    body = [`${won ? MARK.exact : MARK.miss} ${label}`];
  } else {
    const cells = bets.map((b) => ({ mark: markFor(b), label: describeBet(b).label }));
    body = layout === 'columns' ? columnRows(cells) : [inlineRow(cells)];
  }

  const nerve = `${nerveMeter(result.daringness)} ${daringnessLabel(result.daringness ?? 0.5)}`;
  return [header, money, '', ...body, ...(body.length ? [''] : []), nerve, url].join('\n');
}

/** Re-exported so callers never hand-roll the conversion. */
export { toRotations, exactCardinal };
