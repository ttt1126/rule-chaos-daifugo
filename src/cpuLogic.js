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
    finishBonus: 20,
    finishByExtraRemovalBonus: 55,
    ruleEffects: {
      skipOpponent: 36,
      skipSelfPenalty: 85,
      bindOpponent: 24,
      bindSelfPenalty: 46,
      giftOpponent: 26,
      clear: 10,
      reverse: 0,
      discardSelf: 28,
      localEightCut: 14,
      localFiveSkip: 38,
      localSevenGift: 30,
      localTenDiscard: 34,
      lowHandThreatBonus: 18
    },
    ruleKnowledgeByMode: {
      normal: 'visible',
      chaos: 'visible',
      mystery: 'visible'
    }
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
  const helpers = normalizeCpuHelpers(getLegalPlays);
  const legalPlays = helpers.getLegalPlays(room, player.id);
  if (legalPlays.length === 0) {
    return null;
  }

  const finishMoves = legalPlays.filter((move) => isFinishingMove(move, player));
  const candidates = finishMoves.length > 0 ? finishMoves : legalPlays;

  return candidates
    .map((move) => ({
      ...move,
      score: scoreMove(move, player, rng, CPU_CONFIG.scoring, { room, helpers })
    }))
    .sort((a, b) => a.score - b.score)[0];
}

