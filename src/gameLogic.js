const { MODES, RANKS, RANK_VALUES, SUITS } = require('./constants');
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
  return room.players.filter((player) => !player.finishedRank);
}

function isActive(room, playerId) {
  const player = getPlayer(room, playerId);
  return Boolean(player && !player.finishedRank);
}

function nextActivePlayerId(room, fromPlayerId) {
  const active = activePlayers(room);
  if (active.length === 0) return null;

  const direction = room.game.direction;
  const startIndex = Math.max(0, room.players.findIndex((player) => player.id === fromPlayerId));
  for (let step = 1; step <= room.players.length; step += 1) {
    const index = (startIndex + step * direction + room.players.length * 10) % room.players.length;
    const player = room.players[index];
    if (!player.finishedRank) {
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
  addEvent(room, 'ゲーム設定を更新しました', 'system');
}

function addRule(room, playerId, input, options = {}) {
  if (!options.system && room.hostId !== playerId) {
    throw new Error('ホストのみルールを追加できます');
  }
  if (room.status === 'finished') {
    throw new Error('終了したゲームにはルールを追加できません');
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
    addEvent(room, `特殊ルール追加: ${describeRule(rule)}`, 'rule');
  } else {
    addEvent(room, '隠しルールを追加しました', 'rule');
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
  if (room.players.length < 2) {
    throw new Error('2人以上で開始してください');
  }
  if (room.players.length > 4) {
    throw new Error('最大4人までです');
  }

  const mode = normalizeMode(room.settings.mode);
  const hiddenRuleCount = normalizeHiddenRuleCount(room.settings.hiddenRuleCount);
  const deck = shuffle(createDeck(), options.rng);

  for (const player of room.players) {
    player.hand = [];
    player.finishedRank = null;
    player.skipTurns = 0;
    player.bindingSuit = null;
  }

  deck.forEach((card, index) => {
    room.players[index % room.players.length].hand.push(card);
  });
  for (const player of room.players) {
    player.hand = sortHand(player.hand);
  }

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

  room.status = 'playing';
  room.game = {
    direction: 1,
    currentPlayerId: room.players[0].id,
    table: null,
    lastPlayBy: null,
    passes: [],
    rankings: [],
    phase: 'playing',
    pendingAction: null,
    effectQueue: [],
    resolvingActorId: null,
    forceLeadPlayerId: null,
    turnNumber: 1
  };

  addEvent(room, `${MODES[mode].label}モードでゲームを開始しました`, 'system');
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

  if (player.bindingSuit && !cardsContainSuit(cards, player.bindingSuit)) {
    throw new Error(`${describeSuit(player.bindingSuit)}を含む手だけ出せます`);
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

  return {
    cards,
    count: cards.length,
    effectiveRank,
    rankValue,
    hasJoker,
    ruleRanks,
    ruleSuits,
    playedCardLabels: cards.map((card) => card.id)
  };
}

function cardsContainSuit(cards, suit) {
  return cards.some((card) => card.joker || card.suit === suit);
}

function clearBindingAfterSuccessfulPlay(player) {
  if (player.bindingSuit) {
    player.bindingSuit = null;
  }
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
  if (player.finishedRank) {
    throw new Error('すでに上がっています');
  }

  const play = analyzePlay(room, player, cardIds);
  player.hand = sortHand(removeCardsFromHand(player.hand, cardIds));
  clearBindingAfterSuccessfulPlay(player);

  room.game.table = {
    cards: play.cards,
    count: play.count,
    rank: play.effectiveRank,
    rankValue: play.rankValue,
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
      requiredSuit: rule.effect === 'bindSuit' ? rule.condition.suit : null,
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
  if (!room.game.table) {
    throw new Error('場が空のときはカードを出してください');
  }

  const player = requirePlayer(room, playerId);
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
      .filter((target) => !target.finishedRank);
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

  if (effectAction.effect === 'bindSuit') {
    for (const target of targets) {
      target.bindingSuit = effectAction.requiredSuit;
    }
    addEvent(
      room,
      `${effectLabel(room, effectAction)}: ${targetNames(targets)}は次回プレイで${describeSuit(
        effectAction.requiredSuit
      )}が必要です`,
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
    if (!player.finishedRank && player.hand.length === 0) {
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
    if (!player || player.finishedRank) {
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

module.exports = {
  addEvent,
  addRule,
  analyzePlay,
  chooseTarget,
  chooseTransferCard,
  directionLabel,
  getPlayer,
  isGamePaused,
  nextActivePlayerId,
  passTurn,
  playCards,
  startGame,
  updateSettings
};
