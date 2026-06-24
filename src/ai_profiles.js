// ============================================================
// ai_profiles.js — AI difficulty tiers ("skill levels").
// PURE DATA + tiny helpers. No DOM, no imports, no side effects.
//
// This is the CANONICAL definition, imported by the sim side (state.js / ai.js /
// tests). The live game (app.js) keeps an inline twin of AI_PROFILES/AI_TIERS/
// DEFAULT_TIER because app.js is intentionally self-contained (same convention as
// its duplicated FACTIONS / mkFaction). KEEP THE TWO IN SYNC.
//
// Phase 1: the knobs are DECLARED here but not yet consumed by decision logic —
// every tier still plays identically until Phase 2 wires the knobs into the AI.
//
// Knob reference (consumed in later phases):
//   blunder      0..1  chance per action to take a random/suboptimal move instead of the best
//   minEdge      int   troop edge required before committing an attack (higher = more cautious)
//   abilities    bool  whether it uses its faction ability (sabotage / bribe) at all
//   defendLead   bool  whether it entrenches / protects the nodes it holds
//   thrift       0..1  resource discipline (0 = wasteful, 1 = optimal spending)
//   lookahead    0|1   0 = greedy immediate score; 1 = expected-value scoring + 1-ply counter check
//   coordinate   bool  AIs gang the leader/human and pool secret-pact knowledge (rule-bending)
//   tyrantAggro  num   multiplier on Tyrant conquest speed / sic targeting
// ============================================================

export const AI_TIERS = ['sandbox', 'jv', 'varsity', 'bloodbath'];
export const DEFAULT_TIER = 'varsity';

export const AI_PROFILES = {
  sandbox: {
    id: 'sandbox', name: 'Sandbox', icon: '🎈',
    blurb: 'Barely tries — random moves, no defense, wastes resources. For learning the ropes.',
    blunder: 0.6, minEdge: 2, abilities: false, defendLead: false,
    thrift: 0.3, lookahead: 0, coordinate: false, tyrantAggro: 0.6,
  },
  jv: {
    id: 'jv', name: 'JV', icon: '🏫',
    blurb: "Solid basics but no foresight — a fair fight you can outthink.",
    blunder: 0.2, minEdge: 1, abilities: true, defendLead: true,
    thrift: 0.6, lookahead: 0, coordinate: false, tyrantAggro: 0.85,
  },
  varsity: {
    id: 'varsity', name: 'Varsity', icon: '🎯',
    blurb: 'Plays the odds, defends its lead, concentrates force. The standard challenge.',
    blunder: 0.04, minEdge: 0, abilities: true, defendLead: true,
    thrift: 0.9, lookahead: 1, coordinate: false, tyrantAggro: 1.0,
  },
  bloodbath: {
    id: 'bloodbath', name: 'Bloodbath', icon: '💀',
    blurb: 'Flawless and merciless — the AIs gang up on the leader and share secrets. They cheat.',
    blunder: 0, minEdge: 0, abilities: true, defendLead: true,
    thrift: 1.0, lookahead: 1, coordinate: true, tyrantAggro: 1.3,
  },
};

// Resolve a tier id to its profile, falling back to the default for unknown/missing ids.
export function getProfile(id) {
  return AI_PROFILES[id] || AI_PROFILES[DEFAULT_TIER];
}
