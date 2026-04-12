import { pool } from './db.js';

async function makeAdmin() {

    try {
        console.log('Setting users to admin...');
        const res = await pool.query("UPDATE users SET role = 'admin' RETURNING name, email, role");
        console.log('Updated users:', res.rows);
    } catch (err) {
        console.error('Error updating users:', err);
    } finally {
        await pool.end();
    }
}

makeAdmin();
