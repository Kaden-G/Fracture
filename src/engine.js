// ============================================================
// engine.js — Pure game state reducer
// reduce(state, action) -> { state, effects, log }
// No DOM, no timers, no network, no Math.random.
// All randomness flows through rng.js via state.rng.
// ============================================================

import {
  RES_CAP, TROOP_CAP, GRID_SIZE, ROUND_CAP, THRALLDOM_CAP, MOON_BAND,
  FACTIONS, TYRANT_KEY, TYRANT_DEF,
  TRAITS, EVENT_DEFS, NODE_TILES, NODE_POSITIONS, START_CORNERS,
  DISTRICT_NAMES, REGION_NAMES,
  factionDef, regionOf, adjacent,
  tilesOf, nodesOf, countNodes, controlsNode, livingKeys,
  hasPact, pairKey, hasTrait,
  reinforceCost, reinforceAmount, moveTroopCount, moveRange, moveReachable, airliftCost,
  grudgeAtkBonus, grudgeDefBonus, coalitionAtkBonus, mkFaction,
} from './state.js';

import { roll2d6, nextInt, nextFloat, shuffleWithRng } from './rng.js';

// ---- Deep clone (JSON round-trip — state is JSON-serializable) ----
function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

// ============================================================
// COALITION SURGE (Step 3) — HUMAN-ONLY counterplay vs the Tyrant.
// A reward for the honest table uniting to burn the blob out. It NEVER fires
// in all-AI sims (gated on 2+ humans) and so is calibrated by play, not the
// harness. Magnitude is the two tunables below — tune these, not the rhythm.
// ============================================================
const COALITION_PER_FACTION = 1;  // attack-vs-Tyrant bonus per coalition member beyond the first (TUNE BY PLAY)
const COALITION_MAX         = 4;  // safety cap on the surge

// A faction is "coalition-hostile" if it drew blood on the Tyrant this round or
// last round (a one-round memory = sustained pressure). Tyrant allies excluded.
function coalitionHostile(state, k) {
  return k !== TYRANT_KEY && !hasPact(state, TYRANT_KEY, k)
      && state.tyrantStruck && state.tyrantStruck[k] >= state.round - 1;
}
function coalitionSize(state) {
  return livingKeys(state).filter(k => coalitionHostile(state, k)).length;
}
// Attack-roll bonus for `attackerFk` striking a tile owned by `defOwner`.
// Only vs the Tyrant, only in 2+ human games, only for a True-Pact faction
// that earned it (drew blood within the window). Scales with coalition size:
// size 1 → 0 (a lone poke is negligible), then +PER_FACTION per extra member.
function tyrantSurgeBonus(state, attackerFk, defOwner) {
  if (!state.tyrantOn || defOwner !== TYRANT_KEY) return 0;
  if ((state.humans ? state.humans.length : 0) < 2) return 0;   // HUMAN-ONLY
  if (!coalitionHostile(state, attackerFk)) return 0;           // must have earned it; allies excluded
  const size = coalitionSize(state);
  return Math.min(COALITION_MAX, Math.max(0, (size - 1) * COALITION_PER_FACTION));
}
// Record that a True-Pact faction drew blood on the Tyrant (earns surge next turn).
function recordTyrantStrike(state, attackerFk, defOwner) {
  if (!state.tyrantOn || defOwner !== TYRANT_KEY) return;
  if (attackerFk === TYRANT_KEY || hasPact(state, TYRANT_KEY, attackerFk)) return;  // allies don't contribute
  if (!state.tyrantStruck) state.tyrantStruck = {};
  state.tyrantStruck[attackerFk] = state.round;
}

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
// Never resolves to the Tyrant — it has its own rise/fall mechanics (a harbored
// Tyrant must be revived by an ALLY, not by a stray Riot or Insurgency).
function weakestKey(state) {
  return livingKeys(state).filter(k => k !== TYRANT_KEY).sort((a,b) =>
    tilesOf(state, a).length - tilesOf(state, b).length
  )[0];
}

// ---- Helper: Tyrant concurrent-pact cap ----
// Single-human games: the Tyrant may hold at most 3 pacts at once, so it can never
// buy a diplomacy-only win by aligning with all 4 rivals when only one is human.
export function tyrantPactCap(state) {
  return (state.humans && state.humans.length === 1) ? 3 : Infinity;
}
export function tyrantAtPactCap(state) {
  const allies = livingKeys(state).filter(k => k !== TYRANT_KEY && hasPact(state, TYRANT_KEY, k));
  return allies.length >= tyrantPactCap(state);
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
    // Tyrant eliminated — purge corruption for the eliminator, track it
    if (state.tyrantOn) {
      const eliminator = state.turnOrder[state.currentTurnIdx];
      if (eliminator && state.factions[eliminator]) {
        state.factions[eliminator].corruption = 0;
        log.push(`💀 ${state.factions[eliminator].name} purged the Tyrant!`);
      }
      state.tyrantEliminations = (state.tyrantEliminations || 0) + 1;
    }
  }
  state.factions[fk].eliminated = true;
  // Death voids diplomacy: clear the fallen faction's pacts so stale entries never
  // count toward anything (e.g. the Tyrant's pact tally). Grudges expire on their own.
  for (const pk of Object.keys(state.pacts || {})) {
    const [a, b] = pk.split('|');
    if (a === fk || b === fk) delete state.pacts[pk];
  }
  log.push(`💀 ${state.factions[fk].name} ELIMINATED!`);
}

