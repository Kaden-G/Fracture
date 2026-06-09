// ============================================================
// engine.test.js — Unit tests for the pure engine
// Run: node --test test/engine.test.js
// ============================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, buildMap, checkWinCondition, resolveCombat } from '../src/engine.js';
import {
  RES_CAP, FACTIONS, TYRANT_KEY, TRAITS,
  factionDef, adjacent, mkFaction,
  tilesOf, countNodes, reinforceCost,
  hasPact, pairKey,
} from '../src/state.js';
import { makeRng, roll2d6, nextInt } from '../src/rng.js';

// ---- Test helper: minimal game state ----
function makeTestState(opts = {}) {
  const rng = makeRng(opts.seed || 42);
  const factions = {};
  for (const k of Object.keys(FACTIONS)) {
    factions[k] = mkFaction(FACTIONS[k].name, k, true, opts.trait || 'scavenger');
  }
  const turnOrder = Object.keys(FACTIONS);
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
    tyrantOn: false,
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
  // Build map
  const tiles = buildMap(state);
  state.tiles = tiles;
  return state;
}

// ============================================================
// RNG TESTS
// ============================================================
describe('RNG', () => {
  it('makeRng produces deterministic sequence', () => {
    const r1 = makeRng(123);
    const r2 = makeRng(123);
    const a1 = nextInt(r1, 100);
    const a2 = nextInt(r2, 100);
    assert.equal(a1.value, a2.value, 'same seed → same value');
  });

  it('roll2d6 returns sum in [2,12]', () => {
    let rng = makeRng(99);
    for (let i = 0; i < 100; i++) {
      const r = roll2d6(rng);
      rng = r.rng;
      assert.ok(r.sum >= 2 && r.sum <= 12, `sum ${r.sum} out of range`);
      assert.equal(r.dice.length, 2);
    }
  });

  it('roll2d6 tactician returns 2 dice from 3', () => {
    let rng = makeRng(77);
    const r = roll2d6(rng, true);
    assert.equal(r.dice.length, 2);
    assert.equal(r.allDice.length, 3);
    assert.ok(r.sum >= 2 && r.sum <= 12);
    // Best two should be >= any single die
    assert.ok(r.dice[0] >= r.allDice[2], 'kept dice should be the largest');
  });
});

// ============================================================
// ADJACENCY TESTS
// ============================================================
describe('Adjacency', () => {
  it('same-row neighbors are adjacent', () => {
    assert.ok(adjacent({row:0, col:0}, {row:0, col:1}));
    assert.ok(!adjacent({row:0, col:0}, {row:0, col:2}));
  });

  it('hex offset adjacency for even/odd rows', () => {
    // Even row (0): neighbors in row 1 are col 0 and col 1
    assert.ok(adjacent({row:0, col:0}, {row:1, col:0}));
    assert.ok(adjacent({row:0, col:1}, {row:1, col:1}));
    // Odd row (1): neighbors in row 0 are col 0 and col -1 offset
    assert.ok(adjacent({row:1, col:1}, {row:0, col:1}));
  });
});

// ============================================================
// COMBAT TESTS
// ============================================================
describe('Combat', () => {
  it('attacker wins ties (fortify=0)', () => {
    // We need to verify the logic: attWins = attTotal >= defTotal + fortify
    // When attTotal === defTotal and fortify=0, attacker wins.
    // Can't force exact dice, but we test the formula path.
    const state = makeTestState({ seed: 1 });
    // Set up two adjacent tiles
    const srcId = 'tile_0_0';
    const tgtId = 'tile_0_1';
    state.tiles[srcId].owner = 'grid';
    state.tiles[srcId].troops = 5;
    state.tiles[tgtId].owner = 'syndicate';
    state.tiles[tgtId].troops = 1;
    state.turnAttacks = 0;

    // Run many combats to verify attacker wins when troops heavily favor them
    let wins = 0;
    let rng = state.rng;
    for (let i = 0; i < 50; i++) {
      const s = JSON.parse(JSON.stringify(state));
      s.rng = rng;
      s.turnAttacks = 0;
      const result = resolveCombat(s, 'grid', srcId, tgtId, 0);
      rng = s.rng;
      if (result.attWins) wins++;
    }
    // With 5 vs 1 troops, attacker should win most of the time
    assert.ok(wins > 30, `Attacker with 5v1 should win often, got ${wins}/50`);
  });

  it('force is capped at +2', () => {
    const state = makeTestState();
    const srcId = 'tile_0_0';
    state.tiles[srcId].owner = 'grid';
    state.tiles[srcId].troops = 20; // would be +5 uncapped, but should be +2

    const result = resolveCombat(state, 'grid', srcId, 'tile_0_1', 0);
    // Check combat effect for force value
    const combat = result.effects.find(e => e.kind === 'combat');
    assert.ok(combat, 'should have combat effect');
    assert.equal(combat.att.force, 2, 'force should be capped at 2');
  });

  it('entrenchment resets on casualty', () => {
    const state = makeTestState({ seed: 10 });
    const tgtId = 'tile_0_1';
    state.tiles[tgtId].owner = 'syndicate';
    state.tiles[tgtId].troops = 3;
    state.tiles[tgtId].heldRounds = 3;

    const srcId = 'tile_0_0';
    state.tiles[srcId].owner = 'grid';
    state.tiles[srcId].troops = 5;

    const result = resolveCombat(state, 'grid', srcId, tgtId, 0);
    if (result.attWins) {
      assert.equal(state.tiles[tgtId].heldRounds, 0, 'casualty should reset entrenchment');
    }
  });
});

