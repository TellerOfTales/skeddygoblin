import { describe, expect, it } from 'vitest';
import { createHttpServer } from '../../src/http/server.js';
import { silentLogger } from '../helpers/db.js';
import type { AppContext } from '../../src/services/context.js';

const ctx = { logger: silentLogger } as unknown as AppContext;

describe('http server without Steam configured', () => {
  it('answers /healthz, so a platform health check passes', async () => {
    const server = createHttpServer(ctx);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');

    // ...and the Steam route is absent rather than half-working.
    const callback = await fetch(`http://127.0.0.1:${port}/steam/callback?state=x`);
    expect(callback.status).toBe(404);

    server.close();
  });
});
