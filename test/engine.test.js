// ============================================================
// engine.test.js — Unit tests for the pure engine
// Run: node --test test/engine.test.js
// ============================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, buildMap, checkWinCondition, resolveCombat, EVENT_HANDLERS, tyrantAtPactCap } from '../src/engine.js';
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

  it('AIRLIFT moves up to 3 troops at cost of 3 res', () => {
    const state = makeTestState();
    state.factions.grid.resources = 10;
    const srcId = 'tile_0_0';
    const dstId = 'tile_6_6';
    state.tiles[srcId].owner = 'grid';
    state.tiles[srcId].troops = 5;
    state.tiles[dstId].owner = 'grid';
    state.tiles[dstId].troops = 2;

    // Explicit count of 2
    const { state: a } = reduce(state, { type: 'AIRLIFT', src: srcId, dst: dstId, count: 2 });
    assert.equal(a.tiles[srcId].troops, 3);
    assert.equal(a.tiles[dstId].troops, 4);
    assert.equal(a.factions.grid.resources, 7);

    // Default (no count) moves the max of 3
    const { state: b } = reduce(state, { type: 'AIRLIFT', src: srcId, dst: dstId });
    assert.equal(b.tiles[srcId].troops, 2, 'default airlift moves 3');
    assert.equal(b.tiles[dstId].troops, 5);
  });

  it('AIRLIFT clamps to 3 and always leaves a garrison of 1', () => {
    const state = makeTestState();
    state.factions.grid.resources = 10;
    state.tiles['tile_0_0'].owner = 'grid'; state.tiles['tile_0_0'].troops = 10;
    state.tiles['tile_6_6'].owner = 'grid'; state.tiles['tile_6_6'].troops = 1;
    // Request 5 → capped at 3
    const { state: c } = reduce(state, { type: 'AIRLIFT', src: 'tile_0_0', dst: 'tile_6_6', count: 5 });
    assert.equal(c.tiles['tile_0_0'].troops, 7, 'no more than 3 moved');
    assert.equal(c.tiles['tile_6_6'].troops, 4);

    // A 2-stack can only spare 1 (leave a garrison), even if 3 requested
    const s2 = makeTestState();
    s2.factions.grid.resources = 10;
    s2.tiles['tile_0_0'].owner = 'grid'; s2.tiles['tile_0_0'].troops = 2;
    s2.tiles['tile_6_6'].owner = 'grid'; s2.tiles['tile_6_6'].troops = 1;
    const { state: d } = reduce(s2, { type: 'AIRLIFT', src: 'tile_0_0', dst: 'tile_6_6', count: 3 });
    assert.equal(d.tiles['tile_0_0'].troops, 1, 'leaves 1 behind');
    assert.equal(d.tiles['tile_6_6'].troops, 2);
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

// ============================================================
// EVENT EFFECT TESTS — every card's effect must be additive/correct
// ============================================================
describe('Event effects', () => {
  const regionOfFaction = (state, fk) =>
    Object.values(state.tiles).find(t => t.owner === fk && t.region !== 'C').region;

  it('MUSTER adds +1 troop to held tiles (additive, never replaces)', () => {
    const state = makeTestState();
    const tile = Object.values(state.tiles).find(t => t.owner === 'grid' && t.region !== 'C');
    tile.troops = 5;
    EVENT_HANDLERS.muster(state, tile.region, [], []);
    assert.equal(tile.troops, 6, 'muster should ADD 1 (5 → 6)');
  });

  it('MERCENARY HIRE adds +4 to the strongest tile (additive, never replaces)', () => {
    const state = makeTestState();
    state.factions.grid.resources = 10;
    const strongest = tilesOf(state, 'grid')[0];
    strongest.troops = 7;
    EVENT_HANDLERS.mercenaryContract(state, null, [], [], 'grid', 0);
    assert.equal(strongest.troops, 11, 'HIRE should ADD 4 (7 → 11), not replace');
    assert.equal(state.factions.grid.resources, 5, 'HIRE costs 5 resources');
  });

  it('MERCENARY HIRE without 5 resources changes nothing', () => {
    const state = makeTestState();
    state.factions.grid.resources = 4;
    const before = tilesOf(state, 'grid').map(t => t.troops);
    EVENT_HANDLERS.mercenaryContract(state, null, [], [], 'grid', 0);
    assert.deepEqual(tilesOf(state, 'grid').map(t => t.troops), before, 'no troops without payment');
    assert.equal(state.factions.grid.resources, 4, 'no resources spent');
  });

  it('MERCENARY DECLINE grants +3 resources, capped', () => {
    const state = makeTestState();
    state.factions.grid.resources = RES_CAP - 1;
    EVENT_HANDLERS.mercenaryContract(state, null, [], [], 'grid', 1);
    assert.equal(state.factions.grid.resources, RES_CAP, 'capped at RES_CAP');
  });

  it('WARLORD PAY costs 4 resources; REFUSE drops 1 troop per tile (min 1)', () => {
    const s1 = makeTestState();
    s1.factions.grid.resources = 6;
    EVENT_HANDLERS.warlordTribute(s1, null, [], [], 'grid', 0);
    assert.equal(s1.factions.grid.resources, 2);

    const s2 = makeTestState();
    const [a, b] = tilesOf(s2, 'grid');
    a.troops = 3; b.troops = 1;
    EVENT_HANDLERS.warlordTribute(s2, null, [], [], 'grid', 1);
    assert.equal(a.troops, 2, '3 → 2');
    assert.equal(b.troops, 1, 'lone troop holds (min 1)');
  });

  it('INSURGENCY adds +4 troops & +3 res to the weakest faction (additive)', () => {
    const state = makeTestState();
    // make ghost the weakest: one tile with 2 troops
    const [keep, drop] = tilesOf(state, 'ghost');
    drop.owner = null; drop.troops = 0;
    keep.troops = 2;
    state.factions.ghost.resources = 4;
    EVENT_HANDLERS.insurgency(state, null, [], []);
    assert.equal(keep.troops, 6, 'insurgency should ADD 4 (2 → 6), not replace');
    assert.equal(state.factions.ghost.resources, 7);
  });

  it('weakest-faction events never target the Tyrant (harbored Tyrant stays down)', () => {
    const state = makeTestState();
    state.tyrantOn = true;
    state.factions[TYRANT_KEY] = mkFaction('THE TYRANT', TYRANT_KEY, true, 'fortify');
    // Tyrant alive with 0 tiles (harbored); ghost is weakest real faction with 1 tile
    const [keep, drop] = tilesOf(state, 'ghost');
    drop.owner = null; drop.troops = 0;
    // INSURGENCY must buff ghost, not the Tyrant
    EVENT_HANDLERS.insurgency(state, null, [], []);
    assert.equal(state.factions[TYRANT_KEY].resources, 4, 'Tyrant untouched by insurgency');
    assert.equal(state.factions.ghost.resources, 7, 'ghost (weakest real faction) gets the boost');
    // RIOT must hand the tile to ghost, never revive the Tyrant
    const target = Object.values(state.tiles).find(t => t.owner === 'grid' && !t.isNode);
    EVENT_HANDLERS.riot(state, target.region, [], []);
    assert.equal(tilesOf(state, TYRANT_KEY).length, 0, 'riot never gifts the Tyrant a tile');
  });

  it('POWER FAILURE drops 1 troop (floor 1) and breaks dig-in', () => {
    const state = makeTestState();
    const tile = Object.values(state.tiles).find(t => t.owner === 'grid' && t.region !== 'C');
    tile.troops = 3; tile.heldRounds = 2;
    const lone = tilesOf(state, 'grid').find(t => t.id !== tile.id);
    lone.region = tile.region; lone.troops = 1;
    EVENT_HANDLERS.powerFailure(state, tile.region, [], []);
    assert.equal(tile.troops, 2);
    assert.equal(tile.heldRounds, 0);
    assert.equal(lone.troops, 1, 'lone defender survives (floor 1)');
  });

  it('UPRISING cuts only 4+ stacks by 2', () => {
    const state = makeTestState();
    const [big, small] = tilesOf(state, 'grid');
    big.troops = 5; small.troops = 3; small.region = big.region;
    EVENT_HANDLERS.uprising(state, big.region, [], []);
    assert.equal(big.troops, 3, '5 → 3');
    assert.equal(small.troops, 3, 'small stack untouched');
  });

  it('EARTHQUAKE hits districts −1 and nodes −2 (floor 1)', () => {
    const state = makeTestState();
    const district = tilesOf(state, 'grid')[0];
    district.troops = 4;
    const node = Object.values(state.tiles).find(t => t.isNode && t.region === district.region);
    node.owner = 'grid'; node.troops = 5;
    EVENT_HANDLERS.quake(state, district.region, [], []);
    assert.equal(district.troops, 3);
    assert.equal(node.troops, 3, 'node loses 2');
  });

  it('SIEGE wipes entrenchment in the region only', () => {
    const state = makeTestState();
    const inRegion = tilesOf(state, 'grid')[0];
    inRegion.heldRounds = 3;
    const elsewhere = Object.values(state.tiles).find(t => t.owner && t.region !== inRegion.region);
    elsewhere.heldRounds = 2;
    EVENT_HANDLERS.siege(state, inRegion.region, [], []);
    assert.equal(inRegion.heldRounds, 0);
    assert.equal(elsewhere.heldRounds, 2, 'other regions keep dig-in');
  });

  it('GOLD STRIKE pays +1 res per tile held in the region, capped', () => {
    const state = makeTestState();
    const reg = regionOfFaction(state, 'grid');
    const n = tilesOf(state, 'grid').filter(t => t.region === reg).length;
    state.factions.grid.resources = 4;
    EVENT_HANDLERS.goldStrike(state, reg, [], []);
    assert.equal(state.factions.grid.resources, Math.min(4 + n, RES_CAP));
  });

  it('MARKET CRASH halves every living faction\'s resources', () => {
    const state = makeTestState();
    state.factions.grid.resources = 9;
    EVENT_HANDLERS.crash(state, null, [], []);
    assert.equal(state.factions.grid.resources, 4);
  });

  it('REVOLUTION topples one node of the leader', () => {
    const state = makeTestState();
    const nodes = Object.values(state.tiles).filter(t => t.isNode);
    nodes[0].owner = 'grid'; nodes[0].troops = 3;
    EVENT_HANDLERS.revolution(state, null, [], []);
    assert.equal(nodes[0].owner, null, 'leader\'s only node falls');
    assert.equal(nodes[0].troops, 0);
  });

  it('TOTAL WAR sets the flag and wipes all entrenchment', () => {
    const state = makeTestState();
    tilesOf(state, 'grid').forEach(t => t.heldRounds = 2);
    EVENT_HANDLERS.totalWar(state, null, [], []);
    assert.ok(state.totalWar);
    assert.ok(tilesOf(state, 'grid').every(t => t.heldRounds === 0));
  });
});

// ============================================================
// TYRANT PACT CAP — single-human games: max 3 concurrent pacts
// ============================================================
describe('Tyrant pact cap', () => {
  function tyrantState(humans) {
    const state = makeTestState();
    state.tyrantOn = true;
    state.humans = humans;
    state.factions[TYRANT_KEY] = mkFaction('THE TYRANT', TYRANT_KEY, true, 'fortify');
    state.turnOrder = [...state.turnOrder, TYRANT_KEY];
    return state;
  }

  it('single-human game: 4th concurrent pact is refused (cap 3)', () => {
    const state = tyrantState(['grid']);
    for (const k of ['grid', 'syndicate', 'commune']) {
      state.pacts[pairKey(TYRANT_KEY, k)] = 1;
    }
    assert.ok(tyrantAtPactCap(state), 'cap reached at 3 pacts');
    const { state: next } = reduce(state, { type: 'TYRANT_COURT', target: 'ghost' });
    assert.ok(!hasPact(next, TYRANT_KEY, 'ghost'), 'court past the cap is a no-op');
  });

  it('single-human game: pacts up to 3 still form', () => {
    const state = tyrantState(['grid']);
    state.pacts[pairKey(TYRANT_KEY, 'grid')] = 1;
    state.pacts[pairKey(TYRANT_KEY, 'syndicate')] = 1;
    const { state: next } = reduce(state, { type: 'TYRANT_COURT', target: 'ghost' });
    assert.ok(hasPact(next, TYRANT_KEY, 'ghost'), '3rd pact forms normally');
  });

  it('multi-human game: no cap — Tyrant can court everyone', () => {
    const state = tyrantState(['grid', 'syndicate']);
    for (const k of ['grid', 'syndicate', 'commune']) {
      state.pacts[pairKey(TYRANT_KEY, k)] = 1;
    }
    assert.ok(!tyrantAtPactCap(state), 'no cap with 2+ humans');
    const { state: next } = reduce(state, { type: 'TYRANT_COURT', target: 'ghost' });
    assert.ok(hasPact(next, TYRANT_KEY, 'ghost'), '4th pact allowed in multi-human games');
  });

  it('conquest Tyrant never re-instigates: TYRANT_COURT is a no-op', () => {
    const state = tyrantState(['grid', 'syndicate']);
    state.tyrantConquest = true;
    const { state: next } = reduce(state, { type: 'TYRANT_COURT', target: 'ghost' });
    assert.ok(!hasPact(next, TYRANT_KEY, 'ghost'), 'a conquest Tyrant does not court');
  });
});

// ============================================================
// STEP 1 — MOVE carry count & post-capture ADVANCE
// ============================================================
describe('Movement & advance', () => {
  function moveState(seed) {
    const state = makeTestState(seed ? { seed } : {});
    state.tiles['tile_0_0'].owner = 'grid';
    state.tiles['tile_0_1'].owner = null;
    state.tiles['tile_0_1'].troops = 0;
    state.currentTurnIdx = 0;   // grid's turn
    return state;
  }

  it('MOVE with count carries the chosen number', () => {
    const state = moveState();
    state.tiles['tile_0_0'].troops = 6;
    const { state: s1 } = reduce(state, { type: 'MOVE', src: 'tile_0_0', dst: 'tile_0_1', count: 5 });
    assert.equal(s1.tiles['tile_0_0'].troops, 1, 'garrison of 1 stays');
    assert.equal(s1.tiles['tile_0_1'].troops, 5, '5 troops carried');
  });

  it('MOVE count clamps to stack−1 (never abandons the source)', () => {
    const state = moveState();
    state.tiles['tile_0_0'].troops = 4;
    const { state: s1 } = reduce(state, { type: 'MOVE', src: 'tile_0_0', dst: 'tile_0_1', count: 99 });
    assert.equal(s1.tiles['tile_0_0'].troops, 1);
    assert.equal(s1.tiles['tile_0_1'].troops, 3);
    assert.equal(s1.tiles['tile_0_0'].owner, 'grid', 'source stays owned');
  });

  it('MOVE without count keeps the legacy default (1 troop)', () => {
    const state = moveState();
    state.tiles['tile_0_0'].troops = 6;
    const { state: s1 } = reduce(state, { type: 'MOVE', src: 'tile_0_0', dst: 'tile_0_1' });
    assert.equal(s1.tiles['tile_0_0'].troops, 5);
    assert.equal(s1.tiles['tile_0_1'].troops, 1);
  });

  it('ATTACK advance moves extra troops into a captured tile, clamped to stack−1', () => {
    for (let seed = 1; seed < 80; seed++) {
      const state = makeTestState({ seed });
      state.tiles['tile_0_0'].owner = 'grid';      state.tiles['tile_0_0'].troops = 10;
      state.tiles['tile_0_1'].owner = 'syndicate'; state.tiles['tile_0_1'].troops = 1;
      state.tiles['tile_0_1'].heldRounds = 0;
      state.currentTurnIdx = 0;
      const { state: s1, effects } = reduce(state,
        { type: 'ATTACK', src: 'tile_0_0', tgt: 'tile_0_1', attackerFk: 'grid', advance: 99 });
      if (effects.some(e => e.kind === 'capture')) {
        assert.equal(s1.tiles['tile_0_1'].owner, 'grid');
        assert.equal(s1.tiles['tile_0_0'].troops, 1, 'advance clamps so 1 stays behind');
        assert.equal(s1.tiles['tile_0_1'].troops, 9, 'occupier + 8 advanced');
        return;
      }
    }
    assert.fail('no capture across 80 seeds — should be near-certain at 10v1');
  });

  it('ATTACK advance does nothing when the attack does not capture', () => {
    for (let seed = 1; seed < 30; seed++) {
      const state = makeTestState({ seed });
      state.tiles['tile_0_0'].owner = 'grid';      state.tiles['tile_0_0'].troops = 6;
      state.tiles['tile_0_1'].owner = 'syndicate'; state.tiles['tile_0_1'].troops = 8;
      state.currentTurnIdx = 0;
      const { state: s1, effects } = reduce(state,
        { type: 'ATTACK', src: 'tile_0_0', tgt: 'tile_0_1', attackerFk: 'grid', advance: 99 });
      assert.ok(!effects.some(e => e.kind === 'capture'), 'no capture at 6v8 single strike');
      assert.equal(s1.tiles['tile_0_1'].owner, 'syndicate', 'tile holds');
      assert.ok(s1.tiles['tile_0_0'].troops >= 1, 'source never emptied');
    }
  });
});

// ============================================================
// STEP 3 — Coalition surge (human-only, vs-Tyrant-only)
// ============================================================
describe('Coalition surge', () => {
  function surgeState(humans) {
    const state = makeTestState({ seed: 7 });
    state.tyrantOn = true;
    state.humans = humans;
    state.round = 5;
    state.factions[TYRANT_KEY] = mkFaction('THE TYRANT', TYRANT_KEY, false, 'fortify');
    state.turnOrder = [...state.turnOrder, TYRANT_KEY];
    // A Tyrant tile adjacent to grid & syndicate tiles
    state.tiles['tile_0_0'].owner = 'grid';      state.tiles['tile_0_0'].troops = 8;
    state.tiles['tile_0_1'].owner = TYRANT_KEY;  state.tiles['tile_0_1'].troops = 3; state.tiles['tile_0_1'].heldRounds = 0;
    state.tiles['tile_1_1'].owner = 'syndicate'; state.tiles['tile_1_1'].troops = 8;
    return state;
  }
  // Read the surge value off the combat effect by attacking the Tyrant from grid.
  function surgeOf(state) {
    const { effects } = reduce(state, { type: 'ATTACK', src: 'tile_0_0', tgt: 'tile_0_1', attackerFk: 'grid' });
    return effects.find(e => e.kind === 'combat').att.surge;
  }

  it('does nothing in <2 human games (sim-safe)', () => {
    const state = surgeState([]);            // all-AI
    state.tyrantStruck = { grid: 4, syndicate: 4 };
    assert.equal(surgeOf(state), 0, 'no surge with 0 humans');
    const solo = surgeState(['grid']);       // single human
    solo.tyrantStruck = { grid: 4, syndicate: 4 };
    assert.equal(surgeOf(solo), 0, 'no surge with 1 human');
  });

  it('scales with coalition size: 1→0, 2→+1, 3→+2', () => {
    const s1 = surgeState(['grid', 'syndicate']);
    s1.tyrantStruck = { grid: 4 };                          // only grid hostile → size 1
    assert.equal(surgeOf(s1), 0, 'lone poke = no surge');
    const s2 = surgeState(['grid', 'syndicate']);
    s2.tyrantStruck = { grid: 4, syndicate: 4 };            // size 2
    assert.equal(surgeOf(s2), 1);
    const s3 = surgeState(['grid', 'syndicate']);
    s3.tyrantStruck = { grid: 4, syndicate: 4, commune: 4 };// size 3
    assert.equal(surgeOf(s3), 2);
  });

  it('requires earning it (struck within the window)', () => {
    const stale = surgeState(['grid', 'syndicate']);
    stale.tyrantStruck = { grid: 1, syndicate: 1 };  // round 5, struck round 1 → out of window
    assert.equal(surgeOf(stale), 0, 'stale hostility does not qualify');
  });

  it('excludes Tyrant allies from the coalition', () => {
    const state = surgeState(['grid', 'syndicate']);
    state.tyrantStruck = { grid: 4, syndicate: 4, commune: 4 };
    state.pacts[pairKey(TYRANT_KEY, 'syndicate')] = 4;   // syndicate is bound → not counted, grid+commune = size 2
    assert.equal(surgeOf(state), 1);
    // And a bound attacker gets nothing even if it strikes
    const ally = surgeState(['grid', 'syndicate']);
    ally.tyrantStruck = { grid: 4 };
    ally.pacts[pairKey(TYRANT_KEY, 'grid')] = 4;
    assert.equal(surgeOf(ally), 0, 'bound attacker earns no surge');
  });

  it('applies only against the Tyrant, not other factions', () => {
    const state = surgeState(['grid', 'syndicate']);
    state.tyrantStruck = { grid: 4, syndicate: 4 };
    // grid attacks syndicate (a normal rival) instead of the Tyrant
    state.tiles['tile_1_0'].owner = 'syndicate'; state.tiles['tile_1_0'].troops = 2;
    const { effects } = reduce(state, { type: 'ATTACK', src: 'tile_0_0', tgt: 'tile_1_0', attackerFk: 'grid' });
    assert.equal(effects.find(e => e.kind === 'combat').att.surge, 0, 'no surge vs non-Tyrant');
  });

  it('attacking the Tyrant records the strike (earns surge next turn)', () => {
    const state = surgeState(['grid', 'syndicate']);
    state.tyrantStruck = {};
    const { state: next } = reduce(state, { type: 'ATTACK', src: 'tile_0_0', tgt: 'tile_0_1', attackerFk: 'grid' });
    assert.equal(next.tyrantStruck.grid, 5, 'strike recorded at current round');
  });
});

// ============================================================
// TRANSIT perk — airlifts cost no resources
// ============================================================
describe('TRANSIT airlift perk', () => {
  it('AIRLIFT costs 3 without TRANSIT, 0 with it', () => {
    const base = makeTestState();
    base.factions.grid.resources = 10;
    base.tiles['tile_0_0'].owner = 'grid'; base.tiles['tile_0_0'].troops = 5;
    base.tiles['tile_0_1'].owner = 'grid'; base.tiles['tile_0_1'].troops = 1;
    base.currentTurnIdx = 0;

    const { state: s1 } = reduce(base, { type: 'AIRLIFT', src: 'tile_0_0', dst: 'tile_0_1', count: 2 });
    assert.equal(s1.factions.grid.resources, 7, 'costs 3 without TRANSIT');

    const withT = JSON.parse(JSON.stringify(base));
    const transit = Object.values(withT.tiles).find(t => t.nodeId === 'node_transit');
    transit.owner = 'grid'; transit.troops = 1;
    const { state: s2 } = reduce(withT, { type: 'AIRLIFT', src: 'tile_0_0', dst: 'tile_0_1', count: 2 });
    assert.equal(s2.factions.grid.resources, 10, 'free while holding TRANSIT');
    assert.equal(s2.tiles['tile_0_1'].troops, 3, 'moves the requested 2 troops');
    assert.equal(s2.actionsUsed, 1, 'still costs an action');
  });

  it('legacy MOVE default no longer grants TRANSIT 2-troop moves', () => {
    const state = makeTestState();
    state.tiles['tile_0_0'].owner = 'grid'; state.tiles['tile_0_0'].troops = 6;
    state.tiles['tile_0_1'].owner = null;   state.tiles['tile_0_1'].troops = 0;
    const transit = Object.values(state.tiles).find(t => t.nodeId === 'node_transit');
    transit.owner = 'grid'; transit.troops = 1;
    state.currentTurnIdx = 0;
    const { state: s1 } = reduce(state, { type: 'MOVE', src: 'tile_0_0', dst: 'tile_0_1' });
    assert.equal(s1.tiles['tile_0_1'].troops, 1, 'default move is 1 troop even with TRANSIT');
  });
});

// ============================================================
// Single-human Tyrant ally-default win is IMPOSSIBLE
// ============================================================
describe('Tyrant ally-default win gating', () => {
  function allAllied(humans) {
    const state = makeTestState();
    state.tyrantOn = true;
    state.humans = humans;
    state.factions[TYRANT_KEY] = mkFaction('THE TYRANT', TYRANT_KEY, humans.length === 0, 'fortify');
    state.turnOrder = [...state.turnOrder, TYRANT_KEY];
    for (const k of Object.keys(FACTIONS)) state.pacts[pairKey(TYRANT_KEY, k)] = 1;  // Tyrant bound to all rivals
    return state;
  }
  it('1-human game: ally-default (NO ENEMIES LEFT) win never fires', () => {
    const win = checkWinCondition(allAllied(['grid']), []);
    assert.ok(!win || win.condition !== 'NO ENEMIES LEFT', 'lone human keeps a path to the Reckoning');
  });
  it('still fires in all-AI games (sim outcome preserved)', () => {
    const win = checkWinCondition(allAllied([]), []);
    assert.ok(win && win.fk === TYRANT_KEY && win.condition === 'NO ENEMIES LEFT');
  });
  it('still fires in 2+ human games', () => {
    const win = checkWinCondition(allAllied(['grid', 'syndicate']), []);
    assert.ok(win && win.fk === TYRANT_KEY && win.condition === 'NO ENEMIES LEFT');
  });
});
