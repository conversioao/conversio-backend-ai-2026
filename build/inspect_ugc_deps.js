import { query } from './db.js';
async function run() {
    try {
        console.log('--- USERS SCHEMA ---');
        const res = await query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'users'");
        console.table(res.rows);
        console.log('\n--- GENERATIONS SCHEMA ---');
        const res2 = await query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'generations'");
        console.table(res2.rows);
        console.log('\n--- PROJECTS SCHEMA ---');
        const res3 = await query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'projects'");
        console.table(res3.rows);
        process.exit(0);
    }
    catch (e) {
        console.error(e);
        process.exit(1);
    }
}
run();
