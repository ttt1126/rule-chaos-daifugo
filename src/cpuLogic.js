const { RANKS, RANK_VALUES } = require('./constants');
const { generateRandomRules } = require('./randomRules');
const { normalizeRuleInput, ruleSignature } = require('./ruleEngine');

const CPU_CONFIG = {
  scoring: {
    rankWeight: 10,
    multiCardBonus: 8,
    jokerPenalty: 50,
    strongRankPenalty: 6,
    randomness: 2,
    finishBonus: 20
  },
  ruleGeneration: {
    attempts: 40,
    randomRuleConfig: {
      conditionSlotDistribution: [
        { slots: 1, weight: 0.72 },
        { slots: 2, weight: 0.25 },
        { slots: 3, weight: 0.03 }
      ],
      maxAttemptsPerRule: 80,
      fixedRankBindRate: 0.75
    }
  }
};

function chooseCpuPlay(room, player, getLegalPlays, rng = Math.random) {
  const legalPlays = getLegalPlays(room, player.id);
  if (legalPlays.length === 0) {
    return null;
  }

  return legalPlays
    .map((move) => ({
      ...move,
      score: scoreMove(move, player, rng)
    }))
    .sort((a, b) => a.score - b.score)[0];
}

function scoreMove(move, player, rng = Math.random, config = CPU_CONFIG.scoring) {
  const jokerCount = move.play.cards.filter((card) => card.joker).length;
  const strongRankBase = RANK_VALUES.K;
  const strongPenalty = Math.max(0, move.play.rankValue - strongRankBase) * config.strongRankPenalty;
  const finishBonus = move.play.count >= player.hand.length ? config.finishBonus : 0;

  return (
    move.play.rankValue * config.rankWeight -
    (move.play.count - 1) * config.multiCardBonus +
    jokerCount * config.jokerPenalty +
    strongPenalty -
    finishBonus +
    rng() * config.randomness
  );
}

function chooseCpuTarget(room, pendingAction, rng = Math.random) {
  const candidates = (pendingAction.eligibleTargetIds || [])
    .map((playerId) => room.players.find((player) => player.id === playerId))
    .filter((player) => player && !player.left && !player.finishedRank);

  if (candidates.length === 0) {
    return null;
  }

  if (pendingAction.effect === 'gift') {
    return chooseByCardCount(candidates, 'max', rng).id;
  }

  if (['skip', 'bindSuit', 'bindRank'].includes(pendingAction.effect)) {
    return chooseByCardCount(candidates, 'min', rng).id;
  }

  return randomItem(candidates, rng).id;
}

function chooseCpuCardsToGive(player, requiredCount) {
  return chooseWeakCards(player.hand, requiredCount);
}

function chooseCpuDiscard(player, requiredCount) {
  return chooseWeakCards(player.hand, requiredCount);
}

function chooseCpuRule(room, player, rng = Math.random) {
  const existingSignatures = room.rules.map((rule) => ruleSignature(rule));

  for (let attempt = 0; attempt < CPU_CONFIG.ruleGeneration.attempts; attempt += 1) {
    const [generated] = generateRandomRules(1, {
      allowAnyCount: true,
      existingSignatures,
      rng,
      config: CPU_CONFIG.ruleGeneration.randomRuleConfig,
      startOrder: room.rules.length
    });
    const rule = normalizeGeneratedRule(generated);
    if (rule && !existingSignatures.includes(ruleSignature(rule))) {
      return rule;
    }
  }

  for (const candidate of fallbackRuleCandidates(player, rng)) {
    try {
      const rule = normalizeRuleInput(candidate);
      if (!existingSignatures.includes(ruleSignature(rule))) {
        return rule;
      }
    } catch (_error) {
      // Try the next simple candidate.
    }
  }

  return null;
}

function normalizeGeneratedRule(rule) {
  if (!rule) return null;
  try {
    return normalizeRuleInput({
      condition: { ...rule.condition },
      target: rule.target,
      effect: rule.effect,
      effectConfig: { ...(rule.effectConfig || {}) }
    });
  } catch (_error) {
    return null;
  }
}

function fallbackRuleCandidates(_player, rng = Math.random) {
  return shuffleArray(
    [
      { condition: baseCondition({ rank: '7' }), target: 'next', effect: 'skip' },
      { condition: baseCondition({ count: 2 }), target: 'next', effect: 'skip' },
      { condition: baseCondition({ rank: '5' }), target: 'next', effect: 'gift' },
      { condition: baseCondition({ rank: '8', count: 1 }), target: 'any', effect: 'skip' },
      { condition: baseCondition({ rank: 'JOKER' }), target: 'any', effect: 'skip' },
      { condition: baseCondition({ suit: 'S', count: 2 }), target: 'any', effect: 'gift' },
      {
        condition: baseCondition({ rank: '10', count: 2 }),
        target: 'any',
        effect: 'bindRank',
        effectConfig: { bindRank: '7' }
      },
      { condition: baseCondition({ rank: randomItem(RANKS, rng) }), target: 'next', effect: 'bindSuit' }
    ],
    rng
  );
}

function baseCondition(overrides) {
  return {
    rank: null,
    suit: null,
    count: null,
    rankRelation: null,
    suitRelation: null,
    ...overrides
  };
}

function chooseWeakCards(hand, requiredCount) {
  const count = Math.max(0, Math.min(Number(requiredCount) || 0, hand.length));
  return [...hand]
    .sort((a, b) => cardValue(a) - cardValue(b) || String(a.id).localeCompare(String(b.id)))
    .slice(0, count)
    .map((card) => card.id);
}

function chooseByCardCount(players, mode, rng) {
  const scores = players.map((player) => player.hand.length);
  const targetScore = mode === 'max' ? Math.max(...scores) : Math.min(...scores);
  return randomItem(players.filter((player) => player.hand.length === targetScore), rng);
}

function cardValue(card) {
  if (card.joker) return RANK_VALUES.JOKER + 20;
  return RANK_VALUES[card.rank] || 0;
}

function randomItem(items, rng) {
  return items[Math.floor(rng() * items.length)];
}

function shuffleArray(items, rng) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

module.exports = {
  CPU_CONFIG,
  chooseCpuCardsToGive,
  chooseCpuDiscard,
  chooseCpuPlay,
  chooseCpuRule,
  chooseCpuTarget,
  scoreMove
};