// Bounty for wiping out a rival: +3 resources, half the victim's stash, and inherit their
// chosen passive trait (stacks). Applies no matter HOW the kill landed — combat, sabotage, or
// bribe. Call AFTER killFaction: no-ops unless the victim is actually eliminated (a harbored
// Tyrant grants nothing until it truly dies).
function awardEliminationBounty(state, killerFk, victimFk, log) {
  const af = state.factions[killerFk];
  const victim = state.factions[victimFk];
  if (!af || !victim || killerFk === victimFk || !victim.eliminated) return;
  const lootRes = Math.floor((victim.resources || 0) / 2);
  af.resources = Math.min((af.resources || 0) + 3 + lootRes, RES_CAP);
  const victimTrait = victim.trait;
  if (victimTrait && victimTrait !== af.trait) {
    if (!af.inheritedTraits) af.inheritedTraits = [];
    if (!af.inheritedTraits.includes(victimTrait)) af.inheritedTraits.push(victimTrait);
  }
  const traitName = victimTrait ? TRAITS.find(t => t.id === victimTrait)?.name : null;
  log.push(`🏆 ${af.icon} eliminated ${victim.name || victimFk}! +${3 + lootRes} resources${traitName ? `, inherited ${traitName}` : ''}.`);
}

// Reckoning duel (engine) — best-of-3 dice, Tyrant wins ties, fallen vote, host-skim
// Host-skim: corruption eats the conspirator's army going into the duel.
// Moon band: corruption in [CAP-MOON_BAND .. CAP-1] gives conspirator a jackpot spike.
function runReckoningEngine(state, conspirator) {
  const corr = state.factions[conspirator].corruption || 0;
  const moonLow = THRALLDOM_CAP - MOON_BAND;
  const inMoon = corr >= moonLow && corr < THRALLDOM_CAP;

  // Host-skim: corruption skims conspirator tiles for the duel
  // skim = floor(corr/2) capped at their tile count minus 1
  const rawTiles = tilesOf(state, conspirator).length;
  const skim = inMoon ? 0 : Math.min(Math.floor(corr / 2), Math.max(0, rawTiles - 1));
  const cTiles = Math.max(1, rawTiles - skim);
  const tTiles = Math.max(1, tilesOf(state, TYRANT_KEY).length);

  // Tyrant essence: base 3 + tiles + corruption influence
  const tEssence = tTiles + 3 + (inMoon ? 0 : Math.floor(corr / 3));
  // Conspirator essence: tiles (after skim) + moon bonus
  const cEssence = cTiles + (inMoon ? 5 : 0);

  // Fallen vote
  let fallenForTyrant = 0, fallenForCon = 0;
  for (const [k, f] of Object.entries(state.factions)) {
    if (!f.eliminated || k === TYRANT_KEY) continue;
    const grudgeKey = k + '>' + conspirator;
    if (state.grudges[grudgeKey]) fallenForTyrant++;
    else fallenForCon++;
  }

  let tWins = 0, cWins = 0;
  for (let r = 0; r < 3 && tWins < 2 && cWins < 2; r++) {
    let tRoll, cRoll;
    if (state.rng) {
      let ri = roll2d6(state.rng); state.rng = ri.rng; tRoll = ri.sum + tEssence + fallenForTyrant;
      ri = roll2d6(state.rng); state.rng = ri.rng; cRoll = ri.sum + cEssence + fallenForCon;
    } else {
      tRoll = Math.floor(Math.random()*6)+1 + Math.floor(Math.random()*6)+1 + tEssence + fallenForTyrant;
      cRoll = Math.floor(Math.random()*6)+1 + Math.floor(Math.random()*6)+1 + cEssence + fallenForCon;
    }
    if (tRoll > cRoll) tWins++; else cWins++;   // ties go to the conspirator
  }
  return tWins >= 2;
}

