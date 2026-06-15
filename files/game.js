// game.js  --  host-authoritative RTS over P2P.
// The host runs the full simulation each frame and broadcasts state snapshots
// ~10x/sec. Every client (including the host) sends commands; the host applies
// them. Clients never simulate: they render the latest snapshot with smoothing,
// compute their own fog of war, and handle selection locally.

import { TILE, MW, MH, WPX, HPX, POPCAP, genMap, baseBuildings, flagSpots, CORNERS } from './maps.js';

// ---------------------------------------------------------------- definitions
const UTYPES = ['builder', 'rifle', 'mg', 'bazooka', 'atgun', 'tank', 'arty'];
const BTYPES = ['hq', 'barracks', 'factory', 'bunker'];
const UIDX = {}; UTYPES.forEach((t, i) => UIDX[t] = i);
const BIDX = {}; BTYPES.forEach((t, i) => BIDX[t] = i);
const STANCES = ['aggressive', 'guard', 'hold'];

const DEFS = {
  builder: { name:'Builder',  short:'BUILD', hp:45,  dmg:3,  range:70,  sight:175, speed:52, rate:1.4,  cost:60,  pop:1, cls:'inf', vs:{inf:0.4,veh:0.1,bld:0.1}, r:6,  build:4 },
  rifle:   { name:'Rifleman', short:'RIFLE', hp:50,  dmg:7,  range:100, sight:190, speed:48, rate:0.7,  cost:60,  pop:1, cls:'inf', vs:{inf:1,veh:0.25,bld:0.3}, r:6,  build:3 },
  mg:      { name:'MG Team',  short:'MG',    hp:55,  dmg:5,  range:135, sight:200, speed:36, rate:0.18, cost:120, pop:2, cls:'inf', vs:{inf:1.3,veh:0.15,bld:0.2}, r:7, build:5, setup:true },
  bazooka: { name:'Bazooka',  short:'AT-INF',hp:42,  dmg:36, range:120, sight:190, speed:44, rate:2.3,  cost:120, pop:2, cls:'inf', vs:{inf:0.4,veh:1.4,bld:1}, r:6,  build:5 },
  atgun:   { name:'AT Gun',   short:'AT-GUN',hp:90,  dmg:48, range:200, sight:210, speed:24, rate:2.6,  cost:170, pop:2, cls:'veh', vs:{inf:0.4,veh:1.6,bld:0.8}, r:9, build:7, setup:true },
  tank:    { name:'Sherman',  short:'TANK',  hp:280, dmg:32, range:160, sight:220, speed:62, rate:1.8,  cost:260, pop:3, cls:'veh', vs:{inf:0.9,veh:1,bld:1}, r:13, build:9 },
  arty:    { name:'Howitzer', short:'ARTY',  hp:90,  dmg:60, range:320, sight:200, speed:32, rate:4.4,  cost:300, pop:3, cls:'veh', vs:{inf:1,veh:0.8,bld:1.5}, r:12, build:11, splash:46, minRange:90 },
};
const PRODUCE = { hq:['builder'], barracks:['rifle','mg','bazooka'], factory:['atgun','tank','arty'] };
const VET = [0, 70, 200];
const BUILDABLE = {
  barracks: { cost: 200, time: 16, hp: 460, w: 3, h: 2 },
  factory:  { cost: 320, time: 24, hp: 520, w: 3, h: 2 },
  bunker:   { cost: 140, time: 8,  hp: 340, w: 1, h: 1 },
};
const OWN_BLUE = '#5b9bff', ALLY_TEAL = '#46c4a0';
const ENEMY_PAL = ['#e0573d', '#d59b34', '#9b6fd0', '#cf5fa0'];

// ---------------------------------------------------------------- module state
let opts, net, isHost, mySlot, myTeam, slots, slotTeam, slotBonus;
let T, OCC;
let running = false, gameOver = false, winner = -1, time = 0;
let raf = 0, last = 0, snapAcc = 0, fogAcc = 0;

// host sim arrays
let units = [], buildings = [], projs = [], money = [], nextId = 1;
let botS = {};
let evbuf = [];

// shared visual
let parts = [], craters = [];

// client render mirror
let cu = new Map(), cbuild = [], cflags = [], clientMoney = [];

// selection (local on every client)
let selSet = new Set(), selBuilding = -1;

// fog
let vis, explored, fogCv, fogCtx;

// camera + dom
let cam = { x: 0, y: 0 };
let cv, ctx, mini, mc, bar, els = {};
const ti = (x, y) => x + y * MW;
const inMap = (x, y) => x >= 0 && y >= 0 && x < MW && y < MH;
const DPR = () => Math.min(devicePixelRatio || 1, 2);

// ---------------------------------------------------------------- helpers
function dims(type) {
  const w = (type === 'bunker' ? 1 : 3) * TILE, h = (type === 'bunker' ? 1 : 2) * TILE;
  return { w, h };
}
const pass = (tx, ty, cls) => {
  if (!inMap(tx, ty)) return false;
  if (OCC[ti(tx, ty)]) return false;
  const t = T[ti(tx, ty)];
  if (t === 2) return false;
  if (t === 1 && cls === 'veh') return false;
  return true;
};
const isForest = (px, py) => { const tx = px / TILE | 0, ty = py / TILE | 0; return inMap(tx, ty) && T[ti(tx, ty)] === 1; };

function canPlace(tx, ty, w, h) {
  for (let y = ty; y < ty + h; y++) for (let x = tx; x < tx + w; x++)
    if (!inMap(x, y) || OCC[ti(x, y)] || T[ti(x, y)] === 2) return false;
  return true;
}
function findBuildSpot(slot, w, h) {
  const hq = hqOf(slot); if (!hq) return null;
  for (let r = 3; r < 16; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
    const tx = hq.tx + dx, ty = hq.ty + dy;
    if (canPlace(tx, ty, w, h)) return { tx, ty };
  }
  return null;
}

function teamColor(owner, team) {
  if (team === myTeam) return owner === mySlot ? OWN_BLUE : ALLY_TEAL;
  return ENEMY_PAL[team % ENEMY_PAL.length];
}
function relIsEnemy(team) { return team !== myTeam; }

// ---------------------------------------------------------------- A* (host)
function findPath(sx, sy, ex, ey, cls) {
  sx = Math.max(0, Math.min(MW - 1, sx)); sy = Math.max(0, Math.min(MH - 1, sy));
  if (!pass(ex, ey, cls)) {
    let best = null, bd = 1e9;
    for (let r = 1; r < 7 && !best; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const nx = ex + dx, ny = ey + dy; if (pass(nx, ny, cls)) { const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = [nx, ny]; } }
    }
    if (!best) return null; ex = best[0]; ey = best[1];
  }
  const open = [], came = {}, g = {}, closed = {}, key = (x, y) => x + ',' + y;
  const h = (x, y) => (Math.abs(x - ex) + Math.abs(y - ey)) * 10;
  open.push({ x: sx, y: sy, f: h(sx, sy) }); g[key(sx, sy)] = 0;
  let it = 0;
  while (open.length && it++ < 6000) {
    let bi = 0; for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0], ck = key(cur.x, cur.y);
    if (closed[ck]) continue; closed[ck] = 1;
    if (cur.x === ex && cur.y === ey) {
      const path = []; let px = ex, py = ey, k = ck;
      while (k !== key(sx, sy)) { path.push([px * TILE + 16, py * TILE + 16]); const p = came[k]; px = p[0]; py = p[1]; k = key(px, py); }
      return path.reverse();
    }
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cur.x + dx, ny = cur.y + dy; if (!pass(nx, ny, cls)) continue;
      if (dx && dy && (!pass(cur.x + dx, cur.y, cls) || !pass(cur.x, cur.y + dy, cls))) continue;
      const nk = key(nx, ny); if (closed[nk]) continue;
      const cost = T[ti(nx, ny)] === 3 ? ((dx && dy) ? 11 : 8) : ((dx && dy) ? 14 : 10);
      const ng = g[ck] + cost;
      if (g[nk] === undefined || ng < g[nk]) { g[nk] = ng; came[nk] = [cur.x, cur.y]; open.push({ x: nx, y: ny, f: ng + h(nx, ny) }); }
    }
  }
  return null;
}

