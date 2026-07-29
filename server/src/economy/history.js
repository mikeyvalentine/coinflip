// history.js — turn settled rounds into the day records ../../../daringness.js
// grades. The trait is therefore computed from what the SERVER recorded, never
// from anything the client reports.

import { computeDaringness } from '../../../daringness.js';

export function roundsToDays(rows) {
  // rows arrive newest first; walk oldest first so "bustedYesterday" is real
  const ordered = [...rows].reverse();
  const days = [];
  let previousEnd = null;

  for (const row of ordered) {
    let lines = [];
    let edge = false;
    try {
      const parsed = row.outcome_json ? JSON.parse(row.outcome_json) : null;
      lines = parsed?.lines ?? [];
      edge = !!parsed?.flip?.edge;
    } catch {
      lines = [];
    }
    if (!lines.length && row.bets_json) {
      try {
        const parsed = JSON.parse(row.bets_json);
        if (Array.isArray(parsed)) lines = parsed.map((b) => ({ risked: b.stake, mult: b.payoutMultiple, key: b.kind, won: b.won }));
      } catch {
        /* ignore */
      }
    }

    const startBalance = row.wallet_before ?? row.stake ?? 0;
    const endBalance = row.wallet_after ?? row.returned ?? 0;
    days.push({
      date: new Date(row.settled_at ?? row.opened_at ?? Date.now()).toISOString().slice(0, 10),
      startBalance,
      endBalance,
      totalStaked: row.stake ?? 0,
      bets: lines.map((l) => ({
        stake: l.risked ?? l.stake ?? 0,
        payoutMultiple: l.mult ?? l.payoutMultiple ?? 0,
        kind: l.key ?? l.kind ?? 'x',
      })),
      bustedYesterday: previousEnd === 0,
      edgeBets: lines.filter((l) => l.pick === 'Edge' || l.key === 'edge').length + (edge ? 0 : 0),
      totalBets: lines.length,
    });
    previousEnd = endBalance;
  }
  return days;
}

// `pendingDay` is the flip being settled right now — it has to be included or
// the trait would always lag one round behind.
export function daringnessFor(rows, previous, pendingDay = null) {
  const days = roundsToDays(rows);
  if (pendingDay) days.push(pendingDay);
  return computeDaringness(days, previous);
}
