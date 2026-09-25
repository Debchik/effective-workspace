import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { loadConfig } from './config.js';
import { Store } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({
  path: path.resolve(here, '../../../.env')
});
dotenv.config({
  path: path.resolve(here, '../.env')
});

const config = loadConfig();
const dbPath = path.join(
  config.dataDir,
  'effective-workspace.sqlite'
);

const store = new Store(dbPath);
store.close();

console.log('SQLite initialized at ' + dbPath);
