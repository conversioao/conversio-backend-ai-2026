import { query } from '../db.js';
import OpenAI from 'openai';
// Instância do OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
/**
 * Agente de Campanhas — Motor de Marketing Automático
 */
export const runCampaignsAgent = async () => {
    // 1. Verificar Janela de Horário (8h - 22h Angola GMT+1)
    const now = new Date();
    // UTC+1
    const hours = now.getUTCHours() + 1;
    if (hours < 8 || hours >= 22) {
        console.log(`[Agente Campanhas] 😴 Fora da janela de envio (Atual: ${hours}h). Em repouso.`);
        return;
    }
    console.log('[Agente Campanhas] Iniciando motor de distribuição...');
    try {
        // 2. Localizar campanhas Ativas
        const activeCampaigns = await query(`
            SELECT id, name, type, target_segment, message_template, channels 
            FROM campaigns 
            WHERE status = 'active' 
            LIMIT 3 -- Regra: Máximo 3 campanhas activas em simultâneo
        `);
        if (activeCampaigns.rowCount === 0) {
            console.log('[Agente Campanhas] Nenhuma campanha ativa.');
            return;
        }
        for (const campaign of activeCampaigns.rows) {
            await processCampaignBatch(campaign);
        }
    }
    catch (e) {
        console.error('[Agente Campanhas] Erro no ciclo principal:', e);
    }
};
/**
 * Processa um lote de envio para uma campanha específica (Max 100/hora)
 */
async function processCampaignBatch(campaign) {
    const { id, name, type } = campaign;
    try {
        // 1. Verificar se o utilizador recebeu algo nas últimas 48h (Regra)
        // 2. Verificar se já não foi enviado para este utilizador nesta campanha
        // 3. Rate Limit: Pegar apenas utilizadores pendentes para esta campanha
        const pendingRecipients = await query(`
            SELECT cr.user_id, u.name, u.email, u.whatsapp, u.created_at
            FROM campaign_recipients cr
            JOIN users u ON cr.user_id = u.id
            WHERE cr.campaign_id = $1 
            AND cr.status = 'pending'
            AND NOT EXISTS (
                SELECT 1 FROM agent_logs al 
                WHERE al.user_id = cr.user_id 
                AND al.created_at > NOW() - INTERVAL '48 hours'
            )
            LIMIT 100 -- Rate Limit: Máximo 100 por hora (por campanha ou geral? vamos fazer por campanha no lote)
        `, [id]);
        if (pendingRecipients.rowCount === 0) {
            // Se não há mais ninguém, marcar campanha como completa
            const totalPending = await query(`SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending'`, [id]);
            if (parseInt(totalPending.rows[0].count) === 0) {
                await query(`UPDATE campaigns SET status = 'completed', completed_at = now() WHERE id = $1`, [id]);
                console.log(`[Agente Campanhas] ✅ Campanha [${name}] finalizada.`);
            }
            return;
        }
        console.log(`[Agente Campanhas] Processando lote de ${pendingRecipients.rowCount} envios para [${name}]`);
        for (const user of pendingRecipients.rows) {
            const message = await generateCampaignContent(campaign, user);
            // Delegar ao Agente Envios via Orquestrador
            const payload = {
                userId: user.user_id,
                message: message,
                campaignId: id,
                type: 'marketing_campaign'
            };
            await query(`
                INSERT INTO agent_tasks (agent_name, task_type, priority, payload)
                VALUES ($1, $2, $3, $4)
            `, ['Agente Envios', 'send_campaign_msg', 2, JSON.stringify(payload)]);
            // Atualizar status do destinatário
            await query(`
                UPDATE campaign_recipients 
                SET status = 'sent', sent_at = now() 
                WHERE campaign_id = $1 AND user_id = $2
            `, [id, user.user_id]);
            // Log de Acção
            await query(`
                INSERT INTO agent_logs (agent_name, action, user_id, result, metadata)
                VALUES ($1, $2, $3, $4, $5)
            `, ['Agente Campanhas', 'SENT_TO_ENVIOS', user.user_id, 'success', JSON.stringify({ campaignId: id, name })]);
        }
        // Atualizar estatísticas da campanha
        await trackCampaignPerformance(id);
    }
    catch (e) {
        console.error(`[Agente Campanhas] Erro ao processar lote da campanha ${id}:`, e);
    }
}
/**
 * IA Content Engine: Prompt Mestre
 */
