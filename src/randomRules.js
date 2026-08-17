const { CONNECTORS, EFFECTS, HIDDEN_RULE_COUNTS, RANKS, SUITS, TARGETS } = require('./constants');
const { calculateConditionPower, normalizeRuleInput, ruleSignature } = require('./ruleEngine');

const RANDOM_RULE_CONFIG = {
  effectPool: ['gift', 'skip', 'bindSuit', 'bindRank', 'clear', 'reverse'],
  conditionSlotDistribution: [
    { slots: 1, weight: 0.65 },
    { slots: 2, weight: 0.3 },
    { slots: 3, weight: 0.05 }
  ],
  effectWeights: {
    gift: 1.3,
    skip: 1.0,
    bindSuit: 0.9,
    bindRank: 0.9,
    reverse: 0.6,
    clear: 0.4
  },
  targetWeights: {
    self: 0.15,
    next: 1.0,
    any: 0.8,
    all: 0.5,
    none: 1.0
  },
  maxAttemptsPerRule: 100,
  fixedRankBindRate: 0.65
};

function randomItem(items, rng) {
  return items[Math.floor(rng() * items.length)];
}

function resolveConfig(config = {}) {
  return {
    ...RANDOM_RULE_CONFIG,
    ...config,
    effectWeights: {
      ...RANDOM_RULE_CONFIG.effectWeights,
      ...(config.effectWeights || {})
    },
    targetWeights: {
      ...RANDOM_RULE_CONFIG.targetWeights,
      ...(config.targetWeights || {})
    }
  };
}

