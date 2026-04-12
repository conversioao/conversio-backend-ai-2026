import { query } from './db.js';
async function migrate() {
    try {
        console.log('[Migration] Verifying brand_logo_url column...');
        // Add the column if it doesn't exist
        await query(`
            ALTER TABLE users 
            ADD COLUMN IF NOT EXISTS brand_logo_url TEXT;
        `);
        console.log('[Migration] Success: brand_logo_url column verified/added.');
        process.exit(0);
    }
    catch (error) {
        console.error('[Migration] Failed:', error);
        process.exit(1);
    }
}
migrate();
