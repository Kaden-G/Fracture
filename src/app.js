// Global error catcher - surfaces silent JS errors in action log
window.lastError = null;
window.onerror = function(msg, src, line, col, err) {
  window.lastError = { msg, src, line, col, stack: err && err.stack };
  const log = document.getElementById('action-log');
  if (log) log.textContent = '⚠️ JS ERROR: ' + msg + ' (line ' + line + ':' + col + ')';
  console.error('JS ERROR:', msg, 'at', src + ':' + line + ':' + col, err && err.stack);
  return false;
};
window.addEventListener('unhandledrejection', function(e) {
  window.lastError = { msg: 'unhandled promise rejection', reason: e.reason, stack: e.reason && e.reason.stack };
  const log = document.getElementById('action-log');
  if (log) log.textContent = '⚠️ ASYNC ERROR: ' + (e.reason && e.reason.message || e.reason);
  console.error('Unhandled rejection:', e.reason);
});

// ============================================================
// GAME DATA
// ============================================================
const RES_CAP = 14;  // resource stockpile ceiling
const GRID    = 7;   // board is GRID x GRID tiles

const FACTIONS = {
  grid:      { name:'THE GRID',   icon:'⚙️',  color:'#f39c12', ability:'overclock', perk:'Industrial: reinforce −1 cost' },
  syndicate: { name:'SYNDICATE',  icon:'💰',  color:'#e74c3c', ability:'bribe',     perk:'Cartel: +1 resource income each round'   },
  commune:   { name:'COMMUNE',    icon:'🌿',  color:'#2ecc71', ability:'rally',     perk:'Grassroots: +1 troop grows every other round'   },
  ghost:     { name:'THE GHOST',  icon:'👁️', color:'#9b59b6', ability:'sabotage',  perk:'Phantom: attacks ignore entrench, move 2 tiles through enemies'    },
};

// The Tyrant — an optional permanent AI player (not selectable as a normal faction).
const TYRANT_KEY = 'tyrant';
const THRALLDOM_CAP = 13; // at this corruption → auto-loss
const MOON_BAND = 2;     // moon band = CAP-MOON_BAND .. CAP-1
// Step 3: COALITION SURGE — human-only counterplay vs the Tyrant (mirrors engine.js).
// Never fires in all-AI/single-human games; magnitude is tune-by-play (these two consts).
const COALITION_PER_FACTION = 1;  // attack-vs-Tyrant bonus per coalition member beyond the first (TUNE BY PLAY)
const COALITION_MAX         = 4;  // safety cap on the surge
const TYRANT_DEF = { name:'THE TYRANT', icon:'🦠', color:'#7b1fa2', ability:'reinforce',
                     perk:'Virus: spreads into adjacent tiles every turn · harbored allies can revive it' };
function factionDef(key) { return FACTIONS[key] || (key===TYRANT_KEY ? TYRANT_DEF : null); }

const TRAITS = [
  { id:'last_stand', name:'LAST STAND',   desc:'1-2 troop defenders get +3 def (no loot on capture)' },
  { id:'scavenger',  name:'SCAVENGER',    desc:'+1 resource per tile captured'      },
  { id:'hoard',      name:'HOARDER',      desc:'Earn +1 resource per Node'           },
  { id:'ghost_step', name:'GHOST STEP',   desc:'Move 2 tiles (3 on Ghost) — slip through anything'},
  { id:'tactician',  name:'TACTICIAN',    desc:'Roll 3d6 attack, keep best 2'        },
  { id:'fortify',    name:'FORTIFY',      desc:'Fresh tiles: +2 def margin. After casualty: +1'},
];

// Phase 5b: faction → traits they CANNOT pick
const TRAIT_EXCLUSIONS = { grid: ['ghost_step'] };

const EVENTS = [
  // ---- REGIONAL: hit the round's target region. The region bag keeps N/S/E/W even over a game ----
  { type:'CHAOS', region:true, title:'POWER FAILURE', body:'Every held tile in the region loses 1 troop and its dig-in.', apply: applyPowerFailure },
  { type:'CHAOS', region:true, title:'THE UPRISING',  body:'Every 4+ stack in the region loses 2 troops and its dig-in.',  apply: applyUprising },
  { type:'CHAOS', region:true, title:'EARTHQUAKE',    body:'The region is shaken — tiles lose 1 troop, Nodes lose 2.',     apply: applyQuake },
  { type:'CHAOS', region:true, title:'RIOT',          body:'A district in the region falls to the weakest faction.',       apply: applyRiot },
  { type:'CHAOS', region:true, title:'SIEGE',         body:'All entrenchment across the region is broken.',                apply: applySiege },
  { type:'LUCK',  region:true, title:'MUSTER',        body:'+1 troop on every tile you hold in the region.',               apply: applyMuster },
  { type:'LUCK',  region:true, title:'GOLD STRIKE',   body:'+1 resource for each tile you hold in the region.',            apply: applyGoldStrike },
  // ---- GLOBAL: board-wide swings ----
  { type:'CHAOS', title:'MARKET CRASH', body:'Every faction loses HALF its resources. Hoarders weep.',       apply: applyCrash },
  { type:'CHAOS', title:'REVOLUTION',   body:'The Node leader is overthrown — they lose one Core Node.',      apply: applyRevolution },
  { type:'CHAOS', title:'TOTAL WAR',    body:'ALL entrenchment wiped and attackers strike +1 this round.',    apply: applyTotalWar },
  { type:'LUCK',  title:'INSURGENCY',   body:'The weakest faction gains +4 troops and +3 resources.',         apply: applyInsurgency },
  // ---- CHOICE: money-vs-blood decisions, every faction picks for itself ----
  { type:'CHOICE', title:"WARLORD'S TRIBUTE",
    body:'A warlord marches on Nexus and demands payment. Coin, or blood?',
    choices:[
      { label:'💰 PAY TRIBUTE (−4 resources)', canPick:(fk)=>G.factions[fk].resources>=4,
        resolve:(fk)=>{ const f=G.factions[fk]; f.resources=Math.max(0,f.resources-4); } },
      { label:'🩸 REFUSE (−1 troop on every tile)', resolve:(fk)=>{ tilesOf(fk).forEach(t=>{ if(t.troops>1) t.troops--; refreshHex(t.id); }); } },
    ],
    aiChoose:(fk)=> G.factions[fk].resources>=4 ? 0 : 1 },
  { type:'CHOICE', title:'MERCENARY CONTRACT',
    body:'Sellswords are for hire — at a steep price.',
    choices:[
      { label:'🪖 HIRE (−5 res → +4 troops on your strongest tile)', canPick:(fk)=>G.factions[fk].resources>=5,
        resolve:(fk)=>{ const f=G.factions[fk]; if(f.resources>=5){ f.resources-=5; const t=tilesOf(fk).sort((a,b)=>b.troops-a.troops)[0]; if(t){ t.troops+=4; refreshHex(t.id);} } } },
      { label:'🔋 DECLINE (+3 resources)', resolve:(fk)=>{ const f=G.factions[fk]; f.resources=Math.min(f.resources+3,RES_CAP); } },
    ],
    aiChoose:(fk)=> (G.factions[fk].resources>=5 && aiTroopHunger(fk)) ? 0 : 1 },
];

const NODE_TILES = [
  { id:'node_power',     name:'⚡ POWER',     short:'⚡PWR', isNode:true },
  { id:'node_water',     name:'💧 WATER',     short:'💧H2O', isNode:true },
  { id:'node_transit',   name:'🚇 TRANSIT',   short:'🚇TRN', isNode:true },
  { id:'node_comms',     name:'📡 COMMS',     short:'📡COM', isNode:true },
  { id:'node_data',      name:'🖧 DATA',      short:'🖧DAT', isNode:true },
  // GRAVEYARD — bounty node spawned where THE TYRANT dies. No perk; just counts as a 6th
  // node toward the "3 to win" condition. Can be stolen like any other node.
  { id:'node_graveyard', name:'☠ GRAVEYARD',  short:'☠GRV', isNode:true },
];

// Each Core Node grants its controller a passive bonus — so WHICH nodes you hold matters.
const NODE_BONUSES = {
  node_power:   'Reinforce −1 cost',
  node_water:   '+1 income / round',
  node_transit: 'Airlifts cost 0 res',
  node_comms:   '+1 attack rolls',
  node_data:    '+1 defense rolls',
  node_graveyard: 'no bonus — bounty for slaying the Tyrant',
};

// Custom artwork for each Core Node (transparent hex badges).
const NODE_IMAGES = {
  node_power:     'assets/node_power.png',
  node_water:     'assets/node_water.png',
  node_transit:   'assets/node_transit.png',
  node_comms:     'assets/node_comms.png',
  node_data:      'assets/node_data.png',
  node_graveyard: 'assets/node_graveyard.png?v=1',
};

// Themed frame artwork for each faction's owned (non-node) tiles.
const FACTION_IMAGES = {
  grid:      'assets/faction_grid.png',
  syndicate: 'assets/faction_syndicate.png?v=2',
  commune:   'assets/faction_commune.png',
  ghost:     'assets/faction_ghost.png',
  tyrant:    'assets/faction_tyrant.png',
};

// Themed card frames for the sidebar faction status rows (built by tools/make_cards.py).
const FACTION_CARDS = {
  grid:      'assets/card_grid.png?v=2',
  syndicate: 'assets/card_syndicate.png?v=2',
  commune:   'assets/card_commune.png?v=2',
  ghost:     'assets/card_ghost.png?v=2',
  tyrant:    'assets/card_tyrant.png',
};
// border-image slice (source px to the frame's inner edge) — per card, since the
// art assets differ in size. Tyrant keeps the original square card's 80.
const FACTION_CARD_SLICE = {
  grid: 120, syndicate: 115, commune: 106, ghost: 118, tyrant: 80,
};

// ---- REGIONS: a pinwheel split of the 5×5 grid into N/S/E/W (6 tiles each) + a neutral CORE.
const REGION_NAMES  = { N:'NORTH', S:'SOUTH', E:'EAST', W:'WEST', C:'CORE' };
const REGION_COLORS = { N:'#5dade2', S:'#e74c3c', E:'#2ecc71', W:'#f1c40f', C:'#888' };
function regionOf(t) {
  const mid = (GRID - 1) / 2;
  const dr = t.row - mid, dc = t.col - mid;
  if (dr === 0 && dc === 0) return 'C';
  const adr = Math.abs(dr), adc = Math.abs(dc);
  if (adr > adc) return dr < 0 ? 'N' : 'S';
  if (adc > adr) return dc < 0 ? 'W' : 'E';
  // diagonal ties → pinwheel: top-left→N, top-right→E, bottom-right→S, bottom-left→W
  if (dr < 0) return dc < 0 ? 'N' : 'E';
  return dc < 0 ? 'W' : 'S';
}
function regionTiles(reg) { return Object.values(G.tiles).filter(t => t.region === reg); }
// Draw the next region from a shuffled bag, refilling when empty — so over a whole game
// each of N/S/E/W is targeted equally often, in a random order each playthrough.
function nextRegion() {
  if (!G.regionBag || !G.regionBag.length) G.regionBag = shuffle(['N','S','E','W']);
  return G.regionBag.pop();
}

const DISTRICT_NAMES = ['ASHFIELD','LOWGATE','COPPERWAY','IRONSIDE','DUSKHOLM',
  'REDMERE','VAULTYARD','CINDERBLOCK','FENWICK','QUARRY ROW',
  'STEELGATE','DOCKSIDE','BURNHILL','NORTHPASS','SOUTHWICK',
  'EMBER LANE','COLDWATER','GRAVEMOOR','EASTGATE','WESTEND'];

// ============================================================
// STATE
// ============================================================
let G = {};
let selectedTile   = null;
let currentAction  = null;
let signalJamActive = false;
let totalWar       = false;  // TOTAL WAR event: attackers +1 this round
let pendingEvent   = null;
let gameOver       = false;
let turnAttacks    = 0;  // total attacks this turn (informational)
let turnStrikes    = {};  // "attacker|victimFaction" → times struck this turn → rally only escalates vs the SAME victim
let assaultCaptures = 0;  // captures in the current assault chain — capped at 3
let assaultOn      = false;  // a "press the assault" attack chain is in progress (player)
let mySeats        = [];  // faction keys THIS device controls (hot-seat: all humans; online: your claimed seat)

// ---- Networking state (all inert while offline; online layer flips these) ----
let online        = false;   // true once in an online room
let isDriver       = true;    // may THIS client advance the engine (run AI/events)? always true offline
let myTurnActive   = false;   // is it currently a local human's turn we've begun?
let applyingRemote = false;   // suppress pushes while loading a remote snapshot
let onlineStarting = false;   // host: round 1 in progress, flip room to started after first turn
let lastShownEventN = 0;      // highest round-event card this client has already displayed
let roomCode       = null;
let roomRef        = null;    // Firebase ref to /rooms/{CODE}
let stateRef       = null;    // Firebase ref to /rooms/{CODE}/state
let lastRoomData   = null;    // most recent room snapshot (seats + state)
let lobbyIsHost    = false;
let myClientId     = null;
let myName         = '';
let myTrait        = '';
let lobbyStep      = 1;       // online lobby wizard: 1 name · 2 faction · 3 passive · 4 review · 5 ready/roster
let tutorialMode   = false;   // coach-mark tour running
let tutorialStep   = 0;
let fbInited       = false;
let db             = null;    // Firebase Realtime Database handle (set by online layer)

// Push the full game state to the room (no-op offline). Defined fully by the online layer;
// stubbed here so the engine can call it unconditionally.
function syncPush() { if (!online || applyingRemote || !db || !roomCode) return; netPushState(); }
function netPushState() {}   // overridden when the online layer loads

// Whose turn is it, and may the local player act right now?
function activeFk()  { return G.turnOrder[G.currentTurnIdx]; }
function canActNow() { if (!G.turnOrder || gameOver) return false; const a=activeFk(); return a===G.playerFaction && mySeats.includes(a) && G.factions[a] && !G.factions[a].isAI; }

// ============================================================
// HELPERS — tiles, nodes, economy, diplomacy
// ============================================================
function tilesOf(fk)  { return Object.values(G.tiles).filter(t=>t.owner===fk); }
function nodesOf(fk)  { return tilesOf(fk).filter(t=>t.isNode); }
function countNodes(fk){ return nodesOf(fk).length; }
// Sabotage siphon: where the +1 troop lands — weakest frontline tile, else weakest tile.
function ghostSiphonTarget(fk){
  const mine = tilesOf(fk);
  if (!mine.length) return null;
  const frontline = mine.filter(mt => Object.values(G.tiles).some(t => t.owner && t.owner !== fk && adjacent(mt, t)));
  const pool = frontline.length ? frontline : mine;
  return pool.reduce((a, b) => a.troops <= b.troops ? a : b);
}
function controlsNode(fk, nodeId){ return !!fk && Object.values(G.tiles).some(t=>t.nodeId===nodeId && t.owner===fk); }

