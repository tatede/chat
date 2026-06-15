// lobby.js  --  home + party lobby. The room creator is the host. Bots fill
// any empty slots so 1v2 / 2v2 / FFA always have full sides and you can test solo.

import { joinNet } from './net.js';
import { Game } from './game.js';

let net = null, isHost = false, myName = 'Commander';
let slots = [];      // {type:'empty'|'human'|'bot', name, peerId}
let mode = 'ffa';
let hostId = null;
let roomCode = '';

const MODES = {
  ffa: { label: '1v1v1v1', n: 4, teams: [0, 1, 2, 3], corners: [0, 1, 2, 3], bonus: [0, 0, 0, 0] },
  '2v2': { label: '2v2', n: 4, teams: [0, 0, 1, 1], corners: [0, 3, 1, 2], bonus: [0, 0, 0, 0] },
  '1v2': { label: '1v2', n: 3, teams: [0, 1, 1], corners: [0, 1, 2], bonus: [0.5, 0, 0] },
};
const TEAM_LETTER = ['A', 'B', 'C', 'D'];
const $ = id => document.getElementById(id);

function rndCode() { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 4; i++) s += a[Math.floor(Math.random() * a.length)]; return s; }
function emptySlots() { return Array.from({ length: 4 }, () => ({ type: 'empty', name: '', peerId: null })); }

function show(screen) {
  ['screen-home', 'screen-lobby'].forEach(s => $(s).style.display = s === screen ? 'flex' : 'none');
  $('screen-game').style.display = 'none';
}

// ---------------------------------------------------------------- host helpers
function broadcastLobby() { if (isHost && net) net.sendLobby({ slots, mode, hostId }); }
function assignPeer(name, peerId) {
  if (slots.some(s => s.peerId === peerId)) return;
  const n = MODES[mode].n;
  for (let i = 0; i < n; i++) if (slots[i].type === 'empty') { slots[i] = { type: 'human', name: name || 'Player', peerId }; break; }
  broadcastLobby(); renderLobby();
}
function freePeer(peerId) {
  const i = slots.findIndex(s => s.peerId === peerId);
  if (i >= 0) { slots[i] = { type: 'empty', name: '', peerId: null }; broadcastLobby(); renderLobby(); }
}

// ---------------------------------------------------------------- create / join
function createRoom() {
  myName = ($('nameInput').value || 'Commander').slice(0, 14);
  roomCode = rndCode();
  net = joinNet(roomCode);
  isHost = true; hostId = net.selfId;
  slots = emptySlots();
  slots[0] = { type: 'human', name: myName + ' (you)', peerId: net.selfId };
  wireNet();
  show('screen-lobby'); renderLobby();
}
function joinRoom() {
  myName = ($('nameInput').value || 'Commander').slice(0, 14);
  const code = ($('codeInput').value || '').toUpperCase().trim();
  if (code.length < 3) { flash('Enter a room code'); return; }
  roomCode = code;
  net = joinNet(roomCode);
  isHost = false; hostId = null;
  slots = emptySlots();
  wireNet();
  // announce ourselves to the host (retry as peers connect)
  const hello = () => net.sendHello({ name: myName });
  net.onPeerJoin(() => hello());
  setTimeout(hello, 400); setTimeout(hello, 1500);
  show('screen-lobby'); renderLobby();
  $('lobbyHint').textContent = 'Connecting to ' + code + '...';
}
function quickSolo() {
  myName = ($('nameInput').value || 'Commander').slice(0, 14);
  roomCode = rndCode();
  net = joinNet(roomCode);
  isHost = true; hostId = net.selfId;
  slots = emptySlots();
  slots[0] = { type: 'human', name: myName + ' (you)', peerId: net.selfId };
  mode = 'ffa';
  for (let i = 1; i < 4; i++) slots[i] = { type: 'bot', name: 'CPU ' + i, peerId: null };
  wireNet();
  startAsHost();
}

function wireNet() {
  if (isHost) {
    net.onHello((d, peerId) => assignPeer(d.name, peerId));
    net.onPeerJoin(() => broadcastLobby());
    net.onPeerLeave(peerId => freePeer(peerId));
  } else {
    net.onLobby(d => { slots = d.slots; mode = d.mode; hostId = d.hostId; renderLobby(); $('lobbyHint').textContent = 'In lobby ' + roomCode; });
    net.onStart(d => startAsClient(d));
  }
}

