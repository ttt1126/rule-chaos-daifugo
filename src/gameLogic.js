const { MATCH_DEFAULTS, MODES, RANKS, RANK_VALUES, ROUND_COUNTS, SUITS } = require('./constants');
const {
  createDeck,
  makeId,
  pickCardsFromHand,
  publicCard,
  removeCardsFromHand,
  shuffle,
  sortHand
} = require('./cardUtils');
const { generateRandomRules } = require('./randomRules');
const {
  describeCondition,
  describeEffect,
  describeRule,
  describeSuit,
  getTriggeredRules,
  normalizeRuleInput,
  orderTriggeredRules,
  ruleSignature
} = require('./ruleEngine');

const MAX_RECENT_EVENTS = 30;

function addEvent(room, text, type = 'info') {
  room.events.push({
    id: makeId('event'),
    text,
    type,
    at: Date.now()
  });
  if (room.events.length > MAX_RECENT_EVENTS) {
    room.events.splice(0, room.events.length - MAX_RECENT_EVENTS);
  }
}

function getPlayer(room, playerId) {
  return room.players.find((player) => player.id === playerId);
}

function requirePlayer(room, playerId) {
  const player = getPlayer(room, playerId);
  if (!player) {
    throw new Error('プレイヤーが見つかりません');
  }
  return player;
}

function activePlayers(room) {
  return room.players.filter((player) => !player.left && !player.finishedRank);
}

function isActive(room, playerId) {
  const player = getPlayer(room, playerId);
  return Boolean(player && !player.left && !player.finishedRank);
}

function nextActivePlayerId(room, fromPlayerId) {
  const active = activePlayers(room);
  if (active.length === 0) return null;

  const direction = room.game.direction;
  const startIndex = Math.max(0, room.players.findIndex((player) => player.id === fromPlayerId));
  for (let step = 1; step <= room.players.length; step += 1) {
    const index = (startIndex + step * direction + room.players.length * 10) % room.players.length;
    const player = room.players[index];
    if (!player.left && !player.finishedRank) {
      return player.id;
    }
  }

  return active[0].id;
}

function firstActiveFrom(room, fromPlayerId) {
  if (isActive(room, fromPlayerId)) {
    return fromPlayerId;
  }
  return nextActivePlayerId(room, fromPlayerId);
}

function requirePlaying(room) {
  if (room.status !== 'playing' || !room.game) {
    throw new Error('ゲーム中ではありません');
  }
  if (room.game.phase !== 'playing') {
    throw new Error('特殊ルールの処理待ちです');
  }
}

function currentTurnPlayer(room) {
  return getPlayer(room, room.game?.currentPlayerId);
}

function isGamePaused(room) {
  if (room.status !== 'playing' || !room.game) return false;

  if (room.game.phase !== 'playing') {
    const actor = getPlayer(room, room.game.pendingAction?.actorId);
    return Boolean(actor && !actor.connected);
  }

  const current = currentTurnPlayer(room);
  return Boolean(current && !current.connected);
}

function normalizeMode(mode) {
  return MODES[mode] ? mode : 'normal';
}

function normalizeHiddenRuleCount(count) {
  const numeric = Number(count);
  return [3, 5, 8, 10].includes(numeric) ? numeric : 5;
}

function normalizeRoundCount(count) {
  const numeric = Number(count);
  return ROUND_COUNTS.includes(numeric) ? numeric : MATCH_DEFAULTS.roundCount;
}

function updateSettings(room, playerId, settings) {
  if (room.hostId !== playerId) {
    throw new Error('ホストのみ設定できます');
  }
  if (room.status !== 'lobby') {
    throw new Error('ゲーム開始後は設定を変更できません');
  }

  room.settings.mode = normalizeMode(settings.mode ?? room.settings.mode);
  room.settings.hiddenRuleCount = normalizeHiddenRuleCount(
    settings.hiddenRuleCount ?? room.settings.hiddenRuleCount
  );
  room.settings.roundCount = normalizeRoundCount(settings.roundCount ?? room.settings.roundCount);
  addEvent(room, 'ゲーム設定を更新しました', 'system');
}

