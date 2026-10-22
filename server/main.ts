// Starts the Multiverse Hub.
//   PORT          listen port (default 8787)
//   HUB_DATA_DIR  where users and uploads are stored (default ./hub-data)
//   STATIC_DIR    serve the built game too, e.g. ./dist (optional)
//   CORS_ORIGIN   allow browser calls from another origin (optional)
//   TRUST_PROXY   set to 1 behind a reverse proxy so rate limits see real IPs

import { createHub } from './app';
import { FileHubStore } from './store';

const port = Number(process.env.PORT) || 8787;
const server = createHub({
  store: new FileHubStore(process.env.HUB_DATA_DIR ?? './hub-data'),
  staticDir: process.env.STATIC_DIR,
  corsOrigin: process.env.CORS_ORIGIN,
  trustProxy: process.env.TRUST_PROXY === '1',
});

server.listen(port, () => {
  console.log(`Multiverse Hub listening on http://localhost:${port}`);
  if (process.env.STATIC_DIR) console.log(`Serving the game from ${process.env.STATIC_DIR}`);
});
