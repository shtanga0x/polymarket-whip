/**
 * Polymarket Whip — content script
 *
 * Space+W  → spawn whip at cursor
 * Move mouse fast to crack it at the chart
 * Each crack bumps the probability display upward
 * 3rd crack → 100% + celebration
 * 4th Space+W → full reset, deactivated until page reload
 */

// ─────────────────────────────────────────────────────────────────────────────
//  PHYSICS SETTINGS  (ported from badclaude overlay.html)
// ─────────────────────────────────────────────────────────────────────────────
const P = {
  segments:             28,
  segmentLength:        25,
  taper:                0.6,
  gravity:              1.2,
  dropGravity:          0.95,
  damping:              0.96,
  constraintIters:      20,
  maxStretchRatio:      1.2,
  baseTargetAngle:     -1.12,
  handleAimByMouseX:    0.4,
  handleAimByMouseY:    0.2,
  handleAimClamp:       2.0,
  handleSpring:         0.7,
  handleAngularDamping: 0.078,
  basePoseSegments:     2,
  basePoseStiffStart:   0.9,
  basePoseStiffEnd:     0.8,
  handleMaxBendDeg:     16,
  tipMaxBendDeg:        130,
  bendRigidityStart:    0.8,
  bendRigidityEnd:      0.12,
  wallBounce:           0.42,
  wallFriction:         0.86,
  crackSpeed:           340,
  crackCooldownMs:      200,
  firstCrackGraceMs:    350,
  lineWidthHandle:      7,
  lineWidthTip:         5,
  outlineWidth:         3,
  handleExtraWidth:     5,
  handleThickSegments:  2,
  bgAlpha:              0,       // transparent in extension (no window capture needed)
  arcWidth:             260,
  arcHeight:            185,
};

// ─────────────────────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────────────────────
let hitCount      = 0;          // number of successful cracks (0-3)
let deactivated   = false;      // true after 4th Space+W — until page reload
let whipPoints    = null;       // physics chain
let dropping      = false;
let whipActive    = false;      // is a whip currently alive?
let spaceHeld     = false;
let lastCrackTime = 0;
let whipSpawnTime = 0;
let handleAngle   = P.baseTargetAngle;
let handleAngVel  = 0;

let mouseX = window.innerWidth / 2;
let mouseY = window.innerHeight / 2;
let prevMouseX = mouseX;
let prevMouseY = mouseY;

let whipCanvas = null;   // full-page transparent canvas for the whip
let whipCtx    = null;
let rafId      = null;