function addRule(room, playerId, input, options = {}) {
  const player = options.system ? null : requirePlayer(room, playerId);
  if (player?.left) {
    throw new Error('退出したプレイヤーはルールを追加できません');
  }
  if (!options.system) {
    if (room.status !== 'ruleBuilding') {
      throw new Error('特殊ルールはラウンド終了後のルール追加フェーズでのみ追加できます');
    }
    if (currentRuleBuilderId(room) !== playerId) {
      throw new Error('現在はあなたのルール追加ターンではありません');
    }
  }

  const normalized = normalizeRuleInput(input);
  const newSignature = ruleSignature(normalized);
  const existing = new Set(room.rules.map((rule) => ruleSignature(rule)));
  if (existing.has(newSignature)) {
    throw new Error('同じ特殊ルールがすでに存在します');
  }

  const rule = {
    ...normalized,
    id: options.id || makeId('rule'),
    order: room.rules.length,
    createdBy: options.system ? 'system' : playerId,
    secret: Boolean(options.secret),
    revealed: !options.secret,
    generated: Boolean(options.generated),
    createdAt: Date.now()
  };
  room.rules.push(rule);

  if (!rule.secret) {
    addEvent(room, `${player?.name || 'システム'}さんが新しいルールを追加しました: ${describeRule(rule)}`, 'rule');
  } else {
    addEvent(room, '隠しルールを追加しました', 'rule');
  }

  if (!options.system) {
    advanceRuleBuilding(room);
  }

  return rule;
}

function startGame(room, playerId, options = {}) {
  if (room.hostId !== playerId) {
    throw new Error('ホストのみゲームを開始できます');
  }
  if (room.status !== 'lobby') {
    throw new Error('ゲームはすでに開始されています');
  }
  const joinedPlayers = room.players.filter((player) => !player.left);
  if (joinedPlayers.length < 2) {
    throw new Error('2人以上で開始してください');
  }
  if (joinedPlayers.length > 4) {
    throw new Error('最大4人までです');
  }

  const mode = normalizeMode(room.settings.mode);
  const hiddenRuleCount = normalizeHiddenRuleCount(room.settings.hiddenRuleCount);
  const roundCount = normalizeRoundCount(room.settings.roundCount);

  if (mode === 'chaos' || mode === 'mystery') {
    const existingSignatures = room.rules.map((rule) => ruleSignature(rule));
    const randomRules = generateRandomRules(hiddenRuleCount, {
      existingSignatures,
      secret: mode === 'mystery',
      startOrder: room.rules.length,
      rng: options.rng || Math.random
    });
    room.rules.push(...randomRules);
  }

  room.match = {
    currentRound: 1,
    totalRounds: roundCount,
    playerIds: joinedPlayers.map((player) => player.id),
    scores: Object.fromEntries(joinedPlayers.map((player) => [player.id, 0])),
    roundResults: [],
    finalResults: null,
    ruleBuilding: null,
    rulesPerPlayerPerRound: MATCH_DEFAULTS.rulesPerPlayerPerRound,
    ruleAddOrder: MATCH_DEFAULTS.ruleAddOrder
  };

  addEvent(room, `${MODES[mode].label}モードで${roundCount}ラウンドのマッチを開始しました`, 'system');
  startRound(room, options);
}

function startRound(room, options = {}) {
  if (!room.match) {
    throw new Error('マッチが開始されていません');
  }

  const roundPlayers = matchPlayers(room).filter((player) => !player.left);
  if (roundPlayers.length < 2) {
    finishMatch(room);
    return;
  }

  const deck = shuffle(createDeck(), options.rng);
  for (const player of room.players) {
    player.hand = [];
    player.finishedRank = null;
    player.skipTurns = 0;
    player.bindingSuit = null;
    player.bindings = [];
  }

  deck.forEach((card, index) => {
    roundPlayers[index % roundPlayers.length].hand.push(card);
  });
  for (const player of roundPlayers) {
    player.hand = sortHand(player.hand);
  }

  room.status = 'playing';
  room.game = {
    direction: 1,
    currentPlayerId: roundPlayers[0].id,
    table: null,
    lastPlayBy: null,
    passes: [],
    rankings: [],
    roundPlayerIds: roundPlayers.map((player) => player.id),
    phase: 'playing',
    pendingAction: null,
    effectQueue: [],
    resolvingActorId: null,
    forceLeadPlayerId: null,
    turnNumber: 1
  };
  room.match.ruleBuilding = null;

  addEvent(room, `第${room.match.currentRound}/${room.match.totalRounds}ラウンドを開始しました`, 'system');
}

function matchPlayers(room) {
  if (!room.match?.playerIds) {
    return room.players.filter((player) => !player.left);
  }
  return room.match.playerIds.map((playerId) => getPlayer(room, playerId)).filter(Boolean);
}

function currentRoundPlayers(room) {
  const ids = room.game?.roundPlayerIds || matchPlayers(room).map((player) => player.id);
  return ids.map((playerId) => getPlayer(room, playerId)).filter(Boolean);
}

