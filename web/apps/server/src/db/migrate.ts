import { loadConfig } from "../config.js";
import { SqliteDatabase } from "./client.js";
import { prepareSqliteUpgrade } from "./upgrade-guard.js";

const config = loadConfig();
await prepareSqliteUpgrade({ dataDir: config.dataDir, appVersion: config.version });
const db = new SqliteDatabase(config.dataDir);
db.connect();
console.log(`Migrated SQLite database at ${db.dbPath}`);
db.close();