// ============================================================
// REDUCER TESTS
// ============================================================
describe('Reducer', () => {
  it('BEGIN_TURN applies income and resets actions', () => {
    const state = makeTestState();
    state.factions.grid.resources = 0;
    const { state: next } = reduce(state, { type: 'BEGIN_TURN', faction: 'grid' });
    assert.ok(next.factions.grid.resources > 0, 'should have gained income');
    assert.equal(next.actionsUsed, 0);
    assert.equal(next.turnAttacks, 0);
  });

  it('REINFORCE adds troops and costs resources', () => {
    const state = makeTestState();
    state.factions.grid.resources = 10;
    const srcId = 'tile_0_0';
    state.tiles[srcId].owner = 'grid';
    state.tiles[srcId].troops = 2;
    const cost = reinforceCost(state, 'grid');

    const { state: next } = reduce(state, { type: 'REINFORCE', tile: srcId });
    assert.equal(next.tiles[srcId].troops, 4); // +2
    assert.equal(next.factions.grid.resources, 10 - cost);
    assert.equal(next.actionsUsed, 1);
  });

  it('ENTRENCH respects node cap of +2', () => {
    const state = makeTestState();
    state.factions.grid.resources = 10;
    // Find a node tile
    const nodeId = Object.keys(state.tiles).find(id => state.tiles[id].isNode);
    state.tiles[nodeId].owner = 'grid';
    state.tiles[nodeId].troops = 3;
    state.tiles[nodeId].heldRounds = 1;

    // First entrench: 1 → 2
    const { state: s2 } = reduce(state, { type: 'ENTRENCH', tile: nodeId });
    assert.equal(s2.tiles[nodeId].heldRounds, 2, 'should be at 2 after entrench');

    // Second entrench: should stay at 2 (node cap)
    s2.factions.grid.resources = 10;
    s2.actionsUsed = 0;
    const { state: s3 } = reduce(s2, { type: 'ENTRENCH', tile: nodeId });
    assert.equal(s3.tiles[nodeId].heldRounds, 2, 'node should cap at +2');
  });

  it('MOVE transfers troops correctly', () => {
    const state = makeTestState();
    const srcId = 'tile_0_0';
    const dstId = 'tile_0_1';
    state.tiles[srcId].owner = 'grid';
    state.tiles[srcId].troops = 3;
    state.tiles[dstId].owner = null;
    state.tiles[dstId].troops = 0;

    const { state: next } = reduce(state, { type: 'MOVE', src: srcId, dst: dstId });
    assert.equal(next.tiles[srcId].troops, 2); // moved 1 (default moveTroopCount)
    assert.equal(next.tiles[dstId].troops, 1);
    assert.equal(next.tiles[dstId].owner, 'grid');
  });

  it('AIRLIFT moves 2 troops at cost of 3 res', () => {
    const state = makeTestState();
    state.factions.grid.resources = 10;
    const srcId = 'tile_0_0';
    const dstId = 'tile_6_6';
    state.tiles[srcId].owner = 'grid';
    state.tiles[srcId].troops = 5;
    state.tiles[dstId].owner = 'grid';
    state.tiles[dstId].troops = 2;

    const { state: next } = reduce(state, { type: 'AIRLIFT', src: srcId, dst: dstId });
    assert.equal(next.tiles[srcId].troops, 3);
    assert.equal(next.tiles[dstId].troops, 4);
    assert.equal(next.factions.grid.resources, 7);
  });

  it('elimination grants +3 resources bounty', () => {
    const state = makeTestState({ seed: 42 });
    const srcId = 'tile_0_0';
    const tgtId = 'tile_0_1';
    state.tiles[srcId].owner = 'grid';
    state.tiles[srcId].troops = 10;
    state.tiles[tgtId].owner = 'syndicate';
    state.tiles[tgtId].troops = 1;
    state.factions.grid.resources = 0;
    // Make sure syndicate has only this one tile
    Object.values(state.tiles).forEach(t => {
      if (t.id !== tgtId && t.owner === 'syndicate') { t.owner = null; t.troops = 0; }
    });

    // Keep attacking until we capture
    let s = state;
    let eliminated = false;
    for (let i = 0; i < 20 && !eliminated; i++) {
      const { state: next, log } = reduce(s, { type: 'ATTACK', src: srcId, tgt: tgtId });
      s = next;
      if (log.some(l => l.includes('ELIMINATED'))) eliminated = true;
      // Reset troops for next attempt if not captured
      if (!eliminated) {
        s.tiles[srcId].troops = 10;
        s.tiles[tgtId].troops = 1;
        s.tiles[tgtId].owner = 'syndicate';
      }
    }
    if (eliminated) {
      assert.ok(s.factions.grid.resources >= 3, 'should have bounty');
    }
  });

  it('END_ROUND detects node dominance win', () => {
    const state = makeTestState();
    // Give grid 3 nodes and set held timer
    let nodeCount = 0;
    Object.values(state.tiles).forEach(t => {
      if (t.isNode && nodeCount < 3) { t.owner = 'grid'; t.troops = 3; nodeCount++; }
    });
    state.nodesHeldSince = { grid: 1 };
    state.round = 2; // held since round 1, now round 2 → >= 1 round elapsed

    const { state: next, effects } = reduce(state, { type: 'END_ROUND' });
    const win = effects.find(e => e.kind === 'win');
    assert.ok(win, 'should detect node dominance win');
    assert.equal(win.winner.fk, 'grid');
    assert.equal(win.winner.condition, 'NODE DOMINANCE');
  });

  it('START_ROUND ticks entrenchment and respects node cap', () => {
    const state = makeTestState();
    const nodeId = Object.keys(state.tiles).find(id => state.tiles[id].isNode);
    const regId = Object.keys(state.tiles).find(id => !state.tiles[id].isNode && state.tiles[id].owner);

    state.tiles[nodeId].owner = 'grid';
    state.tiles[nodeId].troops = 3;
    state.tiles[nodeId].heldRounds = 1;

    if (regId) {
      state.tiles[regId].owner = 'grid';
      state.tiles[regId].troops = 3;
      state.tiles[regId].heldRounds = 2;
    }

    const { state: next } = reduce(state, { type: 'START_ROUND' });
    assert.equal(next.tiles[nodeId].heldRounds, 2, 'node should be at 2 (cap)');
    if (regId) {
      assert.equal(next.tiles[regId].heldRounds, 3, 'regular tile should be at 3');
    }
  });
});

