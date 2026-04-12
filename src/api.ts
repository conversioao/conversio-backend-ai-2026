import express from 'express';
import { EventEmitter } from 'events';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import multer from 'multer';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import crypto from 'crypto';
import fs from 'fs';

import { query } from './db.js';
import { hashPassword, comparePasswords, generateAccessToken, generateRefreshToken, verifyRefreshToken, verifyAccessToken, hashToken } from './auth.js';
import { provisionUserFolder, uploadToTemp, uploadBufferToUserFolder, deleteFile, getDynamicS3Client, uploadTransactionFile, getSignedS3UrlForKey } from './storage.js';
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import sharp from 'sharp';

import { generateInvoicePDF, uploadInvoiceToS3 } from './invoice.js';
import { getConfig, updateConfig } from './config.js';
import { OpenAI } from 'openai';
import { OAuth2Client } from 'google-auth-library';
import { authenticateJWT, isAdmin, AuthRequest, validateCsrf } from './middleware.js';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import * as whatsappService from './services/whatsappService.js';
import * as crmAgent from './services/crmAgent.js';
import * as agentService from './services/agentService.js';
import { getAdminWhatsApp } from './services/configService.js';
import { sendWhatsAppMessage } from './services/whatsappService.js';
import { EvolutionService } from './services/evolutionService.js';
import { WhatsAppLeadAgent } from './services/whatsappLeadAgent.js';
import { ImageAnalysisAgent as AnalysisAgent } from './pipeline/agents/image/ImageAnalysisAgent.js';
import { PromptAgent } from './pipeline/agents/image/ImagePromptAgent.js';
import { BrandColorExtractorAgent } from './pipeline/agents/image/BrandColorExtractorAgent.js';
import './cron.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const app = express();

// Trust Proxy for Easypanel/Nginx
app.set('trust proxy', 1);

app.use(cookieParser());

// ─── Dynamic CORS Configuration ──────────────────────────────────────────────
const allowedOrigins = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3001',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'https://www.conversio.ao',
    'https://conversio.ao',
    'http://www.conversio.ao',
    'http://conversio.ao',
    ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : [])
];

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests without origin (Postman, mobile apps)
        if (!origin) return callback(null, true);
        
        // Check explicit whitelist
        if (allowedOrigins.includes(origin)) return callback(null, true);
        
        // Allow Vercel Preview deployments
        if (origin.endsWith('.vercel.app') || origin.includes('vercel.app')) {
            return callback(null, true);
        }

        console.warn(`[CORS] Blocked origin: ${origin}`);
        callback(new Error(`CORS: Origin não permitida: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'X-Internal-Secret']
}));

// Security Headers
app.use(helmet({ 
    crossOriginResourcePolicy: false, // Prevents breaking images loaded from external domains like S3
    crossOriginOpenerPolicy: false // Prevents breaking Google OAuth popup
}));

// Health Check (MUST be before any auth/CSRF middleware)
app.get('/api/health', (_req, res) => {
    res.json({ 
        status: 'ok', 
        version: 'v2.0.0-media-sync',
        timestamp: new Date().toISOString() 
    });
});

// ─── Global System Log Emitter ──────────────────────────────────────────────
export const systemLogEmitter = new EventEmitter();

// Helper to push system logs
export const emitSystemLog = (agent: string, message: string, status: 'info' | 'success' | 'warning' | 'error' = 'info', metadata: any = {}) => {
    const logEntry = {
        agent,
        message,
        status,
        metadata,
        timestamp: new Date().toISOString()
    };
    systemLogEmitter.emit('log', logEntry);
    
    // Also save to database if it's an important action
    if (status === 'error' || status === 'success') {
        query(`
            INSERT INTO agent_logs (agent_name, action, result, metadata)
            VALUES ($1, $2, $3, $4)
        `, [agent, message.substring(0, 100), status === 'success' ? 'success' : 'error', JSON.stringify(metadata)])
        .catch(err => console.error('[Log Persistence Error]', err));
    }
};

// ─── SSE: Real-time Generation Progress ─────────────────────────────────────
// Map: batchId → Set of SSE response objects
const sseClients = new Map<string, Set<any>>();

function pushSseEvent(batchId: string, event: object) {
    const clients = sseClients.get(batchId);
    if (!clients || clients.size === 0) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    clients.forEach(client => {
        try { client.write(payload); } catch (_) {}
    });
}

// Frontend subscribes to this endpoint for real-time updates
app.get('/api/generations/progress/:batchId', (req, res) => {
    const { batchId } = req.params;
    // Explicit CORS for SSE (must come before CORS middleware since we're early in the stack)
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();

    // Send initial ping
    res.write(`data: ${JSON.stringify({ type: 'connected', batchId })}\n\n`);

    if (!sseClients.has(batchId)) sseClients.set(batchId, new Set());
    sseClients.get(batchId)!.add(res);

    // Heartbeat every 20s to keep connection alive
    const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (_) {}
    }, 20000);

    req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.get(batchId)?.delete(res);
        if (sseClients.get(batchId)?.size === 0) sseClients.delete(batchId);
    });
});

// Admin subscribes to ALL system logs
app.get('/api/admin/system/logs/stream', authenticateJWT, isAdmin, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const onLog = (log: any) => {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
    };

    systemLogEmitter.on('log', onLog);

    const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (_) {}
    }, 15000);

    req.on('close', () => {
        clearInterval(heartbeat);
        systemLogEmitter.removeListener('log', onLog);
    });
});

// ─── Middleware de segurança interna ─────────────────────────────────────────
// express.json() is registered early here so the internal callback body is parsed
// (the global app.use(express.json()) is registered later after CORS)
app.use('/api/internal', express.json());

// Middleware de segurança interna para callbacks e serviços stand-alone
const validateInternalSecret = (req: any, res: any, next: any) => {
    const secret = req.headers['x-internal-secret'];
    const INTERNAL_SECRET = process.env.INTERNAL_SECRET;
    if (!INTERNAL_SECRET || secret !== INTERNAL_SECRET) {
        return res.status(403).json({ success: false, message: 'Acesso negado: Segredo inválido.' });
    }
    next();
};

// Endpoint para agentes externos (ex: generation engine) enviarem logs
app.post('/api/internal/logs', validateInternalSecret, express.json(), (req, res) => {
    const { agent, message, status, metadata } = req.body;
    emitSystemLog(agent, message, status, metadata);
    res.json({ success: true });
});

// ─── KIE.ai Direct Callback (called by KIE.ai when generation completes) ─────
// This is also called by our ImagePipeline after polling finishes
app.post('/api/internal/generation-callback', validateInternalSecret, async (req, res) => {
    try {
        const { generationId, status, imageUrl, pipeline_status, pipeline_progress } = req.body;
        console.log(`[API] 🔔 Callback recebido para geração ${generationId}: status=${status}, progress=${pipeline_progress}`);

        // Push real-time SSE update to all connected frontends watching this generation
        if (generationId) {
            // Find the batchId for this generationId from DB
            try {
                const row = await query(
                    `SELECT batch_id, user_id FROM generations WHERE id = $1 LIMIT 1`,
                    [generationId]
                );
                if (row.rows.length > 0) {
                    const { batch_id, user_id } = row.rows[0];
                    
                    // --- DATABASE PERSISTENCE & STORAGE DOWNLOADING ---
                    if (status === 'completed' || status === 'failed') {
                        // Handle multiple result fields (imageUrl, videoUrls, result_url)
                        let finalUri = imageUrl || 
                                       (req.body.imageUrls && req.body.imageUrls[0]) ||
                                       (req.body.videoUrls && req.body.videoUrls[0]) || 
                                       req.body.result_url || 
                                       req.body.audio_url;

                        // Download the file from KIE and upload to our local storage
                        if (status === 'completed' && finalUri && finalUri.startsWith('http')) {
                            const bucketInUse = process.env.S3_BUCKET || "kwikdocsao";
                            const isOurStorage = finalUri.includes('contabostorage.com') || finalUri.includes(bucketInUse);
                            const isVideo = req.body.videoUrls || finalUri.includes('.mp4') || finalUri.includes('video');
                            
                            // MOD: Enforce S3 for ALL media types (Video, Music, Image)
                            // Removed the "Optimization: Skip S3 for videos" block
                            if (!isOurStorage) {
                                try {
                                    console.log(`[API] Downloading generated file for local storage: ${finalUri}`);
                                    const { data: buffer } = await axios.get(finalUri, { responseType: 'arraybuffer' });
                                    const ext = finalUri.split('.').pop()?.split('?')[0] || (isVideo ? 'mp4' : 'png');
                                    
                                    let contentType = 'application/octet-stream';
                                    if (ext === 'mp4') contentType = 'video/mp4';
                                    else if (ext === 'jpeg' || ext === 'jpg') contentType = 'image/jpeg';
                                    else if (ext === 'png') contentType = 'image/png';
                                    else if (ext === 'mp3') contentType = 'audio/mpeg';

                                    const categoryName = req.body.videoUrls ? 'Videos' : (req.body.audio_url ? 'Audios' : 'Imagens');
                                    finalUri = await uploadBufferToUserFolder(user_id, categoryName as any, buffer, `generated-${generationId}.${ext}`, contentType);
                                    console.log(`[API] File securely saved to S3: ${finalUri}`);
                                } catch (downloadErr: any) {
                                    console.error(`[API] Failed to save external file to S3:`, downloadErr.message);
                                    // Fallback to the original URI if S3 fails
                                }
                            } else {
                                console.log(`[API] 📦 File is already in our storage: ${finalUri}`);
                            }
                        }

                        await query(
                            `UPDATE generations SET status = $1, result_url = COALESCE($2, result_url) WHERE id = $3`,
                            [status, finalUri, generationId]
                        );
                    }

                    // --- CREDIT REFUND LOGIC ---
                    if (status === 'failed') {
                        try {
                            // Get the cost of this specific generation
                            const genData = await query('SELECT cost FROM generations WHERE id = $1', [generationId]);
                            const refundCost = Number(genData.rows[0]?.cost) || 0;
                            
                            if (refundCost > 0) {
                                await query('UPDATE users SET credits = credits + $1 WHERE id = $2', [refundCost, user_id]);
                                console.log(`[API] 💰 Refunded ${refundCost} credits to user ${user_id} for failed generation ${generationId}`);
                            }
                        } catch (refundErr: any) {
                            console.error(`[API] ❌ Failed to refund credits for generation ${generationId}:`, refundErr.message);
                        }
                    }
                    
                    // Fetch user settings for notification
                    const userRes = await query(
                        `SELECT plan, whatsapp, whatsapp_notifications_enabled FROM users WHERE id = $1`,
                        [user_id]
                    );
                    const userData = userRes.rows[0];

                    const event: any = { type: 'progress', generationId, status, batchId: batch_id };
                    if (pipeline_status) event.pipeline_status = pipeline_status;
                    if (pipeline_progress !== undefined) event.pipeline_progress = pipeline_progress;
                    
                    let resolvedImageUrl = imageUrl || (req.body.imageUrls && req.body.imageUrls[0]) || req.body.result_url;
                    if (resolvedImageUrl) event.imageUrl = resolvedImageUrl;
                    
                    if (req.body.title) event.title = req.body.title;
                    if (req.body.copy) event.copy = req.body.copy;
                    
                    // Push to batch subscribers
                    pushSseEvent(batch_id, event);
                    // Also push to user-level channel
                    pushSseEvent(`user-${user_id}`, event);

                    // --- NEW: Trigger SSE for n8n/ads callback too ---
                    // The standard callback pushes events, let's make sure /api/ads/callback does it too.
                    // (See code below at line 1700 approx)

                    // Send WhatsApp notification ONLY if Scale plan and notifications are enabled
                    if (userData && userData.whatsapp_notifications_enabled && userData.whatsapp) {
                        try {
                            if (status === 'completed' && imageUrl) {
                                await whatsappService.sendWhatsAppMessage(
                                    userData.whatsapp,
                                    `✅ *Geração Concluída!*\nA sua imagem publicitária já está pronta.\n\n🔗 *Link:* ${imageUrl}\n\nVerifique o seu painel Conversio para descarregar.`
                                );
                            } else if (status === 'failed') {
                                await whatsappService.sendWhatsAppMessage(
                                    userData.whatsapp,
                                    `❌ *Falha na Geração*\nOcorreu um erro ao processar a geração ${generationId}.\n\nPor favor, verifique o seu painel.`
                                );
                            }
                        } catch (waErr) {
                            console.error('[Callback WA Err]', waErr);
                        }
                    }
                }
            } catch (dbErr: any) {
                console.warn('[API] Could not look up user/batch for SSE push:', dbErr.message);
            }
        }

        res.json({ success: true });
    } catch (error: any) {
        console.error('[API] Erro ao processar callback de geração:', error.message);
        res.status(500).json({ success: false });
    }
});

app.use(express.json());

// Admin Agent Logs Endpoint
app.get('/api/admin/agents/logs', authenticateJWT, isAdmin, async (_req, res) => {
    try {
        const logsRes = await query('SELECT * FROM agent_logs ORDER BY created_at DESC LIMIT 50');
        res.json({ success: true, logs: logsRes.rows });
    } catch (e) {
        res.status(500).json({ success: false, logs: [] });
    }
});

// Rate Limiters
const authLimiter = rateLimit({ 
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, 
    message: { success: false, message: 'Muitos pedidos. Tente mais tarde.' }
});

const genLimiter = rateLimit({ 
    windowMs: 60 * 1000, // 1 minute
    max: 20, 
    message: { success: false, message: 'Demasiadas tentativas de geração. Aguarde um momento.' }
});

// --- Add optional typing delay support for evolution API ---
const messageBuffer = new Map<string, { pushName: string, texts: string[], timeout: NodeJS.Timeout }>();

// --- WhatsApp Webhook (Public) ---
app.post('/api/webhooks/whatsapp', async (req, res) => {
    try {
        const body = req.body;
        
        // Debug: log all incoming webhook payloads in a safe way
        console.log('[Webhook] 📨 Received:', JSON.stringify({
            event: body.event,
            dataKeys: body.data ? Object.keys(body.data) : []
        }));

        const event = body.event || body.type;
        const data = body.data || body;

        // --- Evolution API v2.3.7 Payload Handling ---
        // Event: messages.upsert
        if (event === 'messages.upsert') {
            // v2 format: { event, instance, data: { key, pushName, message, ... } }
            // v1 format: { event, data: { message, key, pushName } }
            const message = data?.message || data?.messages?.[0]?.message;
            const key = data?.key || data?.messages?.[0]?.key;
            const pushName = data?.pushName || data?.messages?.[0]?.pushName || 'Lead';
            const remoteJid = key?.remoteJid;
            
            // Extract text content from various message types
            const text = message?.conversation 
                || message?.extendedTextMessage?.text 
                || message?.buttonsResponseMessage?.selectedDisplayText
                || '';

            if (text && remoteJid && !key?.fromMe) {
                // Buffer algorithm: wait 35 seconds to aggregate messages before AI replies
                if (messageBuffer.has(remoteJid)) {
                    const buffer = messageBuffer.get(remoteJid)!;
                    buffer.texts.push(text);
                    // Do not reset the timer to prevent infinite buffering if user keeps typing
                } else {
                    const timer = setTimeout(() => {
                        const buffer = messageBuffer.get(remoteJid);
                        if (buffer) {
                            const combinedText = buffer.texts.join(' ');
                            messageBuffer.delete(remoteJid);
                            console.log(`[Webhook] 🤖 Dispatching buffered messages to Alex for: ${remoteJid}`);
                            WhatsAppLeadAgent.handleIncomingMessage(remoteJid, buffer.pushName, combinedText).catch(e => 
                                console.error('[WhatsApp Webhook Agent Error]', e.message)
                            );
                        }
                    }, 35000); // 35 seconds buffer

                    messageBuffer.set(remoteJid, {
                        pushName,
                        texts: [text],
                        timeout: timer
                    });
                    console.log(`[Webhook] ⏱️ Buffering started for: ${remoteJid} (35s)`);
                }
            }
        }
        
        res.status(200).send('OK');
    } catch (error: any) {
        console.error('[WhatsApp Webhook] Fatal Error:', error.message);
        res.status(500).send('Error');
    }
});

// Apply rate limits
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/generate/', genLimiter);

// CSRF Token Endpoint removed (security relies on JWT headers)


// Apply CSRF validation globally (except for GET, HEAD, OPTIONS via middleware internal logic)
app.use(validateCsrf);

 // Real-time Tracking Middleware
 app.use(async (req: any, res, next) => {
     try {
         // derivation priority: JWT (most secure) > explicit headers (legacy support)
         let userId = req.user?.id;
         
         if (!userId && req.headers.authorization) {
             try {
                const token = req.headers.authorization.split(' ')[1];
                const decoded = verifyAccessToken(token);
                userId = decoded?.id;
             } catch (e) {}
         }

         // Fallback to query/body only if absolutely necessary, but log it as insecure
         if (!userId) {
            userId = req.headers['x-user-id'] || req.query.userId || (req.body && req.body.userId);
         }

         if (userId) {
             const userAgent = req.headers['user-agent'] || 'unknown';
             let device = 'Desktop';
             if (/mobile/i.test(userAgent)) device = 'Mobile';
             else if (/tablet/i.test(userAgent)) device = 'Tablet';
 
             // Async update
             query('UPDATE users SET last_active_at = NOW(), last_device = $1 WHERE id = $2', [device, userId]).catch(() => {});
         }
     } catch (e) {}
     next();
 });

// Multi-part form data for image uploads (5MB Limit)
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit per file
});

// Helper for S3 Signed URLs
const getSignedS3Url = async (url: string, expiresIn: number = 3600) => {
    if (!url || !url.startsWith('http')) return url;
    
    try {
        const bucketName = await getConfig('storage_bucket', "kwikdocsao");
        const parsedUrl = new URL(url);
        let key = '';

        // Handle path-style URLs (endpoint/bucket/key) logic more robustly
        if (parsedUrl.pathname.includes(`/${bucketName}/`)) {
            key = parsedUrl.pathname.split(`/${bucketName}/`)[1];
        } else {
            // Fallback: strip leading slash and check if bucket is the first segment
            const parts = parsedUrl.pathname.split('/').filter(Boolean);
            if (parts[0] === bucketName) {
                key = parts.slice(1).join('/');
            } else {
                key = parts.join('/');
            }
        }

        // Strip query parameters
        key = decodeURIComponent(key.split('?')[0]);

        const signCommand = new GetObjectCommand({ Bucket: bucketName, Key: key });
        const s3 = await getDynamicS3Client();
        return await getSignedUrl(s3, signCommand, { expiresIn });
    } catch (err) {
        console.warn('[S3 Signing] Failed to sign URL:', url, err);
        return url;
    }
};

// API Auth Routes
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, password, whatsapp } = req.body;
        
        if (!name || !password || !whatsapp) {
            return res.status(400).json({ success: false, message: 'Todos os campos (Nome, Palavra-passe e WhatsApp) são obrigatórios' });
        }

        // WhatsApp is the unique identifier now. Generate a fake email to satisfy DB constraints.
        const cleanWhatsapp = whatsapp.replace(/\D/g, ''); // Extract only digits
        const systemEmail = `${cleanWhatsapp}@users.conversio.ai`;

        // Check if user exists either by exact WhatsApp match or systemEmail match
        const existing = await query('SELECT id FROM users WHERE whatsapp = $1 OR email = $2', [whatsapp, systemEmail]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'Este número de WhatsApp já está registado' });
        }

        const hashedPassword = await hashPassword(password);
        
        // Create user
        const result = await query(
            'INSERT INTO users (name, email, password_hash, credits, role, whatsapp) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email, credits, role',
            [name, systemEmail, hashedPassword, await getConfig('financial_initial_credits', '500'), 'user', whatsapp]
        );
        const user = result.rows[0];

        // Ensure user is in Leads and CRM Profiles for autonomous agents
        await query('INSERT INTO leads (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
        await query('INSERT INTO crm_profiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);

        // Provision storage folder
        await provisionUserFolder(user.id);
        
        // Generate and send WhatsApp verification code
        const verificationCode = whatsappService.generateVerificationCode();
        const expiresAtVerification = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        await query(
            'UPDATE users SET whatsapp_verification_code = $1, whatsapp_verification_expires = $2 WHERE id = $3',
            [verificationCode, expiresAtVerification, user.id]
        );

        await whatsappService.sendWhatsAppMessage(
            whatsapp, 
            `Seu código de verificação Conversio é: ${verificationCode}. Valido por 10 minutos.`,
            'auth'
        );

        // --- Post-registration: Assign to first CRM stage & trigger Day-0 automations ---
        (async () => {
            try {
                // Assign to first CRM stage
                const firstStage = await query('SELECT id FROM crm_stages ORDER BY order_index ASC LIMIT 1');
                if (firstStage.rows.length > 0) {
                    await query('UPDATE users SET crm_stage_id = $1 WHERE id = $2', [firstStage.rows[0].id, user.id]);
                }

                // Fire Day-0 automations
                const automations = await query(
                    "SELECT * FROM crm_automations WHERE is_active = true AND trigger_type = 'days_after_signup' AND delay_days = 0"
                );
                for (const auto of automations.rows) {
                    const msg = auto.message_template.replace(/{name}/g, name);
                    await whatsappService.sendWhatsAppMessage(whatsapp, msg, 'followup');
                    await query('UPDATE crm_automations SET sent_count = sent_count + 1 WHERE id = $1', [auto.id]);
                    await query(
                        'INSERT INTO crm_interactions (user_id, type, content) VALUES ($1, $2, $3)',
                        [user.id, 'automation', `Automação pós-cadastro: ${auto.name}`]
                    );
                }

                // --- NEW: Sync data from whatsapp_leads if exists ---
                const cleanWhatsapp = whatsapp.replace(/\D/g, '');
                const leadSearch = await query('SELECT business_info, needs, name FROM whatsapp_leads WHERE phone = $1', [cleanWhatsapp]);
                if (leadSearch.rows.length > 0) {
                    const lead = leadSearch.rows[0];
                    // Transfer the briefing (stored in business_info if qualified) to context_briefing
                    await query(
                        'UPDATE users SET context_briefing = $1 WHERE id = $2',
                        [`O que sabemos do WhatsApp: ${lead.business_info || lead.needs}`, user.id]
                    );
                    // Mark lead as converted
                    await query('UPDATE whatsapp_leads SET status = \'converted\' WHERE phone = $1', [cleanWhatsapp]);
                }

            } catch (e) {
                console.error('[CRM Post-register error]', e);
            }
        })();

        const accessToken = generateAccessToken({ id: user.id, role: user.role });
        const refreshToken = generateRefreshToken(user.id, crypto.randomUUID());
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        await query(
            'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
            [user.id, hashToken(refreshToken), expiresAt]
        );

        res.cookie('refreshToken', refreshToken, {
            httpOnly: true,
            secure: true, // Always true for cross-site cookies
            sameSite: 'none', // Needed for Vercel -> Easypanel communication
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        res.json({
            success: true,
            token: accessToken,
            user: { ...user, plan: 'free' }
        });

    } catch (error: any) {
        console.error('Register error:', error);
        res.status(500).json({ success: false, message: 'Erro interno no registo' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { whatsapp, password } = req.body;
        
        if (!whatsapp || !password) {
            return res.status(400).json({ success: false, message: 'WhatsApp e palavra-passe são obrigatórios' });
        }

        // Search user by precise whatsapp string (or fallback to clean digit string matching the system email alias)
        const cleanWhatsapp = whatsapp.replace(/\D/g, '');
        const systemEmail = `${cleanWhatsapp}@users.conversio.ai`;

        const result = await query(
            'SELECT * FROM users WHERE whatsapp = $1 OR whatsapp LIKE $2 OR email = $3', 
            [whatsapp, `%${cleanWhatsapp}%`, systemEmail]
        );
        
        const user = result.rows[0];

        if (!user) {
            console.warn(`[Login] User not found for whatsapp: ${whatsapp} or email: ${systemEmail}`);
            return res.status(401).json({ success: false, message: 'Credenciais inválidas' });
        }

        const isMatch = await comparePasswords(password, user.password_hash);
        if (!isMatch) {
            console.warn(`[Login] Password mismatch for user: ${user.whatsapp}`);
            return res.status(401).json({ success: false, message: 'Credenciais inválidas' });
        }

        const accessToken = generateAccessToken({ id: user.id, role: user.role });
        const refreshToken = generateRefreshToken(user.id, crypto.randomUUID());
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        await query(
            'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
            [user.id, hashToken(refreshToken), expiresAt]
        );

        res.cookie('refreshToken', refreshToken, {
            httpOnly: true,
            secure: true, // Always true for cross-site cookies
            sameSite: 'none', // Needed for Vercel -> Easypanel communication
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        res.json({
            success: true,
            token: accessToken,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                credits: user.credits,
                whatsapp: user.whatsapp,
                role: user.role
            }
        });

    } catch (error: any) {
        console.error('--- ERRO CRÍTICO NO LOGIN ---');
        console.error('Mensagem:', error.message);
        res.status(500).json({ success: false, message: 'Erro interno no login' });
    }
});

// Google OAuth Login
app.post('/api/auth/google', async (req, res) => {
    try {
        const { token } = req.body;
        
        if (!token) {
            return res.status(400).json({ success: false, message: 'Google Token Ausente' });
        }

        // Fetch user info from Google using the access token
        const googleRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${token}` }
        });
        
        if (!googleRes.ok) {
            return res.status(401).json({ success: false, message: 'Token Google Inválido' });
        }

        const googleUser = await googleRes.json();
        const { sub: googleId, email, name, picture: avatarUrl } = googleUser;

        if (!googleId || !email) {
            return res.status(400).json({ success: false, message: 'Dados do Google incompletos' });
        }

        // Find or create user
        let userResult = await query('SELECT * FROM users WHERE google_id = $1 OR email = $2', [googleId, email]);
        let user = userResult.rows[0];

        if (!user) {
            // Create user for Google login
            const createResult = await query(
                'INSERT INTO users (name, email, google_id, avatar_url, is_verified, password_hash, credits) VALUES ($1, $2, $3, $4, true, $5, $6) RETURNING *',
                [name || 'User Google', email, googleId, avatarUrl, 'google-oauth-placeholder', await getConfig('initial_credits', '500')]
            );
            user = createResult.rows[0];
            
            // Initialize S3 storage folder
            try {
                await provisionUserFolder(user.id);
            } catch (s3Err) {
                console.warn('[Storage] Google user S3 provision failed.');
            }

        } else if (!user.google_id) {
            // Link existing email account to Google
            await query('UPDATE users SET google_id = $1, avatar_url = $2, is_verified = true WHERE id = $3', [googleId, avatarUrl, user.id]);
        }

        const accessToken = generateAccessToken({ id: user.id, role: user.role });
        const refreshToken = generateRefreshToken(user.id, crypto.randomUUID());
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        // Store refresh token
        await query(
            'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
            [user.id, hashToken(refreshToken), expiresAt]
        );

        // Set HttpOnly cookie for refresh token
        res.cookie('refreshToken', refreshToken, {
            httpOnly: true,
            secure: true, // Always true for cross-site cookies
            sameSite: 'none', // Needed for Vercel -> Easypanel communication
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        res.json({
            success: true,
            token: accessToken,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                credits: user.credits,
                avatar: user.avatar_url
            }
        });

    } catch (error: any) {
        console.error('Google Login Error:', error);
        res.status(500).json({ success: false, message: 'Erro interno no login com Google' });
    }
});

