import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const isProduction = process.env.NODE_ENV === 'production';
const dbHost = process.env.DB_HOST || (isProduction ? '161.97.77.110' : 'localhost');
const dbName = process.env.DB_NAME || 'conversioai';

// SSL Configuration Logic
let sslConfig: any = false;

if (process.env.DB_SSL === 'false') {
    sslConfig = false;
} else if (isProduction || process.env.DB_SSL === 'true') {
    if (process.env.DB_SSL_CERT_PATH) {
        try {
            sslConfig = {
                rejectUnauthorized: true,
                ca: fs.readFileSync(process.env.DB_SSL_CERT_PATH).toString(),
            };
        } catch (err: any) {
            console.error(`[Database] Failed to read SSL certificate at ${process.env.DB_SSL_CERT_PATH}:`, err.message);
            // Fallback to basic SSL if cert fails but we are in production
            sslConfig = { rejectUnauthorized: false };
        }
    } else {
        // Default for most managed providers (Railway, Supabase, Render, Neon)
        sslConfig = { rejectUnauthorized: false };
    }
}

console.log(`[Database] Connecting to host: ${dbHost} (${isProduction ? 'Production' : 'Development'}, SSL: ${!!sslConfig})`);

export const pool = new Pool({
    host: dbHost,
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: dbName,
    ssl: sslConfig,
    // Resilience settings
    connectionTimeoutMillis: 10000, // 10s before failing a connection attempt
    idleTimeoutMillis: 30000,       // 30s before closing idle clients
    max: 20                         // Limit max connections to prevent overwhelming VPS
});


export const query = async (text: string, params?: any[]) => {
    const start = Date.now();
    try {
        const res = await pool.query(text, params);
        const duration = Date.now() - start;
        // console.log('executed query', { text, duration, rows: res.rowCount });
        return res;
    } catch (error) {
        console.error('Error executing query', { text, error });
        throw error;
    }
};

export const getClient = async () => {
    const client = await pool.connect();
    return client;
};
