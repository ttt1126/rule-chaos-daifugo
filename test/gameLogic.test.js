const test = require('node:test');
const assert = require('node:assert/strict');

const { addRule, chooseTarget, chooseTransferCard, leavePlayer, passTurn, playCards } = require('../src/gameLogic');
const {
  calculateConditionPower,
  conditionUnlocksTarget,
  effectSupportsTarget,
  normalizeRuleInput
} = require('../src/ruleEngine');

function card(id, rank, suit) {
  return { id, rank, suit, joker: false };
}

function joker(id = 'JK-1') {
  return { id, rank: 'JOKER', suit: null, joker: true };
}

function makeRoom(hands) {
  const players = Object.entries(hands).map(([id, hand], index) => ({
    id,
    name: `P${index + 1}`,
    connected: true,
    disconnectedAt: null,
    socketIds: new Set(),
    hand,
    finishedRank: null,
    skipTurns: 0,
    bindingSuit: null
  }));

  return {
    code: 'TEST1',
    hostId: players[0].id,
    status: 'playing',
    settings: { mode: 'normal', hiddenRuleCount: 5 },
    players,
    rules: [],
    events: [],
    game: {
      direction: 1,
      currentPlayerId: players[0].id,
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
    }
  };
}

test('conditionPowerは条件から計算され、最大4で止まる', () => {
  assert.equal(calculateConditionPower({ count: 1 }), 1);
  assert.equal(calculateConditionPower({ count: 2 }), 2);
  assert.equal(calculateConditionPower({ count: 3 }), 3);
  assert.equal(calculateConditionPower({ count: 4 }), 4);
  assert.equal(calculateConditionPower({ rank: '7' }), 2);
  assert.equal(calculateConditionPower({ suit: 'S' }), 2);
  assert.equal(calculateConditionPower({ rank: 'JOKER' }), 3);
  assert.equal(calculateConditionPower({ rank: '7', suit: 'S', count: 1 }), 4);
});

test('conditionPowerに応じて対象コネクタが解放される', () => {
  assert.equal(conditionUnlocksTarget({ count: 1 }, 'self'), true);
  assert.equal(conditionUnlocksTarget({ count: 1 }, 'next'), false);
  assert.equal(conditionUnlocksTarget({ count: 2 }, 'next'), true);
  assert.equal(conditionUnlocksTarget({ count: 2 }, 'any'), false);
  assert.equal(conditionUnlocksTarget({ rank: '7', count: 1 }, 'any'), true);
  assert.equal(conditionUnlocksTarget({ rank: '7', count: 1 }, 'all'), false);
  assert.equal(conditionUnlocksTarget({ rank: '7', suit: 'S' }, 'all'), true);
});

test('効果と対象属性の互換性を判定できる', () => {
  assert.equal(effectSupportsTarget('skip', 'self'), true);
  assert.equal(effectSupportsTarget('skip', 'next'), true);
  assert.equal(effectSupportsTarget('skip', 'any'), true);
  assert.equal(effectSupportsTarget('skip', 'all'), false);
  assert.equal(effectSupportsTarget('bindSuit', 'self'), true);
  assert.equal(effectSupportsTarget('bindSuit', 'next'), true);
  assert.equal(effectSupportsTarget('bindSuit', 'any'), true);
  assert.equal(effectSupportsTarget('bindSuit', 'all'), true);
  assert.equal(effectSupportsTarget('gift', 'next'), true);
  assert.equal(effectSupportsTarget('gift', 'any'), true);
  assert.equal(effectSupportsTarget('gift', 'self'), false);
  assert.equal(effectSupportsTarget('gift', 'all'), false);
  assert.equal(effectSupportsTarget('reverse', 'none'), true);
  assert.equal(effectSupportsTarget('reverse', 'next'), false);
  assert.equal(effectSupportsTarget('clear', 'none'), true);
  assert.equal(effectSupportsTarget('clear', 'next'), false);
});

test('4段コネクタの成立と不成立をサーバー側で検証する', () => {
  assert.throws(() => normalizeRuleInput({ condition: {}, target: 'self', effect: 'skip' }), /条件/);
  assert.doesNotThrow(() => normalizeRuleInput({ condition: { rank: '7' }, target: 'next', effect: 'skip' }));
  assert.throws(() => normalizeRuleInput({ condition: { rank: '7' }, target: 'any', effect: 'skip' }), /条件パワー/);
  assert.doesNotThrow(() =>
    normalizeRuleInput({ condition: { rank: '7', count: 1 }, target: 'any', effect: 'skip' })
  );
  assert.doesNotThrow(() =>
    normalizeRuleInput({ condition: { rank: '7', suit: 'S' }, target: 'none', effect: 'clear' })
  );
  assert.throws(() => normalizeRuleInput({ condition: { count: 4 }, target: 'self', effect: 'gift' }), /対象にできません/);
  assert.throws(() => normalizeRuleInput({ condition: { count: 4 }, target: 'all', effect: 'skip' }), /対象にできません/);
  assert.doesNotThrow(() =>
    normalizeRuleInput({ condition: { count: 4 }, target: 'all', effect: 'bindSuit' })
  );
});

test('同じ数字の複数枚出しと場より強い判定を行う', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '7', 'H'), card('c', '9', 'S')],
    p2: [card('d', '8', 'S'), card('e', '8', 'H')]
  });

  playCards(room, 'p1', ['a', 'b']);

  assert.equal(room.game.table.count, 2);
  assert.equal(room.game.table.rank, '7');
  assert.equal(room.game.currentPlayerId, 'p2');

  playCards(room, 'p2', ['d', 'e']);
  assert.equal(room.game.table.rank, '8');
});

