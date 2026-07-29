// minigame/build-demo.mjs
// ---------------------------------------------------------------------------
// Inlines minigame/clean.js into a single self-contained clean-demo.html.
//
// WHY THERE IS A BUILD STEP AT ALL, on a project that prides itself on not
// having one. The demo has to be a single file with no imports so it can be
// published as a standalone artifact and opened on a phone. The payout rule has
// to live in ONE place, because it is the game's only money faucet and a copy
// that drifts from the tested one is a copy that pays the wrong amount.
//
// Those two requirements cannot both be met by hand. Twenty lines of concat is
// the cheapest way to satisfy both, and it means the page you play is running
// the exact source tools/verify-clean.mjs proved.
//
// Run: node minigame/build-demo.mjs
// ---------------------------------------------------------------------------
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const logic = (await fs.readFile(path.join(HERE, 'clean.js'), 'utf8'))
  // An inline <script type="module"> has no importer, so its exports are dead
  // weight. Strip the keyword rather than the declarations.
  .replace(/^export (const|function) /gm, '$1 ');

const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>COINFLIP — cleaning</title>
<style>
  body { font-family: "Google Sans", "Google Sans Text", sans-serif; margin:0;
         padding:40px 24px; display:flex; flex-direction:column; align-items:center; gap:20px; }
  #c { touch-action:none; cursor:grab; width:min(84vw, 340px); height:auto; display:block; }
  #c.scrubbing { cursor:grabbing; }
  #readout { font-weight:700; font-size:22px; font-variant-numeric:tabular-nums; }
  #readout.done { color:#1a9e3f; }
  #debugBar { margin-top:24px; padding-top:16px; border-top:1px solid #eee; width:min(84vw, 340px); }
  #debugBar button { font:inherit; color:#9a9a9a; background:none; border:1px solid #ddd;
                     padding:4px 10px; cursor:pointer; }
  #debugBar button:hover { color:black; border-color:black; }
  @media (prefers-color-scheme: dark) {
    body { background:#111; color:#eee; }
    #debugBar { border-top-color:#333; }
    #debugBar button { border-color:#333; }
    #debugBar button:hover { color:white; border-color:#888; }
  }
</style>
</head>
<body>

<canvas id="c" width="680" height="680"></canvas>
<div id="readout"><span id="pay">40</span> ₿</div>

<div id="debugBar"><button id="reset">reset</button></div>

<script type="module">
// ===== minigame/clean.js, inlined by minigame/build-demo.mjs =====
${logic}
// ===== view =====

const cv = document.getElementById('c');
const ctx = cv.getContext('2d');
const payEl = document.getElementById('pay');
const readout = document.getElementById('readout');

let game = createClean({ seed: (Math.random() * 1e6) | 0 });

// The dirt is drawn from the mask at grid resolution and scaled up. 64x64 over
// a 340 px coin is ~5 px a cell, and letting the browser smooth it is what turns
// a grid of numbers into grime — drawing crisp cells would read as pixel art.
const mask = document.createElement('canvas');
mask.width = mask.height = game.grid;
const mctx = mask.getContext('2d');
const img = mctx.createImageData(game.grid, game.grid);

function drawCoin(cx, cy, r) {
  // body
  const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
  g.addColorStop(0, '#e6e7ea');
  g.addColorStop(0.55, '#bfc1c7');
  g.addColorStop(1, '#8e9199');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();

  // rim
  ctx.lineWidth = r * 0.055; ctx.strokeStyle = '#7d8089';
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.965, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = r * 0.018; ctx.strokeStyle = '#9fa2aa';
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.86, 0, Math.PI * 2); ctx.stroke();

  // milled edge
  ctx.strokeStyle = '#83868f'; ctx.lineWidth = r * 0.02;
  for (let i = 0; i < 90; i++) {
    const a = (i / 90) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r * 0.975, cy + Math.sin(a) * r * 0.975);
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.stroke();
  }

  // a suggestion of engraving, not an attempt at the real coin
  ctx.strokeStyle = '#82858e'; ctx.lineWidth = r * 0.035; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.1, cy - r * 0.26);
  ctx.lineTo(cx + r * 0.02, cy - r * 0.36);
  ctx.lineTo(cx + r * 0.02, cy + r * 0.3);
  ctx.stroke();
  ctx.lineWidth = r * 0.022;
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.6, Math.PI * 0.75, Math.PI * 0.25); ctx.stroke();
}

function drawDirt(cx, cy, r) {
  const g = game.grid;
  const d = img.data;
  for (let j = 0; j < g; j++) {
    for (let i = 0; i < g; i++) {
      const k = j * g + i;
      const v = game.dirtAt(i, j);
      d[k * 4] = 58; d[k * 4 + 1] = 47; d[k * 4 + 2] = 34;
      d[k * 4 + 3] = Math.round(Math.min(1, v) * 236);
    }
  }
  mctx.putImageData(img, 0, 0);
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(mask, cx - r, cy - r, r * 2, r * 2);
  ctx.restore();
}

function render() {
  const w = cv.width; const h = cv.height;
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2; const cy = h / 2; const r = Math.min(w, h) * 0.44;
  drawCoin(cx, cy, r);
  drawDirt(cx, cy, r);
  payEl.textContent = game.payout;
  readout.classList.toggle('done', game.done);
}

/** Client px -> coin-normalised [-1,1]. */
function toCoin(ev) {
  const b = cv.getBoundingClientRect();
  const r = Math.min(b.width, b.height) * 0.44;
  return [(ev.clientX - (b.left + b.width / 2)) / r, (ev.clientY - (b.top + b.height / 2)) / r];
}

let down = false;
cv.addEventListener('pointerdown', (ev) => {
  down = true; cv.classList.add('scrubbing');
  try { cv.setPointerCapture(ev.pointerId); } catch {}
  const [x, y] = toCoin(ev); game.scrubTo(x, y); render();
  ev.preventDefault();
});
cv.addEventListener('pointermove', (ev) => {
  if (!down) return;
  const [x, y] = toCoin(ev); game.scrubTo(x, y); render();
  ev.preventDefault();
});
const release = () => { down = false; cv.classList.remove('scrubbing'); game.lift(); };
cv.addEventListener('pointerup', release);
cv.addEventListener('pointercancel', release);

// The hard cap can only fire from tick(), because a player who has stopped
// scrubbing emits no events.
(function loop() {
  if (game.tick()) render();
  requestAnimationFrame(loop);
}());

document.getElementById('reset').addEventListener('click', () => {
  game.reset((Math.random() * 1e6) | 0);
  render();
});

render();
</script>
</body>
</html>
`;

const out = path.join(HERE, 'clean-demo.html');
await fs.writeFile(out, page, 'utf8');
console.log(`wrote ${out} (${(page.length / 1024).toFixed(1)} kB, clean.js inlined)`);
