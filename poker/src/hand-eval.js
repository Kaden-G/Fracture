import { RANK_VALUES } from './cards.js';

const HAND_RANKS = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  THREE_KIND: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_KIND: 7,
  STRAIGHT_FLUSH: 8,
  ROYAL_FLUSH: 9,
};

const HAND_NAMES = [
  'High Card', 'Pair', 'Two Pair', 'Three of a Kind',
  'Straight', 'Flush', 'Full House', 'Four of a Kind',
  'Straight Flush', 'Royal Flush'
];

export { HAND_RANKS, HAND_NAMES };

function combinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  const withFirst = combinations(rest, k - 1).map(c => [first, ...c]);
  const without = combinations(rest, k);
  return [...withFirst, ...without];
}

function evaluateFive(cards) {
  const values = cards.map(c => c.value).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);

  const uniqueVals = [...new Set(values)].sort((a, b) => b - a);
  let isStraight = false;
  let straightHigh = 0;

  if (uniqueVals.length === 5) {
    if (uniqueVals[0] - uniqueVals[4] === 4) {
      isStraight = true;
      straightHigh = uniqueVals[0];
    }
    if (uniqueVals[0] === 14 && uniqueVals[1] === 5 && uniqueVals[4] === 2) {
      isStraight = true;
      straightHigh = 5;
    }
  }

  const counts = {};
  values.forEach(v => counts[v] = (counts[v] || 0) + 1);
  const groups = Object.entries(counts)
    .map(([v, c]) => ({ val: +v, count: c }))
    .sort((a, b) => b.count - a.count || b.val - a.val);

  if (isStraight && isFlush) {
    const rank = straightHigh === 14 ? HAND_RANKS.ROYAL_FLUSH : HAND_RANKS.STRAIGHT_FLUSH;
    return { rank, kickers: [straightHigh] };
  }
  if (groups[0].count === 4) {
    return { rank: HAND_RANKS.FOUR_KIND, kickers: [groups[0].val, groups[1].val] };
  }
  if (groups[0].count === 3 && groups[1].count === 2) {
    return { rank: HAND_RANKS.FULL_HOUSE, kickers: [groups[0].val, groups[1].val] };
  }
  if (isFlush) {
    return { rank: HAND_RANKS.FLUSH, kickers: values };
  }
  if (isStraight) {
    return { rank: HAND_RANKS.STRAIGHT, kickers: [straightHigh] };
  }
  if (groups[0].count === 3) {
    const kicks = groups.slice(1).map(g => g.val);
    return { rank: HAND_RANKS.THREE_KIND, kickers: [groups[0].val, ...kicks] };
  }
  if (groups[0].count === 2 && groups[1].count === 2) {
    const pairVals = [groups[0].val, groups[1].val].sort((a, b) => b - a);
    return { rank: HAND_RANKS.TWO_PAIR, kickers: [...pairVals, groups[2].val] };
  }
  if (groups[0].count === 2) {
    const kicks = groups.slice(1).map(g => g.val);
    return { rank: HAND_RANKS.PAIR, kickers: [groups[0].val, ...kicks] };
  }
  return { rank: HAND_RANKS.HIGH_CARD, kickers: values };
}

export function evaluateHand(holeCards, communityCards) {
  const all = [...holeCards, ...communityCards];
  const combos = combinations(all, 5);
  let best = null;
  for (const combo of combos) {
    const result = evaluateFive(combo);
    if (!best || compareEval(result, best) > 0) {
      best = result;
      best.cards = combo;
    }
  }
  best.name = HAND_NAMES[best.rank];
  return best;
}

function compareEval(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.min(a.kickers.length, b.kickers.length); i++) {
    if (a.kickers[i] !== b.kickers[i]) return a.kickers[i] - b.kickers[i];
  }
  return 0;
}

export function compareHands(evalA, evalB) {
  return compareEval(evalA, evalB);
}
