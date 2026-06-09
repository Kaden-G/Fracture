// ============================================================
// ai.js — Pure AI decision-making
// chooseAction(state, fk) -> action object (or null if nothing to do)
// No DOM, no timers, no network.
// ============================================================

import {
  TYRANT_KEY,
  adjacent, tilesOf, nodesOf, countNodes, controlsNode,
  livingKeys, hasPact, pairKey,
  reinforceCost, reinforceAmount,
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
      if (!adjacent(atk, def)) continue;
      const pact = hasPact(state, fk, def.owner);
      const canBetray = def.isNode && atk.troops >= def.troops + 2;
      if (pact && !canBetray) continue;

      const atkPower = Math.min(2, Math.floor(atk.troops / 4));
      const defPower = Math.min(2, Math.floor(def.troops / 4))
        + Math.min(def.heldRounds || 0, def.isNode ? 2 : 3)
        + (turnAttacks || 0) * 2;
      const edge = (atk.troops - def.troops) + (atkPower - defPower) * 2;
      const score = (def.isNode ? 100 : 0) + edge * 10 - def.troops - (pact ? 15 : 0);
      if (!best || score > best.score) best = { atk, def, score, betray: pact };
    }
  }
  return best;
}

// ---- Node push: seize unclaimed node or march toward nearest ----
function aiNodePush(state, fk) {
  const tiles = Object.values(state.tiles);
  const movable = tiles.filter(t => t.owner === fk && t.troops >= 2);
  if (!movable.length) return null;
  const targets = tiles.filter(t => t.isNode && t.owner !== fk);
  if (!targets.length) return null;

  // Step onto adjacent unclaimed node
  for (const src of movable) {
    const node = targets.find(n => !n.owner && adjacent(src, n));
    if (node) return { type: 'MOVE', src: src.id, dst: node.id };
  }

  // March toward nearest node
  const dist = bfsFromTiles(state, targets);
  let mv = null;
  for (const src of movable) {
    const here = dist[src.id];
    if (here === undefined) continue;
    for (const nb of tiles) {
      if (adjacent(src, nb) && (!nb.owner || nb.owner === fk)) {
        const d = dist[nb.id];
        if (d !== undefined && d < here && (!mv || d < mv.d || (d === mv.d && src.troops > mv.srcTroops)))
          mv = { src: src.id, dst: nb.id, d, srcTroops: src.troops };
      }
    }
  }
  if (mv) return { type: 'MOVE', src: mv.src, dst: mv.dst };
  return null;
}

// ---- AI ability usage ----
function chooseAbility(state, fk) {
  const f = state.factions[fk];
  const myT = () => Object.values(state.tiles).filter(t => t.owner === fk);
  const enemyT = () => Object.values(state.tiles).filter(t => t.owner && t.owner !== fk);

  if (f.ability === 'sabotage' && f.resources >= 1) {
    const foes = enemyT().filter(t => !hasPact(state, fk, t.owner));
    const target = foes.filter(t => t.isNode).sort((a,b) => b.troops - a.troops)[0]
                || foes.sort((a,b) => b.troops - a.troops)[0];
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

  // 1. Seize enemy-held NODE
  if (attackable && best.def.isNode && best.atk.troops >= best.def.troops) {
    const action = { type: 'ATTACK', src: best.atk.id, tgt: best.def.id, attackerFk: fk };
    if (best.betray) action.breakPact = { betrayer: fk, victim: best.def.owner };
    return action;
  }

  // 1b. AIRLIFT to concentrate force before node assault
  if (f.resources >= 3 && myT().length >= 2) {
    const nodeTarget = enemyT().find(t => t.isNode && myT().some(m => adjacent(m,t) && m.troops < t.troops));
    if (nodeTarget) {
      const adjTile = myT().find(m => adjacent(m, nodeTarget) && m.troops < nodeTarget.troops);
      const donor = myT().filter(t => t.id !== adjTile?.id && t.troops >= 3).sort((a,b) => b.troops - a.troops)[0];
      if (adjTile && donor) {
        return { type: 'AIRLIFT', src: donor.id, dst: adjTile.id };
      }
    }
  }

  // 2. Grab unclaimed Node or march toward nearest
  const push = aiNodePush(state, fk);
  if (push) return push;

  // 2b. RETREAT thin stacks
  const threatened = myT().filter(t => t.troops <= 2 && !t.isNode &&
    enemyT().some(e => adjacent(t,e) && e.troops >= t.troops + 2));
  if (threatened.length) {
    const victim = threatened[0];
    const safe = myT().find(t => t.id !== victim.id && adjacent(t, victim));
    if (safe) return { type: 'AI_RETREAT', src: victim.id, dst: safe.id };
  }

  // 3. Any favorable attack
  if (attackable && best.atk.troops > best.def.troops) {
    const action = { type: 'ATTACK', src: best.atk.id, tgt: best.def.id, attackerFk: fk };
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
  const myTiles = tilesOf(state, aiFk).length;
  const theirTiles = tilesOf(state, propFk).length;
  if (myTiles <= 2) return true;
  if (theirTiles >= myTiles + 2) return true;
  const myNodes = countNodes(state, aiFk);
  const theirNodes = countNodes(state, propFk);
  if (theirNodes >= 2 && myNodes < 2) return true;
  return Math.random() < 0.3; // Note: in sim, this should use RNG
}
