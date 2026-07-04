import { DEFAULT_DB_PATH, getDb, closeDb } from "../src/lib/db";

const db = getDb();
closeDb();

console.log(`Initialized SQLite database at ${DEFAULT_DB_PATH}`);
