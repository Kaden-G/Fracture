// ============================================================
// simulate.js — Headless AI-vs-AI simulation harness
// Run: node sim/simulate.js [numGames] [seed]
// Or open sim/index.html in a browser.
// ============================================================

import { reduce, buildMap } from '../src/engine.js';
import { chooseAction, aiChooseEvent, aiConsiderPact, aiPickBoon, aiShouldRenounce } from '../src/ai.js';
import {
  RES_CAP, ROUND_CAP, FACTIONS, TYRANT_KEY, TRAITS, EVENT_DEFS,
  factionDef, mkFaction, livingKeys, hasPact, pairKey, countNodes, tilesOf, traitsFor,
} from '../src/state.js';
import { AI_PROFILES, DEFAULT_TIER } from '../src/ai_profiles.js';
import { makeRng, nextInt, shuffleWithRng } from '../src/rng.js';

// ---- Create initial game state ----
function initGame(seed, opts = {}) {
  let rng = makeRng(seed);
  // Phase 5 step 2: AI difficulty tier (sandbox|jv|varsity|bloodbath). Default tracks the live
  // game's default so the baseline sim matches what a fresh single-player game would feel like.
  const diff = AI_PROFILES[opts.diff] ? opts.diff : DEFAULT_TIER;

  // Assign random traits
  const factions = {};
  const keys = Object.keys(FACTIONS);
  for (const k of keys) {
    const pool = traitsFor(k);  // Phase 5b: faction-specific trait pool
    const r = nextInt(rng, pool.length);
    rng = r.rng;
    factions[k] = mkFaction(FACTIONS[k].name, k, true, pool[r.value].id, diff);
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
    tyrantStruck: {},
    tyrantConquest: false,
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
    // The Tyrant carries NO trait. We still burn one RNG draw here so the random stream stays
    // byte-aligned with prior runs (keeps controlled before/after gates clean — only the trait
    // changes, not the dice that follow).
    const r = nextInt(rng, TRAITS.length);
    rng = r.rng;
    state.rng = rng;
    factions[TYRANT_KEY] = mkFaction('THE TYRANT', TYRANT_KEY, true, null);
    turnOrder.push(TYRANT_KEY);
  }

  state.tiles = buildMap(state);
  return state;
}

