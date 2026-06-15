// ============================================================
// state.js — Game constants, definitions, and initial-state factory
// PURE: no DOM, no timers, no network, no Math.random in engine paths.
// ============================================================

export const RES_CAP = 14;
export const GRID_SIZE = 7;   // board is GRID_SIZE x GRID_SIZE tiles
export const ROUND_CAP = 30;
export const THRALLDOM_CAP = 13; // at this corruption → auto-loss (Tyrant wins)
export const MOON_BAND = 2;     // moon band = CAP-MOON_BAND .. CAP-1 (11-12 at cap 13)

// ---- Factions ----
export const FACTIONS = {
  grid:      { name:'THE GRID',   icon:'⚙️',  color:'#f39c12', ability:'overclock', perk:'Industrial: reinforce −1 cost' },
  syndicate: { name:'SYNDICATE',  icon:'💰',  color:'#e74c3c', ability:'bribe',     perk:'Cartel: +1 resource income each round'   },
  commune:   { name:'COMMUNE',    icon:'🌿',  color:'#2ecc71', ability:'rally',     perk:'Grassroots: +1 troop grows each round'   },
  ghost:     { name:'THE GHOST',  icon:'👁️', color:'#9b59b6', ability:'sabotage',  perk:'Phantom: attacks ignore entrenchment'    },
};

export const TYRANT_KEY = 'tyrant';
export const TYRANT_DEF = {
  name:'THE TYRANT', icon:'🦠', color:'#7b1fa2', ability:'reinforce',
  perk:'Virus: spreads into adjacent tiles every turn · harbored allies can revive it'
};

export function factionDef(key) {
  return FACTIONS[key] || (key === TYRANT_KEY ? TYRANT_DEF : null);
}

// ---- Traits ----
export const TRAITS = [
  { id:'last_stand', name:'LAST STAND',   desc:'1-2 troop defenders get +3 def (no loot on capture)' },
  { id:'scavenger',  name:'SCAVENGER',    desc:'+1 resource per tile captured'      },
  { id:'hoard',      name:'HOARDER',      desc:'Earn +1 resource per Node'           },
  { id:'ghost_step', name:'GHOST STEP',   desc:'Move 2 tiles — slip through anything'},
  { id:'tactician',  name:'TACTICIAN',    desc:'Roll 3d6 attack, keep best 2'        },
  { id:'fortify',    name:'FORTIFY',      desc:'Fresh tiles: +2 def margin. After casualty: +1'},
];

// Phase 5b: faction → traits they CANNOT pick
export const TRAIT_EXCLUSIONS = {
  grid: ['ghost_step'],
};
export function traitsFor(fk) {
  const blocked = TRAIT_EXCLUSIONS[fk] || [];
  return TRAITS.filter(t => !blocked.includes(t.id));
}

// ---- Nodes ----
export const NODE_TILES = [
  { id:'node_power',     name:'⚡ POWER',     short:'⚡PWR', isNode:true },
  { id:'node_water',     name:'💧 WATER',     short:'💧H2O', isNode:true },
  { id:'node_transit',   name:'🚇 TRANSIT',   short:'🚇TRN', isNode:true },
  { id:'node_comms',     name:'📡 COMMS',     short:'📡COM', isNode:true },
  { id:'node_data',      name:'🖧 DATA',      short:'🖧DAT', isNode:true },
  // GRAVEYARD — bounty node spawned on the tile where THE TYRANT dies. No perk; just counts
  // as a 6th node toward the 3-of-N victory. Can be stolen like any other node.
  { id:'node_graveyard', name:'☠ GRAVEYARD',  short:'☠GRV', isNode:true },
];

export const NODE_BONUSES = {
  node_power:   'Reinforce −1 cost',
  node_water:   '+1 income / round',
  node_transit: 'Airlifts cost 0 res',
  node_comms:   '+1 attack rolls',
  node_data:    '+1 defense rolls',
  node_graveyard: 'no bonus — bounty for slaying the Tyrant',
};

export const NODE_IMAGES = {
  node_power:     'assets/node_power.png',
  node_water:     'assets/node_water.png',
  node_transit:   'assets/node_transit.png',
  node_comms:     'assets/node_comms.png',
  node_data:      'assets/node_data.png',
  node_graveyard: 'assets/node_graveyard.png',
};

export const FACTION_IMAGES = {
  grid:      'assets/faction_grid.png',
  syndicate: 'assets/faction_syndicate.png',
  commune:   'assets/faction_commune.png',
  ghost:     'assets/faction_ghost.png',
  tyrant:    'assets/faction_tyrant.png',
};

