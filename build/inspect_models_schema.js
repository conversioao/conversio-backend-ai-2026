import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(process.cwd(), '.env') });
const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl: false
});
async function inspectModelsSchema() {
    const client = await pool.connect();
    try {
        console.log('Inspecting models table columns...');
        const query = `
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'models'
      ORDER BY ordinal_position;
    `;
        const res = await client.query(query);
        console.log('Columns in "models" table:');
        res.rows.forEach(row => {
            console.log(`- ${row.column_name} (${row.data_type})`);
        });
    }
    catch (err) {
        console.error('Error inspecting models schema:', err);
    }
    finally {
        client.release();
        await pool.end();
    }
}
inspectModelsSchema();
