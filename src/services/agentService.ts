import { query } from '../db.js';
import { sendWhatsAppMessage, sendWhatsAppVideo, sendWhatsAppImage } from './whatsappService.js';
import { getAdminWhatsApp } from './configService.js';
import { generateFollowUpWithAI } from './crmAgent.js';

// ─────────────────────────────────────────────────────────────
// AGENT SERVICE — Equipa Autónoma de Gestão de Clientes
// 5 agentes especializados operam em pipeline sequencial
// ─────────────────────────────────────────────────────────────

interface Agent {
    id: number;
    name: string;
    persona_name: string;
    emoji: string;
    trigger_type: string;
    delay_days: number;
    delay_hours: number;
    mission: string;
    message_template: string;
    requires_approval: boolean;
    approval_action_type: string | null;
    approval_action_value: any;
    is_active: boolean;
    order_index: number;
}

interface UserContext {
    id: string;
    name: string;
    whatsapp: string;
    credits: number;
    crm_stage_id: number;
    created_at: string;
    last_active_at: string;
    interaction_history: string;
    context_briefing?: string;
}

// ─────────────────────────────────────────────────────────────
// Funções auxiliares
// ─────────────────────────────────────────────────────────────

const personalizeMessage = (template: string, user: UserContext): string => {
    const firstName = user.name?.split(' ')[0] || user.name;
    return template
        .replace(/{name}/g, firstName)
        .replace(/{credits}/g, String(user.credits))
        .replace(/{plan}/g, 'Premium'); // Default to Premium in the credit-only model
};