// ---- Regions ----
export const REGION_NAMES  = { N:'NORTH', S:'SOUTH', E:'EAST', W:'WEST', C:'CORE' };
export const REGION_COLORS = { N:'#5dade2', S:'#e74c3c', E:'#2ecc71', W:'#f1c40f', C:'#888' };

export function regionOf(t) {
  const mid = (GRID_SIZE - 1) / 2;
  const dr = t.row - mid, dc = t.col - mid;
  if (dr === 0 && dc === 0) return 'C';
  const adr = Math.abs(dr), adc = Math.abs(dc);
  if (adr > adc) return dr < 0 ? 'N' : 'S';
  if (adc > adr) return dc < 0 ? 'W' : 'E';
  if (dr < 0) return dc < 0 ? 'N' : 'E';
  return dc < 0 ? 'W' : 'S';
}

export const DISTRICT_NAMES = ['ASHFIELD','LOWGATE','COPPERWAY','IRONSIDE','DUSKHOLM',
  'REDMERE','VAULTYARD','CINDERBLOCK','FENWICK','QUARRY ROW',
  'STEELGATE','DOCKSIDE','BURNHILL','NORTHPASS','SOUTHWICK',
  'EMBER LANE','COLDWATER','GRAVEMOOR','EASTGATE','WESTEND'];

// ---- Event definitions (keys instead of function refs, resolved by engine) ----
export const EVENT_DEFS = [
  { type:'CHAOS', region:true, title:'POWER FAILURE', body:'Every held tile in the region loses 1 troop and its dig-in.', key:'powerFailure' },
  { type:'CHAOS', region:true, title:'THE UPRISING',  body:'Every 4+ stack in the region loses 2 troops and its dig-in.',  key:'uprising' },
  { type:'CHAOS', region:true, title:'EARTHQUAKE',    body:'The region is shaken — tiles lose 1 troop, Nodes lose 2.',     key:'quake' },
  { type:'CHAOS', region:true, title:'RIOT',          body:'A district in the region falls to the weakest faction.',       key:'riot' },
  { type:'CHAOS', region:true, title:'SIEGE',         body:'All entrenchment across the region is broken.',                key:'siege' },
  { type:'LUCK',  region:true, title:'MUSTER',        body:'+1 troop on every tile you hold in the region.',               key:'muster' },
  { type:'LUCK',  region:true, title:'GOLD STRIKE',   body:'+1 resource for each tile you hold in the region.',            key:'goldStrike' },
  { type:'CHAOS', title:'MARKET CRASH', body:'Every faction loses HALF its resources. Hoarders weep.',       key:'crash' },
  { type:'CHAOS', title:'REVOLUTION',   body:'The Node leader is overthrown — they lose one Core Node.',      key:'revolution' },
  { type:'CHAOS', title:'TOTAL WAR',    body:'ALL entrenchment wiped and attackers strike +1 this round.',    key:'totalWar' },
  { type:'LUCK',  title:'INSURGENCY',   body:'The weakest faction gains +4 troops and +3 resources.',         key:'insurgency' },
  { type:'CHOICE', title:"WARLORD'S TRIBUTE",
    body:'A warlord marches on Nexus and demands payment. Coin, or blood?',
    key:'warlordTribute',
    choices:[
      { label:'💰 PAY TRIBUTE (−4 resources)' },
      { label:'🩸 REFUSE (−1 troop on every tile)' },
    ]},
  { type:'CHOICE', title:'MERCENARY CONTRACT',
    body:'Sellswords are for hire — at a steep price.',
    key:'mercenaryContract',
    choices:[
      { label:'🪖 HIRE (−5 res → +4 troops on your strongest tile)' },
      { label:'🔋 DECLINE (+3 resources)' },
    ]},
];

// ---- Map layout constants ----
const _Q = 1, _MID = Math.floor((GRID_SIZE - 1) / 2);
export const NODE_POSITIONS = {
  node_power:   { row: _Q,             col: _Q             },
  node_water:   { row: _Q,             col: GRID_SIZE-1-_Q },
  node_transit: { row: _MID,           col: _MID           },
  node_comms:   { row: GRID_SIZE-1-_Q, col: _Q             },
  node_data:    { row: GRID_SIZE-1-_Q, col: GRID_SIZE-1-_Q },
};

export const START_CORNERS = [
  { tiles: [{row:0,col:0},{row:0,col:1}],                              label:'NW' },
  { tiles: [{row:0,col:GRID_SIZE-1},{row:1,col:GRID_SIZE-1}],          label:'NE' },
  { tiles: [{row:GRID_SIZE-1,col:0},{row:GRID_SIZE-2,col:0}],          label:'SW' },
  { tiles: [{row:GRID_SIZE-1,col:GRID_SIZE-1},{row:GRID_SIZE-1,col:GRID_SIZE-2}], label:'SE' },
];