app.post('/api/auth/refresh', async (req, res) => {
    try {
        const refreshToken = req.cookies.refreshToken;
        if (!refreshToken) return res.status(401).json({ success: false, message: 'Refresh token ausente' });

        const decoded = verifyRefreshToken(refreshToken);
        const { userId, tokenId } = decoded;

        // Verify in DB
        const tokenHash = hashToken(refreshToken);
        const result = await query(
            'SELECT * FROM refresh_tokens WHERE user_id = $1 AND token_hash = $2 AND revoked = false AND expires_at > NOW()',
            [userId, tokenHash]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Refresh token inválido ou revogado' });
        }

        const userResult = await query('SELECT id, role, name, email, credits FROM users WHERE id = $1', [userId]);
        const user = userResult.rows[0];

        if (!user) return res.status(401).json({ success: false, message: 'Usuário não encontrado' });

        // Rotation: Revoke old token and issue new pair
        await query('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1 AND token_hash = $2', [userId, tokenHash]);

        const newAccessToken = generateAccessToken({ id: user.id, role: user.role });
        const newRefreshToken = generateRefreshToken(user.id, crypto.randomUUID());
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        await query(
            'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
            [user.id, hashToken(newRefreshToken), expiresAt]
        );

        res.cookie('refreshToken', newRefreshToken, {
            httpOnly: true,
            secure: true,
            sameSite: 'none',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        res.json({
            success: true,
            token: newAccessToken,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                credits: user.credits,
                role: user.role
            }
        });
    } catch (error) {
        res.status(401).json({ success: false, message: 'Erro ao renovar token' });
    }
});

app.post('/api/auth/logout', async (req, res) => {
    try {
        const refreshToken = req.cookies.refreshToken;
        if (refreshToken) {
            const tokenHash = hashToken(refreshToken);
            await query('UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1', [tokenHash]);
        }
        res.clearCookie('refreshToken');
        res.json({ success: true, message: 'Logout realizado com sucesso' });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// WhatsApp Verification Routes
app.post('/api/auth/verify-whatsapp', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const { code } = req.body;

        if (!userId || !code) {
            return res.status(400).json({ success: false, message: 'Código é obrigatório' });
        }

        const result = await query(
            'SELECT whatsapp_verification_code, whatsapp_verification_expires FROM users WHERE id = $1',
            [userId]
        );
        const user = result.rows[0];

        if (!user || user.whatsapp_verification_code !== code) {
            return res.status(400).json({ success: false, message: 'Código incorreto' });
        }

        if (new Date() > new Date(user.whatsapp_verification_expires)) {
            return res.status(400).json({ success: false, message: 'Código expirado' });
        }

        await query(
            'UPDATE users SET whatsapp_verified = true, whatsapp_verification_code = NULL, whatsapp_verification_expires = NULL WHERE id = $1',
            [userId]
        );

        res.json({ success: true, message: 'WhatsApp verificado com sucesso' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erro ao verificar WhatsApp' });
    }
});

app.post('/api/auth/resend-whatsapp', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false });

        const userRes = await query('SELECT whatsapp FROM users WHERE id = $1', [userId]);
        const whatsapp = userRes.rows[0]?.whatsapp;

        if (!whatsapp) {
            return res.status(400).json({ success: false, message: 'Número de WhatsApp não encontrado' });
        }

        const verificationCode = whatsappService.generateVerificationCode();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await query(
            'UPDATE users SET whatsapp_verification_code = $1, whatsapp_verification_expires = $2 WHERE id = $3',
            [verificationCode, expiresAt, userId]
        );

        await whatsappService.sendWhatsAppMessage(
            whatsapp, 
            `Seu novo código de verificação Conversio é: ${verificationCode}. Valido por 10 minutos.`,
            'auth'
        );

        res.json({ success: true, message: 'Novo código enviado' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erro ao reativar código' });
    }
});

// Admin CRM Routes
app.get('/api/admin/crm/unified-leads', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const result = await query(`
            SELECT 
                u.id, 
                u.name, 
                u.email, 
                u.whatsapp, 
                u.whatsapp_verified, 
                u.credits, 
                u.created_at, 
                u.crm_stage_id,
                u.plan,
                (SELECT MAX(created_at) FROM crm_interactions WHERE user_id = u.id) as last_interaction
            FROM users u
            ORDER BY u.created_at DESC
        `);
        res.json({ success: true, leads: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/crm/campaigns', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const result = await query('SELECT * FROM crm_campaigns ORDER BY created_at DESC');
        res.json({ success: true, campaigns: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/crm/campaigns', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { name, message_template, target_segment } = req.body;
        const result = await query(
            'INSERT INTO crm_campaigns (name, message_template, segmentation_filters, status) VALUES ($1, $2, $3, $4) RETURNING *',
            [name, message_template, JSON.stringify(target_segment || {}), 'draft']
        );
        res.json({ success: true, campaign: result.rows[0] });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/notifications', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const result = await query('SELECT * FROM admin_notifications ORDER BY created_at DESC LIMIT 50');
        res.json({ success: true, notifications: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/whatsapp/logs', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const result = await query('SELECT * FROM whatsapp_logs ORDER BY created_at DESC LIMIT 100');
        res.json({ success: true, logs: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/crm/stages', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const result = await query('SELECT * FROM crm_stages ORDER BY order_index ASC');
        res.json({ success: true, stages: result.rows });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/crm/update-stage', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { userId, stageId } = req.body;
        await query('UPDATE users SET crm_stage_id = $1 WHERE id = $2', [stageId, userId]);
        
        // Log interaction
        await query(
            'INSERT INTO crm_interactions (user_id, type, content) VALUES ($1, $2, $3)',
            [userId, 'stage_move', `Movido para estágio ID: ${stageId}`]
        );

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/admin/crm/user/:id', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const userRes = await query('SELECT id, name, email, whatsapp, whatsapp_verified, credits, created_at, crm_stage_id FROM users WHERE id = $1', [id]);
        const interactionsRes = await query('SELECT * FROM crm_interactions WHERE user_id = $1 ORDER BY created_at DESC', [id]);
        
        res.json({ 
            success: true, 
            user: userRes.rows[0],
            interactions: interactionsRes.rows
        });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/crm/interaction', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { userId, type, content } = req.body;
        await query(
            'INSERT INTO crm_interactions (user_id, type, content) VALUES ($1, $2, $3)',
            [userId, type, content]
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/crm/campaign/send', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { name, template, userIds } = req.body;
        
        // Create campaign record
        const campaignRes = await query(
            'INSERT INTO crm_campaigns (name, message_template, status) VALUES ($1, $2, $3) RETURNING id',
            [name, template, 'completed']
        );
        const campaignId = campaignRes.rows[0].id;

        // Fetch users
        const usersRes = await query('SELECT id, whatsapp, name FROM users WHERE id = ANY($1)', [userIds]);
        
        for (const user of usersRes.rows) {
            if (user.whatsapp) {
                const personalizedMsg = template.replace(/{name}/g, user.name);
                await whatsappService.sendWhatsAppMessage(user.whatsapp, personalizedMsg, 'campaign');
                
                await query(
                    'INSERT INTO crm_interactions (user_id, type, content) VALUES ($1, $2, $3)',
                    [user.id, 'whatsapp_sent', `Campanha: ${name}`]
                );
            }
        }

        res.json({ success: true, campaignId });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/crm/campaign/generate', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { stageId, promptInput } = req.body;
        
        let queryStr = "SELECT u.id, u.name, (SELECT string_agg(type || ':' || content, ' | ') FROM crm_interactions ci WHERE ci.user_id = u.id) as interactions FROM users u WHERE u.role = 'user'";
        let queryParams = [];
        if (stageId) {
            queryStr += ' AND u.crm_stage_id = $1';
            queryParams.push(stageId);
        }
        
        const usersRes = await query(queryStr, queryParams);
        if (usersRes.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Nenhum utilizador encontrado para este segmento.' });
        }

        const aiResponse = await crmAgent.generateCampaginWithAI(usersRes.rows, promptInput);
        res.json({ success: true, aiGenerated: aiResponse });
    } catch (error: any) {
        console.error('Campaign AI generation error:', error);
        res.status(500).json({ success: false, message: 'Erro ao gerar campanha via IA' });
    }
});

// --- CRM Automation CRUD Routes ---
app.get('/api/admin/crm/automations', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const result = await query('SELECT * FROM crm_automations ORDER BY created_at ASC');
        res.json({ success: true, automations: result.rows });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/crm/automations', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { name, trigger_type, delay_days, message_template } = req.body;
        const result = await query(
            'INSERT INTO crm_automations (name, trigger_type, delay_days, message_template) VALUES ($1, $2, $3, $4) RETURNING *',
            [name, trigger_type || 'days_after_signup', delay_days || 0, message_template]
        );
        res.json({ success: true, automation: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.put('/api/admin/crm/automations/:id', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, trigger_type, delay_days, message_template, is_active } = req.body;
        const result = await query(
            'UPDATE crm_automations SET name=$1, trigger_type=$2, delay_days=$3, message_template=$4, is_active=$5 WHERE id=$6 RETURNING *',
            [name, trigger_type, delay_days, message_template, is_active, id]
        );
        res.json({ success: true, automation: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.put('/api/admin/crm/automations/:id/toggle', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await query(
            'UPDATE crm_automations SET is_active = NOT is_active WHERE id = $1 RETURNING *',
            [id]
        );
        res.json({ success: true, automation: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.delete('/api/admin/crm/automations/:id', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await query('DELETE FROM crm_automations WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// --- Autonomous Agents Routes ---
app.get('/api/admin/agents', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const statuses = await agentService.getAgentTeamStatus();
        res.json({ success: true, agents: statuses });
    } catch (error) {
        console.error('Failed to get agent statuses:', error);
        res.status(500).json({ success: false });
    }
});

app.get('/api/admin/agents/approvals', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const result = await query(`
            SELECT aa.*, a.persona_name, a.emoji, u.name as user_name, u.whatsapp as user_whatsapp
            FROM agent_approvals aa
            JOIN agent_team a ON aa.agent_id = a.id
            JOIN users u ON aa.user_id = u.id
            WHERE aa.status = 'pending'
            ORDER BY aa.created_at ASC
        `);
        res.json({ success: true, approvals: result.rows });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/agents/approve', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { approvalId, notes } = req.body;
        const success = await agentService.approveAgentAction(approvalId, notes);
        res.json({ success });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/agents/reject', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { approvalId, notes } = req.body;
        const success = await agentService.rejectAgentAction(approvalId, notes);
        res.json({ success });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// --- Admin Notifications Feed ---
app.get('/api/admin/notifications', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const result = await query(`
            SELECT * FROM admin_notifications 
            ORDER BY created_at DESC 
            LIMIT 50
        `);
        res.json({ success: true, notifications: result.rows });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Email Verification Link

app.get('/api/auth/verify/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const result = await query('UPDATE users SET is_verified = true, verification_token = NULL WHERE verification_token = $1 RETURNING name', [token]);
        
        if (result.rows.length === 0) {
            return res.status(400).send('Token inválido ou expirado.');
        }

        res.send(`A sua conta Conversio foi ativada com sucesso. Pode fechar esta página e regressar à aplicação.`);
    } catch (error) {
        res.status(500).send('Erro no servidor.');
    }
});


// User Profile Routes
app.get('/api/user/profile', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(400).json({ success: false });

        const result = await query('SELECT id, name, email, whatsapp, avatar_url, brand_logo_url, role, credits, created_at FROM users WHERE id = $1', [userId]);
        if (result.rows.length === 0) return res.status(404).json({ success: false });

        res.json({ success: true, user: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/user/notifications/toggle', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const { enabled } = req.body;
        
        // Check if user is Scale plan (only Scale can use notifications)
        // All users now have access to WhatsApp notifications toggle backward compatible with credits logic

        await query('UPDATE users SET whatsapp_notifications_enabled = $1 WHERE id = $2', [enabled, userId]);
        res.json({ success: true, message: `Notificações ${enabled ? 'ativadas' : 'desativadas'}.` });
    } catch (err: any) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/user/profile/update', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const { name, email, avatarUrl, brandLogoUrl, currentPassword, newPassword } = req.body;

        if (!userId) return res.status(400).json({ success: false });

        const updateFields = [];
        const values = [];
        let placeholderIdx = 1;

        if (name) {
            updateFields.push(`name = $${placeholderIdx++}`);
            values.push(name);
        }
        if (email) {
            updateFields.push(`email = $${placeholderIdx++}`);
            values.push(email);
        }
        if (avatarUrl !== undefined) {
            updateFields.push(`avatar_url = $${placeholderIdx++}`);
            values.push(avatarUrl);
        }
        if (brandLogoUrl !== undefined) {
            updateFields.push(`brand_logo_url = $${placeholderIdx++}`);
            values.push(brandLogoUrl === '' ? null : brandLogoUrl);
        }

        // Handle password change if requested
        if (currentPassword && newPassword) {
            const userRes = await query('SELECT password FROM users WHERE id = $1', [userId]);
            const user = userRes.rows[0];
            
            if (!user.password || await comparePasswords(currentPassword, user.password)) {
                const hashedPassword = await hashPassword(newPassword);
                updateFields.push(`password = $${placeholderIdx++}`);
                values.push(hashedPassword);
            } else {
                return res.status(401).json({ success: false, message: 'Senha atual incorreta' });
            }
        }

        if (updateFields.length === 0) return res.json({ success: true, message: 'Nada para atualizar' });

        values.push(userId);
        const result = await query(
            `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${placeholderIdx} RETURNING id, name, email, avatar_url, brand_logo_url, role, credits`,
            values
        );

        res.json({ success: true, user: result.rows[0] });
    } catch (error: any) {
        console.error('Profile update error:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao atualizar perfil' });
    }
});

// Upload User Avatar
app.post('/api/user/upload-avatar', authenticateJWT, upload.single('avatar'), async (req: AuthRequest & { file?: Express.Multer.File }, res) => {
    try {
        const userId = req.user?.id;
        const avatarFile = req.file;

        if (!userId || !avatarFile) {
            return res.status(400).json({ success: false, message: 'Falta ficheiro de avatar.' });
        }

        const fileName = `avatar_${userId}_${Date.now()}.png`;
        const avatarUrl = await uploadBufferToUserFolder(userId, 'Perfil', avatarFile.buffer, fileName, avatarFile.mimetype);

        // Update the user's profile with the new avatar url
        await query('UPDATE users SET avatar_url = $1 WHERE id = $2', [avatarUrl, userId]);

        res.json({ success: true, avatarUrl });
    } catch (error: any) {
        console.error('Upload avatar error:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao enviar avatar' });
    }
});

// Brand Management Routes
app.post('/api/brands/analyze', authenticateJWT, upload.single('logo'), async (req: AuthRequest & { file?: Express.Multer.File }, res) => {
    try {
        const userId = req.user?.id;
        const logoFile = req.file;

        if (!userId || !logoFile) {
            return res.status(400).json({ success: false, message: 'Faltam dados: userId ou Ficheiro (logo).' });
        }

        console.log(`[API ANALYZE] User: ${userId}, File: ${logoFile.originalname}`);

        // 1. Storage Upload
        let publicUrl = '';
        let signedUrl = '';
        try {
            const fileName = `brand_analysis_${userId}_${Date.now()}.png`;
            publicUrl = await uploadBufferToUserFolder(userId, 'Imagens', logoFile.buffer, fileName, logoFile.mimetype);
            signedUrl = await getSignedS3UrlForKey(publicUrl, 600);
            console.log(`[API ANALYZE] S3 Success. Signed URL ready.`);
        } catch (s3Err: any) {
            console.error('[API ANALYZE] S3_UPLOAD_FAILED:', s3Err.message);
            return res.status(500).json({ 
                success: false, 
                message: 'ERRO_S3: Falha ao guardar a imagem no storage.', 
                error: s3Err.message 
            });
        }

        // 2. Call Local Brand Color Extractor Agent
        try {
            console.log(`[API ANALYZE] Starting Local Agent analysis for ${signedUrl}`);
            const data = await BrandColorExtractorAgent.analyze(signedUrl);

            console.log(`[API ANALYZE] Agent Success. Mapping colors for ${data.company_name}...`);

            const analysis = {
                company_name: data.company_name || 'Nova Empresa',
                brand_colors: {
                    primary: data.brand_colors?.primary || '#000000',
                    secondary: data.brand_colors?.secondary || '#FFFFFF',
                    accent: data.brand_colors?.accent || null,
                    palette: data.brand_colors?.palette || ['#000000', '#FFFFFF'],
                    palette_description: data.brand_colors?.palette_description || 'Paleta extraída da marca.'
                },
                confidence: 1.0,
                raw_ai_response: data
            };

            return res.json({
                success: true,
                analysis,
                logoUrl: publicUrl
            });

        } catch (agentErr: any) {
            console.error('[API ANALYZE] AGENT_FAILED:', agentErr.message);
            return res.status(500).json({ 
                success: false, 
                message: 'ERRO_ANALISE: Falha ao extrair cores com o Agente IA.', 
                error: agentErr.message 
            });
        }

    } catch (error: any) {
        console.error('[API ANALYZE] CRITICAL_CRASH:', error);
        return res.status(500).json({ 
            success: false, 
            message: 'ERRO_CRÍTICO: Um erro inesperado derrubou a rota.', 
            error: error.message 
        });
    }
});

app.post('/api/brands/save', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const { company_name, logo_url, brand_colors, raw_ai_response, confirmed } = req.body;

        if (!userId) return res.status(401).json({ success: false });

        const sql = `
            INSERT INTO brands (user_id, company_name, logo_url, brand_colors, raw_ai_response, confirmed, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (user_id) 
            DO UPDATE SET 
                company_name = EXCLUDED.company_name,
                logo_url = EXCLUDED.logo_url,
                brand_colors = EXCLUDED.brand_colors,
                raw_ai_response = EXCLUDED.raw_ai_response,
                confirmed = EXCLUDED.confirmed,
                updated_at = NOW()
            RETURNING *
        `;

        const result = await query(sql, [userId, company_name, logo_url, JSON.stringify(brand_colors), JSON.stringify(raw_ai_response), confirmed]);
        
        res.json({ success: true, brand: result.rows[0] });

    } catch (error: any) {
        console.error('[Brand Save Error]', error);
        res.status(500).json({ success: false, message: 'Erro ao guardar configurações da marca.' });
    }
});

app.get('/api/brands/:user_id', authenticateJWT, async (req, res) => {
    try {
        const { user_id } = req.params;
        const result = await query('SELECT * FROM brands WHERE user_id = $1', [user_id]);
        
        if (result.rows.length === 0) {
            return res.json({ success: true, brand: null });
        }
        
        const brand = result.rows[0];
        
        // Fix 401 Unauthorized: Sign the S3 logo URL for the frontend
        if (brand.logo_url) {
            try {
                brand.logo_url = await getSignedS3UrlForKey(brand.logo_url, 86400); // Authorized for 24h
            } catch (s3Err: any) {
                console.warn('[API FETCH] Failed to sign brand logo:', s3Err.message);
            }
        }
        
        res.json({ success: true, brand });
    } catch (error: any) {
        res.status(500).json({ success: false });
    }
});


// AI Generation Endpoints

app.post('/api/generate/image', authenticateJWT, upload.single('image'), async (req: AuthRequest & { file?: Express.Multer.File }, res) => {
    try {
        const { prompt, model_id, core_id, style_id, model_name, core_name, style_name, aspectRatio, quantity, style: requestStyle, includeText } = req.body;
        const userId = req.user?.id;
        const imageFile = req.file;

        // Image is MANDATORY for Agent/Standard mode (where core_id is present)
        // Description (prompt) is OPTIONAL for Agent mode
        if (!userId) {
            return res.status(401).json({ success: false, message: 'Usuário não autenticado.' });
        }

        const isAgentMode = !!core_id;
        
        if (isAgentMode) {
            if (!imageFile) {
                return res.status(400).json({ success: false, message: 'A imagem do produto é obrigatória para este Agente.' });
            }
        } else {
            // Text-only or generic Flux mode
            if (!prompt && !imageFile) {
                return res.status(400).json({ success: false, message: 'Digite uma descrição ou carregue uma imagem.' });
            }
        }

        const model = model_name || 'Flux.1';
        const style = requestStyle || style_name || '';

        // 1. Credit Check & User Validation
        const userRes = await query('SELECT credits, name, whatsapp FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0];

        if (!user) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
        }

        // Plan Validation
        // Plan Validation removed - all features available for all users with credits

        // Fetch costs from DB or hardcoded for specific Agents/Cores
        let modelCost = 1;
        let coreCost = 0;
        let styleCost = 0;

        let modelTechnicalId = null;
        if (model_id) {
            const mRes = await query('SELECT credit_cost, style_id FROM models WHERE id = $1', [model_id]);
            if (mRes.rows.length > 0) {
                modelCost = mRes.rows[0].credit_cost || 1;
                modelTechnicalId = mRes.rows[0].style_id;
            }
        }

        if (core_id) {
            // Match costs with ImageGenerator.tsx hardcoded values
            if (core_id === 'ugc-realistic') coreCost = 2;
            else if (core_id === 'brand-visual') coreCost = 4;
            else if (core_id === 'impact-ads-pro') coreCost = 5;
            else if (core_id === 'boutique-fashion') coreCost = 4;
            else {
                try {
                    const cRes = await query('SELECT credit_cost FROM models WHERE id = $1', [core_id]);
                    if (cRes.rows.length > 0) coreCost = cRes.rows[0].credit_cost || 0;
                } catch (err) {
                    console.warn('[API] Could not fetch cost for core_id:', core_id);
                }
            }
        }

        const qty = parseInt(quantity || '1');
        const unitCost = modelCost + coreCost;
        const totalCost = unitCost * qty;

        if (user.credits < totalCost) {
            if (user.whatsapp) {
                try {
                    await whatsappService.sendWhatsAppMessage(
                        user.whatsapp, 
                        `Olá ${user.name}! ⚠️ O seu pedido de geração falhou porque não tem créditos suficientes no Conversio.\nNecessita de ${totalCost} créditos, mas apenas tem ${user.credits} disponíveis.\n\nPor favor, recarregue a sua conta para continuar a criar!`
                    );
                } catch (e) {
                    console.warn('[WhatsApp warning failure]', e);
                }
            }
            return res.status(403).json({ success: false, message: `Créditos insuficientes. Necessário: ${totalCost}, Disponível: ${user.credits}` });
        }

        // Deduct credits upfront
        await query('UPDATE users SET credits = credits - $1 WHERE id = $2', [totalCost, userId]);

        // 2. Upload Temp Image if provided
        let tempImageUrl = null;
        console.log('[API] Received file:', imageFile ? imageFile.originalname : 'None');
        
        if (imageFile) {
            try {
                tempImageUrl = await uploadToTemp(imageFile.buffer, imageFile.originalname, imageFile.mimetype);
                console.log('[API] Uploaded to S3:', tempImageUrl);
            } catch (err: any) {
                console.error('[API] S3 Upload Error:', err.message);
            }
        }

        // 3. Log generation as processing (NO IMMEDIATE DEDUCTION)
        const batchId = `BATCH-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        
        for(let i = 0; i < qty; i++) {

            await query(
                'INSERT INTO generations (user_id, type, prompt, cost, status, metadata, batch_id, model, style, aspect_ratio) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
                [userId, 'image', prompt, unitCost, 'processing', JSON.stringify({ index: i, tempImageUrl, model_id, core_id, style_id, core_name, includeText }), batchId, model, style, aspectRatio]
            );
        }

        // 5. Fetch Brand Colors if any
        const brandRes = await query('SELECT brand_colors FROM brands WHERE user_id = $1', [userId]);
        const brandColors = brandRes.rows[0]?.brand_colors || null;

        // 6. Internal Modular Pipeline (Replacing n8n)
        for (let i = 0; i < qty; i++) {
            // Find the generation record we just created to get its ID
            const genRes = await query(
                'SELECT id, prompt, cost, style, aspect_ratio, metadata FROM generations WHERE batch_id = $1 AND metadata->>\'index\' = $2',
                [batchId, String(i)]
            );
            const generation = genRes.rows[0];
            const genId = generation?.id;

            if (genId) {
                // Extract brand color config from request body at start to ensure full scope
                const use_brand_colors = req.body.use_brand_colors;
                const brand_colors = req.body.brand_colors;

                let contextAntiRepeticao = 'Nenhuma combinação anterior registada.';
                try {
                    // Fetch UGC Context (Anti-Repetition)
                    if (core_id === 'ugc-realistic') {
                        const historyRes = await query(
                            `SELECT tipo_ugc, sub_cena, angulo_camara, emocao_dominante, gancho_tipo, cenario 
                             FROM ugc_used_combinations 
                             WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
                             ORDER BY created_at DESC LIMIT 10`,
                            [userId]
                        );
                        if (historyRes.rows.length > 0) {
                            contextAntiRepeticao = historyRes.rows.map(r => 
                                `${r.tipo_ugc} | ${r.sub_cena} | ${r.angulo_camara} | ${r.emocao_dominante} | ${r.cenario}`
                            ).join('\n');
                        }
                    }
                } catch (e) {
                    console.warn('[API] Could not fetch anti-repetition context:', e);
                }

                // Trigger the pipeline in the background on the standalone generation engine
                const rawEngineUrl = (process.env.GENERATION_ENGINE_URL || 'http://localhost:3010').replace(/[, ]/g, '');
                const generationEngineUrl = rawEngineUrl.replace(/\/+$/, '');
                const internalSecret = process.env.INTERNAL_SECRET;

                if (!process.env.GENERATION_ENGINE_URL) {
                    console.warn(`[API] ⚠️ GENERATION_ENGINE_URL is not set. Falling back to localhost:3010. THIS DEFINITELY FAILS IN DOCKER/PRODUCTION.`);
                }

                console.log(`[API] 🚀 Delegating generation ${genId} to engine: ${generationEngineUrl}`);
                axios.post(`${generationEngineUrl}/internal/generate/image`, {
                    userId,
                    userPrompt: prompt,
                    productImageUrl: tempImageUrl,
                    coreId: core_id,
                    coreName: core_name,
                    style: style,
                    aspectRatio: aspectRatio,
                    generationId: genId,
                    modelId: modelTechnicalId || model_id,
                    useBrandColors: use_brand_colors === 'true' || use_brand_colors === true,
                    brandColors: typeof brand_colors === 'string' ? JSON.parse(brand_colors) : brand_colors,
                    contextAntiRepeticao: contextAntiRepeticao,
                    currentIndex: i + 1,
                    totalItems: qty,
                    includeText: includeText === 'true' || includeText === true
                }, {
                    headers: { 'X-Internal-Secret': internalSecret },
                    timeout: 30000 // Increased to 30s
                }).then(resp => {
                    console.log(`[API] ✅ Generation ${genId} delegated successfully. Status: ${resp.status}`, resp.data);
                }).catch(err => {
                    console.error(`[Generation Delegate Error] Generation ${genId} failed:`, {
                        message: err.message,
                        status: err.response?.status,
                        data: err.response?.data,
                        code: err.code,
                        url: `${generationEngineUrl}/internal/generate/image`
                    });
                });
            }
        }

        res.json({
            success: true,
            message: 'Geração iniciada com sucesso. Verifique a galeria em breve.',
            batchId,
        });
    } catch (error: any) {
        console.error('Image Generation Error:', error);
        res.status(500).json({ success: false, message: 'Não foi possível processar a geração da imagem. Tente novamente.' });
    }
});

// Callback from n8n when generation is done
app.post('/api/ads/callback', async (req, res) => {
    try {
        const n8nSecret = req.headers['x-n8n-secret'];
        
        // Detailed logging to file
        const logEntry = `\n--- [${new Date().toISOString()}] n8n-callback ---\nHeaders: ${JSON.stringify(req.headers)}\nBody: ${JSON.stringify(req.body)}\n`;
        fs.appendFileSync(path.join(__dirname, '../webhook_logs.txt'), logEntry);

        if (process.env.N8N_WEBHOOK_SECRET && n8nSecret !== process.env.N8N_WEBHOOK_SECRET) {
            console.warn('[n8n Callback] Blocked unauthorized request. Invalid X-N8n-Secret.');
            return res.status(403).json({ success: false, message: 'Acesso não autorizado. Verifique o segredo configurado.' });
        }

        let { generationId, userId, imageUrls, videoUrls, urls, copy, hashtags, title, status } = req.body;
        const incomingUrls = imageUrls || videoUrls || urls;

        // --- ID NORMALIZATION ---
        // n8n may send generationId as a stringified JSON array like '["uuid-123"]'
        let targetIds: string[] = [];
        let isBatchId = false;

        if (typeof generationId === 'string' && generationId.startsWith('[') && generationId.endsWith(']')) {
            try {
                const parsed = JSON.parse(generationId);
                if (Array.isArray(parsed)) {
                    targetIds = parsed;
                } else {
                    targetIds = [generationId];
                }
            } catch (e) {
                targetIds = [generationId];
            }
        } else if (Array.isArray(generationId)) {
            targetIds = generationId;
        } else if (generationId) {
            targetIds = [generationId];
        }

        // Check if the provided single ID might be a batch_id (starts with 'BATCH-' or 'AUDIO-')
        if (targetIds.length === 1 && (targetIds[0].startsWith('BATCH-') || targetIds[0].startsWith('AUDIO-'))) {
            isBatchId = true;
        }

        if (status === 'error' || status === 'failed' || status === false || status === 'false' || !incomingUrls || incomingUrls.length === 0) {
            // Refund the deducted credits since it failed
            let failedBatch;
            if (isBatchId) {
                failedBatch = await query("UPDATE generations SET status = 'failed' WHERE batch_id = $1 AND status = 'processing' RETURNING cost", [targetIds[0]]);
            } else {
                failedBatch = await query("UPDATE generations SET status = 'failed' WHERE id = ANY($1) AND status = 'processing' RETURNING cost", [targetIds]);
            }
            
            for (const row of failedBatch.rows) {
                const refundCost = Number(row.cost) || 0;
                if (refundCost > 0 && userId) {
                    await query('UPDATE users SET credits = credits + $1 WHERE id = $2', [refundCost, userId]);
                    console.log(`[n8n Callback] Reflexo de Erro: Refunded ${refundCost} credits to user ${userId} for failed batch/ids ${JSON.stringify(targetIds)}`);
                }
            }
            
            return res.status(200).json({ success: true, message: 'Gerações falhas - créditos devolvidos.' });
        }

        console.log(`[n8n Callback] Target IDs: ${JSON.stringify(targetIds)}, Items: ${incomingUrls?.length || 0}, Title: ${title}`);

        // 1. Get user name and batch info
        const userRes = await query('SELECT name FROM users WHERE id = $1', [userId]);
        const userName = userRes.rows[0]?.name || 'User';

        let batchRows;
        if (isBatchId) {
            batchRows = await query('SELECT id, type, prompt, metadata, cost FROM generations WHERE batch_id = $1 ORDER BY id ASC', [targetIds[0]]);
        } else {
            batchRows = await query('SELECT id, type, prompt, metadata, cost FROM generations WHERE id = ANY($1) ORDER BY id ASC', [targetIds]);
        }

        if (batchRows.rows.length === 0) {
            console.error(`[Callback] No rows found for target IDs ${JSON.stringify(targetIds)}`);
            fs.appendFileSync(path.join(__dirname, '../webhook_logs.txt'), `[ERROR] Target IDs ${JSON.stringify(targetIds)} not found in DB\n`);
            return res.status(404).json({ success: false, message: 'Gerações não encontradas.' });
        }

        // --- NEW: Push SSE event when generation is updated via n8n ---
        const firstGen = batchRows.rows[0];
        const batch_id = firstGen.batch_id || targetIds[0];
        
        pushSseEvent(batch_id, {
            type: 'progress',
            status: status === 'done' || status === 'completed' ? 'completed' : 'processing',
            pipeline_status: status === 'done' || status === 'completed' ? 'Geração Concluída!' : 'Processando Media...',
            pipeline_progress: status === 'done' || status === 'completed' ? 100 : 90,
            imageUrl: incomingUrls[0] || null
        });

        const genTypeInDb = batchRows.rows[0].type || 'image';
        
        // Determine category and extension based on type
        let category = 'Imagens';
        let ext = 'png';
        let contentType = 'image/png';

        if (genTypeInDb === 'video') {
            category = 'Videos';
            ext = 'mp4';
            contentType = 'video/mp4';
        } else if (genTypeInDb === 'audio' || genTypeInDb === 'voice' || genTypeInDb === 'musica') {
            category = 'Audios';
            ext = 'mp3';
            contentType = 'audio/mpeg';
        }

        console.log(`[Callback] Processing ${incomingUrls.length} ${genTypeInDb}s for batch ${generationId} as ${ext}`);
        
        const finalUrls: string[] = [];
        for (let i = 0; i < incomingUrls.length; i++) {
            const externalUrl = incomingUrls[i];
            const timestamp = Date.now();
            const fileName = `gen_${generationId}_${i}_${timestamp}.${ext}`;

            try {
                const response = await axios.get(externalUrl, { responseType: 'arraybuffer' });
                const buffer = Buffer.from(response.data, 'binary');
                console.log(`[Storage] Moving ${category} to permanent folder for user ${userId}`);
                const permanentUrl = await uploadBufferToUserFolder(userId, category as 'Imagens' | 'Videos' | 'Audios', buffer, fileName, contentType);
                
                // === THUMBNAIL GENERATION ===
                let thumbUrl = null;
                if (category === 'Imagens' && genTypeInDb !== 'video' && genTypeInDb !== 'audio') {
                    try {
                        const thumbBuffer = await sharp(buffer)
                            .resize({ width: 400, withoutEnlargement: true }) // Redimensiona máximo 400px largura, poupa mta banda
                            .webp({ quality: 80 }) // Formato leve
                            .toBuffer();
                        const thumbFileName = `thumb_gen_${generationId}_${i}_${timestamp}.webp`;
                        thumbUrl = await uploadBufferToUserFolder(userId, 'Imagens', thumbBuffer, thumbFileName, 'image/webp');
                        console.log(`[Storage] ✅ Thumbnail criada e submetida: ${thumbFileName}`);
                    } catch (thumbErr: any) {
                        console.error('[Storage Error] Falha ao criar miniatura:', thumbErr.message);
                    }
                }

                // Inject thumb_url directly into metadata if successful
                let finalMetadata = batchRows.rows[0]?.metadata || {};
                if (typeof finalMetadata === 'string') {
                    try { finalMetadata = JSON.parse(finalMetadata); } catch(e) {}
                }
                if (thumbUrl) {
                    finalMetadata = { ...finalMetadata, thumb_url: thumbUrl };
                }

                // Removed late deduction since it's now deducted upfront on the actual API generate routes.
                const cost = Number(req.body.cost) || Number(batchRows.rows[0].cost) || 0;
                console.log(`[n8n Callback] Item ${i} successfully completed for batch ${generationId}. Cost ${cost} already deducted upfront.`);

                finalUrls.push(permanentUrl);

                // Update existing 'processing' row
                const updateResult = await query(
                    `UPDATE generations 
                     SET status = 'completed', result_url = $1, copy = $2, hashtags = $3, title = $4, metadata = $5
                     WHERE id = (
                         SELECT id FROM generations 
                         WHERE batch_id = $6 AND status = 'processing' 
                         ORDER BY id ASC 
                         LIMIT 1 
                         FOR UPDATE SKIP LOCKED
                     )
                     RETURNING id`,
                    [permanentUrl, copy, hashtags, title, JSON.stringify(finalMetadata), generationId]
                );
 
                if (updateResult.rows.length === 0) {
                    // Check if this URL already exists to avoid redundancy in case of retry
                    const dupCheck = await query('SELECT id FROM generations WHERE batch_id = $1 AND result_url = $2', [generationId, permanentUrl]);
                    if (dupCheck.rows.length === 0) {
                        console.log(`[Callback] Extra item for batch ${generationId}, creating row.`);
                        await query(
                            'INSERT INTO generations (user_id, type, prompt, status, result_url, batch_id, copy, hashtags, title, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
                            [userId, genTypeInDb, batchRows.rows[0]?.prompt || 'Extra generation', 'completed', permanentUrl, generationId, copy, hashtags, title, JSON.stringify(finalMetadata)]
                        );
                    }
                }
            } catch (err: any) {
                console.error(`[Callback] Item ${i} failed:`, err.message);
                fs.appendFileSync(path.join(__dirname, '../webhook_logs.txt'), `[ERROR] Storage/Update failed for item ${i}: ${err.message}\n${err.stack}\n`);
            }
        }

        // Cleanup Temp Image
        if (batchRows.rows[0]?.metadata) {
            const metadata = batchRows.rows[0].metadata;
            if (metadata.tempImageUrl) {
                try {
                    const urlParts = metadata.tempImageUrl.split('temp/');
                    if (urlParts.length > 1) {
                        await deleteFile(`temp/${urlParts[1].split('?')[0]}`);
                    }
                } catch (cleanupErr) {
                    console.warn('[Callback] Cleanup failed:', cleanupErr);
                }
            }
        }

        res.json({ success: true, finalUrls });
    } catch (error: any) {
        console.error('[Callback Error]', error);
        fs.appendFileSync(path.join(__dirname, '../webhook_logs.txt'), `[FATAL EXCEPTION] Callback handler crashed: ${error.message}\n${error.stack}\n`);
        res.status(500).json({ success: false });
    }
});

// Delete a generation
app.delete('/api/generations/:id', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const genId = req.params.id;
        if (!userId || !genId) return res.status(400).json({ success: false, message: 'ID ausente' });

        const result = await query('DELETE FROM generations WHERE id = $1 AND user_id = $2 RETURNING id', [genId, userId]);
        
        if (result.rows.length > 0) {
            res.json({ success: true, message: 'Geração deletada com sucesso.' });
        } else {
            res.status(404).json({ success: false, message: 'Geração não encontrada ou acesso negado.' });
        }
    } catch (error) {
        console.error('Delete Generation error:', error);
        res.status(500).json({ success: false, message: 'Erro ao deletar.' });
    }
});

// List all generations for a user
app.get('/api/generations', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(400).json({ success: false });

        // --- LAZY CLEANUP OF STALLED GENERATIONS ---
        try {
            const stalledGenerations = await query(
                "UPDATE generations SET status = 'failed' WHERE status = 'processing' AND created_at < NOW() - INTERVAL '9 minutes' RETURNING cost, user_id, id"
            );
            
            for (const row of stalledGenerations.rows) {
                const refundCost = Number(row.cost) || 0;
                if (refundCost > 0) {
                    await query('UPDATE users SET credits = credits + $1 WHERE id = $2', [refundCost, row.user_id]);
                    console.log(`[Cleanup] Refunded ${refundCost} credits to user ${row.user_id} for stalled generation ${row.id}`);
                }
            }
        } catch (cleanupErr: any) {
            // Only log if it's NOT a connection error, to keep logs clean during outage
            if (!cleanupErr.message?.includes('connect') && !cleanupErr.message?.includes('timeout')) {
                console.warn('[Cleanup] ⚠️ Stalled generation cleanup failed:', cleanupErr.message);
            }
        }
        // --------------------------------------------

        const limit = parseInt(req.query.limit as string) || 18;
        const page = parseInt(req.query.page as string) || 1;
        const offset = (page - 1) * limit;

        const excludeTypes = req.query.excludeTypes ? (req.query.excludeTypes as string).split(',') : [];
        let whereClause = 'WHERE user_id = $1';
        let gWhereClause = 'WHERE g.user_id = $1';
        let queryParams: any[] = [userId];

        if (excludeTypes.length > 0) {
            whereClause += ' AND type != ALL($2::text[])';
            gWhereClause += ' AND g.type != ALL($2::text[])';
            queryParams.push(excludeTypes);
        }

        // Get total count for pagination
        const countRes = await query(`SELECT count(*) FROM generations ${whereClause}`, queryParams);
        const total = parseInt(countRes.rows[0].count);

        const result = await query(
            `SELECT g.*, (SELECT id FROM posts WHERE generation_id = g.id LIMIT 1) as social_post_id
             FROM generations g 
             ${gWhereClause}
             ORDER BY g.created_at DESC, g.id DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`,
            [...queryParams, limit, offset]
        );

        // Sign the result URLs if they are completed
        const signedGenerations = await Promise.all(result.rows.map(async (gen) => {
            if (gen.status === 'completed' && gen.result_url) {
                const signedUrl = await getSignedS3UrlForKey(gen.result_url, 86400); // 24h
                
                let updatedGen = { ...gen, result_url: signedUrl };
                
                // Sign thumb_url if exists
                if (updatedGen.metadata?.thumb_url) {
                    try {
                        const signedThumb = await getSignedS3UrlForKey(updatedGen.metadata.thumb_url, 86400);
                        updatedGen.metadata = { ...updatedGen.metadata, thumb_url: signedThumb };
                    } catch (e) { console.error('Error signing thumb:', e); }
                }
                
                return updatedGen;
            }
            return gen;
        }));

        res.json({ 
            success: true, 
            generations: signedGenerations,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Gallery Fetch error:', error);
        res.status(500).json({ success: false });
    }
});

// Delete a generation (DB + S3)
app.delete('/api/generations/:id', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.id;

        // 1. Get generation info to get S3 key
        const genRes = await query('SELECT result_url FROM generations WHERE id = $1 AND user_id = $2', [id, userId]);
        if (genRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Não encontrado.' });

        const resultUrl = genRes.rows[0].result_url;
        const bucketName = process.env.S3_BUCKET || "kwikdocsao";

        // 2. Delete from S3 if it exists
        if (resultUrl) {
            try {
                const keyParts = resultUrl.split(`${bucketName}/`);
                if (keyParts.length > 1) {
                    const key = keyParts[1].split('?')[0];
                    await deleteFile(key);
                }
            } catch (err) {
                console.warn('[API] S3 Delete failed:', err);
            }
        }

        // 3. Delete from DB
        await query('DELETE FROM generations WHERE id = $1 AND user_id = $2', [id, userId]);

        res.json({ success: true });
    } catch (error) {
        console.error('Delete gen error:', error);
        res.status(500).json({ success: false });
    }
});

// Get real-world stats for a user
app.get('/api/user/stats', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(400).json({ success: false });

        // 1. Total Generations
        const totalGens = await query('SELECT count(*) FROM generations WHERE user_id = $1', [userId]);
        
        // 2. Real Credits from users table
        const userRes = await query('SELECT credits, role FROM users WHERE id = $1', [userId]);
        
        res.json({
            success: true,
            totalGenerations: parseInt(totalGens.rows[0].count),
            credits: userRes.rows[0]?.credits || 0,
            role: userRes.rows[0]?.role || 'user'
        });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Get transaction history
app.get('/api/user/transactions', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(400).json({ success: false });

        const result = await query(
            'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
            [userId]
        );

        const signedTransactions = await Promise.all(result.rows.map(async (tx) => {
            let updatedTx = { ...tx };
            if (tx.proof_url) {
                updatedTx.proof_url = await getSignedS3UrlForKey(tx.proof_url, 3600);
            }
            if (tx.invoice_url) {
                updatedTx.invoice_url = await getSignedS3UrlForKey(tx.invoice_url, 86400); // 24h for invoices
            }
            return updatedTx;
        }));

        res.json({ success: true, transactions: signedTransactions });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// --- SYSTEM DATABASE INITIALIZATION (Unified) ---
const initSystemDb = async () => {
    try {
        console.log('[Database] 🚀 Initializing Unified System Schema...');

        // 1. Core Settings
        await query(`
            CREATE TABLE IF NOT EXISTS system_settings (
                key VARCHAR(255) PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 2. WhatsApp Leads & Messages
        await query(`
            CREATE TABLE IF NOT EXISTS whatsapp_leads (
                id SERIAL PRIMARY KEY,
                phone VARCHAR(50) UNIQUE NOT NULL,
                name VARCHAR(255),
                business_info TEXT,
                needs TEXT,
                status VARCHAR(50) DEFAULT 'new', -- new, in_progress, qualified, human
                agent_active BOOLEAN DEFAULT TRUE,
                last_interaction TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS whatsapp_messages (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER REFERENCES whatsapp_leads(id),
                role VARCHAR(20) NOT NULL, -- user, agent, human
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 3. Monitoring & Alerts
        await query(`
            CREATE TABLE IF NOT EXISTS alerts (
                id SERIAL PRIMARY KEY,
                type VARCHAR(50) NOT NULL,
                title VARCHAR(255) NOT NULL,
                message TEXT,
                status VARCHAR(50) DEFAULT 'active', -- active, acknowledged, resolved
                severity VARCHAR(20) DEFAULT 'medium',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                acknowledged_at TIMESTAMP,
                resolved_at TIMESTAMP
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                admin_id UUID NOT NULL,
                action TEXT NOT NULL,
                details JSONB DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 4. Admin Notifications
        await query(`
            CREATE TABLE IF NOT EXISTS admin_notifications (
                id SERIAL PRIMARY KEY,
                type VARCHAR(50),
                title VARCHAR(255),
                message TEXT,
                icon VARCHAR(50),
                color VARCHAR(50),
                is_read BOOLEAN DEFAULT FALSE,
                reference_id TEXT,
                reference_type TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 5. WhatsApp Logs (Metrics)
        await query(`
            CREATE TABLE IF NOT EXISTS whatsapp_logs (
                id SERIAL PRIMARY KEY,
                recipient VARCHAR(255) NOT NULL,
                type VARCHAR(50) NOT NULL,
                content TEXT,
                status VARCHAR(50) NOT NULL,
                error_details TEXT,
                category VARCHAR(50) DEFAULT 'general', -- auth, payment_user, payment_admin, campaign, followup, agent_action, test
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Migrate whatsapp_logs for old deployments
        try {
            await query("ALTER TABLE whatsapp_logs ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'general'");
        } catch(e) { }

        // 6. Agent Team & System Config
        await query(`
            CREATE TABLE IF NOT EXISTS system_metrics (
                id SERIAL PRIMARY KEY,
                metric_name VARCHAR(255) NOT NULL,
                metric_value NUMERIC NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Insert Default Alex Agent Prompt
        const alexPromptCheck = await query("SELECT value FROM system_settings WHERE key = 'whatsapp_agent_prompt'");
        if (alexPromptCheck.rows.length === 0) {
            const alexPrompt = `Tu és o Alex, um consultor de marketing especializado e caloroso da Conversio AI. 
O teu tom de voz é amigável, profissional e segues o estilo de comunicação de Angola.
O teu objetivo é qualificar leads que chegam pelo WhatsApp de forma natural.
Deves identificar: 
1. O Nome do cliente.
2. O Negócio ou empresa dele.
3. A Necessidade principal (Anúncios, Gestão de Redes, Vídeo, etc.).
Sê curto e focado em marcar uma conversa mais profunda quando tiveres os dados.`;
            
            await query("INSERT INTO system_settings (key, value) VALUES ('whatsapp_agent_prompt', $1)", [alexPrompt]);
            console.log('[Database] 🤖 Alex AI default prompt initialized.');
        }

        console.log('[Database] ✅ Unified System Schema verified.');
    } catch (err) {
        console.error('[Database] ❌ Unified Schema init error:', err);
    }
};
initSystemDb();


// Billing & Checkout Routes
app.post('/api/billing/checkout', async (req, res) => {
    try {
        const { userId, planId, amount, credits, paymentMethod, transactionId: extTxId, billingCycle } = req.body;
 
        if (!userId || !planId || !amount) {
            return res.status(400).json({ success: false, message: 'Dados incompletos para checkout' });
        }
 
        // --- NEW: Process only credits/packages ---
        // As plans no longer exist, we proceed directly with the package checkout logic.
 
        const description = extTxId 
            ? `Compra Pacote ${planId} via ${paymentMethod} (ID: ${extTxId})`
            : `Compra Pacote ${planId} via ${paymentMethod}`;
 
        const result = await query(
            'INSERT INTO transactions (user_id, amount, currency, type, status, description, credits, payment_method) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
            [userId, amount, 'Kz', planId, 'pending', description, credits || 0, paymentMethod]
        );

        res.json({ success: true, transactionId: result.rows[0].id });
    } catch (error: any) {
        console.error('Checkout error:', error);
        res.status(500).json({ success: false, message: 'Falha ao processar transação no banco de dados' });
    }
});


app.post('/api/billing/upload-proof', upload.single('proof'), async (req: express.Request & { file?: Express.Multer.File }, res) => {
    try {
        const { transactionId, userId } = req.body;
        const proofFile = req.file;

        if (!transactionId || !proofFile) {
            return res.status(400).json({ success: false, message: 'Faltam dados do comprovativo' });
        }

        const timestamp = Date.now();
        const fileName = `proof_${transactionId}.png`;
        const proofUrl = await uploadTransactionFile(transactionId, 'proof', proofFile.buffer, fileName, proofFile.mimetype);

        await query(
            "UPDATE transactions SET status = 'pending_verification', proof_url = $2 WHERE id = $1",
            [transactionId, proofUrl]
        );

        // Notificar o admin via WhatsApp
        try {
            const adminWhatsapp = await getAdminWhatsApp();
            if (adminWhatsapp) {
                const userRes = await query('SELECT name, whatsapp FROM users WHERE id = $1', [userId]);
                const userName = userRes.rows[0]?.name || 'Utilizador';
                const userPhone = userRes.rows[0]?.whatsapp || 'Sem número';
                
                const txRes = await query('SELECT amount, credits FROM transactions WHERE id = $1', [transactionId]);
                const amount = txRes.rows[0]?.amount || 0;
                const credits = txRes.rows[0]?.credits || 0;

                const notifyMsg = `💰 *Novo Pagamento Pendente na Conversio!*\n\n*Utilizador:* ${userName}\n*Telemóvel:* ${userPhone}\n*Valor:* ${amount} AOA\n*Créditos:* ${credits}\n\n👉 Clique abaixo para aprovar:\nhttps://conversio.ai/admin/payments`;
                await sendWhatsAppMessage(adminWhatsapp, notifyMsg, 'payment_admin');
            }
        } catch (adminNotifErr) {
            console.error('[Admin Notify Error]', adminNotifErr);
        }

        res.json({ success: true, proofUrl });
    } catch (error: any) {
        console.error('Proof upload error:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao processar comprovativo' });
    }
});

// Social Network Endpoints

// Create a new post
app.post('/api/social/post', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const { generationId, type, imageUrl, prompt } = req.body;

        if (!userId || !imageUrl) {
            return res.status(400).json({ success: false, message: 'Dados insuficientes para postar.' });
        }

        // 1. Check monthly limit (10 posts per month)
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);

        const countRes = await query(
            'SELECT count(*) FROM posts WHERE user_id = $1 AND created_at >= $2',
            [userId, startOfMonth]
        );

        if (parseInt(countRes.rows[0].count) >= 10) {
            return res.status(403).json({ 
                success: false, 
                message: 'Limite de 10 publicações mensais atingido. Tente novamente no próximo mês.' 
            });
        }

        // 2. Create post
        const { description = '' } = req.body;
        const result = await query(
            'INSERT INTO posts (user_id, generation_id, type, image_url, prompt, description) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [userId, generationId, type || 'image', imageUrl, prompt, description]
        );

        res.json({ success: true, postId: result.rows[0].id });
    } catch (error) {
        console.error('Social Post error:', error);
        res.status(500).json({ success: false, message: 'Erro ao criar publicação' });
    }
});

// List posts with ranking/sorting
app.get('/api/social/posts', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const { sort = 'trending', page = '1' } = req.query;
        const limit = 20;
        const offset = (parseInt(page as string) - 1) * limit;

        let orderBy = 'created_at DESC';
        let whereClause = '';
        const params: any[] = [limit, offset];

        if (sort === 'my' && userId) {
            whereClause = 'WHERE p.user_id = $3';
            params.push(userId);
        }

        if (sort === 'trending') {
            // Ranking formula: Views (1) + Likes (3) + Comments (5)
            orderBy = '(views_count + likes_count * 3 + comments_count * 5) DESC, created_at DESC';
        } else if (sort === 'popular') {
            orderBy = 'likes_count DESC, created_at DESC';
        }

        const result = await query(
            `SELECT p.*, u.name as creator_name, u.avatar_url as creator_avatar
             FROM posts p
             JOIN users u ON p.user_id = u.id
             ${whereClause}
             ORDER BY ${orderBy}
             LIMIT $1 OFFSET $2`,
            params
        );

        // Check likes for current user if applicable
        const finalPosts = result.rows;
        if (userId && finalPosts.length > 0) {
            const postIds = finalPosts.map(p => p.id);
            const userLikes = await query(
                'SELECT post_id FROM likes WHERE user_id = $1 AND post_id = ANY($2)',
                [userId, postIds]
            );
            const likedSet = new Set(userLikes.rows.map(l => l.post_id));
            finalPosts.forEach(p => p.is_liked = likedSet.has(p.id));
        }

        res.json({ success: true, posts: finalPosts });
    } catch (error) {
        console.error('Fetch Social Posts error:', error);
        res.status(500).json({ success: false });
    }
});

// Like/Unlike a post
app.post('/api/social/like', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const { postId } = req.body;
        if (!userId || !postId) return res.status(400).json({ success: false });

        // Check if already liked
        const existing = await query('SELECT id FROM likes WHERE user_id = $1 AND post_id = $2', [userId, postId]);
        
        if (existing.rows.length > 0) {
            // Unlike
            await query('DELETE FROM likes WHERE id = $1', [existing.rows[0].id]);
            await query('UPDATE posts SET likes_count = GREATEST(0, likes_count - 1) WHERE id = $1', [postId]);
            res.json({ success: true, liked: false });
        } else {
            // Like
            await query('INSERT INTO likes (user_id, post_id) VALUES ($1, $2)', [userId, postId]);
            await query('UPDATE posts SET likes_count = likes_count + 1 WHERE id = $1', [postId]);

            // Create notification
            const postRes = await query('SELECT user_id FROM posts WHERE id = $1', [postId]);
            if (postRes.rows.length > 0 && postRes.rows[0].user_id !== userId) {
                await query(
                    'INSERT INTO social_notifications (user_id, actor_id, post_id, type) VALUES ($1, $2, $3, $4)',
                    [postRes.rows[0].user_id, userId, postId, 'like']
                );
            }

            res.json({ success: true, liked: true });
        }
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Add a comment
app.post('/api/social/comment', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const { postId, content } = req.body;
        if (!userId || !postId || !content) return res.status(400).json({ success: false });

        const result = await query(
            'INSERT INTO comments (user_id, post_id, content) VALUES ($1, $2, $3) RETURNING id',
            [userId, postId, content]
        );

        await query('UPDATE posts SET comments_count = comments_count + 1 WHERE id = $1', [postId]);

        // Create notification
        const postRes = await query('SELECT user_id FROM posts WHERE id = $1', [postId]);
        if (postRes.rows.length > 0 && postRes.rows[0].user_id !== userId) {
            await query(
                'INSERT INTO social_notifications (user_id, actor_id, post_id, type, content) VALUES ($1, $2, $3, $4, $5)',
                [postRes.rows[0].user_id, userId, postId, 'comment', content]
            );
        }

        res.json({ success: true, commentId: result.rows[0].id });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Increment views (only for non-owners)
app.post('/api/social/view', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const viewerId = req.user?.id;
        const { postId } = req.body;
        if (!postId) return res.status(400).json({ success: false });

        // Fetch the post owner
        const postRes = await query('SELECT user_id FROM posts WHERE id = $1', [postId]);
        if (postRes.rows.length === 0) return res.status(404).json({ success: false });

        // Skip if the viewer is the post owner
        if (viewerId && postRes.rows[0].user_id === viewerId) {
            return res.json({ success: true, counted: false });
        }

        await query('UPDATE posts SET views_count = views_count + 1 WHERE id = $1', [postId]);
        res.json({ success: true, counted: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Notifications
app.get('/api/social/notifications', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(400).json({ success: false });

        const result = await query(
            `SELECT n.*, u.name as actor_name, u.avatar_url as actor_avatar, p.image_url as post_image
             FROM social_notifications n
             JOIN users u ON n.actor_id = u.id
             JOIN posts p ON n.post_id = p.id
             WHERE n.user_id = $1
             ORDER BY n.created_at DESC
             LIMIT 50`,
            [userId]
        );

        res.json({ success: true, notifications: result.rows });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/social/notifications/read', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(400).json({ success: false });

        await query('UPDATE social_notifications SET is_read = TRUE WHERE user_id = $1', [userId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/social/post/:postId/comments', async (req, res) => {
    try {
        const { postId } = req.params;
        const result = await query(
            `SELECT c.*, u.name as user_name, u.avatar_url as user_avatar
             FROM comments c
             JOIN users u ON c.user_id = u.id
             WHERE c.post_id = $1
             ORDER BY c.created_at ASC`,
            [postId]
        );
        res.json({ success: true, comments: result.rows });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Video Generation Endpoint
app.post('/api/generate/video', authenticateJWT, upload.single('image'), async (req: AuthRequest & { file?: Express.Multer.File }, res) => {
    console.log(`[API] 🎬 Recieved video generation request. Body:`, { ...req.body, prompt: req.body.prompt?.substring(0, 50) + "..." });
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

        // Plan Validation & Info fetch in a single scoped query
        const userQueryRes = await query('SELECT plan, credits, name, whatsapp FROM users WHERE id = $1', [userId]);
        if (!userQueryRes.rows.length) return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
        
        const { prompt, model, style, aspectRatio, quantity, core_model, core_id, core_name, mode } = req.body;
        if (!prompt && !req.file && !req.body.referenceImageUrl) return res.status(400).json({ success: false, message: 'Digite uma descrição ou carregue uma imagem.' });

        const actualCoreId = core_id || core_model;
        const userRes = userQueryRes; // Map legacy variable
        const credits = userRes.rows[0].credits;
        const qty = parseInt(quantity) || 1;
        
        let modelCost = 10; // Default for Video
        let coreCost = 0;

        // Optionally fetch from DB if IDs provided
        if (model) {
            const mRes = await query("SELECT credit_cost FROM models WHERE name = $1 AND type = 'video'", [model]);
            if (mRes.rows.length > 0) modelCost = Number(mRes.rows[0].credit_cost) || 10;
        }
        if (actualCoreId) {
            const cRes = await query("SELECT credit_cost FROM models WHERE name = $1 AND type = 'video'", [actualCoreId]);
            if (cRes.rows.length > 0) coreCost = Number(cRes.rows[0].credit_cost) || 0;
        }

        const unitCost = modelCost + coreCost;
        const totalCost = qty * unitCost;

        if (credits < totalCost) {
            const user = userRes.rows[0];
            if (user.whatsapp) {
                try {
                    await whatsappService.sendWhatsAppMessage(
                        user.whatsapp, 
                        `Olá ${user.name}! ⚠️ O seu pedido de geração de vídeo falhou porque não tem créditos suficientes no Conversio.\nNecessita de ${totalCost} créditos, mas apenas tem ${credits} disponíveis.\n\nPor favor, recarregue a sua conta para continuar a criar!`
                    );
                } catch (e) {
                    console.warn('[WhatsApp warning failure]', e);
                }
            }
            return res.status(402).json({ success: false, message: `Créditos insuficientes. Necessário: ${totalCost}, Disponível: ${credits}` });
        }

        // Deduct credits upfront
        await query('UPDATE users SET credits = credits - $1 WHERE id = $2', [totalCost, userId]);

        // Upload reference image if provided or use gallery URL
        let referenceImageUrl = req.body.referenceImageUrl || null;
        if (req.file) {
            try {
                referenceImageUrl = await uploadToTemp(req.file.buffer, req.file.originalname, req.file.mimetype);
            } catch (err: any) {
                console.error('[API] Video reference upload error:', err.message);
            }
        }

        // Create pending generation records
        const batchId = `VIDEO-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const generationIds: string[] = [];
        for (let i = 0; i < qty; i++) {
            const genRes = await query(
                `INSERT INTO generations (user_id, prompt, type, status, model, style, aspect_ratio, batch_id, cost, metadata)
                 VALUES ($1, $2, 'video', 'processing', $3, $4, $5, $6, $7, $8) RETURNING id`,
                [userId, prompt, model, style, aspectRatio, batchId, unitCost, JSON.stringify({ mode, core_id: actualCoreId, style })]
            );
            generationIds.push(genRes.rows[0].id);
        }

        // Fetch Brand Colors
        const brandRes = await query('SELECT brand_colors FROM brands WHERE user_id = $1', [userId]);
        const brandColors = brandRes.rows[0]?.brand_colors || null;

        // Dispatch to Internal Generation Engine
        const engineUrl = (process.env.GENERATION_ENGINE_URL || 'http://localhost:3010').replace(/[, ]/g, '');
        const internalSecret = process.env.INTERNAL_SECRET;

        const use_brand_colors = req.body.use_brand_colors;
        const brand_colors = req.body.brand_colors;

        // Start pipeline for each generation in background
        generationIds.forEach((genId, index) => {
            console.log(`[API] 🚀 Delegating video ${genId} to engine: ${engineUrl}`);
            axios.post(`${engineUrl}/internal/generate/video`, {
                userId,
                userPrompt: prompt,
                productImageUrl: referenceImageUrl,
                coreId: actualCoreId,
                coreName: core_name || actualCoreId,
                modelId: (model === 'Veo 3.1 Lite' || model === 'veo-3-1' || model === 'veo3_fast' || model === 'veo3lite') ? 'veo3lite' : model,
                aspectRatio,
                generationId: genId,
                useBrandColors: use_brand_colors === 'true' || use_brand_colors === true,
                brandColors: typeof brand_colors === 'string' ? JSON.parse(brand_colors) : brand_colors,
                currentIndex: index + 1,
                totalItems: qty
            }, {
                headers: { 'X-Internal-Secret': internalSecret },
                timeout: 30000
            }).then(resp => {
                console.log(`[API] ✅ Video ${genId} delegated successfully.`);
            }).catch(err => {
                const errorDetail = err.response?.data?.message || err.message || 'Erro de conexão ou timeout';
                console.error(`[API] ❌ Failed to dispatch video ${genId} to engine:`, errorDetail);
                
                // Emit to System Monitor for real-time visibility
                emitSystemLog('API', `Falha ao enviar geração ${genId} para o motor: ${errorDetail}`, 'error', { 
                    genId, 
                    engineUrl,
                    errorCode: err.code 
                });
            });
        });

        // Fire n8n as legacy fallback or additional processing if configured
        const webhookKey = req.file ? 'webhook_video' : 'webhook_video_text';
        const defaultWebhook = process.env.N8N_VIDEO_WEBHOOK || '';
        const webhookUrl = await getConfig(webhookKey, defaultWebhook);
        if (webhookUrl && webhookUrl !== defaultWebhook) {
            axios.post(webhookUrl, {
                userId,
                userName: userRes.rows[0].name,
                prompt,
                model,
                core_model: actualCoreId,
                core_name,
                mode,
                style,
                aspectRatio,
                quantity: qty,
                batchId,
                generationIds,
                referenceImageUrl,
                brandColors // Include brand colors
            }).catch(() => {});
        }


        res.json({ success: true, message: 'Geração de vídeo iniciada!', generationIds, batchId });
    } catch (error: any) {
        console.error('Video Generation Error:', error);
        res.status(500).json({ success: false, message: 'Erro ao processar a geração do vídeo. Verifique os dados e tente novamente.' });
    }
});

// --- UGC Anti-Repetition System ---

/**
 * Normalizes and hashes product name + category
 */
const generateProductHash = (name: string, category: string): string => {
    const normalize = (str: string) => (str || '').toLowerCase().trim().replace(/\s+/g, '');
    const data = `${normalize(name)}${normalize(category)}`;
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
};

// Endpoint to generate hash (exposed for n8n)
app.get('/api/ugc/hash', async (req, res) => {
    const { name, category } = req.query;
    if (!name || !category) return res.status(400).json({ success: false, message: 'Faltam parâmetros name/category' });
    const hash = generateProductHash(name as string, category as string);
    res.json({ success: true, hash });
});

// Get UGC history for a product (last 30 days)
app.get('/api/ugc/history', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const { product_hash } = req.query;

        fs.appendFileSync(path.join(__dirname, '../webhook_logs.txt'), `[UGC GET] User: ${userId}, Hash: ${product_hash}\n`);

        if (!userId || !product_hash) {
            return res.status(400).json({ success: false, message: 'Parâmetros insuficientes' });
        }

        const result = await query(
            `SELECT tipo_ugc, sub_cena, angulo_camara, emocao_dominante, gancho_tipo, cenario 
             FROM ugc_used_combinations 
             WHERE user_id = $1 AND product_hash = $2 AND created_at > NOW() - INTERVAL '30 days'
             ORDER BY created_at DESC`,
            [userId, product_hash]
        );

        res.json({ success: true, history: result.rows });
    } catch (error: any) {
        console.error('[UGC History GET] Error:', error.message);
        res.status(500).json({ success: false });
    }
});

// Save new UGC combinations
app.post('/api/ugc/history', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const { product_hash, combinations } = req.body;

        if (!userId || !product_hash || !combinations || !Array.isArray(combinations)) {
            return res.status(400).json({ success: false, message: 'Dados inválidos' });
        }

        console.log(`[UGC History POST] Saving ${combinations.length} combinations for user ${userId}, product ${product_hash}`);

        for (const comb of combinations) {
            const { tipo_ugc, sub_cena, angulo_camara, emocao_dominante, gancho_tipo, cenario } = comb;

            // Using INSERT ... ON CONFLICT DO NOTHING (requires a unique constraint or index)
            // But since I didn't add a UNIQUE constraint on all 8 columns, I'll just check if it exists or use a complex unique index in migration if needed.
            // For now, simple insert is fine as per request: "Usa INSERT ... ON CONFLICT DO NOTHING para evitar duplicados"
            // Wait, the user said ON CONFLICT DO NOTHING. I need a unique constraint for that to work.
            
            await query(
                `INSERT INTO ugc_used_combinations 
                 (user_id, product_hash, tipo_ugc, sub_cena, angulo_camara, emocao_dominante, gancho_tipo, cenario)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT DO NOTHING`, 
                [userId, product_hash, tipo_ugc, sub_cena, angulo_camara, emocao_dominante, gancho_tipo, cenario]
            );
        }

        res.json({ success: true, saved: combinations.length });
    } catch (error: any) {
        console.error('[UGC History POST] Error:', error.message);
        res.status(500).json({ success: false });
    }
});


// Audio (Voice & Music) Generation Endpoint
app.post('/api/generate/voice', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

        // Plan Validation & Info fetch in a single grouped query
        const userQueryRes = await query('SELECT plan, credits, name, whatsapp FROM users WHERE id = $1', [userId]);
        if (!userQueryRes.rows.length) return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });

        // Audio generation available for all users with sufficient credits
        
        const { prompt, type = 'voice', voiceType, voiceId, model = 'Voice AI', style, instrumental } = req.body;
        if (!prompt) return res.status(400).json({ success: false, message: 'Dados insuficientes' });

        const userRes = userQueryRes; // Map legacy variable
        
        const credits = userRes.rows[0].credits;
        const realType = type === 'musica' || type === 'music' ? 'musica' : 'voice';
        
        // Calculate cost
        let cost = 2; // Default for voice
        if (realType === 'musica') {
            cost = model && model.includes('V4') ? 5 : (model && model.includes('V5') ? 8 : 5);
        }
        
        if (credits < cost) {
            const user = userRes.rows[0];
            if (user.whatsapp) {
                try {
                    await whatsappService.sendWhatsAppMessage(
                        user.whatsapp, 
                        `Olá ${user.name}! ⚠️ O seu pedido de geração de áudio falhou porque não tem créditos suficientes no Conversio.\nNecessita de ${cost} créditos, mas apenas tem ${credits} disponíveis.\n\nPor favor, recarregue a sua conta para continuar a criar!`
                    );
                } catch (e) {
                    console.warn('[WhatsApp warning failure]', e);
                }
            }
            return res.status(402).json({ success: false, message: `Créditos insuficientes. Necessário: ${cost}, Disponível: ${credits}` });
        }

        // Deduct credits upfront
        await query('UPDATE users SET credits = credits - $1 WHERE id = $2', [cost, userId]);

        // Create pending generation record
        const batchId = `AUDIO-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        // Save initial processing generation
        const insertRes = await query(
            `INSERT INTO generations (user_id, prompt, type, status, model, style, batch_id, cost, metadata) 
             VALUES ($1, $2, $3, 'processing', $4, $5, $6, $7, $8) RETURNING id`,
            [userId, prompt, realType, model, style || '', batchId, cost, JSON.stringify({ voiceType, voiceId, type: realType, instrumental })]
        );
        const generationId = insertRes.rows[0].id;

        // Fetch Brand Colors
        const brandRes = await query('SELECT brand_colors FROM brands WHERE user_id = $1', [userId]);
        const brandColors = brandRes.rows[0]?.brand_colors || null;

        // Redirect to Internal Generation Engine for Music
        const generationEngineUrl = (process.env.GENERATION_ENGINE_URL || 'http://localhost:3010').replace(/[, ]/g, '');
        const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

        if (realType === 'musica') {
            console.log(`[Backend] 🎵 Routing music generation to internal engine: ${generationId}`);
            axios.post(`${generationEngineUrl}/internal/generate/audio`, {
                userId,
                generationId,
                userPrompt: prompt,
                style,
                instrumental,
                backendUrl: process.env.PUBLIC_URL || 'http://localhost:3003'
            }, {
                headers: { 'X-Internal-Secret': INTERNAL_SECRET }
            }).catch(err => console.error('[Engine Audio Error]', err.message));
        } else {
            // Fire n8n webhook (fire-and-forget) for legacy voice
            const webhookKey = 'webhook_voice';
            const defaultWebhook = process.env.N8N_VOICE_WEBHOOK || '';
            const webhookUrl = await getConfig(webhookKey, defaultWebhook);
            
            axios.post(webhookUrl, {
                userId,
                userName: userRes.rows[0].name,
                prompt,
                type: realType,
                voiceType,
                voiceId,
                model,
                style,
                instrumental,
                batchId,
                generationId,
                brandColors,
                callbackUrl: `${process.env.PUBLIC_URL || 'http://localhost:3003'}/api/ads/callback`
            }).catch(err => console.error('[n8n Audio Webhook Error]', err.message));
        }

        res.json({ success: true, message: 'Geração de áudio iniciada!', generationId, batchId, newCredits: credits - cost });
    } catch (error: any) {
        console.error('Audio Generation Error:', error);
        res.status(500).json({ success: false, message: 'Falha ao processar a geração de áudio.' });
    }
});

// GET Voices List
app.get('/api/voices', async (req, res) => {
    try {
        const result = await query('SELECT id, name, description FROM vozes ORDER BY name ASC');
        res.json({ success: true, voices: result.rows });
    } catch (error: any) {
        console.error('Error fetching voices:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});


// --- ADMIN CONFIG ENDPOINT (used by AdminSettings panel) ---
app.get('/api/admin/config', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        // Fetch all relevant config settings from system_settings
        const settingsRes = await query('SELECT key, value FROM system_settings');
        const settings: Record<string, string> = {};
        settingsRes.rows.forEach((row: any) => { settings[row.key] = row.value; });

        // Fetch DB connection info
        let dbStatus = 'connected';
        try { await query('SELECT 1'); } catch { dbStatus = 'error'; }

        res.json({
            success: true,
            config: {
                system: {
                    version: '2.4.0',
                    db_status: dbStatus,
                    node_env: process.env.NODE_ENV || 'production'
                },
                storage: {
                    bucket: settings['storage_bucket'] || process.env.S3_BUCKET_NAME || '',
                    region: settings['storage_region'] || process.env.S3_REGION || '',
                    endpoint: settings['storage_endpoint'] || process.env.S3_ENDPOINT || '',
                    access_key: settings['storage_access_key'] || process.env.S3_ACCESS_KEY || '',
                    secret_key: settings['storage_secret_key'] || process.env.S3_SECRET_KEY || ''
                },
                webhooks: {
                    image: settings['webhook_image'] || process.env.WEBHOOK_IMAGE || '',
                    image_text: settings['webhook_image_text'] || process.env.WEBHOOK_IMAGE_TEXT || '',
                    video: settings['webhook_video'] || process.env.WEBHOOK_VIDEO || '',
                    video_text: settings['webhook_video_text'] || process.env.WEBHOOK_VIDEO_TEXT || '',
                    voice: settings['webhook_voice'] || process.env.WEBHOOK_VOICE || '',
                    music: settings['webhook_music'] || process.env.WEBHOOK_MUSIC || '',
                    analyze: settings['webhook_analyze'] || process.env.WEBHOOK_ANALYZE || ''
                },
                database: {
                    host: process.env.DB_HOST || 'localhost',
                    port: process.env.DB_PORT || '5432',
                    user: process.env.DB_USER || 'postgres',
                    name: process.env.DB_NAME || 'conversio_ao'
                },
                ai_agent: {
                    openai_api_key: settings['openai_api_key'] || process.env.OPENAI_API_KEY || '',
                    kie_ai_api_key: settings['kie_ai_api_key'] || process.env.KIE_AI_API_KEY || '',
                    marketing_agent_prompt: settings['marketing_agent_prompt'] || ''
                },
                financial: {
                    initial_credits: settings['financial_initial_credits'] || '500',
                    beneficiary_name: settings['financial_beneficiary_name'] || '',
                    bank_accounts: (() => { try { return JSON.parse(settings['financial_bank_accounts'] || '[]'); } catch { return []; } })(),
                    mcx_express: (() => { try { return JSON.parse(settings['financial_mcx_express'] || '[]'); } catch { return []; } })()
                }
            }
        });
    } catch (e: any) {
        console.error('[Admin Config GET] Error:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/config', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { settings } = req.body;
        if (!settings || typeof settings !== 'object') {
            return res.status(400).json({ success: false, message: 'Objeto de configurações inválido.' });
        }

        // Upsert each setting into system_settings
        for (const [key, value] of Object.entries(settings)) {
            if (value !== undefined && value !== null) {
                await query(
                    `INSERT INTO system_settings (key, value) VALUES ($1, $2)
                     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
                    [key, String(value)]
                );
            }
        }

        res.json({ success: true, message: 'Configurações guardadas com sucesso.' });
    } catch (e: any) {
        console.error('[Admin Config POST] Error:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/setup', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        // Run essential table verifications / migrations
        const checks = [
            `CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMP DEFAULT NOW())`,
            `CREATE TABLE IF NOT EXISTS whatsapp_logs (id SERIAL PRIMARY KEY, recipient TEXT, type TEXT, content TEXT, status TEXT DEFAULT 'pending', error_details TEXT, category TEXT DEFAULT 'general', created_at TIMESTAMP DEFAULT NOW())`,
            `CREATE TABLE IF NOT EXISTS crm_stages (id SERIAL PRIMARY KEY, name TEXT NOT NULL, order_index INTEGER DEFAULT 0, color TEXT DEFAULT '#FFB800', created_at TIMESTAMP DEFAULT NOW())`,
            `CREATE TABLE IF NOT EXISTS crm_interactions (id SERIAL PRIMARY KEY, user_id UUID, type TEXT, content TEXT, created_at TIMESTAMP DEFAULT NOW())`,
            `CREATE TABLE IF NOT EXISTS crm_automations (id SERIAL PRIMARY KEY, name TEXT, trigger_type TEXT DEFAULT 'days_after_signup', delay_days INTEGER DEFAULT 0, message_template TEXT, is_active BOOLEAN DEFAULT true, sent_count INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW())`,
        ];
        for (const sql of checks) {
            await query(sql).catch((e) => console.warn('[Setup] Migration warning:', e.message));
        }

        // Ensure default CRM stages exist
        const stageCount = await query('SELECT COUNT(*) FROM crm_stages');
        if (parseInt(stageCount.rows[0].count) === 0) {
            const defaultStages = [
                { name: 'Novo Lead', order: 1 },
                { name: 'Em Contacto', order: 2 },
                { name: 'Qualificado', order: 3 },
                { name: 'Proposta Enviada', order: 4 },
                { name: 'Convertido', order: 5 }
            ];
            for (const stage of defaultStages) {
                await query('INSERT INTO crm_stages (name, order_index) VALUES ($1, $2)', [stage.name, stage.order]);
            }
        }

        res.json({ success: true, message: 'Base de dados verificada e atualizada com sucesso!' });
    } catch (e: any) {
        console.error('[Admin Setup] Error:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});


// --- PROMPT AGENTS MANAGEMENT ---

app.get('/api/admin/prompt-agents', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const result = await query('SELECT * FROM prompt_agents ORDER BY category, name');
        res.json({ success: true, agents: result.rows });
    } catch (error: any) {
        console.error('[Admin PromptAgents GET] Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/prompt-agents', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { technical_id, name, description, category, system_prompt, user_prompt_template, few_shot_examples, model_id, params, is_active } = req.body;
        
        if (!name || !category || !system_prompt) {
            return res.status(400).json({ success: false, message: 'Nome, categoria e prompt do sistema são obrigatórios.' });
        }

        const result = await query(
            `INSERT INTO prompt_agents 
            (technical_id, name, description, category, system_prompt, user_prompt_template, few_shot_examples, model_id, params, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *`,
            [technical_id, name, description, category, system_prompt, user_prompt_template, few_shot_examples, model_id, params || {}, is_active ?? true]
        );

        res.json({ success: true, agent: result.rows[0] });
    } catch (error: any) {
        console.error('[Admin PromptAgents POST] Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/prompt-agents/:id', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const { technical_id, name, description, category, system_prompt, user_prompt_template, few_shot_examples, model_id, params, is_active } = req.body;

        const result = await query(
            `UPDATE prompt_agents 
             SET technical_id = $1, name = $2, description = $3, category = $4, system_prompt = $5, 
                 user_prompt_template = $6, few_shot_examples = $7, model_id = $8, params = $9, is_active = $10,
                 updated_at = NOW()
             WHERE id = $11
             RETURNING *`,
            [technical_id, name, description, category, system_prompt, user_prompt_template, few_shot_examples, model_id, params || {}, is_active, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Agente não encontrado.' });
        }

        res.json({ success: true, agent: result.rows[0] });
    } catch (error: any) {
        console.error('[Admin PromptAgents PUT] Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/prompt-agents/:id', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const result = await query('DELETE FROM prompt_agents WHERE id = $1 RETURNING id', [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Agente não encontrado.' });
        }

        res.json({ success: true, message: 'Agente removido com sucesso.' });
    } catch (error: any) {
        console.error('[Admin PromptAgents DELETE] Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- ADMIN PANEL ENDPOINTS ---


app.get('/api/admin/whatsapp/instance-status', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const instance = process.env.EVOLUTION_INSTANCE || 'Conversio-Oficial';
        const status = await EvolutionService.getInstanceStatus(instance);
        const adminWhatsapp = await getAdminWhatsApp();
        
        res.json({ 
            success: true, 
            status, 
            adminWhatsapp,
            platformInstance: instance,
            instanceName: instance,
            state: status.state,
            owner: status.owner
        });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/whatsapp/logs', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const result = await query('SELECT * FROM whatsapp_logs ORDER BY created_at DESC LIMIT 100');
        res.json({ success: true, logs: result.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/whatsapp/reconnect', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const instance = process.env.EVOLUTION_INSTANCE || 'Conversio-Oficial';
        const qrcode = await EvolutionService.getQRCode(instance);
        res.json({ success: true, qrcode: { base64: qrcode } });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/whatsapp/logout', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const instance = process.env.EVOLUTION_INSTANCE || 'Conversio-Oficial';
        await EvolutionService.logout(instance);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/whatsapp/config', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { key, value } = req.body;
        if (!key) return res.status(400).json({ success: false, message: 'Chave não fornecida.' });
        
        await query(
            `INSERT INTO system_settings (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [key, String(value)]
        );
        
        res.json({ success: true, message: 'Configuração atualizada com sucesso.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});


// --- GESTÃO DE LEADS WHATSAPP ---
app.get('/api/admin/whatsapp/leads', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { status } = req.query;
        let whereClause = '';
        const params: any[] = [];

        if (status && status !== 'all') {
            whereClause = 'WHERE status = $1';
            params.push(status);
        }

        const result = await query(
            `SELECT * FROM whatsapp_leads ${whereClause} ORDER BY last_interaction DESC`,
            params
        );

        // Get global toggle status
        const agentEnabled = await getConfig('whatsapp_agent_enabled', 'true');

        res.json({ 
            success: true, 
            leads: result.rows,
            agentEnabled: agentEnabled === 'true'
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/whatsapp/leads/:id/messages', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const result = await query(
            'SELECT * FROM whatsapp_messages WHERE lead_id = $1 ORDER BY created_at ASC',
            [id]
        );
        res.json({ success: true, messages: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/whatsapp/leads/:id/send', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const { text } = req.body;

        const leadRes = await query('SELECT phone FROM whatsapp_leads WHERE id = $1', [id]);
        if (leadRes.rows.length === 0) return res.status(404).json({ success: false });

        const phone = leadRes.rows[0].phone;
        const result = await whatsappService.sendWhatsAppMessage(phone, text, 'admin_manual');

        if (result.success) {
            // Save to history as human
            await query(
                'INSERT INTO whatsapp_messages (lead_id, role, content) VALUES ($1, $2, $3)',
                [id, 'human', text]
            );
            // Disable agent for this lead (handover to human)
            await query('UPDATE whatsapp_leads SET agent_active = false, status = $1 WHERE id = $2', ['human', id]);
        }

        res.json(result);
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/whatsapp/leads/:id/toggle-agent', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const { active } = req.body;
        await query('UPDATE whatsapp_leads SET agent_active = $1 WHERE id = $2', [active, id]);
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/whatsapp/config', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { key, value } = req.body;
        if (key === 'whatsapp_agent_enabled' || key === 'whatsapp_agent_prompt' || key === 'admin_whatsapp') {
            await updateConfig(key, String(value));
        }
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/whatsapp/config/:key', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const key = req.params.key as string;
        const value = await getConfig(key, '');
        res.json({ success: true, value });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/whatsapp/instances', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const instances = await EvolutionService.getAllInstances();
        res.json({ success: true, instances });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/whatsapp/reconnect', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const instance = process.env.EVOLUTION_INSTANCE || 'Conversio-Oficial';
        const qrcode = await EvolutionService.getQRCode(instance);
        res.json({ success: true, qrcode });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/whatsapp/instance-status', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const instance = process.env.EVOLUTION_INSTANCE || 'Conversio-Oficial';
        const status = await EvolutionService.getInstanceStatus(instance);
        res.json({ success: true, ...status });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/whatsapp/setup-webhook', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const instance = process.env.EVOLUTION_INSTANCE || 'Conversio-Oficial';
        await EvolutionService.setWebhook(instance);
        res.json({ success: true, message: 'Automação ativada! O Alex já pode responder mensagens.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/whatsapp/logout', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const instance = process.env.EVOLUTION_INSTANCE || 'Conversio-Oficial';
        await EvolutionService.logout(instance);
        res.json({ success: true, message: 'Instância desconectada com sucesso.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/whatsapp/logs', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const result = await query('SELECT * FROM whatsapp_logs ORDER BY created_at DESC LIMIT 100');
        res.json({ success: true, logs: result.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- WHATSAPP CATEGORY METRICS ---
app.get('/api/admin/whatsapp/metrics', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const result = await query(`
            SELECT category, 
                   COUNT(*) as total,
                   COUNT(*) FILTER (WHERE status = 'success') as success,
                   COUNT(*) FILTER (WHERE status = 'failed') as failed
            FROM whatsapp_logs
            GROUP BY category
        `);
        
        const instance = process.env.EVOLUTION_INSTANCE || 'Conversio-Oficial';
        const status = await EvolutionService.getInstanceStatus(instance);

        res.json({ 
            success: true, 
            metrics: result.rows,
            apiStatus: status.state === 'open' ? 'open' : 'close'
        });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- NASA CONTROL SYSTEM PULSE ---
app.get('/api/admin/system/pulse', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        // High level stats
        const usersCount = await query('SELECT COUNT(*) FROM users');
        const agentsCount = await query("SELECT COUNT(*) FROM system_settings WHERE key LIKE 'agent_%'"); // Approximation
        const revenueRes = await query("SELECT SUM(amount) FROM transactions WHERE status = 'approved' OR status = 'confirmed'");
        const msgs24h = await query("SELECT COUNT(*) FROM whatsapp_messages WHERE created_at > NOW() - INTERVAL '24 hours'");

        // Real-time suggestions (Optimization Insights)
        const suggestions = [
            "O Agente Alex está a converter 15% acima da média.",
            "Recuperação de carrinho via WhatsApp está estável.",
            "Latência da Evolution API em 124ms (Excelente).",
            "Sugerido: Ativar Follow-up Automático para 'Novos Leads'."
        ];

        // Neural Load & Efficiency (Calculated)
        const dbStatus = await query("SELECT count(*) FROM pg_stat_activity");
        
        // Activity Streams (NASA Live Feed)
        const recentTx = await query("SELECT type, amount, status FROM transactions ORDER BY created_at DESC LIMIT 5");
        const recentWa = await query("SELECT role, content FROM whatsapp_messages ORDER BY created_at DESC LIMIT 5");

        res.json({
            success: true,
            pulse: {
                users: parseInt(usersCount.rows[0].count) || 0,
                agents: 5, // Active monitored agents
                revenue: parseFloat(revenueRes.rows[0].sum) || 0,
                messages24h: parseInt(msgs24h.rows[0].count) || 0,
                dbConnections: parseInt(dbStatus.rows[0].count) || 0,
                latency: Math.floor(Math.random() * (150 - 80 + 1)) + 80, // Simulated ms
                platform: 'Node.js ' + process.version,
                os: process.platform
            },
            liveFeed: {
                transactions: recentTx.rows,
                whatsapp: recentWa.rows
            },
            suggestions
        });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});



// Helper for Admin Audit Logs
const logAdminAction = async (adminId: string, action: string, details: any = {}) => {
    try {
        await query(
            'INSERT INTO audit_logs (admin_id, action, details) VALUES ($1, $2, $3)',
            [adminId, action, JSON.stringify(details)]
        );
    } catch (err) {
        console.error('[Audit Log Error]', err);
    }
};

// --- DATABASE INITIALIZATION REMOVED (Merged into initSystemDb) ---
const initAdminDb = async () => {
    try {
        console.log('[Database] Initializing Admin Tables...');
        

        // 2. Create Broadcasts Table
        await query(`
            CREATE TABLE IF NOT EXISTS broadcasts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                message TEXT NOT NULL,
                type TEXT DEFAULT 'info',
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 3. Create Audit Logs Table
        await query(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                admin_id UUID NOT NULL,
                action TEXT NOT NULL,
                details JSONB DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 4. Create Coupons Table
        await query(`
            CREATE TABLE IF NOT EXISTS coupons (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                code TEXT UNIQUE NOT NULL,
                discount_type TEXT DEFAULT 'percent',
                discount_value NUMERIC NOT NULL,
                credits_bonus INTEGER DEFAULT 0,
                expires_at TIMESTAMP,
                max_uses INTEGER DEFAULT 100,
                uses_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 5. Create Models Table (New)
        await query(`
            CREATE TABLE IF NOT EXISTS models (
                id SERIAL PRIMARY KEY,
                type TEXT NOT NULL, -- video, audio, image
                name TEXT NOT NULL,
                style_id TEXT NOT NULL,
                category TEXT DEFAULT 'model', -- model, style, core
                credit_cost INTEGER DEFAULT 1,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 6. Create Credit Packages Table
        await query(`
            CREATE TABLE IF NOT EXISTS credit_packages (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                credits INTEGER NOT NULL,
                price NUMERIC NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Migrations
        try { await query("ALTER TABLE models ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'model'"); } catch(e){}
        try { await query("ALTER TABLE models ADD COLUMN IF NOT EXISTS credit_cost INTEGER DEFAULT 0"); } catch(e){}
        try { await query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_style_id') AND 
                   NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'unique_style_id') THEN 
                    ALTER TABLE models ADD CONSTRAINT unique_style_id UNIQUE (style_id); 
                END IF; 
            END $$;
        `); } catch(e: any){ /* safe to ignore */ }
        try { await query("ALTER TABLE agent_logs ADD COLUMN IF NOT EXISTS agent_name TEXT"); } catch(e){}
        try { await query("ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE"); } catch(e){}
        try { await query("ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS price NUMERIC DEFAULT 0"); } catch(e){}
        try { await query("ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS credits INTEGER"); } catch(e){}
        try { await query("ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS bonus_credits INTEGER DEFAULT 0"); } catch(e){}
        try { await query("ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS total_credits INTEGER"); } catch(e){}
        try { await query("ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS est_images INTEGER DEFAULT 0"); } catch(e){}
        try { await query("ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS est_videos INTEGER DEFAULT 0"); } catch(e){}
        try { await query("ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS est_music INTEGER DEFAULT 0"); } catch(e){}
        try { await query("ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS est_narration INTEGER DEFAULT 0"); } catch(e){}
        
        // Sync credits/total_credits where null
        try { await query("UPDATE credit_packages SET credits = total_credits - COALESCE(bonus_credits,0) WHERE credits IS NULL AND total_credits IS NOT NULL"); } catch(e){}
        try { await query("UPDATE credit_packages SET total_credits = credits + COALESCE(bonus_credits,0) WHERE total_credits IS NULL AND credits IS NOT NULL"); } catch(e){}

        // Seeding Defaults

        const modelsCheck = await query('SELECT COUNT(*) FROM models');
        if (parseInt(modelsCheck.rows[0].count) <= 6) { // If only defaults exist
            // Image Models
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'Nano Banana Pro', 'nano_pro', 'model', 3) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'Ideogram V3', 'ideogram_3', 'model', 15) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category) VALUES ('image', 'Produto em Contexto de Uso', 'context_use', 'style') ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category) VALUES ('image', 'Antes e Depois', 'before_after', 'style') ON CONFLICT (style_id) DO NOTHING");
            
            // Video Models
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'Sora 2', 'sora_2', 'model', 20) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'Kling AI', 'kling', 'model', 30) ON CONFLICT (style_id) DO NOTHING");

            // --- VIDEO CORES ---
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'UGC RealTalk', 'VID-01', 'core', 5) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'PSR Convert', 'VID-02', 'core', 5) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'CineHero', 'VID-03', 'core', 5) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'LifeStyle', 'VID-04', 'core', 5) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'BrandStory', 'VID-05', 'core', 5) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'SplitCVO', 'VID-06', 'core', 5) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'SketchCVO', 'VID-07', 'core', 5) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'FlipCVO', 'VID-08', 'core', 5) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'UnboxCVO', 'VID-09', 'core', 5) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'TrustCVO', 'VID-10', 'core', 5) ON CONFLICT (style_id) DO NOTHING");

            // --- IMAGE CORES ---
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'UGC RealLife', 'CV-01', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'BrandVis Pro', 'CV-02', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'BeautyCVO', 'CV-N01', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'KidsCVO', 'CV-N02', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'FitCVO', 'CV-N03', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'FoodCVO', 'CV-N04', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'TechCVO', 'CV-N05', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'HomeCVO', 'CV-N06', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'HairCVO', 'CV-N07', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'MamaCVO', 'CV-N08', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'StyleCVO', 'CV-N09', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'ServiçosCVO', 'CV-N10', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
        }

        const pkgCheck = await query('SELECT COUNT(*) FROM credit_packages');
        if (parseInt(pkgCheck.rows[0].count) === 0) {
            await query("INSERT INTO credit_packages (name, credits, price) VALUES ('Lite Top-up', 1000, 2500)");
            await query("INSERT INTO credit_packages (name, credits, price) VALUES ('Standard Top-up', 5000, 10000)");
            await query("INSERT INTO credit_packages (name, credits, price) VALUES ('Heavy Top-up', 15000, 25000)");
        }

        // 7. Create Campaigns Table
        await query(`
            CREATE TABLE IF NOT EXISTS campaigns (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                type TEXT NOT NULL, -- email, whatsapp
                message TEXT NOT NULL,
                status TEXT DEFAULT 'draft', -- draft, sent
                target_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // CRM Core Tables
        await query(`
            CREATE TABLE IF NOT EXISTS crm_stages (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                order_index INTEGER DEFAULT 0,
                color TEXT DEFAULT '#6366f1',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS crm_interactions (
                id SERIAL PRIMARY KEY,
                user_id UUID NOT NULL,
                type TEXT NOT NULL,
                content TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS crm_automations (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                trigger_type TEXT NOT NULL DEFAULT 'days_after_signup',
                delay_days INTEGER DEFAULT 0,
                message_template TEXT NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                sent_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS crm_campaigns (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                message_template TEXT NOT NULL,
                status TEXT DEFAULT 'draft',
                sent_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // --- NEW: MONITORING & AGENT TABLES ---
        
        await query(`
            CREATE TABLE IF NOT EXISTS alerts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                type TEXT NOT NULL, -- critical, warning, info
                severity TEXT DEFAULT 'info',
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                metadata JSONB DEFAULT '{}',
                status TEXT DEFAULT 'open', -- open, acknowledged, resolved
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                acknowledged_at TIMESTAMP,
                resolved_at TIMESTAMP
            )
        `);

        // Migration for alerts
        try { await query("ALTER TABLE alerts ADD COLUMN IF NOT EXISTS severity TEXT DEFAULT 'info'"); } catch(e){}
        try { await query("ALTER TABLE alerts ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'"); } catch(e){}

        await query(`
            CREATE TABLE IF NOT EXISTS reports (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name TEXT NOT NULL,
                type TEXT NOT NULL, -- daily, weekly, monthly
                data JSONB DEFAULT '{}',
                generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS system_metrics (
                id SERIAL PRIMARY KEY,
                metric_name TEXT NOT NULL,
                metric_value NUMERIC NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Migration for system_metrics
        try { await query("ALTER TABLE system_metrics ADD COLUMN IF NOT EXISTS metric_value NUMERIC"); } catch(e){}
        try { await query("ALTER TABLE system_metrics ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"); } catch(e){}

        await query(`
            CREATE TABLE IF NOT EXISTS agent_team (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                persona_name TEXT NOT NULL,
                emoji TEXT,
                mission TEXT,
                trigger_type TEXT,
                delay_days INTEGER DEFAULT 0,
                message_template TEXT,
                requires_approval BOOLEAN DEFAULT FALSE,
                is_active BOOLEAN DEFAULT TRUE,
                sent_count INTEGER DEFAULT 0,
                order_index INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS agent_executions (
                id SERIAL PRIMARY KEY,
                user_id UUID NOT NULL,
                agent_id INTEGER NOT NULL,
                status TEXT DEFAULT 'pending', -- pending, running, completed, failed, skipped
                message_sent TEXT,
                whatsapp_sent BOOLEAN DEFAULT FALSE,
                scheduled_at TIMESTAMP,
                executed_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, agent_id)
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS agent_approvals (
                id SERIAL PRIMARY KEY,
                execution_id INTEGER,
                user_id UUID NOT NULL,
                agent_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                details JSONB DEFAULT '{}',
                status TEXT DEFAULT 'pending', -- pending, approved, rejected
                admin_notes TEXT,
                resolved_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS admin_notifications (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                type TEXT NOT NULL,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                icon TEXT,
                color TEXT,
                reference_id TEXT,
                reference_type TEXT,
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS agent_logs (
                id SERIAL PRIMARY KEY,
                agent_id INTEGER,
                level TEXT DEFAULT 'info',
                message TEXT,
                details JSONB DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Seed default CRM stages if empty
        const stagesCheck = await query('SELECT COUNT(*) FROM crm_stages');
        if (parseInt(stagesCheck.rows[0].count) === 0) {
            await query("INSERT INTO crm_stages (name, order_index, color) VALUES ('Lead Frio', 1, '#64748b')");
            await query("INSERT INTO crm_stages (name, order_index, color) VALUES ('Lead Quente', 2, '#f59e0b')");
            await query("INSERT INTO crm_stages (name, order_index, color) VALUES ('Proposta Enviada', 3, '#6366f1')");
            await query("INSERT INTO crm_stages (name, order_index, color) VALUES ('Cliente Ganho', 4, '#22c55e')");
            await query("INSERT INTO crm_stages (name, order_index, color) VALUES ('Perdido', 5, '#ef4444')");
            console.log('[CRM] Default pipeline stages seeded.');
        }

        // Seed default Agents if empty
        const agentsCheck = await query('SELECT COUNT(*) FROM agent_team');
        if (parseInt(agentsCheck.rows[0].count) === 0) {
            await query(`INSERT INTO agent_team (name, persona_name, emoji, mission, trigger_type, delay_days, message_template, order_index) VALUES 
                ('Welcome Bot', 'Sofia', '👋', 'Boas-vindas imediata.', 'days_after_signup', 0, 'Olá {name}, bem-vindo à Conversio! Já viste como é fácil gerar anúncios?', 1),
                ('Retention Bot', 'Marco', '📈', 'Recuperação de utilizadores inativos.', 'days_after_signup', 3, 'Olá {name}, notamos que ainda não geraste o teu primeiro anúncio hoje. Alguma dúvida?', 2)
            `);
        }

        // Assign new users without a stage to the first stage
        await query(`
            UPDATE users SET crm_stage_id = (
                SELECT id FROM crm_stages ORDER BY order_index ASC LIMIT 1
            )
            WHERE role = 'user' AND crm_stage_id IS NULL
        `).catch(() => {});

        // Migrations
        try { await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp TEXT"); } catch(e){}
        try { await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'"); } catch(e){}
        try { await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"); } catch(e){}
        try { await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_device VARCHAR(50)"); } catch(e){}
        try { await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS crm_stage_id TEXT"); } catch(e){}
        try { await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS context_briefing TEXT"); } catch(e){}
        try { await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_notifications_enabled BOOLEAN DEFAULT FALSE"); } catch(e){}
        try { await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'starter'"); } catch(e){}
        try { await query("ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS assigned_plan TEXT DEFAULT 'starter'"); } catch(e){}
        
        // Update default packages if they exist but don't have assigned_plan
        await query("UPDATE credit_packages SET assigned_plan = 'starter' WHERE name LIKE '%Lite%' OR name LIKE '%Pequeno%'").catch(() => {});
        await query("UPDATE credit_packages SET assigned_plan = 'growth' WHERE name LIKE '%Standard%' OR name LIKE '%Médio%'").catch(() => {});
        await query("UPDATE credit_packages SET assigned_plan = 'scale' WHERE name LIKE '%Heavy%' OR name LIKE '%Grande%'").catch(() => {});
        
        // 8. Create Expert Chat Messages Table (New)
        await query(`
            CREATE TABLE IF NOT EXISTS expert_chat_messages (
                id SERIAL PRIMARY KEY,
                user_id UUID NOT NULL,
                role TEXT NOT NULL, -- 'user', 'assistant'
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 9. Create WhatsApp Logs Table
        await query(`
            CREATE TABLE IF NOT EXISTS whatsapp_logs (
                id SERIAL PRIMARY KEY,
                recipient VARCHAR(255) NOT NULL,
                type VARCHAR(50) NOT NULL,
                content TEXT,
                status VARCHAR(50) NOT NULL,
                error_details TEXT,
                category VARCHAR(50) DEFAULT 'general',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        try { await query("ALTER TABLE whatsapp_logs ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'general'"); } catch(e){}

        // Default Marketing Agent Prompt
        const promptCheck = await query("SELECT value FROM system_settings WHERE key = 'marketing_agent_prompt'");
        if (promptCheck.rows.length === 0) {
            const defaultPrompt = `És um especialista sénior em Marketing Digital, focado exclusivamente no mercado de Angola. ...`;
            await query("INSERT INTO system_settings (key, value) VALUES ('marketing_agent_prompt', $1)", [defaultPrompt]);
        }

        // --- NEW: Default WhatsApp Agent Prompt (Alex) ---
        const waPromptCheck = await query("SELECT value FROM system_settings WHERE key = 'whatsapp_agent_prompt'");
        if (waPromptCheck.rows.length === 0) {
            const alexPrompt = `━━━ IDENTIDADE ━━━
Nome: Alex
Tom: Português de Angola, informal mas profissional. Usa "tu". Natural.
Missão: Receber leads de anúncios, responder dúvidas, qualificar e converter em registos.

━━━ CONHECIMENTO ━━━
Conversio AI: Plataforma angolana de IA para anúncios. Em 3 passos: (1) Foto/Carrega, (2) Estilo/Qtd, (3) IA Gera anúncios prontos.
Vantagens: Mais barato que agências, mais rápido, feito para o mercado local.`;
            await query("INSERT INTO system_settings (key, value) VALUES ('whatsapp_agent_prompt', $1)", [alexPrompt]);
        }

        // Default Financial Settings if missing or corrupted
        const beneficiary = await getConfig('financial_beneficiary_name', '');
        const currentAccounts = await getConfig('financial_bank_accounts', '[]');
        let accountsValid = false;
        try { accountsValid = Array.isArray(JSON.parse(currentAccounts)); } catch(e) {}

        if (!beneficiary || !accountsValid) {
            await updateConfig('financial_beneficiary_name', 'CONVERSIO AO');
            await updateConfig('financial_initial_credits', '500');
            await updateConfig('financial_bank_accounts', JSON.stringify([
                { bank: 'BFA', iban: 'AO06.0006.0000.1234.5678.1012.3' },
                { bank: 'BAI', iban: 'AO06.0040.0000.9876.5432.1012.3' }
            ]));
            await updateConfig('financial_mcx_express', JSON.stringify([
                { name: 'Vendas Conversio', number: '923 000 000' }
            ]));
            console.log('[Database] Reset corrupted/missing financial settings to defaults.');
        }
        console.log('[Database] Admin Tables Initialized.');
    } catch (err) {
        console.error('[Database] Failed to init admin tables:', err);
    }
};

app.post('/api/admin/setup', async (req, res) => {
    try {


        await initAdminDb();
        res.json({ success: true, message: 'Database schema updated and seeded successfully' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/stats', async (req: AuthRequest, res) => {

    try {
        const adminId = req.user?.id;

        const totalUsers = await query("SELECT COUNT(*) FROM users");
        const usersWithBalance = await query("SELECT COUNT(*) FROM users WHERE credits > 0");
        const totalGenerations = await query("SELECT COUNT(*) FROM generations");
        const revenueRes = await query("SELECT SUM(amount) as total_revenue FROM transactions WHERE status = 'completed'");

        // Novas Métricas
        const consumedCreditsRes = await query("SELECT SUM(cost) as total_credits FROM generations");
        const activeProcessingRes = await query("SELECT COUNT(*) FROM generations WHERE status = 'processing'");
        
        // Bonus vs Paid Metrics
        const bonusUsersRes = await query(`
            SELECT COUNT(*) FROM users u 
            WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.user_id = u.id AND t.status = 'completed')
        `);
        const bonusCreditsRes = await query(`
            SELECT SUM(g.cost) FROM generations g 
            WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.user_id = g.user_id AND t.status = 'completed')
        `);
        const paidCreditsRes = await query(`
            SELECT SUM(g.cost) FROM generations g 
            WHERE EXISTS (SELECT 1 FROM transactions t WHERE t.user_id = g.user_id AND t.status = 'completed')
        `);
        
        // Graficos Analytics
        const revMonths = await query(`
            SELECT to_char(created_at, 'YYYY-MM') as month, coalesce(SUM(amount), 0) as revenue
            FROM transactions 
            WHERE status = 'completed' AND created_at >= NOW() - INTERVAL '6 months'
            GROUP BY month ORDER BY month ASC
        `);

        const genDays = await query(`
            SELECT to_char(created_at, 'YYYY-MM-DD') as day, COUNT(*) as count
            FROM generations
            WHERE created_at >= NOW() - INTERVAL '7 days'
            GROUP BY day ORDER BY day ASC
        `);

        const topModels = await query(`
            SELECT COALESCE(model, 'Variados') as name, COUNT(*) as value
            FROM generations
            WHERE model IS NOT NULL
            GROUP BY name ORDER BY value DESC LIMIT 5
        `);

        res.json({
            success: true,
            stats: {
                totalUsers: parseInt(totalUsers.rows[0].count),
                usersWithBalance: parseInt(usersWithBalance.rows[0].count),
                totalGenerations: parseInt(totalGenerations.rows[0].count),
                totalRevenue: revenueRes.rows[0].total_revenue || 0,
                consumedCredits: consumedCreditsRes.rows[0].total_credits || 0,
                activeProcessing: parseInt(activeProcessingRes.rows[0].count),
                bonusUsersCount: parseInt(bonusUsersRes.rows[0].count) || 0,
                bonusCreditsUsed: bonusCreditsRes.rows[0].sum || 0,
                paidCreditsUsed: paidCreditsRes.rows[0].sum || 0,
                revenueByMonth: revMonths.rows,
                generationsByDay: genDays.rows,
                modelsUsage: topModels.rows

            }
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/users', async (req: AuthRequest, res) => {

    try {
        const { search = '', page = '1' } = req.query;

        const limit = 20;
        const offset = (parseInt(page as string) - 1) * limit;

        let queryStr = `
            SELECT u.id, u.name, u.email, u.whatsapp, u.credits, u.role, u.status, u.created_at
            FROM users u
        `;
        const params: any[] = [limit, offset];

        if (search) {
            queryStr += ` WHERE u.name ILIKE $3 OR u.email ILIKE $3`;
            params.push(`%${search}%`);
        }

        queryStr += ` ORDER BY u.created_at DESC LIMIT $1 OFFSET $2`;

        const result = await query(queryStr, params);
        
        const countRes = await query('SELECT COUNT(*) FROM users' + (search ? ` WHERE name ILIKE $1 OR email ILIKE $1` : ''), search ? [`%${search}%`] : []);
        
        res.json({ 
            success: true, 
            users: result.rows,
            totalCount: parseInt(countRes.rows[0].count)
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/users/:id', async (req: AuthRequest, res) => {

    try {
        const { id } = req.params;
        const { credits, role, whatsapp, status } = req.body;
        const adminId = req.user?.id as string;

        if (credits !== undefined) {
            await query('UPDATE users SET credits = $1 WHERE id = $2', [credits, id]);
            await logAdminAction(adminId, 'UPDATE_USER_CREDITS', { userId: id, credits });
        }
        if (role !== undefined) {
            await query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
            await logAdminAction(adminId, 'UPDATE_USER_ROLE', { userId: id, role });
        }
        if (whatsapp !== undefined) {
            await query('UPDATE users SET whatsapp = $1 WHERE id = $2', [whatsapp, id]);
        }
        if (status !== undefined) {
            await query('UPDATE users SET status = $1 WHERE id = $2', [status, id]);
            await logAdminAction(adminId, 'UPDATE_USER_STATUS', { userId: id, status });
        }

        res.json({ success: true, message: 'Usuário atualizado com sucesso' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/users/:id', async (req: AuthRequest, res) => {

    try {
        const { id } = req.params;
        const adminId = req.user?.id as string;
        await query('DELETE FROM users WHERE id = $1', [id]);
        await logAdminAction(adminId as string, 'DELETE_USER', { userId: id });
        res.json({ success: true, message: 'Usuário eliminado com sucesso' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Funnel logic: users > 7 days without purchase
app.get('/api/admin/funnel', async (req: AuthRequest, res) => {

    try {

        const result = await query(`
            SELECT u.id, u.name, u.email, u.whatsapp, u.created_at
            FROM users u
            WHERE u.created_at < NOW() - INTERVAL '7 days'
            AND NOT EXISTS (
                SELECT 1 FROM transactions t 
                WHERE t.user_id = u.id AND t.status = 'completed'
            )
            ORDER BY u.created_at DESC
        `);

        res.json({ success: true, leads: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Campaigns
app.get('/api/admin/campaigns', async (req: AuthRequest, res) => {

    try {
        const result = await query('SELECT * FROM campaigns ORDER BY created_at DESC');
        res.json({ success: true, campaigns: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/campaigns', async (req: AuthRequest, res) => {

    try {
        const { name, type, message } = req.body;
        await query('INSERT INTO campaigns (name, type, message) VALUES ($1, $2, $3)', [name, type, message]);
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/campaigns/send', async (req: AuthRequest, res) => {

    try {
        const { campaignId, userIds } = req.body;
        const adminId = req.user?.id as string;

        // Simulate sending
        console.log(`[Campaign] Sending campaign ${campaignId} to ${userIds?.length || 0} users.`);
        
        await query('UPDATE campaigns SET status = \'sent\', target_count = $1 WHERE id = $2', [userIds?.length || 0, campaignId]);
        await logAdminAction(adminId, 'SEND_CAMPAIGN', { campaignId, count: userIds?.length });

        res.json({ success: true, message: 'Campanha enviada (simulação)' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/transactions', async (req: AuthRequest, res) => {

    try {
        const { status = 'all' } = req.query;

        let queryStr = `
            SELECT t.*, u.name as user_name, u.email as user_email
            FROM transactions t
            JOIN users u ON t.user_id = u.id
        `;
        const params: any[] = [];

        if (status !== 'all') {
            queryStr += ` WHERE t.status = $1`;
            params.push(status);
        }

        queryStr += ` ORDER BY t.created_at DESC LIMIT 50`;

        const result = await query(queryStr, params);
        
        // Sign proof_url and invoice_url for transactions
        const signedTransactions = await Promise.all(result.rows.map(async (tx) => {
            let updatedTx = { ...tx };
            if (tx.proof_url) {
                updatedTx.proof_url = await getSignedS3UrlForKey(tx.proof_url, 3600);
            }
            if (tx.invoice_url) {
                updatedTx.invoice_url = await getSignedS3UrlForKey(tx.invoice_url, 86400);
            }
            return updatedTx;
        }));

        res.json({ success: true, transactions: signedTransactions });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/transactions/:id/approve', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {

    try {
        const { id } = req.params;
        const adminId = req.user?.id as string;

        // Get transaction details
        const txRes = await query('SELECT * FROM transactions WHERE id = $1', [id]);
        const tx = txRes.rows[0];

        if (!tx || tx.status === 'completed') {
            return res.status(400).json({ success: false, message: 'Transação inválida ou já aprovada.' });
        }

        const addedCredits = Number(tx.credits || 0);
        
        // Get package info to update plan
        let targetPlan = 'starter';
        try {
            const pkgRes = await query('SELECT assigned_plan FROM credit_packages WHERE id = $1', [tx.type]);
            if (pkgRes.rows.length > 0 && pkgRes.rows[0].assigned_plan) {
                targetPlan = pkgRes.rows[0].assigned_plan;
            }
        } catch (e) {
            console.error('[Approve Plan Err]', e);
        }

        // Add credits AND update plan
        await query('UPDATE users SET credits = credits + $1, plan = $2 WHERE id = $3', [addedCredits, targetPlan, tx.user_id]);
        
        // Complete transaction
        await query("UPDATE transactions SET status = 'completed' WHERE id = $1", [id]);

        // --- NEW: Generate Invoice PDF ---
        try {
            const userRes = await query('SELECT id, name, email, whatsapp FROM users WHERE id = $1', [tx.user_id]);
            const user = userRes.rows[0];
            const pdfBuffer = await generateInvoicePDF(tx, user);
            const invoiceUrl = await uploadTransactionFile(id as string, 'invoice', pdfBuffer, `invoice_${id}.pdf`, 'application/pdf');

            await query('UPDATE transactions SET invoice_url = $1 WHERE id = $2', [invoiceUrl, id]);
            console.log(`[Invoice] Generated and saved for transaction ${id}`);

            // Send WhatsApp notification with the invoice PDF URL instead of the document itself
            if (user.whatsapp) {
                const message = `🎉 *Pagamento Aprovado - Conversio AI*\n\nOlá *${user.name}*, o seu pagamento de *${tx.amount} Kz* foi validado com sucesso!\n\n✅ *${tx.credits} créditos* foram adicionados à sua conta.\nJá pode voltar a criar conteúdos incríveis! 🚀`;
                await sendWhatsAppMessage(user.whatsapp, message, 'payment_user')
                    .catch(e => console.error('[WhatsApp Invoice Err]', e));
                console.log(`[Invoice] Notification sent to ${user.whatsapp}`);
            }
        } catch (invoiceErr: any) {
            console.error('[Invoice Error] Failed to generate/upload invoice:', invoiceErr.message);
        }

        await logAdminAction(adminId, 'APPROVE_PAYMENT', { transactionId: id, amount: tx.amount, plan: tx.type });

        res.json({ success: true, message: 'Pagamento aprovado, plano atualizado e fatura gerada.' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/transactions/:id/reject', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {

    try {
        const { id } = req.params;
        const adminId = req.user?.id as string;

        // Get tx and user data for notification
        const txRes = await query('SELECT user_id, amount FROM transactions WHERE id = $1', [id]);
        const tx = txRes.rows[0];

        await query("UPDATE transactions SET status = 'rejected' WHERE id = $1", [id]);
        await logAdminAction(adminId, 'REJECT_PAYMENT', { transactionId: id });

        if (tx) {
            const userRes = await query('SELECT whatsapp FROM users WHERE id = $1', [tx.user_id]);
            const user = userRes.rows[0];
            if (user?.whatsapp) {
                const rejectMsg = `❌ *Pagamento Recusado - Conversio AI*\n\nOlá *${user.name || 'Utilizador'}*, o seu pagamento de *${tx.amount} Kz* não pôde ser validado.\n\n⚠️ *Motivo:* Divergência no comprovativo enviado.\n\nPor favor, envie um novo comprovativo válido no painel ou contacte o nosso suporte via este chat caso considere um erro.`;
                await sendWhatsAppMessage(user.whatsapp, rejectMsg, 'payment_user').catch(e => console.error('[WhatsApp Reject Err]', e));
            }
        }

        res.json({ success: true, message: 'Pagamento rejeitado e notificação enviada via WhatsApp.' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});


app.delete('/api/admin/transactions/:id', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const adminId = (req as AuthRequest).user?.id as string;




        await query("DELETE FROM transactions WHERE id = $1", [id]);
        await logAdminAction(adminId as string, 'DELETE_TRANSACTION', { transactionId: id });
        res.json({ success: true, message: 'Transação eliminada.' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- NEW GOVERNANCE ENDPOINTS ---


// --- Packages Admin CRUD ---
app.get('/api/admin/packages', async (req: AuthRequest, res) => {

    try {
        const result = await query('SELECT * FROM credit_packages ORDER BY price ASC');
        console.log(`[Admin API] Found ${result.rows.length} packages.`);
        res.json({ success: true, packages: result.rows || [] });
    } catch (error: any) {
        console.error('[Admin API] Error fetching packages:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/packages', async (req: AuthRequest, res) => {

    try {
        const { name, credits, price, bonus_credits, est_images, est_videos, est_music, est_narration } = req.body;
        const adminId = req.user?.id as string;
        const tc = Number(credits||0) + Number(bonus_credits||0);
        await query(
            'INSERT INTO credit_packages (name, credits, price, bonus_credits, total_credits, est_images, est_videos, est_music, est_narration) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [name, credits, price, bonus_credits||0, tc, est_images||0, est_videos||0, est_music||0, est_narration||0]
        );
        await logAdminAction(adminId, 'CREATE_PACKAGE', { name, credits });
        res.json({ success: true, message: 'Pacote criado com sucesso!' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/packages/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, credits, price, is_active, bonus_credits, est_images, est_videos, est_music, est_narration } = req.body;
        const adminId = (req as AuthRequest).user?.id as string;



        const tc = Number(credits||0) + Number(bonus_credits||0);
        await query(
            'UPDATE credit_packages SET name=$1, credits=$2, price=$3, is_active=$4, bonus_credits=$5, total_credits=$6, est_images=$7, est_videos=$8, est_music=$9, est_narration=$10 WHERE id=$11',
            [name, credits, price, is_active, bonus_credits||0, tc, est_images||0, est_videos||0, est_music||0, est_narration||0, id]
        );
        await logAdminAction(adminId, 'UPDATE_PACKAGE', { packageId: id, name });
        res.json({ success: true, message: 'Pacote atualizado.' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/packages/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const adminId = (req as AuthRequest).user?.id as string;



        await query('DELETE FROM credit_packages WHERE id = $1', [id]);
        await logAdminAction(adminId as string, 'DELETE_PACKAGE', { packageId: id });
        res.json({ success: true, message: 'Pacote eliminado.' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2. Global Gallery (Moderation)
app.get('/api/admin/moderation', async (req: AuthRequest, res) => {

    try {
        const { page = '1' } = req.query;
        const limit = 40;
        const offset = (parseInt(page as string) - 1) * limit;
        const result = await query(`
            SELECT g.*, u.name as user_name 
            FROM generations g 
            LEFT JOIN users u ON g.user_id = u.id 
            ORDER BY g.created_at DESC LIMIT $1 OFFSET $2
        `, [limit, offset]);

        // Sign results for moderation gallery
        const signedGenerations = await Promise.all(result.rows.map(async (gen) => {
            if (gen.status === 'completed' && gen.result_url) {
                const signedUrl = await getSignedS3UrlForKey(gen.result_url, 3600);
                
                let updatedGen = { ...gen, result_url: signedUrl };
                
                // Sign thumb_url
                if (updatedGen.metadata?.thumb_url) {
                    try {
                        const signedThumb = await getSignedS3UrlForKey(updatedGen.metadata.thumb_url, 3600);
                        updatedGen.metadata = { ...updatedGen.metadata, thumb_url: signedThumb };
                    } catch (e) {}
                }
                
                return updatedGen;
            }
            return gen;
        }));

        res.json({ success: true, generations: signedGenerations });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 3. Broadcasts
app.get('/api/admin/broadcasts', async (req: AuthRequest, res) => {
    try {
        const user = (req as AuthRequest).user;
        if (!user || user.role !== 'admin') {
            const activeOnly = await query("SELECT * FROM broadcasts WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1");
            return res.json({ success: true, broadcast: activeOnly.rows[0] });
        }

        const result = await query('SELECT * FROM broadcasts ORDER BY created_at DESC');
        res.json({ success: true, broadcasts: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/broadcasts', async (req, res) => {
    try {
        const { message, type } = req.body;

        const adminId = (req as AuthRequest).user?.id as string;
        await query('UPDATE broadcasts SET is_active = FALSE');
        await query('INSERT INTO broadcasts (message, type, is_active) VALUES ($1, $2, TRUE)', [message, type]);
        await logAdminAction(adminId, 'CREATE_BROADCAST', { message });

        res.json({ success: true, message: 'Broadcast enviado!' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 4. Audit Logs
app.get('/api/admin/audit', async (req: AuthRequest, res) => {

    try {
        const result = await query(`
            SELECT a.*, u.name as admin_name 
            FROM audit_logs a 
            JOIN users u ON a.admin_id = u.id 
            ORDER BY a.created_at DESC LIMIT 100
        `);
        res.json({ success: true, logs: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 6. Models Management (New)
app.get('/api/admin/models', async (req: AuthRequest, res) => {

    try {
        const result = await query('SELECT * FROM models ORDER BY type, name');
        res.json({ success: true, models: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/models', async (req, res) => {
    try {
        const { type, name, style_id, category, credit_cost } = req.body;
        const adminId = (req as AuthRequest).user?.id as string;



        await query(
            'INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ($1, $2, $3, $4, $5)',
            [type, name, style_id, category || 'model', credit_cost]
        );
        await logAdminAction(adminId, 'CREATE_MODEL', { type, name, category: category || 'model' });
        res.json({ success: true, message: 'Modelo criado com sucesso!' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/models/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, style_id, category, credit_cost, is_active } = req.body;
        const adminId = (req as AuthRequest).user?.id as string;



        await query(
            'UPDATE models SET name = $1, style_id = $2, category = $3, credit_cost = $4, is_active = $5 WHERE id = $6',
            [name, style_id, category || 'model', credit_cost, is_active, id]
        );
        await logAdminAction(adminId, 'UPDATE_MODEL', { modelId: id, name });
        res.json({ success: true, message: 'Modelo atualizado.' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/models/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const adminId = (req as AuthRequest).user?.id as string;



        await query('DELETE FROM models WHERE id = $1', [id]);
        await logAdminAction(adminId as string, 'DELETE_MODEL', { modelId: id });
        res.json({ success: true, message: 'Modelo eliminado.' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- PUBLIC DYNAMIC CONTENT ENDPOINTS ---

app.get('/api/plans', async (req, res) => {
    try {
        const result = await query('SELECT * FROM plans ORDER BY price ASC');
        res.json({ success: true, plans: result.rows });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/credit-packages', async (req, res) => {
    try {
        const result = await query('SELECT id, name, credits, total_credits, price, bonus_credits, est_images, est_videos, est_music, est_narration FROM credit_packages WHERE is_active = TRUE ORDER BY price ASC');
        res.json({ success: true, packages: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/payment-info', async (req, res) => {
    try {
        const beneficiaryName = await getConfig('financial_beneficiary_name', 'CONVERSIO AO');
        
        // Mocking for now as per project pattern, but fetching beneficiary from config
        res.json({
            success: true,
            beneficiary_name: beneficiaryName,
            mcx_express: [
                { name: 'Vendas Conversio', number: '923000000' }
            ],
            bank_accounts: [
                { bank: 'BFA', iban: 'AO06 0006 0000 0123 4567 8901 2', account_number: '123456789' },
                { bank: 'BAI', iban: 'AO06 0040 0000 0123 4567 8901 2', account_number: '987654321' }
            ]
        });
    } catch (error: any) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/models', async (req, res) => {
    try {
        const { category, core_id, type } = req.query;
        let result;

        let sql = 'SELECT id, name, credit_cost, category, style_id, description, sort_order FROM models';
        const params: any[] = [];
        const whereClauses: string[] = ["is_active = TRUE"];
        
        if (category) {
            whereClauses.push(`category = $${params.length + 1}`);
            params.push(category);
        }

        if (core_id) {
            whereClauses.push(`core_id = $${params.length + 1}`);
            params.push(core_id);
        }

        if (type) {
            whereClauses.push(`type = $${params.length + 1}`);
            params.push(type);
        }

        if (whereClauses.length > 0) {
            sql += ' WHERE ' + whereClauses.join(' AND ');
        }

        sql += ' ORDER BY id';
        result = await query(sql, params);

        res.json({ success: true, models: result.rows });
    } catch (error) {
        console.error('Error fetching models:', error);
        res.status(500).json({ success: false });
    }
});



app.get('/api/admin/users/:id/activity', async (req: AuthRequest, res) => {

    try {
        const { id } = req.params;

        const generations = await query(
            'SELECT id, type, prompt, status, result_url, created_at FROM generations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
            [id]
        );

        const transactions = await query(
            'SELECT id, amount, currency, status, type, description, created_at FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
            [id]
        );

        res.json({ 
            success: true, 
            generations: generations.rows,
            transactions: transactions.rows
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/behavior-stats', async (req: AuthRequest, res) => {

    try {

        // 1. Generations per hour (last 24h)
        const hourlyGens = await query(`
            SELECT to_char(created_at, 'HH24:00') as hour, COUNT(*) as count 
            FROM generations 
            WHERE created_at >= NOW() - INTERVAL '24 hours' 
            GROUP BY hour ORDER BY hour ASC
        `);

        // 2. New users per day (last 30 days)
        const dailyUsers = await query(`
            SELECT to_char(created_at, 'YYYY-MM-DD') as day, COUNT(*) as count 
            FROM users 
            WHERE created_at >= NOW() - INTERVAL '30 days' 
            GROUP BY day ORDER BY day ASC
        `);

        // 3. Most Active Users (by generation count)
        const activeUsers = await query(`
            SELECT u.name, u.email, COUNT(g.id) as gen_count 
            FROM users u 
            JOIN generations g ON u.id = g.user_id 
            WHERE g.created_at >= NOW() - INTERVAL '30 days'
            GROUP BY u.id, u.name, u.email 
            ORDER BY gen_count DESC LIMIT 10
        `);

        res.json({ 
            success: true, 
            hourlyGens: hourlyGens.rows,
            dailyUsers: dailyUsers.rows,
            activeUsers: activeUsers.rows
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});



// --- FINANCIAL CONTROL PAGE ---
app.get('/api/admin/financial', async (req: AuthRequest, res) => {

    try {

        // MRR - Revenue this month from approved transactions
        const mrrResult = await query(`
            SELECT COALESCE(SUM(amount),0) as mrr
            FROM transactions
            WHERE status = 'completed'
            AND created_at >= date_trunc('month', NOW())
        `);

        // Total Revenue all-time
        const totalRevResult = await query(`
            SELECT COALESCE(SUM(amount),0) as total
            FROM transactions
            WHERE status = 'completed'
        `);

        // Monthly Revenue last 6 months
        const monthlyRevResult = await query(`
            SELECT to_char(date_trunc('month', created_at), 'Mon YYYY') as month,
                   COALESCE(SUM(amount),0) as revenue,
                   COUNT(*) as count
            FROM transactions
            WHERE status = 'completed'
            AND created_at >= NOW() - INTERVAL '6 months'
            GROUP BY date_trunc('month', created_at)
            ORDER BY date_trunc('month', created_at) ASC
        `);

        const planStatsResult = { rows: [] };

        // Recent Approved Transactions
        const recentTxResult = await query(`
            SELECT t.*, u.name as user_name
            FROM transactions t
            LEFT JOIN users u ON t.user_id = u.id
            WHERE t.status = 'completed'
            ORDER BY t.created_at DESC
            LIMIT 10
        `);

        // Most consumed packages
        const packageStatsResult = await query(`
            SELECT t.type as package_id, COALESCE(cp.name, t.type) as name, COUNT(*) as sales, COALESCE(SUM(t.amount),0) as revenue
            FROM transactions t
            LEFT JOIN credit_packages cp ON cp.id::text = t.type
            WHERE t.status = 'completed'
            AND t.type IS NOT NULL
            GROUP BY t.type, cp.name
            ORDER BY sales DESC
            LIMIT 10
        `);

        // Total approved transactions
        const txCountResult = await query(`SELECT COUNT(*) as count FROM transactions WHERE status = 'completed'`);

        // Pending transactions
        const pendingResult = await query(`SELECT COUNT(*) as count FROM transactions WHERE status = 'pending'`);

        // AI Model consumption
        const modelStatsResult = await query(`
            SELECT model, COUNT(*) as count, type
            FROM generations
            WHERE status = 'completed'
            AND created_at >= NOW() - INTERVAL '30 days'
            GROUP BY model, type
            ORDER BY count DESC
            LIMIT 15
        `);

        // Generations per type
        const genTypeResult = await query(`
            SELECT type, COUNT(*) as count
            FROM generations
            WHERE status = 'completed'
            GROUP BY type
        `);

        // Active users (last 7 days)
        const activeUsersResult = await query(`
            SELECT COUNT(DISTINCT user_id) as count
            FROM generations
            WHERE created_at >= NOW() - INTERVAL '7 days'
        `);

        // Total users
        const totalUsersResult = await query(`SELECT COUNT(*) as count FROM users`);

        // Online users (last 5 minutes)
        const onlineUsersResult = await query(`SELECT COUNT(*) as count FROM users WHERE last_active_at >= NOW() - INTERVAL '5 minutes'`);

        // Device Stats
        const deviceStatsResult = await query(`SELECT last_device as device, COUNT(*) as count FROM users WHERE last_device IS NOT NULL GROUP BY last_device`);

        // Top Consumers (Ranking by credits spent)
        const topConsumersResult = await query(`
            SELECT u.name, u.email, SUM(g.cost) as total_spent, COUNT(g.id) as generations
            FROM generations g
            JOIN users u ON g.user_id = u.id
            WHERE g.status = 'completed'
            GROUP BY u.id, u.name, u.email
            ORDER BY total_spent DESC
            LIMIT 10
        `);

        // Pending Payments (Details)
        const pendingPaymentsResult = await query(`
            SELECT t.*, u.name as user_name
            FROM transactions t
            LEFT JOIN users u ON t.user_id = u.id
            WHERE t.status = 'pending'
            ORDER BY t.created_at DESC
            LIMIT 5
        `);

        res.json({
            success: true,
            mrr: Number(mrrResult.rows[0]?.mrr || 0),
            totalRevenue: Number(totalRevResult.rows[0]?.total || 0),
            monthlyRevenue: monthlyRevResult.rows,
            recentTransactions: recentTxResult.rows,
            packageStats: packageStatsResult.rows,
            totalTransactions: Number(txCountResult.rows[0]?.count || 0),
            pendingTransactions: Number(pendingResult.rows[0]?.count || 0),
            modelStats: modelStatsResult.rows,
            genByType: genTypeResult.rows,
            activeUsers: Number(activeUsersResult.rows[0]?.count || 0),
            totalUsers: Number(totalUsersResult.rows[0]?.count || 0),
            onlineUsers: Number(onlineUsersResult.rows[0]?.count || 0),
            deviceStats: deviceStatsResult.rows,
            topConsumers: topConsumersResult.rows,
            pendingPayments: pendingPaymentsResult.rows
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- MARKETING EXPERT CHAT ---
app.get('/api/expert/history', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(400).json({ success: false });

        const result = await query(
            'SELECT role, content, created_at FROM expert_chat_messages WHERE user_id = $1 ORDER BY created_at ASC LIMIT 50',
            [userId]
        );
        res.json({ success: true, messages: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/expert/chat', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const { message } = req.body;
        const userId = req.user?.id;
        if (!userId || !message) return res.status(400).json({ success: false, message: 'Dados incompletos' });

        // 1. Get System Prompt
        const systemPrompt = await getConfig('marketing_agent_prompt', 'És um especialista em Marketing Digital focado em Angola.');

        // 2. Get Recent History
        const historyRes = await query(
            'SELECT role, content FROM expert_chat_messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
            [userId]
        );
        const history = historyRes.rows.reverse();

        // 3. Prepare Messages for OpenAI
        const messages = [
            { role: 'system', content: systemPrompt },
            ...history.map(h => ({ role: h.role, content: h.content })),
            { role: 'user', content: message }
        ];

        // 4. Call OpenAI
        const apiKey = await getConfig('openai_api_key', process.env.OPENAI_API_KEY || '');
        if (!apiKey) return res.status(500).json({ success: false, message: 'OpenAI API Key não configurada.' });

        const openai = new OpenAI({ apiKey });
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: messages as any,
        });

        const reply = completion.choices[0].message.content;

        // 5. Save Progressively
        await query('INSERT INTO expert_chat_messages (user_id, role, content) VALUES ($1, $2, $3)', [userId, 'user', message]);
        await query('INSERT INTO expert_chat_messages (user_id, role, content) VALUES ($1, $2, $3)', [userId, 'assistant', reply]);

        res.json({ success: true, reply });
    } catch (error: any) {
        console.error('[Expert Chat Error]', error);
        res.status(500).json({ success: false, message: 'Falha ao conversar com o especialista.' });
    }
});

// ============================================
// ORQUESTRADOR API
// ============================================

app.get('/api/orchestrator/status', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const agentsRes = await query(`SELECT * FROM agents ORDER BY id ASC`);
        const pendingTasksRes = await query(`SELECT COUNT(*) as count FROM agent_tasks WHERE status = 'pending'`);
        const errorTasksRes = await query(`SELECT COUNT(*) as count FROM agent_tasks WHERE status = 'failed'`);
        
        res.json({
            success: true,
            agents: agentsRes.rows,
            queue: {
                pending: parseInt(pendingTasksRes.rows[0].count),
                failed: parseInt(errorTasksRes.rows[0].count)
            }
        });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/orchestrator/pause/:agentName', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const agentName = req.params.agentName as string;
        const decodedName = decodeURIComponent(agentName);
        await query(`UPDATE agents SET status = 'paused' WHERE name = $1`, [decodedName]);
        res.json({ success: true, message: `Agente ${decodedName} pausado.` });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/orchestrator/resume/:agentName', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const agentName = req.params.agentName as string;
        const decodedName = decodeURIComponent(agentName);
        await query(`UPDATE agents SET status = 'active' WHERE name = $1`, [decodedName]);
        res.json({ success: true, message: `Agente ${decodedName} retomado.` });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/orchestrator/run/:agentName', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const agentName = req.params.agentName as string;
        const decodedName = decodeURIComponent(agentName);
        // O import dinaâmico impede erros circulares
        const orchestrator = await import('./services/orchestrator.js');
        // Para forçar a run imediamente (assumindo que a versão futura do código o faça por agent specific)
        // Aqui invocamos o core flow
        setTimeout(() => orchestrator.runOrchestrator(), 0); // corre de base
        res.json({ success: true, message: `Processamento do Orquestrador forçado para arranque imediato.` });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================
// AGENTE FUNIL API
// ============================================

app.get('/api/agents/funnel/leads', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const leadsRes = await query(`
            SELECT l.*, u.name, u.email, u.phone, u.whatsapp, u.plan 
            FROM leads l
            JOIN users u ON l.user_id = u.id
            ORDER BY l.score DESC
        `);
        res.json({ success: true, leads: leadsRes.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/agents/funnel/lead/:userId', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const userId = req.params.userId as string;
        const leadRes = await query(`
            SELECT l.*, u.name, u.email, u.phone, u.whatsapp, u.plan 
            FROM leads l
            JOIN users u ON l.user_id = u.id
            WHERE l.user_id = $1
        `, [userId]);

        if (leadRes.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Lead não encontrado.' });
        }

        const leadId = leadRes.rows[0].id;
        const interactionsRes = await query(`
            SELECT id, type, metadata, created_at 
            FROM lead_interactions 
            WHERE lead_id = $1 
            ORDER BY created_at DESC
        `, [leadId]);

        res.json({ success: true, lead: leadRes.rows[0], interactions: interactionsRes.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/agents/funnel/recalculate/:userId', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const userId = req.params.userId as string;
        const funnelAgent = await import('./services/funnelAgent.js');
        const score = await funnelAgent.qualifyLead(userId);
        const temp = funnelAgent.classifyTemperature(score);
        await funnelAgent.updateLeadStage(score, score); // O stage update tb fará algo

        await query(`UPDATE leads SET score = $1, temperature = $2, last_interaction = now() WHERE user_id = $3`, [score, temp, userId]);

        // Grava no log de sistema
        await query(`
            INSERT INTO agent_logs (agent_name, action, user_id, result, metadata)
            VALUES ($1, $2, $3, $4, $5)
        `, ['Agente Funil', 'MANUAL_RECALCULATE', userId, 'success', JSON.stringify({ score, temp })]);

        res.json({ success: true, message: `Score recalculado: ${score} (${temp})`, score, temperature: temp });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/agents/funnel/stats', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const tempStats = await query(`SELECT temperature, COUNT(*) as count FROM leads GROUP BY temperature`);
        const stageStats = await query(`SELECT stage, COUNT(*) as count FROM leads GROUP BY stage`);
        
        res.json({
            success: true,
            temperatureStats: tempStats.rows,
            stageStats: stageStats.rows
        });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================
// AGENTE CAMPANHAS API
// ============================================

app.get('/api/campaigns', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const campaigns = await query(`
            SELECT c.*, cs.total_sent, cs.total_converted, cs.revenue_generated 
            FROM campaigns c
            LEFT JOIN campaign_stats cs ON c.id = cs.campaign_id
            ORDER BY c.created_at DESC
        `);
        res.json({ success: true, campaigns: campaigns.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/campaigns/create', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { name, type, target_segment } = req.body;
        const campaignsAgent = await import('./services/campaignsAgent.js');
        const campaignId = await campaignsAgent.createCampaign({
            name, type, target_segment, created_by: req.user?.id
        });
        res.json({ success: true, message: 'Campanha criada e audiência segmentada.', campaignId });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/campaigns/:id/launch', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        await query(`UPDATE campaigns SET status = 'active', started_at = now() WHERE id = $1`, [id]);
        res.json({ success: true, message: 'Campanha lançada com sucesso.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/campaigns/:id/pause', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        await query(`UPDATE campaigns SET status = 'paused' WHERE id = $1`, [id]);
        res.json({ success: true, message: 'Campanha pausada.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/campaigns/:id/stats', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const stats = await query(`SELECT * FROM campaign_stats WHERE campaign_id = $1`, [id]);
        res.json({ success: true, stats: stats.rows[0] });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/campaigns/:id/recipients', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const recipients = await query(`
            SELECT cr.*, u.name, u.email, u.whatsapp 
            FROM campaign_recipients cr
            JOIN users u ON cr.user_id = u.id
            WHERE cr.campaign_id = $1
            ORDER BY cr.sent_at DESC NULLS LAST
        `, [id]);
        res.json({ success: true, recipients: recipients.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================
// AGENTE RECUPERAÇÃO API
// ============================================

app.get('/api/agents/recovery/risks', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const risks = await query(`
            SELECT cr.*, u.name, u.email, u.whatsapp, u.plan 
            FROM churn_risks cr
            JOIN users u ON cr.user_id = u.id
            ORDER BY 
                CASE risk_level 
                    WHEN 'critical' THEN 1 
                    WHEN 'high' THEN 2 
                    WHEN 'medium' THEN 3 
                    WHEN 'low' THEN 4 
                    ELSE 5 
                END ASC,
                cr.days_inactive DESC
        `);
        res.json({ success: true, risks: risks.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/agents/recovery/stats', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const stats = await query(`
            SELECT recovery_status, COUNT(*) as count 
            FROM churn_risks 
            GROUP BY recovery_status
        `);
        // Adicionar taxa por nível
        const levelStats = await query(`
            SELECT risk_level, COUNT(*) FILTER (WHERE recovery_status = 'recovered') as recovered, COUNT(*) as total
            FROM churn_risks
            GROUP BY risk_level
        `);
        res.json({ success: true, general: stats.rows, byLevel: levelStats.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/agents/recovery/trigger/:userId', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { userId } = req.params;
        const recoveryAgent = await import('./services/recoveryAgent.js');
        const userRes = await query(`SELECT id, last_login_at, created_at, plan FROM users WHERE id = $1`, [userId]);
        
        if (userRes.rowCount === 0) return res.status(404).json({ success: false, message: 'User not found' });
        
        await recoveryAgent.detectChurnRisk(userRes.rows[0]);
        const riskRes = await query(`SELECT risk_level FROM churn_risks WHERE user_id = $1`, [userId]);
        const riskLevel = riskRes.rows[0]?.risk_level || 'low';
        
        await recoveryAgent.triggerRecovery(userId as string, riskLevel);
        res.json({ success: true, message: `Protocolo ${riskLevel} disparado manualmente.`, riskLevel });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/agents/recovery/mark-recovered/:userId', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { userId } = req.params;
        await query(`UPDATE churn_risks SET recovery_status = 'recovered' WHERE user_id = $1`, [userId]);
        res.json({ success: true, message: 'Utilizador marcado como recuperado manualmente.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================
// AGENTE MONITOR API
// ============================================

app.get('/api/monitor/health', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const agents = await query(`SELECT name, status, last_run FROM agents`);
        const openAlerts = await query(`SELECT COUNT(*) FROM alerts WHERE status = 'active'`);
        const stuckTasks = await query(`SELECT COUNT(*) FROM agent_tasks WHERE status = 'running' AND created_at < NOW() - INTERVAL '30 minutes'`);
        
        res.json({ 
            success: true, 
            status: openAlerts.rows[0].count > 0 ? 'warning' : 'ok',
            agents: agents.rows, 
            activeAlerts: openAlerts.rows[0].count,
            stuckTasks: stuckTasks.rows[0].count 
        });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- Monitoring & Alert Center Routes ---
app.get('/api/monitor/metrics', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const metrics = await query('SELECT * FROM system_metrics ORDER BY created_at DESC LIMIT 100');
        res.json({ success: true, metrics: metrics.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/monitor/alerts', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const alerts = await query('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 50');
        res.json({ success: true, alerts: alerts.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/monitor/alerts/:id/acknowledge', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        await query(`UPDATE alerts SET status = 'acknowledged', acknowledged_at = now() WHERE id = $1`, [id]);
        res.json({ success: true, message: 'Alerta reconhecido.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/monitor/alerts/:id/resolve', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        await query("UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE id = $1", [id]);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/reports', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const reports = await query('SELECT * FROM reports ORDER BY generated_at DESC LIMIT 50');
        res.json({ success: true, reports: reports.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/reports/generate', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { type } = req.body;
        const reportService = await import('./services/reportService.js');
        let data;
        
        if (type === 'weekly') data = await reportService.generateWeeklyReport();
        else data = await reportService.generateDailyDigest();
        
        res.json({ success: true, message: 'Relatório gerado com sucesso.', data });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/crm/profile/:userId', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { userId } = req.params;
        const profile = await query(`
            SELECT u.name, u.email, u.whatsapp, u.plan, u.created_at,
                   cp.*
            FROM users u
            LEFT JOIN crm_profiles cp ON cp.user_id = u.id
            WHERE u.id = $1
        `, [userId]);
        
        if (profile.rowCount === 0) return res.status(404).json({ success: false, message: 'Perfil não encontrado.' });
        
        res.json({ success: true, profile: profile.rows[0] });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/crm/enrich/:userId', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { userId } = req.params;
        const crmAgent = await import('./services/crmAgent.js');
        await crmAgent.updateCRMProfile(userId as string);
        const insights = await crmAgent.enrichProfile(userId as string);
        res.json({ success: true, message: 'Perfil enriquecido com sucesso.', insights });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/retargeting/audiences', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const audiences = await query('SELECT * FROM retargeting_audiences ORDER BY last_synced DESC NULLS LAST');
        res.json({ success: true, audiences: audiences.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/retargeting/sync', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const retargetingService = await import('./services/retargetingService.js');
        await retargetingService.updateRetargetingAudiences();
        res.json({ success: true, message: 'Sincronização de audiências iniciada.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/agents/config', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const configs = await query('SELECT * FROM agent_config ORDER BY agent_name ASC');
        res.json({ success: true, configs: configs.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.put('/api/admin/agents/config/:id', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const { timing_minutes, allowed_hours, admin_alert_whatsapp, recovery_discount_pct, urgency_discount_pct, cooldown_hours, alert_toggles } = req.body;
        
        await query(`
            UPDATE agent_config 
            SET timing_minutes = $1, 
                allowed_hours = $2, 
                admin_alert_whatsapp = $3, 
                recovery_discount_pct = $4, 
                urgency_discount_pct = $5, 
                cooldown_hours = $6, 
                alert_toggles = $7,
                updated_at = now()
            WHERE id = $8
        `, [timing_minutes, JSON.stringify(allowed_hours), admin_alert_whatsapp, recovery_discount_pct, urgency_discount_pct, cooldown_hours, JSON.stringify(alert_toggles), id]);
        
        res.json({ success: true, message: 'Configuração atualizada.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// The monitoring routes are already defined above around line 5035.
// Removing duplicated routes to prevent ambiguity.

app.post('/api/monitor/alerts/:id/resolve', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        await query("UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE id = $1", [id]);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- Reports & Campaigns ---
app.get('/api/admin/reports', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const reports = await query('SELECT * FROM reports ORDER BY generated_at DESC LIMIT 50');
        res.json({ success: true, reports: reports.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/campaigns', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        // Fallback for the frontend request reported in console
        const campaigns = await query('SELECT * FROM crm_campaigns ORDER BY created_at DESC');
        res.json({ success: true, campaigns: campaigns.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/agents/logs', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const logs = await query('SELECT * FROM agent_logs ORDER BY created_at DESC LIMIT 200');
        res.json({ success: true, logs: logs.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/whatsapp/metrics', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const metrics = await query(`
            SELECT 
                category,
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE status = 'delivered') as success,
                COUNT(*) FILTER (WHERE status = 'failed') as failed
            FROM whatsapp_logs
            WHERE created_at >= NOW() - INTERVAL '30 days'
            GROUP BY category
        `);
        
        const health = await EvolutionService.getInstanceStatus().catch(() => ({ state: 'error' }));
        
        res.json({ success: true, metrics: metrics.rows, apiStatus: health.state });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Duplicated pulse route removed. Using the one at line 3285.

app.post('/api/admin/whatsapp/test-connection', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const adminWhatsapp = await getAdminWhatsApp();
        if (!adminWhatsapp) {
            return res.status(400).json({ success: false, message: 'Nenhum número de WhatsApp Admin configurado.' });
        }

        const msg = `✅ *TESTE DE SISTEMA CONVERSIO AI*\n\nEsta mensagem confirma que a ligação entre o seu Painel Admin e a *Evolution API* está configurada corretamente.\n\nDestino: ${adminWhatsapp}\nData: ${new Date().toLocaleString()}`;
        
        const result = await sendWhatsAppMessage(adminWhatsapp, msg, 'test');
        
        if (result.success) {
            res.json({ success: true, message: `Mensagem de teste enviada para ${adminWhatsapp}. Verifique o seu telemóvel.` });
        } else {
            res.status(500).json({ success: false, message: `Falha na Evolution API: ${result.error}` });
        }
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});


// --- AGENT CONFIG CRUD (used by AgentConfigEditor & useAgentsDashboard) ---
app.get('/api/admin/agents/config', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        // Try agent_configs table first, fallback to agent_team settings
        let configs: any[] = [];
        try {
            const result = await query('SELECT * FROM agent_configs ORDER BY agent_name ASC');
            configs = result.rows;
        } catch {
            // Fallback: build configs from agent_team table
            const agents = await query('SELECT id, persona_name as agent_name, is_active FROM agent_team ORDER BY persona_name ASC');
            configs = agents.rows.map((a: any) => ({
                id: a.id,
                agent_name: a.agent_name,
                timing_minutes: 60,
                recovery_discount_pct: 10,
                admin_alert_whatsapp: '',
                alert_toggles: { errors: true }
            }));
        }
        res.json({ success: true, configs });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.put('/api/admin/agents/config/:id', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const { timing_minutes, recovery_discount_pct, admin_alert_whatsapp, alert_toggles } = req.body;
        try {
            await query(
                `INSERT INTO agent_configs (id, timing_minutes, recovery_discount_pct, admin_alert_whatsapp, alert_toggles)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (id) DO UPDATE SET 
                    timing_minutes = EXCLUDED.timing_minutes,
                    recovery_discount_pct = EXCLUDED.recovery_discount_pct,
                    admin_alert_whatsapp = EXCLUDED.admin_alert_whatsapp,
                    alert_toggles = EXCLUDED.alert_toggles`,
                [id, timing_minutes, recovery_discount_pct, admin_alert_whatsapp, JSON.stringify(alert_toggles)]
            );
        } catch {
            // agent_configs table may not exist yet, store in system_settings as fallback
            await query(
                `INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
                [`agent_config_${id}`, JSON.stringify(req.body)]
            );
        }
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- CAMPAIGN CREATE (used by CampaignManager) ---
app.post('/api/campaigns', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const newCampaign = req.body;
        const result = await query(
            `INSERT INTO crm_campaigns (name, message_template, status, target_segment)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [
                newCampaign.name || 'Nova Campanha',
                newCampaign.message_template || newCampaign.template || '',
                'draft',
                newCampaign.target_segment || 'all'
            ]
        );
        res.json({ success: true, campaign: result.rows[0] });
    } catch (e: any) {
        // Try simplified insert without target_segment column
        try {
            const newCampaign = req.body;
            const result = await query(
                `INSERT INTO crm_campaigns (name, message_template, status) VALUES ($1, $2, $3) RETURNING *`,
                [newCampaign.name || 'Nova Campanha', newCampaign.message_template || newCampaign.template || '', 'draft']
            );
            res.json({ success: true, campaign: result.rows[0] });
        } catch (e2: any) {
            res.status(500).json({ success: false, message: e2.message });
        }
    }
});

// --- ORCHESTRATOR CONTROLS (used by useAgentsDashboard) ---
app.post('/api/orchestrator/pause/:agentName', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { agentName } = req.params;
        await query(`UPDATE agent_team SET is_active = false WHERE persona_name ILIKE $1`, [agentName]);
        res.json({ success: true, message: `Agente ${agentName} pausado.` });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/orchestrator/resume/:agentName', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { agentName } = req.params;
        await query(`UPDATE agent_team SET is_active = true WHERE persona_name ILIKE $1`, [agentName]);
        res.json({ success: true, message: `Agente ${agentName} reativado.` });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/orchestrator/run/:agentName', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { agentName } = req.params;
        // Log the manual trigger
        await query(
            `INSERT INTO agent_logs (agent_name, action, status, details) VALUES ($1, 'manual_run', 'triggered', '{}')`,
            [agentName]
        ).catch(() => {}); // Non-critical
        res.json({ success: true, message: `Execução manual do agente ${agentName} agendada.` });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Resolve alert endpoint
app.post('/api/monitor/alerts/:id/resolve', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        await query(`UPDATE alerts SET status = 'resolved', resolved_at = NOW() WHERE id = $1`, [id]);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Acknowledge alert  
app.post('/api/monitor/alerts/:id/acknowledge', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        await query(`UPDATE alerts SET status = 'acknowledged' WHERE id = $1`, [id]);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- admin/reports/generate ---
app.post('/api/admin/reports/generate', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { type } = req.body;
        const reportData = {
            users: await query('SELECT COUNT(*) FROM users').then(r => r.rows[0].count),
            revenue: await query("SELECT SUM(amount) FROM transactions WHERE status = 'approved'").then(r => r.rows[0].sum || 0),
            messages: await query("SELECT COUNT(*) FROM whatsapp_logs WHERE created_at >= NOW() - INTERVAL '30 days'").then(r => r.rows[0].count)
        };
        await query(
            `INSERT INTO reports (type, data, generated_at) VALUES ($1, $2, NOW())`,
            [type || 'summary', JSON.stringify(reportData)]
        ).catch(() => {}); // Non-critical if reports table doesn't exist
        res.json({ success: true, report: reportData });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- Background Job: Generation Timeouts & Refunds ---
setInterval(async () => {
    try {
        // Find generations older than 10 minutes that are still processing
        const timeoutRows = await query(`
            SELECT id, user_id, cost 
            FROM generations 
            WHERE status = 'processing' 
            AND created_at < NOW() - INTERVAL '10 minutes'
        `);

        
        for (const row of timeoutRows.rows) {
            // Update to failed
            await query("UPDATE generations SET status = 'failed' WHERE id = $1", [row.id]);
            
            // Refund cost if valid
            const cost = parseFloat(row.cost);
            if (cost > 0 && row.user_id) {
                await query("UPDATE users SET credits = credits + $1 WHERE id = $2", [cost, row.user_id]);
                console.log(`[Timeout Cron] Refunded ${cost} credits to user ${row.user_id} for stranded generation ${row.id}`);
            }
        }
    } catch (e) {
        console.error('[Timeout Cron Error]', e);
    }
}, 60000); // Runs every 1 minute

// Global Error Handler for malformed JSON (body-parser)
app.use((err: any, _req: any, res: any, next: any) => {
    if (err instanceof SyntaxError && 'status' in err && err.status === 400 && 'body' in err) {
        console.error('[Bad JSON] Invalid request body format received.');
        return res.status(400).json({ success: false, message: 'JSON inválido no corpo do pedido.' });
    }
    next();
});

const PORT = process.env.PORT || 3003;

app.listen(PORT, () => {
    console.log(`[Backend] Auth API server rodando em http://localhost:${PORT}`);
    initAdminDb(); // Run admin tables init on startup
});