function finishRound(room) {
  if (!room.match) {
    return finishLegacyGame(room);
  }

  const roundPlayers = currentRoundPlayers(room);
  const rankedIds = [...room.game.rankings];
  for (const player of roundPlayers) {
    if (!rankedIds.includes(player.id)) {
      player.finishedRank = rankedIds.length + 1;
      rankedIds.push(player.id);
      addEvent(room, `${player.name}さんが${player.finishedRank}位です`, 'finish');
    }
  }
  room.game.rankings = rankedIds;

  const playerCount = roundPlayers.length;
  const rankings = rankedIds.map((playerId, index) => {
    const rank = index + 1;
    const player = getPlayer(room, playerId);
    const points = MATCH_DEFAULTS.pointsByRank(playerCount, rank);
    room.match.scores[playerId] = (room.match.scores[playerId] || 0) + points;
    return {
      playerId,
      name: player?.name || '退出済み',
      rank,
      points
    };
  });

  const result = {
    round: room.match.currentRound,
    rankings,
    scoresAfter: { ...room.match.scores },
    finishedAt: Date.now()
  };
  room.match.roundResults.push(result);

  clearRoundState(room);

  if (room.match.currentRound >= room.match.totalRounds || matchPlayers(room).filter((player) => !player.left).length < 2) {
    finishMatch(room);
    return true;
  }

  room.status = 'roundResult';
  room.game.phase = 'roundResult';
  addEvent(room, `第${result.round}ラウンドが終了しました`, 'system');
  return true;
}

function clearRoundState(room) {
  for (const player of room.players) {
    player.hand = [];
    player.skipTurns = 0;
    player.bindingSuit = null;
    player.bindings = [];
  }

  if (!room.game) return;
  room.game.currentPlayerId = null;
  room.game.table = null;
  room.game.lastPlayBy = null;
  room.game.passes = [];
  room.game.pendingAction = null;
  room.game.effectQueue = [];
  room.game.resolvingActorId = null;
  room.game.forceLeadPlayerId = null;
}

function finishMatch(room) {
  if (!room.match) {
    return finishLegacyGame(room);
  }

  clearRoundState(room);
  room.status = 'matchResult';
  room.game = room.game || { phase: 'matchResult', rankings: [] };
  room.game.phase = 'matchResult';
  room.game.currentPlayerId = null;
  room.match.ruleBuilding = null;
  room.match.finalResults = calculateFinalResults(room);
  addEvent(room, 'マッチが終了しました', 'system');
  return true;
}

function calculateFinalResults(room) {
  const latestFirst = [...room.match.roundResults].reverse();
  return matchPlayers(room)
    .map((player) => ({
      playerId: player.id,
      name: player.name,
      points: room.match.scores[player.id] || 0,
      roundRanks: room.match.roundResults.map((round) => {
        const result = round.rankings.find((entry) => entry.playerId === player.id);
        return result?.rank || null;
      }),
      left: Boolean(player.left)
    }))
    .sort((a, b) => {
      const pointDiff = b.points - a.points;
      if (pointDiff !== 0) return pointDiff;

      for (const round of latestFirst) {
        const aRank = round.rankings.find((entry) => entry.playerId === a.playerId)?.rank || Number.POSITIVE_INFINITY;
        const bRank = round.rankings.find((entry) => entry.playerId === b.playerId)?.rank || Number.POSITIVE_INFINITY;
        if (aRank !== bRank) return aRank - bRank;
      }

      return a.name.localeCompare(b.name, 'ja');
    })
    .map((entry, index) => ({ ...entry, finalRank: index + 1 }));
}

function beginRuleBuilding(room, playerId) {
  if (room.hostId !== playerId) {
    throw new Error('ホストのみ進行できます');
  }
  if (room.status !== 'roundResult') {
    throw new Error('ルール追加フェーズへ進める状態ではありません');
  }
  if (!room.match || room.match.currentRound >= room.match.totalRounds) {
    throw new Error('最終ラウンド後はルール追加フェーズへ進みません');
  }

  const lastResult = room.match.roundResults.at(-1);
  const queue = [...lastResult.rankings]
    .sort((a, b) => b.rank - a.rank)
    .map((entry) => entry.playerId)
    .filter((queuedPlayerId) => {
      const player = getPlayer(room, queuedPlayerId);
      return player && !player.left;
    });

  if (queue.length === 0) {
    startNextRound(room);
    return;
  }

  room.status = 'ruleBuilding';
  room.match.ruleBuilding = {
    afterRound: room.match.currentRound,
    queue,
    currentIndex: 0,
    addedRules: []
  };
  room.game.phase = 'ruleBuilding';
  addEvent(room, 'ルール追加フェーズを開始しました', 'system');
}

function currentRuleBuilderId(room) {
  const ruleBuilding = room.match?.ruleBuilding;
  if (!ruleBuilding) return null;
  return ruleBuilding.queue[ruleBuilding.currentIndex] || null;
}

