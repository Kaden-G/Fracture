import { createDeck, shuffleDeck, cardId } from './cards.js';
import { evaluateHand, compareHands } from './hand-eval.js';

export const PHASES = ['preflop', 'flop', 'turn', 'river', 'showdown'];
export const SMALL_BLIND = 10;
export const BIG_BLIND = 20;
export const STARTING_CHIPS = 1000;

export function createGame(players) {
  return {
    players: players.map((p, i) => ({
      id: i,
      name: p.name,
      chips: STARTING_CHIPS,
      hand: [],
      currentBet: 0,
      totalBet: 0,
      folded: false,
      allIn: false,
      isAI: p.isAI,
      personality: p.personality || null,
      seatIndex: i,
    })),
    communityCards: [],
    deck: [],
    pot: 0,
    sidePots: [],
    phase: 'waiting',
    dealerIndex: 0,
    activeIndex: -1,
    currentBet: 0,
    minRaise: BIG_BLIND,
    lastRaiser: -1,
    roundNum: 0,
    log: [],
    winners: null,
  };
}

export function startHand(game) {
  const g = { ...game };
  g.roundNum++;
  g.deck = shuffleDeck(createDeck());
  g.communityCards = [];
  g.pot = 0;
  g.sidePots = [];
  g.currentBet = 0;
  g.minRaise = BIG_BLIND;
  g.lastRaiser = -1;
  g.winners = null;
  g.log = [];

  const alive = g.players.filter(p => p.chips > 0);
  if (alive.length < 2) return g;

  g.players.forEach(p => {
    p.hand = [];
    p.currentBet = 0;
    p.totalBet = 0;
    p.folded = false;
    p.allIn = false;
  });

  while (g.players[g.dealerIndex].chips <= 0) {
    g.dealerIndex = nextAlive(g, g.dealerIndex);
  }

  const sbIndex = alive.length === 2 ? g.dealerIndex : nextAlive(g, g.dealerIndex);
  const bbIndex = nextAlive(g, sbIndex);

  const sbAmount = Math.min(SMALL_BLIND, g.players[sbIndex].chips);
  g.players[sbIndex].chips -= sbAmount;
  g.players[sbIndex].currentBet = sbAmount;
  g.players[sbIndex].totalBet = sbAmount;
  g.pot += sbAmount;
  if (g.players[sbIndex].chips === 0) g.players[sbIndex].allIn = true;
  g.log.push({ type: 'blind', player: g.players[sbIndex].name, amount: sbAmount, kind: 'small' });

  const bbAmount = Math.min(BIG_BLIND, g.players[bbIndex].chips);
  g.players[bbIndex].chips -= bbAmount;
  g.players[bbIndex].currentBet = bbAmount;
  g.players[bbIndex].totalBet = bbAmount;
  g.pot += bbAmount;
  if (g.players[bbIndex].chips === 0) g.players[bbIndex].allIn = true;
  g.currentBet = BIG_BLIND;
  g.log.push({ type: 'blind', player: g.players[bbIndex].name, amount: bbAmount, kind: 'big' });

  for (const p of g.players) {
    if (p.chips > 0 || p.allIn) {
      p.hand = [g.deck.pop(), g.deck.pop()];
    }
  }

  g.phase = 'preflop';
  g.activeIndex = nextAlive(g, bbIndex);
  g.lastRaiser = -1;
  g.actedThisRound = {};

  return g;
}

function nextAlive(game, from) {
  let i = (from + 1) % game.players.length;
  let safety = 0;
  while ((game.players[i].chips <= 0 && !game.players[i].allIn) || game.players[i].folded) {
    i = (i + 1) % game.players.length;
    if (++safety > game.players.length) return from;
  }
  return i;
}

function activePlayers(game) {
  return game.players.filter(p => !p.folded && (p.chips > 0 || p.allIn));
}

function canAct(player) {
  return !player.folded && !player.allIn && player.chips > 0;
}

