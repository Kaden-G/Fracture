# FRACTURE

A browser strategy game for 1–4 players (plus AI). Four factions fight for the broken
grid of Nexus — hold **any 3 Core Nodes for 2 consecutive rounds**, or eliminate every
rival, to win. Dominate. Negotiate. Betray. Survive.

**Play:** https://kaden-g.github.io/Fracture/

## The game

- **Board:** a 7×7 hex grid split into four cardinal regions (N/E/S/W) around a neutral
  core. Five Core Node tiles (⚡ Power, 💧 Water, 🚇 Transit, 📡 Comms, 🖧 Data) each grant
  their controller a passive bonus on top of income.
- **Turns:** every round opens with an event card, then each faction takes 3 actions —
  Move, Attack, Reinforce, Airlift, Entrench, plus a faction ability. Pacts are free.
- **Combat:** 2d6 vs 2d6 with modifiers for force (+1 per 4 troops, capped at +2),
  entrenchment, grudges, node bonuses, and an anti-snowball coalition. Stacks cap at
  **12 troops**, so chip damage always bites. Winning attacks can "press the assault" —
  keep striking for free (max 3 captures per chain); rally is **per-encounter**: grinding
  the *same defending tile from the same attacker* digs the defender in +2 each repeat,
  but switching attacker or target fights fresh.
- **Events:** regional chaos (Power Failure, Uprising, Earthquake, Riot, Siege, Muster,
  Gold Strike), global swings (Market Crash, Revolution, Total War, Insurgency), and
  choice cards (Warlord's Tribute, Mercenary Contract) where every faction — human or
  AI — decides for itself. Options a faction can't afford are disabled, never silent.
- **Diplomacy:** non-aggression pacts (lapse after 4 rounds), betrayal grudges (+2 vs
  the betrayer for 2 rounds), and peaceful renounce.
- **Traits:** each player picks a passive — Last Stand, Scavenger, Hoarder, Ghost Step,
  Tactician, or Fortify.

## Factions

| Faction | Perk | Ability |
|---|---|---|
| ⚙️ THE GRID | Reinforce costs 1 less | Overclock — +3 troops on a tile (1 res) |
| 💰 SYNDICATE | +1 resource income each round | Bribe — steal a troop from an adjacent enemy (1 res) |
| 🌿 COMMUNE | +1 troop grows every other round | Rally — buff a tile and adjacent friendlies (1 res) |
| 👁️ THE GHOST | Attacks ignore entrenchment; moves **or attacks** 2 tiles, leapfrogging through anything | Sabotage — **−2** to any enemy tile; the first hit per turn siphons up to **+2** to your weakest frontline (1 res) |

## 🦠 The Tyrant (optional fifth player)

An always-AI menace that festers at the center of the board and **spreads like a virus**
toward its enemies every turn. Each round it offers a bound faction a fresh **bargain**
(🩸 Tithe: +1 troop a round, or 👹 Sic: it attacks your enemies) — but allied factions pay
tribute, get skimmed, and accrue hidden **corruption**. Win while corrupt and you must
first survive the **Reckoning**, a best-of-3 duel against the Tyrant; hit the corruption
cap and you become its thrall. Cornered, it can be harbored back to life by an ally; bound
factions can renounce it at the brink of victory — at a price.

It is also the **shared enemy**, so it plays by harsher rules: it carries **no trait** and
**never rallies**, so the coalition can grind it down without its defense escalating. Slay
it and its former seat becomes a **☠ Graveyard** node — no passive, just a bounty for
whoever lands the kill.

The Tyrant also wins by **diplomacy**: holding a pact with every surviving rival.
**In single-human games it can hold at most 3 pacts at once**, so it can never win by
diplomacy alone — someone has to fall first.

## Play modes

- **Hot-seat:** 1–4 humans pass-and-play on one device; AI fills the remaining seats.
- **Online:** cross-device multiplayer over Firebase Realtime Database — host a room,
  share the 4-letter code, claim seats in the lobby.

## Project layout

```
index.html        UI shell, overlays, rules
styles.css        presentation
src/app.js        the game the browser runs (UI + engine + online layer)
src/state.js      shared constants & pure helpers
src/engine.js     pure reducer port of the engine (no DOM/RNG side effects)
src/ai.js         pure AI decision-making
src/rng.js        seedable RNG
test/             engine unit tests
sim/              headless balance simulator
```

No build step — serve the repo statically. Tests: `npm test` · Balance sims: `npm run sim`
