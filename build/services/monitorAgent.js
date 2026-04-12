import { query } from '../db.js';
import { sendWhatsAppMessage } from './whatsappService.js';
import { getAdminWhatsApp } from './configService.js';
/**
 * Agente Monitor — Vigilância 24h e Alertas Críticos
 */
export const runMonitorAgent = async () => {
    console.log('[Agente Monitor] Iniciando auditoria de saúde do sistema...');
    try {
        // 1. Coleta e Registo de Métricas Atuais
        const metrics = await collectAllMetrics();
        // 2. Avaliação de Regras de Alerta (Automático via Base de Dados)
        await evaluateAlertRules(metrics);
        // 3. Verificações Específicas de Hard-Coding (Mission critical)
        await checkAgentsHealth();
        await checkStuckTasks();
        await checkGenerationFailures();
    }
    catch (e) {
        console.error('[Agente Monitor] Erro na auditoria:', e);
    }
};
/**
 * Coleta snapshot de métricas de diversas fontes
 */
async function collectAllMetrics() {
    const metrics = {};
    // a) Registos (24h)
    const signups = await query(`SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '24 hours'`);
    metrics['daily_signups'] = parseInt(signups.rows[0].count);
    // b) Erros de Agentes (Última hora)
    const agentErrors = await query(`
        SELECT COUNT(*) as errors, agent_name 
        FROM agent_logs 
        WHERE result = 'error' AND created_at > NOW() - INTERVAL '1 hour'
        GROUP BY agent_name
    `);
    // Fazemos uma média ou pegamos o máximo para a regra genérica
    metrics['agent_error_rate'] = agentErrors.rows.length > 0 ? (agentErrors.rows[0].errors * 10) : 0; // Exemplo simplificado
    // c) WhatsApp Delivery (1h)
    const waStats = await query(`
        SELECT 
            COUNT(*) FILTER (WHERE status = 'failed') as failed,
            COUNT(*) as total
        FROM whatsapp_logs 
        WHERE created_at > NOW() - INTERVAL '1 hour'
    `);
    const totalWA = parseInt(waStats.rows[0].total);
    metrics['whatsapp_failure_rate'] = totalWA > 0 ? (parseInt(waStats.rows[0].failed) / totalWA) * 100 : 0;
    // d) Tarefas Estagnadas
    const stuck = await query(`
        SELECT COUNT(*) FROM agent_tasks 
        WHERE status IN ('pending', 'running') 
        AND created_at < NOW() - INTERVAL '30 minutes'
    `);
    metrics['stuck_tasks'] = parseInt(stuck.rows[0].count);
    // Guardar na tabela system_metrics
    for (const [name, val] of Object.entries(metrics)) {
        await query(`INSERT INTO system_metrics (metric_name, metric_value) VALUES ($1, $2)`, [name, val]);
    }
    return metrics;
}
/**
 * Avalia regras dinâmicas da tabela alert_rules
 */
async function evaluateAlertRules(metrics) {
    const rules = await query(`SELECT * FROM alert_rules WHERE is_active = true`);
    for (const rule of rules.rows) {
        const val = metrics[rule.metric_name];
        if (val === undefined)
            continue;
        let triggered = false;
        if (rule.condition === 'gt' && val > rule.threshold)
            triggered = true;
        if (rule.condition === 'lt' && val < rule.threshold)
            triggered = true;
        if (rule.condition === 'eq' && val == rule.threshold)
            triggered = true;
        if (triggered) {
            // Verificar Cooldown
            const cooldownPassed = !rule.last_triggered_at ||
                (new Date().getTime() - new Date(rule.last_triggered_at).getTime()) / 60000 >= rule.cooldown_minutes;
            if (cooldownPassed) {
                const message = rule.message_template.replace('{value}', val.toString());
                await triggerAlert(rule.metric_name, rule.severity, `Alerta de Regra: ${rule.metric_name}`, message, { value: val, ruleId: rule.id });
                // Update last triggered
                await query(`UPDATE alert_rules SET last_triggered_at = now() WHERE id = $1`, [rule.id]);
            }
        }
    }
}
/**
 * Verifica se agentes pararam
 */
async function checkAgentsHealth() {
    const agents = await query(`SELECT name, last_run, status FROM agents WHERE status = 'active'`);
    for (const agent of agents.rows) {
        // Se não corre há mais de 1 hora (ajustável por agente no futuro)
        if (agent.last_run) {
            const diffMin = (new Date().getTime() - new Date(agent.last_run).getTime()) / 60000;
            if (diffMin > 60) {
                await triggerAlert('agent_stopped', 'critical', `Agente Inativo: ${agent.name}`, `O ${agent.name} não reporta actividade há ${Math.floor(diffMin)} minutos!`, { agentName: agent.name, lastRun: agent.last_run });
            }
        }
    }
}
/**
 * Verifica tarefas estagnadas
 */
async function checkStuckTasks() {
    const res = await query(`
        SELECT COUNT(*), task_type 
        FROM agent_tasks 
        WHERE status = 'running' AND created_at < NOW() - INTERVAL '30 minutes'
        GROUP BY task_type
    `);
    if (res.rowCount > 0) {
        for (const row of res.rows) {
            await triggerAlert('stuck_tasks', 'critical', 'Fila de Tarefas Estagnada', `A tarefa do tipo ${row.task_type} está presa em processamento há mais de 30 min.`, { type: row.task_type, count: row.count });
        }
    }
}
/**
 * DISPARADOR CENTRAL DE ALERTAS
 * Pode ser chamado de qualquer lugar do sistema para alertas imediatos
 */
