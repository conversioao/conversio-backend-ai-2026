import pkg from 'pg';
const { Client } = pkg;
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });
const client = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
});
const key = process.env.OPENAI_API_KEY || '';
async function run() {
    try {
        await client.connect();
        console.log('Connected to DB');
        await client.query(`
      INSERT INTO system_settings (key, value) 
      VALUES ('openai_api_key', $1) 
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [key]);
        console.log('OpenAI API Key updated in database');
    }
    catch (err) {
        console.error('Error updating key:', err);
    }
    finally {
        await client.end();
    }
}
run();