// Economy (faction perks + node bonuses fold in here)
function reinforceCost(fk){
  let c = 2;
  if (fk==='grid')                           c -= 1;  // ⚙️ GRID industrial
  if (controlsNode(fk,'node_power'))         c -= 1;  // ⚡ POWER node
  return Math.max(1, c);
}
function reinforceAmount(fk){ return 2; }  // all factions reinforce +2; GRID's perk is the cost discount
function airliftCost(fk){ return controlsNode(fk,'node_transit') ? 0 : 3; }             // 🚇 TRANSIT: free airlifts
function moveRange(fk){
  const f = G.factions[fk];
  if (!f) return 1;
  const phantom = f.ability === 'sabotage';  // ghost faction perk
  const step    = f.trait === 'ghost_step';   // trait
  // Phase 5b: phantom+ghost_step stacks to 3; either alone = 2; otherwise 1
  if (phantom && step) return 3;
  if (phantom || step) return 2;
  return 1;
}
// Is `dest` a legal move target for fk's troops starting at `src`? (does NOT check dest ownership)
function moveReachable(fk, src, dest){
  if (!src || !dest || src.id===dest.id) return false;
  if (adjacent(src,dest)) return true;                       // 1 step — every faction
  const range = moveRange(fk);
  if (range <= 1) return false;
  // BFS from src up to `range` steps — phantom/ghost_step pass through any tile
  const tiles = Object.values(G.tiles);
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

// AI helper for choice events: 1 => short on bodies, prefers troops over cash
function aiTroopHunger(fk){
  const mine = tilesOf(fk);
  if (!mine.length) return 0;
  const troops = mine.reduce((s,t)=>s+t.troops,0);
  return (troops / mine.length) < 2.5 ? 1 : 0;
}

// Diplomacy — pacts (mutual) and grudges (one-way, post-betrayal)
function pairKey(a,b){ return [a,b].sort().join('|'); }
function hasPact(a,b){ return !!(a && b && a!==b && G.pacts && G.pacts[pairKey(a,b)]); }
function formPact(a,b){ G.pacts[pairKey(a,b)] = G.round; }
function breakPactBetrayal(betrayer, victim){
  delete G.pacts[pairKey(betrayer,victim)];
  G.grudges[victim+'>'+betrayer] = G.round + 2;  // victim seethes for 2 rounds
  // Part 2: clear boon if a Tyrant pact is broken
  if (betrayer === TYRANT_KEY && G.factions[victim]) G.factions[victim].boon = null;
  if (victim === TYRANT_KEY && G.factions[betrayer]) G.factions[betrayer].boon = null;
  // Keep Tyrant betrayals vague in the shared log to preserve secrecy.
  addLog('🗡️ A non-aggression pact was broken!');
}
// Part 2: corruption band — display only, never show raw integer
function corruptionBand(n) {
  if (n <= 0)                               return { label: 'Untouched',             tier: 0 };
  if (n <= 3)                               return { label: 'Touched by shadow',     tier: 1 };
  if (n < THRALLDOM_CAP - MOON_BAND)        return { label: 'Deeply corrupt',        tier: 2 };
  if (n < THRALLDOM_CAP)                    return { label: 'Moon-touched',          tier: 3 };
  return                                           { label: 'Thrall of the Tyrant',  tier: 4 };
}

function grudgeAtkBonus(atk, def){ return (G.grudges[atk+'>'+def] >= G.round) ? 2 : 0; }
function grudgeDefBonus(atk, def){ return (G.grudges[def+'>'+atk] >= G.round) ? 2 : 0; }
// Coalition: everyone piles on whoever already holds 2+ Nodes (anti-snowball)
function coalitionAtkBonus(defFk, atkFk){ return (defFk!==atkFk && countNodes(defFk)>=2) ? 1 : 0; }

// Does an AI accept a non-aggression pact proposal?
function aiConsiderPact(aiFk, propFk){
  // The Tyrant accepts EVERY pact — every ally brings it closer to winning by diplomacy —
  // unless it has hit its concurrent-pact cap (single-human games: max 3).
  if (aiFk === TYRANT_KEY) return !tyrantAtPactCap();
  // Being courted BY the Tyrant: contenders refuse (deny its diplo-win); the weak/scared appease it.
  if (propFk === TYRANT_KEY) {
    if (countNodes(aiFk) >= 2) return false;
    return tilesOf(TYRANT_KEY).length >= 4 || Math.random() < 0.45;
  }
  const alive = Object.keys(G.factions).filter(k=>!G.factions[k].eliminated);
  const leadNodes = Math.max(...alive.map(countNodes));
  const aiNodes = countNodes(aiFk), propNodes = countNodes(propFk);
  // The frontrunner presses its advantage and refuses to be tied down.
  if (aiNodes===leadNodes && aiNodes>=2) return false;
  if (propNodes > aiNodes) return true;                       // buy time vs a stronger rival
  if (tilesOf(propFk).length >= tilesOf(aiFk).length) return true;
  return Math.random() < 0.5;                                  // weaker suitor: a coin flip
}

// AI redemption — should this bound AI renounce-kill the Tyrant?
// Aligned with the HUMAN rule: renounce is only available at the "last reprieve" — when
// close to a victory that would force a Reckoning. No mid-game dead-zone bailout.
function aiShouldRenounceLive(aiFk) {
  if (!tyrantOn() || !G.factions[TYRANT_KEY] || G.factions[TYRANT_KEY].eliminated) return false;
  if (!hasPact(TYRANT_KEY, aiFk)) return false;
  const corr = G.factions[aiFk].corruption || 0;
  if (corr <= 0) return false;

  // Same gate as the human's "Fork in the Dark" prompt: only offered when close to a win.
  const myNodes = countNodes(aiFk);
  const myTiles = tilesOf(aiFk).length;
  const heldSince = G.nodesHeldSince && G.nodesHeldSince[aiFk];
  const closeToWin = (myNodes >= 3 && heldSince !== undefined)
                  || (myNodes >= 2 && myTiles >= 8);
  if (!closeToWin) return false;

  // At the reprieve: in the moon band, commit to the jackpot duel; otherwise renounce-kill.
  const moonLow = THRALLDOM_CAP - MOON_BAND;
  if (corr >= moonLow && corr < THRALLDOM_CAP) return false;
  return true;
}

// ---- TYRANT helpers ----
function tyrantOn()      { return !!(G.tyrantOn && G.factions[TYRANT_KEY]); }
function tyrantAlive()   { return tyrantOn() && !G.factions[TYRANT_KEY].eliminated; }
function tyrantAllies()  { return livingKeys().filter(k => k!==TYRANT_KEY && hasPact(TYRANT_KEY, k)); }
// Single-human games: the Tyrant may hold at most 3 pacts at once, so it can never
// buy a diplomacy-only win by aligning with all 4 rivals when only one is human.
function tyrantPactCap()   { return (G.humans && G.humans.length === 1) ? 3 : Infinity; }
function tyrantAtPactCap() { return tyrantAllies().length >= tyrantPactCap(); }
// All pacts are secret — visible only to the two parties involved.
function pactVisibleTo(a, b, viewer){ return a===viewer || b===viewer; }

// ---- Step 3: coalition surge (human-only counterplay vs the Tyrant) ----
// A faction is "coalition-hostile" if it drew blood on the Tyrant this round or
// last round (one-round memory = sustained pressure). Tyrant allies excluded.
function coalitionHostile(k) {
  return k !== TYRANT_KEY && !hasPact(TYRANT_KEY, k)
      && G.tyrantStruck && G.tyrantStruck[k] >= G.round - 1;
}
function coalitionSize() { return livingKeys().filter(coalitionHostile).length; }
// Attack-roll bonus for attackerFk striking defOwner's tile: only vs the Tyrant,
// only in 2+ human games, only for an earned True-Pact faction. Scales with the
// visible coalition size (size 1 → 0, then +PER_FACTION per extra member).
function tyrantSurgeBonus(attackerFk, defOwner) {
  if (!tyrantOn() || defOwner !== TYRANT_KEY) return 0;
  if ((G.humans ? G.humans.length : 0) < 2) return 0;   // HUMAN-ONLY
  if (!coalitionHostile(attackerFk)) return 0;           // must have earned it; allies excluded
  const size = coalitionSize();
  return Math.min(COALITION_MAX, Math.max(0, (size - 1) * COALITION_PER_FACTION));
}
// Record a True-Pact faction drawing blood on the Tyrant (earns surge next turn).
function recordTyrantStrike(attackerFk, defOwner) {
  if (!tyrantOn() || defOwner !== TYRANT_KEY) return;
  if (attackerFk === TYRANT_KEY || hasPact(TYRANT_KEY, attackerFk)) return;
  if (!G.tyrantStruck) G.tyrantStruck = {};
  G.tyrantStruck[attackerFk] = G.round;
}

// All elimination flows route through here so the Tyrant can get its harbor reprieve.
function killFaction(fk){
  if (fk === TYRANT_KEY && tyrantAllies().length > 0 && !G.tyrantHarbor) {
    G.tyrantHarbor = G.round + 3;
    addLog(`🦠 THE TYRANT is cornered — harbored by allies. Feed it a tile within 3 rounds or it dies.`);
    return;
  }
  // Tyrant eliminated — purge corruption for the eliminator, track it
  if (fk === TYRANT_KEY && tyrantOn()) {
    const eliminator = G.turnOrder[G.currentTurnIdx];
    if (eliminator && G.factions[eliminator]) {
      G.factions[eliminator].corruption = 0;
      addLog(`💀 ${G.factions[eliminator].name} purged the Tyrant!`);
    }
  }
  G.factions[fk].eliminated = true;
  // Death voids diplomacy: clear the fallen faction's pacts so stale entries never
  // count toward anything (e.g. the Tyrant's pact tally). Grudges expire on their own.
  for (const pk of Object.keys(G.pacts || {})) {
    const [a, b] = pk.split('|');
    if (a === fk || b === fk) delete G.pacts[pk];
  }
  addLog(`💀 ${G.factions[fk].name} ELIMINATED!`);
}

// Reckoning intercept — called when a faction would win.
// Returns: 'freedom' (conspirator won), 'thralldom' (Tyrant won), or false (no Reckoning).
function maybeReckoningApp(fk) {
  if (!tyrantOn()) return false;
  if (!G.factions[TYRANT_KEY] || G.factions[TYRANT_KEY].eliminated) return false;
  if (fk === TYRANT_KEY) return false;
  const corr = G.factions[fk].corruption || 0;
  if (corr <= 0) {
    // No Reckoning fires when corruption is clean — but if the winner was BOUND to the
    // Tyrant (just hadn't ticked any corruption yet), tell them. Otherwise the silent
    // skip reads as a bug ("the Reckoning didn't happen!"). A brief themed modal sits on
    // top of the win banner until dismissed, so the player understands they were spared.
    if (hasPact(TYRANT_KEY, fk)) {
      addLog(`⚖️ ${G.factions[fk].name}'s soul was weighed — untainted. The Tyrant lets them ascend.`);
      tyrantModal({
        type: 'THE WEIGHING',
        title: '⚖️ SOUL UNTAINTED',
        body: `<b>${G.factions[fk].name}</b> was bound to the Tyrant — but your soul was untainted by corruption.<br><br>` +
              `You ascend without trial.`,
        confirmLabel: 'SO BE IT',
        cancelLabel: null,
      });
    }
    return false;
  }

  // Thralldom cap — auto-loss
  if (corr >= THRALLDOM_CAP) {
    addLog(`🦠 THRALLDOM! ${G.factions[fk].name} is consumed — corruption reached the cap!`);
    showWin(TYRANT_KEY, 'RECKONING (THRALLDOM)',
      `${G.factions[fk].name} was consumed by corruption — the Tyrant wins through its thrall.`);
    return 'thralldom';
  }

  addLog(`⚔️ RECKONING triggered! ${G.factions[fk].name} (corruption ${corr}) must face the Tyrant!`);
  const tyrantWins = runReckoning(fk);
  if (tyrantWins) {
    addLog(`🦠 The Tyrant prevails — ${G.factions[fk].name} falls to thralldom!`);
    showWin(TYRANT_KEY, 'RECKONING (THRALLDOM)',
      `${G.factions[fk].name} was about to win but lost the Reckoning — the Tyrant consumes Nexus.`);
    return 'thralldom';
  } else {
    G.factions[fk].corruption = 0;
    addLog(`💀 ${G.factions[fk].name} vanquished the Tyrant in the Reckoning!`);
    return 'freedom';
  }
}

// Reckoning duel — best-of-3 dice, host-skim, moon band, fallen vote
function runReckoning(conspirator) {
  const corr = G.factions[conspirator].corruption || 0;
  const moonLow = THRALLDOM_CAP - MOON_BAND;
  const inMoon = corr >= moonLow && corr < THRALLDOM_CAP;

  // Host-skim: corruption eats conspirator tiles in the duel
  const rawTiles = tilesOf(conspirator).length;
  const skim = inMoon ? 0 : Math.min(Math.floor(corr / 2), Math.max(0, rawTiles - 1));
  const cTiles = Math.max(1, rawTiles - skim);
  const tTiles = Math.max(1, tilesOf(TYRANT_KEY).length);

  const tEssence = tTiles + 3 + (inMoon ? 0 : Math.floor(corr / 3));
  const cEssence = cTiles + (inMoon ? 5 : 0);

  let fallenForTyrant = 0, fallenForCon = 0;
  for (const [k, f] of Object.entries(G.factions)) {
    if (!f.eliminated || k === TYRANT_KEY) continue;
    const grudgeKey = k + '>' + conspirator;
    if (G.grudges[grudgeKey]) { fallenForTyrant++; }
    else                      { fallenForCon++; }
  }

  let tWins = 0, cWins = 0;
  const rounds = [];

  for (let r = 0; r < 3 && tWins < 2 && cWins < 2; r++) {
    const tRoll = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1 + tEssence + fallenForTyrant;
    const cRoll = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1 + cEssence + fallenForCon;
    if (tRoll > cRoll) { tWins++; rounds.push(`R${r+1}: Tyrant ${tRoll} vs ${cRoll} — Tyrant wins`); }   // ties go to the conspirator
    else               { cWins++; rounds.push(`R${r+1}: Tyrant ${tRoll} vs ${cRoll} — Conspirator wins`); }
  }

  const winner = tWins >= 2 ? 'THE TYRANT' : G.factions[conspirator].name;
  addLog(`⚔️ RECKONING: ${winner} prevails! (${tWins}-${cWins})`);

  // Themed duel report — shown to everyone; it sits above the win screen until dismissed.
  const skimMsg = skim > 0 ? `<br>Host-skim: <b>−${skim} tiles</b> — corruption ate the army` : '';
  const moonMsg = inMoon ? '<br>🌙 <b>MOON BAND</b> — jackpot spike!' : '';
  const fallenMsg = (fallenForTyrant || fallenForCon)
    ? `<br>Fallen votes: +${fallenForCon} conspirator · +${fallenForTyrant} Tyrant` : '';
  tyrantModal({
    type: 'THE RECKONING',
    title: tWins >= 2 ? '🦠 THE TYRANT PREVAILS' : '⚔️ THE TYRANT FALLS',
    body: `<b>${G.factions[conspirator].name}</b> challenges the Tyrant in the final duel.<br><br>` +
          `Tyrant Essence <b>${tEssence}</b> · Conspirator Essence <b>${cEssence}</b>` +
          skimMsg + moonMsg + fallenMsg +
          `<br><br><span style="font-family:monospace; font-size:12px;">${rounds.join('<br>')}</span>` +
          `<br><br><b>${winner} wins the Reckoning!</b>`,
    confirmLabel: 'SO BE IT',
    cancelLabel: null,
  });

  return tWins >= 2;
}

// ============================================================
// NAV
// ============================================================
function showTitle() {
  if (typeof resetNet === 'function') resetNet();
  document.getElementById('conquest-overlay')?.classList.remove('show');
  switchScreen('title-screen');
  document.getElementById('rules-btn').style.display = 'none';
}

function showSetup() {
  if (typeof resetNet === 'function') resetNet();
  document.getElementById('conquest-overlay')?.classList.remove('show');
  switchScreen('setup-screen');
  G = {};
  renderSetup();
}

function switchScreen(id) {
  // Each screen's ID rule sets display:flex/grid, which outranks `.screen{display:none}`
  // (ID beats class). So we can't rely on the class alone — set inline display:none on
  // inactive screens (inline wins over any selector) and clear it on the active one so its
  // CSS display takes over. Without this, the setup + lobby screens stack on top of each other.
  document.querySelectorAll('.screen').forEach(s => {
    if (s.id === id) { s.classList.add('active'); s.style.display = ''; }
    else { s.classList.remove('active'); s.style.display = 'none'; }
  });
}

// ============================================================
// SETUP — one card per faction; each is HUMAN (pass-and-play) or AI
// ============================================================
function defaultSetup() {
  const seats = {};
  Object.keys(FACTIONS).forEach((k, i) => {
    seats[k] = (i === 0)
      ? { type:'human', name:'', trait:'' }   // first faction starts as the lone human
      : { type:'ai',    name:'', trait:'' };
  });
  return { seats, tyrant: false };
}

function toggleTyrant() { G.setup.tyrant = !G.setup.tyrant; renderSetup(); }

function renderSetup() {
  if (!G.setup) G.setup = defaultSetup();
  const grid = document.getElementById('setup-grid');
  grid.innerHTML = Object.entries(FACTIONS).map(([k, f]) => {
    const s = G.setup.seats[k];
    const human = s.type === 'human';
    return `
      <div class="setup-card" style="border-color:${f.color}">
        <h3 style="color:${f.color}; border-color:${f.color}">${f.icon} ${f.name}</h3>
        <div class="seat-toggle">
          <div class="seat-opt ${human?'selected':''}"  onclick="setSeatType('${k}','human')">🎮 HUMAN</div>
          <div class="seat-opt ${!human?'selected':''}" onclick="setSeatType('${k}','ai')">🤖 AI</div>
        </div>
        <div style="display:${human?'block':'none'}">
          <label>CALLSIGN</label>
          <input class="input-field" maxlength="16" placeholder="Player name..."
                 value="${(s.name||'').replace(/"/g,'&quot;')}"
                 oninput="setSeatName('${k}', this.value)">
          <label>PASSIVE TRAIT</label>
          <div class="trait-select">
            ${TRAITS.filter(t => !(TRAIT_EXCLUSIONS[k]||[]).includes(t.id)).map(t=>`
              <div class="trait-option ${s.trait===t.id?'selected':''}" onclick="setSeatTrait('${k}','${t.id}')">
                <strong>${t.name}:</strong> ${t.desc}
              </div>`).join('')}
          </div>
        </div>
        <div style="display:${human?'none':'block'}; font-size:12px; color:#888; margin-top:8px; line-height:1.5;">
          🤖 Computer-controlled · random trait · same event deck & dice as everyone. No handicaps.
        </div>
      </div>`;
  }).join('') + `
      <div class="setup-card" style="grid-column:1/-1; border-color:${TYRANT_DEF.color}; cursor:pointer;" onclick="toggleTyrant()">
        <h3 style="color:${TYRANT_DEF.color}; border-color:${TYRANT_DEF.color}">${TYRANT_DEF.icon} THE TYRANT</h3>
        <div style="display:flex; align-items:center; gap:12px;">
          <div class="seat-opt ${G.setup.tyrant?'selected':''}" style="flex:0 0 130px;">${G.setup.tyrant?'☠ INCLUDED':'+ ADD TYRANT'}</div>
          <div style="font-size:12px; color:#bbb; line-height:1.5;">
            A permanent AI that festers at the center and <strong>spreads like a virus</strong>. It wins normally —
            or by making a (secret) pact with <em>every</em> surviving player. Ally with it, use it, or unite to burn it out.
          </div>
        </div>
      </div>`;
  checkReady();
}

function setSeatType(fk, type) {
  G.setup.seats[fk].type = type;
  renderSetup();           // re-render to reveal/hide the human fields
}
function setSeatName(fk, val) {
  G.setup.seats[fk].name = val;
  checkReady();            // no re-render — keep input focus while typing
}
function setSeatTrait(fk, id) {
  G.setup.seats[fk].trait = id;
  renderSetup();
}

// What's stopping deployment? Returns a human-readable list (empty = ready).
function setupMissing() {
  const humans = Object.entries(G.setup.seats).filter(([, s]) => s.type === 'human');
  const out = [];
  if (humans.length < 1) out.push('Set at least one faction to HUMAN');
  humans.forEach(([k, s]) => {
    if (!s.name.trim()) out.push(`${FACTIONS[k].name}: enter a name`);
    if (!s.trait)       out.push(`${FACTIONS[k].name}: pick a passive trait`);
  });
  return out;
}

function checkReady() {
  // DEPLOY stays clickable so a tap can explain what's missing instead of failing silently.
  const btn = document.getElementById('start-btn');
  if (btn) btn.disabled = false;
  const status = document.getElementById('setup-status');
  if (!status) return;
  const missing = setupMissing();
  if (missing.length) {
    status.className = 'setup-status warn';
    status.innerHTML = '⚠️ <b>To deploy:</b> ' + missing.map(m => `<span>${m}</span>`).join('');
  } else {
    status.className = 'setup-status ok';
    status.textContent = '✓ All set — tap DEPLOY!';
  }
}

// ============================================================
// GAME INIT
// ============================================================
function startGame() {
  // Block deploy with a clear reason rather than silently doing nothing.
  const missing = setupMissing();
  if (missing.length) {
    const status = document.getElementById('setup-status');
    if (status) {
      status.className = 'setup-status warn';
      status.innerHTML = '⛔ <b>Can\'t deploy yet:</b> ' + missing.map(m => `<span>${m}</span>`).join('');
      if (status.scrollIntoView) status.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    return;
  }
  const seats = G.setup.seats;
  const order = shuffle(Object.keys(FACTIONS));  // randomized turn order for fairness

  const factions = {};
  order.forEach(k => {
    const s = seats[k];
    factions[k] = (s.type === 'human')
      ? mkFaction(s.name.trim() || FACTIONS[k].name, k, false, s.trait || randTrait(k))
      : mkFaction('NEXUS-'+k.slice(0,3).toUpperCase(), k, true, randTrait(k));
  });

  const turnOrder = order.slice();
  // The Tyrant joins as a permanent AI, taking its turn last.
  if (G.setup.tyrant) {
    factions[TYRANT_KEY] = mkFaction(TYRANT_DEF.name, TYRANT_KEY, true, randTrait(TYRANT_KEY));
    turnOrder.push(TYRANT_KEY);
  }

  G = {
    round: 1,
    signalJam: false,
    currentTurnIdx: 0,
    actionsUsed: 0,
    factions,
    turnOrder,
    humans: order.filter(k => seats[k].type === 'human'),
    tyrantOn: !!G.setup.tyrant,
    tyrantHarbor: 0,        // round the harbor reprieve expires (0 = not harbored)
    tyrantLastOffer: {},    // fk -> round the Tyrant last offered them a pact
    tyrantStruck: {},       // Step 3: fk -> last round it drew blood on the Tyrant (coalition surge)
    tyrantConquest: false,  // Part 2: Tyrant switched from diplomacy to conquest
    nodesHeldSince: {},     // fk -> round they first held 3+ nodes (for 2-round win check)
    tiles: {},
    log: [],
    pacts: {},     // pairKey -> round formed
    grudges: {},   // "victim>betrayer" -> round it expires after
    playerFaction: order[0],  // local "acting/viewing" faction; repointed each human turn
  };
  gameOver = false;
  G.tiles = buildMap();

  // Hot-seat: this one device controls every human seat. (Online will narrow this.)
  mySeats = G.humans.slice();
  G.playerFaction = G.humans[0] || order[0];

  switchScreen('game-screen');
  document.getElementById('rules-btn').style.display = 'flex';
  renderMap();
  renderSidebar();
  startRound();
}

function mkFaction(name, key, isAI, trait) {
  const def = factionDef(key);
  return { name, icon: def.icon, color: def.color,
           ability: def.ability, isAI, trait, resources: 4, eliminated: false,
           isTyrant: key === TYRANT_KEY,
           corruption: 0, boon: null };
}

function randTrait(fk) {
  const pool = fk ? TRAITS.filter(t => !(TRAIT_EXCLUSIONS[fk]||[]).includes(t.id)) : TRAITS;
  return pool[Math.floor(Math.random()*pool.length)].id;
}

// ============================================================
// MAP BUILD
// ============================================================
// Symmetric node positions on the GRIDxGRID board: one node near each corner
// (so every faction has a nearby objective) + a contested central node.
const _Q = 1, _MID = Math.floor((GRID - 1) / 2);
const NODE_POSITIONS = {
  node_power:   { row: _Q,          col: _Q          },  // NW quadrant
  node_water:   { row: _Q,          col: GRID-1-_Q   },  // NE quadrant
  node_transit: { row: _MID,        col: _MID        },  // center (contested)
  node_comms:   { row: GRID-1-_Q,   col: _Q          },  // SW quadrant
  node_data:    { row: GRID-1-_Q,   col: GRID-1-_Q   },  // SE quadrant
};

// Each faction starts in a corner with 2 adjacent tiles, mirrored across the board.
const START_CORNERS = [
  { tiles: [{row:0,col:0},{row:0,col:1}],               label:'NW' },
  { tiles: [{row:0,col:GRID-1},{row:1,col:GRID-1}],     label:'NE' },
  { tiles: [{row:GRID-1,col:0},{row:GRID-2,col:0}],     label:'SW' },
  { tiles: [{row:GRID-1,col:GRID-1},{row:GRID-1,col:GRID-2}], label:'SE' },
];

function buildMap() {
  const tiles = {};

  // 1. Lay down all GRID*GRID cells as neutral districts first.
  //    Shuffle district NAMES only (cosmetic), positions stay fixed.
  const districtNames = shuffle([...DISTRICT_NAMES]);
  let dn = 0;
  for (let r=0; r<GRID; r++) for (let c=0; c<GRID; c++) {
    const id = `tile_${r}_${c}`;
    const name = districtNames[dn++ % districtNames.length];
    tiles[id] = { id, name, short:name.slice(0,6), isNode:false,
                  row:r, col:c, owner:null, troops:0, heldRounds:0 };
  }

  // 2. Stamp the 5 nodes onto their fixed symmetric positions.
  for (const [nodeId, pos] of Object.entries(NODE_POSITIONS)) {
    const def = NODE_TILES.find(n => n.id === nodeId);
    const id = `tile_${pos.row}_${pos.col}`;
    tiles[id] = { ...def, id, nodeId, row:pos.row, col:pos.col, owner:null, troops:0, heldRounds:0 };
  }

  // 3. Assign each NORMAL faction a symmetric corner (randomized for fairness).
  const corners = shuffle([...START_CORNERS]);
  const normals = Object.keys(G.factions).filter(k => k !== TYRANT_KEY);
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

  // 3b. The Tyrant festers at the heart of Nexus — it seizes the central Node.
  if (G.factions[TYRANT_KEY]) {
    const cId = `tile_${_MID}_${_MID}`;
    if (tiles[cId]) { tiles[cId].owner = TYRANT_KEY; tiles[cId].troops = 4; }
  }

  // Stamp each tile with its cardinal region (used by region-targeted events).
  Object.values(tiles).forEach(t => { t.region = regionOf(t); });

  return tiles;
}

function shuffle(a) {
  for (let i=a.length-1; i>0; i--) {
    const j = Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

// ============================================================
// RENDER
// ============================================================
function renderMap() {
  const grid = document.getElementById('hex-grid');
  grid.innerHTML = '';
  // Flat-top hexes tile in COLUMNS; odd columns are shifted down half a tile.
  const cols = Array.from({length: GRID}, () => []);
  Object.values(G.tiles).forEach(t => cols[t.col].push(t));
  cols.forEach(c => c.sort((a,b)=>a.row-b.row));

  cols.forEach((col, ci) => {
    const colEl = document.createElement('div');
    colEl.className = 'hex-col' + (ci%2===1 ? ' down' : '');
    col.forEach(tile => colEl.appendChild(makeHex(tile)));
    grid.appendChild(colEl);
  });

  fitBoard();
  if (tutorialMode) tutorialReposition();   // keep the spotlight aligned after a board re-render
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fitBoard);   // after layout settles
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && !window.__fitResize) {
    window.__fitResize = true;
    window.addEventListener('resize', () => { fitBoard(); tutorialReposition(); });
    // Mobile: re-fit after an orientation flip / address-bar resize once layout settles.
    window.addEventListener('orientationchange', () => setTimeout(() => { fitBoard(); tutorialReposition(); }, 250));
  }
}

// Scale the whole board so it always fits its area — no scrolling, as large as possible.
function fitBoard() {
  const area = document.getElementById('map-area');
  const grid = document.getElementById('hex-grid');
  if (!area || !grid || typeof grid.offsetWidth !== 'number') return;
  const bw = grid.offsetWidth, bh = grid.offsetHeight;   // layout size (unaffected by transform)
  if (!bw || !bh) return;
  const aw = area.clientWidth - 20, ah = area.clientHeight - 20;
  if (aw <= 0 || ah <= 0) return;
  const s = Math.max(0.2, Math.min(aw / bw, ah / bh));
  grid.style.transform = `translate(-50%,-50%) scale(${s.toFixed(3)})`;
}

function makeHex(tile) {
  const div = document.createElement('div');
  div.className = 'hex';
  div.id = 'hex-'+tile.id;
  div.onclick = () => handleTileClick(tile.id);

  // Owned non-node tiles wear their faction's themed frame; nodes use their badge art.
  const showFrame = !!(tile.owner && !tile.isNode && FACTION_IMAGES[tile.owner]);
  // Unclaimed tiles are semi-transparent so the cardinal-zone backdrop shows through.
  const fillColor = showFrame ? 'rgba(18,18,28,0.55)'
                  : (tile.owner ? G.factions[tile.owner].color : 'rgba(20,20,32,0.45)');
  const strokeW   = tile.isNode ? 3.5 : 2;
  const strokeC   = tile.isNode ? '#f1c40f' : 'rgba(0,0,0,0.6)';

  const entrench = Math.min(tile.heldRounds||0, 3);
  const entrenchPips = entrench>0 && tile.owner
    ? `<div class="hex-entrench" title="Dug in +${entrench}">${'🛡️'.repeat(entrench)}</div>` : '';

  const reg = tile.region;
  const regTag = (reg && reg !== 'C')
    ? `<div class="hex-region" style="color:${REGION_COLORS[reg]}" title="${REGION_NAMES[reg]} region">${reg}</div>` : '';
  // Node artwork badge — owner-colored glow shows ownership; the owner-fill hex behind it reads as a ring.
  let nodeArt = '';
  if (tile.isNode && NODE_IMAGES[tile.nodeId]) {
    const glow = tile.owner
      ? `drop-shadow(0 0 5px ${G.factions[tile.owner].color}) drop-shadow(0 0 2px ${G.factions[tile.owner].color})`
      : 'drop-shadow(0 0 3px rgba(0,0,0,0.65))';
    nodeArt = `<img class="hex-node-art" src="${NODE_IMAGES[tile.nodeId]}" alt="" draggable="false" style="filter:${glow}">`;
  }

  let factionArt = '';
  if (showFrame) {
    const oc = G.factions[tile.owner].color;
    factionArt = `<img class="hex-faction-art" src="${FACTION_IMAGES[tile.owner]}" alt="" draggable="false" style="filter:drop-shadow(0 0 4px ${oc})">`;
  }

  const HEX = '25,2 75,2 98,43.5 75,85 25,85 2,43.5';   // flat-top hexagon
  const hideLabel = tile.isNode && NODE_IMAGES[tile.nodeId];  // art tiles need no text
  div.innerHTML = `
    <svg viewBox="0 0 100 87" xmlns="http://www.w3.org/2000/svg">
      <polygon points="${HEX}" fill="${fillColor}" stroke="${strokeC}" stroke-width="${strokeW}"/>
      ${entrench>0 && tile.owner ? `<polygon points="${HEX}"
        fill="none" stroke="#ffffff" stroke-width="${entrench}" opacity="0.35"/>` : ''}
    </svg>
    ${factionArt}
    ${nodeArt}
    ${entrench>0 && tile.owner ? `<div class="hex-dug" style="opacity:${(0.16*entrench).toFixed(2)}"></div>` : ''}
    <div class="hex-label">${hideLabel ? '' : tile.short}</div>
    ${tile.troops>0 ? `<div class="hex-troops">${tile.troops}</div>` : ''}
    ${regTag}
    ${entrenchPips}
  `;

  if (selectedTile === tile.id) div.classList.add('selected');
  if (G.eventRegion && reg === G.eventRegion) div.classList.add('region-active');
  return div;
}

function refreshHex(id) {
  const old = document.getElementById('hex-'+id);
  if (!old) return;
  const n = makeHex(G.tiles[id]);
  if (selectedTile===id) n.classList.add('selected');
  old.replaceWith(n);
}

// Brief red pulse on a tile so a troop loss (sabotage / casualty) is impossible to miss.
function flashHex(id) {
  const el = document.getElementById('hex-'+id);
  if (!el) return;
  el.classList.remove('hit-flash');
  void el.offsetWidth;            // restart the animation if it's already mid-flight
  el.classList.add('hit-flash');
}

function renderSidebar() {
  // Factions
  document.getElementById('faction-status').innerHTML =
    Object.entries(G.factions).map(([k,f]) => {
      const tiles = Object.values(G.tiles).filter(t=>t.owner===k).length;
      const nodes = Object.values(G.tiles).filter(t=>t.owner===k&&t.isNode).length;
      const isActive = k===activeFk();
      const isMe = mySeats.includes(k);
      // Each faction's row sits in its themed card frame (9-slice via border-image).
      return `
        <div class="faction-row card-framed" style="
          border-image: url('${FACTION_CARDS[k]}') ${FACTION_CARD_SLICE[k]||80} fill / 12px stretch;
          ${isActive?`box-shadow: 0 0 12px ${f.color}aa; filter:brightness(1.12);`:''}
          ${f.eliminated?'opacity:0.35; filter:grayscale(0.7);':''}
        ">
          <div class="fr-scrim">
            <div class="faction-dot" style="background:${f.color}"></div>
            <div style="flex:1">
              <div style="font-family:'Bangers'; font-size:13px; letter-spacing:1px; color:${f.color}">
                ${f.icon} ${f.name} ${f.isAI?'(AI)':'(HUMAN)'}${isMe?' 👤':''}${isActive?' ◄ TURN':''}
              </div>
              <div class="faction-row-sub">${tiles} tiles · ${nodes}★ nodes · ${f.resources} res ${f.eliminated?'· DEAD':''}</div>
            </div>
          </div>
        </div>`;
    }).join('');

  // Nodes — show the static 5, plus GRAVEYARD only once it has spawned (Tyrant slain).
  document.getElementById('node-list').innerHTML = NODE_TILES.map(n => {
    const t = Object.values(G.tiles).find(t=>t.nodeId===n.id);
    if (!t) return '';   // GRAVEYARD won't have a tile until the Tyrant dies
    const owner = t.owner ? G.factions[t.owner] : null;
    return `
      <div class="node-item" style="border-left:4px solid ${owner?owner.color:'#333'}; flex-direction:column; align-items:stretch; gap:2px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span>${n.name}</span>
          <span style="color:${owner?owner.color:'#555'}; font-weight:900; font-size:10px;">
            ${owner?owner.name:'—'}
          </span>
        </div>
        <span style="font-size:9px; color:#888; letter-spacing:0.5px;">${NODE_BONUSES[n.id]}</span>
      </div>`;
  }).join('');

  // Resources
  const f = G.factions[G.playerFaction];
  document.getElementById('resources-display').innerHTML = `
    <div class="res-chip">🔋 ${f.resources} RES</div>
    <div class="res-chip">🏠 ${tilesOf(G.playerFaction).length} TILES</div>
    <div class="res-chip">⭐ ${countNodes(G.playerFaction)}/3 TO WIN</div>
    <div class="res-chip" style="font-size:11px; border-color:#444;">🎭 ${TRAITS.find(t=>t.id===f.trait)?.name||''}</div>
  `;

  // Quick-reference: your faction's ability + perk
  const refAb = document.getElementById('ref-ability');
  if (refAb) refAb.innerHTML = `<strong>YOU (${FACTIONS[G.playerFaction].name}):</strong> ${FACTIONS[G.playerFaction].perk}`;

  // Diplomacy — all pacts are secret, shown only to the two parties. Tyrant pact COUNT is public.
  const dipEl = document.getElementById('diplomacy-list');
  if (dipEl) {
    const viewer = G.playerFaction;
    const rows = [];
    let hiddenPacts = 0;
    for (const k of Object.keys(G.pacts||{})) {
      const [a,b] = k.split('|');
      if (!G.factions[a] || !G.factions[b]) continue;
      if (!pactVisibleTo(a, b, viewer)) { hiddenPacts++; continue; }
      rows.push(`🤝 ${G.factions[a].icon} ${G.factions[a].name} ↔ ${G.factions[b].icon} ${G.factions[b].name}`);
    }
    for (const k of Object.keys(G.grudges||{})) {
      if (G.grudges[k] < G.round) continue;
      const [v,br] = k.split('>');
      if (!G.factions[v] || !G.factions[br]) continue;
      if (!pactVisibleTo(v, br, viewer)) continue;
      rows.push(`🗡️ ${G.factions[v].icon} ${G.factions[v].name} grudge → ${G.factions[br].icon} ${G.factions[br].name}`);
    }
    if (hiddenPacts > 0)
      rows.push(`<span style="opacity:0.6">🔒 ${hiddenPacts} other pact${hiddenPacts>1?'s':''} in Nexus</span>`);
    if (tyrantAlive()) {
      const tp = tyrantAllies().length;   // pacts with LIVING rivals only
      const need = livingKeys().filter(k=>k!==TYRANT_KEY).length;
      const left = need - tp;
      const cap = tyrantPactCap();
      if (cap < need) {
        rows.push(`<span style="color:${TYRANT_DEF.color}; font-weight:700">🦠 TYRANT holds <b>${tp}</b>/${cap} pacts (capped — it cannot win Nexus by diplomacy alone)</span>`);
      } else {
        rows.push(`<span style="color:${TYRANT_DEF.color}; font-weight:700">🦠 TYRANT has <b>${tp}</b> pact${tp!==1?'s':''} of <b>${need}</b> needed to win${left>0?` — ${left} more to go`:' — ⚠️ WINNING!'}</span>`);
      }
    }
    dipEl.innerHTML = rows.length
      ? rows.map(r=>`<div class="faction-row-sub" style="padding:2px 0">${r}</div>`).join('')
      : `<div class="faction-row-sub" style="opacity:0.6">No active pacts or grudges.</div>`;
  }

  renderLog();   // keep the bottom feed current (incl. when loading remote online state)
  renderPlayerStats();
}

// Your own live stats, rendered right alongside the action buttons.
function renderPlayerStats() {
  const el = document.getElementById('player-stats');
  if (!el) return;
  const fk = G.playerFaction;
  const f  = G.factions && G.factions[fk];
  if (!f) { el.innerHTML = ''; return; }
  const tiles = Object.values(G.tiles).filter(t=>t.owner===fk);
  const nodes = tiles.filter(t=>t.isNode).length;
  const myTurn = (typeof activeFk==='function') && activeFk()===fk && !f.isAI;
  const actsLeft = Math.max(0, 3 - (G.actionsUsed||0));

  // Pacts visible to me (Tyrant deals stay secret unless I'm in them).
  const partners = [];
  for (const k of Object.keys(G.pacts||{})) {
    const [a,b] = k.split('|');
    if (a!==fk && b!==fk) continue;
    const other = a===fk ? b : a;
    if (!G.factions[other]) continue;
    partners.push(`${G.factions[other].icon} ${G.factions[other].name}`);
  }
  const pactChip = partners.length
    ? `<span class="ps-chip ps-pacts" title="Active non-aggression pacts">🤝 ${partners.join(', ')}</span>`
    : `<span class="ps-chip" style="opacity:0.6">🤝 no pacts</span>`;

  const actsChip = myTurn
    ? `<span class="ps-chip ps-acts ${actsLeft===0?'spent':''}" title="Actions left this turn">⚡ Actions <b>${actsLeft}</b>/3</span>`
    : `<span class="ps-wait">⏳ ${f.isAI?'(AI seat)':'waiting for your turn'}</span>`;

  // Part 2: corruption band — self-visible only (your own faction), Tyrant-on only
  let corruptChip = '';
  if (tyrantOn() && fk === G.playerFaction && fk !== TYRANT_KEY && (f.corruption || 0) > 0) {
    const band = corruptionBand(f.corruption);
    const colors = ['#8b949e','#9b59b6','#e74c3c','#ff0000'];
    corruptChip = `<span class="ps-chip" style="color:${colors[band.tier]}" title="Your corruption level (secret)">🦠 <b>${band.label}</b></span>`;
  }

  el.innerHTML = `
    <span class="ps-name" style="color:${f.color}">${f.icon} ${f.name}</span>
    <span class="ps-chip" title="Tiles you hold">▦ Tiles <b>${tiles.length}</b></span>
    <span class="ps-chip" title="★ Nodes you control (need 3 to win)">★ Nodes <b>${nodes}</b>/5</span>
    <span class="ps-chip" title="Resources on hand">🎒 Res <b>${f.resources}</b></span>
    ${actsChip}
    ${pactChip}
    ${corruptChip}
  `;
}

function addLog(msg) {
  if (!G.log) G.log = [];
  G.log.push(msg);                 // newest at the end
  if (G.log.length > 10) G.log.shift();   // tail the last 10
  renderLog();
}

function renderLog() {
  const el = document.getElementById('event-log');
  if (!el) return;
  const log = G.log || [];
  const n = log.length;
  el.innerHTML = log.map((m, i) => {
    const op = n <= 1 ? 1 : Math.max(0.4, 0.45 + 0.55 * (i / (n - 1)));  // older → dimmer
    return `<span class="log-chip" style="opacity:${op.toFixed(2)}">${m}</span>`;
  }).join('');
  el.scrollTop = el.scrollHeight;  // newest line is at the bottom — keep it in view
}

function setActionLog(msg) {
  document.getElementById('action-log').textContent = msg;
}

// ============================================================
// TURN ENGINE
// ============================================================
const TRIBUTE_INTERVAL = 3;  // Tyrant tribute falls due every 3 rounds of a pact
const TRIBUTE_COST     = 2;

function startRound() {
  G.currentTurnIdx = 0;
  signalJamActive = false;
  totalWar = false;
  const tributeQueue = [];   // local human seats owing tribute — prompted via themed modal below
  // Entrenchment: tiles held with 2+ troops dig in deeper each round
  Object.values(G.tiles).forEach(t => {
    if (t.owner && t.troops >= 2) t.heldRounds = Math.min((t.heldRounds||0) + 1, t.isNode ? 2 : 3);
    else t.heldRounds = 0;
  });
  // Diplomacy upkeep: pacts lapse after 4 rounds (Tyrant deals are durable until betrayed),
  // grudges cool off when their timer passes
  for (const k of Object.keys(G.pacts)) {
    const [a,b] = k.split('|');
    if (a===TYRANT_KEY || b===TYRANT_KEY) continue;
    if (G.round - G.pacts[k] >= 4) {
      if (!G.pactRenewals) G.pactRenewals = {};
      if (G.pactRenewals[k]) continue;   // renewal vote already pending — pact holds in the meantime
      const humanParties = [a,b].filter(x => G.factions[x] && !G.factions[x].isAI && !G.factions[x].eliminated);
      if (!humanParties.length) {        // AI↔AI: lapse silently, as before
        delete G.pacts[k]; addLog('📜 A non-aggression pact has lapsed');
        continue;
      }
      // Queue a renewal vote: AI parties decide now, humans get a popup (modal below / on sync).
      const votes = {};
      for (const x of [a,b]) if (G.factions[x].isAI) votes[x] = aiConsiderPact(x, x===a ? b : a);
      G.pactRenewals[k] = { round: G.round, votes };
      addLog('📜 A non-aggression pact is up for renewal…');
    }
  }
  for (const k of Object.keys(G.grudges)) { if (G.grudges[k] < G.round) delete G.grudges[k]; }

  // Tyrant harbor reprieve: revive if fed, perish if the 3 rounds lapse, else let AI allies donate.
  if (G.tyrantHarbor && tyrantOn()) {
    if (tilesOf(TYRANT_KEY).length > 0) {
      G.tyrantHarbor = 0;
    } else if (G.round > G.tyrantHarbor) {
      G.factions[TYRANT_KEY].eliminated = true; G.tyrantHarbor = 0;
      addLog('💀 THE TYRANT perished — no ally harbored it in time.');
    } else {
      for (const a of tyrantAllies()) {
        if (G.factions[a].isAI && aiHarborDecision(a)) {
          const t = tilesOf(a).sort((x,y)=>x.troops-y.troops)[0];
          if (t) { t.owner=TYRANT_KEY; t.troops=Math.max(1,t.troops); t.heldRounds=0; G.tyrantHarbor=0;
            addLog(`🦠 ${G.factions[a].name} harbored the Tyrant — it rises again!`); break; }
        }
      }
    }
  }
  // Part 2: Tyrant mechanics (skim, tribute, corruption, tithe)
  if (tyrantAlive()) {
    // Standing imbalance: Tyrant skims 1 troop from each ally's weakest tile
    for (const k of livingKeys()) {
      if (k === TYRANT_KEY || !hasPact(TYRANT_KEY, k)) continue;
      const myTiles = tilesOf(k).filter(t => t.troops >= 2);
      if (myTiles.length > 0) {
        const weakest = myTiles.reduce((a, b) => a.troops <= b.troops ? a : b);
        weakest.troops--;
        addLog(`🦠 The Tyrant skims a troop from ${G.factions[k].name} (${weakest.name})`);
        refreshHex(weakest.id);
      }
    }
    // Tribute: every 3 rounds while allied, pay 2 resources or +2 corruption
    for (const k of livingKeys()) {
      if (k === TYRANT_KEY) continue;
      if (!hasPact(TYRANT_KEY, k)) continue;
      const pactRound = G.pacts[pairKey(TYRANT_KEY, k)];
      const elapsed = G.round - pactRound;
      if (elapsed > 0 && elapsed % TRIBUTE_INTERVAL === 0) {
        const f = G.factions[k];
        const local = !f.isAI && (!online || mySeats.includes(k));
        if (local && f.resources >= TRIBUTE_COST) {
          tributeQueue.push(k);   // local human with the coin: ask via the Tyrant modal below
        } else if (f.resources >= TRIBUTE_COST) {
          // AI (and remote humans, whose devices can't be prompted from here) pay if able
          f.resources -= TRIBUTE_COST;
          addLog(`🦠 ${f.name} pays tribute to the Tyrant (−${TRIBUTE_COST} res)`);
        } else {
          f.corruption = (f.corruption || 0) + 2;
          addLog(`🦠 ${f.name} can't pay tribute — corruption surges!`);
        }
      }
    }
  // corruption tick — each Tyrant ally sinks deeper, but slowly: +1 every 2 rounds bound
  // (first tick delayed to 2 rounds in). Slower accrual keeps the bargain survivable.
    for (const k of livingKeys()) {
      if (k === TYRANT_KEY) continue;
      if (!hasPact(TYRANT_KEY, k)) continue;
      const cPactRound = G.pacts[pairKey(TYRANT_KEY, k)];
      const cElapsed = G.round - cPactRound;
      if (cElapsed > 0 && cElapsed % 2 === 0) {
        G.factions[k].corruption = (G.factions[k].corruption || 0) + 1;
      }
    }
    // (Tithe is now applied at each bound faction's turn-start, when they pick TITHE on the
    // per-round bargain modal — not in a round-start sweep. Sic likewise: each bound faction
    // picks at their turn-start, the Tyrant reads .boon === 'sic' when it acts later.)
    // Per-round boon reset: clear last round's choice so each bound faction must pick again.
    for (const k of livingKeys()) {
      if (k === TYRANT_KEY) continue;
      if (hasPact(TYRANT_KEY, k)) G.factions[k].boon = null;
    }
  }
  document.getElementById('phase-label').textContent = `ROUND ${G.round}`;
  processTributeQueue(tributeQueue, fireRoundEvent);
  maybeShowPactRenewals();
}

// Sequentially ask each local human owing tribute via the Tyrant-themed modal, then continue.
function processTributeQueue(queue, done) {
  if (!queue.length) { done(); return; }
  const k = queue.shift();
  const f = G.factions[k];
  tyrantModal({
    type: "THE TYRANT'S DUE",
    title: '🦠 TRIBUTE DEMANDED',
    body: `The Tyrant turns its gaze on <b>${f.name}</b> and demands its due: <b>${TRIBUTE_COST} resources</b>.<br><br>` +
          `Pay — or refuse, and feel the <span style="color:#d98fd9;">corruption surge (+2)</span> through your ranks.`,
    confirmLabel: `💰 PAY ${TRIBUTE_COST} RES`,
    cancelLabel: '🩸 REFUSE',
    onConfirm: () => {
      f.resources = Math.max(0, f.resources - TRIBUTE_COST);
      addLog(`🦠 ${f.name} pays tribute to the Tyrant (−${TRIBUTE_COST} res)`);
      renderSidebar(); syncPush();
      processTributeQueue(queue, done);
    },
    onCancel: () => {
      f.corruption = (f.corruption || 0) + 2;
      addLog(`🦠 ${f.name} refused tribute — corruption surges!`);
      renderSidebar(); syncPush();
      processTributeQueue(queue, done);
    },
  });
}

// Draw and apply/show the round's event card (runs once any tribute prompts resolve).
function fireRoundEvent() {
  const evIdx = Math.floor(Math.random()*EVENTS.length);
  const ev = EVENTS[evIdx];
  const reg = ev.region ? nextRegion() : null;   // regional events draw from the even-distribution bag
  G.eventRegion = reg;
  // Record the event so EVERY client can display the card (not just the driver).
  G.eventCard = { type: ev.type, title: ev.title, body: ev.body, reg, n: (G.eventN = (G.eventN || 0) + 1), evIdx };
  lastShownEventN = G.eventCard.n;   // the driver shows its own card below; don't re-show on echo
  if (ev.choices) {
    if (online) {
      // Online: AI resolves immediately on driver; humans choose on their own devices
      Object.keys(G.factions).filter(k => G.factions[k].isAI && !G.factions[k].eliminated)
        .forEach(k => { ev.choices[ev.aiChoose ? ev.aiChoose(k) : 0].resolve(k); });
      const pendingHumans = G.humans.filter(k => !G.factions[k].eliminated);
      G.pendingChoiceEvent = { evIdx, choicesMade: {}, pending: pendingHumans };
      renderMap(); renderSidebar();
      syncPush();
      showOnlineChoiceUI();
    } else {
      syncPush();
      showChoiceEvent(ev, () => { renderMap(); renderSidebar(); doNextTurn(); });
    }
  } else {
    ev.apply(reg);
    renderMap();
    renderSidebar();
    syncPush();   // broadcast applied effect + event card
    showEventCard(ev, () => doNextTurn(), reg);
  }
}

function applyIncome(fk) {
  const f = G.factions[fk];
  const nodes = countNodes(fk);
  let income = 2 + nodes * (f.trait==='hoard' ? 2 : 1);
  if (controlsNode(fk,'node_water')) income += 1;   // 💧 WATER node
  if (f.ability==='bribe')           income += 1;   // 💰 SYNDICATE cartel perk
  f.resources = Math.min(f.resources + income, RES_CAP);
  addLog(`${f.icon} ${f.name} earned +${income} res (${nodes} nodes)`);

  // 🌿 COMMUNE grassroots perk — Phase 5b: grows every OTHER round (odd only)
  if (f.ability==='rally' && G.round % 2 === 1) {
    const mine = tilesOf(fk);
    if (mine.length) {
      const front = mine.filter(t => Object.values(G.tiles).some(e=>e.owner&&e.owner!==fk&&adjacent(t,e)));
      const grow  = (front.length ? front : mine).sort((a,b)=>a.troops-b.troops)[0];
      grow.troops++; refreshHex(grow.id);
    }
  }
}

function doNextTurn() {
  if (gameOver) return;
  if (!isDriver) return;   // online: only the engine-driver advances turns
  while (G.currentTurnIdx < G.turnOrder.length && G.factions[G.turnOrder[G.currentTurnIdx]].eliminated)
    G.currentTurnIdx++;

  if (G.currentTurnIdx >= G.turnOrder.length) { endRound(); return; }

  const fk = G.turnOrder[G.currentTurnIdx];
  if (online) G.live = true;   // turns are now live — remote clients may take theirs
  G.actionsUsed = 0;       // reset the fresh turn's action budget in the SYNCED state, so remote
                           // clients don't inherit the previous player's spent actions (online race)
  applyIncome(fk);
  syncPush();              // broadcast income + whose turn (no-op offline)
  beginTurnFor(fk);
}

// Route a turn to the AI, a local human, or (online) a remote human we just watch.
function beginTurnFor(fk) {
  const f = G.factions[fk];

  if (f.isAI) {
    if (!isDriver) { disablePlayerActions(); return; }   // only the driver runs the AI
    const lbl = document.getElementById('turn-label');
    lbl.textContent = `${f.icon} AI TURN`;
    lbl.className = 'turn-indicator';
    document.getElementById('phase-label').textContent = `ROUND ${G.round} · ${f.name}`;
    setActionLog(`${f.name} is planning...`);
    disablePlayerActions();
    setTimeout(() => runAITurn(fk), online ? 400 : 500);
    return;
  }

  // Online: a remote human's turn — show a read-only "waiting" board.
  if (online && !mySeats.includes(fk)) {
    myTurnActive = false; isDriver = false;
    disablePlayerActions();
    const lbl = document.getElementById('turn-label');
    lbl.textContent = `⌛ ${f.name}`;
    lbl.className = 'turn-indicator';
    document.getElementById('phase-label').textContent = `ROUND ${G.round} · ${f.name}`;
    setActionLog(`Waiting for ${f.name} to move…`);
    renderMap(); renderSidebar();
    return;
  }

  // A local human's turn (any human in hot-seat, or my own seat online).
  G.playerFaction = fk;
  G.actionsUsed = 0;
  turnAttacks = 0; turnStrikes = {}; assaultCaptures = 0; assaultOn = false;
  G.renouncedThisTurn = {};  // Part 1: clear per-faction renounce guard
  G.siphonedThisTurn = false;  // Ghost sabotage: one siphon gain per turn
  selectedTile = null; currentAction = null;
  myTurnActive = true; isDriver = true;

  const begin = () => {
    const lbl = document.getElementById('turn-label');
    lbl.textContent = `⚡ ${f.name}`;
    lbl.className = 'turn-indicator your-turn';
    document.getElementById('phase-label').textContent = `ROUND ${G.round} · ${f.name}`;
    enablePlayerActions(fk);
    renderMap(); renderSidebar();
    setActionLog(`${f.name}: pick an action, then click a tile. 3 actions. Res: ${f.resources}`);
    if (tyrantOn()) tyrantInteract(fk);   // secret deal offer / harbor request (private to this player)
    // Pact offers are delivered the moment they sync (maybeShowPactOffer in onRemoteState);
    // this is a safety net in case that sync was missed (e.g. a refresh mid-offer).
    maybeShowPactOffer();
    maybeShowPactRenewals();
  };

  // Hot-seat with several humans on one device: gate behind a pass-the-device screen.
  if (!online && G.humans.length > 1) { disablePlayerActions(); renderSidebar(); showHandoff(fk, begin); }
  else begin();
}

// The Tyrant's private dealings with the active human: a harbor plea or a secret pact offer.
function tyrantInteract(fk) {
  if (fk === TYRANT_KEY) return;
  // 0. PER-ROUND BARGAIN: if already bound, ask what the Tyrant owes you THIS round
  //    (or whether to renounce). Replaces the old set-and-forget tithe/sic at pact formation.
  if (tyrantAlive() && hasPact(TYRANT_KEY, fk) && !G.tyrantHarbor) {
    // Don't re-prompt if a choice was already made this round (e.g., reopened mid-turn).
    if (!G.boonChosenThisRound) G.boonChosenThisRound = {};
    const key = fk + '|' + G.round;
    if (!G.boonChosenThisRound[key]) {
      showRoundBoonModal(fk);
      return;   // boon flow handles the rest (other interactions queue if needed)
    }
  }
  // 1. Harbor: a cornered Tyrant begs an ally to feed it a tile so it can rise again.
  if (G.tyrantHarbor && hasPact(TYRANT_KEY, fk) && tilesOf(TYRANT_KEY).length === 0) {
    tyrantModal({
      type: 'A CORNERED BEAST',
      title: '🦠 HARBOR THE TYRANT?',
      body: `The Tyrant is cornered and begs you — its <b>secret ally</b> — to harbor it. ` +
            `Give up one of your tiles to revive it, or let it perish?`,
      confirmLabel: '🩸 HARBOR IT',
      cancelLabel: '✋ LET IT PERISH',
      onConfirm: () => {
        const t = tilesOf(fk).sort((a,b)=>a.troops-b.troops)[0];
        if (t) { t.owner = TYRANT_KEY; t.troops = Math.max(1, t.troops); t.heldRounds = 0; G.tyrantHarbor = 0;
          addLog(`🦠 ${G.factions[fk].name} HARBORED the Tyrant — it rises again!`); refreshHex(t.id); renderSidebar(); syncPush(); }
      }
    });
    return;
  }
  // 2. Otherwise the Tyrant may offer a secret non-aggression pact — at most TWICE per
  //    player, spaced 3+ rounds apart. No offer once it has hit its concurrent-pact cap
  //    (single-human games: 3), and NONE once it has flipped to CONQUEST — a conquest Tyrant
  //    never re-instigates diplomacy. A player may still petition it (PACT action on a Tyrant
  //    tile), and it may accept; it simply never reaches out first again.
  if (tyrantAlive() && !G.tyrantConquest && !hasPact(TYRANT_KEY, fk) && !tyrantAtPactCap()) {
    if (!G.tyrantLastOffer)  G.tyrantLastOffer  = {};   // Firebase strips empty objects; rebuild defensively
    if (!G.tyrantOfferCount) G.tyrantOfferCount = {};
    const last = G.tyrantLastOffer[fk] || -99;
    if ((G.tyrantOfferCount[fk] || 0) < 2 && G.round - last >= 3) {
      G.tyrantLastOffer[fk] = G.round;
      G.tyrantOfferCount[fk] = (G.tyrantOfferCount[fk] || 0) + 1;
      showTyrantPactOffer(fk);   // custom themed modal — accept/refuse handled in callbacks
    }
  }
  // §4: Two-steps-from-victory prompt — if bound and close to triggering a win, warn
  if (tyrantAlive() && hasPact(TYRANT_KEY, fk) && (G.factions[fk].corruption || 0) > 0) {
    const corr = G.factions[fk].corruption;
    const myNodes = countNodes(fk);
    const heldSince = G.nodesHeldSince && G.nodesHeldSince[fk];
    const closeToWin = (myNodes >= 3 && heldSince !== undefined)
                    || (myNodes >= 2 && tilesOf(fk).length >= 8);
    if (closeToWin) {
      const band = corruptionBand(corr);
      tyrantModal({
        type: 'THE RECKONING IS NEAR',
        title: '⚠️ A FORK IN THE DARK',
        body: `You are close to victory — but you are <b>${band.label}</b>. ` +
              `Winning while bound forces a <b>Reckoning duel</b> against the Tyrant.<br><br>` +
              `<b>Renounce now</b> and the Tyrant lashes out and dies — but eliminated factions ` +
              `<span style="color:#d98fd9;">resurrect with a grudge against you</span>.`,
        confirmLabel: '🗡️ RENOUNCE',
        cancelLabel: '⚔️ PRESS ON',
        onConfirm: () => {
          // Trigger renounce-kill
          delete G.pacts[pairKey(fk, TYRANT_KEY)];
          G.factions[fk].boon = null;
          const rTiles = tilesOf(fk).sort((a,b) => a.troops - b.troops);
          for (let i = 0; i < Math.min(2, rTiles.length); i++) {
            const lost = Math.max(1, Math.floor(rTiles[i].troops / 2));
            rTiles[i].troops = Math.max(1, rTiles[i].troops - lost);
            refreshHex(rTiles[i].id);
          }
          addLog(`🦠💥 ${G.factions[fk].name} RENOUNCES the Tyrant before the Reckoning!`);
          tilesOf(TYRANT_KEY).forEach(t => { t.owner = null; t.troops = 0; t.heldRounds = 0; refreshHex(t.id); });
          G.factions[TYRANT_KEY].eliminated = true;
          for (const pk of Object.keys(G.pacts || {})) {
            const [pa, pb] = pk.split('|');
            if (pa === TYRANT_KEY || pb === TYRANT_KEY) {
              const ally = pa === TYRANT_KEY ? pb : pa;
              if (G.factions[ally]) G.factions[ally].boon = null;
              delete G.pacts[pk];
            }
          }
          addLog('💀 THE TYRANT is destroyed!');
          for (const [ek, ef] of Object.entries(G.factions)) {
            if (!ef.eliminated || ek === TYRANT_KEY || ek === fk) continue;
            const neutrals = Object.values(G.tiles).filter(t => !t.owner);
            if (neutrals.length === 0) continue;
            ef.eliminated = false; ef.corruption = 0; ef.resources = 3;
            const count = Math.min(2, neutrals.length);
            for (let i = 0; i < count; i++) {
              neutrals[i].owner = ek; neutrals[i].troops = 2; neutrals[i].heldRounds = 0;
              refreshHex(neutrals[i].id);
            }
            G.grudges[ek + '>' + fk] = G.round + 3;
            addLog(`👻 ${ef.name} rises — grudge against ${G.factions[fk].name}!`);
          }
          G.factions[fk].corruption = 0;
          renderMap(); renderSidebar(); syncPush();
        }
      });
    }
  }
}

// ---- Reusable Tyrant-themed confirm modal (harbor / renounce) ----
let _tyrantModalCb = null;
function tyrantModal({ type = 'THE TYRANT', title, body, confirmLabel = 'CONFIRM', cancelLabel = 'CANCEL', onConfirm, onCancel }) {
  document.getElementById('tyrant-confirm-type').textContent  = type;
  document.getElementById('tyrant-confirm-title').textContent = title;
  document.getElementById('tyrant-confirm-body').innerHTML    = body;
  document.getElementById('tyrant-confirm-ok').textContent     = confirmLabel;
  const cancelBtn = document.getElementById('tyrant-confirm-cancel');
  cancelBtn.textContent    = cancelLabel || '';
  cancelBtn.style.display  = cancelLabel ? '' : 'none';   // null/'' = info-only modal
  _tyrantModalCb = { onConfirm, onCancel };
  document.getElementById('tyrant-confirm-overlay').classList.add('show');
}
function tyrantModalConfirm() {
  const cb = _tyrantModalCb; _tyrantModalCb = null;
  document.getElementById('tyrant-confirm-overlay').classList.remove('show');
  if (cb && cb.onConfirm) cb.onConfirm();
}
function tyrantModalCancel() {
  const cb = _tyrantModalCb; _tyrantModalCb = null;
  document.getElementById('tyrant-confirm-overlay').classList.remove('show');
  if (cb && cb.onCancel) cb.onCancel();
}

// ---- Pact-offer modal (shared overlay) — used hot-seat and online ----
function pactOfferModal(from, to, { onAccept, onRefuse }) {
  const fromF = G.factions[from], toF = G.factions[to];
  tyrantModal({
    type: 'DIPLOMACY',
    title: '🤝 NON-AGGRESSION PACT?',
    body: `<b>${fromF.name}</b> proposes a non-aggression pact with <b>${toF.name}</b>.<br><br>` +
          `While it holds, neither side can attack the other. Betraying it hands the victim <b>+2</b> against the traitor.`,
    confirmLabel: '🤝 ACCEPT',
    cancelLabel: '✋ REFUSE',
    onConfirm: onAccept,
    onCancel: onRefuse,
  });
}

// ---- Pact renewal (pacts lapse after 4 rounds): each human party votes RENEW or LAPSE.
// AI parties voted at queue time (aiConsiderPact). Unanimous = renewed for another 4 rounds;
// any refusal = clean lapse, no grudge. The pact stays in force while the vote is pending.
function maybeShowPactRenewals() {
  if (!G.pactRenewals) return;
  if (document.getElementById('tyrant-confirm-overlay').classList.contains('show')) return;
  for (const k of Object.keys(G.pactRenewals)) {
    const r = G.pactRenewals[k]; r.votes = r.votes || {};   // Firebase strips empty objects
    if (!G.pacts[k]) { delete G.pactRenewals[k]; continue; }   // pact died in the meantime (betrayal/renounce)
    const [a, b] = k.split('|');
    const me = [a, b].find(x => G.factions[x] && !G.factions[x].isAI && !G.factions[x].eliminated
                             && r.votes[x] === undefined && (!online || mySeats.includes(x)));
    if (!me) { resolvePactRenewal(k); continue; }
    const other = me === a ? b : a;
    tyrantModal({
      type: 'DIPLOMACY',
      title: '📜 PACT EXPIRING',
      body: `<b>${G.factions[me].name}</b>: your non-aggression pact with <b>${G.factions[other].name}</b> has run its course.<br><br>` +
            `Renew it for another 4 rounds — or let it lapse and walk away clean (no grudge)?`,
      confirmLabel: '🤝 RENEW',
      cancelLabel: '📜 LET IT LAPSE',
      onConfirm: () => { r.votes[me] = true;  resolvePactRenewal(k); syncPush(); renderSidebar(); maybeShowPactRenewals(); },
      onCancel:  () => { r.votes[me] = false; resolvePactRenewal(k); syncPush(); renderSidebar(); maybeShowPactRenewals(); },
    });
    return;   // one modal at a time — the rest follow as each is answered
  }
}
function resolvePactRenewal(k) {
  const r = G.pactRenewals && G.pactRenewals[k];
  if (!r) return;
  const parties = k.split('|').filter(x => G.factions[x] && !G.factions[x].eliminated);
  if (!parties.every(x => (r.votes || {})[x] !== undefined)) return;   // still waiting on someone
  delete G.pactRenewals[k];
  if (parties.length >= 2 && parties.every(x => r.votes[x])) {
    G.pacts[k] = G.round;
    addLog('🤝 A non-aggression pact was renewed.');
  } else {
    delete G.pacts[k];
    addLog('📜 A non-aggression pact has lapsed');
  }
}

// Online: deliver a pending human→human pact offer to the recipient the moment it
// syncs — no waiting for their turn. Idempotent: re-invoked on every remote snapshot,
// shows nothing while another modal is up (retries on the next sync), and clears
// offers that died in transit (elimination / pact already formed).
function maybeShowPactOffer() {
  const p = G.pactProposal;
  if (!p || !online || !mySeats.includes(p.to)) return;
  if (document.getElementById('tyrant-confirm-overlay').classList.contains('show')) return;
  const fromF = G.factions[p.from], toF = G.factions[p.to];
  if (!fromF || fromF.eliminated || !toF || toF.eliminated || hasPact(p.from, p.to)) {
    G.pactProposal = null; syncPush(); renderSidebar(); return;
  }
  pactOfferModal(p.from, p.to, {
    onAccept: () => {
      formPact(p.from, p.to);
      addLog('🤝 A non-aggression pact was formed.');
      G.pactProposal = null;
      syncPush(); renderSidebar();
    },
    onRefuse: () => {
      addLog('✋ A pact proposal was refused.');
      G.pactProposal = null;
      syncPush(); renderSidebar();
    },
  });
}

// ---- Troop quantity picker (move carry / post-capture advance) ----
let _qtyCb = null;
function showQtyPicker({ title, min = 1, max, def, confirmLabel = 'CONFIRM', onPick, onCancel }) {
  const r = document.getElementById('qty-range');
  r.min = min; r.max = max; r.value = Math.max(min, Math.min(def ?? max, max));
  document.getElementById('qty-title').textContent = title;
  document.getElementById('qty-value').textContent = r.value;
  document.getElementById('qty-ok').textContent = confirmLabel;
  _qtyCb = { onPick, onCancel };
  document.getElementById('qty-overlay').classList.add('show');
}
function qtySync() {
  document.getElementById('qty-value').textContent = document.getElementById('qty-range').value;
}
function qtyAdj(d) {
  const r = document.getElementById('qty-range');
  r.value = Math.max(+r.min, Math.min(+r.max, +r.value + d));
  qtySync();
}
function qtyConfirm() {
  const cb = _qtyCb; _qtyCb = null;
  const n = +document.getElementById('qty-range').value;
  document.getElementById('qty-overlay').classList.remove('show');
  if (cb && cb.onPick) cb.onPick(n);
}
function qtyCancel() {
  const cb = _qtyCb; _qtyCb = null;
  document.getElementById('qty-overlay').classList.remove('show');
  if (cb && cb.onCancel) cb.onCancel();
}

// ---- Custom Tyrant pact offer modal (replaces system confirm dialogs) ----
let tyrantOfferFk = null;
let tyrantOfferIsPetition = false;   // true when the PLAYER came to the Tyrant

function showTyrantPactOffer(fk, petition = false) {
  tyrantOfferFk = fk;
  tyrantOfferIsPetition = !!petition;
  const body = document.getElementById('tyrant-offer-body');
  if (body) {
    body.innerHTML = petition
      ? `<b>${G.factions[fk].name}</b> comes to the Tyrant seeking a <b>secret non-aggression pact</b>. ` +
        `It grins. While the pact holds, neither of you attacks the other — and no rival will know. ` +
        `<span style="color:#d98fd9;">But your corruption festers each round you stay bound.</span>`
      : `It offers <b>${G.factions[fk].name}</b> a <b>secret non-aggression pact</b>. ` +
        `While it holds, neither of you attacks the other — and no rival will know. ` +
        `<span style="color:#d98fd9;">But your corruption festers each round you stay bound.</span>`;
  }
  document.getElementById('tyrant-overlay').classList.add('show');
}

function closeTyrantPactOffer() {
  document.getElementById('tyrant-overlay').classList.remove('show');
  tyrantOfferFk = null;
  tyrantOfferIsPetition = false;
}

function acceptTyrantPact(boon) {
  const fk = tyrantOfferFk;
  if (!fk) { closeTyrantPactOffer(); return; }
  formPact(TYRANT_KEY, fk);
  G.tyrantRefusalStreak = 0;  // pact formed — reset streak
  closeTyrantPactOffer();
  addLog('🦠 A secret pact takes hold in the shadows…');
  // Apply the initial boon choice immediately and mark it as this round's pick, so the
  // per-round bargain modal doesn't re-prompt them on the same turn. (Previously only the
  // raw .boon field was set, which silently dropped the TITHE effect once the round-start
  // sweep was removed.)
  const choice = (boon === 'sic') ? 'sic' : 'tithe';
  if (!G.boonChosenThisRound) G.boonChosenThisRound = {};
  G.boonChosenThisRound[fk + '|' + G.round] = choice;
  applyBoonChoice(fk, choice);
  renderSidebar(); syncPush();
}

// ============================================================
// PER-ROUND TYRANT BARGAIN — each round, a bound faction picks tithe/sic/refuse/renounce
// ============================================================
let _roundBoonFk = null;

function showRoundBoonModal(fk) {
  _roundBoonFk = fk;
  const f = G.factions[fk];
  const corr = f.corruption || 0;
  const band = (typeof corruptionBand === 'function') ? corruptionBand(corr) : { label: `${corr} corruption` };
  const body = document.getElementById('boon-body');
  if (body) {
    body.innerHTML =
      `<b>${f.name}</b>, you are bound to the Tyrant — <b>${band.label}</b>.<br>` +
      `Each round it offers a service. Take its gift, take nothing, or break the pact and ` +
      `<span style="color:#d98fd9;">slay the Tyrant</span>.`;
  }
  document.getElementById('boon-overlay').classList.add('show');
}

function pickRoundBoon(choice) {
  const fk = _roundBoonFk; _roundBoonFk = null;
  document.getElementById('boon-overlay').classList.remove('show');
  if (!fk || !G.factions[fk] || G.factions[fk].eliminated) return;
  if (!G.boonChosenThisRound) G.boonChosenThisRound = {};
  G.boonChosenThisRound[fk + '|' + G.round] = choice;
  applyBoonChoice(fk, choice);
  renderSidebar(); syncPush();
  // Re-enter the Tyrant turn-start flow so any FOLLOWING prompts still fire (e.g. the
  // close-to-win RECKONING IS NEAR fork). The boonChosenThisRound guard ensures the
  // per-round bargain doesn't re-prompt; the rest of tyrantInteract proceeds normally.
  // Skipped on renounce — the pact is gone, so there's nothing left to warn about.
  if (choice !== 'renounce') tyrantInteract(fk);
}

function applyBoonChoice(fk, choice) {
  const f = G.factions[fk];
  if (choice === 'tithe') {
    f.boon = 'tithe';
    // +1 troop on a frontline tile (or weakest if no frontline) — same intent as the old sweep.
    const myT = tilesOf(fk);
    if (myT.length) {
      const frontline = myT.filter(mt => Object.values(G.tiles).some(t => t.owner && t.owner !== fk && adjacent(mt, t)));
      const target = (frontline.length ? frontline : myT).reduce((a, b) => a.troops <= b.troops ? a : b);
      if (target) { target.troops += 1; refreshHex(target.id); addLog(`🩸 The Tyrant blesses ${target.name} (+1 troop) — tithe.`); }
    }
  } else if (choice === 'sic') {
    f.boon = 'sic';   // Tyrant turn reads this and lashes out at an ally-enemy
    addLog(`👹 ${f.name} sics the Tyrant on an enemy this round.`);
  } else if (choice === 'refuse') {
    f.boon = null;
    addLog(`✋ ${f.name} accepts nothing from the Tyrant this round.`);
  } else if (choice === 'renounce') {
    // Existing renounce-kill logic: break pact, wipe Tyrant, resurrect grudges.
    renounceTyrant(fk);
  }
}

// Renounce-kill (extracted from the old turn-start fork at "RECKONING IS NEAR"). Always
// available via the per-round bargain now, not just when closeToWin.
function renounceTyrant(fk) {
  delete G.pacts[pairKey(fk, TYRANT_KEY)];
  G.factions[fk].boon = null;
  const rTiles = tilesOf(fk).sort((a, b) => a.troops - b.troops);
  for (let i = 0; i < Math.min(2, rTiles.length); i++) {
    const lost = Math.max(1, Math.floor(rTiles[i].troops / 2));
    rTiles[i].troops = Math.max(1, rTiles[i].troops - lost);
    refreshHex(rTiles[i].id);
  }
  addLog(`🦠💥 ${G.factions[fk].name} RENOUNCES the Tyrant! Withdrawal hit!`);
  tilesOf(TYRANT_KEY).forEach(t => { t.owner = null; t.troops = 0; t.heldRounds = 0; refreshHex(t.id); });
  G.factions[TYRANT_KEY].eliminated = true;
  for (const pk of Object.keys(G.pacts || {})) {
    const [pa, pb] = pk.split('|');
    if (pa === TYRANT_KEY || pb === TYRANT_KEY) {
      const ally = pa === TYRANT_KEY ? pb : pa;
      if (G.factions[ally]) G.factions[ally].boon = null;
      delete G.pacts[pk];
    }
  }
  addLog('💀 THE TYRANT is destroyed!');
  // Resurrect eliminated factions with a grudge against the renouncer.
  for (const [ek, ef] of Object.entries(G.factions)) {
    if (!ef.eliminated || ek === TYRANT_KEY || ek === fk) continue;
    const neutrals = Object.values(G.tiles).filter(t => !t.owner);
    if (!neutrals.length) continue;
    ef.eliminated = false; ef.corruption = 0; ef.resources = 3;
    for (let i = 0; i < Math.min(2, neutrals.length); i++) {
      neutrals[i].owner = ek; neutrals[i].troops = 2; neutrals[i].heldRounds = 0;
      refreshHex(neutrals[i].id);
    }
    G.grudges[ek + '>' + fk] = G.round + 3;
    addLog(`👻 ${ef.name} rises — grudge against ${G.factions[fk].name}!`);
  }
  G.factions[fk].corruption = 0;
  renderMap(); renderSidebar();
}

function refuseTyrantPact() {
  const fk = tyrantOfferFk;
  const petition = tyrantOfferIsPetition;
  tyrantOfferIsPetition = false;
  closeTyrantPactOffer();
  if (!fk) return;
  if (petition) { setActionLog('You think better of it and walk away.'); return; }
  // Human refused — increment refusal streak, check for conquest flip.
  // Flip when spurned 3 times, or when its two asks are spent on every living
  // non-allied human (the 2-offer cap would otherwise make the flip unreachable).
  if (!G.tyrantConquest) {
    if (!G.tyrantRefusalStreak) G.tyrantRefusalStreak = 0;
    G.tyrantRefusalStreak++;
    const oc = G.tyrantOfferCount || {};
    const spurned = livingKeys().filter(k =>
      k !== TYRANT_KEY && !G.factions[k].isAI && !hasPact(TYRANT_KEY, k));
    const exhausted = spurned.length > 0 && spurned.every(k => (oc[k] || 0) >= 2);
    if (G.tyrantRefusalStreak >= 3 || exhausted) {
      const unAllied = livingKeys().filter(k => k !== TYRANT_KEY && !hasPact(TYRANT_KEY, k));
      if (unAllied.length > 0) {
        G.tyrantConquest = true;
        addLog('🦠🗡️ THE TYRANT abandons diplomacy — CONQUEST MODE!');
        for (const k of Object.keys(G.pacts||{})) {
          const [a,b] = k.split('|');
          if (a === TYRANT_KEY || b === TYRANT_KEY) {
            const ally = a === TYRANT_KEY ? b : a;
            breakPactBetrayal(TYRANT_KEY, ally);
          }
        }
        renderSidebar(); syncPush();
      }
    }
  }
}

// Part 2: AI picks a boon when signing with the Tyrant
function aiPickBoon(aiFk) {
  const myT = tilesOf(aiFk);
  const hasAdjacentRival = myT.some(mt =>
    Object.values(G.tiles).some(t => t.owner && t.owner !== aiFk && t.owner !== TYRANT_KEY && adjacent(mt, t))
  );
  // Behind on economy → Tithe (growth). Has adjacent rival → Sic (aggressive).
  if (hasAdjacentRival && myT.length >= 3) return 'sic';
  return 'tithe';
}

// AI ally decides whether to harbor the cornered Tyrant (keep it as a weapon vs the leader).
function aiHarborDecision(aiFk) {
  const lead = Math.max(...livingKeys().filter(k=>k!==TYRANT_KEY).map(countNodes));
  return countNodes(aiFk) < lead || Math.random() < 0.35;   // underdogs shelter it; others sometimes do
}

// Pass-the-device screen between human turns (hot-seat)
function showHandoff(fk, cb) {
  const f = G.factions[fk];
  document.getElementById('handoff-name').textContent = f.name;
  document.getElementById('handoff-faction').innerHTML = `${f.icon} ${FACTIONS[fk].name}`;
  const ov  = document.getElementById('handoff-overlay');
  const btn = document.getElementById('handoff-btn');
  btn.style.background = f.color;
  btn.style.color = '#0a0a0a';
  btn.onclick = () => { ov.classList.remove('show'); cb(); };
  ov.classList.add('show');
}

function endTurn() {
  if (tutorialMode) { tutorialNext(); return; }   // in the tour, END TURN just advances the coach-marks
  if (online && !canActNow()) return;   // only the active local player may end the turn
  selectedTile = null; currentAction = null; assaultOn = false;
  clearHighlights();
  myTurnActive = false;
  G.currentTurnIdx++;
  renderMap(); renderSidebar();
  syncPush();                            // broadcast the finished board (no-op offline)
  if (!checkWin()) setTimeout(doNextTurn, 200);
}

const ROUND_CAP = 30;
function endRound() {
  // Node dominance win: held 3+ nodes for 2 consecutive round-ends
  if (G.nodesHeldSince) {
    for (const [k, since] of Object.entries(G.nodesHeldSince)) {
      const f = G.factions[k];
      if (f && !f.eliminated && countNodes(k) >= 3 && G.round - since >= 1) {
        // Part 2: corrupt faction → Reckoning intercept
        const r = maybeReckoningApp(k);
        if (r === 'thralldom') return; // Tyrant won — showWin already called
        if (r === 'freedom') { showWin(k, 'RECKONING (FREEDOM)', `${f.name} fought off the Tyrant and claimed Nexus!`); return; }
        showWin(k, 'NODE DOMINANCE', `${f.name} held 3+ Core Nodes for 2 rounds and commands Nexus.`);
        return;
      }
    }
  }
  G.round++;
  if (G.round > ROUND_CAP) {
    // Tiebreak: most nodes (Tyrant excluded from timeout)
    let best=null, bestN=-1;
    for (const [k,f] of Object.entries(G.factions)) {
      if (f.eliminated || k === TYRANT_KEY) continue;
      const n = Object.values(G.tiles).filter(t=>t.owner===k&&t.isNode).length;
      if (n>bestN) { bestN=n; best=k; }
    }
    if (best) {
      const r = maybeReckoningApp(best);
      if (r === 'thralldom') return;
      if (r === 'freedom') { showWin(best, 'RECKONING (FREEDOM)', `${G.factions[best].name} fought off the Tyrant and claimed Nexus!`); return; }
      showWin(best,'TIMED OUT',`After ${ROUND_CAP} rounds, ${G.factions[best].name} held the most Nodes.`);
    }
    return;
  }
  startRound();
}

// ============================================================
// PLAYER ACTIONS
// ============================================================
function enablePlayerActions(fk) {
  ['btn-move','btn-attack','btn-reinforce','btn-pact','btn-renounce','btn-airlift','btn-entrench'].forEach(id => {
    const el = document.getElementById(id);
    el.disabled = false; el.classList.remove('active-action');
  });
  ['btn-sabotage','btn-bribe','btn-rally','btn-overclock'].forEach(id => {
    document.getElementById(id).style.display = 'none';
    document.getElementById(id).disabled = false;
  });
  const ab = G.factions[fk].ability;
  const abEl = document.getElementById('btn-'+ab);
  if (abEl) abEl.style.display = '';
  const etb = document.querySelector('.end-turn-btn');
  if (etb) etb.disabled = false;
}

function disablePlayerActions() {
  ['btn-move','btn-attack','btn-reinforce','btn-pact','btn-renounce','btn-airlift','btn-entrench','btn-sabotage','btn-bribe','btn-rally','btn-overclock'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.disabled = true; el.classList.remove('active-action'); }
  });
  const etb = document.querySelector('.end-turn-btn');
  if (etb) etb.disabled = true;
}

