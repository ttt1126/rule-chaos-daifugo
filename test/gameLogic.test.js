const test = require('node:test');
const assert = require('node:assert/strict');

const {
  addRule,
  beginRuleBuilding,
  chooseDiscardCards,
  chooseTarget,
  chooseTransferCard,
  endGame,
  getLegalPlays,
  getTurnAvailability,
  leavePlayer,
  passTurn,
  playCards,
  startRound,
  startGame
} = require('../src/gameLogic');
const { createRoomManager } = require('../src/roomManager');
const {
  calculateConditionPower,
  conditionUnlocksTarget,
  effectSupportsTarget,
  getTriggeredRules,
  normalizeRuleInput
} = require('../src/ruleEngine');
const { generateRandomRules } = require('../src/randomRules');
const {
  chooseCpuCardsToGive,
  chooseCpuDiscard,
  chooseCpuPlay,
  chooseCpuRule,
  chooseCpuTarget
} = require('../src/cpuLogic');

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
    settings: {
      mode: 'normal',
      hiddenRuleCount: 5,
      roundCount: 4,
      bindingMode: 'standard',
      localRules: { eightCut: false, fiveSkip: false, sevenGift: false, tenDiscard: false }
    },
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
      autoPassDepth: 0,
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
  assert.equal(calculateConditionPower({ suit: 'S' }), 1);
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
  assert.equal(conditionUnlocksTarget({ rank: '7', suit: 'S' }, 'all'), false);
  assert.equal(conditionUnlocksTarget({ rank: '7', suit: 'S', count: 1 }, 'all'), true);
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
  assert.equal(effectSupportsTarget('bindStep', 'all'), false);
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
    normalizeRuleInput({ condition: { rank: '7', suit: 'S', count: 1 }, target: 'none', effect: 'clear' })
  );
  assert.throws(
    () => normalizeRuleInput({ condition: { rank: 'JOKER', suit: 'S' }, target: 'next', effect: 'skip' }),
    /JOKER条件/
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

test('1つ上の数字条件は通常ランク順で成立し、2から3へ循環しない', () => {
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

test('同スート条件は共通スートがある場合だけ成立する', () => {
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

test('JOKER単体は2より強い専用ランクとして使える', () => {
  const room = makeRoom({
    p1: [card('a', '2', 'S'), card('b', '9', 'S')],
    p2: [joker()]
  });

  playCards(room, 'p1', ['a']);
  playCards(room, 'p2', ['JK-1']);

  assert.equal(room.game.table.rank, 'JOKER');
});

test('JOKERペアは2のペアより強い', () => {
  const room = makeRoom({
    p1: [card('a', '2', 'S'), card('b', '2', 'H'), card('c', '9', 'S')],
    p2: [joker('JK-1'), joker('JK-2')]
  });

  playCards(room, 'p1', ['a', 'b']);
  playCards(room, 'p2', ['JK-1', 'JK-2']);

  assert.equal(room.game.table.rank, 'JOKER');
  assert.equal(room.game.table.count, 2);
});

test('JOKERは通常カードと混ぜるとその数字の組として扱う', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), joker('JK-1'), card('x', '9', 'S')],
    p2: [card('b', '8', 'S'), card('c', '8', 'H')]
  });

  playCards(room, 'p1', ['a', 'JK-1']);
  assert.equal(room.game.table.rank, '7');
  playCards(room, 'p2', ['b', 'c']);
  assert.equal(room.game.table.rank, '8');
});

