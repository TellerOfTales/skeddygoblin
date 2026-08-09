/**
 * A minimal HTTP server whose only job is the Steam OpenID return_to callback.
 *
 * Deliberately node:http rather than a framework. It serves two routes, has no
 * templating, no sessions and no static assets - a framework here would be
 * dependency surface for nothing. The brief also rules out a web frontend until
 * Steam forces one, and this is exactly the minimum Steam forces.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { optionalSteamConfig } from '../config.js';
import { verifyCallback } from '../steam/openid.js';
import { completeLink } from '../services/steamService.js';
import type { AppContext } from '../services/context.js';

function page(title: string, body: string): string {
  // Deliberately plain: this page is seen once, for two seconds, and its only
  // job is to say whether the link worked.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto;
         padding: 0 1.5rem; line-height: 1.6; }
  h1 { font-size: 1.4rem; }
  .muted { color: #666; }
</style></head>
<body><h1>${title}</h1>${body}</body></html>`;
}

function send(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
}

async function handleCallback(ctx: AppContext, url: URL, response: ServerResponse): Promise<void> {
  const state = url.searchParams.get('state');
  if (!state) {
    send(response, 400, page('Something went missing', '<p>That link was incomplete.</p>'));
    return;
  }

  // Steam's assertion arrives through the user's browser and is forgeable, so
  // it is checked with Steam directly before we believe the SteamID.
  const verification = await verifyCallback(url.searchParams);
  if (!verification.ok || !verification.steamId) {
    ctx.logger.warn('steam openid verification failed', { reason: verification.reason });
    send(
      response,
      400,
      page('Could not verify that', '<p>Steam did not confirm the sign-in. Try again.</p>'),
    );
    return;
  }

  try {
    const outcome = await completeLink(ctx, { state, steamId: verification.steamId });

    if (!outcome.profilePublic) {
      send(
        response,
        200,
        page(
          'Linked, but your library is hidden',
          `<p>Your Steam account is connected, but its game details are private, so
           Skeddy Goblin cannot see what you own.</p>
           <p class="muted">Steam &rarr; Profile &rarr; Edit Profile &rarr; Privacy Settings &rarr;
           set <strong>Game details</strong> to Public, then run
           <code>/link-steam</code> again.</p>`,
        ),
      );
      return;
    }

    send(
      response,
      200,
      page(
        'Steam linked 🧌',
        `<p>Synced <strong>${outcome.gamesSynced}</strong> games. You can close this tab.</p>
         <p class="muted">Only counts are ever shown to your group &mdash; never which
         games are yours.</p>`,
      ),
    );
  } catch (error) {
    ctx.logger.error('steam link failed', { error });
    send(
      response,
      400,
      page('That link has expired', '<p>Run <code>/link-steam</code> again for a fresh one.</p>'),
    );
  }
}

export function createHttpServer(ctx: AppContext): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    if (url.pathname === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
      return;
    }

    if (url.pathname === '/steam/callback') {
      void handleCallback(ctx, url, response).catch((error: unknown) => {
        ctx.logger.error('steam callback crashed', { error });
        if (!response.headersSent) send(response, 500, page('Something went wrong', ''));
      });
      return;
    }

    send(response, 404, page('Not found', ''));
  });
}

/** Starts the callback server, or returns undefined when Steam is unconfigured. */
export function startHttpServer(ctx: AppContext, port: number): Server | undefined {
  if (!optionalSteamConfig()) {
    ctx.logger.info('steam not configured, callback server not started');
    return undefined;
  }

  const server = createHttpServer(ctx);
  server.listen(port, () => ctx.logger.info('steam callback server listening', { port }));
  return server;
}
