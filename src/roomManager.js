const crypto = require('crypto');
const {
  BINDING_MODES,
  DEFAULT_BINDING_MODE_BY_MODE,
  LOCAL_RULE_IDS,
  MODES,
  SUIT_SYMBOLS
} = require('./constants');
const { makeId, makeReconnectToken, publicCard, sortHand } = require('./cardUtils');
const { DEFAULT_LOCAL_RULE_SETTINGS, LOCAL_RULES, enabledLocalRules, normalizeLocalRuleSettings } = require('./localRules');
const { calculateConditionPower, describeRule, targetConnector, validTargetsForEffect } = require('./ruleEngine');
const {
  addEvent,
  addRule,
  beginRuleBuilding,
  chooseDiscardCards,
  chooseTarget,
  chooseTransferCard,
  directionLabel,
  endGame,
  getTurnAvailability,
  isGamePaused,
  leavePlayer,
  passTurn,
  playCards,
  restartMatch,
  startGame,
  updateSettings
} = require('./gameLogic');

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 4;
const DISCONNECT_GRACE_MS = 5 * 60 * 1000;

function createRoomManager() {
  const rooms = new Map();

  function createRoom(name) {
    const normalizedName = normalizeName(name);
    const code = makeRoomCode(rooms);
    const player = createPlayer(normalizedName);
    const room = {
      code,
      hostId: player.id,
      status: 'lobby',
      settings: {
        mode: 'normal',
        hiddenRuleCount: 5,
        roundCount: 4,
        bindingMode: DEFAULT_BINDING_MODE_BY_MODE.normal,
        localRules: { ...DEFAULT_LOCAL_RULE_SETTINGS }
      },
      players: [player],
      rules: [],
      events: [],
      game: null,
      match: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    rooms.set(code, room);
    addEvent(room, `${player.name}さんが部屋を作りました`, 'system');
    return { room, player, reconnectToken: player.reconnectToken };
  }

  function joinRoom(code, name) {
    const room = requireRoom(code);
    if (room.status !== 'lobby') {
      throw new Error('開始済みの部屋には新規参加できません');
    }
    if (room.players.length >= MAX_PLAYERS) {
      throw new Error('この部屋は満員です');
    }

    const player = createPlayer(normalizeName(name));
    room.players.push(player);
    touch(room);
    addEvent(room, `${player.name}さんが参加しました`, 'system');
    return { room, player, reconnectToken: player.reconnectToken };
  }

  function reconnect(code, playerId, reconnectToken) {
    const room = requireRoom(code);
    const player = room.players.find((candidate) => candidate.id === playerId);
    if (!player || player.reconnectToken !== reconnectToken) {
      throw new Error('再接続情報が一致しません');
    }
    if (player.left) {
      throw new Error('退出済みのプレイヤーには再接続できません');
    }

    player.connected = true;
    player.disconnectedAt = null;
    touch(room);
    addEvent(room, `${player.name}さんが再接続しました`, 'system');
    return { room, player, reconnectToken: player.reconnectToken };
  }

  function attachSocket(room, player, socketId) {
    player.socketIds.add(socketId);
    player.connected = true;
    player.disconnectedAt = null;
    touch(room);
  }

  function detachSocket(socketId) {
    for (const room of rooms.values()) {
      for (const player of room.players) {
        if (!player.socketIds.has(socketId)) continue;

        player.socketIds.delete(socketId);
        if (player.left) {
          touch(room);
          return room;
        }
        if (player.socketIds.size === 0) {
          player.connected = false;
          player.disconnectedAt = Date.now();
          addEvent(room, `${player.name}さんが切断しました。再接続を待っています`, 'system');
        }
        touch(room);
        return room;
      }
    }
    return null;
  }

  function getPublicState(room, viewerId) {
    const currentPlayer = room.game?.currentPlayerId
      ? room.players.find((player) => player.id === room.game.currentPlayerId)
      : null;
    const roundLeader = room.game?.roundLeaderId
      ? room.players.find((player) => player.id === room.game.roundLeaderId)
      : null;
    const pendingAction = getViewerPendingAction(room, viewerId);
    const viewer = room.players.find((player) => player.id === viewerId);
    const canSpectateHands = Boolean(viewer?.finishedRank || room.status === 'matchResult' || room.status === 'finished');

    return {
      code: room.code,
      status: room.status,
      hostId: room.hostId,
      viewerId,
      isHost: room.hostId === viewerId,
      settings: {
        mode: room.settings.mode,
        modeLabel: MODES[room.settings.mode]?.label || room.settings.mode,
        hiddenRuleCount: room.settings.hiddenRuleCount,
        roundCount: room.settings.roundCount,
        bindingMode: room.settings.bindingMode || DEFAULT_BINDING_MODE_BY_MODE[room.settings.mode] || 'standard',
        bindingModeLabel:
          BINDING_MODES[room.settings.bindingMode || DEFAULT_BINDING_MODE_BY_MODE[room.settings.mode] || 'standard']
            ?.label || '標準',
        localRules: normalizeLocalRuleSettings(room.settings.localRules)
      },
      players: room.players.map((player) => {
        const turnAvailability = room.game?.currentPlayerId === player.id
          ? getTurnAvailability(room, player.id)
          : null;
        return {
          id: player.id,
          name: player.name,
          isHost: player.id === room.hostId,
          isYou: player.id === viewerId,
          connected: player.connected,
          left: Boolean(player.left),
          disconnectedAt: player.disconnectedAt,
          disconnectGraceMs: DISCONNECT_GRACE_MS,
          cardCount: player.left ? 0 : player.hand.length,
          hand:
            !player.left && (player.id === viewerId || canSpectateHands)
              ? sortHand(player.hand).map(publicCard)
              : null,
          finishedRank: player.finishedRank,
          isRoundLeader: room.game?.roundLeaderId === player.id,
          score: room.match?.scores?.[player.id] || 0,
          roundRanks: room.match?.roundResults?.map((round) => {
            const result = round.rankings.find((entry) => entry.playerId === player.id);
            return result?.rank || null;
          }) || [],
          skipTurns: player.skipTurns,
          bindings: publicBindings(player),
          bindingSuit: player.bindingSuit,
          bindingSuitLabel: player.bindingSuit ? SUIT_SYMBOLS[player.bindingSuit] : null,
          actionBlocked: Boolean(turnAvailability?.noLegalPlay),
          actionStatusText: turnAvailability?.noLegalPlay ? turnAvailability.passReason || '出せるカードがありません' : ''
        };
      }),
      game: room.game
        ? {
            direction: room.game.direction,
            directionLabel: directionLabel(room),
            currentPlayerId: room.game.currentPlayerId,
            currentPlayerName: currentPlayer?.name || null,
            roundLeaderId: room.game.roundLeaderId || null,
            roundLeaderName: roundLeader?.name || null,
            isYourTurn: room.game.currentPlayerId === viewerId,
            table: room.game.table
              ? {
                  count: room.game.table.count,
                  rank: room.game.table.rank,
                  cards: room.game.table.cards.map(publicCard),
                  playedBy: room.game.table.playedBy,
                  playedByName:
                    room.players.find((player) => player.id === room.game.table.playedBy)?.name || null
                }
              : null,
            passes: room.game.passes,
            rankings: room.game.rankings,
            phase: room.game.phase,
            paused: isGamePaused(room),
            pendingAction,
            turnAvailability: getTurnAvailability(room, viewerId)
          }
        : null,
      match: getPublicMatchState(room, viewerId),
      rules: room.rules.map((rule) => ({
        id: rule.id,
        hidden: rule.secret && !rule.revealed,
        revealed: rule.revealed,
        generated: rule.generated,
        createdBy: rule.createdBy,
        createdByName: rule.createdByName || room.players.find((player) => player.id === rule.createdBy)?.name || null,
        createdRound: rule.createdRound || null,
        createdPhase: rule.createdPhase || null,
        createdAfterRound: rule.createdAfterRound || null,
        condition: rule.secret && !rule.revealed ? null : rule.condition,
        conditionPower: rule.secret && !rule.revealed ? null : calculateConditionPower(rule.condition),
        target: rule.secret && !rule.revealed ? null : rule.target,
        targetConnector: rule.secret && !rule.revealed ? null : targetConnector(rule.target),
        effect: rule.secret && !rule.revealed ? null : rule.effect,
        effectConfig: rule.secret && !rule.revealed ? null : rule.effectConfig || {},
        description: describeRule(rule)
      })),
      localRules: enabledLocalRules(room.settings.localRules).map((rule) => ({
        id: rule.ruleId,
        localRuleId: rule.id,
        label: rule.label,
        description: rule.description,
        condition: rule.condition,
        target: rule.target,
        effect: rule.effect,
        effectConfig: {},
        count: rule.count || 1
      })),
      localRuleOptions: LOCAL_RULE_IDS.map((id) => ({
        id,
        label: LOCAL_RULES[id].label,
        description: LOCAL_RULES[id].description
      })),
      recentEvents: [...room.events].slice(-5).reverse().map(publicEvent),
      eventHistory: [...room.events].map(publicEvent),
      targetOptions: Object.fromEntries(
        Object.entries(validTargetsByEffect()).map(([effect, targets]) => [effect, targets])
      )
    };
  }

  function dispatch(room, fn) {
    const result = fn();
    touch(room);
    return result;
  }

  return {
    rooms,
    createRoom,
    joinRoom,
    reconnect,
    attachSocket,
    detachSocket,
    getPublicState,
    requireRoom,
    addRule: (room, playerId, input) => dispatch(room, () => addRule(room, playerId, input)),
    beginRuleBuilding: (room, playerId) => dispatch(room, () => beginRuleBuilding(room, playerId)),
    chooseTarget: (room, playerId, pendingId, targetPlayerId) =>
      dispatch(room, () => chooseTarget(room, playerId, pendingId, targetPlayerId)),
    chooseTransferCard: (room, playerId, pendingId, cardIds) =>
      dispatch(room, () => chooseTransferCard(room, playerId, pendingId, cardIds)),
    chooseDiscardCards: (room, playerId, pendingId, cardIds) =>
      dispatch(room, () => chooseDiscardCards(room, playerId, pendingId, cardIds)),
    endGame: (room, playerId) => dispatch(room, () => endGame(room, playerId)),
    leaveRoom: (room, playerId) => {
      const player = room.players.find((candidate) => candidate.id === playerId);
      if (!player) {
        throw new Error('プレイヤーが見つかりません');
      }
      const leftSocketIds = [...player.socketIds];
      const result = dispatch(room, () => leavePlayer(room, playerId));
      player.socketIds.clear();
      if (result.roomClosed) {
        rooms.delete(room.code);
      }
      return { ...result, leftSocketIds };
    },
    passTurn: (room, playerId) => dispatch(room, () => passTurn(room, playerId)),
    playCards: (room, playerId, cardIds) => dispatch(room, () => playCards(room, playerId, cardIds)),
    restartMatch: (room, playerId) => dispatch(room, () => restartMatch(room, playerId)),
    startGame: (room, playerId) => dispatch(room, () => startGame(room, playerId)),
    updateSettings: (room, playerId, settings) =>
      dispatch(room, () => updateSettings(room, playerId, settings))
  };

  function requireRoom(code) {
    const normalizedCode = String(code || '').trim().toUpperCase();
    const room = rooms.get(normalizedCode);
    if (!room) {
      throw new Error('部屋が見つかりません');
    }
    return room;
  }
}

function validTargetsByEffect() {
  return Object.fromEntries(
    ['skip', 'bindSuit', 'bindRank', 'reverse', 'clear', 'gift'].map((effect) => [
      effect,
      validTargetsForEffect(effect)
    ])
  );
}

function publicEvent(event) {
  return {
    id: event.id,
    text: event.text,
    type: event.type || 'info',
    at: event.at,
    round: event.round ?? null,
    phase: event.phase || null,
    playerId: event.playerId || null,
    metadata: event.metadata || {}
  };
}

function publicBindings(player) {
  const bindings = Array.isArray(player.bindings) && player.bindings.length > 0
    ? player.bindings
    : player.bindingSuit
      ? [{ type: 'suit', suits: [player.bindingSuit] }]
      : [];

  return bindings.map((binding) => {
    if (binding.type === 'suit') {
      const suits = binding.suits || [];
      return {
        type: 'suit',
        suits,
        label: `スート縛り: ${suits.map((suit) => SUIT_SYMBOLS[suit] || suit).join(' / ')}`
      };
    }
    if (binding.type === 'rank') {
      const ranks = binding.ranks || [];
      return {
        type: 'rank',
        ranks,
        label: `数字縛り: ${ranks.join(' / ')}`
      };
    }
    if (binding.type === 'step') {
      const ranks = binding.ranks || [];
      return {
        type: 'step',
        ranks,
        label: `数字縛り: ${ranks.length > 0 ? `${ranks.join(' / ')}のみ` : 'パスのみ'}`
      };
    }
    return { type: binding.type || 'unknown', label: '縛り' };
  });
}

function getPublicMatchState(room, viewerId) {
  if (!room.match) return null;

  const currentBuilderId = room.match.ruleBuilding
    ? room.match.ruleBuilding.queue[room.match.ruleBuilding.currentIndex] || null
    : null;
  const currentBuilder = currentBuilderId
    ? room.players.find((player) => player.id === currentBuilderId)
    : null;

  return {
    currentRound: room.match.currentRound,
    totalRounds: room.match.totalRounds,
    scores: { ...room.match.scores },
    roundResults: room.match.roundResults,
    latestRoundResult: room.match.roundResults.at(-1) || null,
    finalResults: room.match.finalResults,
    ruleBuilding: room.match.ruleBuilding
      ? {
          afterRound: room.match.ruleBuilding.afterRound,
          queue: room.match.ruleBuilding.queue,
          currentIndex: room.match.ruleBuilding.currentIndex,
          currentPlayerId: currentBuilderId,
          currentPlayerName: currentBuilder?.name || null,
          isYourTurn: currentBuilderId === viewerId,
          remainingCount: Math.max(0, room.match.ruleBuilding.queue.length - room.match.ruleBuilding.currentIndex)
        }
      : null
  };
}

function getViewerPendingAction(room, viewerId) {
  const pending = room.game?.pendingAction;
  if (!pending) return null;

  const actor = room.players.find((player) => player.id === pending.actorId);
  const base = {
    id: pending.id,
    type: pending.type,
    actorId: pending.actorId,
    actorName: actor?.name || null,
    effect: pending.effect
  };

  if (pending.actorId !== viewerId) {
    return {
      ...base,
      waitingForYou: false
    };
  }

  if (pending.type === 'target') {
    return {
      ...base,
      waitingForYou: true,
      eligibleTargets: pending.eligibleTargetIds.map((targetId) => {
        const target = room.players.find((player) => player.id === targetId);
        if (!target) return null;
        return {
          id: target.id,
          name: target.name,
          cardCount: target.hand.length
        };
      }).filter(Boolean)
    };
  }

  if (pending.type === 'giftCard') {
    const target = room.players.find((player) => player.id === pending.targetPlayerId);
    return {
      ...base,
      waitingForYou: true,
      targetPlayerId: pending.targetPlayerId,
      targetName: target?.name || null,
      requiredCount: pending.requiredCount || 1
    };
  }

  if (pending.type === 'discardCard') {
    return {
      ...base,
      waitingForYou: true,
      requiredCount: pending.requiredCount || 1
    };
  }

  return base;
}

function normalizeName(name) {
  const normalized = String(name || '').trim().replace(/\s+/g, ' ');
  if (normalized.length < 1) {
    throw new Error('名前を入力してください');
  }
  return normalized.slice(0, 16);
}

function createPlayer(name) {
  return {
    id: makeId('player'),
    name,
    reconnectToken: makeReconnectToken(),
    connected: true,
    left: false,
    disconnectedAt: null,
    socketIds: new Set(),
    hand: [],
    finishedRank: null,
    skipTurns: 0,
    bindingSuit: null,
    bindings: []
  };
}

function makeRoomCode(rooms) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const bytes = crypto.randomBytes(5);
    let code = '';
    for (let index = 0; index < 5; index += 1) {
      code += ROOM_CODE_ALPHABET[bytes[index] % ROOM_CODE_ALPHABET.length];
    }
    if (!rooms.has(code)) {
      return code;
    }
  }
  throw new Error('部屋コードを生成できませんでした');
}

function touch(room) {
  room.updatedAt = Date.now();
}

module.exports = {
  createRoomManager
};