function setAction(action) {
  assaultOn = false;        // choosing a new action halts any assault in progress
  currentAction = action;
  selectedTile  = null;
  clearHighlights();
  renderMap();
  ['btn-move','btn-attack','btn-reinforce','btn-pact','btn-renounce','btn-airlift','btn-entrench','btn-sabotage','btn-bribe','btn-rally','btn-overclock'].forEach(id => {
    document.getElementById(id)?.classList.remove('active-action');
  });
  document.getElementById('btn-'+action)?.classList.add('active-action');

  const hints = {
    move:      'MOVE: Click one of YOUR tiles (2+ troops), then an adjacent tile.',
    attack:    'ATTACK: Click YOUR tile (2+ troops), then an adjacent ENEMY tile.',
    reinforce: 'REINFORCE: Click YOUR tile to add troops (cost varies by faction/nodes).',
    pact:      "PACT: Click a rival's tile to propose a non-aggression pact (free, no action).",
    renounce:  'RENOUNCE: Click a tile owned by a faction you have a pact with to peacefully withdraw (free, no grudge).',
    airlift:   `AIRLIFT (${airliftCost(G.playerFaction)} res): Click YOUR tile (2+ troops), then ANY other tile you own — move up to 3 troops.`,
    entrench:  'ENTRENCH (2 res): Click YOUR tile (2+ troops) to dig in +1 (max +3, or +2 on Nodes).',
    sabotage:  'SABOTAGE (1 res): Click any ENEMY tile — −2 troops. First sabotage each turn vs a 3+ stack siphons +2 to your weakest frontline tile.',
    bribe:     'BRIBE (1 res): Click an adjacent enemy tile — a troop defects to you (−1 them, +1 you).',
    rally:     'RALLY (1 res): Click YOUR tile — it and all adjacent friendlies get +1 troop.',
    overclock: 'OVERCLOCK (1 res): Click YOUR tile — add +3 troops (industrial surge).',
  };
  setActionLog(hints[action] || 'Pick a tile.');
}

