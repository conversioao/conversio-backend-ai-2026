import { pool } from './db.js';
async function inspectPlansSchema() {
    const client = await pool.connect();
    try {
        console.log('Inspecting plans table columns...');
        const query = `
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'plans'
      ORDER BY ordinal_position;
    `;
        const res = await client.query(query);
        console.log('Columns in "plans" table:');
        res.rows.forEach(row => {
            console.log(`- ${row.column_name} (${row.data_type})`);
        });
    }
    catch (err) {
        console.error('Error inspecting schema:', err);
    }
    finally {
        client.release();
        await pool.end();
    }
}
inspectPlansSchema();