test('JOKER条件は物理JOKER使用を判定し、通常数字・スート条件と独立する', () => {
  const jokerRule = normalizeRuleInput({ condition: { rank: 'JOKER' }, effect: 'skip', target: 'next' });
  const rankRule = normalizeRuleInput({ condition: { rank: '7' }, effect: 'skip', target: 'next' });
  const suitRule = normalizeRuleInput({ condition: { suit: 'S' }, effect: 'skip', target: 'self' });
  const countRule = normalizeRuleInput({ condition: { count: 2 }, effect: 'skip', target: 'next' });

  assert.equal(
    getTriggeredRules(
      [jokerRule, rankRule, suitRule, countRule],
      {
        effectiveRank: '7',
        hasJoker: true,
        ruleRanks: new Set(['7']),
        ruleSuits: new Set(['S']),
        count: 2
      }
    ).length,
    4
  );

  assert.equal(
    getTriggeredRules(
      [jokerRule, rankRule, suitRule, countRule],
      {
        effectiveRank: 'JOKER',
        hasJoker: true,
        ruleRanks: new Set(),
        ruleSuits: new Set(),
        count: 2
      }
    ).length,
    2
  );
});

test('7 + 8 + JOKERのような異なる通常数字混在は不正', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '8', 'H'), joker('JK-1')],
    p2: [card('c', '9', 'S')]
  });

  assert.throws(() => playCards(room, 'p1', ['a', 'b', 'JK-1']), /同じ数字/);
});

test('自分以外の全員がパスすると場が流れる', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '9', 'S')],
    p2: [card('c', '8', 'S'), card('d', '5', 'S')],
    p3: [card('e', '9', 'H'), card('f', '5', 'H')]
  });

  playCards(room, 'p1', ['a']);
  passTurn(room, 'p2');
  passTurn(room, 'p3');

  assert.equal(room.game.table, null);
  assert.equal(room.game.currentPlayerId, 'p1');
});

test('誰も上回れない場合は自動で場が流れるがJOKERがあれば流れない', () => {
  const room = makeRoom({
    p1: [card('a', '2', 'S'), card('x', '9', 'S')],
    p2: [card('b', 'K', 'H')],
    p3: [card('c', 'A', 'D')]
  });

  playCards(room, 'p1', ['a']);

  assert.equal(room.game.table, null);
  assert.equal(room.game.currentPlayerId, 'p1');

  const jokerRoom = makeRoom({
    p1: [card('d', '2', 'S'), card('y', '9', 'S')],
    p2: [joker()],
    p3: [card('e', 'A', 'D')]
  });

  playCards(jokerRoom, 'p1', ['d']);

  assert.equal(jokerRoom.game.table.rank, '2');
  assert.equal(jokerRoom.game.currentPlayerId, 'p2');
});

test('JOKERペアを持つ相手がいる場合、2ペアの場は自動で流れない', () => {
  const room = makeRoom({
    p1: [card('a', '2', 'S'), card('b', '2', 'H'), card('x', '9', 'S')],
    p2: [joker('JK-1'), joker('JK-2')],
    p3: [card('c', 'A', 'D'), card('d', 'A', 'C')]
  });

  playCards(room, 'p1', ['a', 'b']);

  assert.equal(room.game.table.rank, '2');
  assert.equal(room.game.currentPlayerId, 'p2');
});

test('直前条件は場流し後の先頭プレイでは発動しない', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '8', 'S')],
    p2: [card('c', '4', 'H'), card('d', '9', 'H')]
  });
  addRule(room, 'p1', {
    condition: { rankRelation: 'plusOne', suit: 'S', count: 1 },
    effect: 'reverse',
    target: 'none'
  }, { system: true });

  playCards(room, 'p1', ['a']);
  assert.equal(room.game.direction, 1);
  passTurn(room, 'p2');
  playCards(room, 'p1', ['b']);
  assert.equal(room.game.direction, 1);
});

test('JOKERを通常カードと混ぜた有効数字で1つ上の数字条件が成立する', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '7', 'H'), card('x', '9', 'S')],
    p2: [card('c', '8', 'S'), joker()]
  });
  addRule(room, 'p1', {
    condition: { rankRelation: 'plusOne', count: 2 },
    effect: 'reverse',
    target: 'none'
  }, { system: true });

  playCards(room, 'p1', ['a', 'b']);
  playCards(room, 'p2', ['c', 'JK-1']);
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

