const { CONNECTORS, EFFECTS, HIDDEN_RULE_COUNTS, RANKS, SUITS, TARGETS } = require('./constants');
const { calculateConditionPower, normalizeRuleInput, ruleSignature } = require('./ruleEngine');

const RANDOM_RULE_CONFIG = {
  effectPool: ['gift', 'skip', 'bindSuit', 'bindRank', 'clear', 'reverse'],
  conditionSlotDistribution: [
    { slots: 1, weight: 0.65 },
    { slots: 2, weight: 0.3 },
    { slots: 3, weight: 0.05 }
  ],
  maxAttemptsPerRule: 100,
  fixedRankBindRate: 0.65
};

function randomItem(items, rng) {
  return items[Math.floor(rng() * items.length)];
}

function weightedSlotCount(rng) {
  const totalWeight = RANDOM_RULE_CONFIG.conditionSlotDistribution.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = rng() * totalWeight;
  for (const entry of RANDOM_RULE_CONFIG.conditionSlotDistribution) {
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
    condition.rank = rng() < 0.08 ? 'JOKER' : randomItem(RANKS, rng);
    if (condition.rank === 'JOKER') {
      condition.suit = null;
    }
  } else if (slot === 'suit' && !condition.suit && condition.rank !== 'JOKER') {
    condition.suit = randomItem(SUITS, rng).id;
  } else if (slot === 'rankRelation' && !condition.rankRelation) {
    condition.rankRelation = 'plusOne';
  } else if (slot === 'suitRelation' && !condition.suitRelation) {
    condition.suitRelation = 'same';
  } else if (slot === 'count' && !condition.count) {
    condition.count = randomItem([1, 1, 2, 2, 3, 4], rng);
  }
}

function buildCondition(target, rng) {
  const condition = { rank: null, suit: null, count: null, rankRelation: null, suitRelation: null };
  const desiredSlots = weightedSlotCount(rng);
  const requiredPower = requiredPowerForTarget(target);

  for (const slot of randomConditionSlots(rng)) {
    if (conditionSlotCount(condition) >= desiredSlots && calculateConditionPower(condition) >= requiredPower) {
      break;
    }
    applyConditionSlot(condition, slot, rng);
  }

  const fallbackSlots = ['count', 'rank', 'suit', 'rankRelation', 'suitRelation'];
  for (const slot of fallbackSlots) {
    if (calculateConditionPower(condition) >= requiredPower) {
      break;
    }
    applyConditionSlot(condition, slot, rng);
  }

  return condition;
}

function buildEffectConfig(effect, rng) {
  if (effect === 'bindRank' && rng() < RANDOM_RULE_CONFIG.fixedRankBindRate) {
    return { bindRank: randomItem(RANKS, rng) };
  }
  return {};
}

function generateRandomRules(count, options = {}) {
  const rng = options.rng || Math.random;
  const safeCount = HIDDEN_RULE_COUNTS.includes(Number(count)) ? Number(count) : 5;
  const startOrder = Number.isFinite(options.startOrder) ? options.startOrder : 0;
  const secret = Boolean(options.secret);
  const effects = RANDOM_RULE_CONFIG.effectPool;
  const rules = [];
  const seen = new Set(options.existingSignatures || []);
  let attempts = 0;

  while (rules.length < safeCount && attempts < safeCount * 60) {
    attempts += 1;
    const effect = randomItem(effects, rng);
    const targets = EFFECTS[effect].targets;
    const target = randomItem(targets, rng);
    let candidate;
    try {
      candidate = normalizeRuleInput({
        condition: buildCondition(target, rng),
        effect,
        target,
        effectConfig: buildEffectConfig(effect, rng)
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
