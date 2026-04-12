import { getClient } from './db.js';

async function migrate() {
  let client;
  try {
    client = await getClient();

    console.log('Connected to DB');
    await client.query('ALTER TABLE generations ADD COLUMN IF NOT EXISTS copy TEXT;');
    await client.query('ALTER TABLE generations ADD COLUMN IF NOT EXISTS hashtags TEXT;');
    await client.query('ALTER TABLE generations ADD COLUMN IF NOT EXISTS batch_id TEXT;');
    console.log('Migration successful: copy, hashtags, and batch_id columns added.');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await client.end();
  }
}

migrate();
