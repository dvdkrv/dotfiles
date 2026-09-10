import { createJiti } from 'jiti';

const { ensureBroker } = await createJiti(import.meta.url).import('../../src/broker-lifecycle.ts');

process.once('message', async ({ agentDir, binary, port }) => {
  try {
    const result = await ensureBroker({ agentDir, binary, port, startupTimeoutMs: 10000 });
    process.send?.({ state: result.state, authorityId: result.config.authorityId });
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    process.disconnect?.();
  }
});