// ---- Run one full game, return stats ----
function runGame(seed, opts = {}) {
  let state = initGame(seed, opts);
  const verbose = opts.verbose || false;
  let _dbgPhase = 'init', _dbgFk = '';
  // Phase 5 instrumentation: track the FIRST faction to hit 3 nodes and how the game resolved
  // from there. The lever Phase 5 tests is "is a 3-node lead near-impregnable?" — answered by
  // first3.winRate = (games where first3.fk also wins) / (games where first3.fk exists).
  let first3 = null;            // { fk, round } — first faction to hit 3 nodes, and when
  let first3MaxHeld = 0;        // longest consecutive-turn streak they held 3 (in END_TURN samples)
  let first3CurrentStreak = 0;  // resets if they drop below 3
  function noteThreeNodeState() {
    for (const fk of livingKeys(state)) {
      if (fk === TYRANT_KEY) continue;
      const n = countNodes(state, fk);
      if (!first3 && n >= 3) {
        first3 = { fk, round: state.round };
        first3CurrentStreak = 1;
        first3MaxHeld = 1;
      } else if (first3 && fk === first3.fk) {
        if (n >= 3) {
          first3CurrentStreak++;
          if (first3CurrentStreak > first3MaxHeld) first3MaxHeld = first3CurrentStreak;
        } else {
          first3CurrentStreak = 0;
        }
      }
    }
  }
  try {
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
      _dbgPhase = 'turn'; _dbgFk = fk;
      if (state.factions[fk].eliminated) continue;

      // Begin turn (income)
      result = reduce(state, { type: 'BEGIN_TURN', faction: fk });
      state = result.state;

      // Tyrant spread + courting + betrayal
      if (fk === TYRANT_KEY) {
        result = reduce(state, { type: 'TYRANT_SPREAD' });
        state = result.state;
        // Part 2 Step 8: Tyrant courts un-allied AI factions
        if (state.tyrantOn && !state.tyrantConquest && state.factions[TYRANT_KEY] && !state.factions[TYRANT_KEY].eliminated) {
          const unAllied = livingKeys(state).filter(k => k !== TYRANT_KEY && !hasPact(state, TYRANT_KEY, k));
          let anyAccepted = false;
          let allRefusedThisRound = true;
          for (const k of unAllied) {
            if (!state.tyrantLastOffer) state.tyrantLastOffer = {};
            const last = state.tyrantLastOffer[k] || -99;
            if (state.round - last >= 3) {
              state.tyrantLastOffer[k] = state.round;
              if (aiConsiderPact(state, k, TYRANT_KEY)) {
                const boon = aiPickBoon(state, k);
                result = reduce(state, { type: 'TYRANT_COURT', target: k, boon });
                state = result.state;
                anyAccepted = true;
                allRefusedThisRound = false;
              }
            } else {
              allRefusedThisRound = false; // not offered this round, can't count as refusal
            }
          }
          // Reset streak if any new pact formed; increment if all refused
          if (!state.tyrantRefusalStreak) state.tyrantRefusalStreak = 0;
          if (anyAccepted) {
            state.tyrantRefusalStreak = 0;
          } else if (unAllied.length > 0 && allRefusedThisRound) {
            state.tyrantRefusalStreak++;
          }
          // Conquest flip: only after 3 consecutive rounds of universal refusal
          if (state.tyrantRefusalStreak >= 3) {
            const stillUnAllied = livingKeys(state).filter(k => k !== TYRANT_KEY && !hasPact(state, TYRANT_KEY, k));
            if (stillUnAllied.length > 0) {
              result = reduce(state, { type: 'TYRANT_BETRAY' });
              state = result.state;
            }
          }
        }
      }

      // AI redemption: bound AI may renounce-kill the Tyrant
      _dbgPhase = 'renounce';
      if (fk !== TYRANT_KEY && aiShouldRenounce(state, fk)) {
        result = reduce(state, { type: 'RENOUNCE', from: fk, target: TYRANT_KEY });
        state = result.state;
        if (verbose) result.log.forEach(l => console.log(`    ${fk}: ${l}`));
        // Tyrant is now dead — check if game ended
        const winEffect = result.effects.find(e => e.kind === 'win');
        if (winEffect || state.winner) return summarize(state, seed, first3, first3MaxHeld);
      }

      // AI actions (up to 3 + assault chains)
      _dbgPhase = 'actions';
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
          return summarize(state, seed, first3, first3MaxHeld);
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
      noteThreeNodeState();   // Phase 5 instrumentation — sample after every turn
    }

    // End round
    result = reduce(state, { type: 'END_ROUND' });
    state = result.state;
    if (verbose) result.log.forEach(l => console.log(`  ${l}`));

    const winEffect = result.effects.find(e => e.kind === 'win');
    if (winEffect || state.winner) {
      return summarize(state, seed, first3, first3MaxHeld);
    }
  }

  // Should not reach here (ROUND_CAP triggers TIMED OUT)
  return summarize(state, seed, first3, first3MaxHeld);
  } catch (e) {
    e.message = `[R${state.round} phase=${_dbgPhase} fk=${_dbgFk}] ${e.message}`;
    throw e;
  }
}

function summarize(state, seed, first3 = null, first3MaxHeld = 0) {
  const winner = state.winner;
  // Count pacts at game end
  const pactCount = Object.keys(state.pacts || {}).length;
  const tyrantPacts = Object.keys(state.pacts || {}).filter(k => k.includes(TYRANT_KEY)).length;
  return {
    seed,
    round: state.round,
    winnerFk: winner?.fk || null,
    condition: winner?.condition || 'UNKNOWN',
    detail: winner?.detail || '',
    // Phase 5 instrumentation: which faction first hit 3 nodes, when, did they hold/win
    first3Fk: first3 ? first3.fk : null,
    first3Round: first3 ? first3.round : null,
    first3MaxHeld,
    first3Won: first3 && winner ? (first3.fk === winner.fk) : false,
    factions: Object.fromEntries(
      Object.entries(state.factions).map(([k, f]) => [k, {
        name: f.name,
        trait: f.trait,
        eliminated: f.eliminated,
        tiles: tilesOf(state, k).length,
        nodes: countNodes(state, k),
        resources: f.resources,
        corruption: f.corruption || 0,
        boon: f.boon || null,
      }])
    ),
    // Tyrant diagnostics
    pactCount,
    tyrantPacts,
    tyrantConquest: !!state.tyrantConquest,
    tyrantEliminations: state.tyrantEliminations || 0,
    renounceKills: state.renounceKills || 0,
    reckonings: state.reckonings || [],
  };
}