function advanceRuleBuilding(room) {
  const ruleBuilding = room.match?.ruleBuilding;
  if (!ruleBuilding) {
    return;
  }

  const currentPlayerId = currentRuleBuilderId(room);
  if (currentPlayerId) {
    ruleBuilding.addedRules.push({ playerId: currentPlayerId, at: Date.now() });
  }

  ruleBuilding.currentIndex += 1;
  while (ruleBuilding.currentIndex < ruleBuilding.queue.length) {
    const nextPlayer = getPlayer(room, ruleBuilding.queue[ruleBuilding.currentIndex]);
    if (nextPlayer && !nextPlayer.left) {
      addEvent(room, `${nextPlayer.name}さんのルール追加ターンです`, 'system');
      return;
    }
    ruleBuilding.currentIndex += 1;
  }

  startNextRound(room);
}

function startNextRound(room) {
  if (!room.match) {
    throw new Error('マッチが開始されていません');
  }

  room.match.currentRound += 1;
  startRound(room);
}

function restartMatch(room, playerId) {
  if (room.hostId !== playerId) {
    throw new Error('ホストのみ再戦できます');
  }
  if (room.status !== 'matchResult') {
    throw new Error('マッチ終了後のみ再戦できます');
  }

  for (const player of room.players) {
    if (player.left) continue;
    player.hand = [];
    player.finishedRank = null;
    player.skipTurns = 0;
    player.bindingSuit = null;
    player.bindings = [];
  }

  room.rules = [];
  room.match = null;
  room.game = null;
  room.status = 'lobby';
  addEvent(room, '再戦のためロビーへ戻りました', 'system');
}

function analyzePlay(room, player, cardIds) {
  const cards = pickCardsFromHand(player.hand, cardIds);
  if (cards.length < 1 || cards.length > 4) {
    throw new Error('出せるカードは1〜4枚です');
  }

  const nonJokers = cards.filter((card) => !card.joker);
  const hasJoker = nonJokers.length !== cards.length;
  const printedRanks = [...new Set(nonJokers.map((card) => card.rank))];
  if (printedRanks.length > 1) {
    throw new Error('複数枚出しは同じ数字だけです');
  }

  const table = room.game.table;
  let effectiveRank;
  if (printedRanks.length === 1) {
    effectiveRank = printedRanks[0];
  } else if (table) {
    effectiveRank = RANKS.find((rank) => RANK_VALUES[rank] > table.rankValue);
    if (!effectiveRank) {
      throw new Error('場より強い数字として使えるジョーカー指定がありません');
    }
  } else {
    effectiveRank = '2';
  }

  const rankValue = RANK_VALUES[effectiveRank];
  if (table) {
    if (cards.length !== table.count) {
      throw new Error(`場と同じ${table.count}枚で出してください`);
    }
    if (rankValue <= table.rankValue) {
      throw new Error('場より強い数字を出してください');
    }
  }

  const ruleRanks = new Set(printedRanks);
  if (hasJoker) {
    ruleRanks.add(effectiveRank);
  }

  const ruleSuits = new Set(nonJokers.map((card) => card.suit));
  if (hasJoker) {
    for (const suit of SUITS) {
      ruleSuits.add(suit.id);
    }
  }
  const playedSuits = new Set(nonJokers.map((card) => card.suit));
  const previousSuits = table
    ? new Set(table.ruleSuits || table.cards?.flatMap((card) => (card.joker ? SUITS.map((suit) => suit.id) : [card.suit])) || [])
    : new Set();

  validateBindingsForPlay(player, cards, effectiveRank);

  return {
    cards,
    count: cards.length,
    effectiveRank,
    rankValue,
    hasJoker,
    ruleRanks,
    ruleSuits,
    playedSuits,
    previousRank: table?.rank || null,
    previousSuits,
    playedCardLabels: cards.map((card) => card.id)
  };
}

function cardsContainSuit(cards, suit) {
  return cards.some((card) => card.joker || card.suit === suit);
}

function cardsContainAnySuit(cards, suits) {
  return suits.some((suit) => cardsContainSuit(cards, suit));
}

function nextRank(rank) {
  const index = RANKS.indexOf(rank);
  if (index < 0 || index >= RANKS.length - 1) return null;
  return RANKS[index + 1];
}

function activeBindings(player) {
  if (Array.isArray(player.bindings) && player.bindings.length > 0) {
    return player.bindings;
  }
  if (player.bindingSuit) {
    return [{ type: 'suit', suits: [player.bindingSuit] }];
  }
  return [];
}

function hasActiveBindings(player) {
  return activeBindings(player).length > 0;
}

function validateBindingsForPlay(player, cards, effectiveRank) {
  for (const binding of activeBindings(player)) {
    if (binding.type === 'suit' && !cardsContainAnySuit(cards, binding.suits || [])) {
      throw new Error(`スート縛り: ${bindingSuitsLabel(binding.suits)}を含む手だけ出せます`);
    }
    if ((binding.type === 'rank' || binding.type === 'step') && !(binding.ranks || []).includes(effectiveRank)) {
      throw new Error(`${bindingLabel(binding)}だけ出せます`);
    }
  }
}

function clearBindingsAfterAction(player) {
  player.bindings = [];
  player.bindingSuit = null;
}