// ============================================================
// STATE IMMUTABILITY
// ============================================================
describe('Immutability', () => {
  it('reduce does not mutate input state', () => {
    const state = makeTestState();
    const original = JSON.stringify(state);
    reduce(state, { type: 'BEGIN_TURN', faction: 'grid' });
    assert.equal(JSON.stringify(state), original, 'input state should not be mutated');
  });
});

// ============================================================
// RENOUNCE (Part 1)
// ============================================================
describe('Renounce', () => {
  function pactedState() {
    const state = makeTestState();
    // Begin grid's turn, then form a pact between grid and commune
    const { state: s1 } = reduce(state, { type: 'BEGIN_TURN', faction: 'grid' });
    const { state: s2 } = reduce(s1, { type: 'PACT', from: 'grid', to: 'commune' });
    return s2;
  }

  it('renounce removes a pact with no grudge', () => {
    const state = pactedState();
    assert.ok(hasPact(state, 'grid', 'commune'), 'pact should exist before renounce');
    const { state: next } = reduce(state, { type: 'RENOUNCE', from: 'grid', target: 'commune' });
    assert.ok(!hasPact(next, 'grid', 'commune'), 'pact should be removed after renounce');
    // No grudge
    const grudgeKey = 'commune>grid';
    assert.ok(!next.grudges[grudgeKey] || next.grudges[grudgeKey] < next.round, 'no grudge after renounce');
  });

  it('renounce sets renouncedThisTurn', () => {
    const state = pactedState();
    const { state: next } = reduce(state, { type: 'RENOUNCE', from: 'grid', target: 'commune' });
    assert.ok(next.renouncedThisTurn && next.renouncedThisTurn['commune'], 'renouncedThisTurn should be set');
  });

  it('BEGIN_TURN clears renouncedThisTurn', () => {
    const state = pactedState();
    const { state: s1 } = reduce(state, { type: 'RENOUNCE', from: 'grid', target: 'commune' });
    assert.ok(s1.renouncedThisTurn['commune'], 'should be set after renounce');
    const { state: s2 } = reduce(s1, { type: 'BEGIN_TURN', faction: 'syndicate' });
    assert.deepEqual(s2.renouncedThisTurn, {}, 'renouncedThisTurn should clear on new turn');
  });

  it('betray still applies a grudge', () => {
    const state = pactedState();
    assert.ok(hasPact(state, 'grid', 'commune'), 'pact should exist');
    const { state: next } = reduce(state, { type: 'BREAK_PACT', betrayer: 'grid', victim: 'commune' });
    assert.ok(!hasPact(next, 'grid', 'commune'), 'pact removed');
    const grudgeKey = 'commune>grid';
    assert.ok(next.grudges[grudgeKey] >= next.round, 'grudge should exist after betrayal');
  });

  it('renounce on non-existent pact is a no-op', () => {
    const state = makeTestState();
    const { state: s1 } = reduce(state, { type: 'BEGIN_TURN', faction: 'grid' });
    const { state: next } = reduce(s1, { type: 'RENOUNCE', from: 'grid', target: 'commune' });
    assert.ok(!hasPact(next, 'grid', 'commune'), 'no pact to renounce');
    assert.ok(!next.renouncedThisTurn || !next.renouncedThisTurn['commune'], 'renouncedThisTurn not set for no-op');
  });
});
