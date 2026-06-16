// ============================================================
// ai.js — Pure AI decision-making
// chooseAction(state, fk) -> action object (or null if nothing to do)
// No DOM, no timers, no network.
// ============================================================

import {
  TYRANT_KEY, THRALLDOM_CAP, MOON_BAND,
  adjacent, tilesOf, nodesOf, countNodes, controlsNode,
  livingKeys, hasPact, pairKey,
  reinforceCost, reinforceAmount, moveReachable, moveRange, airliftCost,
} from './state.js';

// ---- BFS from a set of source tiles ----
function bfsFromTiles(state, sources) {
  const tiles = Object.values(state.tiles);
  const dist = {};
  const q = [];
  sources.forEach(s => { dist[s.id] = 0; q.push(s); });
  for (let h = 0; h < q.length; h++) {
    const cur = q[h];
    for (const nb of tiles) {
      if (dist[nb.id] === undefined && adjacent(cur, nb)) {
        dist[nb.id] = dist[cur.id] + 1;
        q.push(nb);
      }
    }
  }
  return dist;
}

// ---- Find best attack target ----
function findBestAttack(state, fk, turnAttacks) {
  const myT = Object.values(state.tiles).filter(t => t.owner === fk);
  const enemyT = Object.values(state.tiles).filter(t => t.owner && t.owner !== fk);
  let best = null;

  for (const atk of myT.filter(t => t.troops >= 2)) {
    for (const def of enemyT) {
      if (!moveReachable(state, fk, atk, def)) continue;   // ghost-attack: leapfrog reach for phantom/ghost_step
      const pact = hasPact(state, fk, def.owner);
      // The TYRANT never opportunistically betrays an ally; its break is the conquest flip.
      const canBetray = def.isNode && atk.troops >= def.troops + 2 && fk !== TYRANT_KEY;
      if (pact && !canBetray) continue;

      const atkPower = Math.min(2, Math.floor(atk.troops / 4));
      const defPower = Math.min(2, Math.floor(def.troops / 4))
        + Math.min(def.heldRounds || 0, def.isNode ? 2 : 3)
        + (def.owner === TYRANT_KEY ? 0 : ((state.turnStrikes && state.turnStrikes[atk.id + '|' + def.id]) || 0) * 2);  // rally: per-encounter (this tile vs that tile), none vs Tyrant
      const edge = (atk.troops - def.troops) + (atkPower - defPower) * 2;
      const score = (def.isNode ? 100 : 0) + edge * 10 - def.troops - (pact ? 15 : 0);
      if (!best || score > best.score) best = { atk, def, score, betray: pact };
    }
  }
  return best;
}

// ---- Advance/carry sizing ----
// Commit force forward, but keep a rear guard when the source tile is threatened.
function tileThreatened(state, fk, tile) {
  return Object.values(state.tiles).some(t => t.owner && t.owner !== fk && adjacent(tile, t));
}
function carryCount(state, fk, src) {
  const movable = Math.max(1, src.troops - 1);
  return tileThreatened(state, fk, src) ? Math.max(1, Math.floor(movable / 2)) : movable;
}
// Post-capture advance: commit hard for a node, advance half into a plain tile
// (keeps the source able to press the assault). Engine clamps to stack−1.
function advanceFor(state, fk, atk, def) {
  if (def.isNode) return tileThreatened(state, fk, atk) ? Math.max(1, Math.floor(atk.troops / 2)) : atk.troops;
  return Math.floor(Math.max(0, atk.troops - 1) / 2);
}