// ---------------------------------------------------------------- host: world setup
function mkBuilding(owner, type, tx, ty, hpOverride) {
  const team = slotTeam[owner];
  const hp = hpOverride || (type === 'hq' ? 780 : type === 'bunker' ? 340 : 460);
  const { w, h } = dims(type);
  const b = { id: nextId++, owner, team, type, tx, ty, x: tx * TILE, y: ty * TILE, w, h,
    hp, maxhp: hp, queue: [], prog: 0, dead: false, rally: null,
    sight: type === 'hq' ? 260 : type === 'bunker' ? 230 : 210, cool: 0, constructing: false, buildProg: 0 };
  b.cx = b.x + w / 2; b.cy = b.y + h / 2;
  buildings.push(b);
  const wt = w / TILE | 0, ht = h / TILE | 0;
  for (let y = ty; y < ty + ht; y++) for (let x = tx; x < tx + wt; x++) if (inMap(x, y)) OCC[ti(x, y)] = 1;
  return b;
}
function popOf(slot) { let p = 0; for (const u of units) if (u.owner === slot && !u.dead) p += DEFS[u.type].pop; return p; }
function hqOf(slot) { return buildings.find(b => b.owner === slot && b.type === 'hq' && !b.dead); }

function spawnUnit(owner, type, atB) {
  const team = slotTeam[owner], d = DEFS[type];
  const src = atB || buildings.find(b => b.owner === owner && (DEFS[type].cls === 'inf' ? b.type === 'barracks' : b.type === 'factory') && !b.dead) || hqOf(owner);
  if (!src) return null;
  const dir = src.cx < WPX / 2 ? 1 : -1;
  const u = { id: nextId++, owner, team, type, hp: d.hp, maxhp: d.hp,
    x: src.cx + dir * 50 + (Math.random() * 20 - 10), y: src.cy + (Math.random() * 50 - 25),
    face: dir > 0 ? 0 : Math.PI, cool: 0, target: null, path: null, pi: 0, dead: false,
    stance: 'aggressive', guardX: 0, guardY: 0, xp: 0, rank: 0, setupT: 0,
    buildTarget: null, attackMove: false };
  u.guardX = u.x; u.guardY = u.y;
  units.push(u);
  return u;
}

function setupWorld() {
  OCC = new Uint8Array(MW * MH);
  const n = slots.length;
  for (let s = 0; s < n; s++) {
    const corner = slots[s].corner;
    for (const spec of baseBuildings(corner)) {
      if (spec.type !== 'hq') continue;
      const b = mkBuilding(s, spec.type, spec.tx, spec.ty);
      b.rally = { x: WPX / 2 > b.cx ? b.cx + 110 : b.cx - 110, y: b.cy };
    }
    // starting forces: builders plus light infantry. The barracks and factory must be built.
    spawnUnit(s, 'builder'); spawnUnit(s, 'builder'); spawnUnit(s, 'rifle'); spawnUnit(s, 'rifle');
    money[s] = Math.round(700 * (1 + slotBonus[s] * 0.5));
    if (slots[s].type === 'bot') botS[s] = { timer: 2, wave: [], state: 'build' };
  }
}

// ---------------------------------------------------------------- host: commands
function issueMove(u, wx, wy) {
  u.target = null; u.attackMove = false; u.setupT = 0;
  const path = findPath(u.x / TILE | 0, u.y / TILE | 0, wx / TILE | 0, wy / TILE | 0, DEFS[u.type].cls);
  if (path) { if (path.length) path[path.length - 1] = [wx, wy]; u.path = path.length ? path : [[wx, wy]]; }
  else u.path = [[wx, wy]];
  u.pi = 0;
}
function ownUnits(ids, owner) { const set = new Set(ids); return units.filter(u => set.has(u.id) && u.owner === owner && !u.dead); }
function findEntity(id) { return units.find(u => u.id === id && !u.dead) || buildings.find(b => b.id === id && !b.dead); }
function buildingById(id) { return buildings.find(b => b.id === id && !b.dead); }

function queueUnit(b, type, owner) {
  const d = DEFS[type];
  if (!d || !PRODUCE[b.type] || !PRODUCE[b.type].includes(type)) return;
  if (b.dead || money[owner] < d.cost || b.queue.length >= 6) return;
  if (popOf(owner) + d.pop > POPCAP) return;
  money[owner] -= d.cost; b.queue.push(type);
}
function placeBuilding(owner, btype, builders, wx, wy) {
  const cfg = BUILDABLE[btype]; if (!cfg || !builders.length) return;
  const w = cfg.w, h = cfg.h;
  const tx = Math.floor(wx / TILE) - (w >> 1), ty = Math.floor(wy / TILE) - (h >> 1);
  if (!canPlace(tx, ty, w, h) || money[owner] < cfg.cost) return;
  money[owner] -= cfg.cost;
  const b = mkBuilding(owner, btype, tx, ty, 1);
  b.constructing = true; b.maxhp = cfg.hp; b.hp = Math.max(20, cfg.hp * 0.08); b.buildProg = 0; b.buildTime = cfg.time;
  builders.forEach(u => { u.buildTarget = b; u.target = null; issueMove(u, b.cx, b.cy); });
}
function applyCmd(cmd) {
  if (gameOver) return;
  const o = cmd.slot;
  if (cmd.c === 'move') {
    const set = ownUnits(cmd.ids, o);
    const cols = Math.ceil(Math.sqrt(set.length || 1));
    set.forEach((u, i) => { const ox = (i % cols - cols / 2 + 0.5) * 26, oy = (Math.floor(i / cols) - cols / 2 + 0.5) * 26;
      issueMove(u, cmd.x + ox, cmd.y + oy); u.guardX = cmd.x + ox; u.guardY = cmd.y + oy; });
  } else if (cmd.c === 'atk') {
    const t = findEntity(cmd.tid); if (t) ownUnits(cmd.ids, o).forEach(u => { u.target = t; u.path = null; u.attackMove = true; });
  } else if (cmd.c === 'stance') {
    ownUnits(cmd.ids, o).forEach(u => { u.stance = cmd.st; u.guardX = u.x; u.guardY = u.y; });
  } else if (cmd.c === 'rally') {
    const b = buildingById(cmd.bid); if (b && b.owner === o) b.rally = { x: cmd.x, y: cmd.y };
  } else if (cmd.c === 'prod') {
    const b = buildingById(cmd.bid); if (b && b.owner === o) queueUnit(b, cmd.type, o);
  } else if (cmd.c === 'build') {
    placeBuilding(o, cmd.btype, ownUnits(cmd.ids, o).filter(u => u.type === 'builder'), cmd.x, cmd.y);
  }
}
function emit(cmd) { cmd.slot = mySlot; if (isHost) applyCmd(cmd); else net.sendCmd(cmd); }

// ---------------------------------------------------------------- host: combat
function vetMul(u) { return 1 + u.rank * 0.18; }
function ev(e) { if (evbuf.length < 200) evbuf.push(e); }
function fire(u, tgt) {
  const d = DEFS[u.type]; u.cool = d.rate;
  const tx = tgt.cx !== undefined ? tgt.cx : tgt.x, ty = tgt.cy !== undefined ? tgt.cy : tgt.y;
  u.face = Math.atan2(ty - u.y, tx - u.x);
  const vcls = tgt.w ? 'bld' : DEFS[tgt.type].cls;
  const dmg = d.dmg * (d.vs[vcls] || 1) * vetMul(u);
  if (u.type === 'rifle' || u.type === 'mg' || u.type === 'builder') {
    const x2 = tx + (Math.random() * 10 - 5), y2 = ty + (Math.random() * 10 - 5);
    parts.push({ t: 'tracer', x: u.x, y: u.y, x2, y2, life: 0.08, max: 0.08, col: teamColor(u.owner, u.team) });
    ev({ k: 't', x: u.x | 0, y: u.y | 0, a: x2 | 0, b: y2 | 0, c: u.owner });
    hit(tgt, dmg * (!tgt.w && isForest(tgt.x, tgt.y) ? 0.6 : 1), u);
  } else {
    const speed = u.type === 'arty' ? 175 : u.type === 'atgun' ? 420 : 340;
    projs.push({ x: u.x, y: u.y, tx, ty, team: u.team, from: u.type, owner: u,
      vx: Math.cos(u.face) * speed, vy: Math.sin(u.face) * speed, dist: Math.hypot(tx - u.x, ty - u.y), trav: 0, tgt,
      splash: d.splash || 0, base: d, vmul: vetMul(u) });
    parts.push({ t: 'flash', x: u.x + Math.cos(u.face) * 16, y: u.y + Math.sin(u.face) * 16, life: 0.07, max: 0.07 });
    ev({ k: 'f', x: (u.x + Math.cos(u.face) * 16) | 0, y: (u.y + Math.sin(u.face) * 16) | 0 });
  }
}
function teamsAlive() {
  const set = new Set();
  for (const b of buildings) if (!b.dead && b.type === 'hq') set.add(b.team);
  return set;
}
function hit(tgt, dmg, attacker) {
  if (tgt.dead) return;
  tgt.hp -= dmg;
  if (attacker && !attacker.dead) { attacker.xp += dmg; while (attacker.rank < 2 && attacker.xp >= VET[attacker.rank + 1]) { attacker.rank++; attacker.maxhp *= 1.2; attacker.hp += attacker.maxhp * 0.2; } }
  if (tgt.hp <= 0) {
    tgt.dead = true;
    if (tgt.w) {
      parts.push({ t: 'boom', x: tgt.cx, y: tgt.cy, r: 62, life: 0.8, max: 0.8 });
      craters.push({ x: tgt.cx, y: tgt.cy, r: 30 });
      ev({ k: 'b', x: tgt.cx | 0, y: tgt.cy | 0, r: 62 });
      const wt = tgt.w / TILE | 0, ht = tgt.h / TILE | 0;
      for (let y = tgt.ty; y < tgt.ty + ht; y++) for (let x = tgt.tx; x < tgt.tx + wt; x++) if (inMap(x, y)) OCC[ti(x, y)] = 0;
      if (tgt.type === 'hq') {
        const alive = teamsAlive();
        if (alive.size <= 1) { winner = alive.size ? [...alive][0] : -1; gameOver = true; }
      }
    } else {
      const veh = DEFS[tgt.type].cls === 'veh';
      parts.push({ t: 'boom', x: tgt.x, y: tgt.y, r: veh ? 34 : 14, life: 0.5, max: 0.5 });
      if (veh) { craters.push({ x: tgt.x, y: tgt.y, r: 16 }); ev({ k: 'b', x: tgt.x | 0, y: tgt.y | 0, r: 34 }); }
    }
  }
}

