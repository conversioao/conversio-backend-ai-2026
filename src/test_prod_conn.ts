import { Pool } from 'pg';

async function test() {
    console.log('Testing Production DB Connection...');
    const pool = new Pool({
        host: '89.167.111.220',
        port: 5432,
        user: 'kaizenai',
        password: 'Mercedes@g63',
        database: 'falajaao',
        ssl: false
    });

    try {
        const res = await pool.query('SELECT NOW()');
        console.log('SUCCESS! Server time:', res.rows[0].now);
        process.exit(0);
    } catch (err) {
        console.error('FAILED to connect to Production:', err.message);
        process.exit(1);
    }
}

test();
