const { CPU_SPEEDS, DEFAULT_CPU_SPEED } = require('./constants');
const {
  addEvent,
  getLegalPlays
} = require('./gameLogic');
const {
  chooseCpuCardsToGive,
  chooseCpuDiscard,
  chooseCpuPlay,
  chooseCpuRule,
  chooseCpuTarget
} = require('./cpuLogic');

function registerSocketHandlers(io, manager) {
  const cpuTimers = new Map();

  function emitRoomState(room) {
    for (const player of room.players) {
      for (const socketId of player.socketIds) {
        io.to(socketId).emit('state', manager.getPublicState(room, player.id));
      }
    }
    scheduleCpuAction(room);
  }

  function emitRoomStateOnly(room) {
    for (const player of room.players) {
      for (const socketId of player.socketIds) {
        io.to(socketId).emit('state', manager.getPublicState(room, player.id));
      }
    }
  }

  function bindSocketToPlayer(socket, room, player) {
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    manager.attachSocket(room, player, socket.id);
  }

  function requireSocketRoom(socket, payload) {
    const roomCode = payload?.roomCode || socket.data.roomCode;
    const playerId = payload?.playerId || socket.data.playerId;
    if (!roomCode || !playerId || roomCode !== socket.data.roomCode || playerId !== socket.data.playerId) {
      throw new Error('操作権限を確認できません');
    }
    const room = manager.requireRoom(roomCode);
    return { room, playerId };
  }

  function handle(socket, ack, fn) {
    try {
      const result = fn();
      if (typeof ack === 'function') {
        ack({ ok: true, ...result });
      }
    } catch (error) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: error.message });
      } else {
        socket.emit('errorMessage', error.message);
      }
    }
  }

  function scheduleCpuAction(room) {
    const task = getCpuTask(room);
    if (!task) {
      clearCpuThinking(room);
      return;
    }
    if (cpuTimers.has(room.code)) {
      return;
    }

    const delayMs = cpuDelayMs(room);
    room.cpuThinking = {
      playerId: task.player.id,
      playerName: task.player.name,
      action: task.type,
      untilAt: Date.now() + delayMs
    };
    emitRoomStateOnly(room);

    const timer = setTimeout(() => {
      cpuTimers.delete(room.code);
      try {
        executeCpuTask(room);
      } catch (error) {
        addEvent(room, `CPU操作に失敗しました: ${error.message}`, 'system');
      } finally {
        room.cpuThinking = null;
        emitRoomState(room);
      }
    }, delayMs);
    cpuTimers.set(room.code, timer);
  }

  function clearCpuThinking(room) {
    if (!room.cpuThinking) {
      return;
    }
    room.cpuThinking = null;
    emitRoomStateOnly(room);
  }

  function clearCpuTimer(room) {
    const timer = cpuTimers.get(room.code);
    if (!timer) return;
    clearTimeout(timer);
    cpuTimers.delete(room.code);
    room.cpuThinking = null;
  }

  function getCpuTask(room) {
    if (!room || room.status === 'lobby' || room.status === 'roundResult' || room.status === 'matchResult') {
      return null;
    }

    if (room.status === 'ruleBuilding') {
      const ruleBuilding = room.match?.ruleBuilding;
      const playerId = ruleBuilding?.queue?.[ruleBuilding.currentIndex];
      const player = room.players.find((candidate) => candidate.id === playerId);
      return player?.isCPU && !player.left ? { type: 'ruleBuilding', player } : null;
    }

    if (room.status !== 'playing' || !room.game) {
      return null;
    }

    const pending = room.game.pendingAction;
    if (pending) {
      const actor = room.players.find((player) => player.id === pending.actorId);
      return actor?.isCPU && !actor.left && !actor.finishedRank
        ? { type: pending.type, player: actor, pendingId: pending.id }
        : null;
    }

    if (room.game.phase !== 'playing') {
      return null;
    }

    const player = room.players.find((candidate) => candidate.id === room.game.currentPlayerId);
    return player?.isCPU && !player.left && !player.finishedRank ? { type: 'turn', player } : null;
  }

  function executeCpuTask(room) {
    const task = getCpuTask(room);
    if (!task) {
      return;
    }

    if (task.type === 'turn') {
      const move = chooseCpuPlay(room, task.player, getLegalPlays);
      if (!move) {
        manager.passTurn(room, task.player.id);
        return;
      }
      manager.playCards(room, task.player.id, move.cardIds);
      return;
    }

    if (task.type === 'target') {
      const pending = room.game.pendingAction;
      const targetPlayerId = chooseCpuTarget(room, pending);
      if (!targetPlayerId) {
        throw new Error('CPUが選べる対象がありません');
      }
      manager.chooseTarget(room, task.player.id, pending.id, targetPlayerId);
      return;
    }

    if (task.type === 'giftCard') {
      const pending = room.game.pendingAction;
      const cardIds = chooseCpuCardsToGive(task.player, pending.requiredCount || 1);
      manager.chooseTransferCard(room, task.player.id, pending.id, cardIds);
      return;
    }

    if (task.type === 'discardCard') {
      const pending = room.game.pendingAction;
      const cardIds = chooseCpuDiscard(task.player, pending.requiredCount || 1);
      manager.chooseDiscardCards(room, task.player.id, pending.id, cardIds);
      return;
    }

    if (task.type === 'ruleBuilding') {
      const rule = chooseCpuRule(room, task.player);
      if (!rule) {
        throw new Error('CPUが追加できるルールを生成できませんでした');
      }
      manager.addRule(room, task.player.id, rule, { generated: true });
    }
  }

  function cpuDelayMs(room) {
    const speed = CPU_SPEEDS[room.settings?.cpuSpeed] || CPU_SPEEDS[DEFAULT_CPU_SPEED];
    const span = Math.max(0, speed.maxMs - speed.minMs);
    return Math.round(speed.minMs + Math.random() * span);
  }

  io.on('connection', (socket) => {
    socket.on('createRoom', (payload, ack) => {
      handle(socket, ack, () => {
        const { room, player, reconnectToken } = manager.createRoom(payload?.name);
        bindSocketToPlayer(socket, room, player);
        emitRoomState(room);
        return {
          roomCode: room.code,
          playerId: player.id,
          reconnectToken
        };
      });
    });

    socket.on('joinRoom', (payload, ack) => {
      handle(socket, ack, () => {
        const { room, player, reconnectToken } = manager.joinRoom(payload?.roomCode, payload?.name);
        bindSocketToPlayer(socket, room, player);
        emitRoomState(room);
        return {
          roomCode: room.code,
          playerId: player.id,
          reconnectToken
        };
      });
    });

    socket.on('reconnectRoom', (payload, ack) => {
      handle(socket, ack, () => {
        const { room, player, reconnectToken } = manager.reconnect(
          payload?.roomCode,
          payload?.playerId,
          payload?.reconnectToken
        );
        bindSocketToPlayer(socket, room, player);
        emitRoomState(room);
        return {
          roomCode: room.code,
          playerId: player.id,
          reconnectToken
        };
      });
    });

    socket.on('updateSettings', (payload, ack) => {
      handle(socket, ack, () => {
        const { room, playerId } = requireSocketRoom(socket, payload);
        manager.updateSettings(room, playerId, payload?.settings || {});
        emitRoomState(room);
        return {};
      });
    });

    socket.on('addCpuPlayer', (payload, ack) => {
      handle(socket, ack, () => {
        const { room, playerId } = requireSocketRoom(socket, payload);
        manager.addCpuPlayer(room, playerId);
        emitRoomState(room);
        return {};
      });
    });

    socket.on('removeCpuPlayer', (payload, ack) => {
      handle(socket, ack, () => {
        const { room, playerId } = requireSocketRoom(socket, payload);
        manager.removeCpuPlayer(room, playerId, payload?.cpuPlayerId);
        emitRoomState(room);
        return {};
      });
    });

    socket.on('addRule', (payload, ack) => {
      handle(socket, ack, () => {
        const { room, playerId } = requireSocketRoom(socket, payload);
        manager.addRule(room, playerId, payload?.rule || {});
        emitRoomState(room);
        return {};
      });
    });

    socket.on('startGame', (payload, ack) => {
      handle(socket, ack, () => {
        const { room, playerId } = requireSocketRoom(socket, payload);
        manager.startGame(room, playerId);
        emitRoomState(room);
        return {};
      });
    });

    socket.on('beginRuleBuilding', (payload, ack) => {
      handle(socket, ack, () => {
        const { room, playerId } = requireSocketRoom(socket, payload);
        manager.beginRuleBuilding(room, playerId);
        emitRoomState(room);
        return {};
      });
    });

    socket.on('restartMatch', (payload, ack) => {
      handle(socket, ack, () => {
        const { room, playerId } = requireSocketRoom(socket, payload);
        manager.restartMatch(room, playerId);
        emitRoomState(room);
        return {};
      });
    });

    socket.on('endGame', (payload, ack) => {
      handle(socket, ack, () => {
        const { room, playerId } = requireSocketRoom(socket, payload);
        manager.endGame(room, playerId);
        emitRoomState(room);
        return {};
      });
    });

    socket.on('playCards', (payload, ack) => {
      handle(socket, ack, () => {
        const { room, playerId } = requireSocketRoom(socket, payload);
        manager.playCards(room, playerId, payload?.cardIds || []);
        emitRoomState(room);
        return {};
      });
    });

    socket.on('passTurn', (payload, ack) => {
      handle(socket, ack, () => {
        const { room, playerId } = requireSocketRoom(socket, payload);
        manager.passTurn(room, playerId);
        emitRoomState(room);
        return {};
      });
    });

    socket.on('chooseTarget', (payload, ack) => {
      handle(socket, ack, () => {
        const { room, playerId } = requireSocketRoom(socket, payload);
        manager.chooseTarget(room, playerId, payload?.pendingId, payload?.targetPlayerId);
        emitRoomState(room);
        return {};
      });
    });

    socket.on('chooseTransferCard', (payload, ack) => {
      handle(socket, ack, () => {
        const { room, playerId } = requireSocketRoom(socket, payload);
        manager.chooseTransferCard(room, playerId, payload?.pendingId, payload?.cardIds || payload?.cardId);
        emitRoomState(room);
        return {};
      });
    });

    socket.on('chooseDiscardCards', (payload, ack) => {
      handle(socket, ack, () => {
        const { room, playerId } = requireSocketRoom(socket, payload);
        manager.chooseDiscardCards(room, playerId, payload?.pendingId, payload?.cardIds || payload?.cardId);
        emitRoomState(room);
        return {};
      });
    });

    socket.on('leaveRoom', (payload, ack) => {
      try {
        const { room, playerId } = requireSocketRoom(socket, payload);
        const result = manager.leaveRoom(room, playerId);
        for (const socketId of result.leftSocketIds) {
          const leavingSocket = io.sockets.sockets.get(socketId);
          if (!leavingSocket) continue;

          leavingSocket.leave(room.code);
          leavingSocket.data.roomCode = null;
          leavingSocket.data.playerId = null;
          leavingSocket.emit('leftRoom');
        }
        if (!result.roomClosed) {
          emitRoomState(room);
        } else {
          clearCpuTimer(room);
        }
        if (typeof ack === 'function') {
          ack({ ok: true, left: true });
        }
      } catch (error) {
        if (typeof ack === 'function') {
          ack({ ok: false, error: error.message });
        } else {
          socket.emit('errorMessage', error.message);
        }
      }
    });

    socket.on('disconnect', () => {
      const room = manager.detachSocket(socket.id);
      if (room) {
        emitRoomState(room);
      }
    });
  });
}

module.exports = {
  registerSocketHandlers
};
