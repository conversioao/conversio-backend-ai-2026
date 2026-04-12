import fs from 'fs';
import { query } from './db.js';

async function run() {
  try {
    const sql = fs.readFileSync('db/migration_transactions_fix.sql', 'utf8');
    await query(sql);
    console.log('Fixed!');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
