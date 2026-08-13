const test = require('node:test');
const assert = require('node:assert/strict');

const {
  addRule,
  beginRuleBuilding,
  chooseTarget,
  chooseTransferCard,
  getTurnAvailability,
  leavePlayer,
  passTurn,
  playCards,
  startGame
} = require('../src/gameLogic');
const {
  calculateConditionPower,
  conditionUnlocksTarget,
  effectSupportsTarget,
  getTriggeredRules,
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
    bindingSuit: null,
    bindings: []
  }));

  return {
    code: 'TEST1',
    hostId: players[0].id,
    status: 'playing',
    settings: { mode: 'normal', hiddenRuleCount: 5, roundCount: 4 },
    players,
    rules: [],
    events: [],
    match: null,
    game: {
      direction: 1,
      currentPlayerId: players[0].id,
      table: null,
      lastPlayBy: null,
      passes: [],
      rankings: [],
      roundPlayerIds: players.map((player) => player.id),
      phase: 'playing',
      pendingAction: null,
      effectQueue: [],
      resolvingActorId: null,
      forceLeadPlayerId: null,
      emptyTablePasses: [],
      emptyTableFirstPasserId: null,
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
  assert.equal(calculateConditionPower({ rankRelation: 'plusOne' }), 2);
  assert.equal(calculateConditionPower({ suitRelation: 'same' }), 2);
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
  assert.equal(effectSupportsTarget('bindRank', 'all'), true);
  assert.equal(effectSupportsTarget('bindStep', 'all'), true);
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
  assert.doesNotThrow(() =>
    normalizeRuleInput({ condition: { rankRelation: 'plusOne' }, target: 'next', effect: 'bindRank' })
  );
});

test('直前より+1条件は通常ランク順で成立し、2から3へ循環しない', () => {
  const rule = normalizeRuleInput({
    condition: { rankRelation: 'plusOne' },
    effect: 'skip',
    target: 'next'
  });

  assert.equal(getTriggeredRules([rule], { effectiveRank: '7', previousRank: '6', ruleSuits: new Set(), count: 1 }).length, 1);
  assert.equal(getTriggeredRules([rule], { effectiveRank: 'J', previousRank: '10', ruleSuits: new Set(), count: 1 }).length, 1);
  assert.equal(getTriggeredRules([rule], { effectiveRank: '2', previousRank: 'A', ruleSuits: new Set(), count: 1 }).length, 1);
  assert.equal(getTriggeredRules([rule], { effectiveRank: '3', previousRank: '2', ruleSuits: new Set(), count: 1 }).length, 0);
  assert.equal(getTriggeredRules([rule], { effectiveRank: '7', previousRank: null, ruleSuits: new Set(), count: 1 }).length, 0);
});

test('直前と同じスート条件は共通スートがある場合だけ成立する', () => {
  const rule = normalizeRuleInput({
    condition: { suitRelation: 'same' },
    effect: 'skip',
    target: 'next'
  });

  assert.equal(
    getTriggeredRules([rule], {
      effectiveRank: '9',
      previousRank: '7',
      ruleSuits: new Set(['S']),
      previousSuits: new Set(['S']),
      count: 1
    }).length,
    1
  );
  assert.equal(
    getTriggeredRules([rule], {
      effectiveRank: '9',
      previousRank: '7',
      ruleSuits: new Set(['H']),
      previousSuits: new Set(['S']),
      count: 1
    }).length,
    0
  );
  assert.equal(
    getTriggeredRules([rule], {
      effectiveRank: '8',
      previousRank: '7',
      ruleSuits: new Set(['H', 'D']),
      previousSuits: new Set(['S', 'H']),
      count: 2
    }).length,
    1
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

test('直前条件は場流し後の先頭プレイでは発動しない', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '8', 'S')],
    p2: [card('c', '4', 'H'), card('d', '9', 'H')]
  });
  addRule(room, 'p1', {
    condition: { rankRelation: 'plusOne', suit: 'S' },
    effect: 'reverse',
    target: 'none'
  }, { system: true });

  playCards(room, 'p1', ['a']);
  assert.equal(room.game.direction, 1);
  passTurn(room, 'p2');
  playCards(room, 'p1', ['b']);
  assert.equal(room.game.direction, 1);
});

test('ジョーカーの有効数字で直前より+1条件が成立する', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '9', 'S')],
    p2: [joker()]
  });
  addRule(room, 'p1', {
    condition: { rankRelation: 'plusOne', suit: 'S' },
    effect: 'reverse',
    target: 'none'
  }, { system: true });

  playCards(room, 'p1', ['a']);
  playCards(room, 'p2', ['JK-1']);
  assert.equal(room.game.table.rank, '8');
  assert.equal(room.game.direction, -1);
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
  }, { system: true });

  playCards(room, 'p1', ['a']);
  assert.equal(room.game.phase, 'awaitingTarget');
  chooseTarget(room, 'p1', room.game.pendingAction.id, 'p2');

  assert.equal(room.players.find((player) => player.id === 'p2').skipTurns, 0);
  assert.equal(room.game.currentPlayerId, 'p3');
});

