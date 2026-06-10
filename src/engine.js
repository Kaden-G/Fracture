// ============================================================
// engine.js — Pure game state reducer
// reduce(state, action) -> { state, effects, log }
// No DOM, no timers, no network, no Math.random.
// All randomness flows through rng.js via state.rng.
// ============================================================

import {
  RES_CAP, GRID_SIZE, ROUND_CAP, FACTIONS, TYRANT_KEY, TYRANT_DEF,
  TRAITS, EVENT_DEFS, NODE_TILES, NODE_POSITIONS, START_CORNERS,
  DISTRICT_NAMES, REGION_NAMES,
  factionDef, regionOf, adjacent,
  tilesOf, nodesOf, countNodes, controlsNode, livingKeys,
  hasPact, pairKey,
  reinforceCost, reinforceAmount, moveTroopCount, moveRange, moveReachable,
  grudgeAtkBonus, grudgeDefBonus, coalitionAtkBonus, mkFaction,
} from './state.js';

import { roll2d6, nextInt, nextFloat, shuffleWithRng } from './rng.js';

// ---- Deep clone (JSON round-trip — state is JSON-serializable) ----
function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

// ---- Helper: region tiles from state ----
function regionTiles(state, reg) {
  return Object.values(state.tiles).filter(t => t.region === reg);
}

// ---- Helper: next region from the shuffled bag ----
function nextRegion(state) {
  if (!state.regionBag || !state.regionBag.length) {
    const r = shuffleWithRng(['N','S','E','W'], state.rng);
    state.regionBag = r.value;
    state.rng = r.rng;
  }
  return state.regionBag.pop();
}

// ---- Helper: weakest faction key ----
function weakestKey(state) {
  return livingKeys(state).sort((a,b) =>
    tilesOf(state, a).length - tilesOf(state, b).length
  )[0];
}

// ---- Helper: kill / eliminate a faction ----
function killFaction(state, fk, log) {
  if (fk === TYRANT_KEY) {
    const allies = livingKeys(state).filter(k => k !== TYRANT_KEY && hasPact(state, TYRANT_KEY, k));
    if (allies.length > 0 && !state.tyrantHarbor) {
      state.tyrantHarbor = state.round + 3;
      log.push('🦠 THE TYRANT is cornered — harbored by allies. Feed it a tile within 3 rounds or it dies.');
      return;
    }
  }
  state.factions[fk].eliminated = true;
  log.push(`💀 ${state.factions[fk].name} ELIMINATED!`);
}

// ---- Helper: form / break pacts ----
function formPact(state, a, b) {
  state.pacts[pairKey(a, b)] = state.round;
}

function breakPact(state, betrayer, victim, log) {
  delete state.pacts[pairKey(betrayer, victim)];
  state.grudges[victim + '>' + betrayer] = state.round + 2;
  log.push('🗡️ A non-aggression pact was broken!');
}

