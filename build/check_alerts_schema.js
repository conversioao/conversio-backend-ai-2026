import { query } from './db.js';
async function checkSchema() {
    try {
        const res = await query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'alerts'
        `);
        console.log('Columns in alerts:', res.rows);
    }
    catch (e) {
        console.error('Error checking schema:', e);
    }
}
checkSchema();