test('スート縛りは発動プレイのスートを要求し、パスでも解除される', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '9', 'C')],
    p2: [card('c', '8', 'H'), card('d', '9', 'S')]
  });

  addRule(room, 'p1', {
    condition: { rank: '7', suit: 'S' },
    effect: 'bindSuit',
    target: 'next'
  }, { system: true });

  playCards(room, 'p1', ['a']);
  assert.equal(room.players.find((player) => player.id === 'p2').bindingSuit, 'S');
  assert.equal(room.players.find((player) => player.id === 'p2').bindings[0].type, 'suit');
  assert.throws(() => playCards(room, 'p2', ['c']), /スート縛り/);

  passTurn(room, 'p2');
  assert.equal(room.players.find((player) => player.id === 'p2').bindings.length, 0);
});

test('数字縛りは発動プレイと同じ数字だけを合法にする', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '9', 'C')],
    p2: [card('c', '8', 'H'), card('d', '9', 'H')]
  });

  addRule(room, 'p1', {
    condition: { rank: '7', suit: 'S' },
    effect: 'bindRank',
    target: 'next'
  }, { system: true });

  playCards(room, 'p1', ['a']);
  assert.equal(room.players.find((player) => player.id === 'p2').bindings[0].type, 'rank');
  assert.throws(() => playCards(room, 'p2', ['c']), /数字縛り/);
  passTurn(room, 'p2');
  assert.equal(room.players.find((player) => player.id === 'p2').bindings.length, 0);
});

test('階段縛りは発動数字の1つ上だけを合法にし、2ならパスのみになる', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '2', 'C')],
    p2: [card('c', '9', 'H'), card('d', '8', 'H')]
  });

  addRule(room, 'p1', {
    condition: { rank: '7', suit: 'S' },
    effect: 'bindStep',
    target: 'next'
  }, { system: true });

  playCards(room, 'p1', ['a']);
  assert.equal(room.players.find((player) => player.id === 'p2').bindings[0].ranks[0], '8');
  assert.throws(() => playCards(room, 'p2', ['c']), /階段縛り/);
  playCards(room, 'p2', ['d']);

  const room2 = makeRoom({
    p1: [card('e', '2', 'S'), card('g', '4', 'C')],
    p2: [card('f', '3', 'H')]
  });
  addRule(room2, 'p1', {
    condition: { rank: '2', suit: 'S' },
    effect: 'bindStep',
    target: 'next'
  }, { system: true });
  playCards(room2, 'p1', ['e']);
  assert.equal(room2.players.find((player) => player.id === 'p2').bindings[0].ranks.length, 0);
  passTurn(room2, 'p2');
  assert.equal(room2.players.find((player) => player.id === 'p2').bindings.length, 0);
});

test('複数縛りはAND条件として扱う', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '9', 'C')],
    p2: [card('c', '7', 'H'), card('d', '8', 'S'), card('e', '7', 'S')]
  });
  const p2 = room.players.find((player) => player.id === 'p2');
  p2.bindings = [
    { type: 'suit', suits: ['S'] },
    { type: 'rank', ranks: ['7'] }
  ];

  room.game.currentPlayerId = 'p2';
  assert.throws(() => playCards(room, 'p2', ['c']), /スート縛り/);
  assert.throws(() => playCards(room, 'p2', ['d']), /数字縛り/);
  playCards(room, 'p2', ['e']);
});

test('場が空でスート縛りの合法手がない場合はパスできる', () => {
  const room = makeRoom({
    p1: [card('a', '4', 'H'), card('b', '5', 'D')],
    p2: [card('c', '6', 'S')]
  });
  const p1 = room.players.find((player) => player.id === 'p1');
  p1.bindings = [{ type: 'suit', suits: ['S'] }];
  p1.bindingSuit = 'S';

  const availability = getTurnAvailability(room, 'p1');
  assert.equal(availability.canPass, true);
  assert.equal(availability.noLegalPlay, true);

  passTurn(room, 'p1');

  assert.equal(room.game.table, null);
  assert.equal(room.game.currentPlayerId, 'p2');
  assert.equal(p1.bindings.length, 0);
  assert.equal(p1.bindingSuit, null);
  assert.match(room.events.map((event) => event.text).join('\n'), /出せるカードがありません/);
});