function scoreMove(move, player, rng = Math.random, config = CPU_CONFIG.scoring, context = {}) {
  const jokerCount = move.play.cards.filter((card) => card.joker).length;
  const strongRankBase = RANK_VALUES.K;
  const strongPenalty = Math.max(0, move.play.rankValue - strongRankBase) * config.strongRankPenalty;
  const finishBonus = isFinishingMove(move, player) ? config.finishBonus : 0;
  const triggeredEffectScore = scoreTriggeredEffects(context.room, player, move, context.helpers, config);

  return (
    move.play.rankValue * config.rankWeight -
    (move.play.count - 1) * config.multiCardBonus +
    jokerCount * config.jokerPenalty +
    strongPenalty -
    finishBonus -
    triggeredEffectScore +
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

  if (['skip', 'bindSuit', 'bindRank', 'gift'].includes(pendingAction.effect)) {
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

function scoreTriggeredEffects(room, player, move, helpers = {}, config = CPU_CONFIG.scoring) {
  if (!room || !helpers.getTriggeredRulesForPlay) {
    return 0;
  }

  const triggeredRules = helpers.getTriggeredRulesForPlay(room, move.play, {
    includeHiddenRules: cpuCanUseHiddenRules(room, config)
  });

  return triggeredRules.reduce(
    (sum, rule) => sum + scoreTriggeredRule(room, player, move, rule, config),
    0
  );
}

function scoreTriggeredRule(room, player, move, rule, config = CPU_CONFIG.scoring) {
  const localScore = scoreLocalRule(room, player, move, rule, config);
  if (localScore !== null) {
    return localScore;
  }

  if (rule.effect === 'clear') {
    return config.ruleEffects.clear;
  }
  if (rule.effect === 'reverse') {
    return config.ruleEffects.reverse;
  }
  if (rule.effect === 'discard') {
    return config.ruleEffects.discardSelf + extraRemovalFinishScore(player, move, rule, config);
  }

  const targets = projectedTargets(room, player, rule);
  return targets.reduce(
    (sum, target) => sum + scoreTargetEffect(rule.effect, player, target, config),
    0
  ) + extraRemovalFinishScore(player, move, rule, config);
}

function scoreLocalRule(room, player, move, rule, config = CPU_CONFIG.scoring) {
  if (rule.source !== 'local') {
    return null;
  }

  const effectScore = config.ruleEffects;
  if (rule.localRuleId === 'eightCut') {
    return effectScore.localEightCut;
  }
  if (rule.localRuleId === 'fiveSkip') {
    const targets = projectedTargets(room, player, rule);
    return effectScore.localFiveSkip + targets.reduce(
      (sum, target) => sum + lowHandThreatBonus(target, config),
      0
    );
  }
  if (rule.localRuleId === 'sevenGift') {
    const targets = projectedTargets(room, player, rule);
    return effectScore.localSevenGift + targets.reduce(
      (sum, target) => sum + lowHandThreatBonus(target, config),
      0
    ) + extraRemovalFinishScore(player, move, rule, config);
  }
  if (rule.localRuleId === 'tenDiscard') {
    return effectScore.localTenDiscard + extraRemovalFinishScore(player, move, rule, config);
  }

  return null;
}

function scoreTargetEffect(effect, actor, target, config = CPU_CONFIG.scoring) {
  const isSelf = actor.id === target.id;
  if (effect === 'skip') {
    return isSelf
      ? -config.ruleEffects.skipSelfPenalty
      : config.ruleEffects.skipOpponent + lowHandThreatBonus(target, config);
  }
  if (effect === 'bindSuit' || effect === 'bindRank') {
    return isSelf
      ? -config.ruleEffects.bindSelfPenalty
      : config.ruleEffects.bindOpponent + lowHandThreatBonus(target, config);
  }
  if (effect === 'gift') {
    return isSelf ? 0 : config.ruleEffects.giftOpponent + lowHandThreatBonus(target, config);
  }
  return 0;
}

function projectedTargets(room, actor, rule) {
  if (rule.target === 'none') {
    return [];
  }
  if (rule.target === 'self') {
    return actor.left || actor.finishedRank ? [] : [actor];
  }
  if (rule.target === 'all') {
    return activePlayers(room);
  }
  if (rule.target === 'next') {
    const targetId = nextActivePlayerId(room, actor.id);
    const target = targetId ? room.players.find((player) => player.id === targetId) : null;
    return target ? [target] : [];
  }
  if (rule.target === 'any') {
    const targetId = chooseCpuTarget(room, {
      effect: rule.effect,
      eligibleTargetIds: activePlayers(room)
        .filter((player) => player.id !== actor.id)
        .map((player) => player.id)
    }, () => 0);
    const target = targetId ? room.players.find((player) => player.id === targetId) : null;
    return target ? [target] : [];
  }
  return [];
}

function extraRemovalFinishScore(player, move, rule, config = CPU_CONFIG.scoring) {
  if (!['gift', 'discard'].includes(rule.effect)) {
    return 0;
  }
  const remainingAfterPlay = player.hand.length - move.play.count;
  const removableCount = Math.max(0, rule.count || 1);
  return remainingAfterPlay > 0 && remainingAfterPlay <= removableCount
    ? config.finishByExtraRemovalBonus
    : 0;
}

function lowHandThreatBonus(target, config = CPU_CONFIG.scoring) {
  const cardCount = target.hand?.length ?? 0;
  return Math.max(0, config.ruleEffects.lowHandThreatBonus - Math.max(0, cardCount - 1) * 4);
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

function normalizeCpuHelpers(helpers) {
  if (typeof helpers === 'function') {
    return { getLegalPlays: helpers, getTriggeredRulesForPlay: null };
  }
  return {
    getLegalPlays: helpers.getLegalPlays,
    getTriggeredRulesForPlay: helpers.getTriggeredRulesForPlay || null
  };
}

function isFinishingMove(move, player) {
  return move.play.count >= player.hand.length;
}

function cpuCanUseHiddenRules(room, config = CPU_CONFIG.scoring) {
  const mode = room.settings?.mode || 'normal';
  return config.ruleKnowledgeByMode?.[mode] === 'all';
}

function activePlayers(room) {
  return room.players.filter((player) => !player.left && !player.finishedRank);
}

function nextActivePlayerId(room, fromPlayerId) {
  const direction = room.game?.direction || 1;
  const startIndex = Math.max(0, room.players.findIndex((player) => player.id === fromPlayerId));
  for (let step = 1; step <= room.players.length; step += 1) {
    const index = (startIndex + step * direction + room.players.length * 10) % room.players.length;
    const player = room.players[index];
    if (player && !player.left && !player.finishedRank) {
      return player.id;
    }
  }
  return activePlayers(room)[0]?.id || null;
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
  scoreTriggeredEffects,
  scoreMove
};