// ---- Node push: seize unclaimed node or march toward nearest ----
function aiNodePush(state, fk) {
  const tiles = Object.values(state.tiles);
  const movable = tiles.filter(t => t.owner === fk && t.troops >= 2);
  if (!movable.length) return null;
  const targets = tiles.filter(t => t.isNode && t.owner !== fk);
  if (!targets.length) return null;

  const phantom = state.factions[fk]?.ability === 'sabotage';

  // Step onto adjacent unclaimed/own node (or 2-tile reach for phantom/ghost_step)
  for (const src of movable) {
    const node = targets.find(n => !n.owner && moveReachable(state, fk, src, n));
    if (node) return { type: 'MOVE', src: src.id, dst: node.id, count: carryCount(state, fk, src) };
  }

  // March toward nearest node — phantom can consider 2-tile jumps through enemy tiles
  const dist = bfsFromTiles(state, targets);
  let mv = null;
  for (const src of movable) {
    const here = dist[src.id];
    if (here === undefined) continue;
    // Standard 1-tile moves
    for (const nb of tiles) {
      if (adjacent(src, nb) && (!nb.owner || nb.owner === fk)) {
        const d = dist[nb.id];
        if (d !== undefined && d < here && (!mv || d < mv.d || (d === mv.d && src.troops > mv.srcTroops)))
          mv = { src: src.id, dst: nb.id, d, srcTroops: src.troops };
      }
    }
    // Phantom/ghost_step: multi-tile jumps through enemy tiles
    if (moveRange(state, fk) >= 2) {
      for (const nb of tiles) {
        if (nb.id === src.id) continue;
        if (nb.owner && nb.owner !== fk) continue;  // can't land on enemy
        if (!moveReachable(state, fk, src, nb)) continue;
        const d = dist[nb.id];
        if (d !== undefined && d < here && (!mv || d < mv.d || (d === mv.d && src.troops > mv.srcTroops)))
          mv = { src: src.id, dst: nb.id, d, srcTroops: src.troops };
      }
    }
  }
  if (mv) return { type: 'MOVE', src: mv.src, dst: mv.dst, count: carryCount(state, fk, state.tiles[mv.src]) };
  return null;
}

// ---- AI ability usage ----
function chooseAbility(state, fk) {
  const f = state.factions[fk];
  const myT = () => Object.values(state.tiles).filter(t => t.owner === fk);
  const enemyT = () => Object.values(state.tiles).filter(t => t.owner && t.owner !== fk);

  if (f.ability === 'sabotage' && f.resources >= 1) {
    const foes = enemyT().filter(t => !hasPact(state, fk, t.owner));
    // Priority: weak garrison (1-2 troops) on a node we can then capture
    const clearableNode = foes.filter(t => t.isNode && t.troops <= 2
      && myT().some(m => m.troops >= 2 && adjacent(m, t)))
      .sort((a,b) => a.troops - b.troops)[0];
    // Then: weak garrison adjacent to a node (opens the path)
    const clearableAdj = !clearableNode && foes.filter(t => t.troops <= 2
      && Object.values(state.tiles).some(n => n.isNode && n.owner !== fk && adjacent(t, n)))
      .sort((a,b) => a.troops - b.troops)[0];
    // Fallback: biggest threat on a node, or any large stack
    const fallback = foes.filter(t => t.isNode).sort((a,b) => b.troops - a.troops)[0]
                  || foes.sort((a,b) => b.troops - a.troops)[0];
    const target = clearableNode || clearableAdj || fallback;
    if (target) return { type: 'ABILITY', kind: 'sabotage', target: target.id };
  }

  if (f.ability === 'bribe' && f.resources >= 1) {
    for (const mt of myT()) {
      const tgt = enemyT().find(e => adjacent(mt, e) && !hasPact(state, fk, e.owner));
      if (tgt) return { type: 'ABILITY', kind: 'bribe', target: tgt.id };
    }
  }

  if (f.ability === 'rally' && f.resources >= 1) {
    const frontline = myT().filter(t => enemyT().some(e => adjacent(t, e)));
    if (frontline.length) return { type: 'ABILITY', kind: 'rally', target: frontline[0].id };
  }

  if (f.ability === 'overclock' && f.resources >= 1) {
    const priority = myT().filter(t => t.isNode || enemyT().some(e => adjacent(t, e)));
    const target = (priority.length ? priority : myT()).sort((a,b) => a.troops - b.troops)[0];
    if (target) return { type: 'ABILITY', kind: 'overclock', target: target.id };
  }

  return null;
}

