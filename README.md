# Sokoban Solver — sokoban-solver-01-run-20261121

![competition](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)
![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/semutadv/sokoban-solver-entry/rank.svg)
![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/semutadv/sokoban-solver-entry/reward.svg)

Push-optimal Sokoban solver in one dependency-free `main.ts` (Node 22).

A generated level is a hallway one square wide with independent rooms off
it, and a box pushed out of its room is lost, so a level's push optimum is
the sum of its rooms' optima. The solver splits the level into rooms at
the hallway row, then solves each room by breadth-first search over
pushes: a state is the sorted box squares plus the player's walking
region, pushes landing a box on a dead square are pruned, and the walks
between pushes are rebuilt from parent links. Rooms are joined by plain
walks along the hallway. Deterministic: fixed orders everywhere, no
clock, no randomness.

Perfect on the practice set: 1,000,000, every instance in P* pushes.

MIT licensed.