// ---------------------------------------------------------------- host: bots
function botTick(slot, dt) {
  const st = botS[slot]; if (!st) return; const team = slotTeam[slot];
  st.timer -= dt; if (st.timer > 0) return; st.timer = 2.0;

  const myB = buildings.filter(b => b.owner === slot && !b.dead);
  const hasBar = myB.some(b => b.type === 'barracks' && !b.constructing);
  const hasFac = myB.some(b => b.type === 'factory' && !b.constructing);
  const makingBar = myB.some(b => b.type === 'barracks' && b.constructing);
  const makingFac = myB.some(b => b.type === 'factory' && b.constructing);
  const idleBuilder = units.find(u => u.owner === slot && u.type === 'builder' && !u.dead && !u.path && !u.buildTarget && !u.target);

  // base building comes first
  if (idleBuilder && !hasBar && !makingBar && money[slot] >= BUILDABLE.barracks.cost) {
    const s = findBuildSpot(slot, 3, 2); if (s) placeBuilding(slot, 'barracks', [idleBuilder], (s.tx + 1.5) * TILE, (s.ty + 1) * TILE);
  } else if (idleBuilder && hasBar && !hasFac && !makingFac && money[slot] >= BUILDABLE.factory.cost) {
    const s = findBuildSpot(slot, 3, 2); if (s) placeBuilding(slot, 'factory', [idleBuilder], (s.tx + 1.5) * TILE, (s.ty + 1) * TILE);
  }
  // keep a couple of builders alive
  const hq = myB.find(b => b.type === 'hq');
  const builderCount = units.filter(u => u.owner === slot && u.type === 'builder' && !u.dead).length;
  if (hq && builderCount < 2 && money[slot] >= DEFS.builder.cost && hq.queue.length < 2) queueUnit(hq, 'builder', slot);

  // unit production once the relevant building exists
  const bar = myB.find(b => b.type === 'barracks' && !b.constructing);
  const fac = myB.find(b => b.type === 'factory' && !b.constructing);
  if (bar || fac) {
    const r = Math.random(); let type = 'rifle';
    if (hasFac && r > 0.84) type = 'arty'; else if (hasFac && r > 0.64) type = 'tank';
    else if (hasFac && r > 0.52) type = 'atgun'; else if (r > 0.38) type = 'mg'; else if (r > 0.26) type = 'bazooka';
    const b = DEFS[type].cls === 'inf' ? bar : fac;
    if (b && money[slot] >= DEFS[type].cost && b.queue.length < 5 && popOf(slot) + DEFS[type].pop <= POPCAP) queueUnit(b, type, slot);
  }

  // gather and attack with combat units only, never builders
  const idle = units.filter(u => u.owner === slot && !u.dead && u.type !== 'builder' && !u.path && !u.target);
  if (st.state === 'build') {
    idle.forEach(u => { if (!st.wave.includes(u)) st.wave.push(u); });
    st.wave = st.wave.filter(u => !u.dead);
    if (st.wave.length >= 6) {
      st.state = 'attack';
      let tgt = null, bd = 1e9; const ax = st.wave[0].x, ay = st.wave[0].y;
      for (const e of buildings) if (!e.dead && e.team !== team && e.type === 'hq') { const d = Math.hypot(e.cx - ax, e.cy - ay); if (d < bd) { bd = d; tgt = e; } }
      if (tgt) st.wave.forEach((u, i) => issueMove(u, tgt.cx + (i % 3 - 1) * 34, tgt.cy + (Math.floor(i / 3) - 1) * 34));
    }
  } else {
    st.wave = st.wave.filter(u => !u.dead);
    if (!st.wave.length || !st.wave.some(u => u.path || u.target)) { st.state = 'build'; st.wave = []; }
  }
}

