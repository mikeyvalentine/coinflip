// sweep.js — characterise the launch envelope. This is the "solve it backwards"
// evidence: how (vy, omega, spinY) maps onto half-flips, what the analytic
// predictor's error is, and where the quality gates actually bite.
// Run: node tools/sweep.js [nSamples]

import { initRapier, simulateClip, omegaForHalfFlips, predictHalfFlips } from '../sim.js';
import { classify } from '../classify.js';
import { makeRng } from '../prng.js';
import { LAUNCH, CLASSIFY } from '../config.js';

await initRapier();
const N = Number(process.argv[2] || 400);
const rng = makeRng('sweep-v1', 'blind');

const rows = [];
const rejects = new Map();
const excesses = [];
let predErrSum = 0, predErrN = 0;
const t0 = process.hrtime.bigint();

for (let i = 0; i < N; i++) {
  const vy = rng.range(LAUNCH.vyMin, LAUNCH.vyMax);
  const omega = rng.range(LAUNCH.omegaMin, LAUNCH.omegaMax);
  const params = {
    y0: LAUNCH.y0, vy, omega,
    vh: rng.range(LAUNCH.vhMin, LAUNCH.vhMax),
    psi: rng.range(0, 2 * Math.PI),
    spinY: rng.range(-LAUNCH.spinYMax, LAUNCH.spinYMax),
  };
  const sim = simulateClip(params);
  const c = classify(sim);
  excesses.push(sim.airborneArcHalfFlips - sim.airborneCount);
  if (!c.ok) rejects.set(c.reject, (rejects.get(c.reject) || 0) + 1);
  if (sim.settled) {
    const pred = predictHalfFlips(omega, LAUNCH.y0, vy);
    predErrSum += (c.meta.halfFlips - pred) / Math.max(1, pred);
    predErrN++;
  }
  rows.push({ vy, omega, hf: c.meta.halfFlips, ok: c.ok, reject: c.reject,
    dur: c.meta.durationMs, quad: c.meta.quadrant, disp: c.diag.displacement,
    bounces: sim.bounces, spinY: params.spinY });
}
const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;

console.log(`=== blind sweep: ${N} sims in ${wallMs.toFixed(0)} ms (${(wallMs / N).toFixed(2)} ms/sim) ===\n`);

const ok = rows.filter((r) => r.ok);
console.log(`yield: ${ok.length}/${N} = ${((100 * ok.length) / N).toFixed(1)}%`);
console.log('reject reasons:', Object.fromEntries([...rejects].sort((a, b) => b[1] - a[1])));

const hfs = ok.map((r) => r.hf).sort((a, b) => a - b);
console.log(`\nhalf-flips over accepted clips: min ${hfs[0]}, max ${hfs[hfs.length - 1]}, ` +
  `median ${hfs[Math.floor(hfs.length / 2)]}`);
const hist = new Map();
for (const r of ok) hist.set(r.hf, (hist.get(r.hf) || 0) + 1);
console.log('half-flip histogram (accepted):');
const line = [];
for (let h = 4; h <= 46; h++) line.push(`${h}:${hist.get(h) || 0}`);
console.log('  ' + line.join(' '));

// coverage of the legal 8..40\{24} band
const legal = ok.filter((r) => r.hf >= 8 && r.hf <= 40 && r.hf !== 24);
const covered = new Set(legal.map((r) => r.hf));
console.log(`\nlegal-band hits: ${legal.length}/${N} (${((100 * legal.length) / N).toFixed(1)}%), ` +
  `distinct half-flip values reached: ${covered.size}/32`);
const missing = [];
for (let h = 8; h <= 40; h++) if (h !== 24 && !covered.has(h)) missing.push(h);
console.log(`values never reached in this sweep: ${missing.length ? missing.join(',') : 'none'}`);

const qh = new Map();
for (const r of legal) qh.set(r.quad, (qh.get(r.quad) || 0) + 1);
console.log('quadrant split:', Object.fromEntries([...qh].sort()));

console.log(`\nanalytic predictor bias: measured half-flips run ` +
  `${((predErrSum / predErrN) * 100).toFixed(1)}% vs prediction (so the Newton step needs 1-2 iterations)`);

excesses.sort((a, b) => a - b);
const pct = (p) => excesses[Math.floor(p * (excesses.length - 1))];
console.log(`\nairborne arc excess (arc/pi - count), clean tumble is [-0.33,+0.67]:`);
console.log(`  p1 ${pct(0.01).toFixed(2)}  p50 ${pct(0.5).toFixed(2)}  p95 ${pct(0.95).toFixed(2)}  ` +
  `p99 ${pct(0.99).toFixed(2)}  max ${excesses[excesses.length - 1].toFixed(2)}`);
console.log(`  gate is [${CLASSIFY.arcExcessMin}, ${CLASSIFY.arcExcessMax}]`);

const durs = ok.map((r) => r.dur).sort((a, b) => a - b);
console.log(`\nsettle duration (accepted): p5 ${durs[Math.floor(0.05 * durs.length)]}ms  ` +
  `median ${durs[Math.floor(0.5 * durs.length)]}ms  p95 ${durs[Math.floor(0.95 * durs.length)]}ms  ` +
  `max ${durs[durs.length - 1]}ms  (budget ${CLASSIFY.maxDurationMs}ms)`);
const disps = ok.map((r) => r.disp).sort((a, b) => a - b);
console.log(`displacement (accepted): min ${disps[0]}m  median ${disps[Math.floor(0.5 * disps.length)]}m  ` +
  `max ${disps[disps.length - 1]}m`);

// Does spinY correlate with the ambiguity rejection?
const amb = rows.filter((r) => r.reject === 'ambiguous-spin');
if (amb.length) {
  const meanAbsSpinAmb = amb.reduce((a, r) => a + Math.abs(r.spinY), 0) / amb.length;
  const meanAbsSpinOk = ok.reduce((a, r) => a + Math.abs(r.spinY), 0) / ok.length;
  console.log(`\nambiguous-spin rejects: mean |spinY| ${meanAbsSpinAmb.toFixed(2)} rad/s ` +
    `vs ${meanAbsSpinOk.toFixed(2)} for accepted clips`);
}
