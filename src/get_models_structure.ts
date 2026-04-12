import { query } from './db.js';

async function check() {
    try {
        const res = await query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'models'
        `);
        console.table(res.rows);
    } catch(e) { console.error(e); }
    process.exit(0);
}
check();
