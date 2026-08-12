const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const RANK_VALUES = Object.fromEntries(RANKS.map((rank, index) => [rank, index + 3]));

const SUITS = [
  { id: 'S', symbol: '♠', label: 'スペード' },
  { id: 'H', symbol: '♥', label: 'ハート' },
  { id: 'D', symbol: '♦', label: 'ダイヤ' },
  { id: 'C', symbol: '♣', label: 'クラブ' }
];

const SUIT_ORDER = Object.fromEntries(SUITS.map((suit, index) => [suit.id, index]));
const SUIT_SYMBOLS = Object.fromEntries(SUITS.map((suit) => [suit.id, suit.symbol]));
const SUIT_LABELS = Object.fromEntries(SUITS.map((suit) => [suit.id, suit.label]));

const TARGETS = {
  none: { id: 'none', label: '対象なし' },
  self: { id: 'self', label: '自分' },
  next: { id: 'next', label: '次のプレイヤー' },
  all: { id: 'all', label: '全員' },
  any: { id: 'any', label: '任意のプレイヤー' }
};

const EFFECTS = {
  reverse: {
    id: 'reverse',
    label: 'リバース',
    order: 10,
    targets: ['none']
  },
  skip: {
    id: 'skip',
    label: 'スキップ',
    order: 20,
    targets: ['next', 'any']
  },
  bindSuit: {
    id: 'bindSuit',
    label: '縛り',
    order: 30,
    targets: ['self', 'next', 'all', 'any']
  },
  gift: {
    id: 'gift',
    label: '渡す',
    order: 40,
    targets: ['next', 'any']
  },
  clear: {
    id: 'clear',
    label: '流す',
    order: 50,
    targets: ['none']
  }
};

const MODES = {
  normal: { id: 'normal', label: '通常' },
  chaos: { id: 'chaos', label: 'カオス' },
  mystery: { id: 'mystery', label: 'ミステリー' }
};

const HIDDEN_RULE_COUNTS = [3, 5, 8, 10];

module.exports = {
  EFFECTS,
  HIDDEN_RULE_COUNTS,
  MODES,
  RANKS,
  RANK_VALUES,
  SUITS,
  SUIT_LABELS,
  SUIT_ORDER,
  SUIT_SYMBOLS,
  TARGETS
};
