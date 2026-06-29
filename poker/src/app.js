import { createDeck, shuffleDeck, cardId, isRed, SUITS, RANKS } from './cards.js';
import { evaluateHand, HAND_NAMES, HAND_RANKS } from './hand-eval.js';
import { createGame, startHand, applyAction, getValidActions, isHandOver, isGameOver, getGameWinner, PHASES, BIG_BLIND } from './engine.js';
import { getAIPersonalities, aiDecision } from './ai.js';
import { initFirebase, createRoom, joinRoom, listenRoom, stopListening, setReady, pushGameState, startOnlineGame, pushAction, clearAction, getClientId, isHost } from './firebase.js';

let G = null;
let isOnline = false;
let roomCode = null;
let roomData = null;
let myClientId = null;
let seq = 0;
let pendingReveal = false;
let revealTimer = null;
let aiTimer = null;

// ── DOM helpers ──
const $ = id => document.getElementById(id);
const show = id => { $(id).classList.add('active'); };
const hide = id => { $(id).classList.remove('active'); };

function switchScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

// ── TITLE ──
window.showTitle = () => switchScreen('title-screen');
window.showSetup = () => {
  renderSetup();
  switchScreen('setup-screen');
};

// ── SETUP (single player) ──
let setupAICount = 4;

function renderSetup() {
  const grid = $('setup-grid');
  grid.innerHTML = '';
  const slider = document.createElement('div');
  slider.className = 'setup-row';
  slider.innerHTML = `
    <label class="setup-label">OPPONENTS</label>
    <div class="setup-slider-wrap">
      <input type="range" min="1" max="5" value="${setupAICount}" id="ai-count-slider" class="setup-slider">
      <span class="setup-slider-val" id="ai-count-val">${setupAICount}</span>
    </div>
  `;
  grid.appendChild(slider);
  $('ai-count-slider').oninput = e => {
    setupAICount = +e.target.value;
    $('ai-count-val').textContent = setupAICount;
  };

  const nameRow = document.createElement('div');
  nameRow.className = 'setup-row';
  nameRow.innerHTML = `
    <label class="setup-label">YOUR NAME</label>
    <input type="text" id="player-name" class="setup-input" value="Stranger" maxlength="16" placeholder="Enter your name...">
  `;
  grid.appendChild(nameRow);
}

window.startGame = () => {
  const name = ($('player-name')?.value || 'Stranger').trim() || 'Stranger';
  const aiPersonalities = getAIPersonalities(setupAICount);
  const players = [
    { name, isAI: false },
    ...aiPersonalities.map(p => ({ name: p.name, isAI: true, personality: p })),
  ];
  G = createGame(players);
  isOnline = false;
  switchScreen('game-screen');
  beginHand();
};

// ── ONLINE ──
window.goOnline = () => {
  initFirebase();
  myClientId = getClientId();
  switchScreen('lobby-screen');
  renderLobbyMenu();
};

function renderLobbyMenu() {
  const body = $('lobby-body');
  body.innerHTML = `
    <div class="lobby-menu">
      <div class="lobby-row">
        <label class="setup-label">YOUR NAME</label>
        <input type="text" id="online-name" class="setup-input" value="Stranger" maxlength="16">
      </div>
      <div class="lobby-buttons">
        <button class="btn btn-primary" onclick="window.hostGame()">🏠 HOST GAME</button>
        <button class="btn btn-secondary" onclick="window.showJoin()">🚪 JOIN GAME</button>
        <button class="btn btn-back" onclick="window.showTitle()">← BACK</button>
      </div>
      <div id="join-section" style="display:none;">
        <div class="lobby-row">
          <label class="setup-label">ROOM CODE</label>
          <input type="text" id="room-code-input" class="setup-input code-input" maxlength="4" placeholder="ABCD">
        </div>
        <button class="btn btn-primary" onclick="window.doJoin()">JOIN →</button>
      </div>
    </div>
  `;
}

window.showJoin = () => {
  $('join-section').style.display = 'block';
};

window.hostGame = async () => {
  const name = ($('online-name')?.value || 'Stranger').trim() || 'Stranger';
  try {
    roomCode = await createRoom(name);
    listenRoom(onRoomUpdate);
    renderLobbyRoom();
  } catch (e) {
    alert('Error creating room: ' + e.message);
  }
};

