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

## PART 2 — The Tyrant / Treachery Path ⏳ NOT STARTED

### Build order (recommended)
1. **Corruption state + corruptionBand() display** — add `corruption` field per faction, `corruptionBand(n)` pure helper, self-visible-only UI band. All behind `tyrantOn()` guard.
2. **Boons (Tithe / Sic the blob)** — chosen at Tyrant pact signing, locked. Tithe: +1 troop on frontline each round. Sic: Tyrant attacks one adjacent enemy per round.
3. **Victory forfeit** — while `corruption > 0`, node/timeout wins blocked. Redemption: renounce + purge to 0 restores eligibility.
4. **Tribute events** — every N rounds while bound, pay tribute or corruption spikes (+2).
5. **Tyrant betrayal flip** — `tyrantConquest` flag. Triggers when diplomacy win becomes impossible (a contender refuses). Tyrant turns on allies.
6. **Reckoning duel** — elimination trigger → sub-mode. Strike/Purge/Bargain actions. Essence = base + corruption. Tyrant wins ties.
7. **Fallen vote** — eliminated players spend influence to nudge duel rolls. Anti-Tyrant default, flips spiteful if conspirator eliminated them.
8. **AI for all above** — sign decision, boon pick, corruption management, betrayal flip, Reckoning play, fallen vote leaning.
9. **Sim instrumentation + calibration** — Tyrant win rate, conspirator Reckoning win rate by corruption tier, base-four shift.

### Hard requirements
- **Zero leakage**: every Part 2 mechanic behind explicit `tyrantOn()` guard. N=1000 Tyrant-OFF run after Part 2 must reproduce post-5b baseline within noise.
- **Corruption never rendered as raw integer** — only `corruptionBand()` label.
- **Boon chosen once at signing, locked for duration.**
- **Calibration targets**: prepared conspirator Reckoning win ~45–55%, greedy conspirator ~15–25%.

### Key existing Tyrant infrastructure (already in codebase)
- `G.setup.tyrant` toggle + lobby UI ("+ ADD TYRANT" card)
- `TYRANT_KEY`, `TYRANT_DEF` constants in state.js
- `tyrantOn()`, `tyrantAlive()`, `tyrantAllies()` helpers in app.js
- `tyrantSpread(fk)` — blob expansion (capped at 4/turn)
- `tyrantInteract(fk)` — secret deal offer/harbor request at turn start
- `killFaction` routes through Tyrant harbor reprieve
- Tyrant pacts are durable (exempt from 4-round lapse)
- Tyrant diplomacy win: all surviving rivals allied → Tyrant wins
- AI: Tyrant accepts every pact; contenders refuse Tyrant; weak AIs appease

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
