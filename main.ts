// Push-optimal Sokoban solver for generated hallway-and-rooms levels.
//
// A generated level is a hallway one square wide with independent rooms off
// it, and a box pushed out of a room is lost, so in an optimal play every
// box stays in its room and the level's push optimum P* is the sum of the
// rooms' optima. This solver splits the level into rooms at the hallway
// row, solves each room on its own with an A* search over pushes, and
// joins the rooms with plain walks. It reads /input/<id>/level.txt and
// writes /output/<id>/solution.txt for every instance of the set.
//
// The room search state is the sorted box squares packed into one number,
// plus the smallest square of the player's walking region, so one state
// covers every square the player can walk to. Pushes that land a box on a
// dead square (a square from which the box can never reach a goal) are
// pruned, and an A* bound — the cheapest matching of boxes to goals over
// static push distances — steers the search to the optimum without ever
// overestimating it. Everything runs in fixed orders with no clock and no
// randomness: two runs of the program on the same set write identical
// answers.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const IN = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const MC = "udlr";

// The walk from `from` to `to` over the squares the neighbour table `nb`
// links, avoiding the box squares marked in `blocked`, as a move string,
// or null when no walk exists. Plain BFS in a fixed direction order, so
// the walk is deterministic.
function walk(nb, blocked, from, to) {
  if (from === to) return "";
  const prev = new Int32Array(blocked.length).fill(-1);
  const pd = new Int8Array(blocked.length);
  prev[from] = from;
  const q = [from];
  for (let i = 0; i < q.length && prev[to] < 0; i++) {
    const c = q[i];
    for (let d = 0; d < 4; d++) {
      const n = nb[c * 4 + d];
      if (n < 0 || blocked[n] || prev[n] >= 0) continue;
      prev[n] = c;
      pd[n] = d;
      q.push(n);
    }
  }
  if (prev[to] < 0) return null;
  let s = "", c = to;
  while (c !== from) {
    s = MC[pd[c]] + s;
    c = prev[c];
  }
  return s;
}