export function applyAction(game, action) {
  const g = { ...game, players: game.players.map(p => ({ ...p })) };
  const player = g.players[g.activeIndex];

  if (!canAct(player)) {
    g.activeIndex = nextAlive(g, g.activeIndex);
    return g;
  }

  switch (action.action) {
    case 'fold':
      player.folded = true;
      g.log.push({ type: 'action', player: player.name, action: 'fold' });
      break;

    case 'check':
      g.log.push({ type: 'action', player: player.name, action: 'check' });
      break;

    case 'call': {
      const toCall = Math.min(g.currentBet - player.currentBet, player.chips);
      player.chips -= toCall;
      player.currentBet += toCall;
      player.totalBet += toCall;
      g.pot += toCall;
      if (player.chips === 0) player.allIn = true;
      g.log.push({ type: 'action', player: player.name, action: player.allIn ? 'all-in (call)' : 'call', amount: toCall });
      break;
    }

    case 'raise': {
      const raiseTotal = action.amount;
      const needed = raiseTotal - player.currentBet;
      const actual = Math.min(needed, player.chips);
      player.chips -= actual;
      player.currentBet += actual;
      player.totalBet += actual;
      g.pot += actual;
      const newBet = player.currentBet;
      g.minRaise = Math.max(g.minRaise, newBet - g.currentBet);
      g.currentBet = newBet;
      g.actedThisRound = { [g.activeIndex]: true };
      if (player.chips === 0) player.allIn = true;
      g.log.push({ type: 'action', player: player.name, action: player.allIn ? 'all-in' : 'raise', amount: player.currentBet });
      break;
    }

    case 'all-in': {
      const amount = player.chips;
      player.currentBet += amount;
      player.totalBet += amount;
      player.chips = 0;
      player.allIn = true;
      g.pot += amount;
      if (player.currentBet > g.currentBet) {
        g.minRaise = Math.max(g.minRaise, player.currentBet - g.currentBet);
        g.currentBet = player.currentBet;
        g.actedThisRound = { [g.activeIndex]: true };
      }
      g.log.push({ type: 'action', player: player.name, action: 'all-in', amount: player.currentBet });
      break;
    }
  }

  if (!g.actedThisRound) g.actedThisRound = {};
  g.actedThisRound[g.activeIndex] = true;

  const notFolded = g.players.filter(p => !p.folded);
  if (notFolded.length === 1) {
    return resolveWinner(g);
  }

  const nextIdx = findNextToAct(g);
  if (nextIdx === -1) {
    return advancePhase(g);
  }

  g.activeIndex = nextIdx;
  return g;
}

function findNextToAct(game) {
  const acted = game.actedThisRound || {};
  let i = (game.activeIndex + 1) % game.players.length;
  for (let n = 0; n < game.players.length; n++) {
    const p = game.players[i];
    if (!p.folded && !p.allIn && p.chips > 0) {
      if (p.currentBet < game.currentBet) return i;
      if (!acted[i]) return i;
      return -1;
    }
    i = (i + 1) % game.players.length;
  }
  return -1;
}

function advancePhase(game) {
  const g = { ...game, players: game.players.map(p => ({ ...p })) };

  g.players.forEach(p => { p.currentBet = 0; });
  g.currentBet = 0;
  g.minRaise = BIG_BLIND;
  g.lastRaiser = -1;
  g.actedThisRound = {};

  const phaseIdx = PHASES.indexOf(g.phase);
  if (phaseIdx >= 3 || activePlayers(g).filter(p => canAct(p)).length <= 1) {
    while (g.communityCards.length < 5) {
      g.deck.pop(); // burn
      g.communityCards.push(g.deck.pop());
    }
    g.phase = 'showdown';
    return resolveShowdown(g);
  }

  g.deck.pop(); // burn card
  if (phaseIdx === 0) {
    g.communityCards.push(g.deck.pop(), g.deck.pop(), g.deck.pop());
    g.phase = 'flop';
  } else if (phaseIdx === 1) {
    g.communityCards.push(g.deck.pop());
    g.phase = 'turn';
  } else if (phaseIdx === 2) {
    g.communityCards.push(g.deck.pop());
    g.phase = 'river';
  }

  const alive = g.players.filter(p => !p.folded && (p.chips > 0 || p.allIn));
  const dealer = g.dealerIndex;
  let start = (dealer + 1) % g.players.length;
  let safety = 0;
  while (safety < g.players.length) {
    const p = g.players[start];
    if (!p.folded && !p.allIn && p.chips > 0) break;
    start = (start + 1) % g.players.length;
    safety++;
  }
  g.activeIndex = start;
  g.lastRaiser = start;

  if (alive.filter(p => canAct(p)).length <= 1) {
    return advancePhase(g);
  }

  g.log.push({ type: 'phase', phase: g.phase });
  return g;
}