function handleTileClick(id) {
  if (!canActNow()) return;   // only the faction whose turn it is, controlled locally, may act
  const f    = G.factions[G.playerFaction];
  const tile = G.tiles[id];

  if (!currentAction) {
    selectedTile = id;
    renderMap();
    const owner = tile.owner ? G.factions[tile.owner].name : 'Unclaimed';
    setActionLog(`${tile.name} · Owner: ${owner} · Troops: ${tile.troops} · ${tile.isNode?'★ NODE':'District'}`);
    return;
  }

  // ---- PACT (free diplomacy — costs no action) ----
  if (currentAction === 'pact') {
    currentAction = null;
    document.querySelectorAll('.action-btn').forEach(b=>b.classList.remove('active-action'));
    if (!tile.owner || tile.owner===G.playerFaction) { setActionLog('Click an ENEMY faction tile to propose a pact.'); return; }
    const other = tile.owner;
    if (hasPact(G.playerFaction, other)) { setActionLog(`You already have a pact with ${G.factions[other].name}.`); return; }
    if ((G.renouncedThisTurn||{})[other]) { setActionLog(`Can't re-propose to ${G.factions[other].name} — you renounced this turn.`); return; }
    // Petitioning THE TYRANT: route through the proper secret-pact modal — boon choice,
    // corruption warning, and the concurrent-pact cap all apply, same as its own offers.
    if (other === TYRANT_KEY) {
      if (tyrantAtPactCap()) { setActionLog('The Tyrant has all the allies it needs — it refuses you.'); return; }
      showTyrantPactOffer(G.playerFaction, true);
      setActionLog('You petition the Tyrant in the shadows…');
      return;
    }
    // AI opponent: AI decides instantly
    if (G.factions[other].isAI) {
      if (aiConsiderPact(other, G.playerFaction)) {
        formPact(G.playerFaction, other);
        addLog('🤝 A non-aggression pact was formed.');
        setActionLog(`${G.factions[other].name} ACCEPTED your non-aggression pact!`);
      } else {
        addLog('✋ A pact proposal was refused.');
        setActionLog(`${G.factions[other].name} REFUSED — they don't need you yet.`);
      }
    }
    // Human opponent, hot-seat: ask them directly via the pact modal
    else if (!online) {
      const me = G.playerFaction;
      pactOfferModal(me, other, {
        onAccept: () => {
          formPact(me, other);
          addLog('🤝 A non-aggression pact was formed.');
          setActionLog(`${G.factions[other].name} ACCEPTED your pact!`);
          renderSidebar();
        },
        onRefuse: () => {
          addLog('✋ A pact proposal was refused.');
          setActionLog(`${G.factions[other].name} REFUSED your pact.`);
          renderSidebar();
        },
      });
    }
    // Human opponent, online: queue proposal for their turn
    else {
      if (G.pactProposal) { setActionLog('A pact proposal is already pending — wait for their response.'); renderSidebar(); return; }
      G.pactProposal = { from: G.playerFaction, to: other };
      addLog('🤝 A pact has been proposed.');
      setActionLog(`Pact proposed to ${G.factions[other].name} — they've been notified.`);
      syncPush();
    }
    renderSidebar(); return;
  }

  // ---- RENOUNCE ----
  if (currentAction === 'renounce') {
    currentAction = null;
    document.querySelectorAll('.action-btn').forEach(b=>b.classList.remove('active-action'));
    if (!tile.owner || tile.owner===G.playerFaction) { setActionLog('Click a tile owned by a faction you have a pact with.'); return; }
    const other = tile.owner;
    if (!hasPact(G.playerFaction, other)) { setActionLog(`You don't have a pact with ${G.factions[other].name}.`); return; }
    // Non-Tyrant renounce: simple exit
    if (other !== TYRANT_KEY && G.playerFaction !== TYRANT_KEY) {
      delete G.pacts[pairKey(G.playerFaction, other)];
      if (!G.renouncedThisTurn) G.renouncedThisTurn = {};
      G.renouncedThisTurn[other] = true;
      addLog('📜 A non-aggression pact was withdrawn.');
      setActionLog(`You withdrew from the pact with ${G.factions[other].name}. No grudge.`);
      renderSidebar(); return;
    }
    // Tyrant pact cannot be freely renounced — only via the forced prompt near victory
    setActionLog('You are bound to the Tyrant. The only way out is through the Reckoning — or the choice that comes when victory is near.');
    return;
  }

  if (G.actionsUsed >= 3) { setActionLog('No actions left — hit END TURN.'); return; }

  // ---- REINFORCE ----
  if (currentAction === 'reinforce') {
    if (tile.owner !== G.playerFaction) { setActionLog('Can only reinforce YOUR tiles.'); return; }
    const cost = reinforceCost(G.playerFaction);
    const amt  = reinforceAmount(G.playerFaction);
    if (f.resources < cost) { setActionLog(`Need ${cost} resources.`); return; }
    f.resources -= cost; tile.troops += amt; G.actionsUsed++;
    addLog(`🛡️ ${f.name} reinforced ${tile.name} (+${amt} troops)`);
    setActionLog(`Reinforced! ${3-G.actionsUsed} action(s) left. Res: ${f.resources}`);
    refreshHex(id); renderSidebar(); return;
  }

  // ---- AIRLIFT (universal, 3 res): redeploy up to 3 troops between any two of YOUR tiles ----
  if (currentAction === 'airlift') {
    const cost = airliftCost(G.playerFaction);   // 0 while holding 🚇 TRANSIT
    if (!selectedTile || selectedTile===id) {
      if (tile.owner===G.playerFaction && tile.troops>=2) {
        if (f.resources < cost) { setActionLog(`Airlift costs ${cost} resources.`); return; }
        selectedTile = id;
        renderMap();
        document.getElementById('hex-'+id)?.classList.add('selected');
        setActionLog(`Airlift FROM ${tile.name}. Click ANY other tile you own.`);
      } else { setActionLog('Airlift needs YOUR tile with 2+ troops.'); }
      return;
    }
    const src = G.tiles[selectedTile];
    if (tile.owner !== G.playerFaction) { setActionLog('Airlift only to YOUR tiles.'); return; }
    if (tile.id === src.id)             { setActionLog('Pick a different destination.'); return; }
    if (f.resources < cost)             { setActionLog(`Airlift costs ${cost} resources.`); return; }
    const maxN = Math.min(3, src.troops - 1);   // leave a garrison of 1
    const dstId = id;
    const doAirlift = (n) => {
      f.resources -= cost;
      src.troops -= n; G.tiles[dstId].troops += n;
      G.actionsUsed++;
      currentAction = null;
      document.querySelectorAll('.action-btn').forEach(b=>b.classList.remove('active-action'));
      addLog(`✈️ ${f.name} airlifted ${n} troop${n>1?'s':''}: ${src.name} → ${G.tiles[dstId].name}`);
      setActionLog(`Airlifted! ${3-G.actionsUsed} action(s) left. Res: ${f.resources}`);
      refreshHex(selectedTile); refreshHex(dstId);
      selectedTile=null; renderSidebar(); syncPush();
    };
    if (maxN <= 1) { doAirlift(1); return; }   // only one to spare — no need to ask
    showQtyPicker({
      title: `Airlift to ${tile.name} — how many troops?`,
      min: 1, max: maxN, def: maxN, confirmLabel: '✈️ AIRLIFT',
      onPick: doAirlift,
      onCancel: () => { setActionLog('Airlift cancelled.'); },
    });
    return;
  }

  // ---- ENTRENCH (universal, 2 res): buy a dig-in level on a garrisoned tile ----
  if (currentAction === 'entrench') {
    const cost = 2;
    const maxDig = tile.isNode ? 2 : 3;  // node tiles cap at +2 to stay contestable
    if (tile.owner !== G.playerFaction)   { setActionLog('Entrench YOUR tiles only.'); return; }
    if (tile.troops < 2)                  { setActionLog('Need 2+ troops to dig in.'); return; }
    if ((tile.heldRounds||0) >= maxDig)   { setActionLog(`Already at max dig-in (+${maxDig}).`); return; }
    if (f.resources < cost)               { setActionLog(`Entrench costs ${cost} resources.`); return; }
    f.resources -= cost;
    tile.heldRounds = Math.min((tile.heldRounds||0)+1, maxDig);
    G.actionsUsed++;
    currentAction = null;
    document.querySelectorAll('.action-btn').forEach(b=>b.classList.remove('active-action'));
    addLog(`🏰 ${f.name} entrenched ${tile.name} (dug in +${tile.heldRounds})`);
    setActionLog(`Entrenched +${tile.heldRounds}! ${3-G.actionsUsed} action(s) left. Res: ${f.resources}`);
    refreshHex(id); renderSidebar(); return;
  }

  // ---- MOVE ----
  if (currentAction === 'move') {
    if (!selectedTile || selectedTile===id) {
      if (tile.owner===G.playerFaction && tile.troops>1) {
        selectedTile = id;
        renderMap();
        document.getElementById('hex-'+id)?.classList.add('selected');
        setActionLog(`Moving FROM ${tile.name}. Click a tile up to ${moveRange(G.playerFaction)} away.`);
      } else { setActionLog('Select YOUR tile with 2+ troops.'); }
      return;
    }
    const src = G.tiles[selectedTile];
    if (tile.owner && tile.owner!==G.playerFaction) { setActionLog('Occupied by enemy — use ATTACK instead.'); return; }
    if (!moveReachable(G.playerFaction, src, tile)) {
      const t=G.factions[G.playerFaction].trait;
      const r = moveRange(G.playerFaction);
      setActionLog(r > 1 ? `Out of range — max ${r} tiles.` : 'Not adjacent! Try again.');
      selectedTile=null; renderMap(); return;
    }
    // Carry up to stack−1 (player-chosen; default leaves 1 behind as a garrison).
    const mvSrcId = selectedTile;
    const maxCarry = src.troops - 1;
    const doMove = (n) => {
      const s = G.tiles[mvSrcId];
      if (!s || s.owner !== G.playerFaction || s.troops < 2 ||
          (tile.owner && tile.owner !== G.playerFaction)) {
        setActionLog('Move fizzled — the situation changed.'); return;
      }
      const moveN = Math.max(1, Math.min(n, s.troops - 1));
      s.troops -= moveN;
      tile.owner = G.playerFaction; tile.troops += moveN;
      G.actionsUsed++;
      currentAction = null;
      document.querySelectorAll('.action-btn').forEach(b=>b.classList.remove('active-action'));
      addLog(`🚶 ${f.name} moved ${moveN} troop${moveN>1?'s':''}: ${s.name} → ${tile.name}`);
      setActionLog(`Moved! ${3-G.actionsUsed} action(s) left.`);
      refreshHex(mvSrcId); refreshHex(id);
      selectedTile=null; renderSidebar(); syncPush();
    };
    if (maxCarry <= 1) { doMove(1); return; }
    showQtyPicker({
      title: `MOVE HOW MANY TO ${tile.name}?`,
      min: 1, max: maxCarry, def: maxCarry,   // default: bring everyone but the garrison
      confirmLabel: '🚶 MOVE',
      onPick: doMove,
      onCancel: () => setActionLog('Move cancelled.'),
    });
    return;
  }

  // ---- ATTACK ----
  if (currentAction === 'attack') {
    if (signalJamActive) { setActionLog('⚠️ SIGNAL JAM — attacks blocked this round!'); return; }
    if (!selectedTile || selectedTile===id) {
      if (tile.owner===G.playerFaction && tile.troops>1) {
        selectedTile = id;
        renderMap();
        document.getElementById('hex-'+id)?.classList.add('selected');
        setActionLog(`Attacking FROM ${tile.name}. Click an adjacent ENEMY tile.`);
      } else { setActionLog('Select YOUR tile with 2+ troops to attack from.'); }
      return;
    }
    const src = G.tiles[selectedTile];
    if (!adjacent(src,tile))          { setActionLog('Not adjacent — pick an enemy next to your assault tile.'); return; }
    if (!tile.owner || tile.owner===G.playerFaction) { setActionLog('Pick an ENEMY tile.'); return; }
    if (src.troops < 2)               { setActionLog('Need 2+ troops to attack.'); return; }
    if ((G.renouncedThisTurn||{})[tile.owner]) { setActionLog("Can't strike a faction you renounced this turn — wait until next turn."); return; }
    const srcId = selectedTile;   // capture now — a confirm modal may defer doAttack
    const doAttack = () => {
      // Re-validate: if the situation changed while a confirm modal was up, fizzle quietly.
      const srcT = G.tiles[srcId];
      if (!srcT || srcT.owner !== G.playerFaction || srcT.troops < 2 || !tile.owner || tile.owner === G.playerFaction) {
        setActionLog('Attack fizzled — the situation changed.'); return;
      }
      // BACKSTOP: any strike that lands on a faction we still have a pact with MUST break
      // the pact (this is the rule, regardless of how we got here — confirm modal, assault
      // chain, or anything else). Catches edge cases like the modal not firing because the
      // pact state was misread, or an assault chain that started before pact formation.
      if (hasPact(G.playerFaction, tile.owner)) breakPactBetrayal(G.playerFaction, tile.owner);
      if (!assaultOn) { G.actionsUsed++; assaultOn = true; assaultCaptures = 0; }   // launching the assault costs ONE action
      const captured = G.tiles[id].troops <= 1;  // will this be a capture if we win?
      const won = resolveAttack(G.playerFaction, srcId, id, true);
      if (won && captured) assaultCaptures++;
      renderSidebar();
      if (checkWin()) return;
      const contAssault = () => {
        // Press the assault: a win lets you keep striking for free, but each strike rallies defenders +2.
        // Hard cap: 3 captures per assault chain.
        if (won && G.tiles[srcId] && G.tiles[srcId].troops >= 2 && assaultCaptures < 3) {
          selectedTile = srcId;   // keep the assault source selected for the next strike
          setActionLog(`⚔️ Assault presses on! (${assaultCaptures}/3 captures) Each repeat strike on the SAME faction rallies it +2. Click another adjacent enemy — or pick another action to halt.`);
          renderMap();
          document.getElementById('hex-'+srcId)?.classList.add('selected');
          return;
        }
        // Repelled, source spent, capture cap hit, or nothing left — the assault is over.
        assaultOn = false; assaultCaptures = 0; selectedTile=null; currentAction=null;
        document.querySelectorAll('.action-btn').forEach(b=>b.classList.remove('active-action'));
        renderMap(); renderSidebar();
      };
      // On a capture, advance a chosen number of extra troops (up to stack−1) into the
      // captured tile in the SAME action. Committing hard empties the source (ending the
      // assault chain from it) — that tradeoff plus rally escalation is the brake.
      const advSrc = G.tiles[srcId];
      const maxAdv = (won && captured && advSrc && advSrc.owner === G.playerFaction) ? advSrc.troops - 1 : 0;
      if (maxAdv >= 1) {
        showQtyPicker({
          title: `ADVANCE HOW MANY INTO ${tile.name}?`,
          min: 0, max: maxAdv, def: maxAdv,
          confirmLabel: '⚔️ ADVANCE',
          onPick: (n) => {
            const s = G.tiles[srcId];
            if (n > 0 && s && s.owner === G.playerFaction && tile.owner === G.playerFaction && s.troops > n) {
              s.troops -= n; tile.troops += n;
              addLog(`${G.factions[G.playerFaction].icon} advanced ${n} troop${n>1?'s':''} into ${tile.name}`);
              refreshHex(srcId); refreshHex(id); renderSidebar(); syncPush();
            }
            contAssault();
          },
          onCancel: contAssault,   // cancel = hold position (advance 0)
        });
        return;
      }
      contAssault();
    };
    if (hasPact(G.playerFaction, tile.owner)) {
      if (tile.owner === TYRANT_KEY) {
        tyrantModal({
          type: 'A PACT IN THE WAY',
          title: '🦠 STRIKE YOUR DARK ALLY?',
          body: `You are bound to the Tyrant by a <b>secret pact</b>. Strike it now and the pact shatters — ` +
                `<span style="color:#d98fd9;">it will hold a grudge (+2 against you for 2 rounds)</span>.`,
          confirmLabel: '🗡️ BREAK THE PACT',
          cancelLabel: '✋ HOLD',
          onConfirm: () => { breakPactBetrayal(G.playerFaction, tile.owner); doAttack(); },
          onCancel:  () => setActionLog('Attack cancelled — pact held.'),
        });
        return;
      }
      if (!confirm(`You have a pact with ${G.factions[tile.owner].name}. Break it and attack? They'll hold a grudge (+2 vs you for 2 rounds).`)) {
        setActionLog('Attack cancelled — pact held.'); return;
      }
      breakPactBetrayal(G.playerFaction, tile.owner);
    }
    doAttack(); return;
  }

  // ---- SABOTAGE ----
  if (currentAction === 'sabotage') {
    if (!tile.owner || tile.owner===G.playerFaction) { setActionLog('Pick an ENEMY tile.'); return; }
    if ((G.renouncedThisTurn||{})[tile.owner]) { setActionLog("Can't strike a faction you renounced this turn — wait until next turn."); return; }
    if (f.resources < 1) { setActionLog('Sabotage costs 1 resource.'); return; }
    const doSabotage = () => {
      // Re-validate: if the situation changed while a confirm modal was up, fizzle quietly.
      if (!tile.owner || tile.owner === G.playerFaction || f.resources < 1) {
        setActionLog('Sabotage fizzled — the situation changed.'); return;
      }
      // BACKSTOP: any strike on a current pact partner breaks the pact (see ATTACK).
      if (hasPact(G.playerFaction, tile.owner)) breakPactBetrayal(G.playerFaction, tile.owner);
      f.resources -= 1;
      const sabPrev = tile.owner;
      recordTyrantStrike(G.playerFaction, sabPrev);   // Step 3: sabotaging the blob earns surge next turn
      const sabPreTroops = tile.troops;  // before the hit (siphon only from a surviving tile)
      const sabDrop = 2;  // −2 enemy troops (distinct from Syndicate's −1 bribe)
      if (tile.troops > sabDrop) tile.troops -= sabDrop; else { tile.owner=null; tile.troops=0; }
      if (tile.owner===null && Object.values(G.tiles).filter(t=>t.owner===sabPrev).length===0) {
        killFaction(sabPrev);
      }
      // Siphon: the knocked-off troops defect — +2 to the Ghost's weakest frontline tile, but
      // ONLY if the target survived the −2 (had 3+) and ONLY once per turn (cap +2/turn, never +6).
      let sabGain = null;
      if (sabPreTroops > sabDrop && !G.siphonedThisTurn) {
        sabGain = ghostSiphonTarget(G.playerFaction);
        if (sabGain) { sabGain.troops += 2; refreshHex(sabGain.id); G.siphonedThisTurn = true; }
      }
      G.actionsUsed++;
      const sabLeft = tile.troops>0 ? `${tile.name} now ${tile.troops} troop${tile.troops>1?'s':''}` : `${tile.name} wiped out`;
      const gainMsg = sabGain ? ` — siphoned +2 to ${sabGain.name}` : '';
      addLog(`👁️ ${f.name} sabotaged ${tile.name}${gainMsg} (${sabLeft})`);
      setActionLog(`Sabotage hit!${gainMsg}. ${3-G.actionsUsed} action(s) left. Res: ${f.resources}`);
      refreshHex(id); flashHex(id); renderSidebar(); checkWin();
      syncPush();   // broadcast so online opponents see the troop drop immediately
    };
    if (hasPact(G.playerFaction, tile.owner)) {
      if (tile.owner === TYRANT_KEY) {
        tyrantModal({
          type: 'A PACT IN THE WAY',
          title: '🦠 SABOTAGE YOUR DARK ALLY?',
          body: `You are bound to the Tyrant by a <b>secret pact</b>. Sabotage it and the pact shatters — ` +
                `<span style="color:#d98fd9;">it will hold a grudge (+2 against you for 2 rounds)</span>.`,
          confirmLabel: '🗡️ BREAK THE PACT',
          cancelLabel: '✋ HOLD',
          onConfirm: () => { breakPactBetrayal(G.playerFaction, tile.owner); doSabotage(); },
          onCancel:  () => setActionLog('Sabotage cancelled — pact held.'),
        });
        return;
      }
      if (!confirm(`Sabotaging ${G.factions[tile.owner].name} breaks your pact. Proceed?`)) { setActionLog('Sabotage cancelled — pact held.'); return; }
      breakPactBetrayal(G.playerFaction, tile.owner);
    }
    doSabotage();
    return;
  }

  // ---- BRIBE ----
  if (currentAction === 'bribe') {
    if (!tile.owner || tile.owner===G.playerFaction) { setActionLog('Pick an ENEMY tile adjacent to your territory.'); return; }
    if (f.resources < 1) { setActionLog('Bribe costs 1 resource.'); return; }
    const myT = Object.values(G.tiles).filter(t=>t.owner===G.playerFaction);
    if (!myT.some(mt=>adjacent(mt,tile))) { setActionLog('Must be adjacent to YOUR territory.'); return; }
    if ((G.renouncedThisTurn||{})[tile.owner]) { setActionLog("Can't strike a faction you renounced this turn — wait until next turn."); return; }
    const doBribe = () => {
      // Re-validate: if the situation changed while a confirm modal was up, fizzle quietly.
      if (!tile.owner || tile.owner === G.playerFaction || f.resources < 1) {
        setActionLog('Bribe fizzled — the situation changed.'); return;
      }
      // BACKSTOP: any strike on a current pact partner breaks the pact (see ATTACK).
      if (hasPact(G.playerFaction, tile.owner)) breakPactBetrayal(G.playerFaction, tile.owner);
      f.resources -= 1;
      const bribedPrev = tile.owner;
      // The bribed troop DEFECTS to an adjacent Syndicate tile (the staging tile) — a 2-point
      // swing (−1 them, +1 you). Pick it before any capture so it's never the seized tile.
      const defectTo = Object.values(G.tiles)
        .filter(t => t.owner === G.playerFaction && adjacent(t, tile))
        .sort((a, b) => b.troops - a.troops)[0];
      tile.troops--;
      if (defectTo) { defectTo.troops++; refreshHex(defectTo.id); }
      if (tile.troops<=0) {
        tile.owner=G.playerFaction; tile.troops=1;
        if (Object.values(G.tiles).filter(t=>t.owner===bribedPrev).length===0) killFaction(bribedPrev);
      }
      G.actionsUsed++;
      addLog(`💰 ${f.name} bribed ${tile.name} — a troop defects${defectTo ? ' to ' + defectTo.name : ''}!`);
      setActionLog(`Bribed! ${3-G.actionsUsed} action(s) left. Res: ${f.resources}`);
      refreshHex(id); renderSidebar(); checkWin();
    };
    if (hasPact(G.playerFaction, tile.owner)) {
      if (tile.owner === TYRANT_KEY) {
        tyrantModal({
          type: 'A PACT IN THE WAY',
          title: '🦠 BRIBE YOUR DARK ALLY?',
          body: `You are bound to the Tyrant by a <b>secret pact</b>. Turn its troops and the pact shatters — ` +
                `<span style="color:#d98fd9;">it will hold a grudge (+2 against you for 2 rounds)</span>.`,
          confirmLabel: '🗡️ BREAK THE PACT',
          cancelLabel: '✋ HOLD',
          onConfirm: () => { breakPactBetrayal(G.playerFaction, tile.owner); doBribe(); },
          onCancel:  () => setActionLog('Bribe cancelled — pact held.'),
        });
        return;
      }
      if (!confirm(`Bribing ${G.factions[tile.owner].name} breaks your pact. Proceed?`)) { setActionLog('Bribe cancelled — pact held.'); return; }
      breakPactBetrayal(G.playerFaction, tile.owner);
    }
    doBribe();
    return;
  }

  // ---- RALLY ----
  if (currentAction === 'rally') {
    if (tile.owner !== G.playerFaction) { setActionLog('Rally on YOUR tiles only.'); return; }
    if (f.resources < 1) { setActionLog('Rally costs 1 resource.'); return; }
    f.resources -= 1;
    tile.troops++;
    const adj = Object.values(G.tiles).filter(t=>t.owner===G.playerFaction && adjacent(t,tile));
    adj.forEach(t=>{ t.troops++; refreshHex(t.id); });
    G.actionsUsed++;
    addLog(`🌿 Rally! +1 to ${tile.name} + ${adj.length} adjacent tiles`);
    setActionLog(`Rallied ${adj.length+1} tiles! ${3-G.actionsUsed} action(s) left.`);
    refreshHex(id); renderSidebar(); return;
  }

  // ---- OVERCLOCK (GRID) ----
  if (currentAction === 'overclock') {
    if (tile.owner !== G.playerFaction) { setActionLog('Overclock YOUR tiles only.'); return; }
    if (f.resources < 1) { setActionLog('Overclock costs 1 resource.'); return; }
    f.resources -= 1;
    tile.troops += 3;
    G.actionsUsed++;
    addLog(`⚙️ Overclock! +3 troops on ${tile.name}`);
    setActionLog(`Overclocked! ${3-G.actionsUsed} action(s) left. Res: ${f.resources}`);
    refreshHex(id); renderSidebar(); return;
  }
}

