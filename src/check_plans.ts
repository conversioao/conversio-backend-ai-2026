import { query } from './db.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

async function checkPlans() {
    try {
        const res = await query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'plans' AND column_name = 'id';
        `);
        console.log('Plans ID column:', res.rows[0]);
    } catch (err) {
        console.error('Error:', err);
    } finally {
        process.exit();
    }
}

checkPlans();