// ---------------------------------------------------------------- host: simulation
function sim(dt) {
  time += dt;
  // income
  for (let s = 0; s < slots.length; s++) {
    const flagCount = cflagOwnedBy(slotTeam[s]);
    money[s] += (9 + flagCount * 6) * (1 + slotBonus[s] * 0.4) * dt;
  }
  // buildings
  for (const b of buildings) {
    if (b.dead) continue;
    if (b.type === 'bunker' && !b.constructing) {
      b.cool -= dt;
      if (b.cool <= 0) {
        let best = null, bd = 190;
        for (const e of units) { if (e.dead || e.team === b.team) continue; const dd = Math.hypot(e.x - b.cx, e.y - b.cy); if (dd < bd) { bd = dd; best = e; } }
        if (best) { b.cool = 0.5; parts.push({ t: 'tracer', x: b.cx, y: b.cy - 10, x2: best.x, y2: best.y, life: 0.08, max: 0.08, col: teamColor(b.owner, b.team) });
          ev({ k: 't', x: b.cx | 0, y: (b.cy - 10) | 0, a: best.x | 0, b: best.y | 0, c: b.owner }); hit(best, 9 * (isForest(best.x, best.y) ? 0.6 : 1), null); }
      }
      continue;
    }
    if (!b.queue.length) continue;
    b.prog += dt;
    if (b.prog >= DEFS[b.queue[0]].build) {
      b.prog = 0; const type = b.queue.shift(); const u = spawnUnit(b.owner, type, b);
      if (u) { const ral = b.rally || { x: b.cx, y: b.cy }; issueMove(u, ral.x, ral.y); u.guardX = ral.x; u.guardY = ral.y; }
    }
  }
  // flags
  for (const f of flagsState) {
    const w = {};
    for (const u of units) { if (u.dead) continue; if (Math.hypot(u.x - f.x, u.y - f.y) < 72) w[u.team] = (w[u.team] || 0) + DEFS[u.type].pop; }
    let topT = -1, topW = 0, second = 0;
    for (const k in w) { const v = w[k]; if (v > topW) { second = topW; topW = v; topT = +k; } else if (v > second) second = v; }
    if (topT >= 0 && topW > second) {
      if (f.own === topT) { f.cap = Math.min(100, f.cap + dt * 30); }
      else { f.cap -= dt * 30; if (f.cap <= 0) { f.own = topT; f.cap = 0; } }
    }
  }
  // bots
  for (const s in botS) botTick(+s, dt);

  // units
  for (const u of units) {
    if (u.dead) continue;
    const d = DEFS[u.type]; u.cool -= dt;
    if (u.rank > 0 && u.hp < u.maxhp && !u.target) u.hp = Math.min(u.maxhp, u.hp + u.maxhp * 0.02 * dt);
    if (u.target && u.target.dead) u.target = null;

    if (u.type === 'builder') {
      if (u.buildTarget && !u.buildTarget.dead) {
        const b = u.buildTarget, dist = Math.hypot(b.cx - u.x, b.cy - u.y);
        if (dist < 46) { u.path = null;
          b.buildProg += dt / (b.buildTime || 8);
          b.hp = Math.min(b.maxhp, b.maxhp * (0.08 + 0.92 * b.buildProg));
          if (b.buildProg >= 1) { b.constructing = false; b.buildProg = 1; b.hp = b.maxhp; u.buildTarget = null; } }
      } else if (!u.target && !u.path) {
        let site = null, sd = 130;
        for (const b of buildings) { if (b.dead || b.team !== u.team || !b.constructing) continue; const dist = Math.hypot(b.cx - u.x, b.cy - u.y); if (dist < sd) { sd = dist; site = b; } }
        if (site) { u.buildTarget = site; issueMove(u, site.cx, site.cy); }
        else { let rep = null, rd = 70;
          for (const b of buildings) { if (b.dead || b.team !== u.team || b.constructing || b.hp >= b.maxhp) continue; const dist = Math.hypot(b.cx - u.x, b.cy - u.y); if (dist < rd) { rd = dist; rep = b; } }
          if (rep) rep.hp = Math.min(rep.maxhp, rep.hp + 22 * dt); }
      }
    }

    if (!u.target && u.stance !== 'hold' && u.type !== 'builder') {
      let best = null, bd = d.sight;
      for (const e of units) { if (e.dead || e.team === u.team) continue;
        let dist = Math.hypot(e.x - u.x, e.y - u.y); if (isForest(e.x, e.y)) dist /= 0.6;
        if (u.stance === 'guard' && Math.hypot(e.x - u.guardX, e.y - u.guardY) > 200) continue;
        if (dist < bd) { bd = dist; best = e; } }
      if (!best) for (const b of buildings) { if (b.dead || b.team === u.team) continue;
        const dist = Math.hypot(b.cx - u.x, b.cy - u.y); if (dist < bd && (u.attackMove || u.stance === 'aggressive')) { bd = dist; best = b; } }
      if (best) u.target = best;
    }

    let mvx = 0, mvy = 0, wantFire = false;
    if (u.target) {
      const tx = u.target.cx !== undefined ? u.target.cx : u.target.x, ty = u.target.cy !== undefined ? u.target.cy : u.target.y;
      const dist = Math.hypot(tx - u.x, ty - u.y), minR = d.minRange || 0;
      const canChase = u.stance === 'aggressive' || u.attackMove || (u.stance === 'guard' && Math.hypot(tx - u.guardX, ty - u.guardY) < 220);
      if (dist <= d.range && dist >= minR) {
        wantFire = true;
        if (d.setup) { u.setupT = Math.min((u.setupT || 0) + dt, 0.6); if (u.setupT >= 0.55 && u.cool <= 0) fire(u, u.target); }
        else if (u.cool <= 0) fire(u, u.target);
      } else if (dist < minR) { mvx = (u.x - tx) / dist; mvy = (u.y - ty) / dist; }
      else if (canChase) {
        u.setupT = 0;
        const nx = (u.x + (tx - u.x) / dist * TILE) / TILE | 0, ny = (u.y + (ty - u.y) / dist * TILE) / TILE | 0;
        if (pass(nx, ny, d.cls)) { mvx = (tx - u.x) / dist; mvy = (ty - u.y) / dist; }
        else if (!u.path) { const sav = u.target; issueMove(u, tx, ty); u.target = sav; }
      } else u.target = null;
      if (!wantFire) u.setupT = Math.max(0, (u.setupT || 0) - dt * 2);
    }
    if (u.path) {
      const wp = u.path[u.pi];
      if (wp) { const dist = Math.hypot(wp[0] - u.x, wp[1] - u.y);
        if (dist < 9) { u.pi++; if (u.pi >= u.path.length) u.path = null; }
        else { mvx = (wp[0] - u.x) / dist; mvy = (wp[1] - u.y) / dist; } }
      else u.path = null;
    }
    if (mvx || mvy) {
      u.face = Math.atan2(mvy, mvx);
      let spd = d.speed; const ttx = Math.max(0, Math.min(MW - 1, u.x / TILE | 0)), tty = Math.max(0, Math.min(MH - 1, u.y / TILE | 0));
      if (T[ti(ttx, tty)] === 3) spd *= 1.3;
      const nx = u.x + mvx * spd * dt, ny = u.y + mvy * spd * dt;
      if (pass(nx / TILE | 0, u.y / TILE | 0, d.cls)) u.x = nx;
      if (pass(u.x / TILE | 0, ny / TILE | 0, d.cls)) u.y = ny;
    }
    for (const o of units) { if (o === u || o.dead) continue;
      const dx = u.x - o.x, dy = u.y - o.y, dist = Math.hypot(dx, dy), min = d.r + DEFS[o.type].r + 2;
      if (dist > 0 && dist < min) { const push = (min - dist) / 2; u.x += dx / dist * push * dt * 8; u.y += dy / dist * push * dt * 8; } }
    u.x = Math.max(8, Math.min(WPX - 8, u.x)); u.y = Math.max(8, Math.min(HPX - 8, u.y));
  }

  // projectiles
  for (const p of projs) {
    if (p.done) continue;
    p.trav += Math.hypot(p.vx, p.vy) * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.trav >= p.dist) {
      p.done = true;
      parts.push({ t: 'boom', x: p.tx, y: p.ty, r: p.splash || 12, life: 0.4, max: 0.4 });
      ev({ k: 'b', x: p.tx | 0, y: p.ty | 0, r: p.splash || 12 });
      if (p.splash) {
        craters.push({ x: p.tx, y: p.ty, r: 18 });
        for (const u of units) { if (u.dead || u.team === p.team) continue; const dist = Math.hypot(u.x - p.tx, u.y - p.ty);
          if (dist < p.splash) { let dm = p.base.dmg * (p.base.vs[DEFS[u.type].cls] || 1) * p.vmul * (1 - dist / p.splash * 0.5); if (isForest(u.x, u.y)) dm *= 0.6; hit(u, dm, p.owner && !p.owner.dead ? p.owner : null); } }
        for (const b of buildings) { if (b.dead || b.team === p.team) continue; if (Math.hypot(b.cx - p.tx, b.cy - p.ty) < p.splash + 28) hit(b, p.base.dmg * (p.base.vs.bld || 1) * p.vmul, p.owner && !p.owner.dead ? p.owner : null); }
      } else if (p.tgt && !p.tgt.dead) {
        let dm = p.base.dmg * (p.base.vs[p.tgt.w ? 'bld' : DEFS[p.tgt.type].cls] || 1) * p.vmul;
        if (!p.tgt.w && isForest(p.tgt.x, p.tgt.y)) dm *= 0.6;
        hit(p.tgt, dm, p.owner && !p.owner.dead ? p.owner : null);
      }
    }
  }
  for (let i = projs.length - 1; i >= 0; i--) if (projs[i].done) projs.splice(i, 1);
  for (let i = units.length - 1; i >= 0; i--) if (units[i].dead) units.splice(i, 1);
}
function cflagOwnedBy(team) { let n = 0; for (const f of flagsState) if (f.own === team) n++; return n; }

// flags live on host as flagsState; clients use cflags
let flagsState = [];

