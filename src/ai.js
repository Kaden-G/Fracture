// ============================================================
// ai.js — Pure AI decision-making
// chooseAction(state, fk) -> action object (or null if nothing to do)
// No DOM, no timers, no network.
// ============================================================

import {
  TYRANT_KEY, THRALLDOM_CAP, MOON_BAND,
  adjacent, tilesOf, nodesOf, countNodes, controlsNode,
  livingKeys, hasPact, pairKey, hasTrait, hasPerkOf,
  reinforceCost, reinforceAmount, moveReachable, moveRange, airliftCost,
  RES_CAP,
} from './state.js';
import { AI_PROFILES, DEFAULT_TIER } from './ai_profiles.js';

// ============================================================
// PHASE 2-4b MIRROR: difficulty knobs (parallel to app.js's aiProfile)
// Tyrant always plays at max discipline; humans never see this code.
// ============================================================
function aiProfile(state, fk) {
  if (fk === TYRANT_KEY) return AI_PROFILES.bloodbath;
  const f = state.factions[fk];
  return AI_PROFILES[f && f.diff] || AI_PROFILES[DEFAULT_TIER];
}

// THREAT READ (Phase 4): the rival closest to a node victory, from viewer's seat — the faction
// the smart play is to STOP, not appease. 3+ nodes always; 2 nodes only if they're SOLE leader.
function mustStopLeader(state, viewerFk) {
  let lead = null, leadN = 1;
  for (const k of livingKeys(state)) {
    if (k === TYRANT_KEY || k === viewerFk) continue;
    const n = countNodes(state, k);
    if (n > leadN) { leadN = n; lead = k; }
  }
  if (!lead) return null;
  if (leadN >= 3) return lead;
  const others = livingKeys(state).filter(k => k !== lead && k !== TYRANT_KEY && countNodes(state, k) >= 2);
  return others.length === 0 ? lead : null;
}
// EMERGENCY (Phase 4b): rival already at 3+ nodes — triggers Bloodbath dogpile until knocked back.
function nodeEmergencyLeader(state, viewerFk) {
  const s = mustStopLeader(state, viewerFk);
  return (s && countNodes(state, s) >= 3) ? s : null;
}