// ============================================================
// MAIN: chooseAction(state, fk) -> action | null
// ============================================================
export function chooseAction(state, fk) {
  const f = state.factions[fk];
  if (!f || f.eliminated) return null;

  const myT = () => Object.values(state.tiles).filter(t => t.owner === fk);
  const enemyT = () => Object.values(state.tiles).filter(t => t.owner && t.owner !== fk);
  const myNodes = nodesOf(state, fk);
  const turnAttacks = state.turnAttacks || 0;

  const best = findBestAttack(state, fk, turnAttacks);
  const attackable = best && best.atk.troops >= 2 && !state.signalJam;

  // 0. DEFEND LEAD: when holding 2+ nodes, entrench/reinforce them
  if (myNodes.length >= 2) {
    const weakNode = myNodes
      .filter(t => (t.heldRounds||0) < (t.isNode?2:3) && t.troops >= 2 && enemyT().some(e => adjacent(t,e)))
      .sort((a,b) => (a.heldRounds||0) - (b.heldRounds||0))[0];
    if (weakNode && f.resources >= 2) {
      return { type: 'ENTRENCH', tile: weakNode.id };
    }
    const thinNode = myNodes.filter(t => t.troops < 4).sort((a,b) => a.troops - b.troops)[0];
    if (thinNode && f.resources >= reinforceCost(state, fk)) {
      return { type: 'REINFORCE', tile: thinNode.id };
    }
  }

  // 0b. GHOST PRIORITY: sabotage a weak node garrison to clear it for capture
  if (f.ability === 'sabotage' && f.resources >= 1) {
    const foes = enemyT().filter(t => !hasPact(state, fk, t.owner));
    const clearable = foes.filter(t => t.isNode && t.troops <= 2
      && myT().some(m => m.troops >= 2 && adjacent(m, t)))
      .sort((a,b) => a.troops - b.troops)[0];
    if (clearable) return { type: 'ABILITY', kind: 'sabotage', target: clearable.id };
  }

  // 1. Seize enemy-held NODE
  if (attackable && best.def.isNode && best.atk.troops >= best.def.troops) {
    const action = { type: 'ATTACK', src: best.atk.id, tgt: best.def.id, attackerFk: fk,
                     advance: advanceFor(state, fk, best.atk, best.def) };
    if (best.betray) action.breakPact = { betrayer: fk, victim: best.def.owner };
    return action;
  }

  // 1b. AIRLIFT to concentrate force before node assault (free with 🚇 TRANSIT)
  if (f.resources >= airliftCost(state, fk) && myT().length >= 2) {
    const nodeTarget = enemyT().find(t => t.isNode && myT().some(m => adjacent(m,t) && m.troops < t.troops));
    if (nodeTarget) {
      const adjTile = myT().find(m => adjacent(m, nodeTarget) && m.troops < nodeTarget.troops);
      const donor = myT().filter(t => t.id !== adjTile?.id && t.troops >= 3).sort((a,b) => b.troops - a.troops)[0];
      if (adjTile && donor) {
        return { type: 'AIRLIFT', src: donor.id, dst: adjTile.id, count: Math.min(3, donor.troops - 1) };
      }
    }
  }

  // 2. Grab unclaimed Node or march toward nearest
  const push = aiNodePush(state, fk);
  if (push) return push;

  // 3. Any favorable attack
  if (attackable && best.atk.troops > best.def.troops) {
    const action = { type: 'ATTACK', src: best.atk.id, tgt: best.def.id, attackerFk: fk,
                     advance: advanceFor(state, fk, best.atk, best.def) };
    if (best.betray) action.breakPact = { betrayer: fk, victim: best.def.owner };
    return action;
  }

  // 4. Use special ability
  const ability = chooseAbility(state, fk);
  if (ability) return ability;

  // 4b. Entrench a frontline node
  if (f.resources >= 2) {
    const maxDig = (t) => t.isNode ? 2 : 3;
    const node = nodesOf(state, fk)
      .filter(t => t.troops >= 3 && (t.heldRounds||0) < maxDig(t) && enemyT().some(e => adjacent(t,e)))
      .sort((a,b) => (a.heldRounds||0) - (b.heldRounds||0))[0];
    if (node) return { type: 'ENTRENCH', tile: node.id };
  }

  // 5. Reinforce
  const cost = reinforceCost(state, fk);
  if (f.resources >= cost && myT().length > 0) {
    const priority = myT().filter(t => t.isNode || enemyT().some(e => adjacent(t,e)));
    const target = (priority.length ? priority : myT()).sort((a,b) => a.troops - b.troops)[0];
    if (target) return { type: 'REINFORCE', tile: target.id };
  }

  return null;
}

// ---- AI choice for choice events ----
export function aiChooseEvent(state, fk, eventKey) {
  const f = state.factions[fk];
  if (eventKey === 'warlordTribute') return f.resources >= 4 ? 0 : 1;
  if (eventKey === 'mercenaryContract') {
    const mine = tilesOf(state, fk);
    const troops = mine.reduce((s,t) => s + t.troops, 0);
    const hungry = mine.length > 0 && (troops / mine.length) < 2.5;
    return (f.resources >= 5 && hungry) ? 0 : 1;
  }
  return 0;
}

