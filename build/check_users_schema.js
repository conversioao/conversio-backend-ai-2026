import { query } from './db.js';
async function checkUsersSchema() {
    try {
        const res = await query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'users'
        `);
        console.log('Columns in users:', JSON.stringify(res.rows, null, 2));
    }
    catch (e) {
        console.error('Error checking users schema:', e);
    }
}
checkUsersSchema();
