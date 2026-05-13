import 'reflect-metadata';
import { Agent, setGlobalDispatcher } from 'undici';
import { NestFactory } from '@nestjs/core';
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
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
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