test('数字縛りは指定数字だけを合法にする', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '9', 'C')],
    p2: [card('c', '8', 'H'), card('d', '9', 'H')]
  });

  addRule(room, 'p1', {
    condition: { rank: '7', suit: 'S' },
    effect: 'bindRank',
    target: 'next',
    effectConfig: { bindRank: '9' }
  }, { system: true });

  playCards(room, 'p1', ['a']);
  assert.equal(room.players.find((player) => player.id === 'p2').bindings[0].type, 'rank');
  assert.deepEqual(room.players.find((player) => player.id === 'p2').bindings[0].ranks, ['9']);
  room.game.currentPlayerId = 'p2';
  room.game.table = null;
  room.game.lastPlayBy = null;
  assert.throws(() => playCards(room, 'p2', ['c']), /数字縛り/);
  passTurn(room, 'p2');
  assert.equal(room.players.find((player) => player.id === 'p2').bindings.length, 0);
});

test('階段縛りは新規ルールとして作成できない', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S')],
    p2: [card('c', '8', 'H')]
  });

  assert.throws(
    () =>
      addRule(room, 'p1', {
        condition: { rank: '7', suit: 'S' },
        effect: 'bindStep',
        target: 'next'
      }, { system: true }),
    /存在しない効果/
  );
});

test('縛り競合は標準では同種上書き、カオスではANDで自動パスになる', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '2', 'C')],
    p2: [card('c', '9', 'H'), card('d', '10', 'H')]
  });

  addRule(room, 'p1', {
    condition: { rank: '7', suit: 'S' },
    effect: 'bindRank',
    target: 'next',
    effectConfig: { bindRank: '9' }
  }, { system: true });
  addRule(room, 'p1', {
    condition: { rank: '7', count: 1 },
    effect: 'bindRank',
    target: 'next',
    effectConfig: { bindRank: '10' }
  }, { system: true });
  playCards(room, 'p1', ['a']);
  assert.deepEqual(room.players.find((player) => player.id === 'p2').bindings.map((binding) => binding.ranks[0]), ['10']);

  const chaosRoom = makeRoom({
    p1: [card('e', '7', 'S'), card('g', '4', 'C')],
    p2: [card('f', '9', 'H'), card('h', '10', 'H')]
  });
  chaosRoom.settings.bindingMode = 'chaos';
  addRule(chaosRoom, 'p1', {
    condition: { rank: '7', suit: 'S' },
    effect: 'bindRank',
    target: 'next',
    effectConfig: { bindRank: '9' }
  }, { system: true });
  addRule(chaosRoom, 'p1', {
    condition: { rank: '7', count: 1 },
    effect: 'bindRank',
    target: 'next',
    effectConfig: { bindRank: '10' }
  }, { system: true });
  playCards(chaosRoom, 'p1', ['e']);
  assert.equal(chaosRoom.players.find((player) => player.id === 'p2').bindings.length, 0);
  assert.match(chaosRoom.events.map((event) => event.text).join('\n'), /自動パス/);
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

test('場が空で数字縛り・旧階段縛り互換の合法手がない場合もパスできる', () => {
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

test('同じ対象への渡すは合算して一度に選択する', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S'), card('b', '9', 'C'), card('e', '10', 'C'), card('f', '3', 'C')],
    p2: [card('c', '8', 'H')],
    p3: [card('d', 'J', 'H')]
  });
  room.settings.localRules.sevenGift = true;

  addRule(room, 'p1', {
    condition: { rank: '7', count: 1 },
    effect: 'gift',
    target: 'next'
  }, { system: true });

  playCards(room, 'p1', ['a']);

  assert.equal(room.game.phase, 'awaitingGiftCard');
  assert.equal(room.game.pendingAction.requiredCount, 2);
  chooseTransferCard(room, 'p1', room.game.pendingAction.id, ['b', 'e']);
  assert.equal(room.players.find((player) => player.id === 'p2').hand.length, 3);
});