// Reckoning intercept — called when a faction would win.
// Returns: win object (conspirator won duel), null (Tyrant won duel), or false (no Reckoning needed).
function maybeReckoning(state, fk, log) {
  if (!state.tyrantOn) return false;
  if (!state.factions[TYRANT_KEY] || state.factions[TYRANT_KEY].eliminated) return false;
  if (fk === TYRANT_KEY) return false;
  const corr = state.factions[fk].corruption || 0;
  if (corr <= 0) return false;

  if (!state.reckonings) state.reckonings = [];
  const moonLow = THRALLDOM_CAP - MOON_BAND;
  const tier = corr >= THRALLDOM_CAP ? 'thralldom'
             : corr >= moonLow       ? 'moon'
             : corr <= 2             ? 'low'
             : corr <= 5             ? 'mid'
             :                         'deep';

  // Thralldom cap — auto-loss, no duel needed
  if (corr >= THRALLDOM_CAP) {
    log.push(`🦠 THRALLDOM! ${state.factions[fk].name} is consumed — corruption reached the cap!`);
    state.reckonings.push({ fk, corruption: corr, tier, tyrantWins: true });
    const win = { fk: TYRANT_KEY, condition: 'RECKONING (THRALLDOM)',
      detail: `${state.factions[fk].name} was consumed by corruption — the Tyrant wins through its thrall.`, round: state.round };
    state.winner = win;
    return null;
  }

  log.push(`⚔️ RECKONING triggered! ${state.factions[fk].name} (corruption ${corr}) must face the Tyrant!`);
  const tyrantWins = runReckoningEngine(state, fk);
  state.reckonings.push({ fk, corruption: corr, tier, tyrantWins });

  if (tyrantWins) {
    log.push(`🦠 The Tyrant prevails — ${state.factions[fk].name} falls to thralldom!`);
    const win = { fk: TYRANT_KEY, condition: 'RECKONING (THRALLDOM)',
      detail: `${state.factions[fk].name} was about to win but lost the Reckoning — the Tyrant consumes Nexus.`, round: state.round };
    state.winner = win;
    return null;
  } else {
    state.factions[fk].corruption = 0;
    log.push(`💀 ${state.factions[fk].name} vanquished the Tyrant in the Reckoning!`);
    const f = state.factions[fk];
    return { fk, condition: 'RECKONING (FREEDOM)',
      detail: `${f.name} fought off the Tyrant and claimed Nexus!`, round: state.round };
  }
}

// ---- Helper: form / break pacts ----
function formPact(state, a, b) {
  state.pacts[pairKey(a, b)] = state.round;
}