// ============================================================
// EVENT APPLICATION (pure — mutates the cloned state)
// ============================================================
const EVENT_HANDLERS = {
  powerFailure(state, reg, log, effects) {
    regionTiles(state, reg).forEach(t => {
      if (t.owner) { t.troops = Math.max(1, t.troops - 1); t.heldRounds = 0; effects.push({kind:'hit', tile:t.id}); }
    });
    log.push(`⚡ EVENT: POWER FAILURE — ${REGION_NAMES[reg]} loses 1 troop per tile & digs out`);
  },
  uprising(state, reg, log, effects) {
    let hit = 0;
    regionTiles(state, reg).forEach(t => {
      if (t.owner && t.troops >= 4) { t.troops -= 2; t.heldRounds = 0; hit++; effects.push({kind:'hit', tile:t.id}); }
    });
    log.push(`✊ EVENT: THE UPRISING — ${hit} large stack${hit===1?'':'s'} cut down in ${REGION_NAMES[reg]}`);
  },
  quake(state, reg, log, effects) {
    regionTiles(state, reg).forEach(t => {
      if (t.owner) { t.troops = Math.max(1, t.troops - (t.isNode ? 2 : 1)); t.heldRounds = 0; effects.push({kind:'hit', tile:t.id}); }
    });
    log.push(`🌋 EVENT: EARTHQUAKE — ${REGION_NAMES[reg]} shaken; Nodes hit hardest`);
  },
  riot(state, reg, log, effects) {
    const tiles = regionTiles(state, reg).filter(t => t.owner && !t.isNode);
    const w = weakestKey(state);
    if (!tiles.length || !w) { log.push(`🔥 EVENT: RIOT — ${REGION_NAMES[reg]} stays calm`); return; }
    const r = nextInt(state.rng, tiles.length);
    state.rng = r.rng;
    const target = tiles[r.value];
    const prev = target.owner;
    target.owner = w; target.heldRounds = 0;
    effects.push({kind:'hit', tile:target.id});
    if (prev !== w && tilesOf(state, prev).length === 0) killFaction(state, prev, log);
    log.push(`🔥 EVENT: RIOT — ${target.name} in ${REGION_NAMES[reg]} falls to ${state.factions[w].name}`);
  },
  siege(state, reg, log, effects) {
    let n = 0;
    regionTiles(state, reg).forEach(t => {
      if (t.heldRounds) { t.heldRounds = 0; n++; effects.push({kind:'hit', tile:t.id}); }
    });
    log.push(`⚔️ EVENT: SIEGE — entrenchment broken across ${REGION_NAMES[reg]} (${n} tile${n===1?'':'s'})`);
  },
  muster(state, reg, log, effects) {
    regionTiles(state, reg).forEach(t => {
      if (t.owner) { t.troops++; effects.push({kind:'hit', tile:t.id}); }
    });
    log.push(`🎖️ EVENT: MUSTER — +1 troop on every held tile in ${REGION_NAMES[reg]}`);
  },
  goldStrike(state, reg, log, _effects) {
    const tiles = regionTiles(state, reg);
    livingKeys(state).forEach(k => {
      const n = tiles.filter(t => t.owner === k).length;
      if (n) state.factions[k].resources = Math.min(state.factions[k].resources + n, RES_CAP);
    });
    log.push(`💰 EVENT: GOLD STRIKE — ${REGION_NAMES[reg]} pays +1 res per tile held there`);
  },
  crash(state, _reg, log, _effects) {
    livingKeys(state).forEach(k => {
      state.factions[k].resources = Math.floor(state.factions[k].resources / 2);
    });
    log.push('💸 EVENT: MARKET CRASH — every faction loses half its resources');
  },
  revolution(state, _reg, log, effects) {
    const alive = livingKeys(state);
    let leader = null, bestN = -1, bestT = -1;
    alive.forEach(k => {
      const n = countNodes(state, k), t = tilesOf(state, k).length;
      if (n > bestN || (n === bestN && t > bestT)) { bestN = n; bestT = t; leader = k; }
    });
    if (!leader || bestN <= 0) { log.push('🚩 EVENT: REVOLUTION — but no Node leader to topple'); return; }
    const their = nodesOf(state, leader);
    const r = nextInt(state.rng, their.length);
    state.rng = r.rng;
    const node = their[r.value];
    node.owner = null; node.troops = 0; node.heldRounds = 0;
    effects.push({kind:'hit', tile:node.id});
    log.push(`🚩 EVENT: REVOLUTION — ${state.factions[leader].name} loses ${node.name} to the mob`);
  },
  totalWar(state, _reg, log, effects) {
    state.totalWar = true;
    Object.values(state.tiles).forEach(t => {
      if (t.heldRounds) { t.heldRounds = 0; effects.push({kind:'hit', tile:t.id}); }
    });
    log.push('⚔️ EVENT: TOTAL WAR — entrenchment wiped, attackers strike +1 this round!');
  },
  insurgency(state, _reg, log, effects) {
    const w = weakestKey(state);
    if (!w) return;
    const f = state.factions[w];
    f.resources = Math.min(f.resources + 3, RES_CAP);
    const mine = tilesOf(state, w).sort((a,b) => b.troops - a.troops);
    if (mine.length) {
      for (let i = 0; i < 4; i++) {
        const t = mine[i % mine.length];
        t.troops++;
        effects.push({kind:'hit', tile:t.id});
      }
    }
    log.push(`✊ EVENT: INSURGENCY — ${f.name} gains +4 troops & +3 resources`);
  },
  // Choice event resolution (called after all choices collected)
  warlordTribute(state, _reg, log, _effects, fk, choiceIdx) {
    const f = state.factions[fk];
    if (choiceIdx === 0) {
      f.resources = Math.max(0, f.resources - 4);
    } else {
      tilesOf(state, fk).forEach(t => { if (t.troops > 1) t.troops--; });
    }
    log.push(`🃏 WARLORD'S TRIBUTE: ${f.name} chose option ${choiceIdx + 1}`);
  },
  mercenaryContract(state, _reg, log, _effects, fk, choiceIdx) {
    const f = state.factions[fk];
    if (choiceIdx === 0) {
      if (f.resources >= 5) {
        f.resources -= 5;
        const t = tilesOf(state, fk).sort((a,b) => b.troops - a.troops)[0];
        if (t) t.troops += 4;
      }
    } else {
      f.resources = Math.min(f.resources + 3, RES_CAP);
    }
    log.push(`🃏 MERCENARY CONTRACT: ${f.name} chose option ${choiceIdx + 1}`);
  },
};

