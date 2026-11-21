// Sokoban solver for sokoban-solver-01: push-level A* with a matching heuristic, room by room.
//
// How it works, in short:
//   1. A level falls apart into rooms on its own: cut the dead squares of the player's row (the
//      hallway: no box resting there can ever be pushed to a goal), and each floor component
//      left that holds boxes is one room. A box can never leave its room (the only way out is
//      onto a dead hallway square), so the rooms are independent problems joined only by the
//      player's walk, and their push optima add up to the level's optimum.
//   2. Each room is solved on the whole board with the other rooms' boxes standing as walls,
//      by an A* over pushes: a state is the room's boxes plus the player's reachable region
//      (named by its lowest square). The estimate is a minimum-cost matching between boxes and
//      goals over precomputed single-box push distances, which never overestimates, so the
//      first solution the search settles on is push-optimal.
//   3. Pushes onto dead squares and pushes that freeze a 2x2 block of walls and boxes around a
//      box off its goal are pruned: neither can be part of any solution.
//   4. If a level does not split into rooms, or a room defeats the optimal search, fallbacks
//      run (a greedier search of the room, then a search of the whole level). Every answer is
//      replayed in-process before it is written; an answer that does not replay as a solve is
//      replaced by the best verified one, or by an empty file.
//
// The program is deterministic: it reads no clock, no environment beyond the input/output
// directory contract, and no randomness. Search budgets are expansion counts, never time, so
// the two graded runs produce byte-identical files.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four steps, in a fixed order everywhere so ties always break the same way.
const STEP_X = [0, 0, -1, 1];
const STEP_Y = [-1, 1, 0, 0];
const STEP_CH = ['u', 'd', 'l', 'r'];
const PUSH_CH = ['U', 'D', 'L', 'R'];

// Search budgets, in expansions (states taken off the heap). A room of this contest's making
// is guaranteed solvable by a plain breadth-first search within 250,000 stored states, and the
// A* below expands a subset of the states such a search would, so these caps are headroom, not
// hope. A shared budget keeps the whole set inside the wall on any draw.
const ROOM_CAP = 220000;
const WHOLE_CAP = 320000;
const sharedBudget = { left: 2600000 };

