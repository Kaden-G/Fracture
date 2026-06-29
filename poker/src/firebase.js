const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDVa8eOLH6CXTt1nbgH9v7mkAb-RtgcbXg",
  authDomain: "fracture-105c1.firebaseapp.com",
  databaseURL: "https://fracture-105c1-default-rtdb.firebaseio.com",
  projectId: "fracture-105c1",
  storageBucket: "fracture-105c1.firebasestorage.app",
  messagingSenderId: "926577785338",
  appId: "1:926577785338:web:8c5170c92ced85e7b9cc43",
};

let db = null;
let roomRef = null;
let clientId = null;
let onRemoteUpdate = null;

export function initFirebase() {
  if (db) return;
  if (!window.firebase) {
    console.error('Firebase SDK not loaded');
    return;
  }
  const app = firebase.app ? firebase.app() : firebase.initializeApp(FIREBASE_CONFIG);
  try { firebase.initializeApp(FIREBASE_CONFIG); } catch (e) {}
  db = firebase.database();
  clientId = sessionStorage.getItem('poker_cid');
  if (!clientId) {
    clientId = 'p_' + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('poker_cid', clientId);
  }
}

export function getClientId() { return clientId; }

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export async function createRoom(playerName) {
  initFirebase();
  const code = genCode();
  roomRef = db.ref('poker_rooms/' + code);
  const room = {
    host: clientId,
    created: Date.now(),
    started: false,
    players: {
      [clientId]: { name: playerName, ready: false, seat: 0 }
    },
    state: null,
  };
  await roomRef.set(room);
  return code;
}

export async function joinRoom(code, playerName) {
  initFirebase();
  roomRef = db.ref('poker_rooms/' + code);
  const snap = await roomRef.once('value');
  if (!snap.exists()) throw new Error('Room not found');
  const room = snap.val();
  if (room.started) throw new Error('Game already started');
  const playerCount = room.players ? Object.keys(room.players).length : 0;
  if (playerCount >= 6) throw new Error('Room is full');
  await roomRef.child('players/' + clientId).set({
    name: playerName,
    ready: false,
    seat: playerCount,
  });
  return room;
}

export function listenRoom(callback) {
  if (!roomRef) return;
  onRemoteUpdate = callback;
  roomRef.on('value', snap => {
    if (!snap.exists()) return;
    callback(snap.val());
  });
}

export function stopListening() {
  if (roomRef) roomRef.off('value');
}

export async function setReady(ready) {
  if (!roomRef) return;
  await roomRef.child('players/' + clientId + '/ready').set(ready);
}

export async function pushGameState(state, seq) {
  if (!roomRef) return;
  await roomRef.update({ state: JSON.stringify(state), seq, lastUpdate: clientId });
}

export async function startOnlineGame() {
  if (!roomRef) return;
  await roomRef.child('started').set(true);
}

export async function pushAction(action) {
  if (!roomRef) return;
  await roomRef.child('pendingAction').set({
    ...action,
    from: clientId,
    ts: Date.now(),
  });
}

export async function clearAction() {
  if (!roomRef) return;
  await roomRef.child('pendingAction').remove();
}

export function isHost(room) {
  return room && room.host === clientId;
}
