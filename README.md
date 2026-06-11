# FRACTURE

A browser strategy game for 1–4 players (plus AI). Four factions fight for the broken
grid of Nexus — hold **3 of 5 Core Nodes for 2 consecutive rounds**, or eliminate every
rival, to win. Dominate. Negotiate. Betray. Survive.

**Play:** https://kaden-g.github.io/Fracture/

## The game

- **Board:** a 7×7 hex grid split into four cardinal regions (N/E/S/W) around a neutral
  core. Five Core Node tiles (⚡ Power, 💧 Water, 🚇 Transit, 📡 Comms, 🖧 Data) each grant
  their controller a passive bonus on top of income.
- **Turns:** every round opens with an event card, then each faction takes 3 actions —
  Move, Attack, Reinforce, Airlift, Entrench, plus a faction ability. Pacts are free.
- **Combat:** 2d6 vs 2d6 with modifiers for force, entrenchment, grudges, node bonuses,
  and an anti-snowball coalition. Winning attacks can "press the assault" — keep striking
  for free while defenders rally harder each strike (max 3 captures per chain).
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
| 👁️ THE GHOST | Attacks ignore entrenchment; moves 2 tiles through enemies | Sabotage — hit any enemy tile; first hit per turn siphons the troop to you (1 res) |

## 🦠 The Tyrant (optional fifth player)

An always-AI menace that festers at the center of the board and **spreads like a virus**
every turn. It offers each faction a **secret pact** with a boon (🩸 Tithe: +1 troop a
round, or 👹 Sic: it attacks your enemies) — but allied factions pay tribute, get
skimmed, and accrue hidden **corruption**. Win while corrupt and you must first survive
the **Reckoning**, a best-of-3 duel against the Tyrant; hit the corruption cap and you
become its thrall. Cornered, it can be harbored back to life by an ally; bound factions
can renounce it at the brink of victory — at a price.

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