// COMBAT ODDS (Phase 3): probability the attacker wins one exchange under the 2d6 dice model
// (best-2-of-3 for TACTICIAN), including the ±4 swing clamp resolveAttack uses. Mirrors app.js's
// winProb exactly. Verified against closed-form odds (even mods = 55.6%, +2 force ≈ 76%, etc.).
const _DIST_2D6 = (() => { const p = {}; for (let a=1;a<=6;a++) for (let b=1;b<=6;b++){ const s=a+b; p[s]=(p[s]||0)+1; } for (const k in p) p[k]/=36; return p; })();
const _DIST_BEST2OF3 = (() => { const p = {}; for (let a=1;a<=6;a++) for (let b=1;b<=6;b++) for (let c=1;c<=6;c++){ const s=a+b+c-Math.min(a,b,c); p[s]=(p[s]||0)+1; } for (const k in p) p[k]/=216; return p; })();
function _diffAtLeast(attDist, t) {
  let prob = 0;
  for (const a in attDist) for (const d in _DIST_2D6) { if ((+a) - (+d) >= t) prob += attDist[a] * _DIST_2D6[d]; }
  return prob;
}
function winProb(attMod, defMod, fortify, tactician) {
  let swing = attMod - defMod;
  if (swing > 4) swing = 4; else if (swing < -4) swing = -4;
  return _diffAtLeast(tactician ? _DIST_BEST2OF3 : _DIST_2D6, -swing + (fortify || 0));
}

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
  const prof = aiProfile(state, fk);
  const useEV = prof.lookahead >= 1;
  const af = state.factions[fk];
  const myNodeCount = nodesOf(state, fk).length;
  const stop = useEV ? mustStopLeader(state, fk) : null;   // focus-fire target (Phase 4)
  let best = null;

  for (const atk of myT.filter(t => t.troops >= 2)) {
    for (const def of enemyT) {
      if (!moveReachable(state, fk, atk, def)) continue;   // ghost-attack: leapfrog reach for phantom/ghost_step
      const pact = hasPact(state, fk, def.owner);
      // The TYRANT never opportunistically betrays an ally; its break is the conquest flip. And a
      // pact WITH the Tyrant is binding — a bound faction can't betray it either (only the Reckoning).
      const canBetray = def.isNode && atk.troops >= def.troops + 2 && fk !== TYRANT_KEY && def.owner !== TYRANT_KEY;
      if (pact && !canBetray) continue;

      const atkPower = Math.min(2, Math.floor(atk.troops / 4));
      const defPower = Math.min(2, Math.floor(def.troops / 4))
        + Math.min(def.heldRounds || 0, def.isNode ? 2 : 3)
        + (def.owner === TYRANT_KEY ? 0 : ((state.turnStrikes && state.turnStrikes[atk.id + '|' + def.id]) || 0) * 2);  // rally: per-encounter (this tile vs that tile), none vs Tyrant
      const edge = (atk.troops - def.troops) + (atkPower - defPower) * 2;
      let score, p = null;
      if (useEV) {
        // EV scoring (Phase 3): weight prize by real odds, charge for likely loss, dock fragile
        // captures an enemy could immediately recapture, and pile a focus-fire bonus on the leader.
        const df = state.factions[def.owner];
        const fortify  = (df && hasTrait(df, 'fortify')) ? ((def.heldRounds||0) > 0 ? 2 : 1) : 0;
        const lastStand = (df && hasTrait(df, 'last_stand') && def.troops <= 2) ? 3 : 0;
        // PHASE 5: factor in the anti-leader surge and entrenchment-crack we'd benefit from.
        // Without this, the AI would underestimate odds against a 3-node leader (~33%) and never
        // commit — chicken-and-egg where strikes never accumulate. We inline the logic from
        // engine.js's nodeLeaderSurge / leaderEntrenchCracked to keep ai.js dependency-free.
        let lSurge = 0, wouldCrack = false;
        const leaderActive = def.owner !== TYRANT_KEY && fk !== TYRANT_KEY && !pact && countNodes(state, def.owner) >= 3;
        if (leaderActive) {
          const rec = state.leaderStruck && state.leaderStruck[def.id];
          const fresh = rec && (state.round - rec.round) <= 1;
          if (fresh) {
            lSurge = Math.min(3, Object.keys(rec.attackers).filter(k => k !== fk).length);
            // Crack triggers when the besieging count (including me, if I'm new) hits 2+.
            const willBeMembers = (rec.attackers[fk] ? 0 : 1) + Object.keys(rec.attackers).length;
            wouldCrack = willBeMembers >= 2;
          } else {
            // First strike of a new siege: I'm member #1, no crack yet, no surge for me.
          }
        }
        const effEntrench = wouldCrack ? 0 : Math.min(def.heldRounds || 0, def.isNode ? 2 : 3);
        const effDefMod = Math.min(2, Math.floor(def.troops / 4))
          + effEntrench
          + (def.owner === TYRANT_KEY ? 0 : ((state.turnStrikes && state.turnStrikes[atk.id + '|' + def.id]) || 0) * 2);
        p = winProb(atkPower + lSurge, effDefMod + lastStand, fortify, af && hasTrait(af, 'tactician'));
        const winsTheGame = def.isNode && (myNodeCount + 1) >= 3;
        const stopBonus = (def.owner === stop) ? (def.isNode ? 180 : 45) : 0;
        const captureValue = (def.isNode ? 120 : 16 + def.troops) + (winsTheGame ? 220 : 0) + stopBonus;
        const lossCost = 6 + def.troops;
        // 1-ply counter: strongest adjacent enemy recapturing our freshly-taken (1-troop) tile.
        let counterP = 0;
        for (const e of enemyT) {
          if (e.owner === fk || e.troops < 2 || !adjacent(e, def) || hasPact(state, fk, e.owner)) continue;
          const ePow = Math.min(2, Math.floor(e.troops/4));
          const pRe = winProb(ePow, 0, 0, hasTrait(state.factions[e.owner] || {}, 'tactician'));
          if (pRe > counterP) counterP = pRe;
        }
        score = p*captureValue - (1-p)*lossCost - counterP*captureValue*0.7 - (pact?40:0);
      } else {
        // Greedy heuristic (Sandbox / JV): nodes, then weaker targets, then a troop edge.
        score = (def.isNode ? 100 : 0) + edge * 10 - def.troops - (pact ? 15 : 0);
      }
      if (!best || score > best.score) best = { atk, def, score, edge, p, betray: pact };
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

  const phantom = hasPerkOf(state.factions[fk], 'sabotage');   // PHANTOM perk (native or inherited)

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

// A deliberately weak action for low-skill tiers (driven by profile.blunder). Mirrors
// app.js's aiLazyAction: reckless strike on a random reachable enemy, or a wasteful reinforce.
function aiLazyAction(state, fk) {
  const f = state.factions[fk];
  const myT = Object.values(state.tiles).filter(t => t.owner === fk);
  const enemyT = Object.values(state.tiles).filter(t => t.owner && t.owner !== fk);
  if (Math.random() < 0.5) {
    for (const a of myT.filter(t => t.troops >= 2)) {
      const targets = enemyT.filter(d => moveReachable(state, fk, a, d) && !hasPact(state, fk, d.owner));
      if (targets.length) {
        const d = targets[(Math.random() * targets.length) | 0];
        return { type: 'ATTACK', src: a.id, tgt: d.id, attackerFk: fk, advance: 0 };
      }
    }
  }
  if (f.resources >= reinforceCost(state, fk) && myT.length) {
    const t = myT[(Math.random() * myT.length) | 0];
    return { type: 'REINFORCE', tile: t.id };
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

  const prof = aiProfile(state, fk);
  // Low tiers squander a fraction of actions on something bad (Tyrant never blunders).
  if (fk !== TYRANT_KEY && prof.blunder && Math.random() < prof.blunder) {
    const lazy = aiLazyAction(state, fk);
    if (lazy) return lazy;
  }

  const best = findBestAttack(state, fk, turnAttacks);
  const attackable = best && best.atk.troops >= 2 && !state.signalJam;
  const edge = best ? (best.atk.troops - best.def.troops) : -99;
  const useEV = prof.lookahead >= 1;

  // EMERGENCY (Phase 4b): a rival ALREADY holds 3 nodes — win timer is running. Coordinate tiers
  // (Bloodbath) drop everything to knock them back below the line at coalition odds (≥ 0.4).
  // Outranks even defending our own lead.
  const emLeader = (fk !== TYRANT_KEY && useEV && prof.coordinate) ? nodeEmergencyLeader(state, fk) : null;
  if (emLeader && attackable && best.def.owner === emLeader && best.p >= 0.4) {
    const action = { type: 'ATTACK', src: best.atk.id, tgt: best.def.id, attackerFk: fk,
                     advance: advanceFor(state, fk, best.atk, best.def) };
    if (best.betray) action.breakPact = { betrayer: fk, victim: best.def.owner };
    return action;
  }

  // 0. DEFEND LEAD: low tiers (defendLead off) never bother and leak their own nodes.
  if (prof.defendLead && myNodes.length >= 2) {
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

  // 0b. GHOST PRIORITY: sabotage a weak node garrison to clear it for capture (abilities gate).
  if (prof.abilities && f.ability === 'sabotage' && f.resources >= 1) {
    const foes = enemyT().filter(t => !hasPact(state, fk, t.owner));
    const clearable = foes.filter(t => t.isNode && t.troops <= 2
      && myT().some(m => m.troops >= 2 && adjacent(m, t)))
      .sort((a,b) => a.troops - b.troops)[0];
    if (clearable) return { type: 'ABILITY', kind: 'sabotage', target: clearable.id };
  }

  // 1. Seize enemy-held NODE. Lookahead tiers commit on win-probability (coordinate tier piles
  // onto the leader's node at sub-even odds 0.4); greedy tiers use the old troop-edge gate with
  // minEdge cushion (top tier 0 — they strike at even troops since the attacker wins ties).
  const stopLeader = useEV ? mustStopLeader(state, fk) : null;
  // Sacrifice rule: when an emergency leader (3+ nodes) is winning, take the FIRST strike at low
  // odds even if it costs you — it cracks entrenchment and surges the next attacker. Without this,
  // nobody commits the 1st strike (~33% solo odds) and the levers never get to fire. The +EV check
  // still applies (we never throw away troops for nothing).
  const emLead = useEV ? nodeEmergencyLeader(state, fk) : null;
  const isLeaderNode = best && best.def.isNode && best.def.owner === stopLeader;
  const isEmNode = best && best.def.isNode && best.def.owner === emLead;
  const nodeThresh = isEmNode
    ? (prof.coordinate ? 0.22 : 0.32)   // Bloodbath/Varsity: lean in even on tough odds
    : (prof.coordinate && isLeaderNode ? 0.4 : 0.5);
  if (attackable && best.def.isNode && (useEV ? (best.p >= nodeThresh && best.score > 0) : edge >= prof.minEdge)) {
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

  // 3. Any favorable attack. Lookahead: solid odds AND positive EV (won't trade into recapture).
  if (attackable && (useEV ? (best.p >= 0.6 && best.score > 0) : edge >= Math.max(1, prof.minEdge))) {
    const action = { type: 'ATTACK', src: best.atk.id, tgt: best.def.id, attackerFk: fk,
                     advance: advanceFor(state, fk, best.atk, best.def) };
    if (best.betray) action.breakPact = { betrayer: fk, victim: best.def.owner };
    return action;
  }

  // 4. Use special ability (low tiers ignore abilities entirely)
  if (prof.abilities) {
    const ability = chooseAbility(state, fk);
    if (ability) return ability;
  }

  // 4b. Entrench a frontline node (defendLead gate)
  if (prof.defendLead && f.resources >= 2) {
    const maxDig = (t) => t.isNode ? 2 : 3;
    const node = nodesOf(state, fk)
      .filter(t => t.troops >= 3 && (t.heldRounds||0) < maxDig(t) && enemyT().some(e => adjacent(t,e)))
      .sort((a,b) => (a.heldRounds||0) - (b.heldRounds||0))[0];
    if (node) return { type: 'ENTRENCH', tile: node.id };
  }

  // 5. Reinforce — disciplined tiers feed weakest frontline; undisciplined (low thrift) reinforce
  //    randomly. ENCIRCLED (down to last tile) = supply cut, can't reinforce.
  const cost = reinforceCost(state, fk);
  const encircled = fk !== TYRANT_KEY && myT().length <= 1;   // last tile = supply cut
  if (!encircled && f.resources >= cost && myT().length > 0) {
    const smart = Math.random() < prof.thrift;
    const priority = myT().filter(t => t.isNode || enemyT().some(e => adjacent(t,e)));
    const pool = (smart && priority.length) ? priority : myT();
    const target = smart ? pool.sort((a,b) => a.troops - b.troops)[0]
                         : pool[(Math.random() * pool.length) | 0];
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