function bindingSuitsLabel(suits = []) {
  return suits.map((suit) => describeSuit(suit)).join(' または ') || '指定スートなし';
}

function bindingRanksLabel(ranks = []) {
  return ranks.length > 0 ? ranks.join(' または ') : '出せる数字なし';
}

function bindingLabel(binding) {
  if (binding.type === 'suit') {
    return `スート縛り: ${bindingSuitsLabel(binding.suits)}`;
  }
  if (binding.type === 'rank') {
    return `数字縛り: ${bindingRanksLabel(binding.ranks)}`;
  }
  if (binding.type === 'step') {
    return `階段縛り: ${bindingRanksLabel(binding.ranks)}`;
  }
  return '縛り';
}

function bindingForEffect(effect, play) {
  if (effect === 'bindSuit') {
    const suits = [...play.playedSuits];
    return { type: 'suit', suits: suits.length > 0 ? suits : [SUITS[0].id] };
  }
  if (effect === 'bindRank') {
    return { type: 'rank', ranks: [play.effectiveRank] };
  }
  if (effect === 'bindStep') {
    const rank = nextRank(play.effectiveRank);
    return { type: 'step', ranks: rank ? [rank] : [] };
  }
  return null;
}

function playCards(room, playerId, cardIds) {
  requirePlaying(room);
  if (isGamePaused(room)) {
    throw new Error('切断中プレイヤーの復帰待ちです');
  }
  if (room.game.currentPlayerId !== playerId) {
    throw new Error('あなたのターンではありません');
  }

  const player = requirePlayer(room, playerId);
  if (player.left || player.finishedRank) {
    throw new Error('すでに上がっています');
  }

  const play = analyzePlay(room, player, cardIds);
  player.hand = sortHand(removeCardsFromHand(player.hand, cardIds));
  clearBindingsAfterAction(player);

  room.game.table = {
    cards: play.cards,
    count: play.count,
    rank: play.effectiveRank,
    rankValue: play.rankValue,
    ruleRanks: [...play.ruleRanks],
    ruleSuits: [...play.ruleSuits],
    playedBy: playerId,
    playedAt: Date.now()
  };
  room.game.lastPlayBy = playerId;
  room.game.passes = room.game.passes.filter((id) => id !== playerId);
  room.game.resolvingActorId = playerId;
  room.game.forceLeadPlayerId = null;

  addEvent(
    room,
    `${player.name}さんが${play.cards.map((card) => publicCard(card).label).join(' ')}を出しました`,
    'play'
  );

  const triggeredRules = orderTriggeredRules(getTriggeredRules(room.rules, play));
  for (const rule of triggeredRules) {
    if (rule.secret && !rule.revealed) {
      rule.revealed = true;
      addEvent(room, `隠しルールが発動して公開されました: ${describeRule(rule)}`, 'rule');
    }

    room.game.effectQueue.push({
      id: makeId('effect'),
      ruleId: rule.id,
      actorId: playerId,
      effect: rule.effect,
      target: rule.target,
      condition: rule.condition,
      binding: bindingForEffect(rule.effect, play),
      selectedTargetIds: null
    });
  }

  continueEffectQueue(room);
}

function passTurn(room, playerId) {
  requirePlaying(room);
  if (isGamePaused(room)) {
    throw new Error('切断中プレイヤーの復帰待ちです');
  }
  if (room.game.currentPlayerId !== playerId) {
    throw new Error('あなたのターンではありません');
  }
  const player = requirePlayer(room, playerId);
  if (player.left || player.finishedRank) {
    throw new Error('参加中のプレイヤーではありません');
  }

  if (!room.game.table) {
    if (!hasActiveBindings(player)) {
      throw new Error('場が空のときはカードを出してください');
    }
    clearBindingsAfterAction(player);
    addEvent(room, `${player.name}さんが縛りを解除するためパスしました`, 'pass');
    setCurrentPlayerWithSkips(room, nextActivePlayerId(room, playerId));
    return;
  }

  clearBindingsAfterAction(player);
  room.game.passes = [...new Set([...room.game.passes, playerId])];
  addEvent(room, `${player.name}さんがパスしました`, 'pass');

  if (shouldClearBecauseAllOthersPassed(room)) {
    clearTableAfterPasses(room);
    return;
  }

  setCurrentPlayerWithSkips(room, nextActivePlayerId(room, playerId));
}

