const {
  CONDITION_POWER,
  CONNECTORS,
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

function normalizeTarget(value) {
  if (value === undefined || value === null || value === '') {
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

  let target = normalizeTarget(input?.target) || effectConfig.targets[0];
  if (effectConfig.targets.length === 1 && effectConfig.targets[0] === 'none') {
    target = 'none';
  }
  const normalized = {
    condition: { rank, suit, count },
    target,
    effect
  };

  validateRuleBalance(normalized);
  return normalized;
}

function validateRuleBalance(rule) {
  const power = calculateConditionPower(rule.condition);
  const target = TARGETS[rule.target];
  const effect = EFFECTS[rule.effect];

  if (!target) {
    throw new Error('存在しない対象です');
  }
  if (!effect) {
    throw new Error('存在しない効果です');
  }

  const targetConnector = target.connector;
  const targetLevel = CONNECTORS[targetConnector]?.level;
  if (!targetLevel) {
    throw new Error('対象の接続属性が不正です');
  }

  if (power < targetLevel) {
    throw new Error(
      `現在の条件パワーは${power}です。${target.label}を対象にするには${targetLevel}以上必要です`
    );
  }

  if (!effect.targets.includes(rule.target) || !effect.connectors.includes(targetConnector)) {
    throw new Error(`「${effect.label}」は${target.label}を対象にできません`);
  }
}

function calculateConditionPower(condition = {}) {
  let power = 0;
  const rank = normalizeNullable(condition.rank);
  const suit = normalizeNullable(condition.suit);
  const rawCount = normalizeNullable(condition.count);
  const count = rawCount === null ? null : Number(rawCount);

  if (rank) {
    power += rank === 'JOKER' ? CONDITION_POWER.jokerRank : CONDITION_POWER.rank;
  }
  if (suit) {
    power += CONDITION_POWER.suit;
  }
  if (count !== null) {
    power += CONDITION_POWER.counts[count] || 0;
  }

  return Math.min(CONDITION_POWER.max, power);
}

function targetConnector(target) {
  return TARGETS[target]?.connector || null;
}

function conditionUnlocksTarget(condition, target) {
  const connector = targetConnector(target);
  if (!connector) return false;
  return calculateConditionPower(condition) >= CONNECTORS[connector].level;
}

function effectSupportsTarget(effect, target) {
  const effectConfig = EFFECTS[effect];
  const connector = targetConnector(target);
  return Boolean(
    effectConfig &&
      connector &&
      effectConfig.targets.includes(target) &&
      effectConfig.connectors.includes(connector)
  );
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

function validConnectorsForEffect(effect) {
  return EFFECTS[effect]?.connectors || [];
}

module.exports = {
  calculateConditionPower,
  conditionUnlocksTarget,
  describeCondition,
  describeEffect,
  describeRule,
  describeSuit,
  describeTarget,
  effectSupportsTarget,
  getTriggeredRules,
  normalizeRuleInput,
  orderTriggeredRules,
  ruleSignature,
  targetConnector,
  validateRuleBalance,
  validConnectorsForEffect,
  validTargetsForEffect
};
