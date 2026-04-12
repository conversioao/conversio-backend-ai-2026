import { query } from './db.js';
async function fixWebhooks() {
    try {
        console.log('[Migration] Fixing n8n webhooks in system_settings...');
        // Fetch all webhook keys
        const result = await query("SELECT key, value FROM system_settings WHERE key LIKE 'webhook_%'");
        for (const row of result.rows) {
            if (row.value.includes('/webhook-test/')) {
                const newValue = row.value.replace('/webhook-test/', '/webhook/');
                console.log(`[Migration] Updating ${row.key}: ${row.value} -> ${newValue}`);
                await query('UPDATE system_settings SET value = $1 WHERE key = $2', [newValue, row.key]);
            }
        }
        console.log('[Migration] Webhooks fixed.');
        process.exit(0);
    }
    catch (error) {
        console.error('[Migration] Failed to fix webhooks:', error);
        process.exit(1);
    }
}
fixWebhooks();