function continueEffectQueue(room) {
  const game = room.game;

  while (game.effectQueue.length > 0) {
    const effectAction = game.effectQueue[0];

    if (effectAction.target === 'any' && !effectAction.selectedTargetIds) {
      const eligibleTargets = eligibleAnyTargets(room, effectAction);
      if (eligibleTargets.length === 0) {
        addEvent(room, `${effectLabel(room, effectAction)}: 対象がいないため不発になりました`, 'rule');
        game.effectQueue.shift();
        continue;
      }

      game.phase = 'awaitingTarget';
      game.pendingAction = {
        id: effectAction.id,
        type: 'target',
        actorId: effectAction.actorId,
        ruleId: effectAction.ruleId,
        effect: effectAction.effect,
        eligibleTargetIds: eligibleTargets.map((player) => player.id)
      };
      return;
    }

    const targets = resolveTargets(room, effectAction);
    const result = applyEffect(room, effectAction, targets);
    if (result === 'pending') {
      return;
    }

    game.effectQueue.shift();
  }

  game.phase = 'playing';
  game.pendingAction = null;
  completeResolvedAction(room);
}

function chooseTarget(room, playerId, pendingId, targetPlayerId) {
  if (room.status !== 'playing' || room.game.phase !== 'awaitingTarget') {
    throw new Error('対象選択待ちではありません');
  }

  const pending = room.game.pendingAction;
  if (pending.id !== pendingId || pending.actorId !== playerId) {
    throw new Error('この対象選択は操作できません');
  }
  if (!pending.eligibleTargetIds.includes(targetPlayerId)) {
    throw new Error('選択できない対象です');
  }

  const currentEffect = room.game.effectQueue[0];
  currentEffect.selectedTargetIds = [targetPlayerId];
  room.game.phase = 'playing';
  room.game.pendingAction = null;
  continueEffectQueue(room);
}

function chooseTransferCard(room, playerId, pendingId, cardId) {
  if (room.status !== 'playing' || room.game.phase !== 'awaitingGiftCard') {
    throw new Error('渡すカードの選択待ちではありません');
  }

  const pending = room.game.pendingAction;
  if (pending.id !== pendingId || pending.actorId !== playerId) {
    throw new Error('このカード選択は操作できません');
  }

  const actor = requirePlayer(room, playerId);
  const target = requirePlayer(room, pending.targetPlayerId);
  if (target.finishedRank) {
    throw new Error('上がったプレイヤーにはカードを渡せません');
  }

  const [card] = pickCardsFromHand(actor.hand, [cardId]);
  actor.hand = removeCardsFromHand(actor.hand, [cardId]);
  target.hand = sortHand([...target.hand, card]);

  addEvent(room, `${actor.name}さんが${target.name}さんへカードを1枚渡しました`, 'rule');
  room.game.effectQueue.shift();
  room.game.phase = 'playing';
  room.game.pendingAction = null;
  continueEffectQueue(room);
}

function resolveTargets(room, effectAction) {
  const actor = requirePlayer(room, effectAction.actorId);

  if (effectAction.target === 'none') {
    return [];
  }
  if (effectAction.target === 'self') {
    return actor.finishedRank ? [] : [actor];
  }
  if (effectAction.target === 'all') {
    return activePlayers(room);
  }
  if (effectAction.target === 'next') {
    const targetId = nextActivePlayerId(room, actor.id);
    const target = targetId ? getPlayer(room, targetId) : null;
    return target ? [target] : [];
  }
  if (effectAction.target === 'any') {
    return (effectAction.selectedTargetIds || [])
      .map((targetId) => getPlayer(room, targetId))
      .filter(Boolean)
      .filter((target) => !target.left && !target.finishedRank);
  }

  return [];
}

function eligibleAnyTargets(room, effectAction) {
  return activePlayers(room).filter((player) => {
    if (player.id === effectAction.actorId) {
      return false;
    }
    if (effectAction.effect === 'gift' && player.finishedRank) {
      return false;
    }
    return !player.finishedRank;
  });
}

function applyEffect(room, effectAction, targets) {
  const game = room.game;
  const actor = requirePlayer(room, effectAction.actorId);

  if (effectAction.effect === 'reverse') {
    game.direction *= -1;
    addEvent(room, `${effectLabel(room, effectAction)}: 進行方向が逆転しました`, 'rule');
    return 'done';
  }

  if (effectAction.effect === 'skip') {
    for (const target of targets) {
      target.skipTurns += 1;
    }
    addEvent(
      room,
      `${effectLabel(room, effectAction)}: ${targetNames(targets)}の次の行動機会をスキップします`,
      'rule'
    );
    return 'done';
  }

  if (['bindSuit', 'bindRank', 'bindStep'].includes(effectAction.effect)) {
    const binding = effectAction.binding;
    for (const target of targets) {
      target.bindings = [...activeBindings(target), binding].filter(Boolean);
      target.bindingSuit = target.bindings.find((candidate) => candidate.type === 'suit')?.suits?.[0] || null;
    }
    addEvent(
      room,
      `${effectLabel(room, effectAction)}: ${targetNames(targets)}に${bindingLabel(binding)}をかけました`,
      'rule'
    );
    return 'done';
  }

  if (effectAction.effect === 'clear') {
    game.table = null;
    game.lastPlayBy = null;
    game.passes = [];
    game.forceLeadPlayerId = actor.id;
    addEvent(room, `${effectLabel(room, effectAction)}: 場が流れました`, 'rule');
    return 'done';
  }

  if (effectAction.effect === 'gift') {
    if (targets.length === 0) {
      addEvent(room, `${effectLabel(room, effectAction)}: 対象がいないため不発になりました`, 'rule');
      return 'done';
    }
    if (actor.hand.length === 0) {
      addEvent(room, `${effectLabel(room, effectAction)}: 渡せるカードがないため不発になりました`, 'rule');
      return 'done';
    }

    game.phase = 'awaitingGiftCard';
    game.pendingAction = {
      id: effectAction.id,
      type: 'giftCard',
      actorId: actor.id,
      ruleId: effectAction.ruleId,
      effect: effectAction.effect,
      targetPlayerId: targets[0].id
    };
    addEvent(room, `${actor.name}さんが渡すカードを選択中です`, 'rule');
    return 'pending';
  }

  throw new Error(`未実装の効果です: ${effectAction.effect}`);
}

