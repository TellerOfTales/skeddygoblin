import { describe, expect, it } from 'vitest';
import { createHttpServer, type BootPhase } from '../../src/http/server.js';
import { silentLogger } from '../helpers/db.js';
import type { AppContext } from '../../src/services/context.js';

const ctx = { logger: silentLogger } as unknown as AppContext;

async function listen(server: ReturnType<typeof createHttpServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return (server.address() as { port: number }).port;
}

describe('http server without Steam configured', () => {
  it('answers /healthz, so a platform health check passes', async () => {
    const server = createHttpServer(ctx);
    const port = await listen(server);

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok ready');

    // ...and the Steam route is absent rather than half-working.
    const callback = await fetch(`http://127.0.0.1:${port}/steam/callback?state=x`);
    expect(callback.status).toBe(404);

    server.close();
  });

  /**
   * The failure this guards against: boot used to bind the port only after the
   * Discord login resolved, so a slow or failing gateway meant the platform
   * health check never passed and the deploy was reported as unhealthy with no
   * hint as to why. /healthz must answer 200 in every phase, and say which one.
   */
  it('answers 200 mid-boot, before the database or Discord are reachable', async () => {
    let phase: BootPhase = 'starting';
    const server = createHttpServer(ctx, () => phase);
    const port = await listen(server);

    for (const current of ['starting', 'migrating', 'connecting-to-discord'] as const) {
      phase = current;
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.text()).toBe(`ok ${current}`);
    }

    server.close();
  });
});