// ---------------------------------------------------------------- snapshots
function snapshot() {
  const u = [];
  for (const e of units) { if (e.dead) continue;
    u.push(e.id, e.owner, UIDX[e.type], Math.round(e.x), Math.round(e.y), Math.round(e.hp), Math.round(e.maxhp), Math.round(e.face * 100), e.rank, STANCES.indexOf(e.stance)); }
  const b = [];
  for (const e of buildings) { if (e.dead) continue;
    b.push(e.id, e.owner, BIDX[e.type], Math.round(e.x), Math.round(e.y), Math.round(e.hp), Math.round(e.maxhp), e.queue.length, Math.round(e.prog * 100), e.constructing ? 1 : 0, Math.round((e.buildProg || 0) * 100), e.queue[0] ? UIDX[e.queue[0]] : -1); }
  const f = []; for (const fl of flagsState) f.push(fl.own, Math.round(fl.cap));
  const evs = evbuf.slice(0, 80); evbuf.length = 0;
  return { u, b, f, m: money.map(v => Math.round(v)), o: gameOver ? winner : -2, ev: evs };
}
function applySnap(s) {
  const seen = new Set();
  for (let i = 0; i < s.u.length; i += 10) {
    const id = s.u[i]; seen.add(id);
    let o = cu.get(id);
    const x = s.u[i + 3], y = s.u[i + 4];
    if (!o) { o = { id, x, y }; cu.set(id, o); }
    o.owner = s.u[i + 1]; o.type = UTYPES[s.u[i + 2]]; o.tx = x; o.ty = y;
    o.hp = s.u[i + 5]; o.maxhp = s.u[i + 6]; o.face = s.u[i + 7] / 100; o.rank = s.u[i + 8];
    o.stance = STANCES[s.u[i + 9]] || 'aggressive'; o.team = slotTeam[o.owner];
  }
  for (const id of [...cu.keys()]) if (!seen.has(id)) cu.delete(id);

  cbuild = [];
  for (let i = 0; i < s.b.length; i += 12) {
    const type = BTYPES[s.b[i + 2]]; const { w, h } = dims(type); const x = s.b[i + 3], y = s.b[i + 4];
    cbuild.push({ id: s.b[i], owner: s.b[i + 1], team: slotTeam[s.b[i + 1]], type, x, y, w, h, cx: x + w / 2, cy: y + h / 2,
      hp: s.b[i + 5], maxhp: s.b[i + 6], qlen: s.b[i + 7], prog: s.b[i + 8] / 100, constructing: s.b[i + 9], buildProg: s.b[i + 10] / 100, qtype: s.b[i + 11] });
  }
  for (let i = 0; i < s.f.length; i += 2) { if (cflags[i / 2]) { cflags[i / 2].own = s.f[i]; cflags[i / 2].cap = s.f[i + 1]; } }
  clientMoney = s.m;
  for (const e of s.ev) spawnEvent(e);
  if (s.o !== -2) { winner = s.o; if (!gameOver) { gameOver = true; showEnd(); } }
}
function spawnEvent(e) {
  if (e.k === 't') parts.push({ t: 'tracer', x: e.x, y: e.y, x2: e.a, y2: e.b, life: 0.08, max: 0.08, col: teamColorByOwner(e.c) });
  else if (e.k === 'f') parts.push({ t: 'flash', x: e.x, y: e.y, life: 0.07, max: 0.07 });
  else if (e.k === 'b') { parts.push({ t: 'boom', x: e.x, y: e.y, r: e.r, life: e.r > 40 ? 0.7 : 0.45, max: e.r > 40 ? 0.7 : 0.45 }); if (e.r > 14) craters.push({ x: e.x, y: e.y, r: e.r * 0.45 }); }
}
function teamColorByOwner(owner) { return teamColor(owner, slotTeam[owner] ?? 0); }

// ---------------------------------------------------------------- world accessor
function world() {
  if (isHost) return { units, buildings, flags: flagsState, money: money[mySlot] | 0 };
  return { units: [...cu.values()], buildings: cbuild, flags: cflags, money: (clientMoney[mySlot] | 0) };
}

// ---------------------------------------------------------------- fog
function computeFog() {
  vis.fill(0);
  const W = world();
  const stamp = (cx, cy, rt) => {
    const x0 = Math.max(0, cx - rt), x1 = Math.min(MW - 1, cx + rt), y0 = Math.max(0, cy - rt), y1 = Math.min(MH - 1, cy + rt);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const dx = x - cx, dy = y - cy; if (dx * dx + dy * dy <= rt * rt) { vis[ti(x, y)] = 1; explored[ti(x, y)] = 1; } }
  };
  for (const u of W.units) if (u.team === myTeam) stamp(u.x / TILE | 0, u.y / TILE | 0, DEFS[u.type].sight / TILE | 0);
  for (const b of W.buildings) if (b.team === myTeam && !b.constructing) stamp(b.cx / TILE | 0, b.cy / TILE | 0, (b.type === 'hq' ? 260 : b.type === 'bunker' ? 230 : 210) / TILE | 0);
  const img = fogCtx.createImageData(MW, MH);
  for (let i = 0; i < MW * MH; i++) { let a = 255; if (vis[i]) a = 0; else if (explored[i]) a = 130; img.data[i * 4 + 3] = a; }
  fogCtx.putImageData(img, 0, 0);
}
const tileVisible = (px, py) => { const tx = px / TILE | 0, ty = py / TILE | 0; return inMap(tx, ty) && vis[ti(tx, ty)]; };
const tileExplored = (px, py) => { const tx = px / TILE | 0, ty = py / TILE | 0; return inMap(tx, ty) && explored[ti(tx, ty)]; };

// ---------------------------------------------------------------- client smoothing
function easeClient(dt) {
  const k = 1 - Math.pow(0.0001, dt);
  for (const o of cu.values()) { o.x += (o.tx - o.x) * k; o.y += (o.ty - o.y) * k; }
}

// ---------------------------------------------------------------- terrain prerender
let tcv, tc;
function prerenderTerrain(seed) {
  const rnd = (x, y) => { let h = (x * 374761393 + y * 668265263 + seed * 2654435761) >>> 0; h = (h ^ (h >> 13)) * 1274126177; return ((h ^ (h >> 16)) >>> 0) / 4294967295; };
  tcv = document.createElement('canvas'); tcv.width = WPX; tcv.height = HPX; tc = tcv.getContext('2d');
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    const t = T[ti(x, y)], px = x * TILE, py = y * TILE, v = rnd(x, y);
    if (t === 2) tc.fillStyle = `rgb(${50 + v * 12 | 0},${80 + v * 14 | 0},${116 + v * 16 | 0})`;
    else if (t === 3) tc.fillStyle = `rgb(${120 + v * 16 | 0},${102 + v * 14 | 0},${72 + v * 10 | 0})`;
    else tc.fillStyle = `rgb(${72 + v * 18 | 0},${90 + v * 20 | 0},${44 + v * 14 | 0})`;
    tc.fillRect(px, py, TILE, TILE);
    if (t === 1) for (let k = 0; k < 3; k++) { const ox = rnd(x * 3 + k, y) * 22 + 5, oy = rnd(x, y * 3 + k) * 22 + 5;
      tc.fillStyle = 'rgba(18,38,14,.8)'; tc.beginPath(); tc.arc(px + ox + 2, py + oy + 2, 7, 0, 7); tc.fill();
      tc.fillStyle = `rgb(${34 + v * 20 | 0},${70 + v * 22 | 0},28)`; tc.beginPath(); tc.arc(px + ox, py + oy, 7, 0, 7); tc.fill(); }
    if (t === 3 && rnd(x * 7, y * 7) > .6) { tc.fillStyle = 'rgba(68,56,38,.5)'; tc.fillRect(px + 6, py + 14, 20, 3); }
  }
}

// ---------------------------------------------------------------- input
const ptrs = new Map();
let selBox = null, panLast = null, buildMode = null;
const scr2w = (px, py) => [px + cam.x, py + cam.y];
function clampCam() { cam.x = Math.max(0, Math.min(WPX - innerWidth, cam.x)); cam.y = Math.max(0, Math.min(HPX - innerHeight, cam.y)); }
function avgPtr() { let x = 0, y = 0; for (const p of ptrs.values()) { x += p.x; y += p.y; } return { x: x / ptrs.size, y: y / ptrs.size }; }
function ping(x, y, col) { parts.push({ t: 'ring', x, y, r: 6, life: 0.5, max: 0.5, col }); }

function mySelUnits() { const W = world(); return W.units.filter(u => selSet.has(u.id) && u.owner === mySlot); }

