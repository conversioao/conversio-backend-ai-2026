const { Pool } = require('pg');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const pool = new Pool({
    host: process.env.DB_HOST || '89.167.111.239',
    port: parseInt(process.env.DB_PORT || '5433'),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || '123456',
    database: process.env.DB_NAME || 'postgres',
    ssl: false
});

async function cleanup() {
    console.log('Starting DB cleanup and enhancement...');
    try {
        // 1. Cleanup plans table
        console.log('Consolidating plans columns...');
        await pool.query(`
            DO $$ 
            BEGIN 
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='plans' AND column_name='price') THEN
                    ALTER TABLE plans DROP COLUMN price;
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='plans' AND column_name='credits') THEN
                    ALTER TABLE plans DROP COLUMN credits;
                END IF;
            END $$;
        `);

        // 2. Enhance credit_packages table
        console.log('Enhancing credit_packages...');
        await pool.query(`
            ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS total_credits INTEGER;
        `);
        
        await pool.query(`
            UPDATE credit_packages SET total_credits = images + (videos * 5) WHERE total_credits IS NULL;
        `);

        console.log('Cleanup completed successfully!');
    } catch (error) {
        console.error('Cleanup failed:', error);
    } finally {
        await pool.end();
    }
}

cleanup();
