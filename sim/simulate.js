// ============================================================
// simulate.js — Headless AI-vs-AI simulation harness
// Run: node sim/simulate.js [numGames] [seed]
// Or open sim/index.html in a browser.
// ============================================================

import { reduce, buildMap } from '../src/engine.js';
import { chooseAction, aiChooseEvent, aiConsiderPact } from '../src/ai.js';
import {
  RES_CAP, ROUND_CAP, FACTIONS, TYRANT_KEY, TRAITS, EVENT_DEFS,
  factionDef, mkFaction, livingKeys, hasPact, pairKey, countNodes, tilesOf,
} from '../src/state.js';
import { makeRng, nextInt, shuffleWithRng } from '../src/rng.js';

// ---- Create initial game state ----
function initGame(seed, opts = {}) {
  let rng = makeRng(seed);

  // Assign random traits
  const factions = {};
  const keys = Object.keys(FACTIONS);
  for (const k of keys) {
    const r = nextInt(rng, TRAITS.length);
    rng = r.rng;
    factions[k] = mkFaction(FACTIONS[k].name, k, true, TRAITS[r.value].id);
  }

  // Shuffle turn order
  const r0 = shuffleWithRng(keys, rng);
  rng = r0.rng;
  const turnOrder = r0.value;

  const state = {
    round: 1,
    signalJam: false,
    totalWar: false,
    currentTurnIdx: 0,
    actionsUsed: 0,
    turnAttacks: 0,
    assaultCaptures: 0,
    assaultOn: false,
    factions,
    turnOrder,
    humans: [],
    live: false,
    tyrantOn: !!opts.tyrant,
    tyrantHarbor: 0,
    tyrantLastOffer: {},
    nodesHeldSince: {},
    tiles: {},
    log: [],
    pacts: {},
    grudges: {},
    playerFaction: turnOrder[0],
    rng,
    seq: 0,
  };

  if (opts.tyrant) {
    const r = nextInt(rng, TRAITS.length);
    rng = r.rng;
    state.rng = rng;
    factions[TYRANT_KEY] = mkFaction('THE TYRANT', TYRANT_KEY, true, TRAITS[r.value].id);
    turnOrder.push(TYRANT_KEY);
  }

  state.tiles = buildMap(state);
  return state;
}

// ---- Run one full game, return stats ----
function runGame(seed, opts = {}) {
  let state = initGame(seed, opts);
  const verbose = opts.verbose || false;

  for (let round = 1; round <= ROUND_CAP + 1; round++) {
    // Start round
    let result = reduce(state, { type: 'START_ROUND' });
    state = result.state;
    if (verbose) result.log.forEach(l => console.log(`  R${state.round}: ${l}`));

    // Apply event
    result = reduce(state, { type: 'APPLY_EVENT' });
    state = result.state;
    if (verbose) result.log.forEach(l => console.log(`  EVENT: ${l}`));

    // Handle choice events
    const ev = state.eventCard;
    if (ev) {
      const evDef = EVENT_DEFS[ev.evIdx];
      if (evDef && evDef.type === 'CHOICE') {
        for (const fk of livingKeys(state)) {
          const choiceIdx = aiChooseEvent(state, fk, evDef.key);
          result = reduce(state, { type: 'CHOICE', eventKey: evDef.key, faction: fk, choiceIdx });
          state = result.state;
        }
      }
    }

    // Each faction's turn
    for (let ti = 0; ti < state.turnOrder.length; ti++) {
      state.currentTurnIdx = ti;
      const fk = state.turnOrder[ti];
      if (state.factions[fk].eliminated) continue;

      // Begin turn (income)
      result = reduce(state, { type: 'BEGIN_TURN', faction: fk });
      state = result.state;

      // Tyrant spread
      if (fk === TYRANT_KEY) {
        result = reduce(state, { type: 'TYRANT_SPREAD' });
        state = result.state;
      }

      // AI actions (up to 3 + assault chains)
      let actionsLeft = 3;
      let aiCaptures = 0;

      for (let step = 0; step < 30 && actionsLeft > 0; step++) {
        const action = chooseAction(state, fk);
        if (!action) break;

        if (action.breakPact) {
          result = reduce(state, { type: 'BREAK_PACT', ...action.breakPact });
          state = result.state;
        }

        result = reduce(state, action);
        state = result.state;
        if (verbose) result.log.forEach(l => console.log(`    ${fk}: ${l}`));

        // Check for win
        const winEffect = result.effects.find(e => e.kind === 'win');
        if (winEffect || state.winner) {
          return summarize(state, seed);
        }

        // Action accounting
        if (action.type === 'ATTACK') {
          const captured = result.effects.some(e => e.kind === 'capture');
          if (captured) aiCaptures++;
          if (!result.effects.some(e => e.kind === 'combat' && e.won) || aiCaptures >= 3) {
            actionsLeft--;
            aiCaptures = 0;
          }
          // Don't decrement on winning attack (press assault)
        } else {
          actionsLeft--;
          aiCaptures = 0;
        }
      }

      // End turn
      result = reduce(state, { type: 'END_TURN' });
      state = result.state;
    }

    // End round
    result = reduce(state, { type: 'END_ROUND' });
    state = result.state;
    if (verbose) result.log.forEach(l => console.log(`  ${l}`));

    const winEffect = result.effects.find(e => e.kind === 'win');
    if (winEffect || state.winner) {
      return summarize(state, seed);
    }
  }

  // Should not reach here (ROUND_CAP triggers TIMED OUT)
  return summarize(state, seed);
}

