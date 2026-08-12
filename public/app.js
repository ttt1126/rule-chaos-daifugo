const STORAGE_KEY = 'rule-chaos-daifugo-session';

const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', 'JOKER'];
const SUITS = [
  ['S', '♠'],
  ['H', '♥'],
  ['D', '♦'],
  ['C', '♣']
];
const EFFECTS = [
  ['skip', 'スキップ'],
  ['bindSuit', '縛り'],
  ['reverse', 'リバース'],
  ['clear', '流す'],
  ['gift', '渡す']
];
const TARGET_LABELS = {
  none: '対象なし',
  self: '自分',
  next: '次のプレイヤー',
  all: '全員',
  any: '任意のプレイヤー'
};
const EFFECT_TARGETS = {
  skip: ['next', 'any'],
  bindSuit: ['self', 'next', 'all', 'any'],
  reverse: ['none'],
  clear: ['none'],
  gift: ['next', 'any']
};

let socket = null;
let session = loadSession();
let roomState = null;
let selectedCardIds = new Set();
let message = '';
let ruleDraft = {
  condition: { rank: '', suit: '', count: '' },
  target: 'next',
  effect: 'skip'
};

const app = document.getElementById('app');

connectSocket();
render();

function connectSocket() {
  socket = io({ transports: ['websocket'] });

  socket.on('connect', () => {
    render();
  });

  socket.on('disconnect', () => {
    render();
  });

  socket.on('state', (nextState) => {
    roomState = nextState;
    trimSelectedCards();
    render();
  });

  socket.on('errorMessage', (error) => {
    showMessage(error);
  });
}

document.addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-action]');
  if (!form) return;
  event.preventDefault();

  const data = Object.fromEntries(new FormData(form).entries());
  if (form.dataset.action === 'create') {
    emit('createRoom', { name: data.name });
  }
  if (form.dataset.action === 'join') {
    emit('joinRoom', { name: data.name, roomCode: data.roomCode });
  }
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-click]');
  if (!button) return;

  const action = button.dataset.click;
  if (action === 'reconnect') {
    if (!session) return;
    emit('reconnectRoom', session);
  }
  if (action === 'forget') {
    session = null;
    roomState = null;
    localStorage.removeItem(STORAGE_KEY);
    render();
  }
  if (action === 'start') {
    emitAuthed('startGame', {});
  }
  if (action === 'select-card') {
    toggleSelectedCard(button.dataset.cardId);
  }
  if (action === 'play') {
    emitAuthed('playCards', { cardIds: [...selectedCardIds] }, () => {
      selectedCardIds.clear();
      render();
    });
  }
  if (action === 'pass') {
    emitAuthed('passTurn', {});
  }
  if (action === 'choose-target') {
    const pending = roomState?.game?.pendingAction;
    emitAuthed('chooseTarget', {
      pendingId: pending?.id,
      targetPlayerId: button.dataset.targetId
    });
  }
  if (action === 'gift-card') {
    const pending = roomState?.game?.pendingAction;
    emitAuthed('chooseTransferCard', {
      pendingId: pending?.id,
      cardId: button.dataset.cardId
    });
  }
});

document.addEventListener('change', (event) => {
  const field = event.target.closest('[data-rule-field], [data-setting]');
  if (!field) return;

  if (field.dataset.ruleField) {
    const fieldName = field.dataset.ruleField;
    if (fieldName === 'rank' || fieldName === 'suit' || fieldName === 'count') {
      ruleDraft.condition[fieldName] = field.value;
    } else {
      ruleDraft[fieldName] = field.value;
    }

    normalizeRuleDraftTarget();
    render();
    return;
  }

  if (field.dataset.setting && roomState?.isHost) {
    const settings = {
      mode: roomState.settings.mode,
      hiddenRuleCount: roomState.settings.hiddenRuleCount
    };
    settings[field.dataset.setting] = field.value;
    emitAuthed('updateSettings', { settings });
  }
});