// ============================================================
// COMBAT RESOLUTION (pure)
// ============================================================
function resolveCombat(state, attackerFk, srcId, tgtId, turnAttacks) {
  const src = state.tiles[srcId];
  const tgt = state.tiles[tgtId];
  const af  = state.factions[attackerFk];
  const df  = state.factions[tgt.owner];
  const log = [];
  const effects = [];

  // --- Base dice (2d6 bell curve) ---
  const attRoll = roll2d6(state.rng, af.trait === 'tactician');
  state.rng = attRoll.rng;
  const defRoll = roll2d6(state.rng, false);
  state.rng = defRoll.rng;
  const attDice = attRoll.sum;
  const defDice = defRoll.sum;

  // --- Modifiers ---
  const attForce = Math.min(2, Math.floor(src.troops / 4));
  const defForce = Math.min(2, Math.floor(tgt.troops / 4));
  const overextend = turnAttacks * 2;
  let entrench = Math.min(tgt.heldRounds || 0, tgt.isNode ? 2 : 3);
  if (af.ability === 'sabotage') entrench = 0;
  const lastStand = (df?.trait === 'last_stand' && tgt.troops <= 2) ? 3 : 0;
  const fortifyVal = df?.trait === 'fortify' ? (tgt.heldRounds > 0 ? 2 : 1) : 0;
  const comms = controlsNode(state, attackerFk, 'node_comms') ? 1 : 0;
  const data  = controlsNode(state, tgt.owner, 'node_data') ? 1 : 0;
  const coalition = coalitionAtkBonus(state, tgt.owner, attackerFk);
  const grudgeA = grudgeAtkBonus(state, attackerFk, tgt.owner);
  const grudgeD = grudgeDefBonus(state, attackerFk, tgt.owner);
  const war = state.totalWar ? 1 : 0;

  let attMods = attForce + comms + coalition + grudgeA + war;
  let defMods = defForce + entrench + lastStand + data + grudgeD + overextend;
  const modSwing = attMods - defMods;
  if (modSwing > 4)       attMods -= (modSwing - 4);
  else if (modSwing < -4) defMods -= (-4 - modSwing);

  const attTotal = attDice + attMods;
  const defTotal = defDice + defMods;
  const attWins = attTotal >= defTotal + fortifyVal;
  const captured = attWins && tgt.troops <= 1;

  // Combat effect for UI rendering
  effects.push({
    kind: 'combat', src: srcId, tgt: tgtId, won: attWins, captured,
    att: { dice: attRoll.dice, force: attForce, comms, coalition, grudge: grudgeA, war, total: attTotal },
    def: { dice: defRoll.dice, force: defForce, entrench, lastStand, fortify: fortifyVal, data, grudge: grudgeD, overextend, total: defTotal },
    attackerFk, defenderFk: tgt.owner,
  });

  if (attWins) {
    tgt.troops--;
    if (tgt.troops <= 0) {
      const prev = tgt.owner;
      tgt.owner = attackerFk;
      tgt.troops = 1;
      tgt.heldRounds = 0;
      src.troops = Math.max(1, src.troops - 1);
      // Scavenger loot (denied by last stand)
      const lootDenied = df?.trait === 'last_stand';
      if (af.trait === 'scavenger' && !lootDenied) {
        af.resources = Math.min((af.resources || 0) + 1, RES_CAP);
      }
      const lootMsg = af.trait === 'scavenger' ? (lootDenied ? ' 🚫 loot denied' : ' 💰+1 res') : '';
      log.push(`🏴 ${af.icon} CAPTURED ${tgt.name}! [${attTotal} vs ${defTotal}]${lootMsg}`);
      effects.push({kind:'capture', tile:tgtId, by:attackerFk, from:prev});
      const defLeft = Object.values(state.tiles).filter(t => t.owner === prev).length;
      if (defLeft === 0) {
        killFaction(state, prev, log);
        af.resources = Math.min((af.resources || 0) + 3, RES_CAP);
        log.push(`🏆 ${af.icon} eliminated ${state.factions[prev]?.name || prev}! +3 resources bounty.`);
      }
    } else {
      tgt.heldRounds = 0;
      log.push(`⚔️ ${af.icon} hit ${tgt.name} [${attTotal} vs ${defTotal}] — ${tgt.troops} left`);
    }
  } else {
    src.troops = Math.max(1, src.troops - 1);
    log.push(`🛡️ ${af.icon} → ${tgt.name} [${attTotal} vs ${defTotal}] — REPELLED`);
  }

  effects.push({kind:'refresh', tiles:[srcId, tgtId]});
  return { attWins, captured, log, effects };
}

