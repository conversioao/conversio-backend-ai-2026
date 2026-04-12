import { query } from './db.js';
async function migrate() {
    try {
        console.log('[Migration] Adding category column to whatsapp_logs...');
        await query(`ALTER TABLE whatsapp_logs ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'general';`);
        console.log('[Migration] Success! Category column added.');
        process.exit(0);
    }
    catch (error) {
        console.error('[Migration] Failed:', error.message);
        process.exit(1);
    }
}
migrate();