function clearHighlights() {
  document.querySelectorAll('.hex.selected,.hex.valid-move,.hex.valid-attack')
    .forEach(h=>h.classList.remove('selected','valid-move','valid-attack'));
}

// ============================================================
// COMBAT
// ============================================================
function roll2d6(tactician) {
  const r = () => Math.ceil(Math.random()*6);
  if (tactician) {
    const d = [r(), r(), r()].sort((a,b)=>b-a);  // 3d6, keep highest 2
    return { sum: d[0]+d[1], dice: [d[0], d[1]] };
  }
  const d = [r(), r()];
  return { sum: d[0]+d[1], dice: d };
}

function resolveAttack(attackerFk, srcId, tgtId, isPlayer) {
  const src = G.tiles[srcId];
  const tgt = G.tiles[tgtId];
  const af  = G.factions[attackerFk];
  const df  = G.factions[tgt.owner];

  // --- Base dice (2d6 bell curve, centered on 7) ---
  const attRoll = roll2d6(af.trait==='tactician');
  const defRoll = roll2d6(false);
  const attDice = attRoll.sum;
  const defDice = defRoll.sum;

  // --- Modifiers ---
  // 1. Force ratio: every 4 troops = +1, capped at +2 (big stacks are resilient, not auto-win)
  const attForce = Math.min(2, Math.floor(src.troops / 4));
  const defForce = Math.min(2, Math.floor(tgt.troops / 4));
  // 2. Rally: a victim only digs in if THIS attacker has already hit it this turn (+2 per
  //    prior strike on the same faction). Attacking different rivals once each costs nothing —
  //    the brake is on grinding the SAME enemy (e.g. a press-the-assault chain), not on spreading.
  //    EXCEPTION: the Tyrant never rallies — it's the shared enemy, so anyone can hammer it
  //    repeatedly without the escalating-defense penalty.
  const rallyKey = attackerFk + '|' + tgt.owner;
  const overextend = tgt.owner === TYRANT_KEY ? 0 : (turnStrikes[rallyKey] || 0) * 2;
  // 3. Entrenchment — GHOST's Phantom assault ignores it entirely
  let entrench = Math.min(tgt.heldRounds || 0, tgt.isNode ? 2 : 3);  // node tiles cap at +2
  if (af.ability==='sabotage') entrench = 0;          // 👁️ GHOST phantom perk
  // 4. Trait modifiers
  const lastStand = (df?.trait==='last_stand' && tgt.troops<=2) ? 3 : 0;  // triggers at 1-2 troops
  const fortify  = df?.trait==='fortify' ? (tgt.heldRounds > 0 ? 2 : 1) : 0;  // +2 fresh, decays to +1 after casualty
  // 5. Node bonuses — 📡 COMMS (+1 atk), 🖧 DATA (+1 def)
  const comms = controlsNode(attackerFk,'node_comms') ? 1 : 0;
  const data  = controlsNode(tgt.owner,'node_data')   ? 1 : 0;
  // 6. Coalition: gang up on whoever holds 2+ Nodes (anti-snowball)
  const coalition = coalitionAtkBonus(tgt.owner, attackerFk);
  // 7. Grudge: a betrayed faction fights harder against its betrayer
  const grudgeA = grudgeAtkBonus(attackerFk, tgt.owner);
  const grudgeD = grudgeDefBonus(attackerFk, tgt.owner);
  // 8. TOTAL WAR event: every attacker swings +1 this round
  const war = totalWar ? 1 : 0;
  // 9. Step 3 coalition surge — human-only attack bonus vs the Tyrant (0 otherwise)
  const surge = tyrantSurgeBonus(attackerFk, tgt.owner);

  // Raw modifier totals (before clamping)
  let attMods = attForce + comms + coalition + grudgeA + war + surge;
  let defMods = defForce + entrench + lastStand + data + grudgeD + overextend;
  // Clamp net modifier swing to ±4 — no combination of perks fully removes chance
  const modSwing = attMods - defMods;
  if (modSwing > 4)       { attMods -= (modSwing - 4); }
  else if (modSwing < -4) { defMods -= (-4 - modSwing); }

  const attTotal = attDice + attMods;
  const defTotal = defDice + defMods;

  // Attacker wins ties; fortify adds a margin requirement
  const attWins = attTotal >= defTotal + fortify;

  turnAttacks++;
  turnStrikes[rallyKey] = (turnStrikes[rallyKey] || 0) + 1;  // next strike on this victim rallies +2

  // Step 3: record the strike (earns surge next turn) — tgt.owner is still the Tyrant here.
  recordTyrantStrike(attackerFk, tgt.owner);

  // Flash the result whenever the human is involved — attacking OR defending
  const captured = attWins && tgt.troops <= 1;   // the defender's last troop falls → tile flips
  if (isPlayer || tgt.owner===G.playerFaction) {
    showCombatResult(
      { dice: attRoll.dice, force: attForce, comms, coalition, grudge: grudgeA, war, surge, total: attTotal },
      { dice: defRoll.dice, force: defForce, entrench, lastStand, fortify, data, grudge: grudgeD, overextend, total: defTotal },
      attWins, isPlayer, af, df, captured
    );
  }

  if (attWins) {
    tgt.troops--;
    if (tgt.troops <= 0) {
      const prev = tgt.owner;
      tgt.owner    = attackerFk;
      tgt.troops   = 1;
      tgt.heldRounds = 0;   // freshly taken — not dug in yet
      src.troops   = Math.max(1, src.troops-1);
      // SCAVENGER trait: loot +1 resource on capture (denied by LAST STAND defenders)
      const lootDenied = df?.trait==='last_stand';
      if (af.trait==='scavenger' && !lootDenied) { af.resources = Math.min((af.resources||0)+1, RES_CAP); }
      const lootMsg = af.trait==='scavenger' ? (lootDenied ? ' 🚫 loot denied' : ' 💰+1 res') : '';
      addLog(`🏴 ${af.icon} CAPTURED ${tgt.name}! [${attTotal} vs ${defTotal}]${lootMsg}`);
      const defLeft = Object.values(G.tiles).filter(t=>t.owner===prev).length;
      if (defLeft===0) {
        killFaction(prev);
        // Bounty: wiping a rival grants +3 resources (encourages PvP without breaking node count).
        af.resources = Math.min((af.resources||0)+3, RES_CAP);
        addLog(`🏆 ${af.icon} eliminated ${G.factions[prev]?.name||prev}! +3 resources bounty.`);
        // GRAVEYARD: when the Tyrant dies (its last tile falls in combat), THIS tile becomes a
        // node — counts toward the "3 nodes for 2 rounds" win for whoever holds it. No perk,
        // just the bounty for slaying the blob. Steal-able like any other node afterwards.
        if (prev === TYRANT_KEY && G.factions[TYRANT_KEY].eliminated && !tgt.isNode) {
          tgt.isNode = true;
          tgt.nodeId = 'node_graveyard';
          tgt.name = '☠ GRAVEYARD';
          tgt.short = '☠GRV';
          addLog(`☠ ${tgt.name} rises where the Tyrant fell — a bounty node for ${af.name}.`);
        }
      }
    } else {
      tgt.heldRounds = 0;   // taking casualties breaks entrenchment
      addLog(`⚔️ ${af.icon} hit ${tgt.name} [${attTotal} vs ${defTotal}] — ${tgt.troops} left`);
    }
  } else {
    src.troops = Math.max(1, src.troops-1);
    addLog(`🛡️ ${af.icon} → ${tgt.name} [${attTotal} vs ${defTotal}] — REPELLED`);
  }

  refreshHex(srcId); refreshHex(tgtId);
  return attWins;
}

function modParts(arr) {
  // Build a "+2 force +1 blitz" style string from non-zero modifiers
  return arr.filter(p => p.v > 0).map(p => `+${p.v} ${p.label}`).join(' ');
}

// Combat results queue — EVERY result stays on screen until the player presses OK.
// Results that land while one is showing queue up behind it; nothing is lost.
let combatQueue      = [];
let combatAckWaiters = [];   // engine continuations waiting for the queue to drain

function showCombatResult(att, def, win, playerIsAttacker, af, df, captured) {
  combatQueue.push({ att, def, win, playerIsAttacker, af, df, captured });
  if (combatQueue.length === 1) renderCombatFlash();
}

