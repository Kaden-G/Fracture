// Unit tests for the win-condition / agenda registry (src/objectives.js).
// Pure predicates over a mock `api` — no engine, no DOM.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OBJECTIVES, getObjective, agendaPool, isObjectiveMet } from '../src/objectives.js';

// Build a mock api from a plain spec, defaulting everything to neutral.
function mkApi(spec = {}) {
  return {
    round: spec.round ?? 1,
    foesAtStart: spec.foesAtStart ?? 4,
    nodes: (fk) => (spec.nodes && spec.nodes[fk]) || 0,
    tiles: (fk) => (spec.tiles && spec.tiles[fk]) || 0,
    resources: (fk) => (spec.resources && spec.resources[fk]) || 0,
    livingRivals: (fk) => (spec.livingRivals && spec.livingRivals[fk]) ?? 3,
    livingFoes: (fk) => (spec.livingFoes && spec.livingFoes[fk]) ?? 3,
    pactRounds: (fk) => (spec.pactRounds && spec.pactRounds[fk]) || 0,
    cardinalRegionTiles: (fk) => (spec.cardinalRegionTiles && spec.cardinalRegionTiles[fk]) || { N: 0, S: 0, E: 0, W: 0 },
  };
}

describe('Objectives registry', () => {
  it('agendaPool excludes universal wins', () => {
    const ids = agendaPool().map(o => o.id);
    assert.ok(!ids.includes('node_dominance'));
    assert.ok(!ids.includes('last_standing'));
    assert.ok(ids.includes('purge'));
    assert.ok(ids.length >= 3, 'at least a few agenda cards');
  });

  it('getObjective returns null for unknown ids', () => {
    assert.equal(getObjective('nope'), null);
    assert.equal(getObjective('purge').id, 'purge');
  });

  it('every objective has check + progress + desc', () => {
    for (const o of Object.values(OBJECTIVES)) {
      assert.equal(typeof o.check, 'function', `${o.id} check`);
      assert.equal(typeof o.progress, 'function', `${o.id} progress`);
      assert.ok(o.desc && o.title, `${o.id} text`);
      const p = o.progress(mkApi(), 'grid');
      assert.ok('cur' in p && 'max' in p && 'label' in p, `${o.id} progress shape`);
    }
  });

  it('node_dominance: met at 3 nodes', () => {
    assert.equal(OBJECTIVES.node_dominance.check(mkApi({ nodes: { grid: 2 } }), 'grid'), false);
    assert.equal(OBJECTIVES.node_dominance.check(mkApi({ nodes: { grid: 3 } }), 'grid'), true);
  });

  it('last_standing: met when no rivals remain', () => {
    assert.equal(OBJECTIVES.last_standing.check(mkApi({ livingRivals: { grid: 1 } }), 'grid'), false);
    assert.equal(OBJECTIVES.last_standing.check(mkApi({ livingRivals: { grid: 0 } }), 'grid'), true);
  });

  it('purge: met after a single rival is eliminated (foesAtStart=4 => livingFoes<=2)', () => {
    assert.equal(OBJECTIVES.purge.check(mkApi({ foesAtStart: 4, livingFoes: { grid: 3 } }), 'grid'), false);
    assert.equal(OBJECTIVES.purge.check(mkApi({ foesAtStart: 4, livingFoes: { grid: 2 } }), 'grid'), true);
    const p0 = OBJECTIVES.purge.progress(mkApi({ foesAtStart: 4, livingFoes: { grid: 3 } }), 'grid');
    assert.equal(p0.cur, 0, '3 rivals alive => 0 purged');
    const p1 = OBJECTIVES.purge.progress(mkApi({ foesAtStart: 4, livingFoes: { grid: 2 } }), 'grid');
    assert.equal(p1.cur, 1, '2 rivals alive => 1 purged');
    assert.equal(p1.max, 1);
  });

  it('warlord: met at 14 tiles', () => {
    assert.equal(OBJECTIVES.warlord.check(mkApi({ tiles: { grid: 13 } }), 'grid'), false);
    assert.equal(OBJECTIVES.warlord.check(mkApi({ tiles: { grid: 14 } }), 'grid'), true);
  });

  it('four_winds: needs 2+ tiles in ALL of N/S/E/W', () => {
    const three = { cardinalRegionTiles: { grid: { N: 2, S: 2, E: 2, W: 1 } } };
    const all   = { cardinalRegionTiles: { grid: { N: 2, S: 3, E: 2, W: 2 } } };
    assert.equal(OBJECTIVES.four_winds.check(mkApi(three), 'grid'), false);
    assert.equal(OBJECTIVES.four_winds.check(mkApi(all), 'grid'), true);
    assert.equal(OBJECTIVES.four_winds.progress(mkApi(three), 'grid').cur, 3, '3 of 4 regions covered');
    assert.equal(OBJECTIVES.four_winds.progress(mkApi(all), 'grid').cur, 4);
  });

  it('power_broker: needs BOTH 2 nodes AND a 2-round pact', () => {
    assert.equal(OBJECTIVES.power_broker.check(mkApi({ nodes: { grid: 2 }, pactRounds: { grid: 1 } }), 'grid'), false);
    assert.equal(OBJECTIVES.power_broker.check(mkApi({ nodes: { grid: 1 }, pactRounds: { grid: 2 } }), 'grid'), false);
    assert.equal(OBJECTIVES.power_broker.check(mkApi({ nodes: { grid: 2 }, pactRounds: { grid: 2 } }), 'grid'), true);
  });

  it('isObjectiveMet helper guards unknown ids', () => {
    assert.equal(isObjectiveMet(mkApi({ tiles: { grid: 15 } }), 'grid', 'warlord'), true);
    assert.equal(isObjectiveMet(mkApi({ tiles: { grid: 10 } }), 'grid', 'warlord'), false);
    assert.equal(isObjectiveMet(mkApi(), 'grid', 'bogus'), false);
  });
});