function summarize(state, seed) {
  const winner = state.winner;
  return {
    seed,
    round: state.round,
    winnerFk: winner?.fk || null,
    condition: winner?.condition || 'UNKNOWN',
    detail: winner?.detail || '',
    factions: Object.fromEntries(
      Object.entries(state.factions).map(([k, f]) => [k, {
        name: f.name,
        trait: f.trait,
        eliminated: f.eliminated,
        tiles: tilesOf(state, k).length,
        nodes: countNodes(state, k),
        resources: f.resources,
      }])
    ),
  };
}

// ---- Run N games and aggregate stats ----
export function runBatch(numGames, baseSeed = 1, opts = {}) {
  const results = [];
  const winCounts = {};
  const condCounts = {};
  const traitWins = {};
  const roundSum = [];

  for (let i = 0; i < numGames; i++) {
    const seed = baseSeed + i;
    try {
      const result = runGame(seed, opts);
      results.push(result);

      const fk = result.winnerFk || 'none';
      winCounts[fk] = (winCounts[fk] || 0) + 1;
      condCounts[result.condition] = (condCounts[result.condition] || 0) + 1;
      roundSum.push(result.round);

      if (result.winnerFk && result.factions[result.winnerFk]) {
        const trait = result.factions[result.winnerFk].trait;
        traitWins[trait] = (traitWins[trait] || 0) + 1;
      }
    } catch (e) {
      console.error(`Game ${i} (seed=${seed}) crashed:`, e.message);
    }
  }

  const avgRound = roundSum.length ? (roundSum.reduce((a,b) => a+b, 0) / roundSum.length).toFixed(1) : 0;

  return {
    numGames,
    winCounts,
    condCounts,
    traitWins,
    avgRound,
    results,
  };
}

// ---- CLI entry point ----
const isCLI = typeof process !== 'undefined' && process.argv;
if (isCLI) {
  const args = (typeof process !== 'undefined' && process.argv) || [];
  const numGames = parseInt(args[2]) || 100;
  const baseSeed = parseInt(args[3]) || 1;

  console.log(`\n=== FRACTURE HEADLESS SIM ===`);
  console.log(`Running ${numGames} AI-vs-AI games (base seed: ${baseSeed})...\n`);

  const t0 = Date.now();
  const stats = runBatch(numGames, baseSeed);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  console.log(`Completed in ${elapsed}s\n`);

  console.log('--- Win Rates by Faction ---');
  for (const [fk, n] of Object.entries(stats.winCounts).sort((a,b) => b[1] - a[1])) {
    console.log(`  ${fk.padEnd(12)} ${n.toString().padStart(4)}  (${(n/numGames*100).toFixed(1)}%)`);
  }

  console.log('\n--- Win Conditions ---');
  for (const [c, n] of Object.entries(stats.condCounts).sort((a,b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(20)} ${n.toString().padStart(4)}  (${(n/numGames*100).toFixed(1)}%)`);
  }

  console.log('\n--- Winning Traits ---');
  for (const [t, n] of Object.entries(stats.traitWins).sort((a,b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(12)} ${n.toString().padStart(4)}  (${(n/numGames*100).toFixed(1)}%)`);
  }

  console.log(`\nAvg rounds per game: ${stats.avgRound}`);
}
