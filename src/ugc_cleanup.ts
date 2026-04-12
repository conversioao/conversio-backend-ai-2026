import { query } from './db.js';

/**
 * UGC Anti-Repetition Cleanup Job
 * Deletes records older than 30 days.
 */
async function runCleanup() {
    console.log('[UGC Cleanup] Starting cleanup job...');
    try {
        const result = await query(
            "DELETE FROM ugc_used_combinations WHERE created_at < NOW() - INTERVAL '30 days'"
        );
        
        console.log(`[UGC Cleanup] Success. Deleted ${result.rowCount} old combinations.`);
        process.exit(0);
    } catch (err) {
        console.error('[UGC Cleanup] Failed:', err);
        process.exit(1);
    }
}

runCleanup();