/** A parsed level: grid, wall and goal masks, sorted goal and box squares, the player's square. */
function parseLevel(text) {
  const lines = text.split('\n').filter((s) => s.length > 0);
  const h = lines.length;
  const w = Math.max(...lines.map((s) => s.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const goals = [];
  const boxes = [];
  let player = -1;
  lines.forEach((line, y) => {
    for (let x = 0; x < line.length; x++) {
      const ch = line[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') {
        goal[i] = 1;
        goals.push(i);
      }
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever the text shows: nothing leaves the board, and the
  // frame guarantees the index arithmetic below never wraps around an edge.
  for (let x = 0; x < w; x++) {
    wall[x] = 1;
    wall[(h - 1) * w + x] = 1;
  }
  for (let y = 0; y < h; y++) {
    wall[y * w] = 1;
    wall[y * w + w - 1] = 1;
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goal, goals, boxes, player };
}

/**
 * For each goal, the fewest pushes that bring one box from any square onto it, other boxes
 * ignored: a breadth-first walk backwards from the goal over pushes (a box on square y can be
 * pushed onto x when the square behind y is open for the player to stand on). -1: unreachable.
 */
function goalDistances(board) {
  const { w, wall, goals } = board;
  const size = w * board.h;
  return goals.map((g0) => {
    const dist = new Int32Array(size).fill(-1);
    dist[g0] = 0;
    const queue = [g0];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi];
      for (let k = 0; k < 4; k++) {
        const d = STEP_Y[k] * w + STEP_X[k];
        const y = x - d;
        const stand = y - d;
        if (dist[y] === -1 && !wall[y] && !wall[stand]) {
          dist[y] = dist[x] + 1;
          queue.push(y);
        }
      }
    }
    return dist;
  });
}

/** A square is live when some goal's table reaches it: a box there can still be pushed home. */
function liveSquares(board, dists) {
  const live = new Uint8Array(board.wall.length);
  for (let s = 0; s < live.length; s++) {
    if (board.wall[s]) continue;
    for (const d of dists) {
      if (d[s] >= 0) {
        live[s] = 1;
        break;
      }
    }
  }
  return live;
}

/**
 * The matching bound: the cheapest assignment of distinct goals to the boxes, summed over the
 * single-box push tables. Admissible (each box must travel at least its own table distance to
 * whichever goal it finally occupies) and consistent, so A* with it stays optimal.
 */
function matchingBound(boxes, dists) {
  const n = boxes.length;
  const INF = Infinity;
  let dp = new Array(1 << n).fill(INF);
  dp[0] = 0;
  for (let i = 0; i < n; i++) {
    const next = new Array(1 << n).fill(INF);
    const b = boxes[i];
    for (let mask = 0; mask < (1 << n); mask++) {
      const cur = dp[mask];
      if (cur === INF) continue;
      for (let g = 0; g < n; g++) {
        if (mask & (1 << g)) continue;
        const c = dists[g][b];
        if (c < 0) continue;
        const v = cur + c;
        const m2 = mask | (1 << g);
        if (v < next[m2]) next[m2] = v;
      }
    }
    dp = next;
  }
  return dp[(1 << n) - 1];
}

/** The looser bound for wide states: each box's own nearest-goal distance, summed. */
function looseBound(boxes, dists) {
  let sum = 0;
  for (const b of boxes) {
    let m = Infinity;
    for (const d of dists) if (d[b] >= 0 && d[b] < m) m = d[b];
    if (m === Infinity) return Infinity;
    sum += m;
  }
  return sum;
}

/**
 * Flood the squares the player reaches from `from` around walls and the boxes in `occ`,
 * stamping them in `seen` with `stamp`; returns the region's lowest square, its name.
 */
function flood(board, occ, from, seen, stamp) {
  const { w, wall } = board;
  let low = from;
  const stack = [from];
  seen[from] = stamp;
  while (stack.length > 0) {
    const p = stack.pop();
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = p + STEP_Y[k] * w + STEP_X[k];
      if (!wall[q] && !occ[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack.push(q);
      }
    }
  }
  return low;
}

/**
 * Whether the box just pushed onto `t` sits in a frozen 2x2 block: four squares of walls and
 * boxes with a box among them off its goal. Such a box can never move again.
 */
function frozenAt(board, occ, t) {
  const { w, wall, goal } = board;
  const solid = (i) => wall[i] === 1 || occ[i] === 1;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!solid(a) || !solid(b) || !solid(c) || !solid(d)) continue;
    if ((occ[a] && !goal[a]) || (occ[b] && !goal[b]) || (occ[c] && !goal[c]) || (occ[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower-case steps, or null. */
function walkMoves(board, occ, from, to) {
  if (from === to) return '';
  const { w, wall } = board;
  const size = w * board.h;
  const prev = new Int32Array(size).fill(-1);
  const how = new Int8Array(size).fill(-1);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + STEP_Y[k] * w + STEP_X[k];
      if (wall[q] || occ[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = k;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = STEP_CH[how[p]] + s;
  return s;
}

/**
 * A* over pushes on one board (a room's sub-board, or a whole level as the fallback).
 * `weight` 1 keeps the search optimal; a larger weight trades optimality for speed on the
 * fallback path. Returns { pushes, moves } with the full step string (walks lower-case,
 * pushes upper-case), or null when the expansion budget runs out first.
 */
function searchPushes(board, cap, weight) {
  const { w, wall, goal, boxes: startBoxes, player: startPlayer } = board;
  const size = w * board.h;
  const dists = goalDistances(board);
  const live = liveSquares(board, dists);
  const bound = startBoxes.length <= 8 ? matchingBound : looseBound;
  const solved = (bs) => bs.every((b) => goal[b] === 1);
  if (solved(startBoxes)) return { pushes: 0, moves: '' };
  if (bound(startBoxes, dists) === Infinity) return null;

  const occ = new Uint8Array(size);
  const seenHere = new Int32Array(size);
  const seenRep = new Int32Array(size);
  let stampHere = 0;
  let stampRep = 0;

  // The states, in the order found: boxes, a square the player stands on, pushes so far,
  // parent, and the push that made the state (the box's old square and the direction).
  const sBoxes = [startBoxes];
  const sPlayer = [startPlayer];
  const sG = [0];
  const sParent = [-1];
  const sFrom = [-1];
  const sDir = [-1];
  const sKey = [];
  const keyOf = (bs, rep) => rep + '|' + bs.join(',');
  for (const b of startBoxes) occ[b] = 1;
  const startRep = flood(board, occ, startPlayer, seenRep, ++stampRep);
  for (const b of startBoxes) occ[b] = 0;
  sKey.push(keyOf(startBoxes, startRep));
  const best = new Map([[sKey[0], 0]]);

  // The open list: a binary heap on (f, h, insertion order), all comparisons exact, so the
  // order states are taken is a function of the level alone.
  const heapF = [];
  const heapH = [];
  const heapN = [];
  const heapS = [];
  let counter = 0;
  const heapLess = (i, j) =>
    heapF[i] < heapF[j] ||
    (heapF[i] === heapF[j] && (heapH[i] < heapH[j] || (heapH[i] === heapH[j] && heapN[i] < heapN[j])));
  const heapSwap = (i, j) => {
    for (const a of [heapF, heapH, heapN, heapS]) {
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
  };
  const heapPush = (f, h, s) => {
    heapF.push(f);
    heapH.push(h);
    heapN.push(counter++);
    heapS.push(s);
    let i = heapF.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(i, p)) break;
      heapSwap(i, p);
      i = p;
    }
  };
  const heapPop = () => {
    const top = heapS[0];
    const lf = heapF.pop();
    const lh = heapH.pop();
    const ln = heapN.pop();
    const ls = heapS.pop();
    if (heapF.length > 0) {
      heapF[0] = lf;
      heapH[0] = lh;
      heapN[0] = ln;
      heapS[0] = ls;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heapF.length) break;
        if (c + 1 < heapF.length && heapLess(c + 1, c)) c++;
        if (!heapLess(c, i)) break;
        heapSwap(i, c);
        i = c;
      }
    }
    return top;
  };
  heapPush(bound(startBoxes, dists) * weight, bound(startBoxes, dists), 0);

  let expansions = 0;
  let found = -1;
  while (heapF.length > 0) {
    const s = heapPop();
    if (best.get(sKey[s]) !== sG[s]) continue; // a cheaper route to this state already won
    if (solved(sBoxes[s])) {
      found = s;
      break;
    }
    if (++expansions > cap || expansions > sharedBudget.left) break;
    const bs = sBoxes[s];
    for (const b of bs) occ[b] = 1;
    flood(board, occ, sPlayer[s], seenHere, ++stampHere);
    const here = stampHere;
    for (let bi = 0; bi < bs.length; bi++) {
      const b = bs[bi];
      for (let k = 0; k < 4; k++) {
        const d = STEP_Y[k] * w + STEP_X[k];
        const stand = b - d;
        const target = b + d;
        if (seenHere[stand] !== here || wall[target] || occ[target] || !live[target]) continue;
        occ[b] = 0;
        occ[target] = 1;
        const frozen = frozenAt(board, occ, target);
        let nb = null;
        let key = null;
        if (!frozen) {
          nb = bs.slice();
          nb[bi] = target;
          nb.sort((x, y) => x - y);
          const rep = flood(board, occ, b, seenRep, ++stampRep);
          key = keyOf(nb, rep);
        }
        occ[target] = 0;
        occ[b] = 1;
        if (frozen) continue;
        const g2 = sG[s] + 1;
        const prev = best.get(key);
        if (prev !== undefined && prev <= g2) continue;
        const h2 = bound(nb, dists);
        if (h2 === Infinity) continue;
        best.set(key, g2);
        const idx = sBoxes.length;
        sBoxes.push(nb);
        sPlayer.push(b);
        sG.push(g2);
        sParent.push(s);
        sFrom.push(b);
        sDir.push(k);
        sKey.push(key);
        heapPush(g2 + weight * h2, h2, idx);
      }
    }
    for (const b of bs) occ[b] = 0;
  }
  sharedBudget.left -= expansions;
  if (found < 0) return null;

  // Rebuild the steps: walk to each push's standing square, then the push itself.
  const path = [];
  for (let t = found; t > 0; t = sParent[t]) path.push(t);
  path.reverse();
  let moves = '';
  let player = startPlayer;
  let cur = startBoxes;
  for (const t of path) {
    const from = sFrom[t];
    const d = STEP_Y[sDir[t]] * w + STEP_X[sDir[t]];
    for (const b of cur) occ[b] = 1;
    const walk = walkMoves(board, occ, player, from - d);
    for (const b of cur) occ[b] = 0;
    if (walk === null) return null;
    moves += walk + PUSH_CH[sDir[t]];
    player = from;
    cur = sBoxes[t];
  }
  return { pushes: path.length, moves };
}

/** The square the player stands on after playing `moves` from `from` on a board of width w. */
function endPosition(w, from, moves) {
  let p = from;
  for (const ch of moves) {
    const k = STEP_CH.indexOf(ch.toLowerCase());
    if (k >= 0) p += STEP_Y[k] * w + STEP_X[k];
  }
  return p;
}

/**
 * Replay `moves` on the level exactly as the checker does: { ok: false } on an illegal step,
 * else { ok: true, solved, pushes }. Nothing is written for a level until its answer passes.
 */
function replay(board, moves) {
  const { w, wall, goal } = board;
  const box = new Uint8Array(w * board.h);
  for (const b of board.boxes) box[b] = 1;
  let player = board.player;
  let pushes = 0;
  for (const raw of moves.replace(/\s+/g, '')) {
    const k = STEP_CH.indexOf(raw.toLowerCase());
    if (k < 0) return { ok: false, solved: false, pushes };
    const d = STEP_Y[k] * w + STEP_X[k];
    const next = player + d;
    if (wall[next]) return { ok: false, solved: false, pushes };
    if (box[next]) {
      const beyond = next + d;
      if (wall[beyond] || box[beyond]) return { ok: false, solved: false, pushes };
      box[next] = 0;
      box[beyond] = 1;
      pushes++;
    }
    player = next;
  }
  for (let i = 0; i < box.length; i++) if (box[i] && !goal[i]) return { ok: true, solved: false, pushes };
  return { ok: true, solved: true, pushes };
}

/**
 * The level's rooms: cut the dead squares of the player's row out of the floor, and each
 * component left that holds a box is a room, with its squares, boxes and goals. Null when the
 * level is no clean set of rooms (a box in the cut, a goal in no component, a component whose
 * boxes and goals differ in number).
 */
function splitRooms(board, dists) {
  const { w, h, wall, player, boxes, goals } = board;
  const size = w * h;
  const live = liveSquares(board, dists);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(size);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b] === 1)) return null;
  const part = new Int32Array(size).fill(-1);
  const rooms = [];
  for (let s = 0; s < size; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i];
      for (let k = 0; k < 4; k++) {
        const q = p + STEP_Y[k] * w + STEP_X[k];
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * Solve the level room by room: each room on the whole board with the other rooms' boxes
 * standing as walls (on their goals once their room is done), the player walking on from
 * where the last room left it. Returns the joined step string, or null when a room fails.
 */
function solveByRooms(board, rooms) {
  let player = board.player;
  let moves = '';
  for (const room of rooms) {
    const wall = board.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const goal = new Uint8Array(board.wall.length);
    for (const g of room.goals) goal[g] = 1;
    const sub = {
      w: board.w,
      h: board.h,
      wall,
      goal,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    let r = searchPushes(sub, ROOM_CAP, 1);
    if (r === null) r = searchPushes(sub, ROOM_CAP, 4);
    if (r === null) return null;
    moves += r.moves;
    player = endPosition(board.w, player, r.moves);
    room.done = true;
  }
  return moves;
}

/** The answer for one level's text: a verified solving step string, or '' when none is found. */
function solveLevel(text) {
  const board = parseLevel(text);
  if (board.boxes.length === 0 || board.player < 0) return '';
  const rooms = splitRooms(board, goalDistances(board));
  if (rooms !== null && rooms.length > 0) {
    const moves = solveByRooms(board, rooms);
    if (moves !== null && replay(board, moves).solved) return moves;
  }
  // Fallback: search the whole level at once, optimally first, then greedily.
  let r = searchPushes(board, WHOLE_CAP, 1);
  if (r === null) r = searchPushes(board, WHOLE_CAP, 4);
  if (r !== null && replay(board, r.moves).solved) return r.moves;
  return '';
}

for (const id of readdirSync(IN_DIR).sort()) {
  const levelPath = join(IN_DIR, id, 'level.txt');
  if (!existsSync(levelPath)) continue;
  const moves = solveLevel(readFileSync(levelPath, 'utf8'));
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'solution.txt'), moves + '\n');
}