document.addEventListener('click', (event) => {
  const addButton = event.target.closest('[data-click="add-rule"]');
  if (!addButton) return;

  normalizeRuleDraftTarget();
  emitAuthed('addRule', {
    rule: {
      condition: {
        rank: ruleDraft.condition.rank || null,
        suit: ruleDraft.condition.suit || null,
        count: ruleDraft.condition.count || null
      },
      target: ruleDraft.target,
      effect: ruleDraft.effect
    }
  });
});

function emitAuthed(eventName, payload, onOk) {
  if (!session) {
    showMessage('部屋に参加していません');
    return;
  }
  emit(eventName, { ...payload, roomCode: session.roomCode, playerId: session.playerId }, onOk);
}

function emit(eventName, payload, onOk) {
  clearMessage();
  socket.emit(eventName, payload, (response) => {
    if (!response?.ok) {
      showMessage(response?.error || '操作に失敗しました');
      return;
    }
    if (response.roomCode && response.playerId && response.reconnectToken) {
      saveCredentials(response);
    }
    if (onOk) onOk(response);
  });
}

function saveCredentials(response) {
  session = {
    roomCode: response.roomCode,
    playerId: response.playerId,
    reconnectToken: response.reconnectToken
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  render();
}

function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_error) {
    return null;
  }
}

function trimSelectedCards() {
  const ownHand = roomState?.players.find((player) => player.isYou)?.hand || [];
  const validIds = new Set(ownHand.map((card) => card.id));
  selectedCardIds = new Set([...selectedCardIds].filter((id) => validIds.has(id)));
}

function toggleSelectedCard(cardId) {
  if (selectedCardIds.has(cardId)) {
    selectedCardIds.delete(cardId);
  } else {
    selectedCardIds.add(cardId);
  }
  render();
}

function showMessage(text) {
  message = text;
  render();
}

function clearMessage() {
  message = '';
}

function render() {
  app.innerHTML = `
    <main class="app-shell">
      <header class="top-bar">
        <div>
          <h1>ルール追加型大富豪</h1>
          ${roomState ? `<p class="room-code">部屋 ${escapeHtml(roomState.code)}</p>` : ''}
        </div>
        <div class="connection ${socket?.connected ? 'online' : 'offline'}">
          ${socket?.connected ? '接続中' : '未接続'}
        </div>
      </header>
      ${message ? `<div class="message">${escapeHtml(message)}</div>` : ''}
      ${roomState ? renderRoom() : renderEntrance()}
    </main>
  `;
}

function renderEntrance() {
  return `
    <section class="entrance-grid">
      <form class="panel" data-action="create">
        <h2>部屋を作る</h2>
        <label>
          名前
          <input name="name" maxlength="16" autocomplete="nickname" required />
        </label>
        <button class="primary" type="submit">部屋を作る</button>
      </form>
      <form class="panel" data-action="join">
        <h2>部屋に入る</h2>
        <label>
          名前
          <input name="name" maxlength="16" autocomplete="nickname" required />
        </label>
        <label>
          部屋コード
          <input name="roomCode" maxlength="5" inputmode="latin" autocapitalize="characters" required />
        </label>
        <button class="primary" type="submit">参加する</button>
      </form>
      ${
        session
          ? `<section class="panel reconnect-panel">
              <h2>以前の部屋</h2>
              <p>${escapeHtml(session.roomCode)} に再接続できます。</p>
              <div class="button-row">
                <button data-click="reconnect" type="button">再接続</button>
                <button class="ghost" data-click="forget" type="button">忘れる</button>
              </div>
            </section>`
          : ''
      }
    </section>
  `;
}

function renderRoom() {
  if (roomState.status === 'lobby') {
    return renderLobby();
  }
  return renderGame();
}

function renderLobby() {
  return `
    <section class="status-banner">
      <strong>待機中</strong>
      <span>${roomState.players.length}/4人参加中</span>
    </section>
    <section class="content-grid">
      <div class="main-column">
        ${renderPlayers()}
        ${roomState.isHost ? renderHostSettings() : '<section class="panel"><h2>ホストの開始待ちです</h2></section>'}
      </div>
      <aside class="side-column">
        ${roomState.isHost ? renderRuleBuilder() : ''}
        ${renderRules()}
        ${renderEvents()}
      </aside>
    </section>
  `;
}

