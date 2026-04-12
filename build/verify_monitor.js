import { runMonitorAgent } from './services/monitorAgent.js';
async function test() {
    console.log('--- Testing Monitor Agent Fix ---');
    try {
        await runMonitorAgent();
        console.log('✅ Monitor Agent ran successfully without SQL errors.');
    }
    catch (e) {
        console.error('❌ Monitor Agent failed:', e);
        process.exit(1);
    }
}
test();