// ============================================================
// WIN CHECK (pure — returns win info or null)
// ============================================================
function checkWinCondition(state, log) {
  if (!state.nodesHeldSince) state.nodesHeldSince = {};
  for (const [k, f] of Object.entries(state.factions)) {
    if (f.eliminated) { delete state.nodesHeldSince[k]; continue; }
    const n = countNodes(state, k);
    if (n >= 3 && !state.nodesHeldSince[k]) {
      state.nodesHeldSince[k] = state.round;
      log.push(`⚠️ ${f.name} controls ${n} Nodes! Must hold for 2 rounds to win.`);
    } else if (n < 3 && state.nodesHeldSince[k]) {
      delete state.nodesHeldSince[k];
      log.push(`📢 ${f.name} lost node dominance — hold timer reset.`);
    }
  }
  // Tyrant diplomacy win
  const tyrantAlive = state.tyrantOn && state.factions[TYRANT_KEY] && !state.factions[TYRANT_KEY].eliminated;
  if (tyrantAlive) {
    const others = livingKeys(state).filter(k => k !== TYRANT_KEY);
    if (others.length > 0 && others.every(k => hasPact(state, TYRANT_KEY, k))) {
      return { fk: TYRANT_KEY, condition: 'NO ENEMIES LEFT',
        detail: 'The Tyrant bought peace with every rival — and rules Nexus by default.', round: state.round };
    }
  }
  // Last standing
  const alive = Object.entries(state.factions).filter(([,f]) => !f.eliminated);
  if (alive.length === 1) {
    return { fk: alive[0][0], condition: 'LAST STANDING',
      detail: `${alive[0][1].name} eliminated all rivals.`, round: state.round };
  }
  return null;
}

// ============================================================
// INCOME (pure)
// ============================================================
function applyIncome(state, fk, log, effects) {
  const f = state.factions[fk];
  const nodes = countNodes(state, fk);
  let income = 2 + nodes * (f.trait === 'hoard' ? 2 : 1);
  if (controlsNode(state, fk, 'node_water')) income += 1;
  if (f.ability === 'bribe') income += 1;
  f.resources = Math.min(f.resources + income, RES_CAP);
  log.push(`${f.icon} ${f.name} earned +${income} res (${nodes} nodes)`);

  // Commune grassroots perk — Phase 5b: grows every OTHER round (odd only)
  if (f.ability === 'rally' && state.round % 2 === 1) {
    const mine = tilesOf(state, fk);
    if (mine.length) {
      const front = mine.filter(t =>
        Object.values(state.tiles).some(e => e.owner && e.owner !== fk && adjacent(t, e))
      );
      const grow = (front.length ? front : mine).sort((a,b) => a.troops - b.troops)[0];
      grow.troops++;
      effects.push({kind:'hit', tile:grow.id});
    }
  }
}

