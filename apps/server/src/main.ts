import 'reflect-metadata';
import { Agent, setGlobalDispatcher } from 'undici';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module.js';

// Pin a long-lived undici Agent so repeated fetches to the same API host
// (DeepSeek, OpenAI, ...) reuse TLS + TCP connections. Saves ~300ms handshake
// per request when Orchestrator fires many parallel task calls.
setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
    connections: 32,
  }),
);

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const bodyLimit = process.env.AGENTHUB_BODY_LIMIT ?? '25mb';
  app.useBodyParser('json', { limit: bodyLimit });
  app.useBodyParser('urlencoded', { extended: true, limit: bodyLimit });
  app.useWebSocketAdapter(new WsAdapter(app));
  // Local single-user dev tool: accept any localhost / loopback / private-LAN
  // origin on ANY port. The web app derives its API base from
  // window.location, so accessing the UI via 127.0.0.1, a LAN IP (phone
  // testing), or a non-3000 port must all work without a CORS wall. An
  // explicit WEB_ORIGIN (e.g. a public deploy) is always allowed too.
  const explicitOrigin = process.env.WEB_ORIGIN;
  const isLocalOrigin = (origin: string): boolean => {
    try {
      const { hostname } = new URL(origin);
      if (hostname === 'localhost' || hostname === '::1') return true;
      // IPv4 loopback + RFC1918 private ranges (LAN testing).
      if (/^127\./.test(hostname)) return true;
      if (/^10\./.test(hostname)) return true;
      if (/^192\.168\./.test(hostname)) return true;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
      return false;
    } catch {
      return false;
    }
  };
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || origin === explicitOrigin || isLocalOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
  });
  const port = Number(process.env.SERVER_PORT ?? 4000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[AgentHub server] listening on http://localhost:${port}`);
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