test('場が空で数字縛り・階段縛りの合法手がない場合もパスできる', () => {
  const rankRoom = makeRoom({
    p1: [card('a', '4', 'H')],
    p2: [card('b', '5', 'S')]
  });
  rankRoom.players.find((player) => player.id === 'p1').bindings = [{ type: 'rank', ranks: ['8'] }];
  passTurn(rankRoom, 'p1');
  assert.equal(rankRoom.players.find((player) => player.id === 'p1').bindings.length, 0);
  assert.equal(rankRoom.game.currentPlayerId, 'p2');

  const stepRoom = makeRoom({
    p1: [card('c', '4', 'H')],
    p2: [card('d', '5', 'S')]
  });
  stepRoom.players.find((player) => player.id === 'p1').bindings = [{ type: 'step', ranks: ['8'] }];
  passTurn(stepRoom, 'p1');
  assert.equal(stepRoom.players.find((player) => player.id === 'p1').bindings.length, 0);
  assert.equal(stepRoom.game.currentPlayerId, 'p2');
});

test('場がある状態で縛りにより合法手がなくてもパスで縛りが解除される', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '9', 'S')],
    p2: [card('c', '8', 'H'), card('d', '10', 'H')]
  });

  playCards(room, 'p1', ['a']);
  const p2 = room.players.find((player) => player.id === 'p2');
  p2.bindings = [{ type: 'suit', suits: ['S'] }];

  assert.equal(getTurnAvailability(room, 'p2').noLegalPlay, true);
  passTurn(room, 'p2');

  assert.equal(p2.bindings.length, 0);
  assert.equal(room.game.table, null);
  assert.equal(room.game.currentPlayerId, 'p1');
});

test('複数縛りでAND条件を満たす合法手がなくてもパスですべて解除される', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '8', 'H')],
    p2: [card('c', '9', 'C')]
  });
  const p1 = room.players.find((player) => player.id === 'p1');
  p1.bindings = [
    { type: 'suit', suits: ['S'] },
    { type: 'rank', ranks: ['8'] }
  ];

  assert.equal(getTurnAvailability(room, 'p1').noLegalPlay, true);
  passTurn(room, 'p1');

  assert.equal(p1.bindings.length, 0);
  assert.equal(room.game.currentPlayerId, 'p2');
});

test('場が空で縛りの合法手がある場合も任意パスで縛りを解除できる', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '8', 'H')],
    p2: [card('c', '9', 'C')]
  });
  const p1 = room.players.find((player) => player.id === 'p1');
  p1.bindings = [{ type: 'suit', suits: ['S'] }];

  const availability = getTurnAvailability(room, 'p1');
  assert.equal(availability.canPass, true);
  assert.equal(availability.noLegalPlay, false);

  passTurn(room, 'p1');

  assert.equal(p1.bindings.length, 0);
  assert.equal(room.game.currentPlayerId, 'p2');
});

test('スキップでは縛りを消費せず、次の実行動機会まで維持する', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '9', 'S')],
    p2: [card('c', '8', 'S')],
    p3: [card('d', '10', 'H')]
  });
  const p2 = room.players.find((player) => player.id === 'p2');
  p2.bindings = [{ type: 'suit', suits: ['S'] }];
  p2.skipTurns = 1;

  playCards(room, 'p1', ['a']);

  assert.equal(room.game.currentPlayerId, 'p3');
  assert.equal(p2.skipTurns, 0);
  assert.equal(p2.bindings.length, 1);
});

test('空の場で縛りによる連続パス後、合法手のある次プレイヤーが場を開始できる', () => {
  const room = makeRoom({
    p1: [card('a', '4', 'H')],
    p2: [card('b', '5', 'D')],
    p3: [card('c', '6', 'S')]
  });
  room.players.find((player) => player.id === 'p1').bindings = [{ type: 'suit', suits: ['S'] }];
  room.players.find((player) => player.id === 'p2').bindings = [{ type: 'rank', ranks: ['8'] }];

  passTurn(room, 'p1');
  passTurn(room, 'p2');

  assert.equal(room.game.table, null);
  assert.equal(room.game.currentPlayerId, 'p3');
  playCards(room, 'p3', ['c']);
  assert.equal(room.game.table.rank, '6');
});

