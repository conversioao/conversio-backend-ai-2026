const { Pool } = require('pg');
require('dotenv').config({ path: '.env' });

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME || 'conversioai',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function migrate() {
    try {
        console.log('[Migration] Adding category column to whatsapp_logs...');
        await pool.query(`ALTER TABLE whatsapp_logs ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'general';`);
        console.log('[Migration] Success! Category column added.');
        process.exit(0);
    } catch (error) {
        console.error('[Migration] Failed:', error);
        process.exit(1);
    }
}

migrate();
