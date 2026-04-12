import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
async function testConnection() {
    console.log('--- Testing Evolution API Connection ---');
    console.log(`URL: ${EVOLUTION_API_URL}`);
    try {
        const response = await axios.get(`${EVOLUTION_API_URL}/instance/fetchInstances`, {
            headers: { 'apikey': EVOLUTION_API_KEY }
        });
        console.log('✅ Connection Successful!');
        console.log(`Found ${response.data.length} instances.`);
        console.log(JSON.stringify(response.data, null, 2));
    }
    catch (error) {
        console.error('❌ Connection Failed!');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', error.response.data);
        }
        else {
            console.error('Error:', error.message);
        }
    }
}
testConnection();