function renderCombatFlash() {
  const { att, def, win, playerIsAttacker, af, df, captured } = combatQueue[0];
  const faces = ['⚀','⚁','⚂','⚃','⚄','⚅'];
  const diceStr = (arr) => arr.map(d => faces[d-1]).join('');
  const attMods = modParts([{v:att.force,label:'force'},{v:att.comms,label:'uplink'},{v:att.coalition,label:'coalition'},{v:att.grudge,label:'grudge'},{v:att.war,label:'war'},{v:att.surge,label:'coalition surge'}]);
  const defMods = modParts([{v:def.force,label:'force'},{v:def.entrench,label:'dug in'},{v:def.lastStand,label:'last stand'},{v:def.fortify,label:'fortify'},{v:def.data,label:'firewall'},{v:def.grudge,label:'grudge'},{v:def.overextend,label:'rally'}]);
  const attLabel = playerIsAttacker ? 'YOU' : (af ? af.icon : 'ATK');
  const defLabel = playerIsAttacker ? (df ? df.icon : 'DEF') : 'YOU';
  // Color + headline from the LOCAL player's point of view (green = good for you).
  const goodForLocal = playerIsAttacker ? win : !win;
  let headline;
  if (captured)   headline = playerIsAttacker ? '⚡ TILE CAPTURED!' : '💥 TILE LOST!';
  else if (win)   headline = '💢 HIT! −1 TROOP';           // round won, but the tile holds
  else            headline = playerIsAttacker ? '🛡️ REPELLED' : '🛡️ YOU HOLD!';
  document.querySelectorAll('.combat-ack-overlay').forEach(e => e.remove());
  const ov = document.createElement('div');
  ov.className = 'combat-ack-overlay';
  const el = document.createElement('div');
  el.className = 'combat-flash';
  el.innerHTML = `
    <div class="combat-side">
      <span class="combat-label">${attLabel}</span>
      <span class="roll-line">${diceStr(att.dice)} ${attMods} <b>= ${att.total}</b></span>
    </div>
    <div class="combat-side">
      <span class="combat-label">${defLabel}</span>
      <span class="roll-line">${diceStr(def.dice)} ${defMods} <b>= ${def.total}</b></span>
    </div>
    <div class="result-line ${goodForLocal?'win-line':'lose-line'}">${headline}</div>
    <button class="combat-ok-btn" onclick="acknowledgeCombat()">OK ✓</button>
  `;
  ov.appendChild(el);
  document.body.appendChild(ov);
}

// OK pressed — dismiss the current result, show the next queued one, or release the engine.
function acknowledgeCombat() {
  if (!combatQueue.length) return;
  document.querySelectorAll('.combat-ack-overlay').forEach(e => e.remove());
  combatQueue.shift();
  if (combatQueue.length) { renderCombatFlash(); return; }
  const waiters = combatAckWaiters;
  combatAckWaiters = [];
  waiters.forEach(cb => cb());
}

// Run `cb` once every shown combat result has been acknowledged (immediately if none is up).
function onCombatAck(cb) {
  if (!combatQueue.length) cb();
  else combatAckWaiters.push(cb);
}

// ============================================================
// ADJACENCY
// ============================================================
function adjacent(a, b) {
  // Flat-top hexes laid out in columns; ODD columns are shifted DOWN by half a tile.
  const dc = Math.abs(a.col - b.col);
  if (dc === 0) return Math.abs(a.row - b.row) === 1;   // same column: up / down
  if (dc !== 1) return false;                            // must be an adjacent column
  const dr = b.row - a.row;
  return (a.col % 2 === 0) ? (dr === -1 || dr === 0)     // even col → neighbors at r-1, r
                          : (dr === 0  || dr === 1);     // odd col  → neighbors at r, r+1
}

// ============================================================
// AI
// ============================================================
// Multi-source BFS over hex adjacency → { tileId: steps to nearest source tile }.
function bfsFromTiles(sources) {
  const tiles = Object.values(G.tiles);
  const dist = {}; const q = [];
  sources.forEach(s => { dist[s.id] = 0; q.push(s); });
  for (let h = 0; h < q.length; h++) {
    const cur = q[h];
    for (const nb of tiles) {
      if (dist[nb.id] === undefined && adjacent(cur, nb)) { dist[nb.id] = dist[cur.id] + 1; q.push(nb); }
    }
  }
  return dist;
}

// AI node-seeking: capture an adjacent unclaimed Node, else march a troop toward the nearest Node.
// This is what makes the AI actually contest the board's objectives (nodes start unowned).
// AI advance/carry sizing — commit force forward, keep a rear guard when threatened.
// (Mirrors carryCount/advanceFor in src/ai.js so live games match the sim.)
function aiTileThreatened(fk, tile) {
  return Object.values(G.tiles).some(t => t.owner && t.owner !== fk && adjacent(tile, t));
}
function aiCarryCount(fk, src) {
  const movable = Math.max(1, src.troops - 1);
  return aiTileThreatened(fk, src) ? Math.max(1, Math.floor(movable / 2)) : movable;
}
function aiAdvanceFor(fk, atk, def) {
  if (def.isNode) return aiTileThreatened(fk, atk) ? Math.max(1, Math.floor(atk.troops / 2)) : atk.troops;
  return Math.floor(Math.max(0, atk.troops - 1) / 2);
}
// Attack + post-capture advance in one action (engine clamps to stack-1).
function aiAttackWithAdvance(fk, atk, def) {
  const willCapture = def.troops <= 1;
  const wantAdv = aiAdvanceFor(fk, atk, def);
  const won = resolveAttack(fk, atk.id, def.id, false);
  if (won && willCapture && G.tiles[def.id].owner === fk) {
    const s = G.tiles[atk.id];
    const adv = (s && s.owner === fk) ? Math.min(wantAdv, s.troops - 1) : 0;
    if (adv > 0) {
      s.troops -= adv; G.tiles[def.id].troops += adv;
      addLog(`${G.factions[fk].icon} ${G.factions[fk].name} advanced ${adv} troop${adv>1?'s':''} into ${def.name}`);
      refreshHex(atk.id); refreshHex(def.id);
    }
  }
  return won ? 'won' : 'repelled';
}

function aiNodePush(fk) {
  const tiles   = Object.values(G.tiles);
  const movable = tiles.filter(t => t.owner === fk && t.troops >= 2);
  if (!movable.length) return false;
  const targets = tiles.filter(t => t.isNode && t.owner !== fk);
  if (!targets.length) return false;
  const f = G.factions[fk];

  const phantom = f.ability === 'sabotage';

  // 1. Step onto an adjacent (or 2-tile for phantom/ghost_step) UNCLAIMED node.
  for (const src of movable) {
    const node = targets.find(n => !n.owner && moveReachable(fk, src, n));
    if (node) {
      const carry = aiCarryCount(fk, src);
      src.troops -= carry; node.owner = fk; node.troops = (node.troops || 0) + carry; node.heldRounds = 0;
      addLog(`${f.icon} ${f.name} seized ${node.name}`);
      refreshHex(src.id); refreshHex(node.id);
      return true;
    }
  }

  // 2. Otherwise march one troop a step closer to the nearest node, through empty/own tiles.
  //    Phantom/ghost_step can also consider 2-tile jumps through enemy tiles.
  const dist = bfsFromTiles(targets);
  let mv = null;
  for (const src of movable) {
    const here = dist[src.id];
    if (here === undefined) continue;
    // Standard 1-tile moves
    for (const nb of tiles) {
      if (adjacent(src, nb) && (!nb.owner || nb.owner === fk)) {
        const d = dist[nb.id];
        if (d !== undefined && d < here && (!mv || d < mv.d || (d === mv.d && src.troops > mv.src.troops)))
          mv = { src, to: nb, d };
      }
    }
    // Phantom/ghost_step: multi-tile jumps through enemy tiles
    if (moveRange(fk) >= 2) {
      for (const nb of tiles) {
        if (nb.id === src.id) continue;
        if (nb.owner && nb.owner !== fk) continue;  // can't land on enemy
        if (!moveReachable(fk, src, nb)) continue;
        const d = dist[nb.id];
        if (d !== undefined && d < here && (!mv || d < mv.d || (d === mv.d && src.troops > mv.src.troops)))
          mv = { src, to: nb, d };
      }
    }
  }
  if (mv) {
    const carry = aiCarryCount(fk, mv.src);
    mv.src.troops -= carry;
    if (!mv.to.owner) { mv.to.owner = fk; mv.to.troops = carry; mv.to.heldRounds = 0; }
    else mv.to.troops += carry;
    addLog(`${f.icon} ${f.name} advanced toward a Node`);
    refreshHex(mv.src.id); refreshHex(mv.to.id);
    return true;
  }
  return false;
}

// The Tyrant's defining trait: each of its turns it metastasizes into nearby empty tiles.
function tyrantSpread(fk) {
  const tiles = Object.values(G.tiles);
  const seeds = tiles.filter(t => t.owner === fk && t.troops >= 2);
  // Grow TOWARD hostile (non-allied) factions, not always into the first/top-left empty tile.
  // This kills the old "always spreads NW" bias and advances the blob on the enemies a
  // SIC-ally has pointed it at, so its strikes actually land.
  const hostile = tiles.filter(t => t.owner && t.owner !== fk && !hasPact(fk, t.owner));
  const dist = (a, b) => Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
  const towardHostile = (t) => hostile.length ? Math.min(...hostile.map(h => dist(t, h))) : 0;
  let spread = 0;
  for (const s of seeds) {
    if (spread >= 4) break;                       // cap per turn so it grows fast, not instantly
    const empties = tiles.filter(t => !t.owner && adjacent(s, t));
    if (!empties.length) continue;
    empties.sort((a, b) => towardHostile(a) - towardHostile(b));   // closest to a hostile tile first
    const empty = empties[0];
    s.troops--; empty.owner = fk; empty.troops = 1; empty.heldRounds = 0;
    refreshHex(s.id); refreshHex(empty.id); spread++;
  }
  if (spread) addLog(`🦠 THE TYRANT spreads into ${spread} new tile${spread>1?'s':''}`);
}

function runAITurn(fk) {
  if (gameOver) return;
  turnAttacks = 0; turnStrikes = {};
  G.renouncedThisTurn = {};  // Part 1: clear per-faction renounce guard
  G.siphonedThisTurn = false;  // Ghost sabotage: one siphon gain per turn
  const f = G.factions[fk];
  if (f.eliminated) { G.currentTurnIdx++; setTimeout(doNextTurn,200); return; }

  // PER-ROUND BARGAIN (AI): a bound non-Tyrant AI silently picks its boon this round.
  // (Humans get the modal in tyrantInteract; this is the AI parallel.)
  if (fk !== TYRANT_KEY && tyrantAlive() && hasPact(TYRANT_KEY, fk) && !G.tyrantHarbor) {
    if (!G.boonChosenThisRound) G.boonChosenThisRound = {};
    const key = fk + '|' + G.round;
    if (!G.boonChosenThisRound[key]) {
      const choice = aiPickBoon(fk);
      G.boonChosenThisRound[key] = choice;
      applyBoonChoice(fk, choice);
    }
  }

  if (fk === TYRANT_KEY) {
    tyrantSpread(fk);   // virus expansion before its normal actions
    // Court every un-allied rival (AIs decide now; humans are offered on their own turn).
    // Courting stops once the Tyrant hits its concurrent-pact cap (single-human games: 3),
    // and entirely once it has flipped to CONQUEST — a conquest Tyrant never re-instigates
    // diplomacy (it may still ACCEPT a pact petitioned to it, handled on the petitioner's turn).
    let newAlly = false;
    let allAIsRefused = true;
    const courtBlocked = tyrantAtPactCap();
    if (!G.tyrantConquest) {
      livingKeys().filter(k => k!==TYRANT_KEY && G.factions[k].isAI && !hasPact(TYRANT_KEY,k))
        .forEach(k => {
          if (tyrantAtPactCap()) return;
          if (aiConsiderPact(k, TYRANT_KEY)) {
            formPact(TYRANT_KEY, k);
            G.factions[k].boon = aiPickBoon(k);
            newAlly = true;
            allAIsRefused = false;
          }
        });
      if (newAlly) addLog('🦠 The Tyrant whispers — a hidden pact takes hold…');
    }

    // Part 2 Step 5: Tyrant betrayal flip — streak-based, requires 3 consecutive rounds
    // (a cap-blocked round made no offers, so it neither builds nor resets the streak)
    if (!G.tyrantConquest && !courtBlocked) {
      if (!G.tyrantRefusalStreak) G.tyrantRefusalStreak = 0;
      const unAllied = livingKeys().filter(k => k !== TYRANT_KEY && !hasPact(TYRANT_KEY, k));
      if (newAlly) {
        G.tyrantRefusalStreak = 0;
      } else if (unAllied.length > 0 && allAIsRefused) {
        G.tyrantRefusalStreak++;
      }
      if (G.tyrantRefusalStreak >= 3 && unAllied.length > 0) {
        G.tyrantConquest = true;
        addLog('🦠🗡️ THE TYRANT abandons diplomacy — CONQUEST MODE!');
        for (const k of Object.keys(G.pacts||{})) {
          const [a,b] = k.split('|');
          if (a === TYRANT_KEY || b === TYRANT_KEY) {
            const ally = a === TYRANT_KEY ? b : a;
            breakPactBetrayal(TYRANT_KEY, ally);
          }
        }
      }
    }

    // Part 2: Sic boon — each turn the Tyrant lashes out at ONE enemy of each sic-ally.
    // Strikes from its strongest 2+ tile adjacent to that enemy. If the blob has no real
    // adjacency yet (it spreads toward enemies — that takes a round or two), sic simply
    // does nothing this turn rather than nibbling for guaranteed damage.
    for (const ally of livingKeys()) {
      if (ally === TYRANT_KEY || !hasPact(TYRANT_KEY, ally) || G.factions[ally].boon !== 'sic') continue;
      const foe = (t) => t.owner && t.owner !== TYRANT_KEY && t.owner !== ally && !hasPact(TYRANT_KEY, t.owner);
      let atkSrc = null, atkTgt = null, best = 1;
      for (const tt of Object.values(G.tiles)) {
        if (tt.owner !== TYRANT_KEY || tt.troops < 2) continue;
        const adj = Object.values(G.tiles).find(t => foe(t) && adjacent(tt, t));
        if (adj && tt.troops > best) { best = tt.troops; atkSrc = tt; atkTgt = adj; }
      }
      if (atkSrc) {
        resolveAttack(TYRANT_KEY, atkSrc.id, atkTgt.id, false);
        addLog(`🦠 The Tyrant lashes out at ${atkTgt.name} (sic the blob)`);
        renderMap(); renderSidebar();
      }
    }
  }

  // AI redemption: bound AI may renounce-kill the Tyrant
  if (fk !== TYRANT_KEY && hasPact(TYRANT_KEY, fk) && aiShouldRenounceLive(fk)) {
    // Inline renounce-kill (same logic as player renounce)
    delete G.pacts[pairKey(fk, TYRANT_KEY)];
    G.factions[fk].boon = null;
    const rTiles = tilesOf(fk).sort((a,b) => a.troops - b.troops);
    for (let i = 0; i < Math.min(2, rTiles.length); i++) {
      const lost = Math.max(1, Math.floor(rTiles[i].troops / 2));
      rTiles[i].troops = Math.max(1, rTiles[i].troops - lost);
      refreshHex(rTiles[i].id);
    }
    addLog(`🦠💥 ${f.name} RENOUNCES the Tyrant! Withdrawal hit!`);
    tilesOf(TYRANT_KEY).forEach(t => { t.owner = null; t.troops = 0; t.heldRounds = 0; refreshHex(t.id); });
    G.factions[TYRANT_KEY].eliminated = true;
    for (const pk of Object.keys(G.pacts || {})) {
      const [pa, pb] = pk.split('|');
      if (pa === TYRANT_KEY || pb === TYRANT_KEY) {
        const ally = pa === TYRANT_KEY ? pb : pa;
        if (G.factions[ally]) G.factions[ally].boon = null;
        delete G.pacts[pk];
      }
    }
    addLog('💀 THE TYRANT is destroyed — its domain collapses to nothing!');
    for (const [ek, ef] of Object.entries(G.factions)) {
      if (!ef.eliminated || ek === TYRANT_KEY || ek === fk) continue;
      const neutrals = Object.values(G.tiles).filter(t => !t.owner);
      if (neutrals.length === 0) continue;
      ef.eliminated = false; ef.corruption = 0; ef.resources = 3;
      const count = Math.min(2, neutrals.length);
      for (let i = 0; i < count; i++) {
        neutrals[i].owner = ek; neutrals[i].troops = 2; neutrals[i].heldRounds = 0;
        refreshHex(neutrals[i].id);
      }
      G.grudges[ek + '>' + fk] = G.round + 3;
      addLog(`👻 ${ef.name} rises from the ashes — and bears a grudge against ${f.name}!`);
    }
    G.factions[fk].corruption = 0;
    renderMap(); renderSidebar(); syncPush();
  }

  const myTiles    = () => Object.values(G.tiles).filter(t=>t.owner===fk);
  const enemyTiles = () => Object.values(G.tiles).filter(t=>t.owner && t.owner!==fk);
  const findBestAttack = () => {
    let best=null;
    for (const atk of myTiles().filter(t=>t.troops>=2)) {
      for (const def of enemyTiles()) {
        if (!adjacent(atk,def)) continue;
        // Honor pacts — unless we can seize a NODE with a commanding edge (betrayal).
        // The TYRANT never opportunistically betrays an ally; its break is the conquest flip.
        const pact = hasPact(fk, def.owner);
        const canBetray = def.isNode && atk.troops >= def.troops + 2 && fk !== TYRANT_KEY;
        if (pact && !canBetray) continue;
        // Prefer: nodes, then weaker targets, then where we have a troop edge
        const atkPower = Math.min(2, Math.floor(atk.troops/4));
        const defPower = Math.min(2, Math.floor(def.troops/4)) + Math.min(def.heldRounds||0, def.isNode?2:3) + (def.owner===TYRANT_KEY ? 0 : (turnStrikes[fk+'|'+def.owner]||0)*2);  // rally: per-victim, none vs Tyrant
        const edge = (atk.troops - def.troops) + (atkPower - defPower)*2;
        const score = (def.isNode?100:0) + edge*10 - def.troops - (pact?15:0);
        if (!best || score > best.score) best = {atk, def, score, betray:pact};
      }
    }
    return best;
  };

  // Take actions ONE AT A TIME, paced so each combat result is shown on its own. A winning
  // attack "presses the assault" (doesn't spend an action) until repelled, the targets run dry
  // (overextension makes nothing favorable), or a 3-capture safety cap — mirroring the player.
  let actsLeft = 3, aiCaptures = 0;
  const step = () => {
    if (gameOver) return;
    if (actsLeft <= 0) { finishAITurn(fk); return; }
    const result = aiOneAction(fk, f, myTiles, enemyTiles, findBestAttack);  // false | 'won' | 'repelled' | true
    renderSidebar();
    if (checkWin()) return;
    if (!result) { finishAITurn(fk); return; }
    const combat = (result === 'won' || result === 'repelled');
    if (result === 'won') aiCaptures++;
    if (result !== 'won' || aiCaptures >= 3) { actsLeft--; aiCaptures = 0; }   // wins chain; 3-capture cap or repel spends action
    // A combat that involved the local player put an OK popup on screen — the AI waits
    // for the acknowledgment before its next action. AI-vs-AI fights keep the old pacing.
    if (combat && combatQueue.length) onCombatAck(() => setTimeout(step, 400));
    else setTimeout(step, combat ? 900 : 250);   // AI-vs-AI fights show no popup — keep it brisk
  };
  // A Tyrant "sic" strike just above may already have a popup up — wait for it first.
  onCombatAck(() => setTimeout(step, 250));
}

function finishAITurn(fk) {
  if (gameOver) return;
  renderSidebar();
  syncPush();                 // broadcast the AI's completed turn (no-op offline)
  if (checkWin()) return;
  G.currentTurnIdx++;
  setTimeout(doNextTurn, online ? 250 : 300);
}

// One AI action. Returns 'combat' if it fought, true for any other action, false if nothing to do.
function aiOneAction(fk, f, myTiles, enemyTiles, findBestAttack) {
  const best = findBestAttack();
  const attackable = best && best.atk.troops >= 2 && !signalJamActive;
  const myNodes = nodesOf(fk);

  // 0. DEFEND LEAD: when holding 2+ nodes, prioritize reinforcing/entrenching them over expansion.
  if (myNodes.length >= 2) {
    // Entrench an under-defended node first
    const weakNode = myNodes
      .filter(t => (t.heldRounds||0) < (t.isNode?2:3) && t.troops >= 2 && enemyTiles().some(e=>adjacent(t,e)))
      .sort((a,b)=>(a.heldRounds||0)-(b.heldRounds||0))[0];
    if (weakNode && f.resources >= 2) {
      f.resources -= 2;
      weakNode.heldRounds = Math.min((weakNode.heldRounds||0)+1, weakNode.isNode?2:3);
      addLog(`🏰 ${f.icon} ${f.name} entrenched ${weakNode.name} (+${weakNode.heldRounds})`);
      refreshHex(weakNode.id);
      return true;
    }
    // Reinforce the weakest node
    const thinNode = myNodes.filter(t => t.troops < 4).sort((a,b)=>a.troops-b.troops)[0];
    if (thinNode && f.resources >= reinforceCost(fk)) {
      thinNode.troops += reinforceAmount(fk); f.resources -= reinforceCost(fk);
      addLog(`${f.icon} ${f.name} reinforced ${thinNode.name}`);
      refreshHex(thinNode.id);
      return true;
    }
  }

  // 1. Seize an enemy-held NODE when we have the edge — it's the win condition.
  if (attackable && best.def.isNode && best.atk.troops >= best.def.troops) {
    if (best.betray) breakPactBetrayal(fk, best.def.owner);
    return aiAttackWithAdvance(fk, best.atk, best.def);
  }

  // 1b. AIRLIFT to concentrate force before a node assault (free with 🚇 TRANSIT).
  const aCost = airliftCost(fk);
  if (f.resources >= aCost && myTiles().length >= 2) {
    const nodeTarget = enemyTiles().find(t => t.isNode && myTiles().some(m => adjacent(m,t) && m.troops < t.troops));
    if (nodeTarget) {
      const adjTile = myTiles().find(m => adjacent(m, nodeTarget) && m.troops < nodeTarget.troops);
      const donor = myTiles().filter(t => t.id !== adjTile.id && t.troops >= 3).sort((a,b)=>b.troops-a.troops)[0];
      if (adjTile && donor) {
        const n = Math.min(3, donor.troops - 1);
        f.resources -= aCost; donor.troops -= n; adjTile.troops += n;
        addLog(`✈️ ${f.icon} ${f.name} airlifted ${n} troop${n>1?'s':''} to ${adjTile.name}`);
        refreshHex(donor.id); refreshHex(adjTile.id);
        return true;
      }
    }
  }

  // 2. Grab an unclaimed Node we can reach, or march a troop toward the nearest Node.
  if (aiNodePush(fk)) return true;

  // 3. Take any other favorable attack.
  if (attackable && best.atk.troops > best.def.troops) {
    if (best.betray) breakPactBetrayal(fk, best.def.owner);
    return aiAttackWithAdvance(fk, best.atk, best.def);
  }
  // 4. Use special ability opportunistically.
  if (aiUseAbility(f, fk, myTiles, enemyTiles)) return true;
  // 4b. Entrench a well-stacked frontline Node that isn't yet maxed — buy defense.
  if (f.resources >= 2) {
    const maxDig = (t) => t.isNode ? 2 : 3;
    const node = nodesOf(fk)
      .filter(t => t.troops >= 3 && (t.heldRounds||0) < maxDig(t) && enemyTiles().some(e=>adjacent(t,e)))
      .sort((a,b)=>(a.heldRounds||0)-(b.heldRounds||0))[0];
    if (node) {
      f.resources -= 2;
      node.heldRounds = Math.min((node.heldRounds||0)+1, maxDig(node));
      addLog(`🏰 ${f.icon} ${f.name} entrenched ${node.name} (+${node.heldRounds})`);
      refreshHex(node.id);
      return true;
    }
  }
  // 5. Reinforce — prefer a Node or frontline tile we already hold.
  const cost = reinforceCost(fk);
  if (f.resources >= cost && myTiles().length > 0) {
    const priority = myTiles().filter(t => t.isNode || enemyTiles().some(e=>adjacent(t,e)));
    const target = (priority.length ? priority : myTiles()).sort((a,b)=>a.troops-b.troops)[0];
    target.troops += reinforceAmount(fk); f.resources -= cost;
    addLog(`${f.icon} ${f.name} reinforced ${target.name}`);
    refreshHex(target.id);
    return true;
  }
  return false;
}

function aiUseAbility(f, fk, myTiles, enemyTiles) {
  // SABOTAGE: weaken a strong enemy node
  if (f.ability==='sabotage' && f.resources>=1) {
    const foes = enemyTiles().filter(t=>!hasPact(fk,t.owner));
    const target = foes.filter(t=>t.isNode).sort((a,b)=>b.troops-a.troops)[0]
                || foes.sort((a,b)=>b.troops-a.troops)[0];
    if (target) {
      const prev = target.owner;
      f.resources -= 1;
      recordTyrantStrike(fk, prev);   // Step 3: AI sabotaging the blob joins the coalition
      const aiPreTroops = target.troops;  // before the hit
      const aiSabDrop = 2;  // −2 enemy troops
      if (target.troops > aiSabDrop) target.troops -= aiSabDrop; else { target.troops=0; target.owner=null; }
      if (target.owner===null && Object.values(G.tiles).filter(t=>t.owner===prev).length===0) killFaction(prev);
      let aiGain = null;
      if (aiPreTroops > aiSabDrop && !G.siphonedThisTurn) {
        aiGain = ghostSiphonTarget(fk);
        if (aiGain) { aiGain.troops += 2; refreshHex(aiGain.id); G.siphonedThisTurn = true; }
      }
      addLog(`👁️ ${f.name} sabotaged ${target.name}${aiGain ? ` (siphoned +2 to ${aiGain.name})` : ''}`);
      refreshHex(target.id); flashHex(target.id);
      return true;
    }
  }
  // BRIBE: steal from an adjacent enemy — the bribed troop defects to the staging tile (mt)
  if (f.ability==='bribe' && f.resources>=1) {
    for (const mt of myTiles()) {
      const tgt = enemyTiles().find(e=>adjacent(mt,e) && !hasPact(fk,e.owner));
      if (tgt) {
        const prev = tgt.owner;
        f.resources-=1; tgt.troops--; mt.troops++;   // −1 them, +1 you (2-point swing)
        if (tgt.troops<=0) {
          tgt.owner=fk; tgt.troops=1;
          if (Object.values(G.tiles).filter(t=>t.owner===prev).length===0) killFaction(prev);
        }
        addLog(`💰 ${f.name} bribed ${tgt.name} — a troop defects to ${mt.name}!`);
        refreshHex(tgt.id); refreshHex(mt.id);
        return true;
      }
    }
  }
  // RALLY: buff a frontline cluster
  if (f.ability==='rally' && f.resources>=1) {
    const frontline = myTiles().filter(t => enemyTiles().some(e=>adjacent(t,e)));
    if (frontline.length) {
      const hub = frontline[0];
      f.resources-=1; hub.troops++;
      myTiles().filter(t=>adjacent(t,hub)).forEach(t=>{ t.troops++; refreshHex(t.id); });
      addLog(`🌿 ${f.name} rallied around ${hub.name}`);
      refreshHex(hub.id);
      return true;
    }
  }
  // OVERCLOCK (GRID): industrial surge — +3 troops on a key tile
  if (f.ability==='overclock' && f.resources>=1) {
    const priority = myTiles().filter(t => t.isNode || enemyTiles().some(e=>adjacent(t,e)));
    const target = (priority.length ? priority : myTiles()).sort((a,b)=>a.troops-b.troops)[0];
    if (target) {
      f.resources-=1; target.troops+=3;
      addLog(`⚙️ ${f.name} overclocked ${target.name} (+3 troops)`);
      refreshHex(target.id);
      return true;
    }
  }
  return false;
}

