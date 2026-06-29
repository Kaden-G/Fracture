import { evaluateHand, HAND_RANKS } from './hand-eval.js';

const PERSONALITIES = [
  { name: 'Slim', style: 'tight', aggression: 0.3, bluff: 0.08 },
  { name: 'Rattlesnake', style: 'aggressive', aggression: 0.7, bluff: 0.2 },
  { name: 'Doc', style: 'calculated', aggression: 0.5, bluff: 0.12 },
  { name: 'Calamity', style: 'loose', aggression: 0.6, bluff: 0.25 },
  { name: 'Preacher', style: 'tight', aggression: 0.35, bluff: 0.05 },
  { name: 'Whiskey Pete', style: 'loose', aggression: 0.55, bluff: 0.3 },
  { name: 'Iron Belle', style: 'aggressive', aggression: 0.65, bluff: 0.15 },
  { name: 'The Kid', style: 'calculated', aggression: 0.45, bluff: 0.1 },
];

export function getAIPersonalities(count) {
  const shuffled = [...PERSONALITIES].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

export function aiDecision(player, gameState) {
  const { communityCards, pot, currentBet, minRaise } = gameState;
  const personality = player.personality;
  const toCall = currentBet - player.currentBet;

  const handStrength = estimateStrength(player.hand, communityCards);
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;

  if (Math.random() < personality.bluff && toCall < player.chips * 0.15) {
    const bluffAmount = minRaise + Math.floor(Math.random() * minRaise);
    if (bluffAmount <= player.chips) {
      return { action: 'raise', amount: Math.min(bluffAmount, player.chips) };
    }
  }

  if (handStrength > 0.8) {
    const raiseAmount = Math.floor(pot * (0.5 + personality.aggression * 0.5));
    if (raiseAmount >= minRaise && raiseAmount <= player.chips) {
      return { action: 'raise', amount: raiseAmount };
    }
    return toCall <= player.chips ? { action: 'call' } : { action: 'fold' };
  }

  if (handStrength > 0.6) {
    if (Math.random() < personality.aggression && toCall < player.chips * 0.2) {
      const raiseAmount = minRaise + Math.floor(Math.random() * pot * 0.3);
      if (raiseAmount <= player.chips) {
        return { action: 'raise', amount: raiseAmount };
      }
    }
    return toCall <= player.chips * 0.3 ? { action: 'call' } : { action: 'fold' };
  }

  if (handStrength > 0.4) {
    if (toCall === 0) return { action: 'check' };
    return toCall <= player.chips * 0.15 ? { action: 'call' } : { action: 'fold' };
  }

  if (toCall === 0) return { action: 'check' };

  if (personality.style === 'loose' && toCall < player.chips * 0.08) {
    return { action: 'call' };
  }

  return { action: 'fold' };
}

function estimateStrength(hand, community) {
  if (!hand || hand.length < 2) return 0.3;

  if (community.length === 0) {
    return preflopStrength(hand);
  }

  const eval_ = evaluateHand(hand, community);
  const rankNorm = eval_.rank / 9;
  const kickerBonus = (eval_.kickers[0] || 2) / 14 * 0.1;
  return Math.min(rankNorm * 0.8 + kickerBonus + 0.15, 1);
}

function preflopStrength(hand) {
  const [a, b] = hand;
  const high = Math.max(a.value, b.value);
  const low = Math.min(a.value, b.value);
  const suited = a.suit === b.suit;
  const paired = a.value === b.value;

  if (paired) {
    if (high >= 12) return 0.9;
    if (high >= 8) return 0.7;
    return 0.55;
  }
  if (high === 14 && low >= 12) return suited ? 0.85 : 0.8;
  if (high === 14 && low >= 10) return suited ? 0.7 : 0.6;
  if (high === 14) return suited ? 0.55 : 0.45;
  if (high === 13 && low >= 11) return suited ? 0.65 : 0.55;
  if (suited && high - low <= 2) return 0.5;
  if (suited) return 0.4;
  if (high - low <= 2) return 0.35;
  return 0.25;
}
