import { Pool } from 'pg';
async function run() {
    const pool = new Pool({
        host: '89.167.111.220',
        port: 5432,
        user: 'kaizenai',
        password: 'Mercedes@g63',
        database: 'falajaao',
        ssl: false
    });
    try {
        console.log('Inspecting Production "users" table columns...');
        const res = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'users'");
        console.log('COLUMNS:', JSON.stringify(res.rows, null, 2));
        console.log('Checking if gen_random_uuid() exists...');
        const uuidRes = await pool.query("SELECT routine_name FROM information_schema.routines WHERE routine_name = 'gen_random_uuid'");
        console.log('GEN_RANDOM_UUID FOUND:', uuidRes.rows.length > 0);
        process.exit(0);
    }
    catch (err) {
        console.error('ERROR:', err);
        process.exit(1);
    }
}
run();
