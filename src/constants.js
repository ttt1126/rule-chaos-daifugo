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

const CONNECTORS = {
  SELF: { id: 'SELF', level: 1, label: '自分', shortLabel: 'SELF' },
  NEXT: { id: 'NEXT', level: 2, label: '次', shortLabel: 'NEXT' },
  CHOICE: { id: 'CHOICE', level: 3, label: '任意', shortLabel: 'CHOICE' },
  GLOBAL: { id: 'GLOBAL', level: 4, label: '全体', shortLabel: 'GLOBAL' }
};

const CONNECTOR_ORDER = ['SELF', 'NEXT', 'CHOICE', 'GLOBAL'];

const CONDITION_POWER = {
  rank: 2,
  jokerRank: 3,
  suit: 2,
  rankRelationPlusOne: 2,
  suitRelationSame: 2,
  counts: {
    1: 1,
    2: 2,
    3: 3,
    4: 4
  },
  max: 4
};

const TARGETS = {
  none: { id: 'none', label: '対象なし', connector: 'GLOBAL' },
  self: { id: 'self', label: '自分', connector: 'SELF' },
  next: { id: 'next', label: '次のプレイヤー', connector: 'NEXT' },
  any: { id: 'any', label: '任意のプレイヤー', connector: 'CHOICE' },
  all: { id: 'all', label: '全員', connector: 'GLOBAL' }
};

const EFFECTS = {
  reverse: {
    id: 'reverse',
    label: 'リバース',
    order: 10,
    targets: ['none'],
    connectors: ['GLOBAL'],
    fixedTarget: 'none',
    fixedTargetLabel: '全体'
  },
  skip: {
    id: 'skip',
    label: 'スキップ',
    order: 20,
    targets: ['self', 'next', 'any'],
    connectors: ['SELF', 'NEXT', 'CHOICE']
  },
  bindSuit: {
    id: 'bindSuit',
    label: 'スート縛り',
    order: 30,
    targets: ['self', 'next', 'any', 'all'],
    connectors: ['SELF', 'NEXT', 'CHOICE', 'GLOBAL']
  },
  bindRank: {
    id: 'bindRank',
    label: '数字縛り',
    order: 31,
    targets: ['self', 'next', 'any', 'all'],
    connectors: ['SELF', 'NEXT', 'CHOICE', 'GLOBAL']
  },
  bindStep: {
    id: 'bindStep',
    label: '階段縛り',
    order: 32,
    targets: ['self', 'next', 'any', 'all'],
    connectors: ['SELF', 'NEXT', 'CHOICE', 'GLOBAL']
  },
  gift: {
    id: 'gift',
    label: '渡す',
    order: 40,
    targets: ['next', 'any'],
    connectors: ['NEXT', 'CHOICE']
  },
  clear: {
    id: 'clear',
    label: '流す',
    order: 50,
    targets: ['none'],
    connectors: ['GLOBAL'],
    fixedTarget: 'none',
    fixedTargetLabel: '場'
  }
};

const MODES = {
  normal: { id: 'normal', label: '通常' },
  chaos: { id: 'chaos', label: 'カオス' },
  mystery: { id: 'mystery', label: 'ミステリー' }
};

const HIDDEN_RULE_COUNTS = [3, 5, 8, 10];
const ROUND_COUNTS = [3, 4, 5];

const MATCH_DEFAULTS = {
  roundCount: 4,
  rulesPerPlayerPerRound: 1,
  ruleAddOrder: 'lowestToHighest',
  pointsByRank(playerCount, rank) {
    return Math.max(0, playerCount - rank);
  }
};

module.exports = {
  CONDITION_POWER,
  CONNECTOR_ORDER,
  CONNECTORS,
  EFFECTS,
  HIDDEN_RULE_COUNTS,
  MATCH_DEFAULTS,
  MODES,
  RANKS,
  RANK_VALUES,
  ROUND_COUNTS,
  SUITS,
  SUIT_LABELS,
  SUIT_ORDER,
  SUIT_SYMBOLS,
  TARGETS
};