// ============================================================
// EVENTS
// ============================================================
function livingKeys() { return Object.keys(G.factions).filter(k=>!G.factions[k].eliminated); }
// "Weakest faction" for events never resolves to the Tyrant — it has its own rise/fall
// mechanics (a harbored Tyrant must be revived by an ALLY, not by a stray Riot).
function weakestKey() {
  return livingKeys().filter(k=>k!==TYRANT_KEY).sort((a,b)=> tilesOf(a).length - tilesOf(b).length)[0];
}

function applyCrash() {
  livingKeys().forEach(k => { G.factions[k].resources = Math.floor(G.factions[k].resources / 2); });
  addLog('💸 EVENT: MARKET CRASH — every faction loses half its resources');
}
// ---- REGIONAL events (receive the round's target region key) ----
function applyPowerFailure(reg) {
  regionTiles(reg).forEach(t => { if (t.owner) { t.troops = Math.max(1, t.troops - 1); t.heldRounds = 0; refreshHex(t.id); } });
  addLog(`⚡ EVENT: POWER FAILURE — ${REGION_NAMES[reg]} loses 1 troop per tile & digs out`);
}
function applyUprising(reg) {
  let hit = 0;
  regionTiles(reg).forEach(t => {
    if (t.owner && t.troops >= 4) { t.troops -= 2; t.heldRounds = 0; hit++; refreshHex(t.id); }
  });
  addLog(`✊ EVENT: THE UPRISING — ${hit} large stack${hit===1?'':'s'} cut down in ${REGION_NAMES[reg]}`);
}
function applyQuake(reg) {
  regionTiles(reg).forEach(t => { if (t.owner) { t.troops = Math.max(1, t.troops - (t.isNode ? 2 : 1)); t.heldRounds = 0; refreshHex(t.id); } });
  addLog(`🌋 EVENT: EARTHQUAKE — ${REGION_NAMES[reg]} shaken; Nodes hit hardest`);
}
function applyRiot(reg) {
  const tiles = regionTiles(reg).filter(t => t.owner && !t.isNode);
  const w = weakestKey();
  if (!tiles.length || !w) { addLog(`🔥 EVENT: RIOT — ${REGION_NAMES[reg]} stays calm`); return; }
  const target = tiles[Math.floor(Math.random() * tiles.length)];
  const prev = target.owner;
  target.owner = w; target.heldRounds = 0; refreshHex(target.id);
  if (prev !== w && tilesOf(prev).length === 0) killFaction(prev);
  addLog(`🔥 EVENT: RIOT — ${target.name} in ${REGION_NAMES[reg]} falls to ${G.factions[w].name}`);
}
function applySiege(reg) {
  let n = 0;
  regionTiles(reg).forEach(t => { if (t.heldRounds) { t.heldRounds = 0; n++; refreshHex(t.id); } });
  addLog(`⚔️ EVENT: SIEGE — entrenchment broken across ${REGION_NAMES[reg]} (${n} tile${n===1?'':'s'})`);
}
function applyMuster(reg) {
  regionTiles(reg).forEach(t => { if (t.owner) { t.troops++; refreshHex(t.id); } });
  addLog(`🎖️ EVENT: MUSTER — +1 troop on every held tile in ${REGION_NAMES[reg]}`);
}
function applyGoldStrike(reg) {
  const tiles = regionTiles(reg);
  livingKeys().forEach(k => { const n = tiles.filter(t => t.owner === k).length; if (n) G.factions[k].resources = Math.min(G.factions[k].resources + n, RES_CAP); });
  addLog(`💰 EVENT: GOLD STRIKE — ${REGION_NAMES[reg]} pays +1 res per tile held there`);
}

// ---- GLOBAL events ----
function applyRevolution() {
  const alive = livingKeys();
  let leader = null, bestN = -1, bestT = -1;
  alive.forEach(k => { const n = countNodes(k), t = tilesOf(k).length; if (n > bestN || (n === bestN && t > bestT)) { bestN = n; bestT = t; leader = k; } });
  if (!leader || bestN <= 0) { addLog('🚩 EVENT: REVOLUTION — but no Node leader to topple'); return; }
  const their = nodesOf(leader);
  const node = their[Math.floor(Math.random() * their.length)];
  node.owner = null; node.troops = 0; node.heldRounds = 0; refreshHex(node.id);
  addLog(`🚩 EVENT: REVOLUTION — ${G.factions[leader].name} loses ${node.name} to the mob`);
}
function applyTotalWar() {
  totalWar = true;
  Object.values(G.tiles).forEach(t => { if (t.heldRounds) { t.heldRounds = 0; refreshHex(t.id); } });
  addLog('⚔️ EVENT: TOTAL WAR — entrenchment wiped, attackers strike +1 this round!');
}
function applyInsurgency() {
  const w = weakestKey();
  if (!w) return;
  const f = G.factions[w];
  f.resources = Math.min(f.resources + 3, RES_CAP);
  const mine = tilesOf(w).sort((a,b)=>b.troops-a.troops);
  if (mine.length) for (let i = 0; i < 4; i++) { const t = mine[i % mine.length]; t.troops++; refreshHex(t.id); }
  addLog(`✊ EVENT: INSURGENCY — ${f.name} gains +4 troops & +3 resources`);
}

function showEventCard(ev, cb, reg) {
  document.getElementById('event-type').textContent  = ev.type+' EVENT';
  document.getElementById('event-title').textContent = ev.title + (reg ? ' · ' + REGION_NAMES[reg] : '');
  document.getElementById('event-body').textContent  = ev.body;
  document.getElementById('event-choices').style.display = 'none';
  document.getElementById('event-ok').style.display = '';
  document.getElementById('event-overlay').classList.add('show');
  pendingEvent = cb;
}

// Informational copy of the round's event card for non-driver clients online (closes, no engine effect).
function showEventCardInfo(card) {
  if (document.getElementById('event-overlay').classList.contains('show')) return; // already showing one
  showEventCard({ type: card.type, title: card.title, body: card.body }, function(){}, card.reg);
}

// Choice event: each living faction decides for itself — every (hot-seat) human in turn
// via buttons, AI via aiChoose. Options a faction can't afford are disabled, never silent no-ops.
function showChoiceEvent(ev, cb) {
  const humans = (G.humans || []).filter(k => G.factions[k] && !G.factions[k].eliminated);
  const queue = humans.slice();
  const finish = () => {
    Object.keys(G.factions)
      .filter(k => !humans.includes(k) && !G.factions[k].eliminated)
      .forEach(k => { ev.choices[ ev.aiChoose ? ev.aiChoose(k) : 0 ].resolve(k); });
    document.getElementById('event-overlay').classList.remove('show');
    cb();
  };
  const askNext = () => {
    if (!queue.length) { finish(); return; }
    const fk = queue.shift();
    const f  = G.factions[fk];
    document.getElementById('event-type').textContent  = 'CHOICE EVENT';
    document.getElementById('event-title').textContent = ev.title;
    document.getElementById('event-body').textContent  = ev.body +
      (humans.length > 1 ? `\n\n${f.icon} ${f.name} decides…` : '');
    document.getElementById('event-ok').style.display = 'none';
    const box = document.getElementById('event-choices');
    box.style.display = 'flex';
    box.innerHTML = '';
    ev.choices.forEach((ch) => {
      const b = document.createElement('button');
      b.className = 'btn btn-secondary';
      b.style.cssText = 'font-size:14px; padding:10px 14px; text-align:left;';
      const affordable = !ch.canPick || ch.canPick(fk);
      b.textContent = affordable ? ch.label : `${ch.label} — can't afford (${f.resources} res)`;
      if (!affordable) { b.disabled = true; b.style.opacity = '0.45'; b.style.cursor = 'not-allowed'; }
      b.onclick = () => {
        ch.resolve(fk);
        addLog(`🃏 ${ev.title}: ${f.name} chose "${ch.label}"`);
        askNext();
      };
      box.appendChild(b);
    });
    document.getElementById('event-overlay').classList.add('show');
  };
  askNext();
}

// Online choice event: each human player picks on their own device.
// Driver collects all choices, then resolves and proceeds.
function showOnlineChoiceUI() {
  if (!G.pendingChoiceEvent) return;
  const pce = G.pendingChoiceEvent;
  const ev = EVENTS[pce.evIdx];
  if (!ev || !ev.choices) return;
  const myPending = mySeats.filter(k => pce.pending.includes(k) && !(pce.choicesMade && pce.choicesMade[k] !== undefined));
  if (myPending.length === 0) {
    // Already chosen — show informational "waiting" card
    if (!document.getElementById('event-overlay').classList.contains('show')) {
      document.getElementById('event-type').textContent = 'CHOICE EVENT';
      document.getElementById('event-title').textContent = ev.title;
      document.getElementById('event-body').textContent  = ev.body + '\n\n⏳ Waiting for other players…';
      document.getElementById('event-choices').style.display = 'none';
      document.getElementById('event-ok').style.display = '';
      document.getElementById('event-overlay').classList.add('show');
      pendingEvent = null;
    }
    return;
  }
  const fk = myPending[0];
  document.getElementById('event-type').textContent  = 'CHOICE EVENT';
  document.getElementById('event-title').textContent = ev.title;
  document.getElementById('event-body').textContent  = ev.body;
  document.getElementById('event-ok').style.display  = 'none';
  const box = document.getElementById('event-choices');
  box.style.display = 'flex';
  box.innerHTML = '';
  ev.choices.forEach((ch, idx) => {
    const b = document.createElement('button');
    b.className = 'btn btn-secondary';
    b.style.cssText = 'font-size:14px; padding:10px 14px; text-align:left;';
    const affordable = !ch.canPick || ch.canPick(fk);
    b.textContent = affordable ? ch.label : `${ch.label} — can't afford (${G.factions[fk].resources} res)`;
    if (!affordable) { b.disabled = true; b.style.opacity = '0.45'; b.style.cursor = 'not-allowed'; }
    b.onclick = () => {
      if (!G.pendingChoiceEvent) return;
      G.pendingChoiceEvent.choicesMade[fk] = idx;
      addLog(`🃏 ${ev.title}: ${G.factions[fk].name} chose "${ch.label}"`);
      document.getElementById('event-overlay').classList.remove('show');
      syncPush();
      checkOnlineChoicesDone();
    };
    box.appendChild(b);
  });
  document.getElementById('event-overlay').classList.add('show');
}

function checkOnlineChoicesDone() {
  if (!isDriver || !G.pendingChoiceEvent) return;
  const pce = G.pendingChoiceEvent;
  const allDone = pce.pending.every(k => pce.choicesMade && pce.choicesMade[k] !== undefined);
  if (!allDone) return;
  const ev = EVENTS[pce.evIdx];
  pce.pending.forEach(k => { ev.choices[pce.choicesMade[k]].resolve(k); });
  delete G.pendingChoiceEvent;
  renderMap(); renderSidebar();
  syncPush();
  doNextTurn();
}

function dismissEvent() {
  document.getElementById('event-overlay').classList.remove('show');
  if (pendingEvent) { const cb=pendingEvent; pendingEvent=null; cb(); }
}

// ============================================================
// WIN CHECK
// ============================================================
function checkWin() {
  // Node dominance tracking: announce when someone reaches 3+ nodes, clear when they drop below.
  // The actual node-hold WIN is checked in endRound (must hold for 2 consecutive round-ends).
  if (!G.nodesHeldSince) G.nodesHeldSince = {};
  for (const [k,f] of Object.entries(G.factions)) {
    if (f.eliminated) { delete G.nodesHeldSince[k]; continue; }
    const n = countNodes(k);
    if (n >= 3 && !G.nodesHeldSince[k]) {
      G.nodesHeldSince[k] = G.round;
      addLog(`⚠️ ${f.name} controls ${n} Nodes! Must hold for 2 rounds to win.`);
    } else if (n < 3 && G.nodesHeldSince[k]) {
      delete G.nodesHeldSince[k];
      addLog(`📢 ${f.name} lost node dominance — hold timer reset.`);
    }
  }
  // The Tyrant wins by diplomacy: a (secret) pact with EVERY surviving rival = no enemies left.
  // NEVER in a single-human game — the lone human must always keep a path to the Reckoning,
  // so the Tyrant can't win by ally-default even after eliminations shrink the field.
  const soloHuman = (G.humans ? G.humans.length : 0) === 1;
  if (tyrantAlive() && !soloHuman) {
    const others = livingKeys().filter(k => k !== TYRANT_KEY);
    if (others.length > 0 && others.every(k => hasPact(TYRANT_KEY, k))) {
      showWin(TYRANT_KEY, 'NO ENEMIES LEFT', 'The Tyrant bought peace with every rival — and rules Nexus by default.');
      return true;
    }
  }
  const alive = Object.entries(G.factions).filter(([,f])=>!f.eliminated);
  if (alive.length===1) {
    const [wk, wf] = alive[0];
    const r = maybeReckoningApp(wk);
    if (r === 'thralldom') return true;
    if (r === 'freedom') { showWin(wk, 'RECKONING (FREEDOM)', `${wf.name} fought off the Tyrant and claimed Nexus!`); return true; }
    showWin(wk,'LAST STANDING',`${wf.name} eliminated all rivals.`);
    return true;
  }
  return false;
}

function showWin(fk, condition, detail) {
  gameOver = true;
  G.winner = { fk, condition, detail, round: G.round };  // recorded so it can broadcast online
  syncPush();
  renderWin(G.winner);
}

function renderWin(w) {
  const f = G.factions[w.fk];
  const humanWon = !f.isAI;  // a human seat took it

  // CONQUEST TAKEOVER: every tile on the board flips to the winner's themed hex.
  Object.values(G.tiles).forEach(t => { t.owner = w.fk; t.troops = 0; t.heldRounds = 0; });
  switchScreen('game-screen');
  selectedTile = null; currentAction = null;
  renderMap(); renderSidebar();
  disablePlayerActions();
  document.getElementById('phase-label').textContent = `ROUND ${w.round} · GAME OVER`;
  const lbl = document.getElementById('turn-label');
  lbl.className = 'turn-indicator';
  lbl.textContent = `${f.icon} ${f.name}`;

  // Banner over the conquered board.
  document.getElementById('win-title').textContent   = humanWon ? '⚡ VICTORY!' : '💀 AI WINS';
  document.getElementById('win-title').style.color   = humanWon ? 'var(--node-glow)' : 'var(--syndicate)';
  const head = document.getElementById('conquest-headline');
  head.textContent  = `${f.icon} ${f.name} CONTROLS NEXUS GRID!`;
  head.style.color  = f.color;
  document.getElementById('win-subtitle').textContent = w.condition;
  document.getElementById('win-detail').textContent   = w.detail + ` (Round ${w.round})`;
  const banner = document.querySelector('.conquest-banner');
  if (banner) banner.style.borderColor = f.color;
  document.getElementById('conquest-overlay').classList.add('show');
  document.getElementById('rules-btn').style.display = 'none';
}

function openRules()  { document.getElementById('rules-overlay').classList.add('show'); }
function closeRules() { document.getElementById('rules-overlay').classList.remove('show'); }

// ============================================================
// TUTORIAL — coach-mark tour on a controlled round-1 board.
// Spotlights one element at a time (dim strips around it, leaving it tappable),
// with a tooltip card and Back/Next/Skip. AI is frozen so the board holds still.
// ============================================================
// Steps run across real screens: an optional onEnter navigates/sets up the screen
// (title → setup → the controlled game board), then we spotlight a target on it.
const TUT_STEPS = [
  { onEnter: showTitle, target: null, title: '⚔️ Welcome to FRACTURE',
    body: 'Four factions fight over a broken grid. <b>Hold any 3 ★ Core Nodes for two straight rounds — or wipe out every rival — to win.</b><br><br>This tour walks you from setup to your first moves. You\'ll play <b style="color:#f39c12">⚙️ THE GRID</b>.' },
  { onEnter: showTitle, target: '#btn-online', title: '🌐 Solo, hot-seat, or online',
    body: '<b>NEW GAME</b> plays on one device — versus AI, or pass-and-play with friends. <b>PLAY ONLINE</b> hosts a room: you get a <b>4-letter code</b>, friends join from their own phones, everyone readies up, and you start once all are set.' },
  { onEnter: showSetup, target: '#setup-grid .setup-card', title: '🎭 Factions & seats',
    body: 'Before a match you configure all four factions — set each to a <b>Human</b> or an <b>AI</b>. Every faction has a unique <b>ability + perk</b>: Grid reinforces cheap and can Overclock, Syndicate bribes troops away, Commune grows reinforcements, Ghost sabotages and slips through walls.' },
  { onEnter: showSetup, target: '#setup-grid .trait-select', title: '🧬 Your passive trait',
    body: 'Each human also picks a <b>passive trait</b> — a perk that lasts the whole game. <b>Scavenger</b> loots resources on every capture, <b>Tactician</b> rolls better dice, <b>Fortify</b> hardens fresh tiles, <b>Hoarder</b> earns more per node. Pick to fit your plan.' },
  { onEnter: showSetup, target: '#setup-grid .setup-card:last-child', title: '🦠 The Tyrant (optional)',
    body: 'Toggle <b>THE TYRANT</b> for a harder, wilder game: an AI <b>virus</b> that festers at the center, <b>spreads every round</b>, and can win by force <em>or</em> by striking a secret pact with <em>every</em> survivor. A shared threat — exploit it, ally with it, or unite to burn it out.' },
  { onEnter: ensureTutorialGame, target: '#hex-tile_0_0', title: '🏰 Your territory',
    body: 'Now into a real game. This corner is yours — the <b>number</b> on a hex is its <b>troop count</b>. You can move to and attack the tiles directly <b>touching</b> yours.' },
  { onEnter: ensureTutorialGame, target: '#hex-tile_1_1', title: '★ Core Nodes',
    body: 'Star tiles are <b>Core Nodes</b>. Each earns +1 resource and a passive perk (this ⚡ one makes Reinforce cheaper). <b>Hold any 3 for two straight rounds and you win</b> — so nodes are everything.' },
  { onEnter: ensureTutorialGame, target: '#action-panel', title: '🔄 Your turn',
    body: 'Each round: an <b>event</b> fires, you collect <b>income</b> (2 + 1 per node), then take <b>3 actions</b> from this bar.' },
  { onEnter: ensureTutorialGame, target: '#player-stats', title: '🎒 Resources & actions',
    body: 'Your <b>resources</b> and <b>actions left</b> live here. Resources buy strength; actions buy moves, fights, and building.' },
  { onEnter: ensureTutorialGame, target: '#btn-move', title: '🚶 Move',
    body: '<b>MOVE</b> shifts troops between your tiles to mass an army or step onto an empty node. Tap it, then a tile, then where to send them.' },
  { onEnter: ensureTutorialGame, target: '#btn-reinforce', title: '🛡️ Reinforce',
    body: '<b>REINFORCE</b> spends resources to add troops to a tile — Grid pays 1 less. Money becomes muscle.' },
  { onEnter: ensureTutorialGame, target: '#hex-tile_1_0', title: '⚔️ Attack & combat',
    body: 'That weak enemy is right next to you. <b>ATTACK</b> → your tile → the enemy. Both roll <b>2d6</b> + bonuses (+1 per 4 troops, capped +2; defenders add dig-in). <b>Attacker wins ties</b>, and a win lets you keep pressing the assault.' },
  { onEnter: ensureTutorialGame, target: '#btn-overclock', title: '⚙️ Your faction power',
    body: 'Every faction has a unique <b>ability</b> + <b>perk</b>. Grid\'s <b>OVERCLOCK</b> surges +3 troops onto a tile, and its reinforces cost less. Yours is your edge — learn it.' },
  { onEnter: ensureTutorialGame, target: '#btn-pact', title: '🤝 Pacts & betrayal',
    body: '<b>PACT</b> a rival for free non-aggression — buy time, or team up on the leader. <b>Break it to backstab</b> and the victim gets <b>+2</b> against you for two rounds. And anyone holding 2+ nodes gets <b>everyone</b> piling on — no runaway winner.' },
  { onEnter: ensureTutorialGame, target: '.end-turn-btn', title: '✅ End your turn',
    body: 'Spent your 3 actions? <b>END TURN</b> hands off. That\'s the whole loop!<br><br>Round events and more are in <b>📖 FULL RULES</b>. Ready to play for real?' },
];

function startTutorial() {
  if (typeof resetNet === 'function') resetNet();
  online = false; gameOver = false;
  tutorialMode = true; tutorialStep = 0;
  tutorialShow(0);   // step 0's onEnter sets the screen
}

// Build the controlled round-1 board for the gameplay half of the tour. Idempotent:
// re-entered when the player steps forward from the setup half.
function ensureTutorialGame() {
  if (G && G.tutBuilt && document.getElementById('game-screen').classList.contains('active')) return;
  online = false; gameOver = false;
  const factions = {
    grid:      mkFaction('YOU', 'grid', false, 'scavenger'),
    syndicate: mkFaction('SYNDICATE', 'syndicate', true, 'fortify'),
    commune:   mkFaction('COMMUNE', 'commune', true, 'hoarder'),
    ghost:     mkFaction('THE GHOST', 'ghost', true, 'tactician'),
  };
  G = {
    round: 1, signalJam: false, currentTurnIdx: 0, actionsUsed: 0,
    factions, turnOrder: ['grid', 'syndicate', 'commune', 'ghost'], humans: ['grid'],
    tyrantOn: false, tyrantHarbor: 0, tyrantLastOffer: {}, tyrantStruck: {}, tyrantConquest: false,
    nodesHeldSince: {}, tiles: {}, log: [], pacts: {}, grudges: {}, playerFaction: 'grid', tutBuilt: true,
  };
  G.tiles = buildMap();
  // Deterministic teaching layout: wipe random faction placement, put Grid in the NW corner
  // with a weak enemy scout adjacent (attack demo) and the ⚡ POWER node one tile away.
  Object.values(G.tiles).forEach(t => { if (!t.isNode) { t.owner = null; t.troops = 0; t.heldRounds = 0; } });
  const set = (id, owner, troops) => { const t = G.tiles[id]; if (t) { t.owner = owner; t.troops = troops; t.heldRounds = 0; } };
  set('tile_0_0', 'grid', 4); set('tile_0_1', 'grid', 3);
  set('tile_1_0', 'commune', 1);                                  // weak scout to attack (adjacent to 0_0)
  set(`tile_0_${GRID-1}`, 'syndicate', 2); set(`tile_1_${GRID-1}`, 'syndicate', 2);
  set(`tile_${GRID-1}_0`, 'commune', 2);
  set(`tile_${GRID-1}_${GRID-1}`, 'ghost', 2); set(`tile_${GRID-1}_${GRID-2}`, 'ghost', 2);
  // tile_1_1 (POWER node) stays neutral as the nearby objective.
  mySeats = ['grid']; G.playerFaction = 'grid';
  myTurnActive = true; isDriver = true; currentAction = null; selectedTile = null;
  switchScreen('game-screen');
  document.getElementById('rules-btn').style.display = 'flex';
  renderMap(); renderSidebar();
  enablePlayerActions('grid');
  const tl = document.getElementById('turn-label'); tl.textContent = '⚡ TUTORIAL'; tl.className = 'turn-indicator your-turn';
  document.getElementById('phase-label').textContent = 'LEARN TO PLAY';
  setActionLog('Follow the tour — tap NEXT. You can try the highlighted controls anytime.');
}

function tutorialShow(i) {
  tutorialStep = i;
  const step = TUT_STEPS[i];
  if (step.onEnter) step.onEnter();   // navigate/build the right screen first
  document.getElementById('tutorial-overlay').classList.add('show');
  document.getElementById('tut-step').textContent  = `${i + 1} / ${TUT_STEPS.length}`;
  document.getElementById('tut-title').textContent = step.title;
  document.getElementById('tut-body').innerHTML    = step.body;
  document.getElementById('tut-back').style.visibility = i === 0 ? 'hidden' : 'visible';
  document.getElementById('tut-next').textContent = i === TUT_STEPS.length - 1 ? 'FINISH ✓' : 'NEXT →';
  tutorialReposition();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tutorialReposition);  // after layout settles
}

function tutorialReposition() {
  if (!tutorialMode) return;
  const ov = document.getElementById('tutorial-overlay');
  if (!ov || !ov.classList.contains('show')) return;
  const step = TUT_STEPS[tutorialStep]; if (!step) return;
  const el = step.target ? document.querySelector(step.target) : null;
  const vw = window.innerWidth || 390, vh = window.innerHeight || 800;
  const T = document.getElementById('tut-top'), B = document.getElementById('tut-bottom');
  const L = document.getElementById('tut-left'), R = document.getElementById('tut-right');
  const ring = document.getElementById('tut-ring'), card = document.getElementById('tut-card');
  const put = (e, x, y, w, h) => { e.style.left = x + 'px'; e.style.top = y + 'px'; e.style.width = Math.max(0, w) + 'px'; e.style.height = Math.max(0, h) + 'px'; };
  const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
  if (r && (r.width > 0 || r.height > 0)) {
    put(T, 0, 0, vw, r.top);
    put(B, 0, r.bottom, vw, vh - r.bottom);
    put(L, 0, r.top, r.left, r.height);
    put(R, r.right, r.top, vw - r.right, r.height);
    ring.style.display = 'block';
    put(ring, r.left - 5, r.top - 5, r.width + 10, r.height + 10);
    const cw = card.offsetWidth || 300, ch = card.offsetHeight || 170;
    let top = (r.top + r.height / 2 > vh / 2) ? r.top - ch - 14 : r.bottom + 14;
    top = Math.max(8, Math.min(top, vh - ch - 8));
    let left = Math.max(8, Math.min(r.left + r.width / 2 - cw / 2, vw - cw - 8));
    card.style.left = left + 'px'; card.style.top = top + 'px';
  } else {
    // No target (or unmeasured): dim everything, center the card.
    put(T, 0, 0, vw, vh); put(B, 0, 0, 0, 0); put(L, 0, 0, 0, 0); put(R, 0, 0, 0, 0);
    ring.style.display = 'none';
    const cw = card.offsetWidth || 300, ch = card.offsetHeight || 170;
    card.style.left = Math.max(8, vw / 2 - cw / 2) + 'px';
    card.style.top = Math.max(8, vh / 2 - ch / 2) + 'px';
  }
}

function tutorialNext() { if (tutorialStep >= TUT_STEPS.length - 1) { endTutorial(); return; } tutorialShow(tutorialStep + 1); }
function tutorialBack() { if (tutorialStep > 0) tutorialShow(tutorialStep - 1); }