function configuredWeight(weights, key) {
  const value = Number(weights?.[key]);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function weightedItem(items, rng, weightForItem) {
  const weightedItems = items
    .map((item) => ({ item, weight: Number(weightForItem(item)) }))
    .filter((entry) => Number.isFinite(entry.weight) && entry.weight > 0);

  if (weightedItems.length === 0) {
    return null;
  }

  const totalWeight = weightedItems.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = rng() * totalWeight;
  for (const entry of weightedItems) {
    roll -= entry.weight;
    if (roll <= 0) return entry.item;
  }
  return weightedItems[weightedItems.length - 1].item;
}

function weightedSlotCount(rng, config = RANDOM_RULE_CONFIG) {
  const distribution = config.conditionSlotDistribution || RANDOM_RULE_CONFIG.conditionSlotDistribution;
  const totalWeight = distribution.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = rng() * totalWeight;
  for (const entry of distribution) {
    roll -= entry.weight;
    if (roll <= 0) return entry.slots;
  }
  return 1;
}

function conditionSlotCount(condition) {
  return ['rank', 'suit', 'count', 'rankRelation', 'suitRelation'].filter((key) => Boolean(condition[key])).length;
}

function requiredPowerForTarget(target) {
  const connector = TARGETS[target]?.connector;
  return connector ? CONNECTORS[connector].level : 4;
}

function randomConditionSlots(rng) {
  return shuffleArray(['rank', 'suit', 'count', 'rankRelation', 'suitRelation'], rng);
}

function shuffleArray(items, rng) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function applyConditionSlot(condition, slot, rng) {
  if (slot === 'rank' && !condition.rank) {
    condition.rank = !condition.suit && rng() < 0.08 ? 'JOKER' : randomItem(RANKS, rng);
    if (condition.rank === 'JOKER') {
      condition.suit = null;
    }
    return true;
  } else if (slot === 'suit' && !condition.suit && condition.rank !== 'JOKER') {
    condition.suit = randomItem(SUITS, rng).id;
    return true;
  } else if (slot === 'rankRelation' && !condition.rankRelation) {
    condition.rankRelation = 'plusOne';
    return true;
  } else if (slot === 'suitRelation' && !condition.suitRelation) {
    condition.suitRelation = 'same';
    return true;
  } else if (slot === 'count' && !condition.count) {
    condition.count = randomItem([1, 1, 2, 2, 3, 4], rng);
    return true;
  }
  return false;
}

function buildConditionBySlotCount(slotCount, rng) {
  const condition = { rank: null, suit: null, count: null, rankRelation: null, suitRelation: null };
  const desiredSlots = Math.max(1, Math.min(3, Number(slotCount) || 1));

  for (const slot of randomConditionSlots(rng)) {
    if (conditionSlotCount(condition) >= desiredSlots) {
      break;
    }
    applyConditionSlot(condition, slot, rng);
  }

  const fallbackSlots = ['count', 'rank', 'suit', 'rankRelation', 'suitRelation'];
  for (const slot of fallbackSlots) {
    if (conditionSlotCount(condition) >= desiredSlots) {
      break;
    }
    applyConditionSlot(condition, slot, rng);
  }

  if (conditionSlotCount(condition) !== desiredSlots) {
    return null;
  }

  return condition;
}

function validTargetsForEffect(condition, effect) {
  const power = calculateConditionPower(condition);
  const effectDefinition = EFFECTS[effect];
  if (!effectDefinition) {
    return [];
  }

  return effectDefinition.targets.filter((target) => {
    if (power < requiredPowerForTarget(target)) {
      return false;
    }

    const targetConnector = TARGETS[target]?.connector;
    return Boolean(targetConnector && effectDefinition.connectors.includes(targetConnector));
  });
}

function chooseEffectAndTarget(condition, effects, rng, config = RANDOM_RULE_CONFIG) {
  const effectCandidates = effects
    .filter((effect) => validTargetsForEffect(condition, effect).length > 0);
  const effect = weightedItem(
    effectCandidates,
    rng,
    (candidate) => configuredWeight(config.effectWeights, candidate)
  );
  if (!effect) {
    return null;
  }

  const targetCandidates = validTargetsForEffect(condition, effect);
  const target = weightedItem(
    targetCandidates,
    rng,
    (candidate) => configuredWeight(config.targetWeights, candidate)
  );

  return target ? { effect, target } : null;
}

function buildEffectConfig(effect, rng, config = RANDOM_RULE_CONFIG) {
  const fixedRankBindRate = config.fixedRankBindRate ?? RANDOM_RULE_CONFIG.fixedRankBindRate;
  if (effect === 'bindRank' && rng() < fixedRankBindRate) {
    return { bindRank: randomItem(RANKS, rng) };
  }
  return {};
}

function generateRandomRules(count, options = {}) {
  const rng = options.rng || Math.random;
  const config = resolveConfig(options.config);
  const requestedCount = Number(count);
  const safeCount = options.allowAnyCount
    ? Math.max(1, Math.min(10, Number.isFinite(requestedCount) ? requestedCount : 1))
    : HIDDEN_RULE_COUNTS.includes(requestedCount)
      ? requestedCount
      : 5;
  const startOrder = Number.isFinite(options.startOrder) ? options.startOrder : 0;
  const secret = Boolean(options.secret);
  const effects = config.effectPool || RANDOM_RULE_CONFIG.effectPool;
  const rules = [];
  const seen = new Set(options.existingSignatures || []);
  let attempts = 0;
  const maxAttempts = safeCount * (config.maxAttemptsPerRule || 60);

  while (rules.length < safeCount && attempts < maxAttempts) {
    attempts += 1;
    const desiredSlots = weightedSlotCount(rng, config);
    const condition = buildConditionBySlotCount(desiredSlots, rng);
    if (!condition) {
      continue;
    }

    const effectAndTarget = chooseEffectAndTarget(condition, effects, rng, config);
    if (!effectAndTarget) {
      continue;
    }

    const { target, effect } = effectAndTarget;
    let candidate;
    try {
      candidate = normalizeRuleInput({
        condition,
        effect,
        target,
        effectConfig: buildEffectConfig(effect, rng, config)
      });
    } catch (_error) {
      continue;
    }
    const signature = ruleSignature(candidate);

    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    rules.push({
      ...candidate,
      id: `random_${Date.now()}_${rules.length}_${Math.floor(rng() * 100000)}`,
      order: startOrder + rules.length,
      createdBy: 'system',
      secret,
      revealed: !secret,
      generated: true
    });
  }

  return rules;
}

module.exports = {
  RANDOM_RULE_CONFIG,
  generateRandomRules
};
