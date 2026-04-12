import { query } from './db.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });
// Cache simples para reduzir queries ao DB
let configCache = {};
let lastFetch = 0;
const CACHE_TTL = 30000; // 30 segundos
export async function getConfig(key, defaultValue = '') {
    const now = Date.now();
    if (configCache[key] && (now - lastFetch < CACHE_TTL)) {
        return configCache[key];
    }
    try {
        const result = await query('SELECT value FROM system_settings WHERE key = $1', [key]);
        if (result.rows.length > 0) {
            configCache[key] = result.rows[0].value;
            lastFetch = now;
            return result.rows[0].value;
        }
    }
    catch (e) {
        console.error(`[Config] Error fetching key ${key}:`, e);
    }
    // Fallbacks para ENV mapeados
    const envMap = {
        'storage_bucket': process.env.S3_BUCKET,
        'storage_region': process.env.S3_REGION,
        'storage_endpoint': process.env.S3_ENDPOINT,
        'storage_access_key': process.env.S3_ACCESS_KEY,
        'storage_secret_key': process.env.S3_SECRET_KEY,
        'webhook_image': process.env.N8N_GENERATE_WEBHOOK,
        'webhook_image_text': process.env.N8N_GENERATE_WEBHOOK,
        'webhook_video': process.env.N8N_VIDEO_WEBHOOK,
        'webhook_video_text': process.env.N8N_VIDEO_WEBHOOK,
        'webhook_voice': process.env.N8N_VOICE_WEBHOOK,
        'webhook_music': process.env.N8N_VOICE_WEBHOOK,
        'db_host': process.env.DB_HOST,
        'db_user': process.env.DB_USER,
        'db_pass': process.env.DB_PASSWORD,
        'db_name': process.env.DB_NAME,
        'db_port': process.env.DB_PORT
    };
    return envMap[key] || defaultValue;
}
export async function updateConfig(key, value) {
    await query(`
        INSERT INTO system_settings (key, value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
    `, [key, value]);
    // Limpar cache após update
    delete configCache[key];
    lastFetch = 0;
}
