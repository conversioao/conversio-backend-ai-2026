const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/conversio'
});

const VIDEO_CORES = [
  { name: 'Campanha Institucional', style_id: 'VID-INST' },
  { name: 'Antes e Depois Visual', style_id: 'VID-BEFORE-AFTER' },
  { name: 'Problema Solução ResultadoLifestyle', style_id: 'VID-LIFESTYLE' },
  { name: 'Cinematic Product Hero', style_id: 'VID-PRODUCT' },
  { name: 'UGC Influencer', style_id: 'VID-UGC' }
];

async function run() {
  await client.connect();
  console.log('Connected to DB');

  for (const core of VIDEO_CORES) {
    const res = await client.query('SELECT id FROM models WHERE name = $1 AND type = \'video\'', [core.name]);
    if (res.rows.length === 0) {
      await client.query(
        'INSERT INTO models (type, name, style_id, category, credit_cost, is_active) VALUES ($1, $2, $3, $4, $5, $6)',
        ['video', core.name, core.style_id, 'core', 5, true]
      );
      console.log(`Created core: ${core.name}`);
    } else {
      console.log(`Core already exists: ${core.name}`);
    }
  }

  // Deactivate old cores that are not in the new list
  const activeNames = VIDEO_CORES.map(c => c.name);
  await client.query(
    'UPDATE models SET is_active = false WHERE type = \'video\' AND category = \'core\' AND name != ALL($1)',
    [activeNames]
  );
  console.log('Deactivated old video cores');

  await client.end();
}

run().catch(console.error);
