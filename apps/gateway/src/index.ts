import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({
  path: path.resolve(here, '../../../.env')
});
dotenv.config({
  path: path.resolve(here, '../.env')
});

const config = loadConfig();
const app = await buildServer(config);

try {
  await app.listen({
    host: config.host,
    port: config.port
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
