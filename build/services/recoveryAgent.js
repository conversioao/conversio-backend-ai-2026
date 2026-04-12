import { query } from '../db.js';
import OpenAI from 'openai';
// Instância do OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
/**
 * Agente Recuperação — Proteção proativa contra Churn
 */
export const runRecoveryAgent = async () => {
    console.log('[Agente Recuperação] Iniciando ciclo de recuperação de 6 horas...');
    try {
        // Encontra utilizadores que estão em protocolos de recuperação ativos
        const inProgressLeads = await query(`
            SELECT user_id, risk_level, recovery_status, days_inactive 
            FROM churn_risks 
            WHERE recovery_status = 'in_progress'
        `);
        for (const row of inProgressLeads.rows) {
            await processRecoveryProtocol(row);
        }
    }
    catch (e) {
        console.error('[Agente Recuperação] Erro no ciclo de recuperação:', e);
    }
};
/**
 * Reavaliação Diária de Churn para toda a base
 */
export const updateAllChurnRisks = async () => {
    console.log('[Agente Recuperação] Reavaliação Diária de Risco de Churn (Batch Mode)...');
    try {
        const users = await query(`SELECT id, name, last_login_at, created_at, plan FROM users`);
        for (const user of users.rows) {
            await detectChurnRisk(user);
        }
        console.log('[Agente Recuperação] Reavaliação concluída!');
    }
    catch (e) {
        console.error('[Agente Recuperação] Erro na reavaliação diária:', e);
    }
};
/**
 * Analisa e atualiza o risco de um utilizador individual
 */
export async function detectChurnRisk(user) {
    const { id, last_login_at, created_at, plan } = user;
    // Calcular dias de inatividade
    const lastActive = last_login_at || created_at;
    const daysInactive = Math.floor((Date.now() - new Date(lastActive).getTime()) / (1000 * 60 * 60 * 24));
    let riskLevel = 'none';
    let riskScore = 0;
    if (daysInactive >= 30 && plan !== 'free') {
        riskLevel = 'critical';
        riskScore = 95;
    }
    else if (daysInactive >= 21) {
        riskLevel = 'high';
        riskScore = 75;
    }
    else if (daysInactive >= 14) {
        riskLevel = 'medium';
        riskScore = 50;
    }
    else if (daysInactive >= 7) {
        riskLevel = 'low';
        riskScore = 30;
    }
    if (riskLevel !== 'none') {
        // Upsert na tabela churn_risks
        await query(`
            INSERT INTO churn_risks (user_id, risk_level, risk_score, days_inactive, last_active_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, now())
            ON CONFLICT (user_id) DO UPDATE SET 
                risk_level = EXCLUDED.risk_level,
                risk_score = EXCLUDED.risk_score,
                days_inactive = EXCLUDED.days_inactive,
                last_active_at = EXCLUDED.last_active_at,
                updated_at = now()
        `, [id, riskLevel, riskScore, daysInactive, lastActive]);
        // Se for CRITICAL e não estiver em processo, inicia protocolo e alerta Admin
        if (riskLevel === 'critical') {
            await triggerRecovery(id, 'critical');
        }
    }
}
/**
 * Dispara uma sequência de recuperação
 */
export async function triggerRecovery(userId, riskLevel) {
    const check = await query(`SELECT recovery_status FROM churn_risks WHERE user_id = $1`, [userId]);
    if (check.rows[0]?.recovery_status === 'not_started' || riskLevel === 'critical') {
        await query(`
            UPDATE churn_risks 
            SET recovery_status = 'in_progress', recovery_started_at = now() 
            WHERE user_id = $1
        `, [userId]);
        console.log(`[Agente Recuperação] Protoco de retenção [${riskLevel.toUpperCase()}] iniciado para ${userId}`);
        // Se for crítico, alerta o admin via Agente Monitor imediatamente
        if (riskLevel === 'critical') {
            const monitor = await import('./monitorAgent.js');
            await monitor.triggerAlert('critical_churn', 'critical', 'ALERTA: Risco Crítico de Churn', `O cliente pago ${userId} está inactivo há mais de 30 dias. Protocolo de recuperação iniciado.`, { userId });
        }
        // Executa o Passo 1 imediatamente
        await executeRecoveryStep(userId, 1, riskLevel);
    }
}
/**
 * Processa as etapas de protocolos em curso
 */
