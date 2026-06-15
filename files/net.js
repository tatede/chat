// net.js  --  thin wrapper around Trystero (WebRTC peer to peer, no server).
// Signalling rides on free public infrastructure, so there is nothing to host.
// The room creator acts as host; that decision is made in lobby.js, not here.

import { joinRoom, selfId } from 'https://esm.sh/trystero@0.21.5/torrent';

const APP_ID = 'frontline1944mp';

export { selfId };

export function joinNet(roomCode) {
  const room = joinRoom({ appId: APP_ID }, roomCode);

  // Each channel name must be <= 12 bytes.
  const [sLobby, gLobby] = room.makeAction('lobby');
  const [sStart, gStart] = room.makeAction('start');
  const [sCmd,   gCmd]   = room.makeAction('cmd');
  const [sSnap,  gSnap]  = room.makeAction('snap');
  const [sHello, gHello] = room.makeAction('hello');

  return {
    selfId,
    room,
    leave: () => { try { room.leave(); } catch (e) {} },
    onPeerJoin: f => room.onPeerJoin(f),
    onPeerLeave: f => room.onPeerLeave(f),

    sendLobby: d => sLobby(d),
    onLobby:   f => gLobby((d, p) => f(d, p)),
    sendStart: d => sStart(d),
    onStart:   f => gStart((d, p) => f(d, p)),
    sendCmd:   (d, to) => sCmd(d, to),
    onCmd:     f => gCmd((d, p) => f(d, p)),
    sendSnap:  d => sSnap(d),
    onSnap:    f => gSnap((d, p) => f(d, p)),
    sendHello: d => sHello(d),
    onHello:   f => gHello((d, p) => f(d, p)),
  };
}