function onDown(e) {
  if (!running || gameOver) return;
  cv.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, btn: e.button });
  if (ptrs.size === 2) { selBox = null; panLast = avgPtr(); }
}
function onMove(e) {
  const p = ptrs.get(e.pointerId); if (!p) return; p.x = e.clientX; p.y = e.clientY;
  if (Math.hypot(p.x - p.sx, p.y - p.sy) > 10) p.moved = true;
  if (ptrs.size >= 2 || p.btn === 2) { const a = ptrs.size >= 2 ? avgPtr() : p; if (panLast) { cam.x -= a.x - panLast.x; cam.y -= a.y - panLast.y; clampCam(); } panLast = { x: a.x, y: a.y }; selBox = null; }
  else if (p.moved && p.btn === 0) selBox = { x1: p.sx, y1: p.sy, x2: p.x, y2: p.y };
}
function onUp(e) {
  const p = ptrs.get(e.pointerId); ptrs.delete(e.pointerId);
  panLast = ptrs.size >= 1 ? avgPtr() : null;
  if (!p || !running || gameOver || p.btn === 2) return;
  const W = world();
  if (selBox && p.moved) {
    const [wx1, wy1] = scr2w(Math.min(selBox.x1, selBox.x2), Math.min(selBox.y1, selBox.y2));
    const [wx2, wy2] = scr2w(Math.max(selBox.x1, selBox.x2), Math.max(selBox.y1, selBox.y2));
    selSet.clear(); selBuilding = -1;
    W.units.forEach(u => { if (u.owner === mySlot && u.x >= wx1 && u.x <= wx2 && u.y >= wy1 && u.y <= wy2) selSet.add(u.id); });
    selBox = null; buildUI(); return;
  }
  selBox = null; if (p.moved) return;
  const [wx, wy] = scr2w(p.x, p.y);

  if (buildMode) {
    const type = buildMode; buildMode = null;
    const ids = [...mySelUnits()].filter(u => u.type === 'builder').map(u => u.id);
    if (ids.length) emit({ c: 'build', btype: type, ids, x: wx, y: wy });
    ping(wx, wy, '#9fd06a'); return;
  }

  // own building
  let ownB = null;
  for (const b of W.buildings) if (b.owner === mySlot && b.type !== 'bunker' && wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h) { ownB = b; break; }
  if (ownB) { if (selBuilding === ownB.id) { selBuilding = -1; } else { selSet.clear(); selBuilding = ownB.id; ping(ownB.cx, ownB.cy, '#9fd06a'); } buildUI(); return; }

  // own unit
  let own = null;
  for (const u of W.units) if (u.owner === mySlot && Math.hypot(u.x - wx, u.y - wy) < 18) { own = u; break; }
  if (own) { selSet.clear(); selSet.add(own.id); selBuilding = -1; buildUI(); return; }

  // building selected -> rally
  if (selBuilding >= 0) { emit({ c: 'rally', bid: selBuilding, x: wx, y: wy }); ping(wx, wy, '#9fd06a'); return; }

  // enemy target
  let tgt = null;
  for (const u of W.units) if (relIsEnemy(u.team) && tileVisible(u.x, u.y) && Math.hypot(u.x - wx, u.y - wy) < 18) { tgt = u; break; }
  if (!tgt) for (const b of W.buildings) if (relIsEnemy(b.team) && tileExplored(b.cx, b.cy) && wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h) { tgt = b; break; }
  const selU = [...mySelUnits()];
  if (tgt && selU.length) { emit({ c: 'atk', ids: selU.map(u => u.id), tid: tgt.id }); ping(wx, wy, '#d06a6a'); return; }

  if (selU.length) { emit({ c: 'move', ids: selU.map(u => u.id), x: wx, y: wy }); ping(wx, wy, '#e8e4c9'); }
  else { selSet.clear(); selBuilding = -1; buildUI(); }
}

const keys = {}, ctrlGroups = {}; let keyHold = {};
function onKeyDown(e) {
  keys[e.code] = true;
  const n = parseInt(e.key);
  if (n >= 1 && n <= 9 && !keyHold[e.key]) keyHold[e.key] = setTimeout(() => { ctrlGroups[n] = [...selSet]; toast('Group ' + n + ' set'); renderGroups(); }, 350);
}
function onKeyUp(e) {
  keys[e.code] = false;
  const n = parseInt(e.key);
  if (n >= 1 && n <= 9 && keyHold[e.key]) { clearTimeout(keyHold[e.key]); keyHold[e.key] = null; selectGroup(n); }
}
function selectGroup(n) {
  const ids = ctrlGroups[n]; if (!ids || !ids.length) return;
  const W = world(); const live = new Set(W.units.filter(u => u.owner === mySlot).map(u => u.id));
  selSet = new Set(ids.filter(id => live.has(id))); selBuilding = -1; buildUI();
  const g = W.units.filter(u => selSet.has(u.id)); if (g.length) { let x = 0, y = 0; g.forEach(u => { x += u.x; y += u.y; }); cam.x = x / g.length - innerWidth / 2; cam.y = y / g.length - innerHeight / 2; clampCam(); }
}

// ---------------------------------------------------------------- UI
function mkBtn(label, cost, cls, onTap) {
  const b = document.createElement('button'); b.className = 'ubtn' + (cls ? ' ' + cls : '');
  b.innerHTML = label + (cost != null ? '<br><span class="cost">$' + cost + '</span>' : '') + '<span class="q"></span>';
  b.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); onTap(b); });
  return b;
}
function startBuild(type) { buildMode = type; toast('Tap ground to place ' + type.toUpperCase()); }
function buildUI() {
  bar.innerHTML = '';
  const W = world();
  if (selBuilding >= 0) {
    const b = W.buildings.find(x => x.id === selBuilding);
    if (b) (PRODUCE[b.type] || []).forEach(type => {
      const d = DEFS[type]; const btn = mkBtn(d.short, d.cost, '', () => emit({ c: 'prod', bid: b.id, type }));
      btn._type = type; bar.appendChild(btn);
    });
  } else {
    const selU = [...mySelUnits()];
    if (selU.length) {
      [['aggressive', 'ATTACK'], ['guard', 'GUARD'], ['hold', 'HOLD']].forEach(([st, lbl]) => {
        const btn = mkBtn(lbl, null, '', () => { emit({ c: 'stance', ids: selU.map(u => u.id), st }); });
        if (selU.every(u => u.stance === st)) btn.classList.add('act');
        bar.appendChild(btn);
      });
      if (selU.some(u => u.type === 'builder')) {
        bar.appendChild(mkBtn('BARRACKS', BUILDABLE.barracks.cost, '', () => startBuild('barracks')));
        bar.appendChild(mkBtn('FACTORY', BUILDABLE.factory.cost, '', () => startBuild('factory')));
        bar.appendChild(mkBtn('BUNKER', BUILDABLE.bunker.cost, '', () => startBuild('bunker')));
      }
    }
  }
  bar.appendChild(mkBtn('ALL', null, 'sys', () => { const W2 = world(); selSet = new Set(W2.units.filter(u => u.owner === mySlot).map(u => u.id)); selBuilding = -1; buildUI(); }));
  bar.appendChild(mkBtn('MENU', null, 'sys', () => leave()));
}
function renderGroups() {
  els.groups.innerHTML = '';
  const W = world(); const mine = new Set(W.units.filter(u => u.owner === mySlot).map(u => u.id));
  for (let n = 1; n <= 4; n++) {
    const ids = (ctrlGroups[n] || []).filter(id => mine.has(id));
    const g = document.createElement('div'); g.className = 'grp' + (ids.length ? '' : ' empty');
    g.innerHTML = n + '<small>' + (ids.length || '') + '</small>';
    g.addEventListener('pointerdown', e => { e.preventDefault(); if (ids.length) selectGroup(n); else { ctrlGroups[n] = [...selSet]; renderGroups(); if (ctrlGroups[n].length) toast('Group ' + n + ' set'); } });
    els.groups.appendChild(g);
  }
}
let toastT = 0;
function toast(m) { els.toast.textContent = m; els.toast.classList.add('show'); toastT = 1.6; }

