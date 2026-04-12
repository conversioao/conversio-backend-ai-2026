import { query } from '../db.js';
import axios from 'axios';
import { getConfig } from '../config.js';

/**
 * MÓDULO D — Retargeting Automático
 */

export async function updateRetargetingAudiences() {
    try {
        console.log('[Retargeting] 🎯 Atualizando audiências de retargeting...');

        // 1. Audience: "Visitaram preços mas não compraram" (últimas 72h)
        const priceViewers = await query(`
            SELECT DISTINCT user_id FROM lead_interactions 
            WHERE type = 'upgrade_viewed' 
            AND created_at >= NOW() - INTERVAL '72 hours'
            AND user_id NOT IN (SELECT user_id FROM transactions WHERE status = 'completed')
        `);
        await upsertAudience('Price Viewers (72h)', priceViewers.rows.map(r => r.user_id));

        // 2. Audience: "Clientes em risco de churn" (do Agente Recuperação)
        const churnRisks = await query(`
            SELECT user_id FROM churn_risks 
            WHERE risk_level IN ('high', 'critical') 
            AND recovery_status != 'recovered'
        `);
        await upsertAudience('Churn Risk High/Critical', churnRisks.rows.map(r => r.user_id));

        // 3. Audience: "Free há mais de 5 dias"
        const freeD5 = await query(`
            SELECT id FROM users 
            WHERE created_at <= NOW() - INTERVAL '5 days'
            AND role = 'user'
            AND id NOT IN (SELECT user_id FROM user_subscriptions WHERE status = 'active')
        `);
        await upsertAudience('Free Plan (Day 5+)', freeD5.rows.map(r => r.id));

        // 4. Audience: "Clientes pagos activos" (para lookalike)
        const activePaid = await query(`
            SELECT user_id FROM user_subscriptions WHERE status = 'active'
        `);
        await upsertAudience('Active Paid Customers', activePaid.rows.map(r => r.user_id));

        console.log('[Retargeting] ✅ Audiências sincronizadas localmente.');
        
        // Sincronizar com Meta Ads (Placeholder)
        await syncWithMetaAds();

        return { success: true };
    } catch (error) {
        console.error('[Retargeting] Erro ao atualizar audiências:', error);
        throw error;
    }
}

async function upsertAudience(name: string, userIds: string[]) {
    await query(`
        INSERT INTO retargeting_audiences (name, rules, user_ids, last_synced)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (name) DO UPDATE SET
            user_ids = EXCLUDED.user_ids,
            last_synced = NOW()
    `, [name, JSON.stringify({ auto: true }), userIds]);

    // Trigger auto-creative if new users added
    if (userIds.length > 0) {
        await triggerAutoCreative(name);
    }
}

async function triggerAutoCreative(audienceName: string) {
    try {
        const webhookUrl = await getConfig('webhook_image', '');
        if (!webhookUrl) return;

        console.log(`[Retargeting] 🎨 Disparando geração de criativo para audiência: ${audienceName}`);
        
        // Usar o sistema de geração já existente via n8n
        await axios.post(webhookUrl, {
            prompt: `Anúncio de alta conversão para o segmento: ${audienceName}. Focado na plataforma Conversio AI.`,
            core: 'Impact-Ads Pro',
            style: 'Produto Herói',
            aspectRatio: '1:1',
            quantity: 1,
            metadata: { source: 'retargeting_auto', audience: audienceName }
        }).catch(err => console.warn('[Retargeting] Webhook recall failed:', err.message));

    } catch (e) {
        console.error('[Retargeting] Auto-creative trigger error:', e);
    }
}

async function syncWithMetaAds() {
    const accessToken = process.env.META_ACCESS_TOKEN;
    const adAccountId = process.env.META_AD_ACCOUNT_ID;

    if (!accessToken || !adAccountId) {
        console.warn('[Retargeting] Meta Ads credentials missing. Cloud sync skipped.');
        return;
    }

    console.log('[Retargeting] ☁️ Sincronizando com Meta Graph API...');
    // Real implementation would use Facebook Business SDK or direct axios calls to /customaudiences
}
