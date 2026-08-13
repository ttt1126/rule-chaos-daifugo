function registerSocketHandlers(io, manager) {
  function emitRoomState(room) {
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
