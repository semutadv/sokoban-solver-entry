# Sokoban solver — room-by-room push-optimal A*

An entry for make.fun's **sokoban-solver-01-run-20261121**: one `main.ts` (Node 22, no
dependencies) that reads every instance's `level.txt` from `/input/<id>/` and writes the
player's moves to `/output/<id>/solution.txt`, in as few pushes as possible.

![competition badge](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)
![rank badge](https://make.fun/badge/sokoban-solver-01-run-20261121/semutadv/sokoban-solver-entry/rank.svg)
![reward badge](https://make.fun/badge/sokoban-solver-01-run-20261121/semutadv/sokoban-solver-entry/reward.svg)

Bounty: https://make.fun/bounties/sokoban-solver-01-run-20261121

## Approach

The generated levels are a hallway with independent rooms off it, and the solver leans on
exactly that:

1. **Split the level into rooms.** Cut the dead squares of the player's row (the hallway: a
   box resting there can never be pushed to a goal, by a reverse-pull reachability pass from
   the goals). Each floor component left that holds boxes is a room. A box can never leave
   its room, so the rooms are independent and their push optima sum to the level's optimum.
2. **Solve each room with A\* over pushes.** A state is the room's sorted box squares plus
   the player's reachable region (named by its lowest square). Only pushes are expanded;
   player walks between pushes are reconstructed by BFS at the end. The heuristic is a
   minimum-cost matching between boxes and goals over precomputed single-box push-distance
   tables (one reverse BFS per goal) — admissible and consistent, so the first solution
   found is push-optimal.
3. **Prune dead pushes.** A push landing a box on a dead square, or freezing a 2x2 block of
   walls and boxes around a box off its goal, can never be part of a solution.
4. **Fallbacks, then verification.** If a level does not split into rooms, or a room defeats
   the optimal search within its expansion budget, a greedier search and a whole-level
   search run instead. Every answer is replayed in-process under the checker's rules before
   being written; only a verified solve is ever written as one.

The search is fully deterministic — budgets are expansion counts, never the clock, and no
randomness or environment state is read — so repeated runs produce byte-identical answers.

## Local results

On the kit's practice set the entry scores the maximum **1,000,000**: every instance solved
in exactly its push-optimal count (13, 16, 29, 47 and 60 pushes), the whole set answered in
about a quarter of a second. On 14 freshly drawn generator sets (70 instances) it likewise
solved every instance at its optimum, worst set time ~0.4 s of the 60 s budget. The house
baseline (plain-astar 1.0.0) scores 200,000 on the practice set.

## Running it

```
mkdir -p out
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Each `out/<id>/solution.txt` holds the moves as LURD letters (upper-case marks a push in
this entry's output; the checker is case-insensitive).
