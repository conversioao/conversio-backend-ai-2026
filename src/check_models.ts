import { pool } from './db.js';

async function checkModels() {

  const client = await pool.connect();
  try {
    console.log('Fetching all models...');
    const res = await client.query('SELECT name, slug FROM models');
    console.log('Available Models:');
    res.rows.forEach(row => {
      console.log(`- ${row.name} (${row.slug})`);
    });
  } catch (err) {
    console.error('Error fetching models:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

checkModels();
