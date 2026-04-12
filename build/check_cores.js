import { pool } from './db.js';
async function checkCores() {
    const client = await pool.connect();
    try {
        console.log('Fetching all cores...');
        const res = await client.query('SELECT * FROM cores');
        console.log('Available Cores:');
        res.rows.forEach(row => {
            console.log(`- ${row.name || row.title} (ID: ${row.id})`);
        });
    }
    catch (err) {
        console.error('Error fetching cores:', err);
    }
    finally {
        client.release();
        await pool.end();
    }
}
checkCores();
