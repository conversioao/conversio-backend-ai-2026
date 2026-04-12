import { query } from './db.js';
async function migrate() {
    console.log('--- Applying Migrations ---');
    try {
        // system_metrics
        try {
            await query("ALTER TABLE system_metrics ADD COLUMN IF NOT EXISTS metric_value NUMERIC");
        }
        catch (e) { }
        try {
            await query("ALTER TABLE system_metrics ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
        }
        catch (e) { }
        // alerts
        try {
            await query("ALTER TABLE alerts ADD COLUMN IF NOT EXISTS severity TEXT DEFAULT 'info'");
        }
        catch (e) { }
        try {
            await query("ALTER TABLE alerts ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'");
        }
        catch (e) { }
        try {
            await query("ALTER TABLE alerts RENAME COLUMN description TO message").catch(() => { });
        }
        catch (e) { } // In case it was description
        console.log('✅ Migrations applied.');
    }
    catch (e) {
        console.error('❌ Migration failed:', e);
    }
}
migrate();