window.doJoin = async () => {
  const name = ($('online-name')?.value || 'Stranger').trim() || 'Stranger';
  const code = ($('room-code-input')?.value || '').trim().toUpperCase();
  if (code.length !== 4) { alert('Enter a 4-letter room code'); return; }
  try {
    roomCode = code;
    await joinRoom(code, name);
    listenRoom(onRoomUpdate);
    renderLobbyRoom();
  } catch (e) {
    alert(e.message);
  }
};

function renderLobbyRoom() {
  const body = $('lobby-body');
  const rd = roomData || {};
  const players = rd.players || {};
  const playerList = Object.entries(players);
  const amHost = rd.host === myClientId;

  body.innerHTML = `
    <div class="lobby-room">
      <div class="room-code-display">Room: <span class="room-code">${roomCode}</span></div>
      <div class="player-list">
        <div class="lobby-label">PLAYERS AT THE TABLE</div>
        ${playerList.map(([cid, p]) => `
          <div class="lobby-player ${p.ready ? 'ready' : ''}">
            <span class="lobby-player-name">${p.name}${cid === rd.host ? ' ★' : ''}</span>
            <span class="lobby-player-status">${p.ready ? '✓ READY' : 'WAITING'}</span>
          </div>
        `).join('')}
      </div>
      <div class="lobby-actions">
        ${!players[myClientId]?.ready ?
          `<button class="btn btn-primary" onclick="window.markReady()">✋ I'M READY</button>` :
          `<div class="ready-badge">YOU'RE READY</div>`
        }
        ${amHost && playerList.length >= 2 && playerList.every(([,p]) => p.ready) ?
          `<button class="btn btn-primary" onclick="window.launchOnline()">🎰 DEAL 'EM!</button>` : ''
        }
      </div>
      <div class="lobby-hint">${amHost ? 'Share the room code with your posse.' : 'Waiting for the host to start...'}</div>
    </div>
  `;
}

window.markReady = () => setReady(true);

window.launchOnline = async () => {
  const rd = roomData;
  const entries = Object.entries(rd.players || {});
  const players = entries.map(([cid, p], i) => ({
    name: p.name,
    isAI: false,
    clientId: cid,
    seatIndex: i,
  }));
  G = createGame(players);
  G.clientMap = {};
  entries.forEach(([cid], i) => { G.clientMap[cid] = i; });
  G = startHand(G);
  isOnline = true;
  seq++;
  await startOnlineGame();
  await pushGameState(G, seq);
};

function onRoomUpdate(data) {
  roomData = data;
  if (!data) return;

  if (data.started && data.state) {
    const parsed = typeof data.state === 'string' ? JSON.parse(data.state) : data.state;
    if (data.seq > seq || !G) {
      seq = data.seq || 0;
      G = parsed;
      isOnline = true;
      switchScreen('game-screen');
      renderGame();
      checkAITurn();
    }
  } else if (!data.started) {
    renderLobbyRoom();
  }

  if (data.pendingAction && data.pendingAction.from !== myClientId && G) {
    const action = data.pendingAction;
    if (isHost(data)) {
      G = applyAction(G, action);
      seq++;
      clearAction();
      pushGameState(G, seq);
      renderGame();
      checkAITurn();
    }
  }
}

// ── GAME FLOW ──
function beginHand() {
  G = startHand(G);
  pendingReveal = false;
  renderGame();
  logMsg(`─── Hand #${G.roundNum} ───`);
  setTimeout(() => checkAITurn(), 400);
}

function checkAITurn() {
  if (!G || isHandOver(G)) return;
  const player = G.players[G.activeIndex];
  if (!player) return;

  if (isOnline) {
    const mySeat = G.clientMap?.[myClientId];
    if (G.activeIndex !== mySeat) return;
    renderGame();
    return;
  }

  if (player.isAI) {
    clearTimeout(aiTimer);
    aiTimer = setTimeout(() => {
      const decision = aiDecision(player, {
        communityCards: G.communityCards,
        pot: G.pot,
        currentBet: G.currentBet,
        minRaise: G.minRaise,
      });

      if (decision.action === 'raise') {
        const raiseTotal = G.currentBet + decision.amount;
        G = applyAction(G, { action: 'raise', amount: raiseTotal });
      } else {
        G = applyAction(G, decision);
      }

      renderGame();

      if (isHandOver(G)) {
        showHandResult();
      } else {
        checkAITurn();
      }
    }, 600 + Math.random() * 800);
  }
}

