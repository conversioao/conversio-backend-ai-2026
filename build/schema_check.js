import { query } from './db.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });
async function checkSchema() {
    console.log('--- Database Schema Check ---');
    try {
        const res = await query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'generations' AND column_name = 'metadata';
        `);
        console.log('Column metadata details:', res.rows[0]);
        const isJsonb = res.rows[0]?.data_type === 'jsonb';
        if (!isJsonb) {
            console.log('Column metadata is NOT jsonb. Attempting to convert...');
            // In some DBs we might need to cast
            try {
                await query('ALTER TABLE generations ALTER COLUMN metadata TYPE jsonb USING metadata::jsonb;');
                console.log('Column converted to jsonb successfully.');
            }
            catch (convErr) {
                console.warn('Conversion failed (maybe it is already jsonb with a different name or just json):', convErr.message);
            }
        }
    }
    catch (err) {
        console.error('Error during schema check:', err);
    }
    finally {
        process.exit();
    }
}
checkSchema();
