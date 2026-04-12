import { query } from '../db.js';
import OpenAI from 'openai';

// Instância do OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * 1. Calcula o Score do Lead (0-100) baseando-se nas iterações
 */
export async function qualifyLead(userId: string) {
    let score = 0;

    try {
        // Obter métricas de atividade do user
        // a) +20 se fez login nas últimas 24h
        const userRes = await query(`SELECT last_login_at, created_at FROM users WHERE id = $1`, [userId]);
        const user = userRes.rows[0];
        
        if (user?.last_login_at) {
            const hoursSinceLogin = (new Date().getTime() - new Date(user.last_login_at).getTime()) / (1000 * 60 * 60);
            if (hoursSinceLogin <= 24) score += 20;
        } else if (user?.created_at) {
            // Fallback se não usar last_login_at mas criou a conta nas ultimas 24h
            const hoursSinceCreation = (new Date().getTime() - new Date(user.created_at).getTime()) / (1000 * 60 * 60);
            if (hoursSinceCreation <= 24) score += 20;
        }

        // Ler interações da tabela lead_interactions
        const interactionsRes = await query(`
            SELECT type FROM lead_interactions 
            WHERE lead_id = (SELECT id FROM leads WHERE user_id = $1)
            AND created_at >= NOW() - INTERVAL '30 days'
        `, [userId]);
        const interactions = interactionsRes.rows.map(r => r.type);

        // b) +15 se usou funcionalidade principal
        // Mapeado a 'feature_used' ou se tem 'generations'
        const gensRes = await query(`SELECT COUNT(*) as count FROM generations WHERE user_id = $1`, [userId]);
        if (parseInt(gensRes.rows[0].count) > 0 || interactions.includes('feature_used')) {
            score += 15;
        }

        // c) +25 se visitou página de preços
        if (interactions.includes('pricing_viewed')) score += 25;

        // d) +30 se tentou fazer upgrade (checkout falhou ou pending)
        const txRes = await query(`SELECT COUNT(*) as count FROM transactions WHERE user_id = $1`, [userId]);
        if (parseInt(txRes.rows[0].count) > 0 || interactions.includes('upgrade_attempted')) {
            score += 30;
        }

        // e) +10 se abriu emails anteriores ou clicou links
        if (interactions.includes('email_opened') || interactions.includes('link_clicked')) {
            score += 10;
        }

        return Math.min(score, 100);

    } catch (e) {
        console.error(`[Agente Funil] Erro ao qualificar lead ${userId}:`, e);
        return 0;
    }
}

/**
 * 2. Atualização de Termómetro (Classifica Temperatura)
 */
export function classifyTemperature(score: number): string {
    if (score <= 30) return 'cold';
    if (score <= 70) return 'warm';
    return 'hot';
}

/**
 * 3. Atualização de Estágio do Funil
 */
export async function updateLeadStage(leadId: number, score: number) {
    let stage = 'awareness';
    if (score > 30) stage = 'interest';
    if (score > 60) stage = 'decision';
    if (score > 85) stage = 'action';
    
    await query(`UPDATE leads SET stage = $1 WHERE id = $2`, [stage, leadId]);
    return stage;
}

/**
 * Geração Mágica de Mensagem baseada em Temperatura usando OpenAI GPT-4o-mini
 */
async function generateFunnelMessage(temperature: string, name: string) {
    try {
        let prompt = '';
        if (temperature === 'cold') {
            prompt = `Cria conteúdo educacional em português de Portugal para ${name} interessado em criar Vendas / Ad copys. Objectivo: mostrar valor sem vender. Tom: especialista, generoso com informação. Máximo 2 parágrafos. Não uses demasiados emojis.`;
        } else if (temperature === 'warm') {
            prompt = `Cria mensagem de nurturing em português de Portugal para ${name} que já conhece a plataforma e registou-se. Inclui um caso de sucesso fictício relevante de e-commerce. Tom: consultivo, baseado em resultados. Máximo 2 parágrafos. Não sejas chato. Chama à acção para usar a plataforma.`;
        } else {
            prompt = `Cria mensagem de conversão urgente e altamente persuasiva em português de Portugal para ${name} com score de interesse alto na Plataforma Conversio AI. Foco em benefício imediato e call-to-action directo. Tom: confiante, orientado a resultado. Máximo 1 parágrafo curto.`;
        }

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: "És um especialista em marketing e vendas de SaaS." }, { role: "user", content: prompt }],
        });
        
        return completion.choices[0].message.content;
    } catch (e: any) {
        console.error('[Agente Funil] Erro I.A. ao gerar mensagem:', e.message);
        // Fallbacks caso API Gemini se encontre restrita ou sem tokens
        if (temperature === 'cold') return `Olá ${name}! Passando para partilhar os nossos melhores guias para criar conteúdo que vende todos os dias.`;
        if (temperature === 'warm') return `Olá ${name}! Lembras-te de quando falamos sobre multiplicar vendas? Uma parceira nossa triplicou ontem o fluxo usando IA. Vamos testar?`;
        return `Olá ${name}! Notamos um enorme potencial no seu fluxo. A conversão final está a 1 clique. Avançamos juntos para o PRO agora mesmo?`;
    }
}