function showHandResult() {
  pendingReveal = true;
  renderGame();
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    if (isGameOver(G)) {
      showGameOver();
    } else {
      beginHand();
    }
  }, 4000);
}

function showGameOver() {
  const winner = getGameWinner(G);
  $('winner-name').textContent = winner.name;
  $('winner-chips').textContent = `$${winner.chips}`;
  show('gameover-overlay');
}

window.playAgain = () => {
  hide('gameover-overlay');
  switchScreen('title-screen');
};

window.continueGame = () => {
  clearTimeout(revealTimer);
  if (isGameOver(G)) {
    showGameOver();
  } else {
    beginHand();
  }
};

// ── PLAYER ACTIONS ──
window.doFold = () => playerAct({ action: 'fold' });
window.doCheck = () => playerAct({ action: 'check' });
window.doCall = () => playerAct({ action: 'call' });
window.doAllIn = () => playerAct({ action: 'all-in' });

window.doRaise = () => {
  const slider = $('raise-slider');
  const amount = +slider.value;
  playerAct({ action: 'raise', amount });
};

function playerAct(action) {
  if (!G || isHandOver(G)) return;
  const player = G.players[G.activeIndex];
  if (player.isAI) return;

  if (isOnline) {
    pushAction(action);
    return;
  }

  G = applyAction(G, action);
  renderGame();

  if (isHandOver(G)) {
    showHandResult();
  } else {
    checkAITurn();
  }
}

// ── RENDER ──
function renderGame() {
  if (!G) return;
  renderCommunity();
  renderPlayers();
  renderPot();
  renderActions();
  renderLog();
}

function renderCommunity() {
  const area = $('community-cards');
  area.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const card = G.communityCards[i];
    const el = document.createElement('div');
    if (card) {
      el.className = `card ${isRed(card) ? 'red' : 'black'}`;
      el.innerHTML = `<span class="card-rank">${card.rank}</span><span class="card-suit">${card.suit}</span>`;
    } else {
      el.className = 'card card-placeholder';
      el.innerHTML = '<span class="card-back">🂠</span>';
    }
    area.appendChild(el);
  }
}

function renderPlayers() {
  const area = $('players-area');
  area.innerHTML = '';

  const myIndex = isOnline ? (G.clientMap?.[myClientId] ?? 0) : 0;

  G.players.forEach((p, i) => {
    const isMe = isOnline ? (G.clientMap?.[myClientId] === i) : !p.isAI;
    const isActive = G.activeIndex === i && !isHandOver(G);
    const showCards = isMe || (isHandOver(G) && pendingReveal && !p.folded);

    const seat = document.createElement('div');
    seat.className = `player-seat ${p.folded ? 'folded' : ''} ${isActive ? 'active-player' : ''} ${p.chips <= 0 && p.hand.length === 0 ? 'busted' : ''}`;

    const dealerMark = G.dealerIndex === i ? '<span class="dealer-chip">D</span>' : '';

    let cardsHtml = '';
    if (p.hand.length === 2) {
      if (showCards) {
        cardsHtml = p.hand.map(c =>
          `<div class="card card-small ${isRed(c) ? 'red' : 'black'}"><span class="card-rank">${c.rank}</span><span class="card-suit">${c.suit}</span></div>`
        ).join('');
      } else {
        cardsHtml = `<div class="card card-small card-facedown"></div><div class="card card-small card-facedown"></div>`;
      }
    }

    let handLabel = '';
    if (showCards && isMe && G.communityCards.length > 0 && p.hand.length === 2 && !p.folded) {
      const eval_ = evaluateHand(p.hand, G.communityCards);
      handLabel = `<div class="hand-label">${eval_.name}</div>`;
    }
    if (showCards && !isMe && pendingReveal && p.hand.length === 2 && !p.folded && G.communityCards.length > 0) {
      const eval_ = evaluateHand(p.hand, G.communityCards);
      handLabel = `<div class="hand-label">${eval_.name}</div>`;
    }

    const winnerInfo = G.winners?.find(w => w.player.id === p.id);
    const winBadge = winnerInfo ? `<div class="win-badge">WON $${winnerInfo.amount}</div>` : '';

    seat.innerHTML = `
      <div class="player-info">
        <div class="player-name">${p.name} ${dealerMark}</div>
        <div class="player-chips">$${p.chips}${p.allIn ? ' ALL IN' : ''}</div>
        ${p.currentBet > 0 ? `<div class="player-bet">Bet: $${p.currentBet}</div>` : ''}
      </div>
      <div class="player-cards">${cardsHtml}</div>
      ${handLabel}
      ${winBadge}
      ${p.folded ? '<div class="fold-label">FOLDED</div>' : ''}
    `;
    area.appendChild(seat);
  });
}