test('空の場で全員が縛りによりパスした場合は縛りを解除して最初のパス者に戻す', () => {
  const room = makeRoom({
    p1: [card('a', '4', 'H')],
    p2: [card('b', '5', 'D')]
  });
  room.players.find((player) => player.id === 'p1').bindings = [{ type: 'suit', suits: ['S'] }];
  room.players.find((player) => player.id === 'p2').bindings = [{ type: 'rank', ranks: ['8'] }];

  passTurn(room, 'p1');
  passTurn(room, 'p2');

  assert.equal(room.game.table, null);
  assert.equal(room.game.currentPlayerId, 'p1');
  assert.equal(room.players.find((player) => player.id === 'p1').bindings.length, 0);
  assert.equal(room.players.find((player) => player.id === 'p2').bindings.length, 0);
  assert.match(room.events.map((event) => event.text).join('\n'), /縛りなしで新しい場を開始/);
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
  }, { system: true });

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
    { secret: true, system: true }
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
      }, { system: true }),
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
  }, { system: true });

  assert.equal(room.rules.length, 1);
});

test('PLAYING中は通常プレイヤーが特殊ルールを追加できない', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S')],
    p2: [card('b', '8', 'S')]
  });

  assert.throws(
    () =>
      addRule(room, 'p1', {
        condition: { rank: '7' },
        effect: 'skip',
        target: 'next'
      }),
    /ルール追加フェーズ/
  );
});

test('複数ラウンドでは終了後にルール追加フェーズを経て次ラウンドへ進む', () => {
  const room = makeRoom({
    p1: [],
    p2: []
  });
  room.status = 'lobby';
  room.game = null;

  startGame(room, 'p1', { rng: () => 0.5 });
  room.players.find((player) => player.id === 'p1').hand = [card('a', '7', 'S')];
  room.players.find((player) => player.id === 'p2').hand = [card('b', '8', 'S')];
  room.game.currentPlayerId = 'p1';

  playCards(room, 'p1', ['a']);

  assert.equal(room.status, 'roundResult');
  assert.equal(room.match.currentRound, 1);
  assert.equal(room.match.scores.p1, 1);
  assert.equal(room.match.scores.p2, 0);

  assert.throws(
    () =>
      addRule(room, 'p1', {
        condition: { rank: '7' },
        effect: 'skip',
        target: 'next'
      }),
    /ルール追加フェーズ/
  );

  beginRuleBuilding(room, 'p1');
  assert.equal(room.status, 'ruleBuilding');
  assert.equal(room.match.ruleBuilding.queue[0], 'p2');

  assert.throws(
    () =>
      addRule(room, 'p1', {
        condition: { rank: '7' },
        effect: 'skip',
        target: 'next'
      }),
    /あなたのルール追加ターン/
  );

  addRule(room, 'p2', {
    condition: { rank: '7' },
    effect: 'skip',
    target: 'next'
  });

  assert.equal(room.match.ruleBuilding.queue[room.match.ruleBuilding.currentIndex], 'p1');

  addRule(room, 'p1', {
    condition: { count: 2 },
    effect: 'gift',
    target: 'next'
  });

  assert.equal(room.status, 'playing');
  assert.equal(room.match.currentRound, 2);
  assert.equal(room.rules.length, 2);
});

test('最終ラウンド後はMATCH_RESULTになり最終ラウンド順位で同点を解決する', () => {
  const room = makeRoom({
    p1: [],
    p2: []
  });
  room.status = 'lobby';
  room.game = null;
  room.settings.roundCount = 4;

  startGame(room, 'p1', { rng: () => 0.5 });

  const winners = ['p1', 'p2', 'p1', 'p2'];
  const ruleRanks = ['7', '8', '9', '10', 'J', 'Q'];
  let ruleIndex = 0;

  for (let round = 1; round <= 4; round += 1) {
    const winnerId = winners[round - 1];
    room.players.find((player) => player.id === 'p1').hand = [card(`a${round}`, '7', 'S')];
    room.players.find((player) => player.id === 'p2').hand = [card(`b${round}`, '8', 'S')];
    room.game.currentPlayerId = winnerId;

    playCards(room, winnerId, [winnerId === 'p1' ? `a${round}` : `b${round}`]);

    if (round < 4) {
      beginRuleBuilding(room, 'p1');
      const firstBuilder = room.match.ruleBuilding.queue[room.match.ruleBuilding.currentIndex];
      addRule(room, firstBuilder, {
        condition: { rank: ruleRanks[ruleIndex] },
        effect: 'skip',
        target: 'next'
      });
      ruleIndex += 1;
      const secondBuilder = room.match.ruleBuilding.queue[room.match.ruleBuilding.currentIndex];
      addRule(room, secondBuilder, {
        condition: { rank: ruleRanks[ruleIndex] },
        effect: 'skip',
        target: 'next'
      });
      ruleIndex += 1;
    }
  }

  assert.equal(room.status, 'matchResult');
  assert.equal(room.match.scores.p1, 2);
  assert.equal(room.match.scores.p2, 2);
  assert.equal(room.match.finalResults[0].playerId, 'p2');
  assert.equal(room.match.roundResults.length, 4);
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
