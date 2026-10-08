import { acquireDataDirectory } from '../../apps/server/src/desktop-context.js';
import { SqliteDatabase } from '../../apps/server/src/db/client.js';
const directory = process.argv[2];
const release = acquireDataDirectory(directory);
const database = new SqliteDatabase(directory);
try {
    database.connect();
    process.stdout.write('node-opened\n');
}
finally {
    database.close();
    release();
}