function endTutorial() {
  tutorialMode = false;
  document.getElementById('tutorial-overlay').classList.remove('show');
  document.body.classList.remove('drawer-open');
  try { localStorage.setItem('fracture_seen', '1'); } catch (e) {}
  showSetup();   // back to the setup screen so they pick their own game
}

// First-run: offer the tour the first time someone opens the game.
function maybeFirstRun() {
  try { if (localStorage.getItem('fracture_seen') === '1') return; } catch (e) { return; }
  const ov = document.getElementById('firstrun-overlay');
  if (ov) ov.classList.add('show');
}
function firstrunSkip()  { try { localStorage.setItem('fracture_seen', '1'); } catch (e) {} document.getElementById('firstrun-overlay').classList.remove('show'); }
function firstrunStart() { firstrunSkip(); startTutorial(); }

// ============================================================
// ONLINE MULTIPLAYER — Firebase Realtime Database
// Rooms by code · full-state broadcast · active-player engine baton.
// All of this is dormant until the player taps PLAY ONLINE.
// ============================================================
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDVa8eOLH6CXTt1nbgH9v7mkAb-RtgcbXg",
  authDomain: "fracture-105c1.firebaseapp.com",
  databaseURL: "https://fracture-105c1-default-rtdb.firebaseio.com",
  projectId: "fracture-105c1",
  storageBucket: "fracture-105c1.firebasestorage.app",
  messagingSenderId: "926577785338",
  appId: "1:926577785338:web:8c5170c92ced85e7b9cc43",
  measurementId: "G-6GHGZ28Q7W"
};

function initFirebase() {
  if (fbInited) return !!db;
  if (typeof firebase === 'undefined') return false;
  try { firebase.initializeApp(FIREBASE_CONFIG); db = firebase.database(); fbInited = true; return true; }
  catch (e) { console.error('Firebase init failed:', e); return false; }
}

// Per-TAB client id (sessionStorage): survives a refresh, but two tabs of the same browser
// are distinct players — so you can test multiplayer in two tabs, and real players never collide.
function clientId() {
  let id;
  try { id = sessionStorage.getItem('fracture_cid'); } catch (e) {}
  if (!id) {
    id = 'c' + Math.random().toString(36).slice(2, 10);
    try { sessionStorage.setItem('fracture_cid', id); } catch (e) {}
  }
  return id;
}

function resetNet() {
  detachRoom();
  online = false; isDriver = true; myTurnActive = false; applyingRemote = false;
  onlineStarting = false; lobbyIsHost = false; roomCode = null; lastRoomData = null;
}
function detachRoom() { if (roomRef) { roomRef.off(); } roomRef = null; stateRef = null; }

// --- the engine's broadcast hook, now real ---
netPushState = function () {
  if (!stateRef) return;
  G.seq = (G.seq || 0) + 1;
  const snap = Object.assign({}, G, { _signalJam: signalJamActive, _totalWar: totalWar, _gameOver: gameOver });
  stateRef.set(JSON.parse(JSON.stringify(snap)));
};

function loadRemoteState(s) {
  const sj = !!s._signalJam, tw = !!s._totalWar, go = !!s._gameOver;
  const clean = Object.assign({}, s); delete clean._signalJam; delete clean._totalWar; delete clean._gameOver;
  // Firebase strips empty objects/arrays — restore the containers the engine assumes exist.
  clean.pacts          = clean.pacts          || {};
  clean.grudges        = clean.grudges        || {};
  clean.log            = clean.log            || [];
  clean.tyrantLastOffer = clean.tyrantLastOffer || {};
  clean.tyrantStruck    = clean.tyrantStruck    || {};
  clean.pactRenewals    = clean.pactRenewals    || {};
  clean.nodesHeldSince  = clean.nodesHeldSince  || {};
  if (clean.pendingChoiceEvent) clean.pendingChoiceEvent.choicesMade = clean.pendingChoiceEvent.choicesMade || {};
  G = clean;
  signalJamActive = sj; totalWar = tw; gameOver = go;
  if (mySeats.length) G.playerFaction = mySeats[0];  // always view through my own seat
}

function ensureGameScreen() {
  if (!document.getElementById('game-screen').classList.contains('active')) {
    switchScreen('game-screen');
    document.getElementById('rules-btn').style.display = 'flex';
  }
}

// Apply a freshly received snapshot and route the turn.
function onRemoteState(s) {
  if (!s) return;
  if (typeof s.seq === 'number' && s.seq <= (G.seq || 0)) return;   // ignore our own echo / stale writes
  applyingRemote = true;
  loadRemoteState(s);
  applyingRemote = false;

  ensureGameScreen();
  renderMap(); renderSidebar();

  // Deliver pending pact offers and expiry votes immediately — the recipient responds
  // out of turn, like the online choice events below.
  maybeShowPactOffer();
  maybeShowPactRenewals();

  // Show this round's event card here too, so every player sees it (not just the driver).
  if (G.eventCard && G.eventCard.n > lastShownEventN) {
    lastShownEventN = G.eventCard.n;
    if (G.pendingChoiceEvent) {
      showOnlineChoiceUI();   // choice event: show buttons, not just an info card
    } else {
      showEventCardInfo(G.eventCard);
    }
  }

  // Online choice event: re-show choice UI if overlay was closed but I haven't chosen yet
  if (G.pendingChoiceEvent) {
    const pce = G.pendingChoiceEvent;
    const myPending = mySeats.filter(k => pce.pending.includes(k) && !(pce.choicesMade && pce.choicesMade[k] !== undefined));
    if (myPending.length > 0 && !document.getElementById('event-overlay').classList.contains('show')) {
      showOnlineChoiceUI();
    }
    checkOnlineChoicesDone();
    return;   // don't route turns while a choice event is pending
  }

  if (gameOver) { if (G.winner) renderWin(G.winner); return; }

  const a = activeFk(), f = a && G.factions[a];
  if (G.live && f && !f.isAI && mySeats.includes(a)) {
    if (!myTurnActive) { isDriver = true; beginTurnFor(a); }   // my turn — take the baton
  } else {
    // Spectating: an AI turn, a remote human's turn, or the game not yet live (host still setting up).
    myTurnActive = false; isDriver = false;
    disablePlayerActions();
    const lbl = document.getElementById('turn-label');
    lbl.className = 'turn-indicator';
    lbl.textContent = !G.live ? '⏳ STARTING…' : (f ? (f.isAI ? `${f.icon} AI` : `⌛ ${f.name}`) : '');
    document.getElementById('phase-label').textContent = `ROUND ${G.round}${f ? ' · ' + f.name : ''}`;
    setActionLog(!G.live ? 'The host is starting the game…' : (f ? (f.isAI ? `${f.name} is moving…` : `Waiting for ${f.name}…`) : ''));
  }
}

// ============================================================
// LOBBY
// ============================================================
function goOnline() {
  if (!initFirebase()) { alert('Online play is unavailable — Firebase did not load. Check your connection and reload.'); return; }
  online = true;
  myClientId = clientId();
  switchScreen('lobby-screen');
  renderLobbyHome();
}

function renderLobbyHome() {
  document.getElementById('lobby-body').innerHTML = `
    <div class="setup-card" style="max-width:420px; margin:0 auto;">
      <h3>🌐 ONLINE GAME</h3>
      <p style="font-size:13px;color:#aaa;margin-bottom:14px;line-height:1.5;">Host a new room and share the 4-letter code, or join a friend's room.</p>
      <button class="btn btn-primary" style="width:100%;margin-bottom:14px;font-size:22px;" onclick="hostRoom()">🎮 HOST A ROOM</button>
      <div style="display:flex;gap:8px;margin-bottom:12px;">
        <input class="input-field" id="join-code" placeholder="ROOM CODE" maxlength="4" style="text-transform:uppercase;margin:0;flex:1;">
        <button class="btn btn-secondary" style="font-size:18px;" onclick="joinRoomPrompt()">JOIN →</button>
      </div>
      <button class="btn btn-secondary" style="width:100%;font-size:16px;" onclick="showTitle()">← BACK</button>
    </div>`;
}

function genCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  // no confusable chars
  let s = ''; for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

function hostRoom() {
  lobbyIsHost = true;
  lobbyStep = 1;
  roomCode = genCode();
  roomRef = db.ref('rooms/' + roomCode);
  stateRef = roomRef.child('state');
  // All seats OPEN by default so anyone can claim one; unclaimed seats become AI at START.
  const seats = {};
  Object.keys(FACTIONS).forEach(k => seats[k] = { type: 'human', by: null, name: '', trait: '', ready: false });
  roomRef.set({ host: myClientId, started: false, seats, tyrant: false })
    .then(() => roomRef.on('value', onRoom))
    .catch(e => alert('Could not create room: ' + e.message));
}

function joinRoomPrompt() {
  const code = (document.getElementById('join-code').value || '').trim().toUpperCase();
  if (code.length < 4) { alert('Enter the 4-letter room code.'); return; }
  roomCode = code; lobbyIsHost = false; lobbyStep = 1;
  roomRef = db.ref('rooms/' + roomCode);
  stateRef = roomRef.child('state');
  roomRef.once('value').then(snap => {
    if (!snap.exists()) { alert('No room found with code ' + code); roomRef = null; return; }
    roomRef.on('value', onRoom);
  });
}

function onRoom(snap) {
  const data = snap.val();
  if (!data) return;
  lastRoomData = data;
  mySeats = Object.keys(data.seats || {}).filter(k => data.seats[k].type === 'human' && data.seats[k].by === myClientId);
  if (data.started && data.state) onRemoteState(data.state);
  else renderLobby(data);
}

function setMyName(v) {
  myName = v;
  const b = document.getElementById('wiz-next');
  if (b) { const ok = !!v.trim(); b.style.opacity = ok ? '' : '0.4'; b.style.pointerEvents = ok ? '' : 'none'; }
}
function hostSetTyrant() {
  if (!lobbyIsHost) return;
  roomRef.update({ tyrant: !(lastRoomData && lastRoomData.tyrant) });
}

// ============================================================
// ONLINE LOBBY — guided wizard: name → faction → passive → ready
// Works the same on laptop and mobile (single centered card, big tap targets).
// ============================================================
function mySeatKey(data) {
  const s = (data && data.seats) || {};
  return Object.keys(s).find(k => s[k] && s[k].by === myClientId) || null;
}
const esc = (v) => String(v || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// One seat write, optimistically mirrored into lastRoomData so the UI is instant.
function writeSeat(fk, seat) {
  if (lastRoomData) { lastRoomData.seats = lastRoomData.seats || {}; lastRoomData.seats[fk] = seat; }
  if (roomRef) roomRef.child('seats/' + fk).set(seat);
}
function clearMyOtherSeats(exceptFk) {
  const seats = (lastRoomData && lastRoomData.seats) || {};
  Object.keys(seats).forEach(k => {
    if (k !== exceptFk && seats[k].by === myClientId) writeSeat(k, { type: 'human', by: null, name: '', trait: '', ready: false });
  });
}

function lobbyNext() {
  if (lobbyStep === 1) { if (!myName.trim()) { alert('Enter your name to continue.'); return; } lobbyStep = 2; }
  else if (lobbyStep === 2) { if (!mySeatKey(lastRoomData)) { alert('Tap a faction to claim your seat.'); return; } lobbyStep = 3; }
  else if (lobbyStep === 3) { if (!myTrait) { alert('Choose a passive trait.'); return; } lobbyStep = 4; }
  renderLobby(lastRoomData);
}
function lobbyBack() { if (lobbyStep > 1) { lobbyStep--; renderLobby(lastRoomData); } }
function lobbyEdit() { lobbyStep = 2; const k = mySeatKey(lastRoomData); if (k) writeSeat(k, { ...lastRoomData.seats[k], ready: false }); renderLobby(lastRoomData); }

function lobbyPickFaction(fk) {
  const seats = (lastRoomData && lastRoomData.seats) || {};
  const taken = seats[fk] && seats[fk].by && seats[fk].by !== myClientId;
  if (taken) return;
  clearMyOtherSeats(fk);
  // Keep my trait only if it's still legal for the new faction.
  if (myTrait && (TRAIT_EXCLUSIONS[fk] || []).includes(myTrait)) myTrait = '';
  writeSeat(fk, { type: 'human', by: myClientId, name: myName.trim(), trait: myTrait || '', ready: false });
  renderLobby(lastRoomData);
}
function lobbyPickTrait(id) {
  const fk = mySeatKey(lastRoomData);
  if (!fk) { lobbyStep = 2; renderLobby(lastRoomData); return; }
  if ((TRAIT_EXCLUSIONS[fk] || []).includes(id)) return;
  myTrait = id;
  writeSeat(fk, { ...lastRoomData.seats[fk], trait: id, ready: false });
  renderLobby(lastRoomData);
}
function lobbyReady() {
  const fk = mySeatKey(lastRoomData);
  if (!fk) { lobbyStep = 2; renderLobby(lastRoomData); return; }
  if (!myTrait) { lobbyStep = 3; renderLobby(lastRoomData); return; }
  writeSeat(fk, { type: 'human', by: myClientId, name: myName.trim(), trait: myTrait, ready: true });
  lobbyStep = 5;
  renderLobby(lastRoomData);
}

function wizShell(stepTitle, stepNum, bodyHTML, footHTML) {
  const dots = [1, 2, 3, 4].map(n =>
    `<span style="width:9px;height:9px;border-radius:50%;display:inline-block;
       background:${n < stepNum ? 'var(--node-glow)' : (n === stepNum ? 'var(--node-glow)' : '#444')};
       ${n === stepNum ? 'box-shadow:0 0 6px var(--node-glow);' : ''}"></span>`).join('<span style="width:14px;height:2px;background:#333;display:inline-block;vertical-align:middle;margin:0 2px;"></span>');
  return `
    <div class="setup-card wizard-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <span style="font-size:11px;color:#888;letter-spacing:1px;">ROOM <b style="color:var(--node-glow);letter-spacing:3px;">${roomCode}</b></span>
        <span style="display:flex;align-items:center;gap:0;">${dots}</span>
      </div>
      <h3 style="margin-bottom:14px;">${stepTitle}</h3>
      ${bodyHTML}
      <div class="wizard-foot">${footHTML}</div>
    </div>`;
}

function renderLobby(data) {
  if (!data) return;
  const mine = mySeatKey(data);
  // Sync local fields from the authoritative seat (covers reconnect / Firebase echo).
  if (mine) { if (!myName) myName = data.seats[mine].name || ''; if (!myTrait) myTrait = data.seats[mine].trait || ''; }
  // If I've already readied (and the game hasn't started), park on the roster view.
  if (mine && data.seats[mine].ready && lobbyStep < 5) lobbyStep = 5;
  if (lobbyStep >= 5 && (!mine || !data.seats[mine].ready)) lobbyStep = 4;  // un-readied elsewhere

  let html;
  if (lobbyStep === 1) html = renderStepName(data);
  else if (lobbyStep === 2) html = renderStepFaction(data);
  else if (lobbyStep === 3) html = renderStepPassive(data);
  else if (lobbyStep === 4) html = renderStepReview(data);
  else html = renderRoster(data);
  document.getElementById('lobby-body').innerHTML = html;
  if (lobbyStep === 1) setMyName(myName);  // sync NEXT button enabled-state
}

function renderStepName(data) {
  return wizShell('What should we call you?', 1, `
    <input class="input-field" id="wiz-name" maxlength="16" placeholder="Your name…"
      value="${esc(myName)}" oninput="setMyName(this.value)"
      onkeydown="if(event.key==='Enter')lobbyNext()" style="font-size:18px;">
    <p style="font-size:12px;color:#888;margin-top:6px;">Other players in the room will see this name.</p>
  `, `
    <button class="btn btn-secondary" style="font-size:15px;" onclick="leaveLobby()">← LEAVE</button>
    <button class="btn btn-primary" id="wiz-next" style="flex:1;font-size:18px;" onclick="lobbyNext()">NEXT →</button>
  `);
}

function renderStepFaction(data) {
  const seats = data.seats || {};
  const mine = mySeatKey(data);
  const cards = Object.entries(FACTIONS).map(([k, f]) => {
    const s = seats[k] || {};
    const takenByOther = s.by && s.by !== myClientId;
    const isMine = s.by === myClientId;
    const who = takenByOther ? `🔒 ${esc(s.name) || 'Taken'}` : (isMine ? '✓ YOUR PICK' : 'Tap to choose');
    return `<div class="wiz-faction ${isMine ? 'selected' : ''} ${takenByOther ? 'taken' : ''}"
        style="border-color:${isMine ? f.color : '#444'};"
        ${takenByOther ? '' : `onclick="lobbyPickFaction('${k}')"`}>
        <div style="font-family:'Bangers';font-size:20px;letter-spacing:1px;color:${f.color};">${f.icon} ${f.name}</div>
        <div style="font-size:11px;color:#bbb;margin:3px 0;">${f.perk}</div>
        <div style="font-size:11px;color:${isMine ? f.color : (takenByOther ? '#e74c3c' : '#888')};font-weight:700;">${who}</div>
      </div>`;
  }).join('');
  return wizShell('Choose your faction', 2, `<div class="wiz-faction-grid">${cards}</div>`, `
    <button class="btn btn-secondary" style="font-size:15px;" onclick="lobbyBack()">← BACK</button>
    <button class="btn btn-primary" style="flex:1;font-size:18px;${mine ? '' : 'opacity:.4;pointer-events:none;'}" onclick="lobbyNext()">NEXT →</button>
  `);
}

function renderStepPassive(data) {
  const fk = mySeatKey(data);
  const f = fk && FACTIONS[fk];
  const pool = TRAITS.filter(t => !(TRAIT_EXCLUSIONS[fk] || []).includes(t.id));
  const opts = pool.map(t =>
    `<div class="trait-option ${myTrait === t.id ? 'selected' : ''}" onclick="lobbyPickTrait('${t.id}')">
       <strong>${t.name}:</strong> ${t.desc}</div>`).join('');
  return wizShell('Pick your passive', 3, `
    <p style="font-size:12px;color:#888;margin-bottom:10px;">Playing ${f ? `<b style="color:${f.color}">${f.icon} ${f.name}</b>` : 'your faction'} — choose a trait that lasts all game.</p>
    <div class="trait-select">${opts}</div>
  `, `
    <button class="btn btn-secondary" style="font-size:15px;" onclick="lobbyBack()">← BACK</button>
    <button class="btn btn-primary" style="flex:1;font-size:18px;${myTrait ? '' : 'opacity:.4;pointer-events:none;'}" onclick="lobbyNext()">NEXT →</button>
  `);
}

function renderStepReview(data) {
  const fk = mySeatKey(data);
  const f = fk && FACTIONS[fk];
  const t = TRAITS.find(x => x.id === myTrait);
  return wizShell('Ready to deploy?', 4, `
    <div class="wiz-review">
      <div><span>NAME</span><b>${esc(myName) || '—'}</b></div>
      <div><span>FACTION</span><b style="color:${f ? f.color : '#fff'}">${f ? f.icon + ' ' + f.name : '—'}</b></div>
      <div><span>PASSIVE</span><b>${t ? t.name : '—'}</b></div>
    </div>
    <p style="font-size:12px;color:#888;margin-top:10px;">Tap READY to lock in. The host starts once everyone is ready.</p>
  `, `
    <button class="btn btn-secondary" style="font-size:15px;" onclick="lobbyBack()">← BACK</button>
    <button class="btn btn-primary" style="flex:1;font-size:18px;background:#27ae60;border-color:#27ae60;color:#fff;" onclick="lobbyReady()">✓ READY</button>
  `);
}

function renderRoster(data) {
  const seats = data.seats || {};
  const claimed = Object.entries(seats).filter(([, s]) => s.by);
  const rows = Object.entries(FACTIONS).map(([k, f]) => {
    const s = seats[k] || {};
    let status, color = '#888';
    if (s.by === myClientId) { status = s.ready ? '✓ READY (you)' : 'YOU'; color = s.ready ? '#27ae60' : f.color; }
    else if (s.by) { status = s.ready ? `✓ ${esc(s.name)}` : `⌛ ${esc(s.name)}`; color = s.ready ? '#27ae60' : '#ddd'; }
    else { status = '🤖 AI (open)'; }
    return `<div class="faction-row" style="justify-content:space-between;gap:8px;">
        <span style="color:${f.color};font-family:'Bangers';letter-spacing:1px;min-width:90px;">${f.icon} ${f.name}</span>
        <span style="font-size:12px;flex:1;text-align:right;color:${color};font-weight:700;">${status}</span>
      </div>`;
  }).join('');
  const everyoneReady = claimed.length > 0 && claimed.every(([, s]) => s.ready);
  const iAmReady = mySeatKey(data) && seats[mySeatKey(data)].ready;
  const hostFoot = lobbyIsHost
    ? `<button class="btn btn-secondary" style="font-size:14px;" onclick="hostSetTyrant()">${data.tyrant ? '☠ TYRANT: ON' : 'TYRANT: OFF'}</button>
       <button class="btn btn-primary" style="flex:1;font-size:18px;${everyoneReady ? '' : 'opacity:.45;pointer-events:none;'}" onclick="hostStart()">START GAME →</button>`
    : `<div style="flex:1;text-align:center;align-self:center;color:#888;font-family:'Bangers';letter-spacing:1px;">${everyoneReady ? 'WAITING FOR HOST…' : 'WAITING FOR PLAYERS…'}</div>`;
  return `
    <div class="setup-card wizard-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="font-size:11px;color:#888;letter-spacing:1px;">ROOM <b style="color:var(--node-glow);letter-spacing:3px;">${roomCode}</b></span>
        <span style="font-size:11px;color:${iAmReady ? '#27ae60' : '#888'};font-weight:700;">${iAmReady ? '✓ YOU ARE READY' : ''}</span>
      </div>
      <h3 style="margin-bottom:6px;">Lobby</h3>
      <p style="font-size:12px;color:#888;margin-bottom:10px;">Share code <b style="color:var(--node-glow);letter-spacing:2px;">${roomCode}</b>. Open seats become AI at start.${data.tyrant ? ' ☠ The Tyrant is in play.' : ''}</p>
      ${rows}
      <div class="wizard-foot" style="margin-top:14px;">
        <button class="btn btn-secondary" style="font-size:13px;" onclick="lobbyEdit()">EDIT</button>
        ${hostFoot}
      </div>
    </div>`;
}

function leaveLobby() { lobbyStep = 1; showTitle(); }

// Mobile standings drawer (the sidebar as a pull-up bottom sheet).
function toggleInfoDrawer() { document.body.classList.toggle('drawer-open'); }
function closeInfoDrawer() { document.body.classList.remove('drawer-open'); }

function hostStart() {
  if (!lobbyIsHost) return;
  const seats = JSON.parse(JSON.stringify(lastRoomData.seats));
  // Everyone who claimed a seat must be READY before the host can deploy.
  const claimed = Object.values(seats).filter(s => s.by);
  if (!claimed.length) { alert('Claim a faction before starting.'); return; }
  if (!claimed.every(s => s.ready)) { alert('Waiting on all players to ready up.'); return; }
  // Unclaimed human seats fall back to AI.
  Object.keys(seats).forEach(k => { if (seats[k].type === 'human' && !seats[k].by) seats[k] = { type: 'ai', by: null, name: '', trait: '' }; });
  // A claim from before an exclusion check (or a tampered write) falls back to a legal random trait.
  Object.keys(seats).forEach(k => { if ((TRAIT_EXCLUSIONS[k] || []).includes(seats[k].trait)) seats[k].trait = ''; });

  buildOnlineGame(seats, !!lastRoomData.tyrant);
  isDriver = true;
  mySeats = Object.keys(seats).filter(k => seats[k].type === 'human' && seats[k].by === myClientId);
  G.playerFaction = mySeats[0] || G.turnOrder[0];

  ensureGameScreen();
  renderMap(); renderSidebar();

  // Publish the board + state IMMEDIATELY (started:true) so every joiner's board appears at once.
  // G.live stays false until doNextTurn — joiners spectate "Starting…" until round 1's first turn is live.
  G.seq = 1;
  const snap = JSON.parse(JSON.stringify(Object.assign({}, G, { _signalJam: signalJamActive, _totalWar: totalWar, _gameOver: gameOver })));
  roomRef.update({ seats, started: true, state: snap }).then(() => startRound());
}

function buildOnlineGame(seats, tyrant) {
  const order = shuffle(Object.keys(FACTIONS));
  const factions = {};
  order.forEach(k => {
    const s = seats[k];
    factions[k] = (s.type === 'human')
      ? mkFaction(s.name || FACTIONS[k].name, k, false, s.trait || randTrait(k))
      : mkFaction('NEXUS-' + k.slice(0, 3).toUpperCase(), k, true, randTrait(k));
  });
  const turnOrder = order.slice();
  if (tyrant) { factions[TYRANT_KEY] = mkFaction(TYRANT_DEF.name, TYRANT_KEY, true, randTrait(TYRANT_KEY)); turnOrder.push(TYRANT_KEY); }
  G = {
    round: 1, signalJam: false, currentTurnIdx: 0, actionsUsed: 0,
    factions, turnOrder, humans: order.filter(k => seats[k].type === 'human'),
    live: false,
    tyrantOn: !!tyrant, tyrantHarbor: 0, tyrantLastOffer: {}, tyrantStruck: {}, tyrantConquest: false, nodesHeldSince: {},
    tiles: {}, log: [], pacts: {}, grudges: {}, playerFaction: order[0], seq: 0
  };
  gameOver = false;
  G.tiles = buildMap();   // places the Tyrant on the central Node when G.factions[TYRANT_KEY] exists
}

// ============================================================
// WINDOW BINDINGS — expose functions used by HTML onclick/oninput
// (ES modules scope all declarations; inline handlers need globals)
// ============================================================
Object.assign(window, {
  showSetup, showTitle, goOnline, startGame, openRules, closeRules,  setAction, endTurn, dismissEvent, toggleTyrant,
  setSeatType, setSeatName, setSeatTrait,
  hostRoom, joinRoomPrompt, hostSetTyrant, hostStart,
  setMyName, lobbyNext, lobbyBack, lobbyEdit, lobbyPickFaction, lobbyPickTrait, lobbyReady, leaveLobby,
  acceptTyrantPact, refuseTyrantPact, pickRoundBoon,
  tyrantModalConfirm, tyrantModalCancel,
  acknowledgeCombat,
  qtySync, qtyAdj, qtyConfirm, qtyCancel,
  toggleInfoDrawer, closeInfoDrawer,
  startTutorial, tutorialNext, tutorialBack, endTutorial, firstrunStart, firstrunSkip,
});
// Read-only test handle: lets the headless harness inspect live game state.
Object.defineProperty(window, '__G', { get: () => G });

// First-run: offer the tutorial the first time the game is opened (DOM is parsed —
// this module script is at the end of <body>).
maybeFirstRun();
