// Starts the Multiverse Hub.
//   PORT          listen port (default 8787)
//   DATABASE_URL  PostgreSQL connection string; without it, data goes to HUB_DATA_DIR
//   DATABASE_SSL  set to 1 to use TLS without verifying the certificate (some hosts' external URLs)
//   HUB_DATA_DIR  file storage directory for local use (default ./hub-data)
//   STATIC_DIR    serve the built game too, e.g. ./dist (optional)
//   CORS_ORIGIN   allow browser calls from another origin (optional)
//   TRUST_PROXY   set to 1 behind a reverse proxy so rate limits see real IPs

import { createHub } from './app';
import { PgHubStore } from './pg-store';
import { FileHubStore, type HubStore } from './store';

async function main() {
  const port = Number(process.env.PORT) || 8787;
  const databaseUrl = process.env.DATABASE_URL;
  const store: HubStore = databaseUrl
    ? await PgHubStore.connect(databaseUrl, { ssl: process.env.DATABASE_SSL === '1' })
    : new FileHubStore(process.env.HUB_DATA_DIR ?? './hub-data');

  const server = createHub({
    store,
    staticDir: process.env.STATIC_DIR,
    corsOrigin: process.env.CORS_ORIGIN,
    trustProxy: process.env.TRUST_PROXY === '1',
  });

  server.listen(port, () => {
    console.log(`Multiverse Hub listening on port ${port} (${databaseUrl ? 'PostgreSQL' : 'file storage'})`);
    if (process.env.STATIC_DIR) console.log(`Serving the game from ${process.env.STATIC_DIR}`);
  });

  // Hosts send SIGTERM on redeploys; finish in-flight requests, then close the pool.
  const shutdown = () => {
    server.close(() => void store.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error('Hub failed to start:', e);
  process.exit(1);
});