test('ジョーカーは場より上の最小ランクとして単独で使える', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '9', 'S')],
    p2: [joker()]
  });

  playCards(room, 'p1', ['a']);
  playCards(room, 'p2', ['JK-1']);

  assert.equal(room.game.table.rank, '8');
});

test('自分以外の全員がパスすると場が流れる', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '9', 'S')],
    p2: [card('c', '4', 'S'), card('d', '5', 'S')],
    p3: [card('e', '4', 'H'), card('f', '5', 'H')]
  });

  playCards(room, 'p1', ['a']);
  passTurn(room, 'p2');
  passTurn(room, 'p3');

  assert.equal(room.game.table, null);
  assert.equal(room.game.currentPlayerId, 'p1');
});

test('任意対象スキップは対象選択後に次回機会を飛ばす', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '9', 'S')],
    p2: [card('c', '8', 'S')],
    p3: [card('d', '9', 'H')]
  });

  addRule(room, 'p1', {
    condition: { rank: '7', count: 1 },
    effect: 'skip',
    target: 'any'
  });

  playCards(room, 'p1', ['a']);
  assert.equal(room.game.phase, 'awaitingTarget');
  chooseTarget(room, 'p1', room.game.pendingAction.id, 'p2');

  assert.equal(room.players.find((player) => player.id === 'p2').skipTurns, 0);
  assert.equal(room.game.currentPlayerId, 'p3');
});

test('縛りは対象の次回成功プレイにスートを要求し、パスでは解除されない', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '9', 'C')],
    p2: [card('c', '8', 'H'), card('d', '9', 'S')]
  });

  addRule(room, 'p1', {
    condition: { rank: '7', suit: 'S' },
    effect: 'bindSuit',
    target: 'next'
  });

  playCards(room, 'p1', ['a']);
  assert.equal(room.players.find((player) => player.id === 'p2').bindingSuit, 'S');
  assert.throws(() => playCards(room, 'p2', ['c']), /スペード/);

  passTurn(room, 'p2');
  assert.equal(room.players.find((player) => player.id === 'p2').bindingSuit, 'S');
});

test('渡すは対象決定後にサーバー上の手札を移動する', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '9', 'C')],
    p2: [card('c', '8', 'H')],
    p3: [card('d', '10', 'H')]
  });

  addRule(room, 'p1', {
    condition: { rank: '7', count: 1 },
    effect: 'gift',
    target: 'any'
  });

  playCards(room, 'p1', ['a']);
  chooseTarget(room, 'p1', room.game.pendingAction.id, 'p3');

  assert.equal(room.game.phase, 'awaitingGiftCard');
  chooseTransferCard(room, 'p1', room.game.pendingAction.id, 'b');

  assert.equal(room.players.find((player) => player.id === 'p1').hand.length, 0);
  assert.equal(room.players.find((player) => player.id === 'p3').hand.some((held) => held.id === 'b'), true);
});

test('隠しルールは発動後に公開される', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '9', 'S')],
    p2: [card('c', '8', 'H')]
  });

  addRule(
    room,
    'p1',
    {
      condition: { rank: '7', suit: 'S' },
      effect: 'reverse',
      target: 'none'
    },
    { secret: true }
  );

  assert.equal(room.rules[0].revealed, false);
  playCards(room, 'p1', ['a']);
  assert.equal(room.rules[0].revealed, true);
  assert.equal(room.game.direction, -1);
});

test('Power不足のGLOBAL効果は追加できない', () => {
  const room = makeRoom({
    p1: [],
    p2: []
  });
  room.status = 'lobby';
  room.game = null;

  assert.throws(
    () =>
      addRule(room, 'p1', {
        condition: { count: 1 },
        effect: 'clear',
        target: 'none'
      }),
    /条件パワー/
  );
});

test('流す効果はPower 4なら追加できる', () => {
  const room = makeRoom({
    p1: [],
    p2: []
  });
  room.status = 'lobby';
  room.game = null;

  addRule(room, 'p1', {
    condition: { rank: '7', suit: 'S' },
    effect: 'clear',
    target: 'none'
  });

  assert.equal(room.rules.length, 1);
});

test('開始前はホスト以外も特殊ルールを追加できる', () => {
  const room = makeRoom({
    p1: [],
    p2: []
  });
  room.status = 'lobby';
  room.game = null;

  addRule(room, 'p2', {
    condition: { rank: '7' },
    effect: 'skip',
    target: 'next'
  });

  assert.equal(room.rules.length, 1);
  assert.equal(room.rules[0].createdBy, 'p2');
});

test('ロビーでホストが退出すると次のプレイヤーへホストを移す', () => {
  const room = makeRoom({
    p1: [],
    p2: []
  });
  room.status = 'lobby';
  room.game = null;

  leavePlayer(room, 'p1');

  assert.equal(room.players.some((player) => player.id === 'p1'), false);
  assert.equal(room.hostId, 'p2');
});

test('ゲーム中に現在プレイヤーが途中退出すると次のプレイヤーへ進む', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S')],
    p2: [card('b', '8', 'S')],
    p3: [card('c', '9', 'S')]
  });

  leavePlayer(room, 'p1');

  assert.equal(room.players.find((player) => player.id === 'p1').left, true);
  assert.equal(room.players.find((player) => player.id === 'p1').hand.length, 0);
  assert.equal(room.game.currentPlayerId, 'p2');
});

test('ゲーム中の途中退出で残り1人になったらゲーム終了', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S')],
    p2: [card('b', '8', 'S')]
  });

  leavePlayer(room, 'p2');

  assert.equal(room.status, 'finished');
  assert.equal(room.players.find((player) => player.id === 'p1').finishedRank, 1);
  assert.equal(room.players.find((player) => player.id === 'p2').left, true);
});