test('ローカルルールの8切りは場を流して発動者を先頭にする', () => {
  const room = makeRoom({
    p1: [card('a', '8', 'S'), card('b', '3', 'C')],
    p2: [card('c', '9', 'H')],
    p3: [card('d', '10', 'H')]
  });
  room.settings.localRules.eightCut = true;

  playCards(room, 'p1', ['a']);

  assert.equal(room.game.table, null);
  assert.equal(room.game.currentPlayerId, 'p1');
  assert.match(room.events.map((event) => event.text).join('\n'), /8切り: 場が流れました/);
});

test('ローカルルールの5飛びは次の有効プレイヤーを1人スキップする', () => {
  const room = makeRoom({
    p1: [card('a', '5', 'S'), card('b', '3', 'C')],
    p2: [card('c', '6', 'H')],
    p3: [card('d', '7', 'H')]
  });
  room.settings.localRules.fiveSkip = true;

  playCards(room, 'p1', ['a']);

  assert.equal(room.game.currentPlayerId, 'p3');
  assert.match(room.events.map((event) => event.text).join('\n'), /P2さんのターンがスキップされました/);
});

test('ローカルルールの10捨ては追加捨て待ちになり、捨てたカードでは追加発動しない', () => {
  const room = makeRoom({
    p1: [card('a', '10', 'S'), card('b', '8', 'C'), card('e', '3', 'C')],
    p2: [card('c', 'J', 'H')],
    p3: [card('d', 'Q', 'H')]
  });
  room.settings.localRules.tenDiscard = true;
  room.settings.localRules.eightCut = true;

  playCards(room, 'p1', ['a']);

  assert.equal(room.game.phase, 'awaitingDiscardCard');
  chooseDiscardCards(room, 'p1', room.game.pendingAction.id, ['b']);
  assert.notEqual(room.game.table, null);
  assert.equal(room.players.find((player) => player.id === 'p1').hand.some((held) => held.id === 'b'), false);
});

