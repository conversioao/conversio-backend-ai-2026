import { query } from './db.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });
async function fullDiagnostic() {
    console.log('--- GLOBAL DATABASE DIAGNOSTIC ---');
    const tablesToCheck = ['users', 'agent_logs', 'leads', 'campaigns', 'user_subscriptions', 'crm_interactions', 'agent_executions'];
    for (const table of tablesToCheck) {
        try {
            const res = await query(`
                SELECT column_name, data_type 
                FROM information_schema.columns 
                WHERE table_name = $1;
            `, [table]);
            if (res.rows.length === 0) {
                console.log(`[TABLE] ${table}: MISSING`);
            }
            else {
                console.log(`[TABLE] ${table}: EXISTS`);
                console.log(`  Columns: ${res.rows.map(r => r.column_name).join(', ')}`);
            }
        }
        catch (err) {
            console.error(`[ERROR] Checking table ${table}:`, err.message);
        }
    }
    console.log('--- END DIAGNOSTIC ---');
    process.exit();
}
fullDiagnostic();