function renderGame() {
  return `
    ${renderTurnBanner()}
    <section class="content-grid">
      <div class="main-column">
        ${renderTable()}
        ${renderPendingAction()}
        ${renderHand()}
      </div>
      <aside class="side-column">
        ${renderPlayers()}
        ${roomState.isHost && roomState.status === 'playing' ? renderRuleBuilder() : ''}
        ${renderRules()}
        ${renderEvents()}
      </aside>
    </section>
  `;
}

function renderTurnBanner() {
  const game = roomState.game;
  if (roomState.status === 'finished') {
    return `<section class="status-banner finished"><strong>ゲーム終了</strong><span>順位が確定しました</span></section>`;
  }
  if (game.paused) {
    return `<section class="status-banner paused"><strong>復帰待ち</strong><span>切断中プレイヤーが操作する場面です</span></section>`;
  }
  if (game.pendingAction && !game.pendingAction.waitingForYou) {
    return `<section class="status-banner pending"><strong>特殊ルール処理中</strong><span>${escapeHtml(
      game.pendingAction.actorName || ''
    )}さんの選択待ちです</span></section>`;
  }
  if (game.pendingAction?.waitingForYou) {
    return `<section class="status-banner your-turn"><strong>特殊ルールを選択してください</strong><span>${pendingLabel(
      game.pendingAction
    )}</span></section>`;
  }
  if (game.isYourTurn) {
    return `<section class="status-banner your-turn"><strong>あなたのターンです</strong><span>カードを選んで出すか、パスできます</span></section>`;
  }
  return `<section class="status-banner"><strong>${escapeHtml(
    game.currentPlayerName || ''
  )}さんのターン</strong><span>${escapeHtml(game.directionLabel)}</span></section>`;
}

function renderPlayers() {
  return `
    <section class="panel">
      <h2>プレイヤー</h2>
      <div class="player-list">
        ${roomState.players
          .map((player) => {
            const turn = roomState.game?.currentPlayerId === player.id ? ' turn' : '';
            const you = player.isYou ? ' you' : '';
            return `
              <div class="player-row${turn}${you}">
                <div>
                  <strong>${escapeHtml(player.name)}${player.isYou ? '（あなた）' : ''}</strong>
                  <div class="player-meta">
                    ${player.isHost ? '<span>ホスト</span>' : ''}
                    <span>${player.connected ? '接続中' : '切断中'}</span>
                    ${player.finishedRank ? `<span>${player.finishedRank}位</span>` : ''}
                    ${player.skipTurns ? `<span>スキップ ${player.skipTurns}</span>` : ''}
                    ${player.bindingSuit ? `<span>縛り ${player.bindingSuitLabel}</span>` : ''}
                  </div>
                </div>
                <span class="card-count">${player.cardCount}枚</span>
              </div>
            `;
          })
          .join('')}
      </div>
    </section>
  `;
}

function renderHostSettings() {
  return `
    <section class="panel">
      <h2>ホスト設定</h2>
      <div class="form-grid">
        <label>
          モード
          <select data-setting="mode">
            ${option('normal', '通常', roomState.settings.mode)}
            ${option('chaos', 'カオス', roomState.settings.mode)}
            ${option('mystery', 'ミステリー', roomState.settings.mode)}
          </select>
        </label>
        <label>
          ランダムルール数
          <select data-setting="hiddenRuleCount">
            ${[3, 5, 8, 10].map((count) => option(String(count), `${count}個`, String(roomState.settings.hiddenRuleCount))).join('')}
          </select>
        </label>
      </div>
      <button class="primary" data-click="start" type="button" ${roomState.players.length < 2 ? 'disabled' : ''}>
        ゲーム開始
      </button>
    </section>
  `;
}

