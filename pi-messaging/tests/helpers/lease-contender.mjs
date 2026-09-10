import { createJiti } from 'jiti';

const { connectBackend } = await createJiti(import.meta.url).import('../../src/nats-backend.ts');
let backend;
let group;
let reservation;

process.on('message', async request => {
  try {
    switch (request.action) {
      case 'init':
        group = request.group;
        backend = await connectBackend(request.config);
        await backend.resume(group, request.peerId, request.sessionId);
        process.send({ ok: true });
        return;
      case 'heartbeat':
        await backend.heartbeat();
        break;
      case 'rename':
        await backend.heartbeat('old-process-role');
        break;
      case 'send':
        await backend.send({ toPeerId: request.toPeerId, text: 'forbidden old-process send' }, 'old-process-send');
        break;
      case 'reserve':
        reservation = await backend.reserve();
        process.send({ ok: true, ...(reservation ? { messageId: reservation.message.id } : {}) });
        return;
      case 'observe':
        await backend.observe(reservation);
        break;
      case 'suspend': {
        // Preserve the test process's stale local handle so the independent leave
        // assertion can exercise the same fenced lease after suspend rejects.
        const participant = backend.participant;
        const consumer = backend.consumer;
        try { await backend.suspend(); }
        catch (error) { backend.participant = participant; backend.consumer = consumer; throw error; }
        break;
      }
      case 'leave':
        await backend.leave();
        break;
      case 'close':
        await backend?.close();
        process.send({ ok: true });
        return;
      default:
        throw new Error(`unknown action: ${request.action}`);
    }
    process.send({ ok: true });
  } catch (error) {
    process.send({ ok: false, code: error?.code, message: error instanceof Error ? error.message : String(error) });
  }
});
