import { query } from './db.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

async function checkTable() {
    console.log('--- Database Health Check ---');
    try {
        const res = await query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'ugc_used_combinations'
            );
        `);
        console.log('Table ugc_used_combinations exists:', res.rows[0].exists);
        
        if (!res.rows[0].exists) {
            console.log('Creating table ugc_used_combinations...');
            await query(`
                CREATE TABLE ugc_used_combinations (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    product_hash VARCHAR(64) NOT NULL,
                    tipo_ugc VARCHAR(100),
                    sub_cena TEXT,
                    angulo_camara TEXT,
                    emocao_dominante TEXT,
                    gancho_tipo TEXT,
                    cenario TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX idx_ugc_user_hash ON ugc_used_combinations(user_id, product_hash);
            `);
            console.log('Table created successfully.');
        } else {
            // Check if product_hash column exists (in case the table was created without it)
            const colRes = await query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name='ugc_used_combinations' AND column_name='product_hash';
            `);
            if (colRes.rows.length === 0) {
                console.log('Adding product_hash column to ugc_used_combinations...');
                await query('ALTER TABLE ugc_used_combinations ADD COLUMN product_hash VARCHAR(64) DEFAULT \'general-batch\';');
            }
        }
    } catch (err) {
        console.error('Error during health check:', err);
    } finally {
        console.log('--- Check Finished ---');
        process.exit();
    }
}

checkTable();
