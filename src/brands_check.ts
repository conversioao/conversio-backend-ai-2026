import { query } from './db.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

async function checkBrandsSchema() {
    console.log('--- Brands Schema Check ---');
    try {
        const res = await query(`
            SELECT column_name
            FROM information_schema.columns 
            WHERE table_name = 'brands';
        `);
        console.log('Columns in brands:', res.rows.map(r => r.column_name));
    } catch (err) {
        console.error('Error during brands schema check:', err);
    } finally {
        process.exit();
    }
}

checkBrandsSchema();