// Snapshot of original probability text before we touched anything
let originalProbText = null;

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const clamp  = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp   = (a, b, t)   => a + (b - a) * t;
const wrapPi = a => {
  while (a >  Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

function segLen(i) {
  const t = i / (P.segments - 1);
  return P.segmentLength * (1 - t * (1 - P.taper));
}

// ─────────────────────────────────────────────────────────────────────────────
//  CRACK SOUND  (sounds/ must be copied from badclaude repo)
// ─────────────────────────────────────────────────────────────────────────────
const CRACK_FILES = ['A', 'B', 'C', 'D', 'E'];
function playCrack() {
  try {
    const name  = CRACK_FILES[Math.floor(Math.random() * CRACK_FILES.length)];
    const url   = chrome.runtime.getURL(`sounds/${name}.mp3`);
    const audio = new Audio(url);
    audio.play().catch(() => {});
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
//  POLYMARKET DOM HELPERS
//  Polymarket uses hashed class names — we find elements by content / role.
// ─────────────────────────────────────────────────────────────────────────────

/** Find the primary probability percentage text node (e.g. "67%"). */
function findProbabilityEl() {
  // Strategy 1: largest % number visible in the top portion of the page
  const all = Array.from(document.querySelectorAll('*'));
  let best = null;
  let bestSize = 0;
  for (const el of all) {
    if (el.children.length > 0) continue;         // leaf nodes only
    const txt = el.textContent.trim();
    if (!/^\d{1,3}%$/.test(txt)) continue;        // must be "XX%"
    const num = parseInt(txt);
    if (num < 1 || num > 99) continue;            // skip 0% or 100% — already done
    const rect = el.getBoundingClientRect();
    if (rect.top > window.innerHeight * 0.6) continue; // must be near top
    const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
    if (fs > bestSize) { bestSize = fs; best = el; }
  }
  return best;
}

/** Read current probability integer (0-100) from the DOM. */
function readProbability() {
  const el = findProbabilityEl();
  if (!el) return null;
  return parseInt(el.textContent);
}

/** Overwrite the probability text in the DOM and fight React re-renders. */
function setProbabilityText(value) {
  const el = findProbabilityEl();
  if (!el) return;

  const pct = `${Math.round(value)}%`;

  // Directly mutate the text — works even on React nodes
  el.textContent = pct;

  // Also look for number-flow-react shadow parts Polymarket uses
  const nf = el.closest('number-flow-react') || el.querySelector('number-flow-react');
  if (nf && nf.shadowRoot) {
    const span = nf.shadowRoot.querySelector('[part="integer"]') || nf.shadowRoot.querySelector('span');
    if (span) span.textContent = String(Math.round(value));
  }
}

/**
 * Find the SVG <path> that draws the probability line.
 * Polymarket renders a line chart in SVG; the probability path is
 * typically the last (topmost) <path> inside the chart SVG that has a stroke.
 */
function findChartSVGandPath() {
  // Find SVGs large enough to be a chart (>300px wide)
  const svgs = Array.from(document.querySelectorAll('svg'));
  let chartSVG = null;
  for (const svg of svgs) {
    const r = svg.getBoundingClientRect();
    if (r.width > 300 && r.height > 100) { chartSVG = svg; break; }
  }
  if (!chartSVG) return { svg: null, path: null };

  // The probability line: a <path> with a non-transparent stroke and no fill
  const paths = Array.from(chartSVG.querySelectorAll('path'));
  let linePath = null;
  for (let i = paths.length - 1; i >= 0; i--) {
    const s = getComputedStyle(paths[i]);
    const stroke = paths[i].getAttribute('stroke') || s.stroke;
    const fill   = paths[i].getAttribute('fill')   || s.fill;
    if (stroke && stroke !== 'none' && stroke !== 'rgba(0, 0, 0, 0)' &&
        (fill === 'none' || fill === 'transparent' || fill === 'rgba(0, 0, 0, 0)')) {
      linePath = paths[i];
      break;
    }
  }
  return { svg: chartSVG, path: linePath };
}

/**
 * Visually boost the probability line in the SVG.
 * We read all Y coordinates from the existing `d` attribute and shift them
 * upward (toward 100%) by `boostFraction` of the chart height.
 */
function boostChartLine(boostFraction) {
  const { svg, path } = findChartSVGandPath();
  if (!path) return;

  const svgRect = svg.getBoundingClientRect();
  const chartH  = svgRect.height;

  const d = path.getAttribute('d') || '';
  // Replace every Y coordinate in the path data by shifting upward
  // SVG path d="M x,y L x,y C x,y x,y x,y ..."
  // Y values in SVG increase downward; moving toward top = lower Y number
  const boosted = d.replace(/([ML])\s*([\d.eE+-]+)[,\s]([\d.eE+-]+)/g, (m, cmd, x, y) => {
    const newY = parseFloat(y) - boostFraction * chartH;
    return `${cmd}${x},${Math.max(0, newY)}`;
  }).replace(/([Cc])\s*([\d.eE+-]+)[,\s]([\d.eE+-]+)\s+([\d.eE+-]+)[,\s]([\d.eE+-]+)\s+([\d.eE+-]+)[,\s]([\d.eE+-]+)/g,
    (m, cmd, x1, y1, x2, y2, x, y) => {
      const shift = boostFraction * chartH;
      return `${cmd}${x1},${Math.max(0, parseFloat(y1) - shift)} ${x2},${Math.max(0, parseFloat(y2) - shift)} ${x},${Math.max(0, parseFloat(y) - shift)}`;
    }
  );
  path.setAttribute('d', boosted);
}

/** Snapshot the probability value and chart path before first modification. */
let originalChartD = null;
function snapshotOriginals() {
  if (originalProbText === null) {
    originalProbText = readProbability() ?? 50;
  }
  if (originalChartD === null) {
    const { path } = findChartSVGandPath();
    if (path) originalChartD = path.getAttribute('d');
  }
}

/** Restore everything to the pre-whip state. */
function restoreOriginals() {
  if (originalProbText !== null) {
    const el = findProbabilityEl();
    if (el) el.textContent = `${originalProbText}%`;
  }
  if (originalChartD !== null) {
    const { path } = findChartSVGandPath();
    if (path) path.setAttribute('d', originalChartD);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  CELEBRATION  —  Polymarket-style confetti burst
// ─────────────────────────────────────────────────────────────────────────────
let confettiPieces  = [];
let confettiCanvas  = null;
let confettiCtx     = null;
let confettiRaf     = null;
const CONFETTI_COLORS = [
  '#FF3366','#FF6B35','#FFD700','#00C9A7',
  '#5B8DEF','#C77DFF','#06D6A0','#EF476F',
];

function spawnCelebration() {
  if (confettiCanvas) return;

  confettiCanvas = document.createElement('canvas');
  Object.assign(confettiCanvas.style, {
    position:      'fixed',
    top:           '0',
    left:          '0',
    width:         '100vw',
    height:        '100vh',
    pointerEvents: 'none',
    zIndex:        '2147483646',
  });
  confettiCanvas.width  = window.innerWidth;
  confettiCanvas.height = window.innerHeight;
  document.body.appendChild(confettiCanvas);
  confettiCtx = confettiCanvas.getContext('2d');

  // Spawn particles from multiple cannons
  const cannons = [0.2, 0.4, 0.5, 0.6, 0.8];
  confettiPieces = [];
  for (const cx of cannons) {
    for (let i = 0; i < 60; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
      const speed = 8 + Math.random() * 14;
      confettiPieces.push({
        x:   confettiCanvas.width  * cx,
        y:   confettiCanvas.height * 0.6,
        vx:  Math.cos(angle) * speed,
        vy:  Math.sin(angle) * speed,
        rot: Math.random() * Math.PI * 2,
        rv:  (Math.random() - 0.5) * 0.3,
        w:   6 + Math.random() * 8,
        h:   3 + Math.random() * 5,
        color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
        alpha: 1,
        shape: Math.random() < 0.5 ? 'rect' : 'circle',
      });
    }
  }

  // Also add burst from top (fireworks style)
  for (let i = 0; i < 120; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 2 + Math.random() * 10;
    confettiPieces.push({
      x:   confettiCanvas.width  * (0.3 + Math.random() * 0.4),
      y:   confettiCanvas.height * (0.1 + Math.random() * 0.3),
      vx:  Math.cos(angle) * speed,
      vy:  Math.sin(angle) * speed,
      rot: Math.random() * Math.PI * 2,
      rv:  (Math.random() - 0.5) * 0.4,
      w:   4 + Math.random() * 7,
      h:   2 + Math.random() * 5,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      alpha: 1,
      shape: Math.random() < 0.3 ? 'circle' : 'rect',
    });
  }

  animateConfetti();
}

function animateConfetti() {
  confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);

  let alive = false;
  for (const p of confettiPieces) {
    p.vy  += 0.35;   // gravity
    p.vx  *= 0.99;   // air drag
    p.x   += p.vx;
    p.y   += p.vy;
    p.rot += p.rv;
    p.alpha -= 0.006;
    if (p.alpha <= 0) continue;
    alive = true;

    confettiCtx.save();
    confettiCtx.globalAlpha = Math.max(0, p.alpha);
    confettiCtx.translate(p.x, p.y);
    confettiCtx.rotate(p.rot);
    confettiCtx.fillStyle = p.color;

    if (p.shape === 'circle') {
      confettiCtx.beginPath();
      confettiCtx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
      confettiCtx.fill();
    } else {
      confettiCtx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    }
    confettiCtx.restore();
  }

  if (alive) {
    confettiRaf = requestAnimationFrame(animateConfetti);
  } else {
    confettiCanvas.remove();
    confettiCanvas = null;
    confettiCtx    = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  WHIP CANVAS SETUP
// ─────────────────────────────────────────────────────────────────────────────
function createWhipCanvas() {
  whipCanvas = document.createElement('canvas');
  Object.assign(whipCanvas.style, {
    position:      'fixed',
    top:           '0',
    left:          '0',
    width:         '100vw',
    height:        '100vh',
    pointerEvents: 'none',
    zIndex:        '2147483647',
  });
  whipCanvas.width  = window.innerWidth;
  whipCanvas.height = window.innerHeight;
  document.body.appendChild(whipCanvas);
  whipCtx = whipCanvas.getContext('2d');
  window.addEventListener('resize', () => {
    whipCanvas.width  = window.innerWidth;
    whipCanvas.height = window.innerHeight;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  WHIP PHYSICS  (ported 1:1 from badclaude overlay.html)
// ─────────────────────────────────────────────────────────────────────────────
function spawnWhip(mx, my) {
  dropping      = false;
  lastCrackTime = 0;
  whipSpawnTime = Date.now();
  const pts = [];
  for (let i = 0; i < P.segments; i++) {
    const t = i / (P.segments - 1);
    const x = mx + t * P.arcWidth;
    const y = my - Math.sin(t * Math.PI * 0.75) * P.arcHeight;
    pts.push({ x, y, px: x, py: y });
  }
  return pts;
}

function catmullPoint(pts, i) {
  const n = pts.length;
  if (n === 0) return { x: 0, y: 0 };
  if (i < 0)   return n >= 2 ? { x: 2*pts[0].x - pts[1].x, y: 2*pts[0].y - pts[1].y } : { ...pts[0] };
  if (i >= n)  return n >= 2 ? { x: 2*pts[n-1].x - pts[n-2].x, y: 2*pts[n-1].y - pts[n-2].y } : { ...pts[n-1] };
  return pts[i];
}

function whipSegBezier(pts, i) {
  const p0 = catmullPoint(pts, i - 1);
  const p1 = pts[i];
  const p2 = pts[i + 1];
  const p3 = catmullPoint(pts, i + 2);
  return {
    cp1x: p1.x + (p2.x - p0.x) / 6,
    cp1y: p1.y + (p2.y - p0.y) / 6,
    cp2x: p2.x - (p3.x - p1.x) / 6,
    cp2y: p2.y - (p3.y - p1.y) / 6,
    x2: p2.x, y2: p2.y,
  };
}

function updateHandleAim() {
  if (dropping) return;
  const mvx = mouseX - prevMouseX;
  const mvy = mouseY - prevMouseY;
  const delta = clamp(mvx * P.handleAimByMouseX + mvy * P.handleAimByMouseY,
                      -P.handleAimClamp, P.handleAimClamp);
  const target = P.baseTargetAngle + delta;
  const err = wrapPi(target - handleAngle);
  handleAngVel += err * P.handleSpring;
  handleAngVel *= P.handleAngularDamping;
  handleAngle = wrapPi(handleAngle + handleAngVel);
}

function applyBasePose() {
  if (!whipPoints || dropping) return;
  const dx = Math.cos(handleAngle);
  const dy = Math.sin(handleAngle);
  const guided = Math.min(P.basePoseSegments, whipPoints.length - 1);
  for (let i = 1; i <= guided; i++) {
    const t = (i - 1) / Math.max(guided - 1, 1);
    const stiff = lerp(P.basePoseStiffStart, P.basePoseStiffEnd, t);
    const prev = whipPoints[i - 1];
    const p    = whipPoints[i];
    const tl   = segLen(i - 1);
    p.x = lerp(p.x, prev.x + dx * tl, stiff);
    p.y = lerp(p.y, prev.y + dy * tl, stiff);
  }
}

function applyBendLimits() {
  if (!whipPoints || whipPoints.length < 3) return;
  for (let i = 1; i < whipPoints.length - 1; i++) {
    const a = whipPoints[i - 1];
    const b = whipPoints[i];
    const c = whipPoints[i + 1];
    const v1x = a.x-b.x, v1y = a.y-b.y;
    const v2x = c.x-b.x, v2y = c.y-b.y;
    const l1 = Math.hypot(v1x, v1y) || 0.0001;
    const l2 = Math.hypot(v2x, v2y) || 0.0001;
    const n1x=v1x/l1, n1y=v1y/l1, n2x=v2x/l2, n2y=v2y/l2;
    const dot   = clamp(n1x*n2x + n1y*n2y, -1, 1);
    const angle = Math.acos(dot);
    const t = i / (whipPoints.length - 2);
    const maxBend = lerp(P.handleMaxBendDeg, P.tipMaxBendDeg, t) * Math.PI / 180;
    const bend = Math.PI - angle;
    if (bend <= maxBend) continue;
    const cross = n1x*n2y - n1y*n2x;
    const sign  = cross >= 0 ? 1 : -1;
    const targetA = Math.atan2(n1y, n1x) + sign * (Math.PI - maxBend);
    const tx = b.x + Math.cos(targetA) * l2;
    const ty = b.y + Math.sin(targetA) * l2;
    const rigidity = lerp(P.bendRigidityStart, P.bendRigidityEnd, t);
    c.x = lerp(c.x, tx, rigidity);
    c.y = lerp(c.y, ty, rigidity);
  }
}

function capStretch() {
  if (!whipPoints || whipPoints.length < 2) return;
  for (let i = 0; i < whipPoints.length - 1; i++) {
    const a = whipPoints[i], b = whipPoints[i+1];
    const dx = b.x-a.x, dy = b.y-a.y;
    const dist = Math.hypot(dx, dy) || 0.0001;
    const maxL = segLen(i) * P.maxStretchRatio;
    if (dist <= maxL) continue;
    const k = maxL / dist;
    b.x = a.x + dx*k;
    b.y = a.y + dy*k;
  }
}

function applyWalls() {
  if (!whipPoints || dropping) return;
  const W = window.innerWidth, H = window.innerHeight;
  for (let i = 1; i < whipPoints.length; i++) {
    const p = whipPoints[i];
    let vx = p.x - p.px, vy = p.y - p.py;
    let hit = false;
    if (p.x < 0)  { p.x=0;  if (vx<0) vx=-vx*P.wallBounce; vy*=P.wallFriction; hit=true; }
    if (p.x > W)  { p.x=W;  if (vx>0) vx=-vx*P.wallBounce; vy*=P.wallFriction; hit=true; }
    if (p.y < 0)  { p.y=0;  if (vy<0) vy=-vy*P.wallBounce; vx*=P.wallFriction; hit=true; }
    if (p.y > H)  { p.y=H;  if (vy>0) vy=-vy*P.wallBounce; vx*=P.wallFriction; hit=true; }
    if (hit) { p.px = p.x - vx; p.py = p.y - vy; }
  }
}

function physicsStep() {
  if (!whipPoints) return;

  const g = dropping ? P.dropGravity : P.gravity;
  updateHandleAim();

  const start = dropping ? 0 : 1;
  for (let i = start; i < whipPoints.length; i++) {
    const p  = whipPoints[i];
    const vx = (p.x - p.px) * P.damping;
    const vy = (p.y - p.py) * P.damping;
    p.px = p.x; p.py = p.y;
    p.x += vx; p.y += vy + g;
  }

  if (!dropping) {
    whipPoints[0].x = mouseX; whipPoints[0].y = mouseY;
    whipPoints[0].px = mouseX; whipPoints[0].py = mouseY;
  }

  capStretch();
  applyWalls();
  applyBasePose();

  for (let iter = 0; iter < P.constraintIters; iter++) {
    for (let i = 0; i < whipPoints.length - 1; i++) {
      const a = whipPoints[i], b = whipPoints[i+1];
      const dx = b.x-a.x, dy = b.y-a.y;
      const dist = Math.sqrt(dx*dx + dy*dy) || 0.0001;
      const diff = (dist - segLen(i)) / dist * 0.5;
      const ox = dx*diff, oy = dy*diff;
      if (i === 0 && !dropping) { b.x -= ox*2; b.y -= oy*2; }
      else { a.x += ox; a.y += oy; b.x -= ox; b.y -= oy; }
    }
    applyBendLimits();
    if (!dropping) applyBasePose();
    capStretch();
    applyWalls();
  }

  // Crack detection
  const tip    = whipPoints[whipPoints.length - 1];
  const tipVel = Math.hypot(tip.x - tip.px, tip.y - tip.py);
  const now    = Date.now();

  if (!dropping && tipVel > P.crackSpeed) {
    if (now - whipSpawnTime >= P.firstCrackGraceMs &&
        now - lastCrackTime  > P.crackCooldownMs) {
      lastCrackTime = now;
      playCrack();
      onWhipCrack();
    }
  }

  // Auto-drop after crack
  if (dropping && whipPoints.every(p => p.y > window.innerHeight + 60)) {
    whipPoints = null;
    dropping   = false;
    whipActive = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  RENDER WHIP
// ─────────────────────────────────────────────────────────────────────────────
function renderWhip() {
  if (!whipCtx) return;
  const W = whipCanvas.width, H = whipCanvas.height;
  whipCtx.clearRect(0, 0, W, H);
  if (!whipPoints || whipPoints.length < 2) return;

  whipCtx.lineCap  = 'round';
  whipCtx.lineJoin = 'round';

  // White outline pass (full spline)
  whipCtx.strokeStyle = '#fff';
  whipCtx.beginPath();
  whipCtx.moveTo(whipPoints[0].x, whipPoints[0].y);
  for (let i = 0; i < whipPoints.length - 1; i++) {
    const { cp1x, cp1y, cp2x, cp2y, x2, y2 } = whipSegBezier(whipPoints, i);
    whipCtx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);
  }
  whipCtx.lineWidth = P.lineWidthTip + P.outlineWidth * 2;
  whipCtx.stroke();

  // Thick handle outline
  const thick = Math.min(P.handleThickSegments, whipPoints.length - 1);
  if (thick > 0 && P.handleExtraWidth > 0) {
    whipCtx.beginPath();
    whipCtx.moveTo(whipPoints[0].x, whipPoints[0].y);
    for (let i = 0; i < thick; i++) {
      const { cp1x, cp1y, cp2x, cp2y, x2, y2 } = whipSegBezier(whipPoints, i);
      whipCtx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);
    }
    whipCtx.lineWidth = P.lineWidthHandle + P.handleExtraWidth + P.outlineWidth * 2;
    whipCtx.stroke();
  }

  // Dark core (segment by segment for variable width)
  whipCtx.strokeStyle = '#111';
  for (let i = 0; i < whipPoints.length - 1; i++) {
    const t     = i / Math.max(1, whipPoints.length - 2);
    const extra = i < P.handleThickSegments ? P.handleExtraWidth : 0;
    whipCtx.lineWidth = lerp(P.lineWidthHandle, P.lineWidthTip, t) + extra;
    const { cp1x, cp1y, cp2x, cp2y, x2, y2 } = whipSegBezier(whipPoints, i);
    whipCtx.beginPath();
    whipCtx.moveTo(whipPoints[i].x, whipPoints[i].y);
    whipCtx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);
    whipCtx.stroke();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ON CRACK — chart boost logic
// ─────────────────────────────────────────────────────────────────────────────
function onWhipCrack() {
  if (hitCount >= 3) return;

  snapshotOriginals();

  hitCount++;
  dropping = true;   // whip flies off after crack

  if (hitCount === 3) {
    // ── Hit 3: go to 100%, celebrate ──────────────────────────────────────
    setProbabilityText(100);
    boostChartLine(0.28); // shift line most of the way to the top
    setTimeout(spawnCelebration, 150);
  } else {
    // ── Hit 1 or 2: partial boost ─────────────────────────────────────────
    const boost      = originalProbText ?? 50;
    const remaining  = 100 - boost;
    // hit 1 → add 1/3 of remaining, hit 2 → add 2/3 of remaining
    const newVal = boost + (remaining * hitCount / 3);
    setProbabilityText(newVal);
    boostChartLine(0.09 * hitCount);  // subtle upward shift each hit
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ANIMATION LOOP
// ─────────────────────────────────────────────────────────────────────────────
function animLoop() {
  physicsStep();
  renderWhip();
  rafId = requestAnimationFrame(animLoop);
}

// ─────────────────────────────────────────────────────────────────────────────
//  KEYBOARD HANDLER
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.code === 'Space') spaceHeld = true;

  // Space + W
  if (e.code === 'KeyW' && spaceHeld) {
    e.preventDefault();
    e.stopImmediatePropagation();

    if (deactivated) return;

    if (hitCount >= 3) {
      // 4th activation — reset everything and deactivate
      restoreOriginals();
      hitCount      = 0;
      whipPoints    = null;
      whipActive    = false;
      dropping      = false;
      deactivated   = true;

      // Fade out confetti immediately if still running
      if (confettiCanvas) { confettiCanvas.remove(); confettiCanvas = null; }
      return;
    }

    if (whipActive) return;   // whip already flying

    whipActive  = true;
    handleAngle = P.baseTargetAngle;
    handleAngVel = 0;
    whipPoints  = spawnWhip(mouseX, mouseY);
  }
});

document.addEventListener('keyup', e => {
  if (e.code === 'Space') spaceHeld = false;
});

// ─────────────────────────────────────────────────────────────────────────────
//  MOUSE TRACKING
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('mousemove', e => {
  prevMouseX = mouseX;
  prevMouseY = mouseY;
  mouseX = e.clientX;
  mouseY = e.clientY;
}, { passive: true });

// ─────────────────────────────────────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────────────────────────────────────
createWhipCanvas();
animLoop();
