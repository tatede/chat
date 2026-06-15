// maps.js  --  deterministic map generation shared by host and all clients.
// Only the host simulates, but every client regenerates identical terrain from
// the same seed so the map and fog render the same everywhere.

export const TILE = 32, MW = 72, MH = 52;
export const WPX = MW * TILE, HPX = MH * TILE;
export const POPCAP = 30;

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ti = (x, y) => x + y * MW;
const inMap = (x, y) => x >= 0 && y >= 0 && x < MW && y < MH;

// Four base corners (tile coords for the HQ). Order: TL, TR, BR, BL.
export const CORNERS = [
  { ax: 5,       ay: 8 },
  { ax: MW - 8,  ay: 8 },
  { ax: MW - 8,  ay: MH - 11 },
  { ax: 5,       ay: MH - 11 },
];

// Buildings for a base at a given corner. type, tile x, tile y.
export function baseBuildings(corner) {
  const c = CORNERS[corner];
  return [
    { type: 'hq',       tx: c.ax, ty: c.ay },
    { type: 'barracks', tx: c.ax, ty: c.ay - 4 },
    { type: 'factory',  tx: c.ax, ty: c.ay + 4 },
  ];
}

// Five capturable supply flags: centre plus four mid points.
export function flagSpots() {
  return [
    { x: (MW / 2) * TILE, y: (MH / 2) * TILE },
    { x: (MW / 2) * TILE, y: 7 * TILE },
    { x: (MW / 2) * TILE, y: (MH - 7) * TILE },
    { x: 14 * TILE,       y: (MH / 2) * TILE },
    { x: (MW - 14) * TILE, y: (MH / 2) * TILE },
  ];
}

// Generate terrain. 0 grass, 1 forest, 2 water, 3 road.
export function genMap(seed) {
  const rnd = mulberry32(seed);
  const perm = new Float32Array(MW * MH);
  for (let i = 0; i < perm.length; i++) perm[i] = rnd();
  const at = (x, y) => perm[((y % MH) + MH) % MH * MW + ((x % MW) + MW) % MW];
  const smooth = t => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * smooth(t);
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    return lerp(lerp(at(xi, yi), at(xi + 1, yi), xf), lerp(at(xi, yi + 1), at(xi + 1, yi + 1), xf), yf);
  };

  const T = new Uint8Array(MW * MH);
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++)
    if (noise(x / 6, y / 6) > 0.68) T[ti(x, y)] = 1;

  // a few small non-blocking ponds toward the middle band
  for (let k = 0; k < 5; k++) {
    const cx = 16 + Math.floor(rnd() * (MW - 32));
    const cy = 8 + Math.floor(rnd() * (MH - 16));
    const r = 2 + Math.floor(rnd() * 2);
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++)
      if (inMap(x, y) && (x - cx) ** 2 + (y - cy) ** 2 <= r * r) T[ti(x, y)] = 2;
  }

  // a cross of roads through the centre to keep corners connected and fast
  const midX = MW >> 1, midY = MH >> 1;
  for (let x = 0; x < MW; x++) { T[ti(x, midY)] = 3; T[ti(x, midY + 1)] = 3; }
  for (let y = 0; y < MH; y++) { T[ti(midX, y)] = 3; T[ti(midX + 1, y)] = 3; }

  // clear forest and water around every base and every flag so nothing is boxed in
  const clear = (cx, cy, r) => {
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++)
      if (inMap(x, y) && T[ti(x, y)] !== 3) T[ti(x, y)] = 0;
  };
  for (const c of CORNERS) clear(c.ax + 1, c.ay + 1, 7);
  for (const f of flagSpots()) clear((f.x / TILE) | 0, (f.y / TILE) | 0, 3);

  return T;
}
