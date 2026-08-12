const { EFFECTS, HIDDEN_RULE_COUNTS, RANKS, SUITS } = require('./constants');
const { normalizeRuleInput, ruleSignature } = require('./ruleEngine');

function randomItem(items, rng) {
  return items[Math.floor(rng() * items.length)];
}

function buildCondition(effect, rng) {
  const condition = { rank: null, suit: null, count: null };
  const conditionSlots = ['rank', 'suit', 'count'];
  const slotCountRoll = rng();
  const desiredSlots = slotCountRoll < 0.55 ? 1 : slotCountRoll < 0.9 ? 2 : 3;

  while (conditionSlots.length > 0 && Object.values(condition).filter(Boolean).length < desiredSlots) {
    const slot = conditionSlots.splice(Math.floor(rng() * conditionSlots.length), 1)[0];
    if (slot === 'rank') {
      condition.rank = rng() < 0.08 ? 'JOKER' : randomItem(RANKS, rng);
    } else if (slot === 'suit') {
      condition.suit = randomItem(SUITS, rng).id;
    } else {
      condition.count = randomItem([1, 2, 3, 4], rng);
    }
  }

  if (effect === 'bindSuit' && !condition.suit) {
    condition.suit = randomItem(SUITS, rng).id;
  }

  if (!condition.rank && !condition.suit && !condition.count) {
    condition.rank = randomItem(RANKS, rng);
  }

  return condition;
}

function generateRandomRules(count, options = {}) {
  const rng = options.rng || Math.random;
  const safeCount = HIDDEN_RULE_COUNTS.includes(Number(count)) ? Number(count) : 5;
  const startOrder = Number.isFinite(options.startOrder) ? options.startOrder : 0;
  const secret = Boolean(options.secret);
  const effects = ['reverse', 'skip', 'bindSuit', 'gift', 'clear'];
  const rules = [];
  const seen = new Set(options.existingSignatures || []);
  let attempts = 0;

  while (rules.length < safeCount && attempts < safeCount * 60) {
    attempts += 1;
    const effect = randomItem(effects, rng);
    const targets = EFFECTS[effect].targets;
    const target = randomItem(targets, rng);
    const candidate = normalizeRuleInput({
      condition: buildCondition(effect, rng),
      effect,
      target
    });
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
  generateRandomRules
};
