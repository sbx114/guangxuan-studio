import { startServer } from '../../server.mjs';

// No unhandledRejection/uncaughtException listener: rejected routes must be
// caught by the production HTTP handler, rather than concealed by the fixture.
const app = await startServer({ dataDir: process.env.GX_MEDIA_OPERATION_DATA, port: 0 });
process.send?.({ origin: app.url });
process.on('message', async message => { if (message === 'close') { await app.close(); process.exit(0); } });
