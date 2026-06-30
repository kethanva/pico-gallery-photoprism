import type { FastifyRequest, FastifyReply } from 'fastify';
import { bus } from '../engine/bus.js';
import type { SseEvent } from '@pico/shared';
import { getEngine } from '../engine/index.js';

export async function sseHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { raw: res } = reply;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event: SseEvent) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  };

  // Send current state immediately on connect
  try {
    const state = getEngine().getState();
    send({ type: 'state', data: state });
  } catch {
    // Engine not ready yet — the first bus event will deliver state instead.
  }

  const unsub = bus.subscribe(send);
  const keepalive = setInterval(() => res.write(': ping\n\n'), 25000);

  req.socket.on('close', () => {
    clearInterval(keepalive);
    unsub();
  });

  // Hold the connection open
  await new Promise<void>((resolve) => req.socket.once('close', resolve));
}
