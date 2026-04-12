import { query } from './db.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });
async function checkGenerationsSchema() {
    console.log('--- Generations Schema Check ---');
    try {
        const res = await query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'generations';
        `);
        console.log('Columns in generations:', res.rows.map(r => r.column_name));
        const hasBatchId = res.rows.some(r => r.column_name === 'batch_id');
        if (!hasBatchId) {
            console.log('Column batch_id is MISSING. Adding it...');
            await query('ALTER TABLE generations ADD COLUMN batch_id VARCHAR(100);');
            await query('CREATE INDEX idx_gen_batch ON generations(batch_id);');
            console.log('Column batch_id added successfully.');
        }
        else {
            console.log('Column batch_id exists.');
        }
    }
    catch (err) {
        console.error('Error during generations schema check:', err);
    }
    finally {
        process.exit();
    }
}
checkGenerationsSchema();