/**
 * 4. Assina a Próxima Acção, delega na Tabela e cria a Task no Agente Envios
 */
export async function assignNextAction(leadId: number, userId: string, temperature: string) {
    try {
        const userRes = await query(`SELECT name FROM users WHERE id = $1`, [userId]);
        const userName = userRes.rows[0]?.name || 'Empreendedor';

        // 1. O prompt para criar mensagem
        const messageBody = await generateFunnelMessage(temperature, userName);
        
        let hoursDelay = 48; // default COLD
        let msgType = 'educational_ping';

        if (temperature === 'warm') {
            hoursDelay = 24;
            msgType = 'demo_case_study';
        } else if (temperature === 'hot') {
            hoursDelay = 2; // Em caso Hot, actua super rápido no Envios
            msgType = 'urgent_conversion';

            // Alerta Imediato via Agente Monitor para o Admin via WhatsApp
            const monitor = await import('./monitorAgent.js');
            await monitor.triggerAlert(
                'hot_lead',
                'warning',
                '🔥 NOVO LEAD QUENTE!',
                `O utilizador ${userName} (${userId}) atingiu o score HOT. Acção recomendada: Acompanhamento manual urgente.`,
                { userId, userName }
            );
        }

        const nextActionDate = new Date(Date.now() + hoursDelay * 60 * 60 * 1000);

        // 2. Nunca enviar mensagens, delegar SEMPRE para o Agente Envios (que está na fila do orquestrador)
        const payload = {
            userId,
            message: messageBody,
            type: msgType,
            temperature
        };

        await query(`
            INSERT INTO agent_tasks (agent_name, task_type, priority, payload)
            VALUES ($1, $2, $3, $4)
        `, ['Agente Envios', 'send_message', temperature === 'hot' ? 1 : 2, JSON.stringify(payload)]);

        // Atualiza a tabela leads
        await query(`
            UPDATE leads 
            SET next_action = $1, next_action_date = $2 
            WHERE id = $3
        `, [msgType, nextActionDate, leadId]);

        return { msgType, nextActionDate };

    } catch (e) {
        console.error(`[Agente Funil] Erro em assignNextAction (Lead ${leadId}):`, e);
    }
}

/**
 * Motor Principal Cíclico
 */
export const runFunnelAgent = async () => {
    console.log('[Agente Funil] A iniciar o loop de varrimento de Leads à procura de ações...');
    try {
        // Encontra leads cuja Next Action deve atuar
        const dueLeads = await query(`
            SELECT id, user_id, temperature 
            FROM leads 
            WHERE next_action_date <= now() OR next_action_date IS NULL
            LIMIT 50
        `);

        for (const row of dueLeads.rows) {
            await assignNextAction(row.id, row.user_id, row.temperature || 'cold');
            
            // Gravar nos agentes_logs a ação orquestrada
            await query(`
                INSERT INTO agent_logs (agent_name, action, user_id, result, metadata)
                VALUES ($1, $2, $3, $4, $5)
            `, ['Agente Funil', 'DELEGATED_TO_ENVIOS', row.user_id, 'success', JSON.stringify({ leadId: row.id, temperature: row.temperature })]);
        }
        
    } catch (e) {
        console.error('[Agente Funil] Falha geral no cron cíclico:', e);
    }
};

/**
 * Cron: Recalculo total das Leads que deve correr 1x ao dia
 */
export const recalculateAllActiveLeads = async () => {
    console.log('[Agente Funil] Recálculo global do Score (Batch Mode)...');
    try {
        const leads = await query(`SELECT id, user_id FROM leads`);

        for (const row of leads.rows) {
            const newScore = await qualifyLead(row.user_id);
            const newTemp = classifyTemperature(newScore);
            await updateLeadStage(row.id, newScore);

            // Fetch old
            const oldLeadQuery = await query(`SELECT score, temperature FROM leads WHERE id = $1`, [row.id]);
            const old = oldLeadQuery.rows[0];

            await query(`
                UPDATE leads 
                SET score = $1, temperature = $2, last_interaction = now() 
                WHERE id = $3
            `, [newScore, newTemp, row.id]);

            if (old.score !== newScore || old.temperature !== newTemp) {
                // Tabela dos tracking history pedida na user rule
                await query(`
                    INSERT INTO agent_logs (agent_name, action, user_id, result, metadata)
                    VALUES ($1, $2, $3, $4, $5)
                `, ['Agente Funil', 'SCORE_CHANGED', row.user_id, 'success', JSON.stringify({ 
                    oldScore: old.score, newScore, 
                    oldTemp: old.temperature, newTemp 
                })]);
            }
        }
        console.log('[Agente Funil] Recálculo global completo!');
    } catch (e) {
        console.error('[Agente Funil] Falha no recálculo em lote:', e);
    }
};