function resolveWinner(game) {
  const g = { ...game };
  const winner = g.players.find(p => !p.folded);
  g.winners = [{ player: winner, amount: g.pot, hand: null }];
  winner.chips += g.pot;
  g.pot = 0;
  g.phase = 'showdown';
  g.log.push({ type: 'win', player: winner.name, amount: g.winners[0].amount, hand: 'everyone folded' });
  return g;
}

function resolveShowdown(game) {
  const g = { ...game };
  const contenders = g.players.filter(p => !p.folded);

  const evals = contenders.map(p => ({
    player: p,
    eval: evaluateHand(p.hand, g.communityCards),
  }));

  evals.sort((a, b) => compareHands(b.eval, a.eval));

  const allBets = g.players.map(p => p.totalBet).filter(b => b > 0);
  const uniqueBets = [...new Set(allBets)].sort((a, b) => a - b);

  g.winners = [];
  let awarded = 0;

  for (const cap of uniqueBets) {
    let potSlice = 0;
    for (const p of g.players) {
      const contribution = Math.min(p.totalBet, cap) - (awarded > 0 ? Math.min(p.totalBet, uniqueBets[uniqueBets.indexOf(cap) - 1] || 0) : 0);
      potSlice += Math.max(0, contribution);
    }
    if (potSlice <= 0) continue;

    const eligible = evals.filter(e => e.player.totalBet >= cap);
    if (eligible.length === 0) continue;

    const bestRank = eligible[0].eval.rank;
    const bestKickers = eligible[0].eval.kickers.join(',');
    const tiedWinners = eligible.filter(e => e.eval.rank === bestRank && e.eval.kickers.join(',') === bestKickers);

    const share = Math.floor(potSlice / tiedWinners.length);
    for (const w of tiedWinners) {
      w.player.chips += share;
      g.winners.push({ player: w.player, amount: share, hand: w.eval.name });
      g.log.push({ type: 'win', player: w.player.name, amount: share, hand: w.eval.name });
    }
  }

  g.pot = 0;
  g.phase = 'showdown';

  g.dealerIndex = nextAlive(g, g.dealerIndex);
  while (g.players[g.dealerIndex].chips <= 0) {
    g.dealerIndex = nextAlive(g, g.dealerIndex);
  }

  return g;
}

export function getValidActions(game) {
  const player = game.players[game.activeIndex];
  if (!player || !canAct(player)) return [];

  const actions = [];
  const toCall = game.currentBet - player.currentBet;

  if (toCall <= 0) {
    actions.push('check');
  }
  if (toCall > 0 && toCall < player.chips) {
    actions.push('call');
  }
  actions.push('fold');

  const minRaiseTotal = game.currentBet + game.minRaise;
  if (player.chips + player.currentBet > game.currentBet && player.chips > toCall) {
    actions.push('raise');
  }
  if (player.chips > 0) {
    actions.push('all-in');
  }

  return actions;
}

export function isHandOver(game) {
  return game.phase === 'showdown' && game.winners !== null;
}

export function isGameOver(game) {
  return game.players.filter(p => p.chips > 0).length <= 1;
}

export function getGameWinner(game) {
  return game.players.find(p => p.chips > 0);
}
