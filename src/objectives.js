// ============================================================
// objectives.js — win-condition / agenda registry.
// PURE: no DOM, no imports, no side effects. Each predicate reads game state ONLY through an
// `api` accessor object passed in by the caller, so the same registry works over app.js's global
// G, the sim's state, or a test mock. The caller builds the api; predicates never touch state
// directly.
//
// This is the home for win conditions. Two kinds:
//   kind:'universal' — always-live wins (node dominance, last standing). Today's wins, expressed
//                      as predicates so they're documented + testable. ORCHESTRATION (the 3-round
//                      hold timer, the Reckoning intercept, the round-cap tiebreak) stays in the
//                      caller — these predicates only answer "is the raw condition met right now?".
//   kind:'agenda'    — SECRET AGENDAS mode (humans only): a human picks one of a few of these at
//                      setup and it becomes their sole win path. AIs never draw agendas.
//
// api shape (all functions take a faction key fk):
//   round                      — current round number
//   nodes(fk)        -> int    — Core Nodes fk controls
//   tiles(fk)        -> int    — tiles fk controls
//   resources(fk)    -> int    — fk's resource stockpile
//   livingRivals(fk) -> int    — living factions other than fk (INCLUDING the Tyrant)
//   livingFoes(fk)   -> int    — living NON-TYRANT factions other than fk
//   foesAtStart      -> int    — non-Tyrant rival count at game start (for "outlast N" goals)
//   pactRounds(fk)   -> int    — longest CURRENT pact fk holds, measured in rounds held (0 if none)
//   cardinalRegionTiles(fk) -> {N,S,E,W} — fk's tile count in each cardinal region (center excluded)
//
// Each objective: { id, title, kind, desc, check(api, fk) -> bool, progress(api, fk) -> {cur,max,label} }
// ============================================================

export const OBJECTIVES = {
  // ---- Universal wins (today's behavior, as predicates) ----
  node_dominance: {
    id: 'node_dominance', title: 'NODE DOMINANCE', kind: 'universal',
    desc: 'Control 3+ Core Nodes (and hold them for 3 rounds).',
    check: (api, fk) => api.nodes(fk) >= 3,   // the 3-round HOLD + Reckoning are orchestrated by the caller
    progress: (api, fk) => ({ cur: api.nodes(fk), max: 3, label: `${api.nodes(fk)}/3 nodes` }),
  },
  last_standing: {
    id: 'last_standing', title: 'LAST STANDING', kind: 'universal',
    desc: 'Be the only faction left alive.',
    check: (api, fk) => api.livingRivals(fk) === 0,
    progress: (api, fk) => ({ cur: 0, max: 0, label: `${api.livingRivals(fk)} rivals left` }),
  },

  // ---- Agenda cards (SECRET AGENDAS mode, humans only) ----
  purge: {
    id: 'purge', title: 'PURGE', kind: 'agenda',
    desc: 'Outlast your rivals — be standing when only ONE non-Tyrant rival remains.',
    check: (api, fk) => api.livingFoes(fk) <= 1,
    progress: (api, fk) => {
      const gone = Math.max(0, (api.foesAtStart - 1) - api.livingFoes(fk));
      const need = Math.max(1, api.foesAtStart - 1);
      return { cur: gone, max: need, label: `${gone}/${need} rivals purged` };
    },
  },
  warlord: {
    id: 'warlord', title: 'WARLORD', kind: 'agenda',
    desc: 'Sprawl across the map — control 14+ tiles at once.',
    check: (api, fk) => api.tiles(fk) >= 14,
    progress: (api, fk) => ({ cur: api.tiles(fk), max: 14, label: `${api.tiles(fk)}/14 tiles` }),
  },
  power_broker: {
    id: 'power_broker', title: 'POWER BROKER', kind: 'agenda',
    desc: 'Hold 2+ Core Nodes while keeping a pact alive for 2 rounds.',
    check: (api, fk) => api.nodes(fk) >= 2 && api.pactRounds(fk) >= 2,
    progress: (api, fk) => {
      const n = api.nodes(fk), p = api.pactRounds(fk);
      return { cur: Math.min(n, 2) + Math.min(p, 2), max: 4, label: `${Math.min(n,2)}/2 nodes · pact ${Math.min(p,2)}/2 rds` };
    },
  },
  // Turtle-proof spread goal: you must project power into every quadrant, so a corner camp can't win.
  four_winds: {
    id: 'four_winds', title: 'FOUR WINDS', kind: 'agenda',
    desc: 'Plant your flag map-wide — control 2+ tiles in EACH region: North, South, East, and West.',
    check: (api, fk) => {
      const r = api.cardinalRegionTiles(fk);
      return r.N >= 2 && r.S >= 2 && r.E >= 2 && r.W >= 2;
    },
    progress: (api, fk) => {
      const r = api.cardinalRegionTiles(fk);
      const done = ['N','S','E','W'].filter(d => r[d] >= 2).length;
      return { cur: done, max: 4, label: `${done}/4 regions · N${r.N} S${r.S} E${r.E} W${r.W}` };
    },
  },
};

export function getObjective(id) { return OBJECTIVES[id] || null; }
export function agendaPool() { return Object.values(OBJECTIVES).filter(o => o.kind === 'agenda'); }
export function isObjectiveMet(api, fk, id) {
  const o = OBJECTIVES[id];
  return !!(o && o.check(api, fk));
}
