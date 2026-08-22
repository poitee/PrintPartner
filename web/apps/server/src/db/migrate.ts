import { loadConfig } from "../config.js";
import { SqliteDatabase } from "./client.js";

const config = loadConfig();
const db = new SqliteDatabase(config.dataDir);
db.connect();
console.log(`Migrated SQLite database at ${db.dbPath}`);
db.close();