function renderTable() {
  const table = roomState.game?.table;
  return `
    <section class="table-area">
      <div class="table-header">
        <h2>場</h2>
        <span>${escapeHtml(roomState.game?.directionLabel || '')}</span>
      </div>
      ${
        table
          ? `<div class="played-cards">
              ${table.cards.map((card) => renderCard(card, false)).join('')}
            </div>
            <p>${escapeHtml(table.playedByName || '')}さん / ${escapeHtml(table.rank)} / ${table.count}枚</p>`
          : '<div class="empty-table">場は空です</div>'
      }
    </section>
  `;
}

function renderPendingAction() {
  const pending = roomState.game?.pendingAction;
  if (!pending?.waitingForYou) return '';

  if (pending.type === 'target') {
    return `
      <section class="pending-panel">
        <h2>対象を選択</h2>
        <div class="button-grid">
          ${pending.eligibleTargets
            .map(
              (target) =>
                `<button data-click="choose-target" data-target-id="${escapeAttr(target.id)}" type="button">
                  ${escapeHtml(target.name)}さん
                  <span>${target.cardCount}枚</span>
                </button>`
            )
            .join('')}
        </div>
      </section>
    `;
  }

  if (pending.type === 'giftCard') {
    const hand = ownPlayer()?.hand || [];
    return `
      <section class="pending-panel">
        <h2>${escapeHtml(pending.targetName || '')}さんへ渡すカード</h2>
        <div class="hand-grid compact">
          ${hand
            .map(
              (card) =>
                `<button class="card-button ${cardClass(card)}" data-click="gift-card" data-card-id="${escapeAttr(
                  card.id
                )}" type="button">${escapeHtml(card.label)}</button>`
            )
            .join('')}
        </div>
      </section>
    `;
  }

  return '';
}

function renderHand() {
  const player = ownPlayer();
  const hand = player?.hand || [];
  const game = roomState.game;
  const disabled = !game?.isYourTurn || game?.paused || Boolean(game?.pendingAction) || roomState.status !== 'playing';

  return `
    <section class="hand-area">
      <div class="hand-header">
        <h2>手札</h2>
        <span>${selectedCardIds.size}枚選択中</span>
      </div>
      <div class="hand-grid">
        ${hand
          .map((card) => {
            const selected = selectedCardIds.has(card.id) ? ' selected' : '';
            return `<button class="card-button ${cardClass(card)}${selected}" data-click="select-card" data-card-id="${escapeAttr(
              card.id
            )}" type="button" ${disabled ? 'disabled' : ''}>${escapeHtml(card.label)}</button>`;
          })
          .join('')}
      </div>
      <div class="action-bar">
        <button class="primary" data-click="play" type="button" ${disabled || selectedCardIds.size === 0 ? 'disabled' : ''}>
          出す
        </button>
        <button data-click="pass" type="button" ${disabled || !game?.table ? 'disabled' : ''}>パス</button>
      </div>
    </section>
  `;
}

function renderRuleBuilder() {
  normalizeRuleDraftTarget();
  const targets = EFFECT_TARGETS[ruleDraft.effect] || ['none'];
  const showTarget = !(targets.length === 1 && targets[0] === 'none');
  const validation = validateRuleDraft();

  return `
    <section class="panel">
      <h2>特殊ルール追加</h2>
      <div class="form-grid">
        <label>
          数字
          <select data-rule-field="rank">
            <option value="">指定なし</option>
            ${RANKS.map((rank) => option(rank, rank, ruleDraft.condition.rank)).join('')}
          </select>
        </label>
        <label>
          スート
          <select data-rule-field="suit">
            <option value="">指定なし</option>
            ${SUITS.map(([id, symbol]) => option(id, symbol, ruleDraft.condition.suit)).join('')}
          </select>
        </label>
        <label>
          枚数
          <select data-rule-field="count">
            <option value="">指定なし</option>
            ${[1, 2, 3, 4].map((count) => option(String(count), `${count}枚`, String(ruleDraft.condition.count))).join('')}
          </select>
        </label>
        <label>
          効果
          <select data-rule-field="effect">
            ${EFFECTS.map(([id, label]) => option(id, label, ruleDraft.effect)).join('')}
          </select>
        </label>
        ${
          showTarget
            ? `<label>
                対象
                <select data-rule-field="target">
                  ${targets.map((target) => option(target, TARGET_LABELS[target], ruleDraft.target)).join('')}
                </select>
              </label>`
            : ''
        }
      </div>
      <div class="rule-preview ${validation.ok ? '' : 'invalid'}">${escapeHtml(validation.message || previewRule())}</div>
      <button data-click="add-rule" type="button" ${validation.ok ? '' : 'disabled'}>追加</button>
    </section>
  `;
}

function renderRules() {
  return `
    <section class="panel">
      <h2>特殊ルール</h2>
      ${
        roomState.rules.length
          ? `<div class="rule-list">
              ${roomState.rules
                .map(
                  (rule) =>
                    `<div class="rule-row ${rule.hidden ? 'hidden-rule' : ''}">
                      <span>${escapeHtml(rule.description)}</span>
                      ${rule.generated ? '<small>ランダム</small>' : ''}
                    </div>`
                )
                .join('')}
            </div>`
          : '<p class="muted">まだありません</p>'
      }
    </section>
  `;
}

function renderEvents() {
  return `
    <section class="panel">
      <h2>直近の出来事</h2>
      ${
        roomState.recentEvents.length
          ? `<ol class="event-list">
              ${roomState.recentEvents.map((event) => `<li>${escapeHtml(event.text)}</li>`).join('')}
            </ol>`
          : '<p class="muted">まだありません</p>'
      }
    </section>
  `;
}

function renderCard(card) {
  return `<span class="card-face ${cardClass(card)}">${escapeHtml(card.label)}</span>`;
}

function cardClass(card) {
  if (card.joker) return 'joker';
  return card.suit === 'H' || card.suit === 'D' ? 'red' : 'black';
}

function ownPlayer() {
  return roomState?.players.find((player) => player.isYou) || null;
}

function normalizeRuleDraftTarget() {
  const targets = EFFECT_TARGETS[ruleDraft.effect] || ['none'];
  if (!targets.includes(ruleDraft.target)) {
    ruleDraft.target = targets[0];
  }
  if (targets.length === 1 && targets[0] === 'none') {
    ruleDraft.target = 'none';
  }
}

function previewRule() {
  const conditionParts = [];
  if (ruleDraft.condition.suit) {
    conditionParts.push(SUITS.find(([id]) => id === ruleDraft.condition.suit)?.[1] || '');
  }
  if (ruleDraft.condition.rank) {
    conditionParts.push(ruleDraft.condition.rank);
  }

  let conditionText = conditionParts.join('');
  if (ruleDraft.condition.count) {
    conditionText = conditionText
      ? `${conditionText}を含む${ruleDraft.condition.count}枚出し`
      : `${ruleDraft.condition.count}枚出し`;
  } else if (conditionText) {
    conditionText = `${conditionText}を出した時`;
  } else {
    conditionText = '条件を選んでください';
  }

  const effect = EFFECTS.find(([id]) => id === ruleDraft.effect)?.[1] || '';
  if (ruleDraft.target === 'none') {
    return `${conditionText} → ${effect}`;
  }
  return `${conditionText} → ${TARGET_LABELS[ruleDraft.target]} → ${effect}`;
}

function validateRuleDraft() {
  if (!ruleDraft.condition.rank && !ruleDraft.condition.suit && !ruleDraft.condition.count) {
    return { ok: false, message: '条件を1つ以上選んでください' };
  }
  if (ruleDraft.effect === 'bindSuit' && !ruleDraft.condition.suit) {
    return { ok: false, message: '縛りはスート条件を選んでください' };
  }
  return { ok: true, message: '' };
}

function pendingLabel(pending) {
  if (pending.type === 'target') return '対象プレイヤーを選んでください';
  if (pending.type === 'giftCard') return '渡すカードを1枚選んでください';
  return '選択してください';
}

function option(value, label, selected) {
  return `<option value="${escapeAttr(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${escapeHtml(
    label
  )}</option>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}
