// settle.js — turning a flip plus a slip into money. Pure.
//
// The wallet is the stake in full, so the wallet AFTER a flip is exactly what
// came back: walletAfter = round(sum of winning payouts). There is nothing left
// over to carry, which is why busting is the common case and the Broke Flip
// exists.

import { resolvePortion, totalMultiple } from './bets.js';
import { FREE_BET_RETURN, SIDES } from './constants.js';

export function settleNormal({ stake, portions, flip }) {
  const lines = portions.map((p) => {
    const risked = stake * p.weight;
    const won = resolvePortion(p, flip);
    const payout = won ? risked * p.mult : 0;
    return {
      key: p.key,
      pick: p.pick,
      mult: p.mult,
      weight: p.weight,
      risked,
      won,
      payout,
      profit: payout - risked,
    };
  });

  const returnedExact = lines.reduce((a, l) => a + l.payout, 0);
  const walletAfter = Math.max(0, Math.round(returnedExact));

  return {
    lines,
    stake,
    returnedExact,
    returned: walletAfter,
    walletAfter,
    profit: walletAfter - stake,
    multiple: stake > 0 ? returnedExact / stake : 0,
    maxMultiple: totalMultiple(portions),
    swept: !!flip.edge && !portions.some((p) => p.pick === 'Edge'),
    bust: walletAfter <= 0,
  };
}

// The Broke Flip. Free, heads or tails only, no upgrades — that is what closes
// the exploit where a broke player could take free long-shot bets. A rim
// landing still sweeps, exactly as it does anywhere else on the felt.
export function settleBroke({ call, flip }) {
  if (!SIDES.includes(call)) throw new Error(`broke flip call must be Heads or Tails, got ${call}`);
  const won = !flip.edge && flip.side === call;
  const walletAfter = won ? FREE_BET_RETURN : 0;
  return {
    lines: [
      {
        key: 'broke',
        pick: call,
        mult: 0,
        weight: 1,
        risked: 0,
        won,
        payout: walletAfter,
        profit: walletAfter,
        free: true,
      },
    ],
    stake: 0,
    returnedExact: walletAfter,
    returned: walletAfter,
    walletAfter,
    profit: walletAfter,
    multiple: 0,
    maxMultiple: 0,
    swept: !!flip.edge,
    bust: walletAfter <= 0,
  };
}

// The shape ../daringness.js expects for one day of history. Built from a
// settled round so the trait is computed from what actually happened on the
// server, not from anything the client reports.
export function toDayRecord({ settlement, dateISO, bustedYesterday, edgeBets }) {
  return {
    date: dateISO,
    startBalance: settlement.stake,
    endBalance: settlement.walletAfter,
    totalStaked: settlement.stake,
    bets: settlement.lines.map((l) => ({
      stake: l.risked,
      payoutMultiple: l.mult,
      kind: l.key,
      won: l.won,
    })),
    bustedYesterday: !!bustedYesterday,
    edgeBets: edgeBets ?? settlement.lines.filter((l) => l.pick === 'Edge').length,
    totalBets: settlement.lines.length,
  };
}