// ============================================================
// MAP BUILD (pure — uses seeded RNG)
// ============================================================
export function buildMap(state) {
  const tiles = {};
  const r0 = shuffleWithRng([...DISTRICT_NAMES], state.rng);
  state.rng = r0.rng;
  const districtNames = r0.value;
  let dn = 0;
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const id = `tile_${r}_${c}`;
      const name = districtNames[dn++ % districtNames.length];
      tiles[id] = { id, name, short: name.slice(0,6), isNode: false,
                    row: r, col: c, owner: null, troops: 0, heldRounds: 0 };
    }
  }
  for (const [nodeId, pos] of Object.entries(NODE_POSITIONS)) {
    const def = NODE_TILES.find(n => n.id === nodeId);
    const id = `tile_${pos.row}_${pos.col}`;
    tiles[id] = { ...def, id, nodeId, row: pos.row, col: pos.col, owner: null, troops: 0, heldRounds: 0 };
  }
  const r1 = shuffleWithRng([...START_CORNERS], state.rng);
  state.rng = r1.rng;
  const corners = r1.value;
  const normals = Object.keys(state.factions).filter(k => k !== TYRANT_KEY);
  normals.forEach((fk, i) => {
    const corner = corners[i];
    if (!corner) return;
    corner.tiles.forEach(pos => {
      const id = `tile_${pos.row}_${pos.col}`;
      if (tiles[id] && !tiles[id].isNode) {
        tiles[id].owner = fk;
        tiles[id].troops = 2;
      }
    });
  });
  const _MID = Math.floor((GRID_SIZE - 1) / 2);
  if (state.factions[TYRANT_KEY]) {
    const cId = `tile_${_MID}_${_MID}`;
    if (tiles[cId]) { tiles[cId].owner = TYRANT_KEY; tiles[cId].troops = 4; }
  }
  Object.values(tiles).forEach(t => { t.region = regionOf(t); });
  return tiles;
}

