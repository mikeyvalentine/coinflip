// tools/qa-harness.mjs
// ---------------------------------------------------------------------------
// A DOM + clock stub rich enough to play the 2D game END TO END.
//
// The existing verifiers stub just enough DOM for the module to finish
// evaluating, then call pure functions. That finds maths bugs. It cannot find
// SEQUENCE bugs — money that balances in every function but not across a flip,
// a gate that holds alone but not while something else is in flight, a flow
// that dead-ends. Those need the real handlers run in the real order against
// state that persists, which is what this is for.
//
// Two things make that possible:
//   * localStorage actually stores, so save()/load() round-trip and a "session"
//     can be reloaded mid-life.
//   * setTimeout and requestAnimationFrame resolve IMMEDIATELY, and
//     performance.now() jumps far enough per frame that every count-up
//     completes on its first tick. A real flip is ~3 s of animation; without
//     this a single end-to-end flip would take longer than the whole suite.
//
// The clock the GAME reads for its rules (Date.now, for the cooldown timer) is
// separate and manually driven, because the cooldown is a rule and must be
// testable independently of animation.
// ---------------------------------------------------------------------------
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** An element that remembers what was done to it, so assertions can read it. */
function mkEl(sel) {
  const cls = new Set();
  const handlers = new Map();
  const el = {
    sel,
    value: '', textContent: '', innerHTML: '', placeholder: '', max: 0,
    offsetLeft: 0, offsetTop: 0, width: 300, height: 300,
    style: {}, dataset: {},
    classList: {
      add: (...c) => c.forEach((x) => cls.add(x)),
      remove: (...c) => c.forEach((x) => cls.delete(x)),
      toggle: (c, f) => (f === undefined
        ? (cls.has(c) ? cls.delete(c) : cls.add(c))
        : (f ? cls.add(c) : cls.delete(c))),
      contains: (c) => cls.has(c),
      _set: cls,
    },
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const a = handlers.get(type) || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    /** Fire a handler the page registered — this is how flows are driven. */
    fire(type, ev = {}) {
      const a = handlers.get(type) || [];
      return Promise.all(a.map((fn) => fn({ preventDefault() {}, ...ev })));
    },
    hasHandler: (type) => (handlers.get(type) || []).length > 0,
    prepend() {}, appendChild() {}, remove() {}, blur() {}, focus() {},
    // removeAttribute was missing, and its absence read as a PAGE bug: clearing
    // the landed-bearing marker threw "lm.removeAttribute is not a function" and
    // took the whole clean-and-rearm path down with it. A stub that omits a
    // standard DOM method does not test less, it reports the wrong thing — so
    // the gap is filled rather than the page bent around it.
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    hasAttribute: () => false,
    setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 300, right: 300, bottom: 300 }),
    getContext: () => ctx2d(),
    closest() { return el; },
    querySelector() { return el; },
    querySelectorAll() { return []; },
  };
  return el;
}

