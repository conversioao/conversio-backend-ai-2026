import { query } from './db.js';
async function check() {
    try {
        const result = await query('SELECT * FROM system_settings');
        console.log('[Settings]', JSON.stringify(result.rows, null, 2));
        process.exit(0);
    }
    catch (error) {
        console.error('[Settings] Error:', error);
        process.exit(1);
    }
}
check();