// ============================================================
// MAIN REDUCER
// ============================================================
export function reduce(inputState, action) {
  const state = clone(inputState);
  const log = [];
  const effects = [];

  switch (action.type) {

    // ---- BEGIN_TURN: apply income, reset actions ----
    case 'BEGIN_TURN': {
      const fk = action.faction;
      state.actionsUsed = 0;
      state.turnAttacks = 0;
      state.assaultCaptures = 0;
      state.assaultOn = false;
      state.renouncedThisTurn = {};  // Part 1: clear per-faction renounce guard
      applyIncome(state, fk, log, effects);
      break;
    }

    // ---- MOVE ----
    case 'MOVE': {
      const src = state.tiles[action.src];
      const dst = state.tiles[action.dst];
      const fk = state.turnOrder[state.currentTurnIdx];
      const moveN = Math.min(moveTroopCount(state, fk), src.troops - 1);
      src.troops -= moveN;
      if (src.troops <= 0) { src.owner = null; src.troops = 0; }
      dst.owner = fk;
      dst.troops += moveN;
      state.actionsUsed++;
      log.push(`${state.factions[fk].icon} moved ${moveN} troop${moveN>1?'s':''}: ${src.name} → ${dst.name}`);
      effects.push({kind:'refresh', tiles:[action.src, action.dst]});
      break;
    }

    // ---- ATTACK ----
    case 'ATTACK': {
      const fk = action.attackerFk || state.turnOrder[state.currentTurnIdx];
      if (!state.assaultOn) {
        state.actionsUsed++;
        state.assaultOn = true;
        state.assaultCaptures = 0;
      }
      const result = resolveCombat(state, fk, action.src, action.tgt, state.turnAttacks || 0);
      state.turnAttacks = (state.turnAttacks || 0) + 1;
      if (result.captured) state.assaultCaptures = (state.assaultCaptures || 0) + 1;
      log.push(...result.log);
      effects.push(...result.effects);

      // Check win after attack
      const win = checkWinCondition(state, log);
      if (win) {
        state.winner = win;
        effects.push({kind:'win', winner:win});
      }

      // Check if assault should end
      const src = state.tiles[action.src];
      if (!result.attWins || !src || src.troops < 2 || state.assaultCaptures >= 3) {
        state.assaultOn = false;
        state.assaultCaptures = 0;
      }
      break;
    }

    // ---- REINFORCE ----
    case 'REINFORCE': {
      const fk = state.turnOrder[state.currentTurnIdx];
      const f = state.factions[fk];
      const tile = state.tiles[action.tile];
      const cost = reinforceCost(state, fk);
      const amt = reinforceAmount(fk);
      f.resources -= cost;
      tile.troops += amt;
      state.actionsUsed++;
      // End any ongoing assault
      state.assaultOn = false;
      state.assaultCaptures = 0;
      log.push(`${f.icon} reinforced ${tile.name} (+${amt} troops)`);
      effects.push({kind:'refresh', tiles:[action.tile]});
      break;
    }

    // ---- AIRLIFT ----
    case 'AIRLIFT': {
      const fk = state.turnOrder[state.currentTurnIdx];
      const f = state.factions[fk];
      const src = state.tiles[action.src];
      const dst = state.tiles[action.dst];
      f.resources -= 3;
      src.troops -= 2;
      dst.troops += 2;
      state.actionsUsed++;
      state.assaultOn = false;
      state.assaultCaptures = 0;
      log.push(`✈️ ${f.icon} airlifted 2 troops: ${src.name} → ${dst.name}`);
      effects.push({kind:'refresh', tiles:[action.src, action.dst]});
      break;
    }

    // ---- ENTRENCH ----
    case 'ENTRENCH': {
      const fk = state.turnOrder[state.currentTurnIdx];
      const f = state.factions[fk];
      const tile = state.tiles[action.tile];
      const maxDig = tile.isNode ? 2 : 3;
      f.resources -= 2;
      tile.heldRounds = Math.min((tile.heldRounds || 0) + 1, maxDig);
      state.actionsUsed++;
      state.assaultOn = false;
      state.assaultCaptures = 0;
      log.push(`🏰 ${f.icon} entrenched ${tile.name} (dug in +${tile.heldRounds})`);
      effects.push({kind:'refresh', tiles:[action.tile]});
      break;
    }

    // ---- PACT ----
    case 'PACT': {
      formPact(state, action.from, action.to);
      log.push('🤝 A non-aggression pact was formed.');
      break;
    }

    // ---- RENOUNCE (Part 1): peaceful pact exit, no grudge ----
    case 'RENOUNCE': {
      const rFrom = action.from;
      const rTo   = action.target;
      if (hasPact(state, rFrom, rTo)) {
        delete state.pacts[pairKey(rFrom, rTo)];
        if (!state.renouncedThisTurn) state.renouncedThisTurn = {};
        state.renouncedThisTurn[rTo] = true;
        log.push('📜 A non-aggression pact was withdrawn.');
      }
      break;
    }

    // ---- ABILITY ----
    case 'ABILITY': {
      const fk = state.turnOrder[state.currentTurnIdx];
      const f = state.factions[fk];
      state.assaultOn = false;
      state.assaultCaptures = 0;

      switch (action.kind) {
        case 'sabotage': {
          const tile = state.tiles[action.target];
          f.resources -= 1;
          const sabPrev = tile.owner;
          const drop = 2;  // Phase 5b: sabotage removes 2 troops
          if (tile.troops > drop) { tile.troops -= drop; }
          else { tile.owner = null; tile.troops = 0; }
          if (tile.owner === null && tilesOf(state, sabPrev).length === 0) {
            killFaction(state, sabPrev, log);
          }
          state.actionsUsed++;
          log.push(`👁️ ${f.icon} sabotaged ${tile.name}`);
          effects.push({kind:'refresh', tiles:[action.target]});
          effects.push({kind:'flash', tile:action.target});
          const win = checkWinCondition(state, log);
          if (win) { state.winner = win; effects.push({kind:'win', winner:win}); }
          break;
        }
        case 'bribe': {
          const tile = state.tiles[action.target];
          f.resources -= 1;
          const bribedPrev = tile.owner;
          tile.troops--;
          if (tile.troops <= 0) {
            tile.owner = fk; tile.troops = 1;
            if (tilesOf(state, bribedPrev).length === 0) killFaction(state, bribedPrev, log);
          }
          state.actionsUsed++;
          log.push(`💰 ${f.icon} bribed ${tile.name}!`);
          effects.push({kind:'refresh', tiles:[action.target]});
          const win = checkWinCondition(state, log);
          if (win) { state.winner = win; effects.push({kind:'win', winner:win}); }
          break;
        }
        case 'rally': {
          const tile = state.tiles[action.target];
          f.resources -= 1;
          tile.troops++;
          const adj = Object.values(state.tiles).filter(t => t.owner === fk && adjacent(t, tile));
          adj.forEach(t => { t.troops++; effects.push({kind:'refresh', tiles:[t.id]}); });
          state.actionsUsed++;
          log.push(`🌿 ${f.icon} Rally! +1 to ${tile.name} + ${adj.length} adjacent tiles`);
          effects.push({kind:'refresh', tiles:[action.target]});
          break;
        }
        case 'overclock': {
          const tile = state.tiles[action.target];
          f.resources -= 1;
          tile.troops += 3;
          state.actionsUsed++;
          log.push(`⚙️ ${f.icon} Overclock! +3 troops on ${tile.name}`);
          effects.push({kind:'refresh', tiles:[action.target]});
          break;
        }
      }
      break;
    }

    // ---- AI_RETREAT: consolidate thin stack into adjacent friendly tile ----
    case 'AI_RETREAT': {
      const fk = state.turnOrder[state.currentTurnIdx];
      const victim = state.tiles[action.src];
      const safe = state.tiles[action.dst];
      safe.troops += victim.troops;
      victim.troops = 0;
      victim.owner = null;
      victim.heldRounds = 0;
      log.push(`🏃 ${state.factions[fk].icon} ${state.factions[fk].name} retreated from ${victim.name}`);
      effects.push({kind:'refresh', tiles:[action.src, action.dst]});
      break;
    }

    // ---- TYRANT_SPREAD: metastasize into adjacent empty tiles ----
    case 'TYRANT_SPREAD': {
      const fk = TYRANT_KEY;
      const tiles = Object.values(state.tiles);
      const seeds = tiles.filter(t => t.owner === fk && t.troops >= 2);
      let spread = 0;
      for (const s of seeds) {
        if (spread >= 4) break;
        const empty = tiles.find(t => !t.owner && adjacent(s, t));
        if (empty) {
          s.troops--;
          empty.owner = fk;
          empty.troops = 1;
          empty.heldRounds = 0;
          effects.push({kind:'refresh', tiles:[s.id, empty.id]});
          spread++;
        }
      }
      if (spread) log.push(`🦠 THE TYRANT spreads into ${spread} new tile${spread>1?'s':''}`);
      break;
    }

    // ---- END_TURN ----
    case 'END_TURN': {
      state.assaultOn = false;
      state.assaultCaptures = 0;
      state.turnAttacks = 0;
      state.currentTurnIdx++;
      effects.push({kind:'turnEnd'});
      break;
    }

    // ---- APPLY_EVENT: draw and apply a round event ----
    case 'APPLY_EVENT': {
      const r = nextInt(state.rng, EVENT_DEFS.length);
      state.rng = r.rng;
      const evIdx = r.value;
      const ev = EVENT_DEFS[evIdx];
      const reg = ev.region ? nextRegion(state) : null;
      state.eventRegion = reg;
      state.eventCard = { type: ev.type, title: ev.title, body: ev.body, reg, evIdx,
                          n: (state.eventN = (state.eventN || 0) + 1) };

      if (ev.type !== 'CHOICE') {
        const handler = EVENT_HANDLERS[ev.key];
        if (handler) handler(state, reg, log, effects);
      }
      // For CHOICE events, the shell handles UI; resolution comes via CHOICE actions
      effects.push({kind:'event', event: state.eventCard, isChoice: ev.type === 'CHOICE'});
      break;
    }

    // ---- CHOICE: resolve a faction's choice for a choice event ----
    case 'CHOICE': {
      const ev = EVENT_DEFS.find(e => e.key === action.eventKey);
      if (ev) {
        const handler = EVENT_HANDLERS[ev.key];
        if (handler) handler(state, state.eventRegion, log, effects, action.faction, action.choiceIdx);
      }
      break;
    }

    // ---- START_ROUND: entrenchment tick, pact upkeep, tyrant harbor ----
    case 'START_ROUND': {
      state.currentTurnIdx = 0;
      state.signalJam = false;
      state.totalWar = false;
      // Entrenchment tick
      Object.values(state.tiles).forEach(t => {
        if (t.owner && t.troops >= 2) t.heldRounds = Math.min((t.heldRounds||0) + 1, t.isNode ? 2 : 3);
        else t.heldRounds = 0;
      });
      // Pact upkeep
      for (const k of Object.keys(state.pacts)) {
        const [a,b] = k.split('|');
        if (a === TYRANT_KEY || b === TYRANT_KEY) continue;
        if (state.round - state.pacts[k] >= 4) {
          delete state.pacts[k];
          log.push('📜 A non-aggression pact has lapsed');
        }
      }
      for (const k of Object.keys(state.grudges)) {
        if (state.grudges[k] < state.round) delete state.grudges[k];
      }
      // Tyrant harbor
      if (state.tyrantHarbor && state.tyrantOn && state.factions[TYRANT_KEY]) {
        if (tilesOf(state, TYRANT_KEY).length > 0) {
          state.tyrantHarbor = 0;
        } else if (state.round > state.tyrantHarbor) {
          state.factions[TYRANT_KEY].eliminated = true;
          state.tyrantHarbor = 0;
          log.push('💀 THE TYRANT perished — no ally harbored it in time.');
        }
      }
      // Part 2: corruption tick — each Tyrant ally gains +1 corruption per round
      if (state.tyrantOn && state.factions[TYRANT_KEY] && !state.factions[TYRANT_KEY].eliminated) {
        for (const k of livingKeys(state)) {
          if (k === TYRANT_KEY) continue;
          if (hasPact(state, TYRANT_KEY, k)) {
            state.factions[k].corruption = (state.factions[k].corruption || 0) + 1;
          }
        }
      }
      effects.push({kind:'roundStart', round:state.round});
      break;
    }

    // ---- END_ROUND: check node dominance win, advance round ----
    case 'END_ROUND': {
      // Node dominance win
      if (state.nodesHeldSince) {
        for (const [k, since] of Object.entries(state.nodesHeldSince)) {
          const f = state.factions[k];
          if (f && !f.eliminated && countNodes(state, k) >= 3 && state.round - since >= 1) {
            const win = { fk: k, condition: 'NODE DOMINANCE',
              detail: `${f.name} held 3+ Core Nodes for 2 rounds and commands Nexus.`, round: state.round };
            state.winner = win;
            effects.push({kind:'win', winner:win});
            return { state, effects, log };
          }
        }
      }
      state.round++;
      if (state.round > ROUND_CAP) {
        let best = null, bestN = -1;
        for (const [k,f] of Object.entries(state.factions)) {
          if (f.eliminated) continue;
          const n = Object.values(state.tiles).filter(t => t.owner === k && t.isNode).length;
          if (n > bestN) { bestN = n; best = k; }
        }
        const win = { fk: best, condition: 'TIMED OUT',
          detail: `After ${ROUND_CAP} rounds, ${state.factions[best].name} held the most Nodes.`, round: state.round };
        state.winner = win;
        effects.push({kind:'win', winner:win});
      }
      break;
    }

    // ---- BREAK_PACT ----
    case 'BREAK_PACT': {
      breakPact(state, action.betrayer, action.victim, log);
      break;
    }

    default:
      log.push(`⚠️ Unknown action: ${action.type}`);
  }

  return { state, effects, log };
}

// Re-export win check for use by the shell/AI
export { checkWinCondition, resolveCombat, applyIncome, EVENT_HANDLERS };
