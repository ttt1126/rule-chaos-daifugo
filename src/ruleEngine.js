const {
  EFFECTS,
  RANKS,
  SUITS,
  SUIT_LABELS,
  SUIT_SYMBOLS,
  TARGETS
} = require('./constants');

const VALID_RANKS = new Set([...RANKS, 'JOKER']);
const VALID_SUITS = new Set(SUITS.map((suit) => suit.id));
const VALID_COUNTS = new Set([1, 2, 3, 4]);

function normalizeNullable(value) {
  if (value === undefined || value === null || value === '' || value === 'none') {
    return null;
  }
  return value;
}

function normalizeRuleInput(input) {
  const condition = input?.condition || {};
  const rank = normalizeNullable(condition.rank);
  const suit = normalizeNullable(condition.suit);
  const rawCount = normalizeNullable(condition.count);
  const count = rawCount === null ? null : Number(rawCount);
  const effect = input?.effect;
  const effectConfig = EFFECTS[effect];

  if (!effectConfig) {
    throw new Error('存在しない効果です');
  }
  if (rank !== null && !VALID_RANKS.has(rank)) {
    throw new Error('存在しない数字条件です');
  }
  if (suit !== null && !VALID_SUITS.has(suit)) {
    throw new Error('存在しないスート条件です');
  }
  if (count !== null && !VALID_COUNTS.has(count)) {
    throw new Error('枚数条件は1〜4枚から選んでください');
  }
  if (rank === null && suit === null && count === null) {
    throw new Error('少なくとも1つの条件を指定してください');
  }

  let target = normalizeNullable(input?.target) || effectConfig.targets[0];
  if (effectConfig.targets.length === 1 && effectConfig.targets[0] === 'none') {
    target = 'none';
  }
  if (!effectConfig.targets.includes(target)) {
    throw new Error('この効果では選べない対象です');
  }

  if (effect === 'bindSuit' && suit === null) {
    throw new Error('縛り効果はスート条件を指定してください');
  }

  return {
    condition: { rank, suit, count },
    target,
    effect
  };
}

function conditionMatchesPlay(condition, play) {
  if (condition.rank !== null) {
    if (condition.rank === 'JOKER') {
      if (!play.hasJoker) return false;
    } else if (!play.ruleRanks.has(condition.rank)) {
      return false;
    }
  }

  if (condition.suit !== null && !play.ruleSuits.has(condition.suit)) {
    return false;
  }

  if (condition.count !== null && play.count !== condition.count) {
    return false;
  }

  return true;
}

function getTriggeredRules(rules, play) {
  return rules.filter((rule) => conditionMatchesPlay(rule.condition, play));
}

function orderTriggeredRules(rules) {
  return [...rules].sort((a, b) => {
    const orderDiff = EFFECTS[a.effect].order - EFFECTS[b.effect].order;
    if (orderDiff !== 0) return orderDiff;
    return (a.order || 0) - (b.order || 0);
  });
}

function ruleSignature(rule) {
  return [
    rule.condition.rank || '*',
    rule.condition.suit || '*',
    rule.condition.count || '*',
    rule.target,
    rule.effect
  ].join('|');
}

function describeCondition(condition) {
  const parts = [];
  if (condition.suit) {
    parts.push(SUIT_SYMBOLS[condition.suit]);
  }
  if (condition.rank) {
    parts.push(condition.rank === 'JOKER' ? 'JOKER' : condition.rank);
  }

  let cardText = parts.join('');
  if (condition.count) {
    cardText = cardText ? `${cardText}を含む${condition.count}枚出し` : `${condition.count}枚出し`;
  } else if (cardText) {
    cardText = `${cardText}を出す`;
  }

  return cardText || '条件なし';
}

function describeTarget(target) {
  return TARGETS[target]?.label || target;
}

function describeEffect(effect) {
  return EFFECTS[effect]?.label || effect;
}

function describeRule(rule) {
  if (rule.secret && !rule.revealed) {
    return '???';
  }

  const conditionText = describeCondition(rule.condition);
  const effectText = describeEffect(rule.effect);
  if (rule.target === 'none') {
    return `${conditionText} → ${effectText}`;
  }
  return `${conditionText} → ${describeTarget(rule.target)} → ${effectText}`;
}

function describeSuit(suit) {
  return `${SUIT_SYMBOLS[suit]}（${SUIT_LABELS[suit]}）`;
}

function validTargetsForEffect(effect) {
  return EFFECTS[effect]?.targets || [];
}

module.exports = {
  describeCondition,
  describeEffect,
  describeRule,
  describeSuit,
  describeTarget,
  getTriggeredRules,
  normalizeRuleInput,
  orderTriggeredRules,
  ruleSignature,
  validTargetsForEffect
};