function breakPact(state, betrayer, victim, log) {
  delete state.pacts[pairKey(betrayer, victim)];
  state.grudges[victim + '>' + betrayer] = state.round + 2;
  // Part 2: clear boon if a Tyrant pact is broken
  if (betrayer === TYRANT_KEY && state.factions[victim]) state.factions[victim].boon = null;
  if (victim === TYRANT_KEY && state.factions[betrayer]) state.factions[betrayer].boon = null;
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
    if (prev !== w && tilesOf(state, prev).length === 0) {
      killFaction(state, prev, log);
      awardEliminationBounty(state, w, prev, log);
    }
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
function resolveCombat(state, attackerFk, srcId, tgtId, priorStrikes) {
  const src = state.tiles[srcId];
  const tgt = state.tiles[tgtId];
  const af  = state.factions[attackerFk];
  const df  = state.factions[tgt.owner];
  const log = [];
  const effects = [];

  // --- Base dice (2d6 bell curve) ---
  const attRoll = roll2d6(state.rng, hasTrait(af, 'tactician'));
  state.rng = attRoll.rng;
  const defRoll = roll2d6(state.rng, false);
  state.rng = defRoll.rng;
  const attDice = attRoll.sum;
  const defDice = defRoll.sum;

  // --- Modifiers ---
  const attForce = Math.min(2, Math.floor(src.troops / 4));
  const defForce = Math.min(2, Math.floor(tgt.troops / 4));
  // Rally: +2 per prior strike by THIS attacker on THIS victim this turn — but the Tyrant
  // never rallies (it's the shared enemy; the coalition can grind it down without the brake).
  const overextend = tgt.owner === TYRANT_KEY ? 0 : priorStrikes * 2;
  let entrench = Math.min(tgt.heldRounds || 0, tgt.isNode ? 2 : 3);
  if (af.ability === 'sabotage') entrench = 0;
  const lastStand = (df && hasTrait(df, 'last_stand') && tgt.troops <= 2) ? 3 : 0;
  const fortifyVal = (df && hasTrait(df, 'fortify')) ? (tgt.heldRounds > 0 ? 2 : 1) : 0;
  const comms = controlsNode(state, attackerFk, 'node_comms') ? 1 : 0;
  const data  = controlsNode(state, tgt.owner, 'node_data') ? 1 : 0;
  const coalition = coalitionAtkBonus(state, tgt.owner, attackerFk);
  const grudgeA = grudgeAtkBonus(state, attackerFk, tgt.owner);
  const grudgeD = grudgeDefBonus(state, attackerFk, tgt.owner);
  const war = state.totalWar ? 1 : 0;
  // Step 3: coalition surge — human-only attack bonus vs the Tyrant (0 otherwise).
  const surge = tyrantSurgeBonus(state, attackerFk, tgt.owner);

  let attMods = attForce + comms + coalition + grudgeA + war + surge;
  let defMods = defForce + entrench + lastStand + data + grudgeD + overextend;
  const modSwing = attMods - defMods;
  if (modSwing > 4)       attMods -= (modSwing - 4);
  else if (modSwing < -4) defMods -= (-4 - modSwing);

  const attTotal = attDice + attMods;
  const defTotal = defDice + defMods;
  const attWins = attTotal >= defTotal + fortifyVal;
  const captured = attWins && tgt.troops <= 1;

  // Step 3: record the strike (earns surge next turn) — defender is still the Tyrant here.
  recordTyrantStrike(state, attackerFk, tgt.owner);

  // Combat effect for UI rendering
  effects.push({
    kind: 'combat', src: srcId, tgt: tgtId, won: attWins, captured,
    att: { dice: attRoll.dice, force: attForce, comms, coalition, grudge: grudgeA, war, surge, total: attTotal },
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
      const lootDenied = df && hasTrait(df, 'last_stand');
      if (hasTrait(af, 'scavenger') && !lootDenied) {
        af.resources = Math.min((af.resources || 0) + 1, RES_CAP);
      }
      const lootMsg = hasTrait(af, 'scavenger') ? (lootDenied ? ' 🚫 loot denied' : ' 💰+1 res') : '';
      log.push(`🏴 ${af.icon} CAPTURED ${tgt.name}! [${attTotal} vs ${defTotal}]${lootMsg}`);
      effects.push({kind:'capture', tile:tgtId, by:attackerFk, from:prev});
      const defLeft = Object.values(state.tiles).filter(t => t.owner === prev).length;
      if (defLeft === 0) {
        killFaction(state, prev, log);
        awardEliminationBounty(state, attackerFk, prev, log);
        // GRAVEYARD: when the Tyrant dies in combat, the killing tile becomes a 6th node —
        // counts toward the "3 to win" condition for whoever holds it. No perk.
        if (prev === TYRANT_KEY && state.factions[TYRANT_KEY].eliminated && !tgt.isNode) {
          tgt.isNode = true;
          tgt.nodeId = 'node_graveyard';
          tgt.name = '☠ GRAVEYARD';
          tgt.short = '☠GRV';
          log.push(`☠ GRAVEYARD rises where the Tyrant fell — a bounty node for ${af.icon}.`);
        }
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
      log.push(`⚠️ ${f.name} controls ${n} Nodes! Must hold for 3 rounds to win.`);
    } else if (n < 3 && state.nodesHeldSince[k]) {
      delete state.nodesHeldSince[k];
      log.push(`📢 ${f.name} lost node dominance — hold timer reset.`);
    }
  }
  // Tyrant diplomacy win ("ally default") — the Tyrant rules when every surviving
  // rival is bound to it. NEVER allowed in a single-human game: the lone human must
  // always keep a path to the Reckoning, so the Tyrant can't win by ally-default even
  // after eliminations shrink the field to its allies. (All-AI sims & 2+ human games
  // keep it as a legitimate outcome.)
  const tyrantAlive = state.tyrantOn && state.factions[TYRANT_KEY] && !state.factions[TYRANT_KEY].eliminated;
  const soloHuman = (state.humans ? state.humans.length : 0) === 1;
  if (tyrantAlive && !soloHuman) {
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
  let income = 2 + nodes * (hasTrait(f, 'hoard') ? 2 : 1);
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
        tiles[id].troops = 3;
      }
    });
  });
  const _MID = Math.floor((GRID_SIZE - 1) / 2);
  if (state.factions[TYRANT_KEY]) {
    const cId = `tile_${_MID}_${_MID}`;
    // 8-troop garrison: protects against the Ghost round-1 sabotage assassination
    // (sabotage is -2; two hits would wipe a 4-troop start before the Tyrant's first turn).
    if (tiles[cId]) { tiles[cId].owner = TYRANT_KEY; tiles[cId].troops = 8; }
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
      state.turnAttacks = 0; state.turnStrikes = {};
      state.assaultCaptures = 0;
      state.assaultOn = false;
      state.renouncedThisTurn = {};  // Part 1: clear per-faction renounce guard
      state.siphonedThisTurn = false;  // Ghost sabotage: one siphon gain per turn
      applyIncome(state, fk, log, effects);
      break;
    }

    // ---- MOVE ----
    case 'MOVE': {
      const src = state.tiles[action.src];
      const dst = state.tiles[action.dst];
      const fk = state.turnOrder[state.currentTurnIdx];
      // Carry up to stack−1 (chosen via action.count); without a count, fall back to
      // the legacy default (1 troop, or 2 with the TRANSIT node).
      const want = (typeof action.count === 'number') ? action.count : moveTroopCount(state, fk);
      const moveN = Math.max(1, Math.min(want, src.troops - 1));
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
      // Rally is per-encounter: it only escalates when the SAME attacking tile strikes the
      // SAME defending tile again this turn. Different attackers ganging one tile, or one
      // attacker spreading across tiles, each fight fresh — only grinding one tile-vs-tile
      // matchup rallies the defender (+2 per prior strike on that exact pairing).
      if (!state.turnStrikes) state.turnStrikes = {};
      const rallyKey = action.src + '|' + action.tgt;
      const prior = state.turnStrikes[rallyKey] || 0;
      const result = resolveCombat(state, fk, action.src, action.tgt, prior);
      state.turnStrikes[rallyKey] = prior + 1;
      state.turnAttacks = (state.turnAttacks || 0) + 1;
      if (result.captured) state.assaultCaptures = (state.assaultCaptures || 0) + 1;
      log.push(...result.log);
      effects.push(...result.effects);

      // On a capture, advance a chosen number of extra troops (up to stack−1) into the
      // captured tile in the SAME action — no second Reinforce needed. Committing hard
      // empties the source (which also ends any assault chain from it): that tradeoff,
      // plus the unchanged rally escalation, is the anti-doom-stack brake.
      if (result.captured && typeof action.advance === 'number' && action.advance > 0) {
        const aSrc = state.tiles[action.src];
        const aTgt = state.tiles[action.tgt];
        if (aSrc && aTgt && aTgt.owner === fk && aSrc.owner === fk) {
          const adv = Math.min(action.advance, aSrc.troops - 1);
          if (adv > 0) {
            aSrc.troops -= adv;
            aTgt.troops += adv;
            log.push(`${state.factions[fk].icon} advanced ${adv} troop${adv>1?'s':''} into ${aTgt.name}`);
            effects.push({kind:'refresh', tiles:[action.src, action.tgt]});
          }
        }
      }

      // Check win after attack
      const win = checkWinCondition(state, log);
      if (win) {
        const rWin = maybeReckoning(state, win.fk, log);
        if (rWin) { state.winner = rWin; effects.push({kind:'win', winner:rWin}); }
        else if (rWin === null) { effects.push({kind:'win', winner:state.winner}); }
        else { state.winner = win; effects.push({kind:'win', winner:win}); }
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
      // Up to 3 troops, always leaving a garrison of 1 behind. Default to the max.
      const n = Math.max(1, Math.min(3, action.count ?? 3, src.troops - 1));
      f.resources -= airliftCost(state, fk);   // 0 while holding 🚇 TRANSIT
      src.troops -= n;
      dst.troops += n;
      state.actionsUsed++;
      state.assaultOn = false;
      state.assaultCaptures = 0;
      log.push(`✈️ ${f.icon} airlifted ${n} troop${n > 1 ? 's' : ''}: ${src.name} → ${dst.name}`);
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

    // ---- RENOUNCE: peaceful pact exit (non-Tyrant) or renounce-kill (Tyrant) ----
    case 'RENOUNCE': {
      const rFrom = action.from;
      const rTo   = action.target;
      if (!hasPact(state, rFrom, rTo)) break;
      delete state.pacts[pairKey(rFrom, rTo)];
      if (!state.renouncedThisTurn) state.renouncedThisTurn = {};
      state.renouncedThisTurn[rTo] = true;

      // Non-Tyrant renounce: simple exit
      if (rTo !== TYRANT_KEY && rFrom !== TYRANT_KEY) {
        log.push('📜 A non-aggression pact was withdrawn.');
        break;
      }

      // Renounce-kill: renouncing a Tyrant pact
      const renouncer = rFrom === TYRANT_KEY ? rTo : rFrom;
      state.factions[renouncer].boon = null;

      // 1. Withdrawal hit: renouncer's weakest two tiles lose half their troops
      const rTiles = tilesOf(state, renouncer).sort((a, b) => a.troops - b.troops);
      for (let i = 0; i < Math.min(2, rTiles.length); i++) {
        const lost = Math.max(1, Math.floor(rTiles[i].troops / 2));
        rTiles[i].troops = Math.max(1, rTiles[i].troops - lost);
        effects.push({kind:'refresh', tiles:[rTiles[i].id]});
      }
      log.push(`🦠💥 The Tyrant lashes out at ${state.factions[renouncer].name} — withdrawal hit!`);

      // 2. Tyrant dies — all its tiles go neutral
      const tyrantTiles = tilesOf(state, TYRANT_KEY);
      for (const t of tyrantTiles) { t.owner = null; t.troops = 0; t.heldRounds = 0; effects.push({kind:'refresh', tiles:[t.id]}); }
      state.factions[TYRANT_KEY].eliminated = true;
      state.tyrantEliminations = (state.tyrantEliminations || 0) + 1;
      // Break all remaining Tyrant pacts
      for (const pk of Object.keys(state.pacts || {})) {
        const [pa, pb] = pk.split('|');
        if (pa === TYRANT_KEY || pb === TYRANT_KEY) {
          const ally = pa === TYRANT_KEY ? pb : pa;
          if (state.factions[ally]) { state.factions[ally].boon = null; }
          delete state.pacts[pk];
        }
      }
      log.push('💀 THE TYRANT is destroyed — its domain collapses to nothing!');

      // 3. Resurrect eliminated factions on their former ground with grudge against renouncer
      if (!state.renounceKills) state.renounceKills = 0;
      state.renounceKills++;
      for (const [ek, ef] of Object.entries(state.factions)) {
        if (!ef.eliminated || ek === TYRANT_KEY || ek === renouncer) continue;
        // Find up to 2 neutral tiles to resurrect on (prefer tiles near board edges)
        const neutrals = Object.values(state.tiles).filter(t => !t.owner);
        if (neutrals.length === 0) continue;
        ef.eliminated = false;
        ef.corruption = 0;
        ef.resources = 3;
        const count = Math.min(2, neutrals.length);
        for (let i = 0; i < count; i++) {
          neutrals[i].owner = ek; neutrals[i].troops = 2; neutrals[i].heldRounds = 0;
          effects.push({kind:'refresh', tiles:[neutrals[i].id]});
        }
        // Grudge against the renouncer (they caused the turmoil)
        state.grudges[ek + '>' + renouncer] = state.round + 3;
        log.push(`👻 ${ef.name} rises from the ashes — and bears a grudge against ${state.factions[renouncer].name}!`);
      }

      // Clear renouncer's corruption (they've paid the price)
      state.factions[renouncer].corruption = 0;
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
          recordTyrantStrike(state, fk, sabPrev);   // Step 3: sabotaging the blob earns surge next turn
          const sabPreTroops = tile.troops;  // before the hit (siphon only from a surviving tile)
          const drop = (tile.heldRounds || 0) >= 2 ? 1 : 2;
          if (tile.troops > drop) { tile.troops -= drop; }
          else { tile.owner = null; tile.troops = 0; }
          if (tile.owner === null && tilesOf(state, sabPrev).length === 0) {
            killFaction(state, sabPrev, log);
            awardEliminationBounty(state, fk, sabPrev, log);
          }
          // Siphon: +2 to saboteur's weakest frontline tile — only if the target survived the −2
          // (had 3+) and only once per turn (cap +2/turn, never +6).
          if (sabPreTroops > drop && !state.siphonedThisTurn) {
            const mine = tilesOf(state, fk);
            if (mine.length) {
              const frontline = mine.filter(mt => Object.values(state.tiles).some(t => t.owner && t.owner !== fk && adjacent(mt, t)));
              const pool = frontline.length ? frontline : mine;
              const gain = pool.reduce((a, b) => a.troops <= b.troops ? a : b);
              gain.troops += 2;
              state.siphonedThisTurn = true;
              effects.push({kind:'refresh', tiles:[gain.id]});
            }
          }
          state.actionsUsed++;
          log.push(`👁️ ${f.icon} sabotaged ${tile.name}`);
          effects.push({kind:'refresh', tiles:[action.target]});
          effects.push({kind:'flash', tile:action.target});
          const win = checkWinCondition(state, log);
          if (win) {
            const rWin = maybeReckoning(state, win.fk, log);
            if (rWin) { state.winner = rWin; effects.push({kind:'win', winner:rWin}); }
            else if (rWin === null) { effects.push({kind:'win', winner:state.winner}); }
            else { state.winner = win; effects.push({kind:'win', winner:win}); }
          }
          break;
        }
        case 'bribe': {
          const tile = state.tiles[action.target];
          f.resources -= 1;
          const bribedPrev = tile.owner;
          // The bribed troop DEFECTS: it joins an adjacent Syndicate tile (the staging tile)
          // rather than just vanishing — a 2-point swing (−1 them, +1 you). Pick the staging
          // tile before any capture so it's never the tile we're about to seize.
          const defectTo = Object.values(state.tiles)
            .filter(t => t.owner === fk && adjacent(t, tile))
            .sort((a, b) => b.troops - a.troops)[0];
          tile.troops--;
          if (defectTo) defectTo.troops++;
          if (tile.troops <= 0) {
            tile.owner = fk; tile.troops = 1;
            if (tilesOf(state, bribedPrev).length === 0) {
              killFaction(state, bribedPrev, log);
              awardEliminationBounty(state, fk, bribedPrev, log);
            }
          }
          state.actionsUsed++;
          log.push(`💰 ${f.icon} bribed ${tile.name} — a troop defects${defectTo ? ' to ' + defectTo.name : ''}!`);
          effects.push({kind:'refresh', tiles: defectTo ? [action.target, defectTo.id] : [action.target]});
          const win = checkWinCondition(state, log);
          if (win) {
            const rWin = maybeReckoning(state, win.fk, log);
            if (rWin) { state.winner = rWin; effects.push({kind:'win', winner:rWin}); }
            else if (rWin === null) { effects.push({kind:'win', winner:state.winner}); }
            else { state.winner = win; effects.push({kind:'win', winner:win}); }
          }
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

    // ---- TYRANT_COURT: Tyrant courts a specific faction (sim dispatches after AI decision) ----
    case 'TYRANT_COURT': {
      const target = action.target;
      if (!state.tyrantOn || !state.factions[TYRANT_KEY] || state.factions[TYRANT_KEY].eliminated) break;
      if (state.tyrantConquest) break;   // a conquest Tyrant never re-instigates diplomacy
      if (hasPact(state, TYRANT_KEY, target)) break;
      if (tyrantAtPactCap(state)) break;   // concurrent-pact cap (single-human games: 3)
      formPact(state, TYRANT_KEY, target);
      state.factions[target].boon = action.boon || 'tithe';
      if (!state.tyrantLastOffer) state.tyrantLastOffer = {};
      state.tyrantLastOffer[target] = state.round;
      log.push('🦠 A secret pact takes hold in the shadows…');
      break;
    }

    // ---- TYRANT_BETRAY: Tyrant switches to conquest mode, breaks all pacts ----
    case 'TYRANT_BETRAY': {
      if (state.tyrantConquest) break;
      state.tyrantConquest = true;
      log.push('🦠🗡️ THE TYRANT abandons diplomacy — CONQUEST MODE!');
      for (const k of Object.keys(state.pacts || {})) {
        const [a, b] = k.split('|');
        if (a === TYRANT_KEY || b === TYRANT_KEY) {
          const ally = a === TYRANT_KEY ? b : a;
          breakPact(state, TYRANT_KEY, ally, log);
        }
      }
      break;
    }

    // ---- TYRANT_SPREAD: metastasize toward hostile factions ----
    case 'TYRANT_SPREAD': {
      const fk = TYRANT_KEY;
      const tiles = Object.values(state.tiles);
      const seeds = tiles.filter(t => t.owner === fk && t.troops >= 2);
      // Grow TOWARD non-allied factions instead of always the first/top-left empty tile.
      const hostile = tiles.filter(t => t.owner && t.owner !== fk && !hasPact(state, fk, t.owner));
      const dist = (a, b) => Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
      const towardHostile = (t) => hostile.length ? Math.min(...hostile.map(h => dist(t, h))) : 0;
      let spread = 0;
      for (const s of seeds) {
        if (spread >= 4) break;
        const empties = tiles.filter(t => !t.owner && adjacent(s, t));
        if (!empties.length) continue;
        empties.sort((a, b) => towardHostile(a) - towardHostile(b));
        const empty = empties[0];
        s.troops--; empty.owner = fk; empty.troops = 1; empty.heldRounds = 0;
        effects.push({kind:'refresh', tiles:[s.id, empty.id]});
        spread++;
      }
      if (spread) log.push(`🦠 THE TYRANT spreads into ${spread} new tile${spread>1?'s':''}`);
      // Part 2: Sic boon — strike ONE enemy of each sic-ally from the strongest 2+ tile
      // adjacent to that enemy. If the blob hasn't reached the frontier yet, sic simply
      // does nothing this turn (no guaranteed nibble — the blob is the threat, not free damage).
      for (const ally of livingKeys(state)) {
        if (ally === TYRANT_KEY || !hasPact(state, TYRANT_KEY, ally) || state.factions[ally].boon !== 'sic') continue;
        const foe = (t) => t.owner && t.owner !== TYRANT_KEY && t.owner !== ally && !hasPact(state, TYRANT_KEY, t.owner);
        let atkSrc = null, atkTgt = null, best = 1;
        for (const tt of Object.values(state.tiles)) {
          if (tt.owner !== TYRANT_KEY || tt.troops < 2) continue;
          const adj = Object.values(state.tiles).find(t => foe(t) && adjacent(tt, t));
          if (adj && tt.troops > best) { best = tt.troops; atkSrc = tt; atkTgt = adj; }
        }
        if (atkSrc) {
          const result = resolveCombat(state, TYRANT_KEY, atkSrc.id, atkTgt.id, 0);
          log.push(...result.log);
          effects.push(...result.effects);
          log.push(`🦠 The Tyrant lashes out at ${atkTgt.name} (sic the blob)`);
          if (atkTgt.owner === null) {
            const prev = result.effects.find(e => e.kind === 'combat')?.defenderFk;
            if (prev && tilesOf(state, prev).length === 0) killFaction(state, prev, log);
          }
        }
      }
      break;
    }

    // ---- END_TURN ----
    case 'END_TURN': {
      state.assaultOn = false;
      state.assaultCaptures = 0;
      state.turnAttacks = 0; state.turnStrikes = {};
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
      // Part 2: Tyrant mechanics (corruption, tribute, tithe, skim)
      if (state.tyrantOn && state.factions[TYRANT_KEY] && !state.factions[TYRANT_KEY].eliminated) {
        // Standing imbalance: Tyrant skims 1 troop from each ally's weakest tile
        for (const k of livingKeys(state)) {
          if (k === TYRANT_KEY || !hasPact(state, TYRANT_KEY, k)) continue;
          const myTiles = tilesOf(state, k).filter(t => t.troops >= 2);
          if (myTiles.length > 0) {
            const weakest = myTiles.reduce((a, b) => a.troops <= b.troops ? a : b);
            weakest.troops--;
            effects.push({kind:'refresh', tiles:[weakest.id]});
          }
        }
        // Tribute: every 3 rounds while allied, pay 2 resources or +2 corruption
        const TRIBUTE_INTERVAL = 3;
        const TRIBUTE_COST = 2;
        for (const k of livingKeys(state)) {
          if (k === TYRANT_KEY) continue;
          if (!hasPact(state, TYRANT_KEY, k)) continue;
          const pactRound = state.pacts[pairKey(TYRANT_KEY, k)];
          const elapsed = state.round - pactRound;
          if (elapsed > 0 && elapsed % TRIBUTE_INTERVAL === 0) {
            const f = state.factions[k];
            if (f.resources >= TRIBUTE_COST) {
              f.resources -= TRIBUTE_COST;
              log.push(`🦠 ${f.name} pays tribute to the Tyrant (−${TRIBUTE_COST} res)`);
            } else {
              f.corruption = (f.corruption || 0) + 2;
              log.push(`🦠 ${f.name} can't pay tribute — corruption surges!`);
            }
          }
        }
      // corruption tick — each Tyrant ally sinks deeper, but slowly: +1 every 2 rounds bound
      // (first tick delayed to 2 rounds in). Slower accrual keeps the bargain survivable.
        for (const k of livingKeys(state)) {
          if (k === TYRANT_KEY) continue;
          if (!hasPact(state, TYRANT_KEY, k)) continue;
          const cPactRound = state.pacts[pairKey(TYRANT_KEY, k)];
          const cElapsed = state.round - cPactRound;
          if (cElapsed > 0 && cElapsed % 2 === 0) {
            state.factions[k].corruption = (state.factions[k].corruption || 0) + 1;
          }
        }
        // Part 2: Tithe boon — +1 troop on a frontline tile each round
        for (const k of livingKeys(state)) {
          if (k === TYRANT_KEY) continue;
          if (hasPact(state, TYRANT_KEY, k) && state.factions[k].boon === 'tithe') {
            const myT = tilesOf(state, k);
            const frontline = myT.filter(mt =>
              Object.values(state.tiles).some(t => t.owner && t.owner !== k && adjacent(mt, t))
            );
            const target = frontline.length > 0
              ? frontline.reduce((a, b) => a.troops <= b.troops ? a : b)
              : myT[0];
            if (target) { target.troops += 1; effects.push({kind:'refresh', tiles:[target.id]}); }
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
          if (f && !f.eliminated && countNodes(state, k) >= 3 && state.round - since >= 2) {
            // Part 2: corrupt faction → Reckoning intercept
            const reckoningWin = maybeReckoning(state, k, log);
            if (reckoningWin) {
              state.winner = reckoningWin;
              effects.push({kind:'win', winner:reckoningWin});
              return { state, effects, log };
            }
            if (reckoningWin === null) {
              // Reckoning fired but conspirator lost → Tyrant wins through them
              continue; // skip this winner, Tyrant win already set below
            }
            // reckoningWin === false → no corruption, normal win
            const win = { fk: k, condition: 'NODE DOMINANCE',
              detail: `${f.name} held 3+ Core Nodes for 3 rounds and commands Nexus.`, round: state.round };
            state.winner = win;
            effects.push({kind:'win', winner:win});
            return { state, effects, log };
          }
        }
      }
      // If a Reckoning resulted in Tyrant winning, it's set in state.winner by maybeReckoning
      if (state.winner) {
        effects.push({kind:'win', winner:state.winner});
        return { state, effects, log };
      }
      state.round++;
      if (state.round > ROUND_CAP) {
        // Find best non-eliminated faction by nodes
        let best = null, bestN = -1;
        for (const [k,f] of Object.entries(state.factions)) {
          if (f.eliminated) continue;
          if (k === TYRANT_KEY) continue; // Tyrant doesn't win by timeout directly
          const n = Object.values(state.tiles).filter(t => t.owner === k && t.isNode).length;
          if (n > bestN) { bestN = n; best = k; }
        }
        if (best) {
          // Part 2: corrupt faction → Reckoning intercept
          const reckoningWin = maybeReckoning(state, best, log);
          if (reckoningWin) {
            state.winner = reckoningWin;
            effects.push({kind:'win', winner:reckoningWin});
          } else if (reckoningWin === null) {
            // Tyrant wins through them — already set in state.winner
            effects.push({kind:'win', winner:state.winner});
          } else {
            const win = { fk: best, condition: 'TIMED OUT',
              detail: `After ${ROUND_CAP} rounds, ${state.factions[best].name} held the most Nodes.`, round: state.round };
            state.winner = win;
            effects.push({kind:'win', winner:win});
          }
        }
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

  // Clamp every stack to the troop cap. Past the force cap extra troops only buy
  // attrition-resistance, which trivializes sabotage/chip effects — so cap the stack.
  for (const t of Object.values(state.tiles)) {
    if (t.troops > TROOP_CAP) t.troops = TROOP_CAP;
  }

  return { state, effects, log };
}

// Re-export win check for use by the shell/AI
export { checkWinCondition, resolveCombat, applyIncome, EVENT_HANDLERS };
