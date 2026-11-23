import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts';

export class Net {
  private ws: WebSocket | null = null;
  onMessage: (m: ServerMsg) => void = () => {};
  onClose: () => void = () => {};
  onOpen: () => void = () => {};

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => this.onOpen();
    ws.onmessage = (e) => {
      try { this.onMessage(JSON.parse(e.data as string)); } catch (err) { console.error(err); }
    };
    ws.onclose = () => { if (this.ws === ws) this.onClose(); };
  }

  send(m: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  get open() { return this.ws?.readyState === WebSocket.OPEN; }
}
