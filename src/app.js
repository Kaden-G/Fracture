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
      { label:'💰 PAY TRIBUTE (−4 resources)', resolve:(fk)=>{ const f=G.factions[fk]; f.resources=Math.max(0,f.resources-4); } },
      { label:'🩸 REFUSE (−1 troop on every tile)', resolve:(fk)=>{ tilesOf(fk).forEach(t=>{ if(t.troops>1) t.troops--; refreshHex(t.id); }); } },
    ],
    aiChoose:(fk)=> G.factions[fk].resources>=4 ? 0 : 1 },
  { type:'CHOICE', title:'MERCENARY CONTRACT',
    body:'Sellswords are for hire — at a steep price.',
    choices:[
      { label:'🪖 HIRE (−5 res → +4 troops on your strongest tile)', resolve:(fk)=>{ const f=G.factions[fk]; if(f.resources>=5){ f.resources-=5; const t=tilesOf(fk).sort((a,b)=>b.troops-a.troops)[0]; if(t){ t.troops+=4; refreshHex(t.id);} } } },
      { label:'🔋 DECLINE (+3 resources)', resolve:(fk)=>{ const f=G.factions[fk]; f.resources=Math.min(f.resources+3,RES_CAP); } },
    ],
    aiChoose:(fk)=> (G.factions[fk].resources>=5 && aiTroopHunger(fk)) ? 0 : 1 },
];

const NODE_TILES = [
  { id:'node_power',   name:'⚡ POWER',   short:'⚡PWR', isNode:true },
  { id:'node_water',   name:'💧 WATER',   short:'💧H2O', isNode:true },
  { id:'node_transit', name:'🚇 TRANSIT', short:'🚇TRN', isNode:true },
  { id:'node_comms',   name:'📡 COMMS',   short:'📡COM', isNode:true },
  { id:'node_data',    name:'🖧 DATA',    short:'🖧DAT', isNode:true },
];

// Each Core Node grants its controller a passive bonus — so WHICH nodes you hold matters.
const NODE_BONUSES = {
  node_power:   'Reinforce −1 cost',
  node_water:   '+1 income / round',
  node_transit: 'Move 2 troops',
  node_comms:   '+1 attack rolls',
  node_data:    '+1 defense rolls',
};

// Custom artwork for each Core Node (transparent hex badges).
const NODE_IMAGES = {
  node_power:   'assets/node_power.png',
  node_water:   'assets/node_water.png',
  node_transit: 'assets/node_transit.png',
  node_comms:   'assets/node_comms.png',
  node_data:    'assets/node_data.png',
};

// Themed frame artwork for each faction's owned (non-node) tiles.
const FACTION_IMAGES = {
  grid:      'assets/faction_grid.png',
  syndicate: 'assets/faction_syndicate.png',
  commune:   'assets/faction_commune.png',
  ghost:     'assets/faction_ghost.png',
  tyrant:    'assets/faction_tyrant.png',
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
let turnAttacks    = 0;  // attacks made this turn → escalating defender "overextension" bonus
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
function controlsNode(fk, nodeId){ return !!fk && Object.values(G.tiles).some(t=>t.nodeId===nodeId && t.owner===fk); }

// Economy (faction perks + node bonuses fold in here)
function reinforceCost(fk){
  let c = 2;
  if (fk==='grid')                           c -= 1;  // ⚙️ GRID industrial
  if (controlsNode(fk,'node_power'))         c -= 1;  // ⚡ POWER node
  return Math.max(1, c);
}
function reinforceAmount(fk){ return 2; }  // all factions reinforce +2; GRID's perk is the cost discount
function moveTroopCount(fk){ return controlsNode(fk,'node_transit') ? 2 : 1; }          // 🚇 TRANSIT
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
  if (n <= 0) return { label: 'Untouched',             tier: 0 };
  if (n <= 3) return { label: 'Touched by shadow',     tier: 1 };
  if (n <= 6) return { label: 'Deeply corrupt',        tier: 2 };
  return             { label: 'One with the Dark Lord', tier: 3 };
}

function grudgeAtkBonus(atk, def){ return (G.grudges[atk+'>'+def] >= G.round) ? 2 : 0; }
function grudgeDefBonus(atk, def){ return (G.grudges[def+'>'+atk] >= G.round) ? 2 : 0; }
// Coalition: everyone piles on whoever already holds 2+ Nodes (anti-snowball)
function coalitionAtkBonus(defFk, atkFk){ return (defFk!==atkFk && countNodes(defFk)>=2) ? 1 : 0; }

// Does an AI accept a non-aggression pact proposal?
function aiConsiderPact(aiFk, propFk){
  // The Tyrant accepts EVERY pact — every ally brings it closer to winning by diplomacy.
  if (aiFk === TYRANT_KEY) return true;
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

// ---- TYRANT helpers ----
function tyrantOn()      { return !!(G.tyrantOn && G.factions[TYRANT_KEY]); }
function tyrantAlive()   { return tyrantOn() && !G.factions[TYRANT_KEY].eliminated; }
function tyrantAllies()  { return livingKeys().filter(k => k!==TYRANT_KEY && hasPact(TYRANT_KEY, k)); }
// All pacts are secret — visible only to the two parties involved.
function pactVisibleTo(a, b, viewer){ return a===viewer || b===viewer; }

// All elimination flows route through here so the Tyrant can get its harbor reprieve.
function killFaction(fk){
  if (fk === TYRANT_KEY && tyrantAllies().length > 0 && !G.tyrantHarbor) {
    G.tyrantHarbor = G.round + 3;   // cornered, but allies may shelter & re-seed it
    addLog(`🦠 THE TYRANT is cornered — harbored by allies. Feed it a tile within 3 rounds or it dies.`);
    return;
  }
  G.factions[fk].eliminated = true;
  addLog(`💀 ${G.factions[fk].name} ELIMINATED!`);
}

// ============================================================
// NAV
// ============================================================
function showTitle() {
  if (typeof resetNet === 'function') resetNet();
  switchScreen('title-screen');
  document.getElementById('rules-btn').style.display = 'none';
}

function showSetup() {
  if (typeof resetNet === 'function') resetNet();
  switchScreen('setup-screen');
  G = {};
  renderSetup();
}

function switchScreen(id) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active');
    s.style.display = '';
  });
  document.getElementById(id).classList.add('active');
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