// ---------------------------------------------------------------- render
function chevrons(u) {
  if (u.rank <= 0) return; ctx.strokeStyle = '#ffd76a'; ctx.lineWidth = 1;
  for (let i = 0; i < u.rank; i++) { const cx = u.x - 3 + i * 4, cy = u.y - DEFS[u.type].r - 13; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + 2, cy - 2.5); ctx.lineTo(cx + 4, cy); ctx.stroke(); }
}
function drawUnit(u) {
  if (relIsEnemy(u.team) && !tileVisible(u.x, u.y)) return;
  const d = DEFS[u.type]; const col = teamColor(u.owner, u.team);
  const dark = shade(col, -0.35), body = col;
  ctx.save(); ctx.translate(u.x, u.y);
  if (selSet.has(u.id)) { ctx.strokeStyle = '#e8e4c9'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(0, 0, d.r + 5, 0, 7); ctx.stroke(); }
  if (u.stance === 'hold' && selSet.has(u.id)) { ctx.strokeStyle = '#d8b54a'; ctx.beginPath(); ctx.arc(0, 0, d.r + 8, 0, 7); ctx.stroke(); }
  if (d.cls === 'inf') {
    ctx.rotate(u.face + Math.PI / 2);
    ctx.fillStyle = body; ctx.beginPath(); ctx.arc(0, 0, 5, 0, 7); ctx.fill();
    ctx.fillStyle = shade(col, 0.2); ctx.beginPath(); ctx.arc(0, 0, 3, 0, 7); ctx.fill();
    ctx.strokeStyle = '#2c2c22'; ctx.lineWidth = 2;
    const gl = u.type === 'bazooka' ? 9 : u.type === 'mg' ? 8 : u.type === 'builder' ? 0 : 6;
    if (gl) { ctx.beginPath(); ctx.moveTo(2, -2); ctx.lineTo(3, -gl); ctx.stroke(); }
  } else if (u.type === 'tank') {
    ctx.rotate(u.face);
    ctx.fillStyle = dark; ctx.fillRect(-13, -10, 26, 4); ctx.fillRect(-13, 6, 26, 4);
    ctx.fillStyle = body; ctx.fillRect(-11, -7, 22, 14);
    ctx.fillStyle = dark; ctx.beginPath(); ctx.arc(0, 0, 6, 0, 7); ctx.fill();
    ctx.strokeStyle = dark; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(17, 0); ctx.stroke();
  } else if (u.type === 'atgun') {
    ctx.rotate(u.face);
    ctx.fillStyle = dark; ctx.beginPath(); ctx.arc(-3, -7, 4, 0, 7); ctx.arc(-3, 7, 4, 0, 7); ctx.fill();
    ctx.fillStyle = body; ctx.fillRect(-7, -4, 9, 8);
    ctx.strokeStyle = dark; ctx.lineWidth = 2.6; ctx.beginPath(); ctx.moveTo(-2, 0); ctx.lineTo(20, 0); ctx.stroke();
  } else {
    ctx.rotate(u.face);
    ctx.fillStyle = dark; ctx.beginPath(); ctx.arc(-5, -7, 4, 0, 7); ctx.arc(-5, 7, 4, 0, 7); ctx.fill();
    ctx.fillStyle = body; ctx.fillRect(-9, -4, 12, 8);
    ctx.strokeStyle = dark; ctx.lineWidth = 3.4; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(19, 0); ctx.stroke();
  }
  ctx.restore();
  chevrons(u);
  if (u.hp < u.maxhp || selSet.has(u.id)) { const w = 20, pct = Math.max(0, u.hp / u.maxhp);
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(u.x - w / 2, u.y - d.r - 10, w, 3);
    ctx.fillStyle = pct > 0.5 ? '#7dc25a' : pct > 0.25 ? '#d8b54a' : '#c4554a'; ctx.fillRect(u.x - w / 2, u.y - d.r - 10, w * pct, 3); }
}
function drawBuilding(b) {
  if (relIsEnemy(b.team) && !tileExplored(b.cx, b.cy)) return;
  const dim = relIsEnemy(b.team) && !tileVisible(b.cx, b.cy);
  const col = teamColor(b.owner, b.team);
  ctx.globalAlpha = dim ? 0.55 : 1;
  if (b.type === 'bunker') {
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(b.x + 3, b.y + 3, b.w, b.h);
    ctx.fillStyle = b.constructing ? '#6a6a52' : shade(col, -0.2); ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = '#2c2c22'; ctx.lineWidth = 2; ctx.strokeRect(b.x + 5, b.y + 5, b.w - 10, b.h - 10);
  } else {
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(b.x + 4, b.y + 4, b.w, b.h);
    ctx.fillStyle = shade(col, -0.15); ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = (selBuilding === b.id ? '#ffd76a' : shade(col, 0.2)); ctx.lineWidth = selBuilding === b.id ? 3 : 2; ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = '#f0ecd0'; ctx.font = 'bold 11px Courier New'; ctx.textAlign = 'center';
    ctx.fillText(b.type === 'hq' ? 'HQ' : b.type === 'barracks' ? 'BRKS' : 'FCTY', b.cx, b.cy + 4);
    ctx.fillStyle = col; ctx.fillRect(b.x + 4, b.y - 12, 14, 8);
  }
  if (b.constructing) {
    ctx.fillStyle = 'rgba(0,0,0,.42)'; ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = 'rgba(216,181,74,.6)'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.strokeRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2); ctx.setLineDash([]);
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(b.x, b.y - 8, b.w, 4);
    ctx.fillStyle = '#d8b54a'; ctx.fillRect(b.x, b.y - 8, b.w * Math.min(1, b.buildProg || 0), 4);
  }
  const pct = Math.max(0, b.hp / b.maxhp);
  if (pct < 1 || selBuilding === b.id) { ctx.fillStyle = '#1a1a1a'; ctx.fillRect(b.x, b.y + b.h + 3, b.w, 4);
    ctx.fillStyle = pct > 0.5 ? '#7dc25a' : pct > 0.25 ? '#d8b54a' : '#c4554a'; ctx.fillRect(b.x, b.y + b.h + 3, b.w * pct, 4); }
  const qlen = b.queue ? b.queue.length : b.qlen; const qprog = b.queue ? (b.queue[0] ? b.prog / DEFS[b.queue[0]].build : 0) : (b.qtype >= 0 ? b.prog / DEFS[UTYPES[b.qtype]].build : 0);
  if (qlen) { ctx.fillStyle = '#1a1a1a'; ctx.fillRect(b.x, b.y - 22, b.w, 5); ctx.fillStyle = '#d8b54a'; ctx.fillRect(b.x, b.y - 22, b.w * (qprog || 0), 5);
    ctx.fillStyle = '#f0ecd0'; ctx.font = '9px Courier New'; ctx.textAlign = 'center'; ctx.fillText('x' + qlen, b.cx, b.y - 25); }
  if (b.owner === mySlot && selBuilding === b.id && b.rally) { ctx.strokeStyle = 'rgba(159,208,106,.6)'; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(b.cx, b.cy); ctx.lineTo(b.rally.x, b.rally.y); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = '#9fd06a'; ctx.beginPath(); ctx.arc(b.rally.x, b.rally.y, 4, 0, 7); ctx.fill(); }
  ctx.globalAlpha = 1;
}
function shade(hex, amt) {
  const m = hex.match(/\w\w/g); if (!m) return hex;
  let [r, g, b] = m.map(h => parseInt(h, 16));
  if (amt > 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; } else { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
function render() {
  const s = DPR(); ctx.setTransform(s, 0, 0, s, 0, 0); ctx.clearRect(0, 0, innerWidth, innerHeight);
  ctx.save(); ctx.translate(-cam.x, -cam.y);
  const vx0 = cam.x, vy0 = cam.y;
  ctx.drawImage(tcv, vx0, vy0, innerWidth, innerHeight, vx0, vy0, innerWidth, innerHeight);
  const W = world();
  for (const c of craters) { if (!tileExplored(c.x, c.y)) continue; ctx.fillStyle = 'rgba(30,24,16,.45)'; ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, 7); ctx.fill(); }
  for (const f of W.flags) { if (!tileExplored(f.x, f.y)) continue;
    ctx.strokeStyle = 'rgba(232,228,201,.2)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(f.x, f.y, 72, 0, 7); ctx.stroke();
    ctx.strokeStyle = '#2c2c22'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(f.x, f.y + 10); ctx.lineTo(f.x, f.y - 22); ctx.stroke();
    ctx.fillStyle = f.own >= 0 ? (f.own === myTeam ? OWN_BLUE : ENEMY_PAL[f.own % ENEMY_PAL.length]) : '#9b9b8a'; ctx.fillRect(f.x, f.y - 22, 18, 11);
    if (f.cap > 1 && f.cap < 100) { ctx.fillStyle = '#1a1a1a'; ctx.fillRect(f.x - 20, f.y + 16, 40, 4); ctx.fillStyle = '#d8b54a'; ctx.fillRect(f.x - 20, f.y + 16, 40 * f.cap / 100, 4); } }
  for (const b of W.buildings) drawBuilding(b);
  for (const u of W.units) drawUnit(u);
  for (const p of parts) { const a = p.life / p.max;
    if (p.t === 'tracer') { ctx.strokeStyle = `rgba(${rgbStr(p.col)},${a})`; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x2, p.y2); ctx.stroke(); }
    else if (p.t === 'flash') { ctx.fillStyle = `rgba(255,220,120,${a})`; ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, 7); ctx.fill(); }
    else if (p.t === 'boom') { const r = p.r * (1 - a * 0.6); ctx.fillStyle = `rgba(230,120,40,${a * .8})`; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill(); ctx.fillStyle = `rgba(60,50,40,${a * .5})`; ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.4, 0, 7); ctx.fill(); }
    else if (p.t === 'ring') { ctx.strokeStyle = p.col; ctx.globalAlpha = a; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, p.r + (1 - a) * 16, 0, 7); ctx.stroke(); ctx.globalAlpha = 1; } }
  ctx.imageSmoothingEnabled = true; ctx.drawImage(fogCv, vx0, vy0, innerWidth, innerHeight, vx0, vy0, innerWidth, innerHeight); ctx.imageSmoothingEnabled = false;
  ctx.restore();
  if (selBox) { ctx.strokeStyle = '#e8e4c9'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.strokeRect(Math.min(selBox.x1, selBox.x2), Math.min(selBox.y1, selBox.y2), Math.abs(selBox.x2 - selBox.x1), Math.abs(selBox.y2 - selBox.y1)); ctx.setLineDash([]); }
  drawMini(W);
  drawHud(W);
}
function rgbStr(col) { if (!col) return '255,230,140'; if (col.startsWith('rgb')) return col.match(/\d+/g).slice(0, 3).join(','); const m = col.match(/\w\w/g); return m ? m.map(h => parseInt(h, 16)).join(',') : '255,230,140'; }
function drawMini(W) {
  const MSX = 156 / WPX, MSY = 110 / HPX;
  mc.fillStyle = '#0d0f08'; mc.fillRect(0, 0, 156, 110); mc.drawImage(tcv, 0, 0, WPX, HPX, 0, 0, 156, 110);
  mc.fillStyle = 'rgba(8,9,5,.78)';
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) if (!explored[ti(x, y)]) mc.fillRect(x * (156 / MW), y * (110 / MH), 156 / MW + 0.6, 110 / MH + 0.6);
  for (const b of W.buildings) { if (relIsEnemy(b.team) && !tileExplored(b.cx, b.cy)) continue; mc.fillStyle = teamColor(b.owner, b.team); mc.fillRect(b.x * MSX - 1, b.y * MSY - 1, 5, 4); }
  for (const u of W.units) { if (relIsEnemy(u.team) && !tileVisible(u.x, u.y)) continue; mc.fillStyle = teamColor(u.owner, u.team); mc.fillRect(u.x * MSX - 1, u.y * MSY - 1, 2, 2); }
  mc.strokeStyle = '#e8e4c9'; mc.lineWidth = 1; mc.strokeRect(cam.x * MSX, cam.y * MSY, innerWidth * MSX, innerHeight * MSY);
}
function drawHud(W) {
  const flagCount = W.flags.filter(f => f.own === myTeam).length, pop = countMyPop(W);
  els.top.innerHTML = `SUPPLIES <b>$${W.money}</b><br>FLAGS <b>${flagCount}/${W.flags.length}</b> &nbsp; POP <b>${pop}/${POPCAP}</b>`;
  const selU = [...mySelUnits()]; let info = '';
  if (selBuilding >= 0) info = 'Producing. Tap ground to set rally';
  else if (selU.length) { const t = {}; selU.forEach(u => t[u.type] = (t[u.type] || 0) + 1); info = Object.entries(t).map(([k, n]) => n + ' ' + DEFS[k].short).join(', ') + '  ' + selU[0].stance.toUpperCase(); }
  els.sel.textContent = info;
  [...bar.children].forEach(btn => { if (btn._type) { const q = btn.querySelector('.q'); if (q) q.style.display = 'none'; btn.classList.toggle('disabled', W.money < DEFS[btn._type].cost); } });
}
function countMyPop(W) { let p = 0; for (const u of W.units) if (u.owner === mySlot) p += DEFS[u.type].pop; return p; }

