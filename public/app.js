const STORAGE_KEY = 'rule-chaos-daifugo-session';

const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', 'JOKER'];
const NORMAL_RANKS = RANKS.filter((rank) => rank !== 'JOKER');
const SUITS = [
  ['S', '♠'],
  ['H', '♥'],
  ['D', '♦'],
  ['C', '♣']
];
const CONNECTORS = [
  { id: 'SELF', level: 1, label: '自分', shortLabel: 'SELF' },
  { id: 'NEXT', level: 2, label: '次', shortLabel: 'NEXT' },
  { id: 'CHOICE', level: 3, label: '任意', shortLabel: 'CHOICE' },
  { id: 'GLOBAL', level: 4, label: '全体', shortLabel: 'GLOBAL' }
];
const CONDITION_POWER = {
  rank: 2,
  jokerRank: 3,
  suit: 1,
  rankRelationPlusOne: 2,
  suitRelationSame: 2,
  counts: { 1: 1, 2: 2, 3: 3, 4: 4 },
  max: 4
};
const TARGETS = {
  none: { id: 'none', label: '対象なし', connector: 'GLOBAL' },
  self: { id: 'self', label: '自分', connector: 'SELF' },
  next: { id: 'next', label: '次のプレイヤー', connector: 'NEXT' },
  any: { id: 'any', label: '任意のプレイヤー', connector: 'CHOICE' },
  all: { id: 'all', label: '全員', connector: 'GLOBAL' }
};
const EFFECT_CONFIGS = {
  skip: {
    label: 'スキップ',
    connectors: ['SELF', 'NEXT', 'CHOICE'],
    targets: ['self', 'next', 'any']
  },
  bindSuit: {
    label: 'スート縛り',
    connectors: ['SELF', 'NEXT', 'CHOICE', 'GLOBAL'],
    targets: ['self', 'next', 'any', 'all']
  },
  bindRank: {
    label: '数字縛り',
    connectors: ['SELF', 'NEXT', 'CHOICE', 'GLOBAL'],
    targets: ['self', 'next', 'any', 'all']
  },
  reverse: {
    label: 'リバース',
    connectors: ['GLOBAL'],
    targets: ['none'],
    fixedTarget: 'none',
    fixedTargetLabel: '全体'
  },
  clear: {
    label: '流す',
    connectors: ['GLOBAL'],
    targets: ['none'],
    fixedTarget: 'none',
    fixedTargetLabel: '場'
  },
  gift: {
    label: '渡す',
    connectors: ['NEXT', 'CHOICE'],
    targets: ['next', 'any']
  }
};
const EFFECTS = Object.entries(EFFECT_CONFIGS).map(([id, config]) => [id, config.label]);
const TARGET_LABELS = Object.fromEntries(Object.entries(TARGETS).map(([id, target]) => [id, target.label]));
const EFFECT_TARGETS = Object.fromEntries(
  Object.entries(EFFECT_CONFIGS).map(([id, config]) => [id, config.targets])
);
const USER_TARGET_IDS = ['self', 'next', 'any', 'all'];
const RULE_PREDICTION_BY_MODE = {
  normal: true,
  chaos: true,
  mystery: false
};
const PLAY_REASON_BY_MODE = {
  normal: true,
  chaos: true,
  mystery: true
};
const PLAYER_STATE_DISPLAY_BY_MODE = {
  normal: 'full',
  chaos: 'full',
  mystery: 'full'
};
const RULE_ACTIVATION_NOTIFICATION_MS = {
  single: 3500,
  few: 4300,
  many: 5200,
  pendingAction: 6000,
  maxItems: 6
};