function effectLabel(room, effectAction) {
  const rule = room.rules.find((candidate) => candidate.id === effectAction.ruleId);
  if (!rule) {
    return describeEffect(effectAction.effect);
  }
  return `${describeCondition(rule.condition)}ルール`;
}

function targetNames(targets) {
  if (targets.length === 0) return '対象者なし';
  return targets.map((target) => `${target.name}さん`).join('、');
}

function completeResolvedAction(room) {
  const game = room.game;
  const actorId = game.resolvingActorId;

  markFinishedPlayers(room);
  if (finishGameIfReady(room)) {
    game.resolvingActorId = null;
    return;
  }

  if (game.forceLeadPlayerId) {
    const leadId = firstActiveFrom(room, game.forceLeadPlayerId);
    game.forceLeadPlayerId = null;
    game.resolvingActorId = null;
    setCurrentPlayerWithSkips(room, leadId);
    return;
  }

  game.resolvingActorId = null;
  setCurrentPlayerWithSkips(room, nextActivePlayerId(room, actorId));
}

function markFinishedPlayers(room) {
  for (const player of room.players) {
    if (!player.left && !player.finishedRank && player.hand.length === 0) {
      player.finishedRank = room.game.rankings.length + 1;
      room.game.rankings.push(player.id);
      addEvent(room, `${player.name}さんが${player.finishedRank}位で上がりました`, 'finish');
    }
  }
}

function finishGameIfReady(room) {
  const remaining = activePlayers(room);
  if (remaining.length > 1) {
    return false;
  }

  if (remaining.length === 1) {
    const last = remaining[0];
    last.finishedRank = room.game.rankings.length + 1;
    room.game.rankings.push(last.id);
    addEvent(room, `${last.name}さんが${last.finishedRank}位です`, 'finish');
  }

  return finishRound(room);
}

function finishLegacyGame(room) {
  room.status = 'finished';
  room.game.currentPlayerId = null;
  room.game.phase = 'finished';
  addEvent(room, 'ゲームが終了しました', 'system');
  return true;
}

function setCurrentPlayerWithSkips(room, candidateId) {
  const game = room.game;
  let nextId = candidateId || firstActiveFrom(room, room.players[0]?.id);
  let guard = 0;

  while (nextId && guard < room.players.length * 3) {
    guard += 1;
    const player = getPlayer(room, nextId);
    if (!player || player.left || player.finishedRank) {
      nextId = nextActivePlayerId(room, nextId);
      continue;
    }

    if (player.skipTurns > 0) {
      player.skipTurns -= 1;
      addEvent(room, `${player.name}さんのターンがスキップされました`, 'rule');
      if (game.table) {
        game.passes = [...new Set([...game.passes, player.id])];
        if (shouldClearBecauseAllOthersPassed(room)) {
          clearTableAfterPasses(room);
          return;
        }
      }
      nextId = nextActivePlayerId(room, player.id);
      continue;
    }

    game.currentPlayerId = player.id;
    game.turnNumber += 1;
    return;
  }

  finishGameIfReady(room);
}

function shouldClearBecauseAllOthersPassed(room) {
  const game = room.game;
  if (!game.table || !game.lastPlayBy) return false;

  const challengers = activePlayers(room).filter((player) => player.id !== game.lastPlayBy);
  if (challengers.length === 0) return true;
  return challengers.every((player) => game.passes.includes(player.id));
}

function clearTableAfterPasses(room) {
  const game = room.game;
  const leaderBaseId = game.lastPlayBy;
  const leader = leaderBaseId ? getPlayer(room, leaderBaseId) : null;
  game.table = null;
  game.lastPlayBy = null;
  game.passes = [];

  addEvent(room, '自分以外の全員がパスしたため、場が流れました', 'system');

  if (finishGameIfReady(room)) {
    return;
  }

  const leadId = leader && !leader.finishedRank ? leader.id : nextActivePlayerId(room, leaderBaseId);
  setCurrentPlayerWithSkips(room, leadId);
}

