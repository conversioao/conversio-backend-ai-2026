import { query } from './db.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });
async function check() {
    try {
        console.log('[Database] Connecting to host:', process.env.DB_HOST);
        const dbList = await query('SELECT datname FROM pg_database WHERE datistemplate = false');
        console.log('Available databases:', dbList.rows.map(r => r.datname).join(', '));
        console.log('Current database:', (await query('SELECT current_database()')).rows[0].current_database);
        console.log('Current user:', (await query('SELECT current_user')).rows[0].current_user);
        const res = await query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
        `);
        console.log('Tables in current DB:', res.rows.map(r => r.table_name).join(', '));
        const batchIds = await query("SELECT batch_id, status FROM generations ORDER BY created_at DESC LIMIT 5");
        console.log('Recent Batches:', JSON.stringify(batchIds.rows, null, 2));
        const ugcExists = res.rows.some(r => r.table_name === 'ugc_used_combinations');
        console.log('ugc_used_combinations exists in current DB:', ugcExists);
        const targetUserId = '77616cbf-fba0-432d-a810-afe253eb0167';
        const userCheck = await query('SELECT id, name FROM users WHERE id = $1', [targetUserId]);
        if (userCheck.rows.length > 0) {
            console.log(`User ${targetUserId} FOUND in current DB:`, userCheck.rows[0].name);
        }
        else {
            console.log(`User ${targetUserId} NOT FOUND in current DB.`);
        }
    }
    catch (err) {
        console.error('Error checking databases:', err.message);
    }
    process.exit(0);
}
check();