/** Enough of a 2D context that the cleaning minigame's view can draw. */
function ctx2d() {
  const noop = () => {};
  return {
    canvas: { width: 300, height: 300 },
    clearRect: noop, fillRect: noop, beginPath: noop, arc: noop, fill: noop,
    stroke: noop, moveTo: noop, lineTo: noop, save: noop, restore: noop,
    clip: noop, drawImage: noop, putImageData: noop, translate: noop, rotate: noop,
    createRadialGradient: () => ({ addColorStop: noop }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    set fillStyle(v) {}, get fillStyle() { return '#000'; },
    set strokeStyle(v) {}, get strokeStyle() { return '#000'; },
    set lineWidth(v) {}, get lineWidth() { return 1; },
    set lineCap(v) {}, get lineCap() { return 'butt'; },
    set imageSmoothingEnabled(v) {}, get imageSmoothingEnabled() { return true; },
  };
}

/**
 * Install the stub globals and evaluate a page's script block.
 *
 * @param {string} pageFile  e.g. 'coinflip-preview.html'
 * @param {string} probeSrc  JS appended to the module that exports its internals
 * @returns {Promise<object>} whatever the probe put on globalThis.__QA
 */
export async function loadPage(pageFile, probeSrc, opts = {}) {
  const store = new Map();
  const els = new Map();
  const getEl = (sel) => {
    if (!els.has(sel)) els.set(sel, mkEl(sel));
    return els.get(sel);
  };

  // The cooldown clock the GAME reads. Separate from the animation clock on
  // purpose: the cooldown is a RULE (bank yes / flip no) and has to be driven
  // independently of how long an animation happens to take.
  let gameNow = 1_000_000;

  globalThis.document = {
    querySelector: (s) => getEl(s),
    querySelectorAll: (s) => (els.has(s) ? [els.get(s)] : []),
    createElement: () => mkEl('created'),
    body: getEl('body'),
    addEventListener() {},
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { if (opts.storageThrows) throw new Error('QuotaExceeded'); store.set(k, String(v)); },
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };

  // Animation time: every frame jumps a long way so count-ups finish at once.
  let animNow = 0;
  globalThis.performance = { now: () => (animNow += 10_000) };
  globalThis.requestAnimationFrame = (fn) => { queueMicrotask(() => fn(performance.now())); return 1; };
  globalThis.cancelAnimationFrame = () => {};
  // setTimeout resolves immediately — a flip is ~3 s of scheduled animation and
  // an end-to-end suite cannot wait for it in real time.
  globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 1; };
  globalThis.clearTimeout = () => {};
  // Intervals are REGISTERED and driven by hand, not discarded. The game's
  // 500 ms tick is what fires the cleaning minigame's 20 s hard cap, and that
  // cap is the only thing that rescues a player who stops scrubbing below the
  // finish threshold. A harness that throws intervals away makes every such
  // player look permanently stranded — a dead end that is purely the test's.
  const intervals = [];
  globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  globalThis.clearInterval = (id) => { if (intervals[id - 1]) intervals[id - 1] = null; };
  const runIntervals = (times = 1) => {
    for (let i = 0; i < times; i++) for (const t of intervals) if (t) t.fn();
  };

  const realDateNow = Date.now;
  Date.now = () => gameNow;

  const html = await fs.readFile(path.join(ROOT, pageFile), 'utf8');
  const body = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];
  const tmp = path.join(ROOT, `_qa_probe_${Date.now()}_${Math.random().toString(36).slice(2)}.mjs`);
  await fs.writeFile(tmp, body + '\n' + probeSrc, 'utf8');
  try {
    await import('file://' + tmp.split(path.sep).join('/'));
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }

  const api = globalThis.__QA;
  // Attach the harness controls ONTO the probe object rather than spreading it.
  // Spreading evaluates every getter once and copies the VALUE, so `g.bet = x`
  // would set a dead own-property on the copy instead of calling the module's
  // setter — the page would never see the write, and every read afterwards
  // would show the stale snapshot. That cost an hour of chasing a game bug that
  // was really a test bug, which is the exact failure mode this whole pass
  // exists to find.
  const extras = {
    /** Fire the page's registered intervals, as a browser would. */
    tick: runIntervals,
    el: getEl,
    els,
    store,
    /** Move the cooldown clock. The game reads this via Date.now(). */
    setGameNow: (t) => { gameNow = t; },
    advanceGame: (ms) => { gameNow += ms; },
    get gameNow() { return gameNow; },
    restoreDate: () => { Date.now = realDateNow; },
    /** Let queued microtasks (the animation chain) drain. */
    settle: async (rounds = 400) => { for (let i = 0; i < rounds; i++) await Promise.resolve(); },
  };
  for (const [k, v] of Object.entries(extras)) {
    Object.defineProperty(api, k, { value: v, writable: true, configurable: true });
  }
  return api;
}