// ---- AI pact consideration ----
export function aiConsiderPact(state, aiFk, propFk) {
  // Tyrant accepts every pact — every ally brings it closer to diplomacy win —
  // unless it has hit its concurrent-pact cap (single-human games: max 3).
  if (aiFk === TYRANT_KEY) {
    const allies = livingKeys(state).filter(k => k !== TYRANT_KEY && hasPact(state, TYRANT_KEY, k));
    const cap = (state.humans && state.humans.length === 1) ? 3 : Infinity;
    return allies.length < cap;
  }

  // Being courted BY the Tyrant: graduated acceptance based on board position.
  // Awareness: the more allies the Tyrant already has, the more dangerous signing becomes.
  if (propFk === TYRANT_KEY) {
    const myNodes = countNodes(state, aiFk);
    const myTiles = tilesOf(state, aiFk).length;
    const tyrantTiles = tilesOf(state, TYRANT_KEY).length;
    const tyrantAllies = livingKeys(state).filter(k => k !== TYRANT_KEY && hasPact(state, TYRANT_KEY, k)).length;
    const totalRivals = livingKeys(state).filter(k => k !== TYRANT_KEY).length;
    // Last holdout — signing hands the Tyrant the diplomacy win. Near-zero.
    if (tyrantAllies >= totalRivals - 1) return Math.random() < 0.05;
    // Pact penalty: more Tyrant allies = closer to diplomacy win = riskier to sign
    const pactMul = tyrantAllies >= 2 ? 0.4 : tyrantAllies >= 1 ? 0.7 : 1.0;
    // Leading contender (2+ nodes) — strong reason to refuse
    if (myNodes >= 2) return Math.random() < 0.08 * pactMul;
    // Healthy mid-range (5+ tiles, 1 node) — cautious
    if (myTiles >= 5 && myNodes >= 1) return Math.random() < 0.18 * pactMul;
    // Underdog (few tiles, 0 nodes) — desperate, more willing
    if (myTiles <= 3) return Math.random() < 0.50 * pactMul;
    // Scared by large Tyrant blob
    if (tyrantTiles >= 5) return Math.random() < 0.35 * pactMul;
    // Default middle ground
    return Math.random() < 0.25 * pactMul;
  }

  // Normal (non-Tyrant) pact consideration
  const myTiles = tilesOf(state, aiFk).length;
  const theirTiles = tilesOf(state, propFk).length;
  if (myTiles <= 2) return true;
  if (theirTiles >= myTiles + 2) return true;
  const myNodes = countNodes(state, aiFk);
  const theirNodes = countNodes(state, propFk);
  if (theirNodes >= 2 && myNodes < 2) return true;
  return Math.random() < 0.3;
}

// Part 2 Step 8: AI boon pick — behind on economy? Tithe. Has adjacent rival? Sic.
export function aiPickBoon(state, aiFk) {
  const myT = tilesOf(state, aiFk);
  const hasAdjacentRival = myT.some(mt =>
    Object.values(state.tiles).some(t => t.owner && t.owner !== aiFk && t.owner !== TYRANT_KEY && adjacent(mt, t))
  );
  return (hasAdjacentRival && myT.length >= 3) ? 'sic' : 'tithe';
}

// Conspirator AI redemption — should this bound AI renounce-kill the Tyrant?
// Aligned with the HUMAN rule: a bound faction can only renounce at the "last reprieve" —
// the moment it is close to a victory that would force a Reckoning. There is NO mid-game
// dead-zone bailout (that escape hatch was AI-only and unfair to humans).
export function aiShouldRenounce(state, aiFk) {
  if (!state.tyrantOn) return false;
  if (!state.factions[TYRANT_KEY] || state.factions[TYRANT_KEY].eliminated) return false;
  if (!hasPact(state, TYRANT_KEY, aiFk)) return false;
  const corr = state.factions[aiFk].corruption || 0;
  if (corr <= 0) return false;

  // Same gate as the human's "Fork in the Dark" prompt: only offered when close to a win.
  const myNodes = countNodes(state, aiFk);
  const myTiles = tilesOf(state, aiFk).length;
  const heldSince = state.nodesHeldSince && state.nodesHeldSince[aiFk];
  const closeToWin = (myNodes >= 3 && heldSince !== undefined)
                  || (myNodes >= 2 && myTiles >= 8);
  if (!closeToWin) return false;

  // At the reprieve: if we're in the moon band, commit to the jackpot duel (conspirator-favored).
  // Otherwise the duel curve favors the Tyrant — renounce-kill to avoid thralldom.
  const moonLow = THRALLDOM_CAP - MOON_BAND;
  if (corr >= moonLow && corr < THRALLDOM_CAP) return false;
  return true;
}
