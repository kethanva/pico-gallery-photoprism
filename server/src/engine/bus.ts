import { EventEmitter } from 'events';
import type { SseEvent } from '@pico/shared';

class EventBus extends EventEmitter {
  publish(event: SseEvent): void {
    this.emit('event', event);
  }

  subscribe(listener: (event: SseEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }
}

export const bus = new EventBus();
bus.setMaxListeners(200);
