const crypto = require('crypto');
const { RANKS, RANK_VALUES, SUITS, SUIT_ORDER, SUIT_SYMBOLS } = require('./constants');

function createDeck() {
  const cards = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      cards.push({
        id: `${suit.id}-${rank}`,
        rank,
        suit: suit.id,
        joker: false
      });
    }
  }

  cards.push({ id: 'JK-1', rank: 'JOKER', suit: null, joker: true });
  cards.push({ id: 'JK-2', rank: 'JOKER', suit: null, joker: true });
  return cards;
}

function shuffle(cards, rng = Math.random) {
  const shuffled = [...cards];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function sortHand(hand) {
  return [...hand].sort((a, b) => {
    if (a.joker && b.joker) return a.id.localeCompare(b.id);
    if (a.joker) return 1;
    if (b.joker) return -1;

    const rankDiff = RANK_VALUES[a.rank] - RANK_VALUES[b.rank];
    if (rankDiff !== 0) return rankDiff;
    return SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit];
  });
}

function cardLabel(card) {
  if (card.joker) return 'JOKER';
  return `${SUIT_SYMBOLS[card.suit]}${card.rank}`;
}

function publicCard(card) {
  return {
    id: card.id,
    rank: card.rank,
    suit: card.suit,
    joker: card.joker,
    label: cardLabel(card)
  };
}

function pickCardsFromHand(hand, cardIds) {
  if (!Array.isArray(cardIds)) {
    throw new Error('カード指定が不正です');
  }

  const uniqueIds = [...new Set(cardIds)];
  if (uniqueIds.length !== cardIds.length) {
    throw new Error('同じカードを複数回指定しています');
  }

  const byId = new Map(hand.map((card) => [card.id, card]));
  return uniqueIds.map((id) => {
    const card = byId.get(id);
    if (!card) {
      throw new Error('手札に存在しないカードが指定されました');
    }
    return card;
  });
}

function removeCardsFromHand(hand, cardIds) {
  const removeIds = new Set(cardIds);
  return hand.filter((card) => !removeIds.has(card.id));
}

function makeReconnectToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

module.exports = {
  cardLabel,
  createDeck,
  makeId,
  makeReconnectToken,
  pickCardsFromHand,
  publicCard,
  removeCardsFromHand,
  shuffle,
  sortHand
};
