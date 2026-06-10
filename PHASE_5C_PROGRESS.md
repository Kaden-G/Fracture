# FRACTURE — Phase 5c Progress

## Branch: `feature/pacts-and-tyrant`

---

## PART 1 — Pact System Overhaul ✅ COMPLETE

### What was built
- **RENOUNCE action** (`engine.js`): new `{ type:'RENOUNCE', from, target }` reducer branch. Deletes pact, no grudge, sets `renouncedThisTurn[target] = true`.
- **Same-turn aggression guard**: `renouncedThisTurn` is per-faction (renounce X doesn't block attacking Y). Cleared in `BEGIN_TURN`.
  - ATTACK blocked against renounced faction same turn
  - SABOTAGE blocked against renounced faction same turn
  - BRIBE blocked against renounced faction same turn
  - PACT re-proposal blocked against renounced faction same turn
- **UI**: `📜 RENOUNCE` button added to action bar (`index.html`), wired into `enablePlayerActions`/`disablePlayerActions`/`setAction` with hint text.
- **Player handler** (`app.js`): validates pact exists, deletes it, sets guard, logs "📜 A non-aggression pact was withdrawn."
- **AI turn**: `renouncedThisTurn = {}` reset at both player turn start and AI turn start.
- **Engine tests**: 5 tests in `test/engine.test.js` (renounce removes pact with no grudge, sets guard, guard clears on BEGIN_TURN, betray still grudges, no-op on non-pact). Tests require Node.js to run (`node --test test/engine.test.js`); Node was not in PATH during this session.

### Files modified (Part 1)
- `src/engine.js` — RENOUNCE case + renouncedThisTurn reset in BEGIN_TURN
- `src/app.js` — renounce handler, aggression guards on attack/sabotage/bribe/pact, button wiring, AI turn reset
- `index.html` — RENOUNCE button in action bar
- `test/engine.test.js` — 5 renounce tests + hasPact/pairKey imports

### Gate result
N=1000 regression check passed — within 0.1pp of post-5b baseline:
```
commune  28.2%  (baseline 28.1%)
grid     26.6%  (baseline 26.6%)
syndicate 25.2% (baseline 25.2%)
ghost    20.0%  (baseline 20.1%)
```

### Commit
`05bad0d` — "Part 1: Renounce action — peaceful pact exit with same-turn aggression guard"

---

## PART 2 — The Tyrant / Treachery Path ✅ COMPLETE

### What was built
1. **Corruption state + corruptionBand()** — `corruption` integer per faction, `corruptionBand(n)` pure helper (4 tiers), self-visible-only UI chip. +1/round while allied with Tyrant.
2. **Boons (Tithe / Sic)** — chosen at pact signing, locked. Tithe: +1 troop weakest frontline tile/round. Sic: Tyrant attacks one adjacent enemy/round per sic ally.
3. **Victory forfeit** — corruption > 0 blocks NODE DOMINANCE and TIMED OUT wins. Renounce purges corruption to 0 (redemption path).
4. **Tribute** — every 3 rounds while allied, pay 2 resources or +2 corruption surge. Humans prompted; AI auto-pays if affordable.
5. **Tyrant betrayal flip** — `tyrantConquest` flag. Triggers when all un-allied rivals refused. Breaks all existing Tyrant pacts.
6. **Reckoning duel** — best-of-3 dice (2d6 + essence). Tyrant essence = tiles + 3. Conspirator essence = tiles + corruption. Tyrant wins ties. Winner: resurrects or dies permanently.
7. **Fallen vote** — each eliminated faction adds +1 to one side. Anti-Tyrant default; spiteful (pro-Tyrant) if conspirator has grudge from them.
8. **AI** — `aiConsiderPact` Tyrant-specific logic (contenders refuse, weak appease). `aiPickBoon()` heuristic. `TYRANT_COURT`/`TYRANT_BETRAY` engine actions. Sim courting loop.
9. **Leakage test** — N=1000 Tyrant-OFF matches baseline (±0.1pp).

### Files modified (Part 2)
- `src/state.js` — corruption + boon fields in mkFaction, corruptionBand()
- `src/engine.js` — corruption tick, tithe, tribute, sic, victory forfeit, TYRANT_COURT, TYRANT_BETRAY, Reckoning duel, fallen vote
- `src/app.js` — all above mirrored + human prompts (boon selection, tribute, Reckoning alert) + UI corruption band chip
- `src/ai.js` — aiConsiderPact Tyrant logic, aiPickBoon()
- `sim/simulate.js` — tyrantConquest state, Tyrant courting/betrayal loop, aiPickBoon import

### Gate result
N=1000 Tyrant-OFF regression passed — within 0.1pp of baseline:
```
commune  28.2%  (baseline 28.1%)
grid     26.6%  (baseline 26.6%)
syndicate 25.2% (baseline 25.2%)
ghost    20.0%  (baseline 20.1%)
```

---

## PART 3 — Tyrant-ON Sim Calibration ⏳ IN PROGRESS

### Goals
- Run N=1000 with Tyrant ON to establish Tyrant-ON baseline
- Measure: Tyrant win rate, faction win rates, Reckoning outcomes, corruption distribution
- Calibration targets: prepared conspirator Reckoning win ~45–55%, greedy conspirator ~15–25%
- Tune Tyrant essence bonus, tribute cost, boon strength as needed

---

## Post-5b Baseline (reference for all regression checks)
```
N=1000, seed=1 (verified stable across seed=45 as well)
commune  28.1%  |  grid  26.6%  |  syndicate  25.2%  |  ghost  20.1%
Win conditions: NODE DOMINANCE 76.4%, TIMED OUT 22.2%, LAST STANDING 1.4%
Avg rounds: 19.1  |  Median: 18  |  Early (<R8): 72
```

## Phase 5b Changes in effect
- Sabotage removes 2 troops (Change A)
- Ghost infiltration: 2-tile move through enemies, 3 with ghost_step (Change B)
- Commune grassroots every other round (Change D)
- Grid excluded from ghost_step trait (TRAIT_EXCLUSIONS)
- Smart AI sabotage targeting + ghost_step stacking
