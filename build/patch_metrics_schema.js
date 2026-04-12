import { query } from './db.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });
async function patchMetrics() {
    console.log('--- PATCHING SYSTEM_METRICS SCHEMA ---');
    try {
        // Rename columns if they exist with old names
        await query(`
            DO $$ 
            BEGIN 
                IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'system_metrics' AND column_name = 'value') THEN
                    ALTER TABLE system_metrics RENAME COLUMN "value" TO metric_value;
                END IF;
                IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'system_metrics' AND column_name = 'recorded_at') THEN
                    ALTER TABLE system_metrics RENAME COLUMN recorded_at TO created_at;
                END IF;
            END $$;
        `);
        console.log('✅ Columns renamed successfully.');
    }
    catch (err) {
        console.error('❌ Failed to patch system_metrics:', err);
    }
    finally {
        process.exit();
    }
}
patchMetrics();