async function generateCampaignContent(campaign, user) {
    try {
        const daysSinceSignup = Math.floor((Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24));
        // Simular resumo de atividade (idealmente viria de uma query de logs)
        const recentActivity = "Usou a IA para gerar anúncios 3 vezes esta semana.";
        const prompt = `
            És um especialista em marketing directo.
            Campanha: ${campaign.name}
            Tipo: ${campaign.type}
            Cliente: ${user.name}, usa a plataforma há ${daysSinceSignup} dias
            Actividade recente: ${recentActivity}
            Objectivo da campanha: Gerar conversão e valor.
            Tom da marca: profissional, próximo, orientado a resultados
            
            Cria uma mensagem personalizada para este cliente específico em português de Portugal.
            A mensagem deve parecer escrita por um humano, não por IA.
            Inclui o nome do cliente naturalmente no texto.
            Máximo 3 parágrafos. Call-to-action no final.
        `;
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "És um copywriter sénior especializado em conversão e retenção de SaaS." },
                { role: "user", content: prompt }
            ],
            temperature: 0.7
        });
        return completion.choices[0].message.content;
    }
    catch (e) {
        console.error('[Agente Campanhas] Erro IA Content:', e.message);
        return `Olá ${user.name}! Temos novidades incríveis na Conversio AI para o teu plano. Descobre mais no nosso painel!`;
    }
}
/**
 * Criação de Campanha e Segmentação
 */
export async function createCampaign(config) {
    const { name, type, target_segment, created_by } = config;
    const campaign = await query(`
        INSERT INTO campaigns (name, type, target_segment, created_by)
        VALUES ($1, $2, $3, $4)
        RETURNING id
    `, [name, type, JSON.stringify(target_segment), created_by]);
    const campaignId = campaign.rows[0].id;
    // Criar estatística inicial vazia
    await query(`INSERT INTO campaign_stats (campaign_id) VALUES ($1)`, [campaignId]);
    // Build Audience (Segmentação Automática)
    const audience = await buildAudience(target_segment);
    for (const userId of audience) {
        await query(`
            INSERT INTO campaign_recipients (campaign_id, user_id)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
        `, [campaignId, userId]);
    }
    return campaignId;
}
/**
 * Motor de Segmentação: Os 5 Segmentos Padrão
 */
export async function buildAudience(segmentRules) {
    const { segmentKey } = segmentRules;
    let usersQuery = "";
    switch (segmentKey) {
        case 'new_users':
            usersQuery = "SELECT id FROM users WHERE created_at > NOW() - INTERVAL '7 days'";
            break;
        case 'active_users':
            usersQuery = "SELECT id FROM users WHERE last_login_at > NOW() - INTERVAL '3 days'";
            break;
        case 'churn_risk':
            usersQuery = "SELECT id FROM users WHERE (last_login_at < NOW() - INTERVAL '14 days' OR last_login_at IS NULL)";
            break;
        case 'ready_for_upgrade':
            // Baseado no Agente Funil
            usersQuery = "SELECT u.id FROM users u JOIN leads l ON u.id = l.user_id WHERE l.score > 70";
            break;
        case 'vip_customers':
            usersQuery = "SELECT id FROM users WHERE created_at < NOW() - INTERVAL '90 days'";
            break;
        default:
            usersQuery = "SELECT id FROM users LIMIT 10"; // Fallback safe
    }
    const res = await query(usersQuery);
    return res.rows.map(r => r.id);
}
/**
 * Actualiza Stats em Tempo Real
 */
export async function trackCampaignPerformance(campaignId) {
    const res = await query(`
        SELECT 
            COUNT(*) FILTER (WHERE status = 'sent') as sent,
            COUNT(*) FILTER (WHERE status = 'converted') as converted
        FROM campaign_recipients 
        WHERE campaign_id = $1
    `, [campaignId]);
    const { sent, converted } = res.rows[0];
    await query(`
        UPDATE campaign_stats 
        SET total_sent = $1, total_converted = $2, calculated_at = now()
        WHERE campaign_id = $3
    `, [parseInt(sent), parseInt(converted), campaignId]);
}
