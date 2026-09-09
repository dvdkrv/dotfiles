import { createJiti } from 'jiti';
const { connectBackend } = await createJiti(import.meta.url).import('../../src/nats-backend.ts');
let backend;
process.on('message', async value => {
  try {
    if (value === 'reserve') { const r = await backend.reserve(); process.send(r ? { attemptId: r.attemptId } : {}); }
    else { backend = await connectBackend(value.config); const peer = await backend.join(value.g, { sessionId: `child-${value.i}`, displayName: `Child ${value.i}` }); process.send(peer); }
  } catch (error) { process.send({ error: String(error) }); }
});