// Solve one room push-optimally. `cells` are the room's own squares, the
// only squares a box may land on; `play` is every square the player may
// stand on (the room plus the hallway squares outside its door); `start`
// is the player's square, the hallway square outside the door. Returns
// { moves, player, boxes } for an optimal solution, or null.
function solveRoom(nb, size, cells, play, goals, boxes0, start) {
  const isCell = new Uint8Array(size);
  const isPlay = new Uint8Array(size);
  const isGoal = new Uint8Array(size);
  for (const c of cells) isCell[c] = 1;
  for (const c of play) isPlay[c] = 1;
  for (const g of goals) isGoal[g] = 1;
  // Live squares: a box there can still be pushed onto a goal. Fixpoint,
  // backwards from the goals: a box on c reaches a live square when the
  // player can stand on the far side of c from it. Directions come in
  // opposite pairs, so d ^ 1 is the way back.
  const live = new Uint8Array(size);
  for (const g of goals) live[g] = 1;
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of cells) {
      if (live[c]) continue;
      for (let d = 0; d < 4; d++) {
        const n = nb[c * 4 + d], s = nb[c * 4 + (d ^ 1)];
        if (n >= 0 && live[n] && s >= 0 && isPlay[s]) {
          live[c] = 1;
          grew = true;
          break;
        }
      }
    }
  }
  // Static push distances: dist[g][c] is the fewest pushes that move one
  // box from c to goal g, other boxes and the player's walk ignored — a
  // plain BFS backwards from each goal over box squares. The cheapest
  // matching of boxes to goals under these distances never overestimates
  // the pushes still needed (every push moves one box one square), so it
  // is a safe A* bound; a state whose matching is impossible is dead.
  const dist = goals.map((g) => {
    const dg = new Int32Array(size).fill(-1);
    dg[g] = 0;
    const q = [g];
    for (let i = 0; i < q.length; i++) {
      const x = q[i];
      for (let d = 0; d < 4; d++) {
        const c = nb[x * 4 + (d ^ 1)];
        const s = c < 0 ? -1 : nb[c * 4 + (d ^ 1)];
        if (c < 0 || s < 0 || !isCell[c] || !isPlay[s] || dg[c] >= 0) continue;
        dg[c] = dg[x] + 1;
        q.push(c);
      }
    }
    return dg;
  });
  const bound = (bs) => {
    let best = Infinity;
    const used = new Array(bs.length).fill(false);
    const go = (i, sum) => {
      if (sum >= best) return;
      if (i === bs.length) {
        best = sum;
        return;
      }
      for (let gi = 0; gi < bs.length; gi++) {
        if (used[gi]) continue;
        const v = dist[gi][bs[i]];
        if (v < 0) continue;
        used[gi] = true;
        go(i + 1, sum + v);
        used[gi] = false;
      }
    };
    go(0, 0);
    return best;
  };
  // The player's walking region under the boxes currently in `boxMark`,
  // flooded from `from` and marked with a fresh stamp; returns the
  // region's smallest square, its canonical name. Two stamp fields: a
  // state's own region lives in `seen`, and the regions of the children
  // it spawns are flooded in `seenC`, so naming a child never smudges
  // the marks its siblings are still being tested against.
  const seen = new Int32Array(size);
  const seenC = new Int32Array(size);
  const boxMark = new Uint8Array(size);
  let stamp = 0;
  let stampC = 0;
  const flood = (marks, stampNow, from) => {
    let rep = from;
    marks[from] = stampNow;
    const q = [from];
    for (let i = 0; i < q.length; i++) {
      const c = q[i];
      if (c < rep) rep = c;
      for (let d = 0; d < 4; d++) {
        const n = nb[c * 4 + d];
        if (n < 0 || !isPlay[n] || boxMark[n] || marks[n] === stampNow) continue;
        marks[n] = stampNow;
        q.push(n);
      }
    }
    return rep;
  };
  const region = (from) => flood(seen, ++stamp, from);
  const regionC = (from) => flood(seenC, ++stampC, from);
  const setBoxes = (bs) => {
    boxMark.fill(0);
    for (const b of bs) boxMark[b] = 1;
  };
  // Box squares pack into one number, four base-512 digits, empty slots
  // filled with 511; a state key is the pack times 512 plus the region.
  const pack = (bs) => {
    const s = [...bs].sort((a, b) => a - b);
    while (s.length < 4) s.push(511);
    return ((s[0] * 512 + s[1]) * 512 + s[2]) * 512 + s[3];
  };
  const unpack = (p) => {
    const bs = [];
    for (let k = 0; k < 4; k++) {
      const v = p % 512;
      p = (p - v) / 512;
      if (v !== 511) bs.push(v);
    }
    return bs.reverse();
  };
  const sPack = [], sPlayer = [], sPrev = [], sSeg = [], sG = [], sF = [], sKey = [];
  const stateAt = new Map();
  // A binary heap over states, ordered by f = pushes so far + bound,
  // ties by the deeper state first, then by arrival: the order is total,
  // so the search is deterministic.
  const heap = [];
  const before = (a, b) => sF[a] !== sF[b] ? sF[a] < sF[b] : sG[a] !== sG[b] ? sG[a] > sG[b] : a < b;
  const hPush = (v) => {
    heap.push(v);
    for (let i = heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (!before(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const hPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0;;) {
        let m = i;
        const l = 2 * i + 1, r = l + 1;
        if (l < heap.length && before(heap[l], heap[m])) m = l;
        if (r < heap.length && before(heap[r], heap[m])) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  const startBs = [...boxes0].sort((a, b) => a - b);
  setBoxes(startBs);
  const startKey = pack(startBs) * 512 + region(start);
  stateAt.set(startKey, 0);
  sPack.push(pack(startBs));
  sPlayer.push(start);
  sPrev.push(-1);
  sSeg.push("");
  sG.push(0);
  sF.push(bound(startBs));
  sKey.push(startKey);
  hPush(0);
  while (heap.length > 0) {
    const si = hPop();
    if (stateAt.get(sKey[si]) < sG[si]) continue;
    const bs = unpack(sPack[si]);
    if (bs.every((b) => isGoal[b])) {
      let out = "";
      for (let k = si; k >= 0; k = sPrev[k]) out = sSeg[k] + out;
      return { moves: out, player: sPlayer[si], boxes: bs };
    }
    const pMark = new Uint8Array(size);
    for (const b of bs) pMark[b] = 1;
    setBoxes(bs);
    region(sPlayer[si]);
    const curStamp = stamp;
    for (const b of bs) {
      for (let d = 0; d < 4; d++) {
        const dest = nb[b * 4 + d];
        const stand = nb[b * 4 + (d ^ 1)];
        if (dest < 0 || stand < 0 || seen[stand] !== curStamp) continue;
        if (!isCell[dest] || pMark[dest] || !live[dest]) continue;
        const nb2 = bs.map((x) => (x === b ? dest : x)).sort((a, b2) => a - b2);
        const hb = bound(nb2);
        if (hb === Infinity) continue;
        const pk = pack(nb2);
        setBoxes(nb2);
        const nk = pk * 512 + regionC(b);
        const g2 = sG[si] + 1;
        if (stateAt.has(nk) && stateAt.get(nk) <= g2) continue;
        const seg = walk(nb, pMark, sPlayer[si], stand);
        if (seg === null) continue;
        stateAt.set(nk, g2);
        sPack.push(pk);
        sPlayer.push(b);
        sPrev.push(si);
        sSeg.push(seg + MC[d].toUpperCase());
        sG.push(g2);
        sF.push(g2 + hb);
        sKey.push(nk);
        hPush(sPack.length - 1);
      }
    }
    if (sPack.length > 4000000) return null;
  }
  return null;
}

// Solve one level text (XSB) into a move string. The player starts on the
// hallway, so the hallway is the player's row: the floor off that row
// falls into one component per room. Rooms are solved in door order and
// joined by walks; the walks never push, so the push count of the whole
// answer is the sum of the rooms' optima. Any surprise (a box on the
// hallway, a room whose boxes and goals differ, a room the search cannot
// finish) falls back to solving the whole floor as a single room, and a
// level that still fails gets an empty answer rather than no answer.
function solveLevel(text) {
  const rows = text.split("\n").filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const size = w * rows.length;
  if (size > 511) return "";
  const wall = new Uint8Array(size).fill(1);
  const goalAt = new Uint8Array(size);
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x], i = y * w + x;
      if (ch === "#") continue;
      wall[i] = 0;
      if (ch === "." || ch === "*" || ch === "+") goalAt[i] = 1;
      if (ch === "$" || ch === "*") boxes.push(i);
      if (ch === "@" || ch === "+") player = i;
    }
  });
  if (player < 0 || boxes.length === 0) return "";
  // Neighbour table: nb[i * 4 + d] is the open square one step from i in
  // direction d, or -1 at a wall or the board's edge.
  const nb = new Int16Array(size * 4).fill(-1);
  for (let i = 0; i < size; i++) {
    if (wall[i]) continue;
    const x = i % w, y = (i / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= rows.length) continue;
      const n = ny * w + nx;
      if (!wall[n]) nb[i * 4 + d] = n;
    }
  }
  const hallY = (player / w) | 0;
  const comp = new Int32Array(size).fill(-1);
  const comps = [];
  for (let i = 0; i < size; i++) {
    if (wall[i] || ((i / w) | 0) === hallY || comp[i] >= 0) continue;
    const cells = [];
    const q = [i];
    comp[i] = comps.length;
    for (let j = 0; j < q.length; j++) {
      const c = q[j];
      cells.push(c);
      for (let d = 0; d < 4; d++) {
        const n = nb[c * 4 + d];
        if (n < 0 || ((n / w) | 0) === hallY || comp[n] >= 0) continue;
        comp[n] = comps.length;
        q.push(n);
      }
    }
    comps.push(cells);
  }
  const rooms = [];
  let ok = boxes.every((b) => comp[b] >= 0);
  for (let ci = 0; ci < comps.length && ok; ci++) {
    const cells = comps[ci];
    const rb = boxes.filter((b) => comp[b] === ci);
    if (rb.length === 0) continue;
    const rg = cells.filter((c) => goalAt[c]);
    const entries = [...new Set(cells.flatMap((c) => {
      const cy = (c / w) | 0;
      return cy === hallY - 1 ? [c + w] : cy === hallY + 1 ? [c - w] : [];
    }))].sort((a, b) => a - b);
    if (rg.length !== rb.length || entries.length === 0) ok = false;
    else rooms.push({ cells, boxes: rb, goals: rg, entries });
  }
  if (!ok || rooms.length === 0) {
    const cells = [];
    for (let i = 0; i < size; i++) if (!wall[i]) cells.push(i);
    rooms.length = 0;
    rooms.push({
      cells,
      boxes: [...boxes].sort((a, b) => a - b),
      goals: cells.filter((c) => goalAt[c]),
      entries: [player],
    });
  }
  rooms.sort((a, b) => a.entries[0] - b.entries[0]);
  let out = "";
  let cur = player;
  const boxNow = new Uint8Array(size);
  for (const b of boxes) boxNow[b] = 1;
  for (const room of rooms) {
    const entry = room.entries[0];
    const seg = walk(nb, boxNow, cur, entry);
    if (seg === null) return "";
    const solved = solveRoom(nb, size, room.cells, [...room.cells, ...room.entries],
      room.goals, room.boxes, entry);
    if (solved === null) return "";
    out += seg + solved.moves;
    for (const b of room.boxes) boxNow[b] = 0;
    for (const b of solved.boxes) boxNow[b] = 1;
    cur = solved.player;
  }
  return out;
}

// Answer every instance of the set, in id order. The output directory is
// only ever created and written into, never removed: on the grader it is
// a mount point.
function main() {
  let ids = [];
  try {
    ids = readdirSync(IN, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return;
  }
  for (const id of ids) {
    let moves = "";
    try {
      moves = solveLevel(readFileSync(join(IN, id, "level.txt"), "utf8"));
    } catch {
      moves = "";
    }
    mkdirSync(join(OUT, id), { recursive: true });
    writeFileSync(join(OUT, id, "solution.txt"), moves + "\n");
  }
}
main();
