import { acquireDataDirectory } from "../desktop-context.js";
import { loadConfig } from "../config.js";
import { SqliteDatabase } from "./client.js";
import { prepareSqliteUpgrade } from "./upgrade-guard.js";

const config = loadConfig();
const releaseOwner = acquireDataDirectory(config.dataDir);
const db = new SqliteDatabase(config.dataDir);
try {
  await prepareSqliteUpgrade({ dataDir: config.dataDir, appVersion: config.version });
  db.connect();
  console.log(`Migrated SQLite database at ${db.dbPath}`);
} finally {
  db.close();
  releaseOwner();
}