function checkReady() {
  const humans = Object.values(G.setup.seats).filter(s => s.type === 'human');
  const ok = humans.length >= 1 && humans.every(s => s.name.trim() && s.trait);
  document.getElementById('start-btn').disabled = !ok;
}

// ============================================================
// GAME INIT
// ============================================================
function startGame() {
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
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fitBoard);   // after layout settles
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && !window.__fitResize) {
    window.__fitResize = true;
    window.addEventListener('resize', () => fitBoard());
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
      return `
        <div class="faction-row" style="
          border: 2px solid ${f.color}${isActive?'':'55'};
          background: ${f.color}${isActive?'28':'10'};
          border-radius: 6px;
          ${isActive?`box-shadow: 0 0 10px ${f.color}44;`:''}
          ${f.eliminated?'opacity:0.35;':''}
        ">
          <div class="faction-dot" style="background:${f.color}"></div>
          <div style="flex:1">
            <div style="font-family:'Bangers'; font-size:13px; letter-spacing:1px; color:${f.color}">
              ${f.icon} ${f.name} ${f.isAI?'(AI)':'(HUMAN)'}${isMe?' 👤':''}${isActive?' ◄ TURN':''}
            </div>
            <div class="faction-row-sub">${tiles} tiles · ${nodes}★ nodes · ${f.resources} res ${f.eliminated?'· DEAD':''}</div>
          </div>
        </div>`;
    }).join('');

  // Nodes
  document.getElementById('node-list').innerHTML = NODE_TILES.map(n => {
    const t = Object.values(G.tiles).find(t=>t.nodeId===n.id);
    if (!t) return '';
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
      const tp = Object.keys(G.pacts||{}).filter(k => { const [a,b]=k.split('|'); return a===TYRANT_KEY||b===TYRANT_KEY; }).length;
      const need = livingKeys().filter(k=>k!==TYRANT_KEY).length;
      const left = need - tp;
      rows.push(`<span style="color:${TYRANT_DEF.color}; font-weight:700">🦠 TYRANT has <b>${tp}</b> pact${tp!==1?'s':''} of <b>${need}</b> needed to win${left>0?` — ${left} more to go`:' — ⚠️ WINNING!'}</span>`);
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
function startRound() {
  G.currentTurnIdx = 0;
  signalJamActive = false;
  totalWar = false;
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
    if (G.round - G.pacts[k] >= 4) { delete G.pacts[k]; addLog('📜 A non-aggression pact has lapsed'); }
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
  // Part 2: corruption tick — each Tyrant ally gains +1 corruption per round
  if (tyrantAlive()) {
    for (const k of livingKeys()) {
      if (k === TYRANT_KEY) continue;
      if (hasPact(TYRANT_KEY, k)) {
        G.factions[k].corruption = (G.factions[k].corruption || 0) + 1;
      }
    }
    // Part 2: Tithe boon — +1 troop on a frontline tile each round
    for (const k of livingKeys()) {
      if (k === TYRANT_KEY) continue;
      if (hasPact(TYRANT_KEY, k) && G.factions[k].boon === 'tithe') {
        const myT = tilesOf(k);
        const frontline = myT.filter(mt =>
          Object.values(G.tiles).some(t => t.owner && t.owner !== k && adjacent(mt, t))
        );
        const target = frontline.length > 0
          ? frontline.reduce((a, b) => a.troops <= b.troops ? a : b)
          : myT.reduce((a, b) => a.troops <= b.troops ? a : b, myT[0]);
        if (target) { target.troops += 1; refreshHex(target.id); }
      }
    }
  }
  document.getElementById('phase-label').textContent = `ROUND ${G.round}`;

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
    setTimeout(() => runAITurn(fk), online ? 700 : 900);
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
  turnAttacks = 0; assaultCaptures = 0; assaultOn = false;
  G.renouncedThisTurn = {};  // Part 1: clear per-faction renounce guard
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
    // Pending pact proposal from another human player?
    if (G.pactProposal && G.pactProposal.to === fk) {
      const from = G.pactProposal.from;
      const fromF = G.factions[from];
      if (fromF && !fromF.eliminated && !hasPact(from, fk)) {
        const accepted = confirm(`🤝 ${fromF.name} proposes a non-aggression pact!\n\nWhile it holds, neither of you attacks the other.\nOK = accept   ·   Cancel = refuse`);
        if (accepted) { formPact(from, fk); addLog('🤝 A non-aggression pact was formed.'); }
        else          { addLog('✋ A pact proposal was refused.'); }
      }
      G.pactProposal = null;
      syncPush(); renderSidebar();
    }
  };

  // Hot-seat with several humans on one device: gate behind a pass-the-device screen.
  if (!online && G.humans.length > 1) { disablePlayerActions(); renderSidebar(); showHandoff(fk, begin); }
  else begin();
}

// The Tyrant's private dealings with the active human: a harbor plea or a secret pact offer.
function tyrantInteract(fk) {
  if (fk === TYRANT_KEY) return;
  // 1. Harbor: a cornered Tyrant begs an ally to feed it a tile so it can rise again.
  if (G.tyrantHarbor && hasPact(TYRANT_KEY, fk) && tilesOf(TYRANT_KEY).length === 0) {
    const give = confirm(`🦠 THE TYRANT is cornered and begs you (its secret ally) to HARBOR it.\n\nGive it one of your tiles to revive it?\nOK = harbor it   ·   Cancel = let it perish`);
    if (give) {
      const t = tilesOf(fk).sort((a,b)=>a.troops-b.troops)[0];
      if (t) { t.owner = TYRANT_KEY; t.troops = Math.max(1, t.troops); t.heldRounds = 0; G.tyrantHarbor = 0;
        addLog(`🦠 ${G.factions[fk].name} HARBORED the Tyrant — it rises again!`); refreshHex(t.id); renderSidebar(); syncPush(); }
    }
    return;
  }
  // 2. Otherwise the Tyrant may offer a secret non-aggression pact (re-offers every couple rounds).
  if (tyrantAlive() && !hasPact(TYRANT_KEY, fk)) {
    if (!G.tyrantLastOffer) G.tyrantLastOffer = {};   // Firebase strips empty objects; rebuild defensively
    const last = G.tyrantLastOffer[fk] || -99;
    if (G.round - last >= 2) {
      G.tyrantLastOffer[fk] = G.round;
      const ok = confirm(`🦠 THE TYRANT offers ${G.factions[fk].name} a SECRET non-aggression pact.\n\nWhile it holds, neither of you attacks the other — and no rival will know.\nBut beware: your corruption will grow each round you stay allied.\nOK = accept   ·   Cancel = refuse`);
      if (ok) {
        formPact(TYRANT_KEY, fk);
        // Part 2: choose a boon (locked for duration)
        const boonChoice = confirm(`🦠 Choose your boon:\n\nOK = TITHE: +1 troop on a frontline tile each round\nCancel = SIC THE BLOB: the Tyrant attacks one adjacent enemy each round`);
        G.factions[fk].boon = boonChoice ? 'tithe' : 'sic';
        addLog('🦠 A secret pact takes hold in the shadows…');
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
        showWin(k, 'NODE DOMINANCE', `${f.name} held 3+ Core Nodes for 2 rounds and commands Nexus.`);
        return;
      }
    }
  }
  G.round++;
  if (G.round > ROUND_CAP) {
    // Tiebreak: most nodes
    let best=null, bestN=-1;
    for (const [k,f] of Object.entries(G.factions)) {
      if (f.eliminated) continue;
      const n = Object.values(G.tiles).filter(t=>t.owner===k&&t.isNode).length;
      if (n>bestN) { bestN=n; best=k; }
    }
    showWin(best,'TIMED OUT',`After ${ROUND_CAP} rounds, ${G.factions[best].name} held the most Nodes.`);
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
    airlift:   'AIRLIFT (3 res): Click YOUR tile (3+ troops), then ANY other tile you own — move 2 troops.',
    entrench:  'ENTRENCH (2 res): Click YOUR tile (2+ troops) to dig in +1 (max +3, or +2 on Nodes).',
    sabotage:  'SABOTAGE (1 res): Click any ENEMY tile to remove 2 troops.',
    bribe:     'BRIBE (1 res): Click an enemy tile ADJACENT to your territory.',
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
    // Human opponent, hot-seat: ask them directly
    else if (!online) {
      const accepted = confirm(`🤝 ${G.factions[G.playerFaction].name} proposes a non-aggression pact with ${G.factions[other].name}.\n\nDoes ${G.factions[other].name} accept?\nOK = accept   ·   Cancel = refuse`);
      if (accepted) {
        formPact(G.playerFaction, other);
        addLog('🤝 A non-aggression pact was formed.');
        setActionLog(`${G.factions[other].name} ACCEPTED your pact!`);
      } else {
        addLog('✋ A pact proposal was refused.');
        setActionLog(`${G.factions[other].name} REFUSED your pact.`);
      }
    }
    // Human opponent, online: queue proposal for their turn
    else {
      if (G.pactProposal) { setActionLog('A pact proposal is already pending — wait for their response.'); renderSidebar(); return; }
      G.pactProposal = { from: G.playerFaction, to: other };
      addLog('🤝 A pact has been proposed.');
      setActionLog(`Pact proposed to ${G.factions[other].name}! They'll see it on their turn.`);
      syncPush();
    }
    renderSidebar(); return;
  }

  // ---- RENOUNCE (Part 1: peaceful pact exit, free, no grudge) ----
  if (currentAction === 'renounce') {
    currentAction = null;
    document.querySelectorAll('.action-btn').forEach(b=>b.classList.remove('active-action'));
    if (!tile.owner || tile.owner===G.playerFaction) { setActionLog('Click a tile owned by a faction you have a pact with.'); return; }
    const other = tile.owner;
    if (!hasPact(G.playerFaction, other)) { setActionLog(`You don't have a pact with ${G.factions[other].name}.`); return; }
    delete G.pacts[pairKey(G.playerFaction, other)];
    if (!G.renouncedThisTurn) G.renouncedThisTurn = {};
    G.renouncedThisTurn[other] = true;
    // Part 2: clear boon if renouncing a Tyrant pact
    if (other === TYRANT_KEY) G.factions[G.playerFaction].boon = null;
    if (G.playerFaction === TYRANT_KEY && G.factions[other]) G.factions[other].boon = null;
    addLog('📜 A non-aggression pact was withdrawn.');
    setActionLog(`You withdrew from the pact with ${G.factions[other].name}. No grudge.`);
    renderSidebar(); return;
  }

  if (G.actionsUsed >= 3) { setActionLog('No actions left — hit END TURN.'); return; }

  // ---- REINFORCE ----
  if (currentAction === 'reinforce') {
    if (tile.owner !== G.playerFaction) { setActionLog('Can only reinforce YOUR tiles.'); return; }
    const cost = reinforceCost(G.playerFaction);
    const amt  = reinforceAmount(G.playerFaction);
    if (f.resources < cost) { setActionLog(`Need ${cost} resources.`); return; }
    f.resources -= cost; tile.troops += amt; G.actionsUsed++;
    addLog(`You reinforced ${tile.name} (+${amt} troops)`);
    setActionLog(`Reinforced! ${3-G.actionsUsed} action(s) left. Res: ${f.resources}`);
    refreshHex(id); renderSidebar(); return;
  }

  // ---- AIRLIFT (universal, 3 res): redeploy 2 troops between any two of YOUR tiles ----
  if (currentAction === 'airlift') {
    const cost = 3;
    if (!selectedTile || selectedTile===id) {
      if (tile.owner===G.playerFaction && tile.troops>=3) {
        if (f.resources < cost) { setActionLog(`Airlift costs ${cost} resources.`); return; }
        selectedTile = id;
        renderMap();
        document.getElementById('hex-'+id)?.classList.add('selected');
        setActionLog(`Airlift FROM ${tile.name}. Click ANY other tile you own.`);
      } else { setActionLog('Airlift needs YOUR tile with 3+ troops.'); }
      return;
    }
    const src = G.tiles[selectedTile];
    if (tile.owner !== G.playerFaction) { setActionLog('Airlift only to YOUR tiles.'); return; }
    if (tile.id === src.id)             { setActionLog('Pick a different destination.'); return; }
    if (f.resources < cost)             { setActionLog(`Airlift costs ${cost} resources.`); return; }
    f.resources -= cost;
    src.troops -= 2; tile.troops += 2;
    G.actionsUsed++;
    currentAction = null;
    document.querySelectorAll('.action-btn').forEach(b=>b.classList.remove('active-action'));
    addLog(`✈️ You airlifted 2 troops: ${src.name} → ${tile.name}`);
    setActionLog(`Airlifted! ${3-G.actionsUsed} action(s) left. Res: ${f.resources}`);
    refreshHex(selectedTile); refreshHex(id);
    selectedTile=null; renderSidebar(); return;
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
    addLog(`🏰 You entrenched ${tile.name} (dug in +${tile.heldRounds})`);
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
    const moveN = Math.min(moveTroopCount(G.playerFaction), src.troops - 1);  // 🚇 TRANSIT moves 2
    src.troops -= moveN;
    if (src.troops <= 0) { src.owner = null; src.troops = 0; }
    tile.owner = G.playerFaction; tile.troops += moveN;
    G.actionsUsed++;
    currentAction = null;
    document.querySelectorAll('.action-btn').forEach(b=>b.classList.remove('active-action'));
    addLog(`You moved ${moveN} troop${moveN>1?'s':''}: ${src.name} → ${tile.name}`);
    setActionLog(`Moved! ${3-G.actionsUsed} action(s) left.`);
    refreshHex(selectedTile); refreshHex(id);
    selectedTile=null; renderSidebar(); return;
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
    if (hasPact(G.playerFaction, tile.owner)) {
      if (!confirm(`You have a pact with ${G.factions[tile.owner].name}. Break it and attack? They'll hold a grudge (+2 vs you for 2 rounds).`)) {
        setActionLog('Attack cancelled — pact held.'); return;
      }
      breakPactBetrayal(G.playerFaction, tile.owner);
    }
    if (!assaultOn) { G.actionsUsed++; assaultOn = true; assaultCaptures = 0; }   // launching the assault costs ONE action
    const captured = G.tiles[id].troops <= 1;  // will this be a capture if we win?
    const won = resolveAttack(G.playerFaction, selectedTile, id, true);
    if (won && captured) assaultCaptures++;
    renderSidebar();
    if (checkWin()) return;
    // Press the assault: a win lets you keep striking for free, but each strike rallies defenders +2.
    // Hard cap: 3 captures per assault chain.
    if (won && G.tiles[selectedTile] && G.tiles[selectedTile].troops >= 2 && assaultCaptures < 3) {
      setActionLog(`⚔️ Assault presses on! (${assaultCaptures}/3 captures) Next strike, defenders rally +${turnAttacks*2}. Click another adjacent enemy — or pick another action to halt.`);
      renderMap();
      document.getElementById('hex-'+selectedTile)?.classList.add('selected');
      return;
    }
    // Repelled, source spent, capture cap hit, or nothing left — the assault is over.
    assaultOn = false; assaultCaptures = 0; selectedTile=null; currentAction=null;
    document.querySelectorAll('.action-btn').forEach(b=>b.classList.remove('active-action'));
    renderMap(); renderSidebar(); return;
  }

  // ---- SABOTAGE ----
  if (currentAction === 'sabotage') {
    if (!tile.owner || tile.owner===G.playerFaction) { setActionLog('Pick an ENEMY tile.'); return; }
    if ((G.renouncedThisTurn||{})[tile.owner]) { setActionLog("Can't strike a faction you renounced this turn — wait until next turn."); return; }
    if (f.resources < 1) { setActionLog('Sabotage costs 1 resource.'); return; }
    if (hasPact(G.playerFaction, tile.owner)) {
      if (!confirm(`Sabotaging ${G.factions[tile.owner].name} breaks your pact. Proceed?`)) { setActionLog('Sabotage cancelled — pact held.'); return; }
      breakPactBetrayal(G.playerFaction, tile.owner);
    }
    f.resources -= 1;
    const sabPrev = tile.owner;
    const sabDrop = 2;  // Phase 5b: sabotage removes 2 troops
    if (tile.troops > sabDrop) tile.troops -= sabDrop; else { tile.owner=null; tile.troops=0; }
    if (tile.owner===null && Object.values(G.tiles).filter(t=>t.owner===sabPrev).length===0) {
      killFaction(sabPrev);
    }
    G.actionsUsed++;
    const sabLeft = tile.troops>0 ? `${tile.name} now ${tile.troops} troop${tile.troops>1?'s':''}` : `${tile.name} wiped out`;
    addLog(`👁️ You sabotaged ${tile.name} — ${sabLeft}!`);
    setActionLog(`Sabotage hit! ${sabLeft}. ${3-G.actionsUsed} action(s) left. Res: ${f.resources}`);
    refreshHex(id); flashHex(id); renderSidebar(); checkWin();
    syncPush();   // broadcast so online opponents see the troop drop immediately
    return;
  }

  // ---- BRIBE ----
  if (currentAction === 'bribe') {
    if (!tile.owner || tile.owner===G.playerFaction) { setActionLog('Pick an ENEMY tile adjacent to your territory.'); return; }
    if (f.resources < 1) { setActionLog('Bribe costs 1 resource.'); return; }
    const myT = Object.values(G.tiles).filter(t=>t.owner===G.playerFaction);
    if (!myT.some(mt=>adjacent(mt,tile))) { setActionLog('Must be adjacent to YOUR territory.'); return; }
    if ((G.renouncedThisTurn||{})[tile.owner]) { setActionLog("Can't strike a faction you renounced this turn — wait until next turn."); return; }
    if (hasPact(G.playerFaction, tile.owner)) {
      if (!confirm(`Bribing ${G.factions[tile.owner].name} breaks your pact. Proceed?`)) { setActionLog('Bribe cancelled — pact held.'); return; }
      breakPactBetrayal(G.playerFaction, tile.owner);
    }
    f.resources -= 1;
    const bribedPrev = tile.owner;
    tile.troops--;
    if (tile.troops<=0) {
      tile.owner=G.playerFaction; tile.troops=1;
      if (Object.values(G.tiles).filter(t=>t.owner===bribedPrev).length===0) killFaction(bribedPrev);
    }
    G.actionsUsed++;
    addLog(`💰 You bribed ${tile.name}!`);
    setActionLog(`Bribed! ${3-G.actionsUsed} action(s) left. Res: ${f.resources}`);
    refreshHex(id); renderSidebar(); checkWin(); return;
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
  // 2. Overextension: each prior attack this turn rallies the defender +2.
  //    Harder brake on press-the-assault chains.
  const overextend = turnAttacks * 2;
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

  // Raw modifier totals (before clamping)
  let attMods = attForce + comms + coalition + grudgeA + war;
  let defMods = defForce + entrench + lastStand + data + grudgeD + overextend;
  // Clamp net modifier swing to ±4 — no combination of perks fully removes chance
  const modSwing = attMods - defMods;
  if (modSwing > 4)       { attMods -= (modSwing - 4); }
  else if (modSwing < -4) { defMods -= (-4 - modSwing); }

  const attTotal = attDice + attMods;
  const defTotal = defDice + defMods;

  // Attacker wins ties; fortify adds a margin requirement
  const attWins = attTotal >= defTotal + fortify;

  turnAttacks++;  // this attack now counts toward overextension on the NEXT strike

  // Flash the result whenever the human is involved — attacking OR defending
  const captured = attWins && tgt.troops <= 1;   // the defender's last troop falls → tile flips
  if (isPlayer || tgt.owner===G.playerFaction) {
    showCombatResult(
      { dice: attRoll.dice, force: attForce, comms, coalition, grudge: grudgeA, war, total: attTotal },
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

function showCombatResult(att, def, win, playerIsAttacker, af, df, captured) {
  const faces = ['⚀','⚁','⚂','⚃','⚄','⚅'];
  const diceStr = (arr) => arr.map(d => faces[d-1]).join('');
  const attMods = modParts([{v:att.force,label:'force'},{v:att.comms,label:'uplink'},{v:att.coalition,label:'coalition'},{v:att.grudge,label:'grudge'},{v:att.war,label:'war'}]);
  const defMods = modParts([{v:def.force,label:'force'},{v:def.entrench,label:'dug in'},{v:def.lastStand,label:'last stand'},{v:def.fortify,label:'fortify'},{v:def.data,label:'firewall'},{v:def.grudge,label:'grudge'},{v:def.overextend,label:'rally'}]);
  const attLabel = playerIsAttacker ? 'YOU' : (af ? af.icon : 'ATK');
  const defLabel = playerIsAttacker ? (df ? df.icon : 'DEF') : 'YOU';
  // Color + headline from the LOCAL player's point of view (green = good for you).
  const goodForLocal = playerIsAttacker ? win : !win;
  let headline;
  if (captured)   headline = playerIsAttacker ? '⚡ TILE CAPTURED!' : '💥 TILE LOST!';
  else if (win)   headline = '💢 HIT! −1 TROOP';           // round won, but the tile holds
  else            headline = playerIsAttacker ? '🛡️ REPELLED' : '🛡️ YOU HOLD!';
  // Never stack flashes — the latest combat replaces any prior one.
  document.querySelectorAll('.combat-flash').forEach(e => e.remove());
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
  `;
  document.body.appendChild(el);
  setTimeout(()=>el.remove(), 1550);
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
      src.troops--; node.owner = fk; node.troops = (node.troops || 0) + 1; node.heldRounds = 0;
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
    mv.src.troops--;
    if (!mv.to.owner) { mv.to.owner = fk; mv.to.troops = 1; mv.to.heldRounds = 0; }
    else mv.to.troops++;
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
  let spread = 0;
  for (const s of seeds) {
    if (spread >= 4) break;                       // cap per turn so it grows fast, not instantly
    const empty = tiles.find(t => !t.owner && adjacent(s, t));
    if (empty) { s.troops--; empty.owner = fk; empty.troops = 1; empty.heldRounds = 0; refreshHex(s.id); refreshHex(empty.id); spread++; }
  }
  if (spread) addLog(`🦠 THE TYRANT spreads into ${spread} new tile${spread>1?'s':''}`);
}

function runAITurn(fk) {
  if (gameOver) return;
  turnAttacks = 0;
  G.renouncedThisTurn = {};  // Part 1: clear per-faction renounce guard
  const f = G.factions[fk];
  if (f.eliminated) { G.currentTurnIdx++; setTimeout(doNextTurn,200); return; }

  if (fk === TYRANT_KEY) {
    tyrantSpread(fk);   // virus expansion before its normal actions
    // Court every un-allied rival (AIs decide now; humans are offered on their own turn).
    let newAlly = false;
    livingKeys().filter(k => k!==TYRANT_KEY && G.factions[k].isAI && !hasPact(TYRANT_KEY,k))
      .forEach(k => {
        if (aiConsiderPact(k, TYRANT_KEY)) {
          formPact(TYRANT_KEY, k);
          // Part 2: AI picks boon — behind on economy? Tithe. Has adjacent rival? Sic.
          G.factions[k].boon = aiPickBoon(k);
          newAlly = true;
        }
      });
    if (newAlly) addLog('🦠 The Tyrant whispers — a hidden pact takes hold…');

    // Part 2: Sic boon — Tyrant attacks one adjacent enemy per sic-allied faction
    for (const ally of livingKeys()) {
      if (ally === TYRANT_KEY || !hasPact(TYRANT_KEY, ally)) continue;
      if (G.factions[ally].boon !== 'sic') continue;
      // Find a Tyrant tile adjacent to an enemy of the ally (not the ally, not the Tyrant)
      const tyrantTiles = Object.values(G.tiles).filter(t => t.owner === TYRANT_KEY && t.troops >= 2);
      let sicTarget = null, sicSrc = null;
      for (const tt of tyrantTiles) {
        const adj = Object.values(G.tiles).find(t =>
          t.owner && t.owner !== TYRANT_KEY && t.owner !== ally && !hasPact(TYRANT_KEY, t.owner) && adjacent(tt, t)
        );
        if (adj) { sicTarget = adj; sicSrc = tt; break; }
      }
      if (sicTarget && sicSrc) {
        resolveAttack(TYRANT_KEY, sicSrc.id, sicTarget.id, false);
        addLog(`🦠 The Tyrant lashes out at ${sicTarget.name} (sic the blob)`);
        renderMap(); renderSidebar();
      }
    }
  }

  const myTiles    = () => Object.values(G.tiles).filter(t=>t.owner===fk);
  const enemyTiles = () => Object.values(G.tiles).filter(t=>t.owner && t.owner!==fk);
  const findBestAttack = () => {
    let best=null;
    for (const atk of myTiles().filter(t=>t.troops>=2)) {
      for (const def of enemyTiles()) {
        if (!adjacent(atk,def)) continue;
        // Honor pacts — unless we can seize a NODE with a commanding edge (betrayal)
        const pact = hasPact(fk, def.owner);
        const canBetray = def.isNode && atk.troops >= def.troops + 2;
        if (pact && !canBetray) continue;
        // Prefer: nodes, then weaker targets, then where we have a troop edge
        const atkPower = Math.min(2, Math.floor(atk.troops/4));
        const defPower = Math.min(2, Math.floor(def.troops/4)) + Math.min(def.heldRounds||0, def.isNode?2:3) + turnAttacks*2;  // overextension
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
    setTimeout(step, combat ? 1700 : 450);
  };
  setTimeout(step, 250);
}

function finishAITurn(fk) {
  if (gameOver) return;
  renderSidebar();
  syncPush();                 // broadcast the AI's completed turn (no-op offline)
  if (checkWin()) return;
  G.currentTurnIdx++;
  setTimeout(doNextTurn, online ? 400 : 500);
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
    return resolveAttack(fk, best.atk.id, best.def.id, false) ? 'won' : 'repelled';
  }

  // 1b. AIRLIFT to concentrate force before a node assault.
  if (f.resources >= 3 && myTiles().length >= 2) {
    const nodeTarget = enemyTiles().find(t => t.isNode && myTiles().some(m => adjacent(m,t) && m.troops < t.troops));
    if (nodeTarget) {
      const adjTile = myTiles().find(m => adjacent(m, nodeTarget) && m.troops < nodeTarget.troops);
      const donor = myTiles().filter(t => t.id !== adjTile.id && t.troops >= 3).sort((a,b)=>b.troops-a.troops)[0];
      if (adjTile && donor) {
        f.resources -= 3; donor.troops -= 2; adjTile.troops += 2;
        addLog(`✈️ ${f.icon} ${f.name} airlifted to ${adjTile.name}`);
        refreshHex(donor.id); refreshHex(adjTile.id);
        return true;
      }
    }
  }

  // 2. Grab an unclaimed Node we can reach, or march a troop toward the nearest Node.
  if (aiNodePush(fk)) return true;

  // 2b. RETREAT: pull a thin stack (1-2 troops) away from a larger adjacent enemy instead of feeding it.
  const threatened = myTiles().filter(t => t.troops <= 2 && !t.isNode &&
    enemyTiles().some(e => adjacent(t,e) && e.troops >= t.troops + 2));
  if (threatened.length) {
    const victim = threatened[0];
    const safe = myTiles().find(t => t.id !== victim.id && adjacent(t, victim));
    if (safe) {
      safe.troops += victim.troops;
      victim.troops = 0; victim.owner = null; victim.heldRounds = 0;
      addLog(`🏃 ${f.icon} ${f.name} retreated from ${victim.name}`);
      refreshHex(victim.id); refreshHex(safe.id);
      return true;
    }
  }

  // 3. Take any other favorable attack.
  if (attackable && best.atk.troops > best.def.troops) {
    if (best.betray) breakPactBetrayal(fk, best.def.owner);
    return resolveAttack(fk, best.atk.id, best.def.id, false) ? 'won' : 'repelled';
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
      const aiSabDrop = 2;  // Phase 5b: sabotage removes 2 troops
      if (target.troops > aiSabDrop) target.troops -= aiSabDrop; else { target.troops=0; target.owner=null; }
      if (target.owner===null && Object.values(G.tiles).filter(t=>t.owner===prev).length===0) killFaction(prev);
      addLog(`👁️ ${f.name} sabotaged ${target.name}`);
      refreshHex(target.id); flashHex(target.id);
      return true;
    }
  }
  // BRIBE: steal from an adjacent enemy
  if (f.ability==='bribe' && f.resources>=1) {
    for (const mt of myTiles()) {
      const tgt = enemyTiles().find(e=>adjacent(mt,e) && !hasPact(fk,e.owner));
      if (tgt) {
        const prev = tgt.owner;
        f.resources-=1; tgt.troops--;
        if (tgt.troops<=0) {
          tgt.owner=fk; tgt.troops=1;
          if (Object.values(G.tiles).filter(t=>t.owner===prev).length===0) killFaction(prev);
        }
        addLog(`💰 ${f.name} bribed ${tgt.name}`);
        refreshHex(tgt.id);
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
function weakestKey() {
  return livingKeys().sort((a,b)=> tilesOf(a).length - tilesOf(b).length)[0];
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

// Choice event: each living faction decides for itself — you via buttons, AI via aiChoose
function showChoiceEvent(ev, cb) {
  document.getElementById('event-type').textContent  = 'CHOICE EVENT';
  document.getElementById('event-title').textContent = ev.title;
  document.getElementById('event-body').textContent  = ev.body;
  document.getElementById('event-ok').style.display = 'none';
  const box = document.getElementById('event-choices');
  box.style.display = 'flex';
  box.innerHTML = '';
  ev.choices.forEach((ch, idx) => {
    const b = document.createElement('button');
    b.className = 'btn btn-secondary';
    b.style.cssText = 'font-size:14px; padding:10px 14px; text-align:left;';
    b.textContent = ch.label;
    b.onclick = () => {
      ch.resolve(G.playerFaction);
      addLog(`🃏 ${ev.title}: YOU chose "${ch.label}"`);
      Object.keys(G.factions)
        .filter(k => k!==G.playerFaction && !G.factions[k].eliminated)
        .forEach(k => { ev.choices[ ev.aiChoose ? ev.aiChoose(k) : 0 ].resolve(k); });
      document.getElementById('event-overlay').classList.remove('show');
      cb();
    };
    box.appendChild(b);
  });
  document.getElementById('event-overlay').classList.add('show');
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
    b.textContent = ch.label;
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
  if (tyrantAlive()) {
    const others = livingKeys().filter(k => k !== TYRANT_KEY);
    if (others.length > 0 && others.every(k => hasPact(TYRANT_KEY, k))) {
      showWin(TYRANT_KEY, 'NO ENEMIES LEFT', 'The Tyrant bought peace with every rival — and rules Nexus by default.');
      return true;
    }
  }
  const alive = Object.entries(G.factions).filter(([,f])=>!f.eliminated);
  if (alive.length===1) {
    showWin(alive[0][0],'LAST STANDING',`${alive[0][1].name} eliminated all rivals.`);
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
  document.getElementById('win-title').textContent   = humanWon ? '⚡ VICTORY!' : '💀 AI WINS';
  document.getElementById('win-title').style.color   = humanWon ? 'var(--node-glow)' : 'var(--syndicate)';
  document.getElementById('win-subtitle').textContent = `${f.icon} ${f.name} — ${w.condition}`;
  document.getElementById('win-detail').textContent   = w.detail + ` (Round ${w.round})`;
  switchScreen('win-screen');
  document.getElementById('rules-btn').style.display = 'none';
}

function openRules()  { document.getElementById('rules-overlay').classList.add('show'); }
function closeRules() { document.getElementById('rules-overlay').classList.remove('show'); }

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
  roomCode = genCode();
  roomRef = db.ref('rooms/' + roomCode);
  stateRef = roomRef.child('state');
  // All seats OPEN by default so anyone can claim one; unclaimed seats become AI at START.
  const seats = {};
  Object.keys(FACTIONS).forEach(k => seats[k] = { type: 'human', by: null, name: '', trait: '' });
  roomRef.set({ host: myClientId, started: false, seats, tyrant: false })
    .then(() => roomRef.on('value', onRoom))
    .catch(e => alert('Could not create room: ' + e.message));
}

function joinRoomPrompt() {
  const code = (document.getElementById('join-code').value || '').trim().toUpperCase();
  if (code.length < 4) { alert('Enter the 4-letter room code.'); return; }
  roomCode = code; lobbyIsHost = false;
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

function setMyName(v) { myName = v; }
function setMyTrait(v) { myTrait = v; renderLobby(lastRoomData); }

function claimSeat(fk) {
  if (!myName.trim() || !myTrait) { alert('Enter your name and pick a trait first.'); return; }
  const seats = lastRoomData.seats || {};
  const updates = {};
  Object.keys(seats).forEach(k => { if (seats[k].by === myClientId) updates['seats/' + k] = { type: 'human', by: null, name: '', trait: '' }; });
  updates['seats/' + fk] = { type: 'human', by: myClientId, name: myName.trim(), trait: myTrait };
  roomRef.update(updates);
}

function hostSetSeat(fk, kind) {  // 'ai' or 'open'
  if (!lobbyIsHost) return;
  roomRef.child('seats/' + fk).set(kind === 'ai'
    ? { type: 'ai', by: null, name: '', trait: '' }
    : { type: 'human', by: null, name: '', trait: '' });
}

function hostSetTyrant() {
  if (!lobbyIsHost) return;
  roomRef.update({ tyrant: !(lastRoomData && lastRoomData.tyrant) });
}

function renderLobby(data) {
  const seats = data.seats || {};
  const rows = Object.entries(FACTIONS).map(([k, f]) => {
    const s = seats[k] || { type: 'ai' };
    let status;
    if (s.type === 'ai') status = '🤖 AI';
    else if (s.by) status = (s.by === myClientId ? '⭐ YOU — ' : '🎮 ') + (s.name || 'Player');
    else status = '🟢 OPEN';
    let actions = '';
    if (lobbyIsHost) {
      actions = `<button class="seat-mini" onclick="hostSetSeat('${k}','ai')">AI</button>
                 <button class="seat-mini" onclick="hostSetSeat('${k}','open')">OPEN</button>
                 <button class="seat-mini" onclick="claimSeat('${k}')">PLAY</button>`;
    } else if (s.type === 'human' && !s.by) {
      actions = `<button class="seat-mini" onclick="claimSeat('${k}')">CLAIM</button>`;
    } else if (s.by === myClientId) {
      actions = `<button class="seat-mini" onclick="claimSeat('${k}')">↻</button>`;
    }
    return `<div class="faction-row" style="justify-content:space-between; gap:8px;">
        <span style="color:${f.color};font-family:'Bangers';letter-spacing:1px;min-width:96px;">${f.icon} ${f.name}</span>
        <span style="font-size:12px;flex:1;text-align:center;color:#ccc;">${status}</span>
        <span style="display:flex;gap:4px;">${actions}</span>
      </div>`;
  }).join('');

  const iHaveSeat = Object.values(seats).some(s => s.by === myClientId);
  const canStart = lobbyIsHost && iHaveSeat;
  document.getElementById('lobby-body').innerHTML = `
    <div class="setup-card" style="max-width:500px; margin:0 auto;">
      <h3>ROOM CODE: <span style="color:var(--node-glow);letter-spacing:4px;">${roomCode}</span></h3>
      <p style="font-size:12px;color:#999;margin-bottom:10px;line-height:1.5;">
        ${lobbyIsHost ? 'Share the code. Set each seat to AI or OPEN, claim one with PLAY, then START.' : 'Claim an OPEN seat, then wait for the host to start.'}
      </p>
      <label>YOUR NAME</label>
      <input class="input-field" maxlength="16" placeholder="Your name..." value="${(myName || '').replace(/"/g, '&quot;')}" oninput="setMyName(this.value)">
      <label>PASSIVE TRAIT</label>
      <div class="trait-select" style="margin-bottom:12px;">
        ${TRAITS.map(t => `<div class="trait-option ${myTrait === t.id ? 'selected' : ''}" onclick="setMyTrait('${t.id}')"><strong>${t.name}:</strong> ${t.desc}</div>`).join('')}
      </div>
      ${rows}
      <div class="faction-row" style="justify-content:space-between; gap:8px; margin-top:8px; border-color:${TYRANT_DEF.color};">
        <span style="color:${TYRANT_DEF.color};font-family:'Bangers';letter-spacing:1px;min-width:96px;">${TYRANT_DEF.icon} THE TYRANT</span>
        <span style="font-size:12px;flex:1;text-align:center;color:#ccc;">${data.tyrant ? '☠ IN PLAY' : '— off —'}</span>
        <span style="display:flex;gap:4px;">${lobbyIsHost ? `<button class="seat-mini" onclick="hostSetTyrant()">${data.tyrant ? 'REMOVE' : 'ADD'}</button>` : ''}</span>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px;">
        <button class="btn btn-secondary" style="font-size:16px;" onclick="showTitle()">← LEAVE</button>
        ${lobbyIsHost
          ? `<button class="btn btn-primary" style="font-size:20px;flex:1;${canStart ? '' : 'opacity:.4;pointer-events:none;'}" onclick="hostStart()">START GAME →</button>`
          : `<div style="flex:1;text-align:center;align-self:center;color:#888;font-family:'Bangers';letter-spacing:1px;">${iHaveSeat ? 'WAITING FOR HOST…' : 'CLAIM A SEAT'}</div>`}
      </div>
    </div>`;
}

function hostStart() {
  if (!lobbyIsHost) return;
  const seats = JSON.parse(JSON.stringify(lastRoomData.seats));
  // Unclaimed human seats fall back to AI.
  Object.keys(seats).forEach(k => { if (seats[k].type === 'human' && !seats[k].by) seats[k] = { type: 'ai', by: null, name: '', trait: '' }; });
  if (!Object.values(seats).some(s => s.type === 'human')) { alert('Claim at least one seat before starting.'); return; }

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
    tyrantOn: !!tyrant, tyrantHarbor: 0, tyrantLastOffer: {}, nodesHeldSince: {},
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
  showSetup, showTitle, goOnline, startGame, openRules, closeRules,
  setAction, endTurn, dismissEvent, toggleTyrant,
  setSeatType, setSeatName, setSeatTrait,
  hostRoom, joinRoomPrompt, claimSeat, hostSetSeat, hostSetTyrant, hostStart,
  setMyName, setMyTrait,
});