// ---- Run N games and aggregate stats ----
export function runBatch(numGames, baseSeed = 1, opts = {}) {
  const results = [];
  const winCounts = {};
  const condCounts = {};
  const traitWins = {};
  const roundSum = [];
  const factionCondBreakdown = {};  // fk -> { condition -> count }
  // Phase 5: 3-node-leader conversion. The headline question: of games where SOMEONE reaches
  // 3 nodes, what fraction of those games does that someone win? Target after Phase 5 levers
  // land: ~55-65%. Today's prediction: very high (>90%).
  let first3Total = 0;        // games where a faction reached 3 nodes (denominator)
  let first3Wins = 0;         // ...and went on to win
  const first3HeldDist = {};  // longest 3-node streak (in rounds) -> count, for shape of the win
  let errors = 0;

  for (let i = 0; i < numGames; i++) {
    const seed = baseSeed + i;
    try {
      const result = runGame(seed, opts);
      result.diff = opts.diff || DEFAULT_TIER;
      results.push(result);

      const fk = result.winnerFk || 'none';
      winCounts[fk] = (winCounts[fk] || 0) + 1;
      condCounts[result.condition] = (condCounts[result.condition] || 0) + 1;
      roundSum.push(result.round);

      // Per-faction win-condition breakdown
      if (!factionCondBreakdown[fk]) factionCondBreakdown[fk] = {};
      factionCondBreakdown[fk][result.condition] = (factionCondBreakdown[fk][result.condition] || 0) + 1;

      if (result.winnerFk && result.factions[result.winnerFk]) {
        const trait = result.factions[result.winnerFk].trait;
        traitWins[trait] = (traitWins[trait] || 0) + 1;
      }

      if (result.first3Fk) {
        first3Total++;
        if (result.first3Won) first3Wins++;
        const bucket = result.first3MaxHeld;
        first3HeldDist[bucket] = (first3HeldDist[bucket] || 0) + 1;
      }
    } catch (e) {
      if (errors < 5) console.error(`Game ${i} (seed=${seed}) phase=${e._dbgPhase||'?'} fk=${e._dbgFk||'?'} crashed:`, e.message, '\n', e.stack);
      errors++;
    }
  }

  const sorted = [...roundSum].sort((a,b) => a - b);
  const avgRound = sorted.length ? (sorted.reduce((a,b) => a+b, 0) / sorted.length).toFixed(1) : 0;
  const medianRound = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const earlyEndings = sorted.filter(r => r < 8).length;

  return {
    numGames,
    errors,
    winCounts,
    condCounts,
    traitWins,
    factionCondBreakdown,
    avgRound,
    medianRound,
    earlyEndings,
    first3Total,
    first3Wins,
    first3WinRate: first3Total ? (first3Wins / first3Total) : 0,
    first3Rate: numGames ? (first3Total / numGames) : 0,
    first3HeldDist,
    results,
  };
}

// ---- CLI entry point ----
const isCLI = typeof process !== 'undefined' && process.argv;
if (isCLI) {
  const args = (typeof process !== 'undefined' && process.argv) || [];
  // Strip optional --tier= flag from the positional args (so `--tier=jv 1000 1` still works).
  const tierArg = args.find(a => a.startsWith('--tier='));
  const tier = tierArg ? tierArg.slice(7) : DEFAULT_TIER;
  const pos = args.slice(2).filter(a => !a.startsWith('--'));
  const numGames = parseInt(pos[0]) || 100;
  const baseSeed = parseInt(pos[1]) || 1;
  if (!AI_PROFILES[tier]) {
    console.error(`Unknown tier "${tier}". Valid: ${Object.keys(AI_PROFILES).join(', ')}`);
    process.exit(1);
  }

  console.log(`\n=== FRACTURE HEADLESS SIM ===`);
  console.log(`Running ${numGames} AI-vs-AI games at tier=${tier} (base seed: ${baseSeed})...\n`);

  const t0 = Date.now();
  const stats = runBatch(numGames, baseSeed, { diff: tier });
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

  // Phase 5: 3-node-leader conversion — the headline difficulty metric.
  console.log('\n--- 3-Node Leader Conversion ---');
  console.log(`  Games where someone reached 3 nodes: ${stats.first3Total}/${numGames}  (${(stats.first3Rate*100).toFixed(1)}%)`);
  if (stats.first3Total > 0) {
    console.log(`  Of those, that faction went on to WIN: ${stats.first3Wins}/${stats.first3Total}  (${(stats.first3WinRate*100).toFixed(1)}%)`);
    console.log(`  Longest 3-node streak (in turn-ends; ~4 per round, 12 ≈ winning hold of 3 full rounds):`);
    const buckets = Object.keys(stats.first3HeldDist).map(Number).sort((a,b)=>a-b);
    for (const b of buckets) {
      const n = stats.first3HeldDist[b];
      console.log(`    ${b.toString().padStart(2)} turns: ${n.toString().padStart(4)}  (${(n/stats.first3Total*100).toFixed(1)}%)`);
    }
  }
}
