import type { SlideshowState } from '@pico/shared';

type StateCallback = (state: SlideshowState) => void;
type DisplayCallback = (on: boolean) => void;
type ConnectionCallback = () => void;

export class SlideshowEventSource {
  private es: EventSource | null = null;
  private onStateCallbacks: StateCallback[] = [];
  private onDisplayCallbacks: DisplayCallback[] = [];
  private onConnectCallbacks: ConnectionCallback[] = [];
  private onDisconnectCallbacks: ConnectionCallback[] = [];

  connect(): void {
    this.es = new EventSource('/api/v1/events');

    this.es.addEventListener('state', (e: MessageEvent) => {
      const state = JSON.parse(e.data) as SlideshowState;
      this.onStateCallbacks.forEach((cb) => cb(state));
    });

    this.es.addEventListener('display', (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { on: boolean };
      this.onDisplayCallbacks.forEach((cb) => cb(data.on));
    });

    this.es.onopen = () => this.onConnectCallbacks.forEach((cb) => cb());
    this.es.onerror = () => this.onDisconnectCallbacks.forEach((cb) => cb());
  }

  onState(cb: StateCallback): void { this.onStateCallbacks.push(cb); }
  onDisplay(cb: DisplayCallback): void { this.onDisplayCallbacks.push(cb); }
  onConnect(cb: ConnectionCallback): void { this.onConnectCallbacks.push(cb); }
  onDisconnect(cb: ConnectionCallback): void { this.onDisconnectCallbacks.push(cb); }

  disconnect(): void {
    this.es?.close();
    this.es = null;
  }
}