const logNotification = async (type: string, title: string, message: string, icon: string, color: string, referenceId?: string, referenceType?: string) => {
    try {
        await query(
            `INSERT INTO admin_notifications (type, title, message, icon, color, reference_id, reference_type) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [type, title, message, icon, color, referenceId || null, referenceType || null]
        );
    } catch (e) {
        console.error('[Agent] Failed to log notification:', e);
    }
};

const markAgentExecuted = async (userId: string, agentId: number, message: string, status: string = 'completed') => {
    await query(
        `UPDATE agent_executions SET status = $1, message_sent = $2, executed_at = NOW(), whatsapp_sent = true
         WHERE user_id = $3 AND agent_id = $4`,
        [status, message, userId, agentId]
    );
    await query(`UPDATE agent_team SET sent_count = sent_count + 1 WHERE id = $1`, [agentId]);
};

// ─────────────────────────────────────────────────────────────
// Execução de um agente para um utilizador específico
// ─────────────────────────────────────────────────────────────

export const executeAgentForUser = async (agent: Agent, user: UserContext): Promise<boolean> => {
    try {
        console.log(`[Agent] 🤖 ${agent.persona_name} (${agent.name}) → Processing user: ${user.name}`);

        // Verificar se já foi executado
        const existing = await query(
            `SELECT id, status FROM agent_executions WHERE user_id = $1 AND agent_id = $2`,
            [user.id, agent.id]
        );

        if (existing.rows.length > 0) {
            if (['completed', 'skipped', 'pending_approval'].includes(existing.rows[0].status)) {
                console.log(`[Agent] ⏭️  ${agent.persona_name} already processed for ${user.name} (${existing.rows[0].status})`);
                return false;
            }
        } else {
            // Criar registo de execução
            await query(
                `INSERT INTO agent_executions (user_id, agent_id, status, scheduled_at) VALUES ($1, $2, 'running', NOW())
                 ON CONFLICT (user_id, agent_id) DO UPDATE SET status = 'running'`,
                [user.id, agent.id]
            );
        }

        // ── Se requer aprovação admin, criar pedido e parar ──
        if (agent.requires_approval) {
            const approvalExists = await query(
                `SELECT id FROM agent_approvals WHERE user_id = $1 AND agent_id = $2 AND status = 'pending'`,
                [user.id, agent.id]
            );
            if (approvalExists.rows.length > 0) {
                console.log(`[Agent] ⏳ Approval already pending for ${user.name}`);
                return false;
            }

            const execRes = await query(
                `SELECT id FROM agent_executions WHERE user_id = $1 AND agent_id = $2`,
                [user.id, agent.id]
            );
            const execId = execRes.rows[0]?.id;

            await query(
                `INSERT INTO agent_approvals (execution_id, user_id, agent_id, type, details, status)
                 VALUES ($1, $2, $3, $4, $5, 'pending')`,
                [execId, user.id, agent.id, 'message_approval', {
                    agent_name: agent.name,
                    persona_name: agent.persona_name,
                    user_name: user.name,
                    user_whatsapp: user.whatsapp,
                    proposed_message: personalizeMessage(agent.message_template, user),
                    action_value: agent.approval_action_value
                }]
            );

            await query(
                `UPDATE agent_executions SET status = 'pending_approval' WHERE user_id = $1 AND agent_id = $2`,
                [user.id, agent.id]
            );

            // Notificação admin no painel
            await logNotification(
                'agent_approval_required',
                `⚠️ ${agent.persona_name} aguarda aprovação`,
                `O agente ${agent.persona_name} quer enviar uma mensagem especial para ${user.name}. Aprova no painel CRM.`,
                '⚠️', 'yellow',
                user.id, 'user'
            );

            // Alerta admin via WhatsApp
            const adminWhatsapp = await getAdminWhatsApp();
            if (adminWhatsapp) {
                const adminMsg = `⚠️ *APROVAÇÃO PENDENTE — ${agent.emoji} ${agent.persona_name}*\n\nO agente quer enviar uma oferta especial para *${user.name}*.\n\nAprova no painel admin: conversio.ai/admin/crm`;
                await sendWhatsAppMessage(adminWhatsapp, adminMsg, 'agent_alert').catch(() => {});
            }

            console.log(`[Agent] ✅ Approval request created for ${user.name} (agent: ${agent.name})`);
            return true;
        }

        // ── Gerar mensagem personalizada ──
        let finalMessage = personalizeMessage(agent.message_template, user);

        // Tentar enriquecer com IA se houver histórico ou briefing de contexto
        // O context_briefing é o que permite os "agentes conversarem entre si"
        if ((user.interaction_history && user.interaction_history.length > 20) || user.context_briefing) {
            try {
                const combinedContext = `
Briefing do Agente Anterior: ${user.context_briefing || 'Sem briefing específico.'}
Histórico de Mensagens: ${user.interaction_history || 'Sem histórico prévio.'}
`.trim();

                const aiResponse = await generateFollowUpWithAI(user.name, agent.name, combinedContext);
                if (aiResponse && aiResponse.message) {
                    finalMessage = aiResponse.message;
                    
                    // Logic for media if AI suggests or based on strategy
                    const mediaType = aiResponse.mediaType;
                    if (mediaType === 'video') {
                        const videoUrl = process.env.STRATEGY_VIDEO_URL || 'https://conversio.ao/videos/followup_impact.mp4';
                        await sendWhatsAppVideo(user.whatsapp, videoUrl, 'Assiste este vídeo curto que preparei para ti! 🎥');
                    } else if (mediaType === 'image') {
                        const imageUrl = process.env.STRATEGY_IMAGE_URL || 'https://conversio.ao/images/result_example.jpg';
                        await sendWhatsAppImage(user.whatsapp, imageUrl, 'Mira o nível de qualidade que podes atingir! ✨');
                    }
                }
            } catch (e) {
                console.warn(`[Agent] AI enrichment failed for ${user.name}, using template.`);
            }
        }

        // ── Enviar WhatsApp ──
        if (user.whatsapp) {
            const result = await sendWhatsAppMessage(user.whatsapp, finalMessage, 'agent_action');
            if (result.success) {
                await markAgentExecuted(user.id, agent.id, finalMessage, 'completed');

                // Registar interação no CRM
                await query(
                    `INSERT INTO crm_interactions (user_id, type, content) VALUES ($1, $2, $3)`,
                    [user.id, 'agent_message', `${agent.emoji} ${agent.persona_name}: ${finalMessage.substring(0, 100)}...`]
                );

                // Notificação admin
                await logNotification(
                    'agent_action',
                    `${agent.emoji} ${agent.persona_name} agiu`,
                    `Mensagem enviada para ${user.name} (${user.whatsapp})`,
                    agent.emoji, 'green',
                    user.id, 'user'
                );

                console.log(`[Agent] ✅ ${agent.persona_name} → WhatsApp sent to ${user.name}`);
                return true;
            } else {
                await markAgentExecuted(user.id, agent.id, finalMessage, 'failed');
                console.error(`[Agent] ❌ WhatsApp failed for ${user.name}: ${result.error}`);
                return false;
            }
        } else {
            await markAgentExecuted(user.id, agent.id, 'NO_WHATSAPP', 'skipped');
            console.warn(`[Agent] ⏭️  ${user.name} has no WhatsApp — skipping`);
            return false;
        }
    } catch (error) {
        console.error(`[Agent] ❌ Critical error processing ${user.name} with ${agent.name}:`, error);
        await query(
            `UPDATE agent_executions SET status = 'failed' WHERE user_id = $1 AND agent_id = $2`,
            [user.id, agent.id]
        ).catch(() => {});
        return false;
    }
};

// ─────────────────────────────────────────────────────────────
// Executar pipeline para utilizadores que se registaram hoje (Agente 1)
// ─────────────────────────────────────────────────────────────
export const runWelcomeAgent = async () => {
    console.log('[AgentPipeline] 👋 Running Welcome Agent (Day 0)...');
    try {
        const agents = await query(`SELECT * FROM agent_team WHERE trigger_type = 'days_after_signup' AND delay_days = 0 AND is_active = true`);
        if (agents.rows.length === 0) return;
        const agent = agents.rows[0] as Agent;

        const users = await query(`
            SELECT u.id, u.name, u.whatsapp, u.credits, u.crm_stage_id, u.created_at, u.last_active_at, u.context_briefing,
                   COALESCE((SELECT string_agg(ci.type || ':' || COALESCE(ci.content,''), ' | ') FROM (SELECT type, content FROM crm_interactions WHERE user_id = u.id ORDER BY created_at DESC LIMIT 5) ci), '') as interaction_history
            FROM users u
            WHERE u.role = 'user'
              AND u.whatsapp IS NOT NULL
              AND DATE(u.created_at) = CURRENT_DATE
              AND NOT EXISTS (SELECT 1 FROM agent_executions ae WHERE ae.user_id = u.id AND ae.agent_id = $1 AND ae.status != 'failed')
        `, [agent.id]);

        console.log(`[AgentPipeline] 👋 Found ${users.rows.length} new users for Welcome Agent`);
        for (const user of users.rows) {
            await new Promise(r => setTimeout(r, 2000)); // Rate limit
            await executeAgentForUser(agent, user as UserContext);
        }
    } catch (e) {
        console.error('[AgentPipeline] Welcome Agent error:', e);
    }
};

// ─────────────────────────────────────────────────────────────
// Executar agente por delay_days (Day 1, Day 3)
// ─────────────────────────────────────────────────────────────
export const runDayNAgent = async (delayDays: number) => {
    console.log(`[AgentPipeline] ⚡ Running Day-${delayDays} Agent...`);
    try {
        const agents = await query(`SELECT * FROM agent_team WHERE trigger_type = 'days_after_signup' AND delay_days = $1 AND is_active = true`, [delayDays]);
        if (agents.rows.length === 0) return;
        const agent = agents.rows[0] as Agent;

        const users = await query(`
            SELECT u.id, u.name, u.whatsapp, u.credits, u.crm_stage_id, u.created_at, u.last_active_at, u.context_briefing,
                   COALESCE((SELECT string_agg(ci.type || ':' || COALESCE(ci.content,''), ' | ') FROM (SELECT type, content FROM crm_interactions WHERE user_id = u.id ORDER BY created_at DESC LIMIT 5) ci), '') as interaction_history
            FROM users u
            WHERE u.role = 'user'
              AND u.whatsapp IS NOT NULL
              AND EXTRACT(DAY FROM (NOW() - u.created_at)) >= $1
              AND EXTRACT(DAY FROM (NOW() - u.created_at)) < $2
              AND NOT EXISTS (SELECT 1 FROM agent_executions ae WHERE ae.user_id = u.id AND ae.agent_id = $3 AND ae.status IN ('completed','skipped','pending_approval'))
        `, [delayDays, delayDays + 1, agent.id]);

        console.log(`[AgentPipeline] Found ${users.rows.length} users for Day-${delayDays} Agent`);
        for (const user of users.rows) {
            await new Promise(r => setTimeout(r, 2000));
            await executeAgentForUser(agent, user as UserContext);
        }
    } catch (e) {
        console.error(`[AgentPipeline] Day-${delayDays} Agent error:`, e);
    }
};

// ─────────────────────────────────────────────────────────────
// Agente Urgência Day-5 (plano gratuito)
// ─────────────────────────────────────────────────────────────
export const runFreePlanDay5Agent = async () => {
    console.log('[AgentPipeline] 🔥 Running Free Plan Day-5 Urgency Agent...');
    try {
        const agents = await query(`SELECT * FROM agent_team WHERE trigger_type = 'free_plan_day_5' AND is_active = true`);
        if (agents.rows.length === 0) return;
        const agent = agents.rows[0] as Agent;

        const users = await query(`
            SELECT u.id, u.name, u.whatsapp, u.credits, u.crm_stage_id, u.created_at, u.last_active_at, u.context_briefing,
                   COALESCE((SELECT string_agg(ci.type || ':' || COALESCE(ci.content,''), ' | ') FROM (SELECT type, content FROM crm_interactions WHERE user_id = u.id ORDER BY created_at DESC LIMIT 5) ci), '') as interaction_history
            FROM users u
            WHERE u.role = 'user'
              AND u.whatsapp IS NOT NULL
              AND EXTRACT(DAY FROM (NOW() - u.created_at)) >= 5
              AND EXTRACT(DAY FROM (NOW() - u.created_at)) < 10
              AND NOT EXISTS (SELECT 1 FROM agent_executions ae WHERE ae.user_id = u.id AND ae.agent_id = $1 AND ae.status IN ('completed','skipped','pending_approval'))
        `, [agent.id]);

        console.log(`[AgentPipeline] 🔥 Found ${users.rows.length} free plan users for Day-5 Agent`);
        for (const user of users.rows) {
            await new Promise(r => setTimeout(r, 2000));
            await executeAgentForUser(agent, user as UserContext);
        }
    } catch (e) {
        console.error('[AgentPipeline] Free Plan Day-5 Agent error:', e);
    }
};

// ─────────────────────────────────────────────────────────────
// Agente Retenção Day-10 (plano gratuito)
// ─────────────────────────────────────────────────────────────
export const runFreePlanDay10Agent = async () => {
    console.log('[AgentPipeline] 🤝 Running Free Plan Day-10 Retention Agent...');
    try {
        const agents = await query(`SELECT * FROM agent_team WHERE trigger_type = 'free_plan_day_10' AND is_active = true`);
        if (agents.rows.length === 0) return;
        const agent = agents.rows[0] as Agent;

        const users = await query(`
            SELECT u.id, u.name, u.whatsapp, u.credits, u.crm_stage_id, u.created_at, u.last_active_at, u.context_briefing,
                   COALESCE((SELECT string_agg(ci.type || ':' || COALESCE(ci.content,''), ' | ') FROM (SELECT type, content FROM crm_interactions WHERE user_id = u.id ORDER BY created_at DESC LIMIT 5) ci), '') as interaction_history
            FROM users u
            WHERE u.role = 'user'
              AND u.whatsapp IS NOT NULL
              AND EXTRACT(DAY FROM (NOW() - u.created_at)) >= 10
              AND NOT EXISTS (SELECT 1 FROM agent_executions ae WHERE ae.user_id = u.id AND ae.agent_id = $1 AND ae.status IN ('completed','skipped','pending_approval'))
        `, [agent.id]);

        console.log(`[AgentPipeline] 🤝 Found ${users.rows.length} free plan users for Day-10 Agent`);
        for (const user of users.rows) {
            await new Promise(r => setTimeout(r, 2000));
            await executeAgentForUser(agent, user as UserContext);

            // Alerta admin se Day-10 não converteu
            try {
                const adminWhatsapp = await getAdminWhatsApp();
                if (adminWhatsapp) {
                    const alertMsg = `🚨 *ATENÇÃO ADMIN — Utilizador em Risco*\n\n*${user.name}* está há 10 dias sem converter.\n\nTelefone: ${user.whatsapp}\n\nConsidere uma abordagem manual. 👆`;
                    await sendWhatsAppMessage(adminWhatsapp, alertMsg, 'agent_alert').catch(() => {});
                }
                await logNotification(
                    'user_at_risk',
                    '🚨 Utilizador em risco de churn',
                    `${user.name} está há 10 dias sem converter. Pode precisar de intervenção manual.`,
                    '🚨', 'red',
                    user.id, 'user'
                );
            } catch (e) {}
        }
    } catch (e) {
        console.error('[AgentPipeline] Free Plan Day-10 Agent error:', e);
    }
};

// ─────────────────────────────────────────────────────────────
// Buscar status de todos os agentes para o painel admin
// ─────────────────────────────────────────────────────────────
export const getAgentTeamStatus = async () => {
    const agents = await query(`
        SELECT 
            a.*,
            COUNT(CASE WHEN ae.status = 'completed' THEN 1 END) as total_completed,
            COUNT(CASE WHEN ae.status = 'pending_approval' THEN 1 END) as pending_approvals,
            COUNT(CASE WHEN ae.status = 'running' THEN 1 END) as currently_running,
            COUNT(CASE WHEN ae.status = 'failed' THEN 1 END) as total_failed,
            (SELECT json_agg(row_to_json(last_actions)) FROM (
                SELECT ae2.status, ae2.executed_at, u.name as user_name, ae2.message_sent
                FROM agent_executions ae2
                JOIN users u ON u.id = ae2.user_id
                WHERE ae2.agent_id = a.id
                ORDER BY ae2.created_at DESC LIMIT 3
            ) last_actions) as recent_actions
        FROM agent_team a
        LEFT JOIN agent_executions ae ON ae.agent_id = a.id
        GROUP BY a.id
        ORDER BY a.order_index ASC
    `);
    return agents.rows;
};

// ─────────────────────────────────────────────────────────────
// Aprovar execução pendente (admin aprova)
// ─────────────────────────────────────────────────────────────
export const approveAgentAction = async (approvalId: number, adminNotes?: string): Promise<boolean> => {
    try {
        const approval = await query(`SELECT * FROM agent_approvals WHERE id = $1`, [approvalId]);
        if (!approval.rows[0]) return false;

        const { execution_id, user_id, agent_id, details } = approval.rows[0];

        // Update approval status
        await query(
            `UPDATE agent_approvals SET status = 'approved', admin_notes = $1, resolved_at = NOW() WHERE id = $2`,
            [adminNotes || null, approvalId]
        );

        // Get user and agent data
        const userRes = await query(`SELECT id, name, whatsapp, credits, last_active_at, created_at FROM users WHERE id = $1`, [user_id]);
        const agentRes = await query(`SELECT * FROM agent_team WHERE id = $1`, [agent_id]);
        
        if (!userRes.rows[0] || !agentRes.rows[0]) return false;
        const user = userRes.rows[0];
        const agent = agentRes.rows[0];

        // Enviar a mensagem proposta
        const message = details.proposed_message || personalizeMessage(agent.message_template, { ...user, interaction_history: '' });
        const result = await sendWhatsAppMessage(user.whatsapp, message, 'agent_action');

        if (result.success) {
            await markAgentExecuted(user_id, agent_id, message, 'completed');
            await query(
                `INSERT INTO crm_interactions (user_id, type, content) VALUES ($1, $2, $3)`,
                [user_id, 'agent_approved', `✅ Admin aprovou: ${agent.persona_name} → ${message.substring(0, 80)}...`]
            );

            await logNotification(
                'agent_approved',
                `✅ Aprovação executada com sucesso`,
                `${agent.persona_name} enviou mensagem aprovada para ${user.name}`,
                '✅', 'green', user_id, 'user'
            );
        }

        return result.success;
    } catch (e) {
        console.error('[Agent] Approve action error:', e);
        return false;
    }
};

// ─────────────────────────────────────────────────────────────
// Rejeitar execução pendente
// ─────────────────────────────────────────────────────────────
export const rejectAgentAction = async (approvalId: number, adminNotes?: string): Promise<boolean> => {
    try {
        const approval = await query(`SELECT * FROM agent_approvals WHERE id = $1`, [approvalId]);
        if (!approval.rows[0]) return false;

        const { user_id, agent_id } = approval.rows[0];

        await query(
            `UPDATE agent_approvals SET status = 'rejected', admin_notes = $1, resolved_at = NOW() WHERE id = $2`,
            [adminNotes || null, approvalId]
        );

        await query(
            `UPDATE agent_executions SET status = 'skipped' WHERE user_id = $1 AND agent_id = $2`,
            [user_id, agent_id]
        );

        return true;
    } catch (e) {
        console.error('[Agent] Reject action error:', e);
        return false;
    }
};