function renderPot() {
  $('pot-display').textContent = `POT: $${G.pot}`;
  const phase = G.phase === 'showdown' ? 'SHOWDOWN' : G.phase.toUpperCase();
  $('phase-display').textContent = `${phase} · HAND #${G.roundNum}`;
}

function renderActions() {
  const panel = $('action-buttons');
  panel.innerHTML = '';

  if (isHandOver(G)) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = isGameOver(G) ? 'SEE RESULTS' : 'NEXT HAND →';
    btn.onclick = window.continueGame;
    panel.appendChild(btn);
    return;
  }

  const player = G.players[G.activeIndex];
  if (!player) return;

  const isMyTurn = isOnline ? (G.clientMap?.[myClientId] === G.activeIndex) : !player.isAI;
  if (!isMyTurn) {
    const wait = document.createElement('div');
    wait.className = 'wait-msg';
    wait.textContent = `Waiting for ${player.name}...`;
    panel.appendChild(wait);
    return;
  }

  const valid = getValidActions(G);
  const toCall = G.currentBet - player.currentBet;

  if (valid.includes('fold')) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-danger';
    btn.textContent = 'FOLD';
    btn.onclick = window.doFold;
    panel.appendChild(btn);
  }

  if (valid.includes('check')) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary';
    btn.textContent = 'CHECK';
    btn.onclick = window.doCheck;
    panel.appendChild(btn);
  }

  if (valid.includes('call')) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = `CALL $${toCall}`;
    btn.onclick = window.doCall;
    panel.appendChild(btn);
  }

  if (valid.includes('raise')) {
    const minTotal = G.currentBet + G.minRaise;
    const maxTotal = player.currentBet + player.chips;

    const raiseWrap = document.createElement('div');
    raiseWrap.className = 'raise-controls';
    raiseWrap.innerHTML = `
      <input type="range" id="raise-slider" class="raise-slider" min="${minTotal}" max="${maxTotal}" value="${minTotal}" step="${BIG_BLIND}">
      <span class="raise-val" id="raise-val">$${minTotal}</span>
      <button class="btn btn-primary" onclick="window.doRaise()">RAISE</button>
    `;
    panel.appendChild(raiseWrap);

    setTimeout(() => {
      const slider = $('raise-slider');
      if (slider) {
        slider.oninput = () => {
          $('raise-val').textContent = `$${slider.value}`;
        };
      }
    }, 0);
  }

  if (valid.includes('all-in')) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-allin';
    btn.textContent = `ALL IN $${player.chips}`;
    btn.onclick = window.doAllIn;
    panel.appendChild(btn);
  }
}

function renderLog() {
  const log = $('game-log');
  if (!log) return;
  const recent = G.log.slice(-8);
  log.innerHTML = recent.map(entry => {
    if (entry.type === 'blind') {
      return `<div class="log-entry log-blind">${entry.player} posts ${entry.kind} blind $${entry.amount}</div>`;
    }
    if (entry.type === 'action') {
      const amt = entry.amount ? ` $${entry.amount}` : '';
      return `<div class="log-entry log-action">${entry.player}: ${entry.action}${amt}</div>`;
    }
    if (entry.type === 'phase') {
      return `<div class="log-entry log-phase">── ${entry.phase.toUpperCase()} ──</div>`;
    }
    if (entry.type === 'win') {
      return `<div class="log-entry log-win">🏆 ${entry.player} wins $${entry.amount} with ${entry.hand}</div>`;
    }
    return '';
  }).join('');
  log.scrollTop = log.scrollHeight;
}

function logMsg(text) {
  const log = $('game-log');
  if (!log) return;
  const div = document.createElement('div');
  div.className = 'log-entry log-system';
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ── INIT ──
renderSetup();