function directionLabel(room) {
  return room.game?.direction === -1 ? '反時計回り' : '時計回り';
}

function leavePlayer(room, playerId) {
  const player = requirePlayer(room, playerId);
  if (player.left) {
    throw new Error('すでに退出しています');
  }

  if (room.status === 'lobby') {
    const playerName = player.name;
    const wasHost = room.hostId === playerId;
    room.players = room.players.filter((candidate) => candidate.id !== playerId);
    if (wasHost) {
      room.hostId = room.players[0]?.id || null;
    }
    addEvent(room, `${playerName}さんが退出しました`, 'system');
    if (wasHost && room.hostId && room.players.length > 0) {
      const host = getPlayer(room, room.hostId);
      addEvent(room, `${host.name}さんがホストになりました`, 'system');
    }
    return { roomClosed: room.players.length === 0 };
  }

  player.left = true;
  player.connected = false;
  player.disconnectedAt = Date.now();
  player.hand = [];
  player.skipTurns = 0;
  player.bindingSuit = null;
  player.bindings = [];

  if (room.hostId === playerId) {
    const nextHost = room.players.find((candidate) => !candidate.left);
    room.hostId = nextHost?.id || null;
    if (nextHost) {
      addEvent(room, `${nextHost.name}さんがホストになりました`, 'system');
    }
  }

  addEvent(room, `${player.name}さんが退出しました`, room.status === 'playing' ? 'finish' : 'system');

  if (room.status === 'playing') {
    handlePlayingLeave(room, playerId);
  } else if (room.status === 'ruleBuilding') {
    handleRuleBuildingLeave(room, playerId);
  } else if (room.status === 'roundResult') {
    if (matchPlayers(room).filter((candidate) => !candidate.left).length < 2) {
      finishMatch(room);
    }
  }

  return { roomClosed: room.players.every((candidate) => candidate.left) };
}

function handlePlayingLeave(room, playerId) {
  const game = room.game;
  game.passes = game.passes.filter((id) => id !== playerId);

  if (game.pendingAction?.actorId === playerId) {
    game.effectQueue = game.effectQueue.filter((action) => action.actorId !== playerId);
    game.pendingAction = null;
    game.phase = 'playing';
    addEvent(room, '退出により未処理の特殊ルールを取り消しました', 'rule');
    continueEffectQueue(room);
    return;
  }

  if (game.pendingAction?.type === 'target') {
    game.pendingAction.eligibleTargetIds = game.pendingAction.eligibleTargetIds.filter((id) =>
      isActive(room, id)
    );
    if (game.pendingAction.eligibleTargetIds.length === 0) {
      game.effectQueue.shift();
      game.pendingAction = null;
      game.phase = 'playing';
      addEvent(room, '対象がいなくなったため特殊ルールは不発になりました', 'rule');
      continueEffectQueue(room);
      return;
    }
  }

  if (game.pendingAction?.type === 'giftCard' && game.pendingAction.targetPlayerId === playerId) {
    game.effectQueue.shift();
    game.pendingAction = null;
    game.phase = 'playing';
    addEvent(room, '渡す相手が退出したため特殊ルールは不発になりました', 'rule');
    continueEffectQueue(room);
    return;
  }

  if (finishGameIfReady(room)) {
    return;
  }

  if (shouldClearBecauseAllOthersPassed(room)) {
    clearTableAfterPasses(room);
    return;
  }

  if (game.currentPlayerId === playerId) {
    setCurrentPlayerWithSkips(room, nextActivePlayerId(room, playerId));
    return;
  }
}

function handleRuleBuildingLeave(room, playerId) {
  const ruleBuilding = room.match?.ruleBuilding;
  if (!ruleBuilding) return;

  ruleBuilding.queue = ruleBuilding.queue.filter((queuedPlayerId) => queuedPlayerId !== playerId);
  if (ruleBuilding.currentIndex >= ruleBuilding.queue.length) {
    startNextRound(room);
    return;
  }

  const current = getPlayer(room, ruleBuilding.queue[ruleBuilding.currentIndex]);
  if (current) {
    addEvent(room, `${current.name}さんのルール追加ターンです`, 'system');
  }
}

module.exports = {
  addEvent,
  addRule,
  analyzePlay,
  beginRuleBuilding,
  chooseTarget,
  chooseTransferCard,
  directionLabel,
  getPlayer,
  isGamePaused,
  leavePlayer,
  nextActivePlayerId,
  passTurn,
  playCards,
  restartMatch,
  startRound,
  startGame,
  updateSettings
};
