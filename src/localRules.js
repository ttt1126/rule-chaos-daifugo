const { LOCAL_RULE_IDS } = require('./constants');

const LOCAL_RULES = {
  eightCut: {
    id: 'eightCut',
    ruleId: 'local_eightCut',
    label: '8切り',
    description: '8を出すと場が流れます。',
    condition: { rank: '8', suit: null, count: null, rankRelation: null, suitRelation: null },
    target: 'none',
    effect: 'clear',
    count: 1,
    order: 60
  },
  fiveSkip: {
    id: 'fiveSkip',
    ruleId: 'local_fiveSkip',
    label: '5飛び',
    description: '5を出すと次のプレイヤーを1人飛ばします。',
    condition: { rank: '5', suit: null, count: null, rankRelation: null, suitRelation: null },
    target: 'next',
    effect: 'skip',
    count: 1,
    order: 30
  },
  sevenGift: {
    id: 'sevenGift',
    ruleId: 'local_sevenGift',
    label: '7渡し',
    description: '7を出すと次のプレイヤーへ手札を1枚渡します。',
    condition: { rank: '7', suit: null, count: null, rankRelation: null, suitRelation: null },
    target: 'next',
    effect: 'gift',
    count: 1,
    order: 10
  },
  tenDiscard: {
    id: 'tenDiscard',
    ruleId: 'local_tenDiscard',
    label: '10捨て',
    description: '10を出すと手札を追加で1枚捨てられます。',
    condition: { rank: '10', suit: null, count: null, rankRelation: null, suitRelation: null },
    target: 'self',
    effect: 'discard',
    count: 1,
    order: 5
  }
};

const DEFAULT_LOCAL_RULE_SETTINGS = Object.fromEntries(LOCAL_RULE_IDS.map((id) => [id, false]));

function normalizeLocalRuleSettings(settings = {}) {
  return Object.fromEntries(
    LOCAL_RULE_IDS.map((id) => [id, Boolean(settings[id])])
  );
}

function enabledLocalRules(settings = {}) {
  const normalized = normalizeLocalRuleSettings(settings);
  return LOCAL_RULE_IDS.filter((id) => normalized[id]).map((id) => LOCAL_RULES[id]);
}

module.exports = {
  DEFAULT_LOCAL_RULE_SETTINGS,
  LOCAL_RULES,
  enabledLocalRules,
  normalizeLocalRuleSettings
};