async function processRecoveryProtocol(protocol) {
    const { user_id, risk_level, days_inactive } = protocol;
    // Verificar se o utilizador já voltou (Deteção de Recuperação)
    const user = await query(`SELECT last_login_at FROM users WHERE id = $1`, [user_id]);
    const lastLogin = new Date(user.rows[0]?.last_login_at);
    if (lastLogin > new Date(Date.now() - 24 * 60 * 60 * 1000)) {
        // Voltou nas últimas 24h
        await query(`UPDATE churn_risks SET recovery_status = 'recovered' WHERE user_id = $1`, [user_id]);
        return;
    }
    // Obter o último passo enviado
    const lastStepRes = await query(`
        SELECT sequence_step, sent_at 
        FROM recovery_sequences 
        WHERE user_id = $1 
        ORDER BY sent_at DESC LIMIT 1
    `, [user_id]);
    const lastStep = lastStepRes.rows[0];
    if (!lastStep)
        return;
    // Lógica de Intervalo por nível
    let hoursInterval = 72; // default medium (3 dias)
    if (risk_level === 'high')
        hoursInterval = 48;
    if (risk_level === 'critical')
        hoursInterval = 24;
    const timePassed = (Date.now() - new Date(lastStep.sent_at).getTime()) / (1000 * 60 * 60);
    if (timePassed >= hoursInterval && lastStep.sequence_step < 3) {
        await executeRecoveryStep(user_id, lastStep.sequence_step + 1, risk_level);
    }
    else if (lastStep.sequence_step >= 3 && timePassed >= 72) {
        // Falhou após 3 tentativas
        await query(`UPDATE churn_risks SET recovery_status = 'churned' WHERE user_id = $1`, [user_id]);
    }
}
/**
 * Execução Real de Envio (Dada a IA OpenAI)
 */
async function executeRecoveryStep(userId, step, riskLevel) {
    try {
        const userRes = await query(`SELECT name, plan, last_login_at, created_at FROM users WHERE id = $1`, [userId]);
        const user = userRes.rows[0];
        const lastActive = user.last_login_at || user.created_at;
        const daysInactive = Math.floor((Date.now() - new Date(lastActive).getTime()) / (1000 * 60 * 60 * 24));
        let prompt = "";
        let discount = step === 2 ? 15 : 25;
        // Prompt Logic conforme missão
        if (riskLevel === 'low' || riskLevel === 'medium') {
            prompt = `Mensagem de check-in natural para ${user.name} que não entra há ${daysInactive} dias. Pergunta genuinamente como está a correr. Sem mencionar inactividade directamente. Tom: amigo que se lembra de ti (SaaS Conversio AI). 1 parágrafo.`;
        }
        else if (riskLevel === 'high') {
            prompt = `Mensagem de recuperação para ${user.name} cliente de plano ${user.plan} inactivo há ${daysInactive} dias. Reconhece a ausência, oferece desconto de ${discount}% para voltar. Tom: honesto, sem pressão, mostra que valorizas o cliente. 2 parágrafos.`;
        }
        else {
            prompt = `Mensagem urgente e pessoal de retenção para ${user.name}, cliente pago crítico da plataforma. Propõe alternativa ao cancelamento (pausa do plano, downgrade suave ou conversa directa com o gestor). Tom: CEO da Conversio AI a falar directamente, muito humano e pessoal. 2 parágrafos.`;
        }
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "És um gestor de retenção e sucesso do cliente (CSM)." },
                { role: "user", content: prompt }
            ]
        });
        const message = completion.choices[0].message.content;
        // Delegar ao Agente Envios
        await query(`
            INSERT INTO agent_tasks (agent_name, task_type, priority, payload)
            VALUES ($1, $2, $3, $4)
        `, ['Agente Envios', 'send_recovery_msg', riskLevel === 'critical' ? 1 : 2, JSON.stringify({ userId, message, step, riskLevel })]);
        // Grava na sequência
        await query(`
            INSERT INTO recovery_sequences (user_id, sequence_step, message_type)
            VALUES ($1, $2, $3)
        `, [userId, step, `recovery_${riskLevel}_step${step}`]);
        // Log imutável
        await query(`
            INSERT INTO agent_logs (agent_name, action, user_id, result, metadata)
            VALUES ($1, $2, $3, $4, $5)
        `, ['Agente Recuperação', 'STEP_EXECUTED', userId, 'success', JSON.stringify({ step, riskLevel })]);
    }
    catch (e) {
        console.error('[Agente Recuperação] Erro ao executar passo:', e);
    }
}