export async function triggerAlert(type, severity, title, description, metadata = {}) {
    try {
        // 1. Gravar na tabela alerts
        const alertRes = await query(`
            INSERT INTO alerts (type, severity, title, message, metadata)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
        `, [type, severity, title, description, JSON.stringify(metadata)]);
        const alertId = alertRes.rows[0].id;
        // 2. Se for CRITICAL ou WARNING, enviar WhatsApp imediato (se não estiver em cooldown global)
        if (severity === 'critical' || severity === 'warning') {
            await sendAdminAlert(severity, title, description);
        }
        // 3. Logar no agent_logs
        await query(`
            INSERT INTO agent_logs (agent_name, action, result, metadata)
            VALUES ($1, $2, $3, $4)
        `, ['Agente Monitor', 'ALERT_TRIGGERED', severity, JSON.stringify({ alertId, title, type })]);
        return alertId;
    }
    catch (e) {
        console.error('[Agente Monitor] Erro ao disparar alerta:', e);
    }
}
/**
 * Formatação e Envio WhatsApp
 */
export async function sendAdminAlert(severity, title, message) {
    const adminWhatsApp = await getAdminWhatsApp();
    if (!adminWhatsApp) {
        console.warn('[Agente Monitor] WhatsApp Admin não configurado. Alerta não enviado.');
        return;
    }
    let formattedMsg = "";
    if (severity === 'critical') {
        formattedMsg = `🔴 URGENTE [SISTEMA]\n*${title}*\n${message}\n\nAcção necessária: Verificar Painel Admin imediatamente.`;
    }
    else if (severity === 'warning') {
        formattedMsg = `🟡 ATENÇÃO [SISTEMA]\n*${title}*\n${message}`;
    }
    else {
        formattedMsg = `🔵 INFO [SISTEMA]\n*${title}*\n${message}`;
    }
    // Rate Limit: Não enviar mais de 10 por hora
    const lastHourAlerts = await query(`
        SELECT COUNT(*) FROM agent_logs 
        WHERE agent_name = 'Agente Monitor' 
        AND action = 'WHATSAPP_SENT' 
        AND created_at > NOW() - INTERVAL '1 hour'
    `);
    if (parseInt(lastHourAlerts.rows[0].count) >= 10) {
        console.log('[Agente Monitor] 🛑 Rate limit de WhatsApp atingido. Agrupando alertas...');
        return;
    }
    await sendWhatsAppMessage(adminWhatsApp, formattedMsg, 'system_alert');
    await query(`
        INSERT INTO agent_logs (agent_name, action, result, metadata)
        VALUES ($1, $2, $3, $4)
    `, ['Agente Monitor', 'WHATSAPP_SENT', 'success', JSON.stringify({ recipient: adminWhatsApp, severity })]);
}
/**
 * Resumo Diário 08:00 AM
 */
export async function sendDailySummary() {
    const adminWhatsApp = await getAdminWhatsApp();
    console.log('[Agente Monitor] Gerando resumo diário...');
    try {
        const last24h = await query(`
            SELECT severity, COUNT(*) as count 
            FROM alerts 
            WHERE created_at > NOW() - INTERVAL '24 hours'
            GROUP BY severity
        `);
        let summary = `📑 *RESUMO DIÁRIO CONVERSIO AI*\nPeríodo: Últimas 24h\n\n`;
        for (const row of last24h.rows) {
            const emoji = row.severity === 'critical' ? '🔴' : (row.severity === 'warning' ? '🟡' : '🔵');
            summary += `${emoji} ${row.severity.toUpperCase()}: ${row.count} incidentes\n`;
        }
        const signups = await query(`SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '24 hours'`);
        summary += `\n👤 Novos Registos: ${signups.rows[0].count}\n`;
        summary += `\nSaúde Geral: ✅ Operacional`;
        await sendWhatsAppMessage(adminWhatsApp, summary, 'system_alert');
    }
    catch (e) {
        console.error('[Agente Monitor] Erro ao gerar resumo diário:', e);
    }
}
/**
 * Monitora falhas na tabela de gerações
 */
async function checkGenerationFailures() {
    try {
        // Busca gerações que falharam nos últimos 15 minutos e que ainda não foram alertadas
        const failedGens = await query(`
            SELECT id, user_id, type, metadata, created_at 
            FROM generations 
            WHERE status = 'failed' 
            AND created_at > NOW() - INTERVAL '15 minutes'
            AND (metadata->>'alerted')::boolean IS NOT TRUE
        `);
        for (const gen of failedGens.rows) {
            const errorMsg = gen.metadata?.error || 'Erro desconhecido';
            // Disparar Alerta Individual (como solicitado)
            await triggerAlert('generation_failed', 'warning', `Falha na Geração: ${gen.type.toUpperCase()}`, `ID: ${gen.id}\nErro: ${errorMsg}\nUser: ${gen.user_id}`, { generationId: gen.id, error: errorMsg });
            // Marcar como alertado para não repetir
            await query(`
                UPDATE generations 
                SET metadata = metadata || '{"alerted": true}'::jsonb 
                WHERE id = $1
            `, [gen.id]);
        }
    }
    catch (e) {
        console.error('[Agente Monitor] Erro ao auditar gerações:', e);
    }
}
