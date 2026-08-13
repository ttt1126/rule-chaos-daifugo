const crypto = require('crypto');
const { MODES, SUIT_SYMBOLS } = require('./constants');
const { makeId, makeReconnectToken, publicCard, sortHand } = require('./cardUtils');
const { calculateConditionPower, describeRule, targetConnector, validTargetsForEffect } = require('./ruleEngine');
const {
  addEvent,
  addRule,
  beginRuleBuilding,
  chooseTarget,
  chooseTransferCard,
  directionLabel,
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
        roundCount: 4
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
    const pendingAction = getViewerPendingAction(room, viewerId);

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
        roundCount: room.settings.roundCount
      },
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        isHost: player.id === room.hostId,
        isYou: player.id === viewerId,
        connected: player.connected,
        left: Boolean(player.left),
        disconnectedAt: player.disconnectedAt,
        disconnectGraceMs: DISCONNECT_GRACE_MS,
        cardCount: player.left ? 0 : player.hand.length,
        hand: player.id === viewerId && !player.left ? sortHand(player.hand).map(publicCard) : null,
        finishedRank: player.finishedRank,
        score: room.match?.scores?.[player.id] || 0,
        roundRanks: room.match?.roundResults?.map((round) => {
          const result = round.rankings.find((entry) => entry.playerId === player.id);
          return result?.rank || null;
        }) || [],
        skipTurns: player.skipTurns,
        bindings: publicBindings(player),
        bindingSuit: player.bindingSuit,
        bindingSuitLabel: player.bindingSuit ? SUIT_SYMBOLS[player.bindingSuit] : null
      })),
      game: room.game
        ? {
            direction: room.game.direction,
            directionLabel: directionLabel(room),
            currentPlayerId: room.game.currentPlayerId,
            currentPlayerName: currentPlayer?.name || null,
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
        condition: rule.secret && !rule.revealed ? null : rule.condition,
        conditionPower: rule.secret && !rule.revealed ? null : calculateConditionPower(rule.condition),
        target: rule.secret && !rule.revealed ? null : rule.target,
        targetConnector: rule.secret && !rule.revealed ? null : targetConnector(rule.target),
        effect: rule.secret && !rule.revealed ? null : rule.effect,
        description: describeRule(rule)
      })),
      recentEvents: [...room.events].slice(-12).reverse(),
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
    chooseTransferCard: (room, playerId, pendingId, cardId) =>
      dispatch(room, () => chooseTransferCard(room, playerId, pendingId, cardId)),
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
    ['skip', 'bindSuit', 'bindRank', 'bindStep', 'reverse', 'clear', 'gift'].map((effect) => [
      effect,
      validTargetsForEffect(effect)
    ])
  );
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
        label: `スート縛り: ${suits.map((suit) => SUIT_SYMBOLS[suit] || suit).join(' / ')}`
      };
    }
    if (binding.type === 'rank') {
      return {
        type: 'rank',
        label: `数字縛り: ${(binding.ranks || []).join(' / ')}`
      };
    }
    if (binding.type === 'step') {
      const ranks = binding.ranks || [];
      return {
        type: 'step',
        label: `階段縛り: ${ranks.length > 0 ? `${ranks.join(' / ')}のみ` : 'パスのみ'}`
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
      targetName: target?.name || null
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