// ---------------------------------------------------------------- loop
function frame(now) {
  raf = requestAnimationFrame(frame);
  let dt = Math.min((now - last) / 1000, 0.05); last = now;
  if (!running) return;
  const ps = 560 * dt;
  if (keys['ArrowLeft'] || keys['KeyA']) cam.x -= ps;
  if (keys['ArrowRight'] || keys['KeyD']) cam.x += ps;
  if (keys['ArrowUp'] || keys['KeyW']) cam.y -= ps;
  if (keys['ArrowDown'] || keys['KeyS']) cam.y += ps;
  clampCam();
  if (isHost) { if (!gameOver) sim(dt); snapAcc += dt; if (snapAcc >= 0.1) { snapAcc = 0; net.sendSnap(snapshot()); } }
  else easeClient(dt);
  for (let i = parts.length - 1; i >= 0; i--) { parts[i].life -= dt; if (parts[i].life <= 0) parts.splice(i, 1); }
  if (craters.length > 140) craters.splice(0, craters.length - 140);
  fogAcc += dt; if (fogAcc >= 0.1) { fogAcc = 0; computeFog(); }
  if (toastT > 0) { toastT -= dt; if (toastT <= 0) els.toast.classList.remove('show'); }
  render();
}

function showEnd() {
  els.end.style.display = 'flex';
  const win = winner === myTeam;
  els.endTitle.textContent = win ? 'VICTORY' : 'DEFEAT'; els.endTitle.className = win ? 'win' : 'lose';
  els.endText.textContent = win ? 'Your forces hold the field.' : 'Your headquarters has fallen.';
}

// ---------------------------------------------------------------- lifecycle
let onLeaveCb = null;
function leave() { stop(); if (onLeaveCb) onLeaveCb(); }

export const Game = {
  start(o) {
    opts = o; net = o.net; isHost = o.isHost; mySlot = o.mySlot; slots = o.slots; onLeaveCb = o.onLeave;
    slotTeam = slots.map(s => s.team); slotBonus = slots.map(s => s.bonus || 0); myTeam = slotTeam[mySlot];
    T = genMap(o.seed); prerenderTerrain(o.seed);
    vis = new Uint8Array(MW * MH); explored = new Uint8Array(MW * MH);
    fogCv = document.createElement('canvas'); fogCv.width = MW; fogCv.height = MH; fogCtx = fogCv.getContext('2d');
    units = []; buildings = []; projs = []; money = []; parts = []; craters = []; nextId = 1; botS = {}; evbuf = [];
    cu = new Map(); cbuild = []; cflags = flagSpots().map(f => ({ x: f.x, y: f.y, own: -1, cap: 0 })); clientMoney = [];
    selSet = new Set(); selBuilding = -1; buildMode = null;
    gameOver = false; winner = -1; time = 0;

    if (isHost) {
      flagsState = flagSpots().map(f => ({ x: f.x, y: f.y, own: -1, cap: 0 }));
      setupWorld();
      net.onCmd((d) => applyCmd(d));
    } else {
      net.onSnap((d) => applySnap(d));
    }

    // dom
    document.getElementById('screen-game').style.display = 'block';
    cv = document.getElementById('cv'); ctx = cv.getContext('2d');
    mini = document.getElementById('mini'); mc = mini.getContext('2d');
    bar = document.getElementById('bottombar');
    els = { top: document.getElementById('topbar'), sel: document.getElementById('selinfo'), toast: document.getElementById('toast'),
      groups: document.getElementById('groups'), end: document.getElementById('end'), endTitle: document.getElementById('endTitle'), endText: document.getElementById('endText') };
    const resize = () => { const s = DPR(); cv.width = innerWidth * s; cv.height = innerHeight * s; cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px'; clampCam(); };
    resize(); addEventListener('resize', resize);
    const c = CORNERS[slots[mySlot].corner]; cam.x = c.ax * TILE - innerWidth / 2 + 80; cam.y = c.ay * TILE - innerHeight / 2; clampCam();

    cv.onpointerdown = onDown; cv.onpointermove = onMove; cv.onpointerup = onUp; cv.onpointercancel = e => { ptrs.delete(e.pointerId); panLast = null; selBox = null; };
    addEventListener('contextmenu', e => e.preventDefault());
    addEventListener('keydown', onKeyDown); addEventListener('keyup', onKeyUp);
    mini.onpointerdown = e => { e.preventDefault(); const r = mini.getBoundingClientRect(); cam.x = (e.clientX - r.left) / r.width * WPX - innerWidth / 2; cam.y = (e.clientY - r.top) / r.height * HPX - innerHeight / 2; clampCam(); };

    els.end.style.display = 'none';
    computeFog(); buildUI(); renderGroups();
    running = true; last = performance.now(); if (!raf) raf = requestAnimationFrame(frame);
  },
  stop() {
    running = false; if (raf) cancelAnimationFrame(raf); raf = 0;
    removeEventListener('keydown', onKeyDown); removeEventListener('keyup', onKeyUp);
    document.getElementById('screen-game').style.display = 'none';
  }
};
function stop() { Game.stop(); }