// ---------------------------------------------------------------- start
function buildStartPacket() {
  const L = MODES[mode], out = [];
  for (let i = 0; i < L.n; i++) out.push({
    slot: i, type: slots[i].type, name: slots[i].name.replace(' (you)', ''),
    team: L.teams[i], corner: L.corners[i], bonus: L.bonus[i], peerId: slots[i].peerId || null,
  });
  return { seed: Math.floor(Math.random() * 1e9), mode, slots: out };
}
function startAsHost() {
  const L = MODES[mode];
  for (let i = 0; i < L.n; i++) if (slots[i].type === 'empty') { flash('Fill every slot or add bots'); return; }
  const packet = buildStartPacket();
  net.sendStart(packet);
  enterGame(packet, 0);
}
function startAsClient(packet) {
  const mine = packet.slots.findIndex(s => s.peerId === net.selfId);
  enterGame(packet, mine < 0 ? 0 : mine);
}
function enterGame(packet, mySlot) {
  show(null);
  Game.start({ net, isHost, mySlot, seed: packet.seed, mode: packet.mode, slots: packet.slots, onLeave: backToHome });
}
function backToHome() { try { net && net.leave(); } catch (e) {} net = null; isHost = false; slots = emptySlots(); show('screen-home'); }

// ---------------------------------------------------------------- lobby UI
function setMode(m) {
  if (!isHost) return; mode = m;
  // drop anyone beyond the new slot count
  for (let i = MODES[mode].n; i < 4; i++) slots[i] = { type: 'empty', name: '', peerId: null };
  broadcastLobby(); renderLobby();
}
function addBot() {
  if (!isHost) return; const n = MODES[mode].n;
  for (let i = 0; i < n; i++) if (slots[i].type === 'empty') { slots[i] = { type: 'bot', name: 'CPU ' + i, peerId: null }; break; }
  broadcastLobby(); renderLobby();
}
function clickSlot(i) {
  if (!isHost) return;
  if (slots[i].type === 'bot') { slots[i] = { type: 'empty', name: '', peerId: null }; broadcastLobby(); renderLobby(); }
}
function renderLobby() {
  $('roomCode').textContent = roomCode;
  const L = MODES[mode];
  document.querySelectorAll('#modeRow .mbtn').forEach(b => b.classList.toggle('sel', b.dataset.m === mode));
  document.querySelectorAll('#modeRow .mbtn').forEach(b => b.style.display = isHost ? '' : (b.dataset.m === mode ? '' : 'none'));
  const wrap = $('slotList'); wrap.innerHTML = '';
  for (let i = 0; i < L.n; i++) {
    const s = slots[i]; const row = document.createElement('div'); row.className = 'slot';
    const team = TEAM_LETTER[L.teams[i]];
    const tag = s.type === 'empty' ? '<span class="muted">open</span>' : (s.type === 'bot' ? 'CPU' : s.name);
    row.innerHTML = `<span class="team t${L.teams[i]}">TEAM ${team}</span><span class="who">${tag}</span>` + (isHost && s.type === 'bot' ? '<span class="x">remove</span>' : '');
    if (isHost && s.type === 'empty') { const add = document.createElement('span'); add.className = 'addbot'; add.textContent = '+ bot'; add.onclick = () => addBot(); row.appendChild(add); }
    if (isHost && s.type === 'bot') row.querySelector('.x').onclick = () => clickSlot(i);
    wrap.appendChild(row);
  }
  $('startBtn').style.display = isHost ? '' : 'none';
  $('hostNote').style.display = isHost ? 'none' : 'block';
}

let flashT = 0;
function flash(m) { const el = $('lobbyFlash'); el.textContent = m; el.style.opacity = 1; clearTimeout(flashT); flashT = setTimeout(() => el.style.opacity = 0, 1800); }

// ---------------------------------------------------------------- wire DOM
addEventListener('DOMContentLoaded', () => {
  $('createBtn').onclick = createRoom;
  $('joinBtn').onclick = joinRoom;
  $('soloBtn').onclick = quickSolo;
  $('startBtn').onclick = startAsHost;
  $('leaveBtn').onclick = backToHome;
  $('playAgain').onclick = () => location.reload();
  document.querySelectorAll('#modeRow .mbtn').forEach(b => b.onclick = () => setMode(b.dataset.m));
  show('screen-home');
});