test('カオス生成は階段縛りを作らず、1〜2条件中心に生成する', () => {
  let seed = 1;
  const rng = () => {
    seed = (seed * 48271) % 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const rules = generateRandomRules(10, { rng });
  const slotCounts = rules.map((rule) =>
    ['rank', 'suit', 'count', 'rankRelation', 'suitRelation'].filter((key) => Boolean(rule.condition[key])).length
  );

  assert.equal(rules.some((rule) => rule.effect === 'bindStep'), false);
  assert.equal(slotCounts.every((count) => count >= 1 && count <= 3), true);
  assert.equal(slotCounts.filter((count) => count <= 2).length >= 7, true);
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
      condition: { rank: '7', suit: 'S', count: 1 },
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
    condition: { rank: '7', suit: 'S', count: 1 },
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

test('親はラウンドごとに席順でローテーションする', () => {
  const room = makeRoom({
    p1: [],
    p2: [],
    p3: []
  });
  room.status = 'lobby';
  room.game = null;

  startGame(room, 'p1', { rng: () => 0.5 });
  assert.equal(room.game.roundLeaderId, 'p1');

  room.match.currentRound = 2;
  startRound(room, { rng: () => 0.5 });
  assert.equal(room.game.roundLeaderId, 'p2');

  room.match.currentRound = 3;
  startRound(room, { rng: () => 0.5 });
  assert.equal(room.game.roundLeaderId, 'p3');
});

test('ホストのゲーム終了は部屋とプレイヤーを維持してロビーへ戻す', () => {
  const room = makeRoom({
    p1: [],
    p2: []
  });
  room.status = 'lobby';
  room.game = null;
  startGame(room, 'p1', { rng: () => 0.5 });
  room.rules.push({ id: 'rule1' });

  endGame(room, 'p1');

  assert.equal(room.status, 'lobby');
  assert.equal(room.match, null);
  assert.equal(room.game, null);
  assert.equal(room.rules.length, 0);
  assert.equal(room.players.length, 2);
  assert.equal(room.players.every((player) => player.hand.length === 0 && !player.finishedRank), true);
  assert.equal(room.events.length, 1);
});

test('設定変更ログは差分を構造化して残す', () => {
  const manager = createRoomManager();
  const { room, player } = manager.createRoom('A');

  manager.updateSettings(room, player.id, {
    mode: 'chaos',
    hiddenRuleCount: 8,
    roundCount: 5,
    bindingMode: 'chaos',
    localRules: { eightCut: true, fiveSkip: false, sevenGift: false, tenDiscard: false }
  });

  const event = room.events.at(-1);
  assert.equal(event.type, 'settings');
  assert.equal(event.playerId, player.id);
  assert.ok(event.text.includes('モード 通常 → カオス'));
  assert.ok(event.metadata.changes.some((change) => change.key === 'localRules.eightCut'));
});

test('開始時設定とサーバー履歴を公開状態で復元できる', () => {
  const manager = createRoomManager();
  const { room, player: p1 } = manager.createRoom('A');
  manager.joinRoom(room.code, 'B');
  room.settings.localRules.eightCut = true;

  manager.startGame(room, p1.id);

  const state = manager.getPublicState(room, p1.id);
  assert.ok(state.eventHistory.length >= state.recentEvents.length);
  assert.ok(state.eventHistory.some((event) => event.type === 'settings' && event.metadata.snapshot));
});

test('公開状態は現在プレイヤーの行動不能を状態として返す', () => {
  const manager = createRoomManager();
  const { room, player: p1 } = manager.createRoom('A');
  const { player: p2 } = manager.joinRoom(room.code, 'B');
  room.status = 'playing';
  room.game = {
    direction: 1,
    currentPlayerId: p1.id,
    roundLeaderId: p1.id,
    table: null,
    lastPlayBy: null,
    passes: [],
    rankings: [],
    roundPlayerIds: [p1.id, p2.id],
    phase: 'playing',
    pendingAction: null,
    effectQueue: [],
    resolvingActorId: null,
    forceLeadPlayerId: null,
    emptyTablePasses: [],
    emptyTableFirstPasserId: null,
    autoPassDepth: 0,
    turnNumber: 1
  };
  p1.hand = [card('a', '7', 'H')];
  p2.hand = [card('b', '8', 'H')];
  p1.bindings = [{ type: 'suit', suits: ['S'] }];

  const state = manager.getPublicState(room, p2.id);
  const current = state.players.find((player) => player.id === p1.id);

  assert.equal(current.actionBlocked, true);
  assert.ok(current.actionStatusText.includes('出せるカード'));
});

test('上がったプレイヤーだけ他人の手札を観戦できる', () => {
  const manager = createRoomManager();
  const { room, player: p1 } = manager.createRoom('A');
  const { player: p2 } = manager.joinRoom(room.code, 'B');
  const { player: p3 } = manager.joinRoom(room.code, 'C');
  room.status = 'playing';
  room.game = {
    direction: 1,
    currentPlayerId: p2.id,
    roundLeaderId: p1.id,
    table: null,
    lastPlayBy: null,
    passes: [],
    rankings: [p1.id],
    roundPlayerIds: [p1.id, p2.id, p3.id],
    phase: 'playing',
    pendingAction: null,
    effectQueue: [],
    resolvingActorId: null,
    forceLeadPlayerId: null,
    emptyTablePasses: [],
    emptyTableFirstPasserId: null,
    turnNumber: 1
  };
  p1.finishedRank = 1;
  p2.hand = [card('a', '7', 'S')];
  p3.hand = [card('b', '8', 'H')];

  const spectatorState = manager.getPublicState(room, p1.id);
  const playingState = manager.getPublicState(room, p2.id);

  assert.equal(spectatorState.players.find((player) => player.id === p2.id).hand.length, 1);
  assert.equal(playingState.players.find((player) => player.id === p3.id).hand, null);
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

test('ホストはロビーでCPUを追加・削除できる', () => {
  const manager = createRoomManager();
  const { room, player: host } = manager.createRoom('A');

  const cpu = manager.addCpuPlayer(room, host.id);
  const state = manager.getPublicState(room, host.id);

  assert.equal(cpu.isCPU, true);
  assert.equal(cpu.reconnectToken, null);
  assert.equal(state.players.find((player) => player.id === cpu.id).isCPU, true);

  manager.removeCpuPlayer(room, host.id, cpu.id);

  assert.equal(room.players.some((player) => player.id === cpu.id), false);
});

test('人間1人とCPU1人でゲーム開始できる', () => {
  const manager = createRoomManager();
  const { room, player: host } = manager.createRoom('A');
  manager.addCpuPlayer(room, host.id);

  manager.startGame(room, host.id);

  assert.equal(room.status, 'playing');
  assert.equal(room.match.playerIds.length, 2);
  assert.equal(room.players.some((player) => player.isCPU), true);
});

test('CPUは通常カードの合法手があればJOKERを温存しやすい', () => {
  const room = makeRoom({
    p1: [card('a', '4', 'S'), joker('JK-1')],
    p2: [card('b', '8', 'S')]
  });
  room.players[0].isCPU = true;

  const move = chooseCpuPlay(room, room.players[0], getLegalPlays, () => 0);

  assert.ok(move);
  assert.deepEqual(move.cardIds, ['a']);
});

test('CPUは渡す・10捨てで弱いカードから選ぶ', () => {
  const player = {
    hand: [card('a', '3', 'S'), card('b', '2', 'S'), joker('JK-1'), card('c', '5', 'H')]
  };

  assert.deepEqual(chooseCpuCardsToGive(player, 2), ['a', 'c']);
  assert.deepEqual(chooseCpuDiscard(player, 1), ['a']);
});

test('CPUの任意対象は効果に応じて自然な相手を選ぶ', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S')],
    p2: [card('b', '8', 'S')],
    p3: [card('c', '9', 'S'), card('d', '10', 'S'), card('e', 'J', 'S')]
  });

  const skipTarget = chooseCpuTarget(room, {
    effect: 'skip',
    eligibleTargetIds: ['p2', 'p3']
  }, () => 0);
  const giftTarget = chooseCpuTarget(room, {
    effect: 'gift',
    eligibleTargetIds: ['p2', 'p3']
  }, () => 0);

  assert.equal(skipTarget, 'p2');
  assert.equal(giftTarget, 'p3');
});

test('CPUはルール追加フェーズで合法ルールを作成できる', () => {
  const room = makeRoom({
    p1: [card('a', '7', 'S')],
    p2: [card('b', '8', 'S')]
  });
  room.players[0].isCPU = true;
  room.status = 'ruleBuilding';
  room.game.phase = 'ruleBuilding';
  room.match = {
    currentRound: 1,
    totalRounds: 4,
    playerIds: ['p1', 'p2'],
    scores: { p1: 0, p2: 0 },
    roundResults: [],
    finalResults: null,
    ruleBuilding: {
      afterRound: 1,
      queue: ['p1', 'p2'],
      currentIndex: 0,
      addedRules: []
    }
  };

  const rule = chooseCpuRule(room, room.players[0], () => 0.25);
  const added = addRule(room, 'p1', rule, { generated: true });

  assert.equal(added.createdBy, 'p1');
  assert.equal(added.createdByName, 'P1');
  assert.equal(added.generated, true);
  assert.equal(room.match.ruleBuilding.currentIndex, 1);
});