// ---- Factory helpers ----
export function mkFaction(name, key, isAI, trait) {
  const def = factionDef(key);
  return {
    name, icon: def.icon, color: def.color,
    ability: def.ability, isAI, trait, resources: 4, eliminated: false,
    isTyrant: key === TYRANT_KEY,
    corruption: 0,   // Part 2: Tyrant corruption clock (exact integer, display via corruptionBand)
    boon: null,       // Part 2: chosen boon when allied to Tyrant ('tithe' | 'sic' | null)
  };
}

// ---- Corruption band (Part 2) — display only, never show raw integer ----
export function corruptionBand(n) {
  if (n <= 0)                               return { label: 'Untouched',             tier: 0 };
  if (n <= 3)                               return { label: 'Touched by shadow',     tier: 1 };
  if (n < THRALLDOM_CAP - MOON_BAND)        return { label: 'Deeply corrupt',        tier: 2 };
  if (n < THRALLDOM_CAP)                    return { label: 'Moon-touched',          tier: 3 };
  return                                           { label: 'Thrall of the Tyrant',  tier: 4 };
}

// ---- State query helpers (take state explicitly) ----
export function tilesOf(state, fk)   { return Object.values(state.tiles).filter(t => t.owner === fk); }
export function nodesOf(state, fk)   { return tilesOf(state, fk).filter(t => t.isNode); }
export function countNodes(state, fk){ return nodesOf(state, fk).length; }
export function controlsNode(state, fk, nodeId) {
  return !!fk && Object.values(state.tiles).some(t => t.nodeId === nodeId && t.owner === fk);
}
export function livingKeys(state) {
  return Object.keys(state.factions).filter(k => !state.factions[k].eliminated);
}
export function pairKey(a, b) { return [a, b].sort().join('|'); }
export function hasPact(state, a, b) {
  return !!(a && b && a !== b && state.pacts && state.pacts[pairKey(a, b)]);
}

// ---- Adjacency (hex grid, offset coords) ----
export function adjacent(a, b) {
  if (!a || !b) return false;
  const dr = a.row - b.row, dc = a.col - b.col;
  if (dr === 0) return Math.abs(dc) === 1;
  if (Math.abs(dr) === 1) {
    const even = a.row % 2 === 0;
    return even ? (dc === 0 || dc === 1) : (dc === 0 || dc === -1);
  }
  return false;
}

// ---- Economy helpers ----
export function reinforceCost(state, fk) {
  let c = 2;
  if (fk === 'grid')                           c -= 1;
  if (controlsNode(state, fk, 'node_power'))   c -= 1;
  return Math.max(1, c);
}
export function reinforceAmount(_fk) { return 2; }
// Legacy default for engine MOVE without an explicit count (players/AI now choose).
export function moveTroopCount(_state, _fk) { return 1; }
// ✈️ AIRLIFT — free while holding the 🚇 TRANSIT node (still costs an action).
export function airliftCost(state, fk) {
  return controlsNode(state, fk, 'node_transit') ? 0 : 3;
}
export function moveRange(state, fk) {
  const f = state.factions[fk];
  if (!f) return 1;
  const phantom = f.ability === 'sabotage';  // ghost faction perk
  const step    = f.trait === 'ghost_step';   // trait
  // Phase 5b: phantom+ghost_step stacks to 3; either alone = 2; otherwise 1
  if (phantom && step) return 3;
  if (phantom || step) return 2;
  return 1;
}
export function moveReachable(state, fk, src, dest) {
  if (!src || !dest || src.id === dest.id) return false;
  if (adjacent(src, dest)) return true;
  const range = moveRange(state, fk);
  if (range <= 1) return false;
  // BFS from src up to `range` steps — phantom/ghost_step pass through any tile
  const tiles = Object.values(state.tiles);
  const dist = { [src.id]: 0 };
  const q = [src];
  for (let h = 0; h < q.length; h++) {
    const cur = q[h];
    const d = dist[cur.id];
    if (d >= range) continue;
    for (const nb of tiles) {
      if (dist[nb.id] === undefined && adjacent(cur, nb)) {
        dist[nb.id] = d + 1;
        if (nb.id === dest.id) return true;
        q.push(nb);
      }
    }
  }
  return false;
}

// Diplomacy
export function grudgeAtkBonus(state, atk, def) {
  return (state.grudges[atk + '>' + def] >= state.round) ? 2 : 0;
}
export function grudgeDefBonus(state, atk, def) {
  return (state.grudges[def + '>' + atk] >= state.round) ? 2 : 0;
}
export function coalitionAtkBonus(state, defFk, atkFk) {
  return (defFk !== atkFk && countNodes(state, defFk) >= 2) ? 1 : 0;
}