let socket = null;
let session = loadSession();
let roomState = null;
let selectedCardIds = new Set();
let selectedGiftCardIds = new Set();
let selectedDiscardCardIds = new Set();
let seenEventIds = new Set();
let ruleNotices = [];
let ruleNoticeTimer = null;
let showRulesHelp = false;
let showEventHistory = false;
let eventHistoryFilter = 'all';
let message = '';
let ruleDraft = {
  condition: { rank: '', suit: '', count: '', rankRelation: '', suitRelation: '' },
  target: 'next',
  effect: 'skip',
  effectConfig: { bindRank: '' }
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
    collectRuleNotices(nextState);
    roomState = nextState;
    trimSelectedCards();
    trimSelectedGiftCards();
    trimSelectedDiscardCards();
    render();
  });

  socket.on('errorMessage', (error) => {
    showMessage(error);
  });

  socket.on('leftRoom', () => {
    leaveLocalRoom('退出しました');
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
    leaveLocalRoom('');
  }
  if (action === 'leave') {
    const isInMatch = roomState && !['lobby', 'matchResult', 'finished'].includes(roomState.status);
    if (isInMatch && !window.confirm('途中退出するとこのゲームには戻れません。退出しますか？')) {
      return;
    }
    emitAuthed('leaveRoom', {}, () => {
      leaveLocalRoom('退出しました');
    });
  }
  if (action === 'toggle-rules-help') {
    showRulesHelp = !showRulesHelp;
    render();
  }
  if (action === 'close-rules-help') {
    showRulesHelp = false;
    render();
  }
  if (action === 'open-event-history') {
    showEventHistory = true;
    render();
  }
  if (action === 'close-event-history') {
    showEventHistory = false;
    render();
  }
  if (action === 'set-event-filter') {
    eventHistoryFilter = button.dataset.filter || 'all';
    render();
  }
  if (action === 'end-game') {
    if (!window.confirm('現在のゲームを終了してロビーに戻りますか？')) {
      return;
    }
    emitAuthed('endGame', {});
  }
  if (action === 'start') {
    emitAuthed('startGame', {});
  }
  if (action === 'begin-rule-building') {
    emitAuthed('beginRuleBuilding', {});
  }
  if (action === 'restart-match') {
    emitAuthed('restartMatch', {});
  }
  if (action === 'copy-room-code') {
    copyRoomCode();
  }
  if (action === 'set-rule-target') {
    if (button.dataset.disabled === 'true') {
      showMessage(button.dataset.reason || 'この対象は現在の条件では接続できません');
      return;
    }
    ruleDraft.target = button.dataset.target;
    render();
  }
  if (action === 'set-rule-effect') {
    if (button.dataset.disabled === 'true') {
      showMessage(button.dataset.reason || 'この効果は現在の条件・対象では接続できません');
      return;
    }
    ruleDraft.effect = button.dataset.effect;
    ruleDraft.effectConfig = ruleDraft.effectConfig || { bindRank: '' };
    if (ruleDraft.effect !== 'bindRank') {
      ruleDraft.effectConfig.bindRank = '';
    }
    normalizeRuleDraftTarget(true);
    render();
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
  if (action === 'select-gift-card') {
    toggleGiftCard(button.dataset.cardId, Number(button.dataset.requiredCount || 1));
  }
  if (action === 'confirm-gift-card') {
    const pending = roomState?.game?.pendingAction;
    emitAuthed('chooseTransferCard', {
      pendingId: pending?.id,
      cardIds: [...selectedGiftCardIds]
    }, () => {
      selectedGiftCardIds.clear();
    });
  }
  if (action === 'select-discard-card') {
    toggleDiscardCard(button.dataset.cardId, Number(button.dataset.requiredCount || 1));
  }
  if (action === 'confirm-discard-card') {
    const pending = roomState?.game?.pendingAction;
    emitAuthed('chooseDiscardCards', {
      pendingId: pending?.id,
      cardIds: [...selectedDiscardCardIds]
    }, () => {
      selectedDiscardCardIds.clear();
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
      if (fieldName === 'rank' && field.value === 'JOKER') {
        ruleDraft.condition.suit = '';
      }
    } else if (fieldName === 'rankRelation' || fieldName === 'suitRelation') {
      ruleDraft.condition[fieldName] = field.checked ? field.value : '';
    } else if (fieldName === 'bindRankValue') {
      ruleDraft.effectConfig.bindRank = field.value;
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
      hiddenRuleCount: roomState.settings.hiddenRuleCount,
      roundCount: roomState.settings.roundCount,
      bindingMode: roomState.settings.bindingMode,
      localRules: { ...(roomState.settings.localRules || {}) }
    };
    const settingName = field.dataset.setting;
    if (settingName.startsWith('localRules.')) {
      settings.localRules[settingName.split('.')[1]] = field.checked;
    } else {
      settings[settingName] = field.value;
      if (settingName === 'mode') {
        settings.bindingMode = field.value === 'chaos' ? 'chaos' : 'standard';
      }
    }
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
        count: ruleDraft.condition.count || null,
        rankRelation: ruleDraft.condition.rankRelation || null,
        suitRelation: ruleDraft.condition.suitRelation || null
      },
      target: ruleDraft.target,
      effect: ruleDraft.effect,
      effectConfig: { ...ruleDraft.effectConfig }
    }
  }, () => {
    resetRuleDraft();
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

function leaveLocalRoom(text) {
  session = null;
  roomState = null;
  selectedCardIds.clear();
  selectedGiftCardIds.clear();
  selectedDiscardCardIds.clear();
  ruleNotices = [];
  seenEventIds.clear();
  showEventHistory = false;
  eventHistoryFilter = 'all';
  localStorage.removeItem(STORAGE_KEY);
  message = text;
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

function trimSelectedGiftCards() {
  const ownHand = roomState?.players.find((player) => player.isYou)?.hand || [];
  const validIds = new Set(ownHand.map((card) => card.id));
  selectedGiftCardIds = new Set([...selectedGiftCardIds].filter((id) => validIds.has(id)));
}

function trimSelectedDiscardCards() {
  const ownHand = roomState?.players.find((player) => player.isYou)?.hand || [];
  const validIds = new Set(ownHand.map((card) => card.id));
  selectedDiscardCardIds = new Set([...selectedDiscardCardIds].filter((id) => validIds.has(id)));
}

function toggleSelectedCard(cardId) {
  if (selectedCardIds.has(cardId)) {
    selectedCardIds.delete(cardId);
  } else {
    selectedCardIds.add(cardId);
  }
  render();
}

function toggleGiftCard(cardId, requiredCount = 1) {
  if (selectedGiftCardIds.has(cardId)) {
    selectedGiftCardIds.delete(cardId);
  } else {
    selectedGiftCardIds = new Set([cardId, ...selectedGiftCardIds].slice(0, requiredCount));
  }
  render();
}

function toggleDiscardCard(cardId, requiredCount = 1) {
  if (selectedDiscardCardIds.has(cardId)) {
    selectedDiscardCardIds.delete(cardId);
  } else {
    selectedDiscardCardIds = new Set([cardId, ...selectedDiscardCardIds].slice(0, requiredCount));
  }
  render();
}

function collectRuleNotices(nextState) {
  const incomingEvents = nextState?.recentEvents || [];
  if (seenEventIds.size === 0) {
    seenEventIds = new Set(incomingEvents.map((event) => event.id));
    return;
  }

  const newRuleEvents = [...incomingEvents]
    .reverse()
    .filter((event) => isRuleNoticeEvent(event) && !seenEventIds.has(event.id));

  for (const event of incomingEvents) {
    seenEventIds.add(event.id);
  }
  if (seenEventIds.size > 80) {
    seenEventIds = new Set([...seenEventIds].slice(-80));
  }

  if (newRuleEvents.length === 0) {
    return;
  }

  ruleNotices = newRuleEvents.slice(-RULE_ACTIVATION_NOTIFICATION_MS.maxItems);
  window.clearTimeout(ruleNoticeTimer);
  ruleNoticeTimer = window.setTimeout(() => {
    ruleNotices = [];
    render();
  }, ruleNoticeDuration(ruleNotices.length, nextState));
}

function isRuleNoticeEvent(event) {
  const text = String(event.text || '');
  return event.type === 'rule' && (text.includes(':') || text.includes('隠しルールが発動'));
}

function ruleNoticeDuration(count, state) {
  if (state?.game?.pendingAction) {
    return RULE_ACTIVATION_NOTIFICATION_MS.pendingAction;
  }
  if (count >= 4) return RULE_ACTIVATION_NOTIFICATION_MS.many;
  if (count >= 2) return RULE_ACTIVATION_NOTIFICATION_MS.few;
  return RULE_ACTIVATION_NOTIFICATION_MS.single;
}

function showMessage(text) {
  message = text;
  render();
}

function clearMessage() {
  message = '';
}

async function copyRoomCode() {
  const code = roomState?.code;
  if (!code) return;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(code);
    } else {
      copyTextFallback(code);
    }
    showMessage(`部屋コード ${code} をコピーしました`);
  } catch (_error) {
    copyTextFallback(code);
    showMessage(`部屋コード ${code} をコピーしました`);
  }
}

function copyTextFallback(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function render() {
  app.innerHTML = `
    <main class="app-shell">
      <header class="top-bar">
        <div>
          <h1>ルール追加型大富豪</h1>
          ${roomState ? renderRoomCode() : ''}
        </div>
        <div class="top-actions">
          <button class="ghost" data-click="toggle-rules-help" type="button">ルール説明</button>
          ${roomState?.isHost && roomState.status !== 'lobby' ? '<button class="ghost danger" data-click="end-game" type="button">ゲーム終了</button>' : ''}
          ${roomState ? '<button class="ghost danger" data-click="leave" type="button">退出</button>' : ''}
          <div class="connection ${socket?.connected ? 'online' : 'offline'}">
            ${socket?.connected ? '接続中' : '未接続'}
          </div>
        </div>
      </header>
      ${message ? `<div class="message">${escapeHtml(message)}</div>` : ''}
      ${renderRuleNotices()}
      ${showRulesHelp ? renderRulesHelp() : ''}
      ${roomState ? renderRoom() : renderEntrance()}
      ${showEventHistory ? renderEventHistoryModal() : ''}
    </main>
  `;
}

function renderRoomCode() {
  return `
    <div class="room-code-line">
      <span class="room-code">部屋 ${escapeHtml(roomState.code)}</span>
      <button class="copy-code-button" data-click="copy-room-code" type="button">コピー</button>
    </div>
  `;
}

function renderRuleNotices() {
  if (ruleNotices.length === 0) return '';

  return `
    <section class="rule-notice">
      <strong>${ruleNotices.length > 1 ? `${ruleNotices.length}件のルール発動！` : '特殊ルール発動！'}</strong>
      <ul>
        ${ruleNotices.map((event) => `<li>${escapeHtml(event.text)}</li>`).join('')}
      </ul>
    </section>
  `;
}

function renderRulesHelp() {
  return `
    <section class="rules-help">
      <div class="table-header">
        <h2>ルール説明</h2>
        <button class="ghost" data-click="close-rules-help" type="button">閉じる</button>
      </div>
      <div class="help-grid">
        <div>
          <h3>基本</h3>
          <ul>
            <li>強さは 3 から 2 まで。通常カードでは 2 が最強です。</li>
            <li>JOKER単体は2より強く、JOKER2枚は2のペアより強いです。</li>
            <li>JOKERを通常カードと一緒に出すと、その数字を補います。JOKERにスートはありません。</li>
            <li>場がある時は同じ枚数で、より強い組を出します。出したくなければパスできます。</li>
            <li>手札をなくした順にラウンド順位が決まります。</li>
          </ul>
        </div>
        <div>
          <h3>特殊ルール</h3>
          <ul>
            <li>ラウンド終了ごとに各プレイヤーが特殊ルールを1つ追加します。</li>
            <li>追加したルールは次ラウンド以降も残ります。</li>
            <li>条件、対象、効果をパズルのように組み合わせます。</li>
            <li>強い対象や効果ほど、厳しい条件Powerが必要です。</li>
          </ul>
        </div>
        <div>
          <h3>ローカルルール</h3>
          ${
            roomState?.localRules?.length
              ? `<ul>${roomState.localRules
                  .map((rule) => `<li>${escapeHtml(rule.label)}: ${escapeHtml(rule.description)}</li>`)
                  .join('')}</ul>`
              : '<p class="muted">現在ONのローカルルールはありません。</p>'
          }
        </div>
      </div>
    </section>
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
  if (roomState.status === 'playing') {
    return renderGame();
  }
  if (roomState.status === 'roundResult') {
    return renderRoundResultPhase();
  }
  if (roomState.status === 'ruleBuilding') {
    return renderRuleBuildingPhase();
  }
  if (roomState.status === 'matchResult' || roomState.status === 'finished') {
    return renderMatchResultPhase();
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
        ${renderMatchSummary()}
        ${renderTable()}
        ${renderPendingAction()}
        ${renderHand()}
      </div>
      <aside class="side-column">
        ${renderPlayers()}
        ${renderRules()}
        ${renderEvents()}
      </aside>
    </section>
  `;
}

function renderRoundResultPhase() {
  const match = roomState.match;
  const latest = match?.latestRoundResult;
  return `
    <section class="status-banner finished">
      <strong>第${latest?.round || match?.currentRound || ''}ラウンド終了</strong>
      <span>結果を確認してからルール追加フェーズへ進みます</span>
    </section>
    <section class="content-grid">
      <div class="main-column">
        ${renderRoundResult(latest)}
        ${renderScoreBoard()}
        ${
          roomState.isHost
            ? '<button class="primary" data-click="begin-rule-building" type="button">ルール追加フェーズへ</button>'
            : '<section class="panel"><h2>ホストの進行待ちです</h2></section>'
        }
      </div>
      <aside class="side-column">
        ${renderPlayers()}
        ${renderRules()}
        ${renderEvents()}
      </aside>
    </section>
  `;
}

function renderRuleBuildingPhase() {
  const builder = roomState.match?.ruleBuilding;
  const builderName = builder?.currentPlayerName || '';
  return `
    <section class="status-banner pending">
      <strong>第${builder?.afterRound || ''}ラウンド後のルール追加フェーズ</strong>
      <span>${escapeHtml(builderName)}さんがルールを作成中です</span>
    </section>
    <section class="content-grid rule-building-layout">
      <div class="main-column">
        ${
          builder?.isYourTurn
            ? renderRuleBuilder()
            : `<section class="panel">
                <h2>ルール追加待ち</h2>
                <p>${escapeHtml(builderName)}さんの追加完了を待っています。</p>
              </section>`
        }
        ${renderScoreBoard()}
      </div>
      <aside class="side-column">
        ${renderPlayers()}
        ${renderRules()}
        ${renderEvents()}
      </aside>
    </section>
  `;
}

function renderMatchResultPhase() {
  return `
    <section class="status-banner finished">
      <strong>マッチ終了</strong>
      <span>${escapeHtml(roomState.match?.totalRounds || '')}ラウンドの最終結果です</span>
    </section>
    <section class="content-grid">
      <div class="main-column">
        ${renderFinalResults()}
        ${renderScoreBoard()}
        ${roomState.isHost ? '<button class="primary" data-click="restart-match" type="button">もう一度遊ぶ</button>' : ''}
      </div>
      <aside class="side-column">
        ${renderRules()}
        ${renderEvents()}
      </aside>
    </section>
  `;
}

function renderMatchSummary() {
  const match = roomState.match;
  if (!match) return '';
  return `
    <section class="panel compact-panel">
      <div class="table-header">
        <h2>第${match.currentRound}/${match.totalRounds}ラウンド</h2>
        <span>親: ${escapeHtml(roomState.game?.roundLeaderName || '')}</span>
      </div>
      ${renderScoreRows(true)}
    </section>
  `;
}

function renderScoreBoard() {
  return `
    <section class="panel">
      <h2>累積ポイント</h2>
      ${renderScoreRows(false)}
    </section>
  `;
}

function renderScoreRows(compact) {
  const players = [...roomState.players].sort((a, b) => {
    const scoreDiff = (b.score || 0) - (a.score || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return a.name.localeCompare(b.name, 'ja');
  });

  return `
    <div class="score-list ${compact ? 'compact' : ''}">
      ${players
        .map(
          (player) => `
            <div class="score-row">
              <strong>${escapeHtml(player.name)}${player.isYou ? '（あなた）' : ''}</strong>
              <span>${player.score || 0}pt</span>
              <small>${formatRoundRanks(player.roundRanks)}</small>
            </div>
          `
        )
        .join('')}
    </div>
  `;
}

function renderRoundResult(result) {
  if (!result) {
    return '<section class="panel"><h2>ラウンド結果</h2><p class="muted">結果がありません</p></section>';
  }

  return `
    <section class="panel">
      <h2>第${result.round}ラウンド結果</h2>
      <div class="result-list">
        ${result.rankings
          .map(
            (entry) => `
              <div class="result-row">
                <strong>${entry.rank}位：${escapeHtml(entry.name)}</strong>
                <span>+${entry.points}pt</span>
              </div>
            `
          )
          .join('')}
      </div>
    </section>
  `;
}

function renderFinalResults() {
  const finalResults = roomState.match?.finalResults || [];
  return `
    <section class="panel">
      <h2>最終結果</h2>
      <div class="result-list final">
        ${finalResults
          .map(
            (entry) => `
              <div class="result-row">
                <strong>${entry.finalRank}位：${escapeHtml(entry.name)}</strong>
                <span>${entry.points}pt</span>
                <small>${formatRoundRanks(entry.roundRanks)}</small>
              </div>
            `
          )
          .join('')}
      </div>
    </section>
  `;
}

function renderTurnBanner() {
  const game = roomState.game;
  const roundLabel = roomState.match ? `第${roomState.match.currentRound}/${roomState.match.totalRounds}ラウンド` : '';
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
    const availability = game.turnAvailability || {};
    const actionText = availability.noLegalPlay
      ? availability.passReason || '出せるカードがありません'
      : availability.canPass
        ? 'カードを選んで出すか、パスできます'
        : '場を開始するカードを出してください';
    return `<section class="status-banner your-turn"><strong>${availability.noLegalPlay ? '出せるカードがありません' : 'あなたの番です'}</strong><span>${escapeHtml(
      `${roundLabel} / ${actionText}`
    )}</span></section>`;
  }
  return `<section class="status-banner"><strong>${escapeHtml(
    game.currentPlayerName || ''
  )}さんの番です</strong><span>${escapeHtml(`${roundLabel} / ${game.directionLabel}`)}</span></section>`;
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
                    ${player.isRoundLeader ? '<span>親</span>' : ''}
                    <span>${player.left ? '退出' : player.connected ? '接続中' : '切断中'}</span>
                    ${roomState.match ? `<span>${player.score || 0}pt</span>` : ''}
                    ${player.finishedRank ? `<span>${player.finishedRank}位</span>` : ''}
                  </div>
                  ${renderPlayerStateBadges(player)}
                  ${renderSpectatorHand(player)}
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

function renderPlayerStateBadges(player) {
  if (PLAYER_STATE_DISPLAY_BY_MODE[roomState.settings?.mode] === 'hidden') {
    return '';
  }

  const badges = [];
  if (player.actionBlocked) {
    badges.push({ label: '行動不能', detail: player.actionStatusText || '出せるカードがありません', className: 'blocked' });
  }
  if (player.skipTurns) {
    badges.push({ label: `スキップ ${player.skipTurns}`, detail: '次の行動機会を飛ばします', className: 'skip' });
  }
  for (const binding of player.bindings || []) {
    badges.push({ label: binding.label, detail: '次の実際の行動後に解除', className: 'binding' });
  }

  if (badges.length === 0) {
    return '';
  }

  return `
    <div class="state-badges" aria-label="${escapeAttr(player.name)}さんの現在の状態">
      ${badges
        .map(
          (badge) => `
            <span class="state-badge ${escapeAttr(badge.className)}" title="${escapeAttr(badge.detail)}">
              <strong>${escapeHtml(badge.label)}</strong>
              <small>${escapeHtml(badge.detail)}</small>
            </span>
          `
        )
        .join('')}
    </div>
  `;
}

function renderSpectatorHand(player) {
  if (player.isYou || !Array.isArray(player.hand) || player.hand.length === 0) {
    return '';
  }

  return `
    <div class="spectator-hand">
      ${player.hand.map((card) => renderCard(card)).join('')}
    </div>
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
        <label>
          ラウンド数
          <select data-setting="roundCount">
            ${[3, 4, 5].map((count) => option(String(count), `${count}ラウンド`, String(roomState.settings.roundCount || 4))).join('')}
          </select>
        </label>
        <label>
          縛りの競合
          <select data-setting="bindingMode">
            ${option('standard', '標準（同種は上書き）', roomState.settings.bindingMode || 'standard')}
            ${option('chaos', 'カオス（同種もAND）', roomState.settings.bindingMode || 'standard')}
          </select>
        </label>
      </div>
      <div class="local-rule-settings">
        <h3>ローカルルール</h3>
        <div class="setting-check-grid">
          ${(roomState.localRuleOptions || [])
            .map((rule) => {
              const checked = roomState.settings.localRules?.[rule.id] ? 'checked' : '';
              return `
                <label class="setting-check">
                  <input data-setting="localRules.${escapeAttr(rule.id)}" type="checkbox" ${checked} />
                  <span>
                    <strong>${escapeHtml(rule.label)}</strong>
                    <small>${escapeHtml(rule.description)}</small>
                  </span>
                </label>
              `;
            })
            .join('')}
        </div>
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
    const requiredCount = pending.requiredCount || 1;
    const selectedCount = selectedGiftCardIds.size;
    return `
      <section class="pending-panel">
        <h2>${escapeHtml(pending.targetName || '')}さんへ渡すカード</h2>
        <p class="selection-counter">選択済み: ${selectedCount} / ${requiredCount}</p>
        <div class="hand-grid compact">
          ${hand
            .map((card) => {
              const selected = selectedGiftCardIds.has(card.id) ? ' selected' : '';
              return `<button class="card-button ${cardClass(card)}${selected}" data-click="select-gift-card" data-card-id="${escapeAttr(
                card.id
              )}" data-required-count="${requiredCount}" type="button">${escapeHtml(card.label)}</button>`;
            })
            .join('')}
        </div>
        <button class="primary" data-click="confirm-gift-card" type="button" ${selectedCount === requiredCount ? '' : 'disabled'}>
          選んだカードを渡す
        </button>
      </section>
    `;
  }

  if (pending.type === 'discardCard') {
    const hand = ownPlayer()?.hand || [];
    const requiredCount = pending.requiredCount || 1;
    const selectedCount = selectedDiscardCardIds.size;
    return `
      <section class="pending-panel">
        <h2>捨てるカード</h2>
        <p class="selection-counter">選択済み: ${selectedCount} / ${requiredCount}</p>
        <div class="hand-grid compact">
          ${hand
            .map((card) => {
              const selected = selectedDiscardCardIds.has(card.id) ? ' selected' : '';
              return `<button class="card-button ${cardClass(card)}${selected}" data-click="select-discard-card" data-card-id="${escapeAttr(
                card.id
              )}" data-required-count="${requiredCount}" type="button">${escapeHtml(card.label)}</button>`;
            })
            .join('')}
        </div>
        <button class="primary" data-click="confirm-discard-card" type="button" ${selectedCount === requiredCount ? '' : 'disabled'}>
          選んだカードを捨てる
        </button>
      </section>
    `;
  }

  return '';
}

function renderHand() {
  const player = ownPlayer();
  const hand = player?.hand || [];
  const game = roomState.game;
  const availability = game?.turnAvailability || {};
  const disabled =
    player?.left || !game?.isYourTurn || game?.paused || Boolean(game?.pendingAction) || roomState.status !== 'playing';
  const cardsDisabled = disabled || Boolean(game?.isYourTurn && availability.noLegalPlay);
  const selectedValidation = validateSelectedPlayPreview();
  const selectedPlayBlocked = selectedCardIds.size > 0 && !selectedValidation.legal;

  return `
    <section class="hand-area ${game?.isYourTurn && !game?.pendingAction ? 'your-turn-hand' : ''}">
      <div class="hand-header">
        <h2>手札</h2>
        <span>${selectedCardIds.size}枚選択中</span>
      </div>
      ${renderTurnConstraintNotice(availability)}
      <div class="hand-grid">
        ${hand
          .map((card) => {
            const selected = selectedCardIds.has(card.id) ? ' selected' : '';
            return `<button class="card-button ${cardClass(card)}${selected}" data-click="select-card" data-card-id="${escapeAttr(
              card.id
            )}" type="button" ${cardsDisabled ? 'disabled' : ''}>${escapeHtml(card.label)}</button>`;
          })
          .join('')}
      </div>
      ${renderHandRulePrediction()}
      ${renderSelectedPlayReasons(selectedValidation)}
      <div class="action-bar">
        <button class="primary" data-click="play" type="button" ${
          disabled || availability.noLegalPlay || selectedCardIds.size === 0 || selectedPlayBlocked ? 'disabled' : ''
        }>
          出す
        </button>
        <button data-click="pass" type="button" ${disabled || !availability.canPass ? 'disabled' : ''}>パス</button>
      </div>
    </section>
  `;
}

function renderSelectedPlayReasons(validation) {
  if (
    !showPlayReasonsForMode(roomState?.settings?.mode) ||
    selectedCardIds.size === 0 ||
    validation.legal ||
    !roomState.game?.isYourTurn ||
    roomState.game?.pendingAction ||
    roomState.game?.paused
  ) {
    return '';
  }

  return `
    <div class="selected-play-reasons" aria-live="polite">
      <strong>この組み合わせは出せません</strong>
      <ul>
        ${validation.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}
      </ul>
    </div>
  `;
}

function showPlayReasonsForMode(mode) {
  return Boolean(PLAY_REASON_BY_MODE[mode]);
}

function renderHandRulePrediction() {
  if (
    roomState.status !== 'playing' ||
    !roomState.game?.isYourTurn ||
    roomState.game?.pendingAction ||
    roomState.game?.paused
  ) {
    return '';
  }

  const prediction = previewTriggeredRules();
  if (prediction.length === 0) {
    return '';
  }

  return `
    <div class="hand-rule-prediction" aria-live="polite">
      <div class="prediction-heading">
        <strong>このプレイで${prediction.length}ルール発動予定</strong>
        <span>発動予定</span>
      </div>
      <ol class="prediction-list">
        ${prediction
          .map(
            (rule) => `
              <li>
                <span>${escapeHtml(rule.prediction)}</span>
                <small>${escapeHtml(rule.sourceText)}</small>
              </li>
            `
          )
          .join('')}
      </ol>
    </div>
  `;
}

function renderTurnConstraintNotice(availability) {
  if (!roomState.game?.isYourTurn) return '';

  const labels = availability.bindingLabels || [];
  const shouldExplainEmptyPass = availability.tableIsEmpty && availability.canPass && labels.length > 0;
  if (!availability.noLegalPlay && !shouldExplainEmptyPass) return '';

  const title = availability.noLegalPlay ? '出せるカードがありません' : '縛りをパスで解除できます';
  const reason =
    availability.passReason ||
    (labels.length > 0 ? '縛り条件を満たす手がありません' : '場に出せる手がありません');

  return `
    <div class="turn-constraint-notice">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(reason)}</span>
      ${
        labels.length > 0
          ? `<ul>${labels.map((label) => `<li>${escapeHtml(label)}</li>`).join('')}</ul>`
          : ''
      }
    </div>
  `;
}

function renderRuleBuilder() {
  ruleDraft.effectConfig = ruleDraft.effectConfig || { bindRank: '' };
  normalizeRuleDraftTarget();
  const power = calculateConditionPower(ruleDraft.condition);
  const target = getDraftTarget();
  const selectedConnector = target?.connector || 'GLOBAL';
  const validation = validateRuleDraft();
  const jokerCondition = ruleDraft.condition.rank === 'JOKER';

  return `
    <section class="panel rule-builder-panel">
      <h2>特殊ルール追加</h2>
      <div class="puzzle-builder">
        <section class="puzzle-piece condition-piece">
          <div class="piece-heading">
            <span><span class="piece-icon">#</span> 条件</span>
            <strong>Power ${power}</strong>
          </div>
          <div class="form-grid compact-form">
            <label>
              数字
              <select data-rule-field="rank">
                <option value="">指定なし</option>
                ${RANKS.map((rank) => option(rank, rank, ruleDraft.condition.rank)).join('')}
              </select>
            </label>
            <label>
              スート
              <select data-rule-field="suit" ${jokerCondition ? 'disabled' : ''}>
                <option value="">指定なし</option>
                ${SUITS.map(([id, symbol]) => option(id, symbol, ruleDraft.condition.suit)).join('')}
              </select>
              ${jokerCondition ? '<small>JOKERはスートなし</small>' : ''}
            </label>
            <label>
              枚数
              <select data-rule-field="count">
                <option value="">指定なし</option>
                ${[1, 2, 3, 4].map((count) => option(String(count), `${count}枚`, String(ruleDraft.condition.count))).join('')}
              </select>
            </label>
          </div>
          <div class="relation-options" aria-label="直前プレイとの関係条件">
            <label class="relation-toggle">
              <input
                data-rule-field="rankRelation"
                type="checkbox"
                value="plusOne"
                ${ruleDraft.condition.rankRelation === 'plusOne' ? 'checked' : ''}
              />
              <span>1つ上の数字</span>
            </label>
            <label class="relation-toggle">
              <input
                data-rule-field="suitRelation"
                type="checkbox"
                value="same"
                ${ruleDraft.condition.suitRelation === 'same' ? 'checked' : ''}
              />
              <span>同スート</span>
            </label>
          </div>
          ${renderConditionSockets(power, selectedConnector)}
        </section>
        <div class="puzzle-arrow" aria-hidden="true">→</div>
        <section class="puzzle-piece target-piece">
          <div class="piece-heading">
            <span><span class="piece-icon">→</span> 対象</span>
            <strong>${escapeHtml(connectorFullLabel(selectedConnector))}</strong>
          </div>
          ${renderTargetChoices(power)}
        </section>
        <div class="puzzle-arrow" aria-hidden="true">→</div>
        <section class="puzzle-piece effect-piece">
          <div class="piece-heading">
            <span><span class="piece-icon">${escapeHtml(effectIcon(ruleDraft.effect))}</span> 効果</span>
            <strong>${escapeHtml(EFFECT_CONFIGS[ruleDraft.effect]?.label || '')}</strong>
          </div>
          ${renderEffectChoices(power)}
          ${renderEffectConfigControls()}
        </section>
      </div>
      <div class="rule-preview ${validation.ok ? '' : 'invalid'}">
        <strong>${escapeHtml(validation.message || previewRule())}</strong>
        <span>条件Power: ${power}</span>
      </div>
      <button data-click="add-rule" type="button" ${validation.ok ? '' : 'disabled'}>追加</button>
    </section>
  `;
}

function renderConditionSockets(power, selectedConnector) {
  return `
    <div class="connector-stack condition-sockets" aria-label="条件ピースの接続穴">
      ${CONNECTORS.map((connector) => {
        const open = connector.level <= power;
        const active = open && connector.id === selectedConnector;
        return `
          <div class="connector-line ${open ? 'open' : 'locked'} ${active ? 'active' : ''}">
            <span class="connector-level">${connector.level}</span>
            <span class="socket-dot">${open ? '○' : '×'}</span>
            <span>
              <strong>${escapeHtml(connector.shortLabel)}</strong>
              <small>${escapeHtml(connector.label)}</small>
            </span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderTargetChoices(power) {
  const effectConfig = EFFECT_CONFIGS[ruleDraft.effect];
  if (effectConfig?.fixedTarget) {
    const targetId = effectConfig.fixedTarget;
    const state = targetOptionState(targetId, power, effectConfig.fixedTargetLabel);
    return `
      <div class="piece-choice selected ${state.ok ? 'connected' : 'is-disabled'}">
        ${renderTargetPeg(TARGETS[targetId].connector, state.ok)}
        <span>
          <strong><span class="choice-icon">${escapeHtml(targetIcon(targetId))}</span>${escapeHtml(effectConfig.fixedTargetLabel)}</strong>
          <small>${escapeHtml(state.ok ? `${connectorFullLabel(TARGETS[targetId].connector)}に接続中` : state.shortReason)}</small>
        </span>
      </div>
    `;
  }

  return `
    <div class="piece-choice-grid">
      ${USER_TARGET_IDS.map((targetId) => {
        const state = targetOptionState(targetId, power);
        const selected = ruleDraft.target === targetId;
        return `
          <button
            class="piece-choice ${selected ? 'selected' : ''} ${state.ok ? 'connected' : 'is-disabled'}"
            data-click="set-rule-target"
            data-target="${escapeAttr(targetId)}"
            data-disabled="${state.ok ? 'false' : 'true'}"
            data-reason="${escapeAttr(state.reason)}"
            title="${escapeAttr(state.reason || `${TARGETS[targetId].label}に接続できます`)}"
            type="button"
          >
            ${renderTargetPeg(TARGETS[targetId].connector, state.ok)}
            <span>
              <strong><span class="choice-icon">${escapeHtml(targetIcon(targetId))}</span>${escapeHtml(TARGETS[targetId].label)}</strong>
              <small>${escapeHtml(state.ok ? `${connectorFullLabel(TARGETS[targetId].connector)}に接続` : state.shortReason)}</small>
            </span>
          </button>
        `;
      }).join('')}
    </div>
  `;
}

function renderEffectChoices(power) {
  return `
    <div class="piece-choice-grid">
      ${EFFECTS.map(([effectId, label]) => {
        const state = effectOptionState(effectId, power);
        const selected = ruleDraft.effect === effectId;
        return `
          <button
            class="piece-choice effect-choice ${selected ? 'selected' : ''} ${state.ok ? 'connected' : 'is-disabled'}"
            data-click="set-rule-effect"
            data-effect="${escapeAttr(effectId)}"
            data-disabled="${state.ok ? 'false' : 'true'}"
            data-reason="${escapeAttr(state.reason)}"
            title="${escapeAttr(state.reason || `${label}を接続できます`)}"
            type="button"
          >
            ${renderEffectSockets(effectId, state.connector)}
            <span>
              <strong><span class="choice-icon">${escapeHtml(effectIcon(effectId))}</span>${escapeHtml(label)}</strong>
              <small>${escapeHtml(state.ok ? connectorSummary(effectId) : state.shortReason)}</small>
            </span>
          </button>
        `;
      }).join('')}
    </div>
  `;
}

function renderEffectConfigControls() {
  if (ruleDraft.effect !== 'bindRank') {
    return '';
  }

  return `
    <div class="effect-config-control">
      <label>
        縛る数字
        <select data-rule-field="bindRankValue">
          <option value="">出した数字</option>
          ${NORMAL_RANKS.map((rank) => option(rank, rank, ruleDraft.effectConfig.bindRank)).join('')}
        </select>
      </label>
    </div>
  `;
}

function renderTargetPeg(connectorId, connected) {
  return `
    <span class="mini-connector peg-stack" aria-hidden="true">
      ${CONNECTORS.map(
        (connector) =>
          `<span class="${connector.id === connectorId ? 'peg' : 'empty'} ${connected && connector.id === connectorId ? 'active' : ''}">${connector.id === connectorId ? '●' : '·'}</span>`
      ).join('')}
    </span>
  `;
}

function previewTriggeredRules() {
  if (!showRulePredictionForMode(roomState?.settings?.mode) || selectedCardIds.size === 0) {
    return [];
  }

  const play = analyzeSelectedPlayPreview();
  if (!play) {
    return [];
  }

  return [...(roomState.localRules || []), ...(roomState.rules || [])]
      .filter((rule) => !rule.hidden && rule.condition && conditionMatchesPreview(rule.condition, play))
      .map((rule) => ({
        id: rule.id,
        description: rule.localRuleId ? `${rule.label}: ${rule.description}` : rule.description,
        sourceText: rule.localRuleId ? `${rule.label}: ${rule.description}` : rule.description,
        prediction: describePredictedRule(rule, play),
        local: Boolean(rule.localRuleId)
      }));
}

function showRulePredictionForMode(mode) {
  return Boolean(RULE_PREDICTION_BY_MODE[mode]);
}

function analyzeSelectedPlayPreview() {
  const validation = validateSelectedPlayPreview();
  return validation.legal ? validation.play : null;
}

function validateSelectedPlayPreview() {
  const hand = ownPlayer()?.hand || [];
  const byId = new Map(hand.map((card) => [card.id, card]));
  const cards = [...selectedCardIds].map((id) => byId.get(id)).filter(Boolean);
  const reasons = [];

  if (cards.length !== selectedCardIds.size) {
    reasons.push('手札にないカードが選ばれています');
  }
  if (cards.length < 1) {
    return { legal: false, reasons: ['カードを選んでください'], play: null };
  }
  if (cards.length > 4) {
    reasons.push('同時に出せるのは4枚までです');
  }

  const nonJokers = cards.filter((card) => !card.joker);
  const hasJoker = nonJokers.length !== cards.length;
  const printedRanks = [...new Set(nonJokers.map((card) => card.rank))];
  if (printedRanks.length > 1) {
    reasons.push('複数枚出しは同じ数字だけ出せます');
  }

  const jokerOnly = nonJokers.length === 0;
  const effectiveRank = jokerOnly ? 'JOKER' : printedRanks[0];
  const table = roomState.game?.table;
  if (table) {
    if (cards.length !== table.count) {
      reasons.push(`場が${table.count}枚なので、同じ${table.count}枚で出してください`);
    }
    if (rankValue(effectiveRank) <= rankValue(table.rank)) {
      reasons.push(`場の${table.rank}より強い数字を出してください`);
    }
  }

  const previousSuits = new Set((table?.cards || []).filter((card) => !card.joker && card.suit).map((card) => card.suit));
  const play = {
    count: cards.length,
    effectiveRank,
    hasJoker,
    ruleRanks: jokerOnly ? new Set() : new Set([effectiveRank]),
    ruleSuits: new Set(nonJokers.map((card) => card.suit)),
    previousRank: table?.rank || null,
    previousSuits
  };

  const bindingReasons = selectedPlayBindingReasons(play);
  reasons.push(...bindingReasons);

  return {
    legal: reasons.length === 0,
    reasons,
    play: reasons.length === 0 ? play : null
  };
}

function selectedPlaySatisfiesBindings(play) {
  return selectedPlayBindingReasons(play).length === 0;
}

function selectedPlayBindingReasons(play) {
  const bindings = ownPlayer()?.bindings || [];
  const reasons = [];
  for (const binding of bindings) {
    if (binding.type === 'suit') {
      const ok = (binding.suits || []).some((suit) => play.ruleSuits.has(suit));
      if (!ok) {
        reasons.push(`${binding.label || 'スート縛り'}を満たしていません`);
      }
      continue;
    }
    if (binding.type === 'rank' || binding.type === 'step') {
      const ok = (binding.ranks || []).includes(play.effectiveRank);
      if (!ok) {
        reasons.push(`${binding.label || '数字縛り'}を満たしていません`);
      }
      continue;
    }
  }
  return reasons;
}

function conditionMatchesPreview(condition, play) {
  if (condition.rank) {
    if (condition.rank === 'JOKER') {
      if (!play.hasJoker) return false;
    } else if (!play.ruleRanks.has(condition.rank)) {
      return false;
    }
  }
  if (condition.suit && !play.ruleSuits.has(condition.suit)) {
    return false;
  }
  if (condition.count && Number(condition.count) !== play.count) {
    return false;
  }
  if (condition.rankRelation === 'plusOne') {
    const previousIndex = NORMAL_RANKS.indexOf(play.previousRank);
    const currentIndex = NORMAL_RANKS.indexOf(play.effectiveRank);
    if (previousIndex < 0 || currentIndex !== previousIndex + 1) {
      return false;
    }
  }
  if (condition.suitRelation === 'same') {
    if (!play.previousSuits || play.previousSuits.size === 0) {
      return false;
    }
    if (![...play.ruleSuits].some((suit) => play.previousSuits.has(suit))) {
      return false;
    }
  }
  return true;
}

function rankValue(rank) {
  if (rank === 'JOKER') return NORMAL_RANKS.length + 3;
  const index = NORMAL_RANKS.indexOf(rank);
  return index < 0 ? -1 : index + 3;
}

function describePredictedRule(rule, play) {
  const target = predictedTargetLabel(rule.target);
  const count = Number(rule.count || 1);

  if (rule.effect === 'skip') {
    return `${target.object}をスキップ`;
  }
  if (rule.effect === 'gift') {
    return `${target.to}へ${count}枚渡す`;
  }
  if (rule.effect === 'discard') {
    return `自分の手札を追加で${count}枚捨てる`;
  }
  if (rule.effect === 'bindSuit') {
    const suits = [...play.ruleSuits].map((suit) => SUITS.find(([id]) => id === suit)?.[1] || suit);
    const suitText = suits.length ? suits.join(' / ') : '指定スート';
    return `${target.subject}は次の行動で${suitText}を含む手しか出せない`;
  }
  if (rule.effect === 'bindRank') {
    const rank = rule.effectConfig?.bindRank || (NORMAL_RANKS.includes(play.effectiveRank) ? play.effectiveRank : '指定数字');
    return `${target.subject}は次の行動で${rank}しか出せない`;
  }
  if (rule.effect === 'reverse') {
    return '進行方向が逆転する';
  }
  if (rule.effect === 'clear') {
    return '場が流れる';
  }
  return rule.description || '特殊ルールが発動する';
}

function predictedTargetLabel(target) {
  if (target === 'self') return { subject: '自分', object: '自分', to: '自分' };
  if (target === 'next') return { subject: '次のプレイヤー', object: '次のプレイヤー', to: '次のプレイヤー' };
  if (target === 'any') return { subject: '選んだプレイヤー', object: '選んだプレイヤー', to: '選んだプレイヤー' };
  if (target === 'all') return { subject: '全員', object: '全員', to: '全員' };
  return { subject: '場', object: '場', to: '場' };
}

function renderEffectSockets(effectId, selectedConnector) {
  const effectConfig = EFFECT_CONFIGS[effectId];
  return `
    <span class="mini-connector effect-sockets" aria-hidden="true">
      ${CONNECTORS.map((connector) => {
        const compatible = effectConfig.connectors.includes(connector.id);
        const active = compatible && connector.id === selectedConnector;
        return `<span class="${compatible ? 'socket' : 'empty'} ${active ? 'active' : ''}">${compatible ? '○' : '·'}</span>`;
      }).join('')}
    </span>
  `;
}

function renderRules() {
  const previewRules = previewTriggeredRules();
  const highlightedRuleIds = new Set(previewRules.map((rule) => rule.id));
  const localRules = roomState.localRules || [];
  const customRules = roomState.rules || [];
  return `
    <section class="panel">
      <h2>特殊ルール</h2>
      ${renderTriggerPreview(previewRules)}
      <div class="rule-section">
        <h3>ローカルルール</h3>
        ${
          localRules.length
            ? `<div class="rule-list">
                ${localRules
                  .map(
                    (rule) =>
                      `<div class="rule-row local-rule-row ${
                        highlightedRuleIds.has(rule.id) ? 'trigger-preview' : ''
                      }">
                        <span>${escapeHtml(rule.label)}</span>
                        <small>${escapeHtml(rule.description)}</small>
                        ${highlightedRuleIds.has(rule.id) ? '<small>発動候補</small>' : ''}
                      </div>`
                  )
                  .join('')}
              </div>`
            : '<p class="muted">OFF</p>'
        }
      </div>
      <div class="rule-section">
        <h3>追加ルール</h3>
      ${
        customRules.length
          ? `<div class="rule-list">
              ${customRules
                .map(
                  (rule) =>
                    `<div class="rule-row ${rule.hidden ? 'hidden-rule' : ''} ${
                      highlightedRuleIds.has(rule.id) ? 'trigger-preview' : ''
                    }">
                      <span>${escapeHtml(rule.description)}</span>
                      ${rule.generated ? '<small>ランダム</small>' : ''}
                      ${renderRuleCreatorMeta(rule)}
                      ${highlightedRuleIds.has(rule.id) ? '<small>発動候補</small>' : ''}
                    </div>`
                )
                .join('')}
            </div>`
          : '<p class="muted">まだありません</p>'
      }
      </div>
    </section>
  `;
}

function renderRuleCreatorMeta(rule) {
  if (rule.generated) {
    return '';
  }
  const parts = [];
  if (rule.createdByName) {
    parts.push(`${rule.createdByName}さん`);
  }
  if (rule.createdAfterRound) {
    parts.push(`第${rule.createdAfterRound}R後`);
  } else if (rule.createdRound) {
    parts.push(`第${rule.createdRound}R`);
  }
  return parts.length ? `<small>${escapeHtml(parts.join(' / '))}</small>` : '';
}

function renderTriggerPreview(previewRules) {
  if (previewRules.length === 0) {
    return '';
  }

  return `
    <div class="trigger-preview-panel">
      <h3>発動予定</h3>
      <ul>
        ${previewRules
          .map(
            (rule) =>
              `<li>${rule.local ? '<strong>ローカル</strong> ' : ''}${escapeHtml(rule.description)}</li>`
          )
          .join('')}
      </ul>
    </div>
  `;
}

function renderEvents() {
  const recentEvents = roomState.recentEvents || [];
  const historyCount = roomState.eventHistory?.length || recentEvents.length;
  return `
    <section class="panel">
      <div class="panel-heading-row">
        <h2>直近の出来事</h2>
        <button class="ghost compact-button" data-click="open-event-history" type="button">履歴を見る</button>
      </div>
      ${
        recentEvents.length
          ? `<ol class="event-list">
              ${recentEvents.map((event) => `<li>${renderEventTypeBadge(event.type)}${escapeHtml(event.text)}</li>`).join('')}
            </ol>`
          : '<p class="muted">まだありません</p>'
      }
      <p class="history-count">${historyCount}件保存中</p>
    </section>
  `;
}

function renderEventHistoryModal() {
  const allEvents = roomState?.eventHistory || [];
  const events = filterEventsForHistory(allEvents);
  const grouped = groupEventsBySection(events);
  const filters = [
    ['all', 'すべて'],
    ['settings', '設定'],
    ['rule', 'ルール'],
    ['play', 'プレイ'],
    ['system', 'システム']
  ];

  return `
    <div class="history-backdrop" role="presentation">
      <section class="history-sheet" role="dialog" aria-modal="true" aria-label="ログ履歴">
        <div class="history-header">
          <div>
            <h2>ログ履歴</h2>
            <p>${allEvents.length}件のサーバーログ</p>
          </div>
          <button class="ghost compact-button" data-click="close-event-history" type="button">閉じる</button>
        </div>
        <div class="history-filter-row" aria-label="ログフィルター">
          ${filters
            .map(
              ([id, label]) => `
                <button
                  class="${eventHistoryFilter === id ? 'selected' : ''}"
                  data-click="set-event-filter"
                  data-filter="${escapeAttr(id)}"
                  type="button"
                >${escapeHtml(label)}</button>
              `
            )
            .join('')}
        </div>
        ${
          grouped.length > 1
            ? `<div class="history-jumps">
                ${grouped
                  .map(
                    (group, index) =>
                      `<a href="#history-section-${index}">${escapeHtml(group.label)}</a>`
                  )
                  .join('')}
              </div>`
            : ''
        }
        <div class="history-body">
          ${
            grouped.length
              ? grouped
                  .map(
                    (group, index) => `
                      <section class="history-section" id="history-section-${index}">
                        <h3>${escapeHtml(group.label)}</h3>
                        <ol>
                          ${group.events
                            .map(
                              (event) => `
                                <li class="history-event">
                                  <span class="history-time">${escapeHtml(formatEventTime(event.at))}</span>
                                  ${renderEventTypeBadge(event.type)}
                                  <span>${escapeHtml(event.text)}</span>
                                </li>
                              `
                            )
                            .join('')}
                        </ol>
                      </section>
                    `
                  )
                  .join('')
              : '<p class="muted">この条件のログはありません</p>'
          }
        </div>
      </section>
    </div>
  `;
}

function filterEventsForHistory(events) {
  if (eventHistoryFilter === 'all') return events;
  if (eventHistoryFilter === 'system') {
    return events.filter((event) => ['system', 'finish', 'pass'].includes(event.type));
  }
  return events.filter((event) => event.type === eventHistoryFilter);
}

function groupEventsBySection(events) {
  const groups = [];
  for (const event of events) {
    const label = eventSectionLabel(event);
    let group = groups[groups.length - 1];
    if (!group || group.label !== label) {
      group = { label, events: [] };
      groups.push(group);
    }
    group.events.push(event);
  }
  return groups;
}

function eventSectionLabel(event) {
  if (event.phase === 'lobby') return 'ロビー';
  if (event.phase === 'roundResult') return `第${event.round || ''}ラウンド結果`;
  if (event.phase === 'ruleBuilding') return `第${event.round || ''}ラウンド後 ルール追加`;
  if (event.phase === 'matchResult' || event.phase === 'finished') return '最終結果';
  if (event.round) return `第${event.round}ラウンド`;
  return 'システム';
}

function renderEventTypeBadge(type) {
  const labels = {
    settings: '設定',
    rule: 'ルール',
    play: 'プレイ',
    pass: 'パス',
    finish: '順位',
    system: '進行',
    info: '情報'
  };
  return `<span class="event-type ${escapeAttr(type || 'info')}">${escapeHtml(labels[type] || labels.info)}</span>`;
}

function formatEventTime(at) {
  if (!at) return '';
  const date = new Date(at);
  return date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

function normalizeRuleDraftTarget(preferUsable = false) {
  const effectConfig = EFFECT_CONFIGS[ruleDraft.effect] || EFFECT_CONFIGS.skip;
  if (effectConfig.fixedTarget) {
    ruleDraft.target = effectConfig.fixedTarget;
    return;
  }

  const targets = effectConfig.targets || ['self'];
  if (!targets.includes(ruleDraft.target)) {
    ruleDraft.target = targets[0];
  }

  if (preferUsable) {
    const power = calculateConditionPower(ruleDraft.condition);
    const currentState = targetOptionState(ruleDraft.target, power);
    if (!currentState.ok) {
      const usableTarget = targets.find((targetId) => targetOptionState(targetId, power).ok);
      if (usableTarget) {
        ruleDraft.target = usableTarget;
      }
    }
  }
}

function previewRule() {
  const conditionText = previewCondition();
  const effectText = previewEffect();
  if (!hasDraftCondition()) {
    return `条件を選ぶと、${effectText}`;
  }
  return `${conditionText}、${effectText}`;
}

function previewCondition() {
  const cardParts = [];
  if (ruleDraft.condition.suit) {
    cardParts.push(SUITS.find(([id]) => id === ruleDraft.condition.suit)?.[1] || '');
  }
  if (ruleDraft.condition.rank) {
    cardParts.push(ruleDraft.condition.rank);
  }

  const phrases = [];
  const cardText = cardParts.join('');
  if (ruleDraft.condition.count) {
    phrases.push(cardText ? `${cardText}を含む${ruleDraft.condition.count}枚出し` : `${ruleDraft.condition.count}枚出し`);
  } else if (cardText) {
    phrases.push(`${cardText}を出す`);
  }

  if (ruleDraft.condition.rankRelation === 'plusOne') {
    phrases.push('直前のプレイより1つ上の数字');
  }
  if (ruleDraft.condition.suitRelation === 'same') {
    phrases.push('直前のプレイと同じスート');
  }

  return phrases.length > 0 ? `${phrases.join('、かつ')}なら` : '条件を選択中';
}

function previewEffect() {
  const effectConfig = EFFECT_CONFIGS[ruleDraft.effect];
  const targetLabel = getDraftTargetLabel();
  if (!effectConfig) return '効果を選んでください';

  if (ruleDraft.effect === 'skip') {
    return `${targetLabel}を1回スキップする`;
  }
  if (ruleDraft.effect === 'bindSuit') {
    return `${targetLabel}は次の行動で出したスートを含む手しか出せない`;
  }
  if (ruleDraft.effect === 'bindRank') {
    const rank = ruleDraft.effectConfig.bindRank;
    return `${targetLabel}は次の行動で${rank || '出した数字'}しか出せない`;
  }
  if (ruleDraft.effect === 'gift') {
    return `${targetLabel}へカードを1枚渡す`;
  }
  if (ruleDraft.effect === 'reverse') {
    return '進行方向を逆転する';
  }
  if (ruleDraft.effect === 'clear') {
    return '場を流す';
  }
  return effectConfig.label;
}

function hasDraftCondition() {
  return Boolean(
    ruleDraft.condition.rank ||
      ruleDraft.condition.suit ||
      ruleDraft.condition.count ||
      ruleDraft.condition.rankRelation ||
      ruleDraft.condition.suitRelation
  );
}

function validateRuleDraft() {
  if (
    !ruleDraft.condition.rank &&
    !ruleDraft.condition.suit &&
    !ruleDraft.condition.count &&
    !ruleDraft.condition.rankRelation &&
    !ruleDraft.condition.suitRelation
  ) {
    return { ok: false, message: '条件を1つ以上選んでください' };
  }

  if (ruleDraft.condition.rank === 'JOKER' && ruleDraft.condition.suit) {
    return { ok: false, message: 'JOKER条件にはスートを指定できません' };
  }

  const power = calculateConditionPower(ruleDraft.condition);
  const targetState = targetOptionState(ruleDraft.target, power, getDraftTargetLabel());
  if (!targetState.ok) {
    return { ok: false, message: targetState.reason };
  }

  const effectConfig = EFFECT_CONFIGS[ruleDraft.effect];
  const connector = targetConnector(ruleDraft.target);
  if (!effectConfig.connectors.includes(connector)) {
    return {
      ok: false,
      message: `『${effectConfig.label}』は${getDraftTargetLabel()}を対象にできません`
    };
  }

  return { ok: true, message: '' };
}

function calculateConditionPower(condition) {
  let power = 0;
  if (condition.rank) {
    power += condition.rank === 'JOKER' ? CONDITION_POWER.jokerRank : CONDITION_POWER.rank;
  }
  if (condition.suit) {
    power += condition.rank === 'JOKER' ? 0 : CONDITION_POWER.suit;
  }
  if (condition.count) {
    power += CONDITION_POWER.counts[Number(condition.count)] || 0;
  }
  if (condition.rankRelation === 'plusOne') {
    power += CONDITION_POWER.rankRelationPlusOne;
  }
  if (condition.suitRelation === 'same') {
    power += CONDITION_POWER.suitRelationSame;
  }
  return Math.min(CONDITION_POWER.max, power);
}

function getDraftTarget() {
  return TARGETS[ruleDraft.target] || TARGETS.none;
}

function getDraftTargetLabel() {
  const effectConfig = EFFECT_CONFIGS[ruleDraft.effect];
  if (effectConfig?.fixedTargetLabel) {
    return effectConfig.fixedTargetLabel;
  }
  return getDraftTarget().label;
}

function targetConnector(targetId) {
  return TARGETS[targetId]?.connector || 'GLOBAL';
}

function connectorLevel(connectorId) {
  return CONNECTORS.find((connector) => connector.id === connectorId)?.level || 4;
}

function connectorLabel(connectorId) {
  const connector = CONNECTORS.find((candidate) => candidate.id === connectorId);
  return connector ? `${connector.level} ${connector.shortLabel}` : connectorId;
}

function connectorFullLabel(connectorId) {
  const connector = CONNECTORS.find((candidate) => candidate.id === connectorId);
  return connector ? `${connector.level} ${connector.shortLabel}（${connector.label}）` : connectorId;
}

function connectorSummary(effectId) {
  const effectConfig = EFFECT_CONFIGS[effectId];
  return effectConfig.connectors.map(connectorFullLabel).join(' / ');
}

function targetIcon(targetId) {
  return {
    self: '自',
    next: '次',
    any: '選',
    all: '全',
    none: '場'
  }[targetId] || '→';
}

function effectIcon(effectId) {
  return {
    skip: '⏭',
    bindSuit: '♠',
    bindRank: '#',
    reverse: '↺',
    clear: '流',
    gift: '渡'
  }[effectId] || '効';
}

function targetOptionState(targetId, power, displayLabel) {
  const target = TARGETS[targetId];
  const effectConfig = EFFECT_CONFIGS[ruleDraft.effect];
  if (!target || !effectConfig) {
    return { ok: false, reason: '対象または効果が不正です', shortReason: '不正' };
  }

  const label = displayLabel || target.label;
  const connector = target.connector;
  const level = connectorLevel(connector);
  if (power < level) {
    return {
      ok: false,
      reason: `現在の条件Powerは${power}です。${label}を対象にするには${level}以上必要です。`,
      shortReason: `Power ${level}必要`
    };
  }

  if (!effectConfig.targets.includes(targetId) || !effectConfig.connectors.includes(connector)) {
    return {
      ok: false,
      reason: `『${effectConfig.label}』は${label}を対象にできません。`,
      shortReason: '効果と非対応'
    };
  }

  return { ok: true, reason: '' };
}

function effectOptionState(effectId, power) {
  const effectConfig = EFFECT_CONFIGS[effectId];
  if (!effectConfig) {
    return { ok: false, reason: '効果が不正です', shortReason: '不正', connector: 'SELF' };
  }

  if (effectConfig.fixedTarget) {
    const connector = targetConnector(effectConfig.fixedTarget);
    const level = connectorLevel(connector);
    if (power < level) {
      return {
        ok: false,
        reason: `『${effectConfig.label}』は${connectorLabel(connector)}属性が必要です。条件Powerを${level}以上にしてください。`,
        shortReason: `Power ${level}必要`,
        connector
      };
    }
    return { ok: true, reason: '', connector };
  }

  const currentConnector = targetConnector(ruleDraft.target);
  if (ruleDraft.target !== 'none' && !effectConfig.targets.includes(ruleDraft.target)) {
    return {
      ok: false,
      reason: `『${effectConfig.label}』は${getDraftTargetLabel()}を対象にできません。`,
      shortReason: '対象と非対応',
      connector: currentConnector
    };
  }

  if (
    effectConfig.targets.includes(ruleDraft.target) &&
    effectConfig.connectors.includes(currentConnector) &&
    power >= connectorLevel(currentConnector)
  ) {
    return { ok: true, reason: '', connector: currentConnector };
  }

  const usableTarget = effectConfig.targets.find((targetId) => {
    const connector = targetConnector(targetId);
    return effectConfig.connectors.includes(connector) && power >= connectorLevel(connector);
  });
  if (usableTarget) {
    return { ok: true, reason: '', connector: targetConnector(usableTarget) };
  }

  const minLevel = Math.min(...effectConfig.connectors.map(connectorLevel));
  return {
    ok: false,
    reason: `『${effectConfig.label}』を使うには条件Power ${minLevel}以上が必要です。`,
    shortReason: `Power ${minLevel}必要`,
    connector: effectConfig.connectors[0]
  };
}

function pendingLabel(pending) {
  if (pending.type === 'target') return '対象プレイヤーを選んでください';
  if (pending.type === 'giftCard') return `渡すカードを${pending.requiredCount || 1}枚選んでください`;
  if (pending.type === 'discardCard') return `捨てるカードを${pending.requiredCount || 1}枚選んでください`;
  return '選択してください';
}

function formatRoundRanks(ranks) {
  const playedRanks = (ranks || []).filter(Boolean);
  if (playedRanks.length === 0) return '順位履歴なし';
  return playedRanks.map((rank) => `${rank}位`).join(' / ');
}

function resetRuleDraft() {
  ruleDraft = {
    condition: { rank: '', suit: '', count: '', rankRelation: '', suitRelation: '' },
    target: 'next',
    effect: 'skip',
    effectConfig: { bindRank: '' }
  };
  normalizeRuleDraftTarget();
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
