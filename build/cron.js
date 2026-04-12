import cron from 'node-cron';
import * as agentService from './services/agentService.js';
import * as orchestrator from './services/orchestrator.js';
import * as funnelAgent from './services/funnelAgent.js';
import * as campaignsAgent from './services/campaignsAgent.js';
import * as recoveryAgent from './services/recoveryAgent.js';
import * as monitorAgent from './services/monitorAgent.js';
import * as reportService from './services/reportService.js';
import * as retargetingService from './services/retargetingService.js';
// ─────────────────────────────────────────────────────────────
// CRON PIPELINE — Equipa Autónoma Conversio AI
// Todos os horários em fuso de Angola (UTC+1)
// ─────────────────────────────────────────────────────────────
// ── AGENTE 1 (Boas-Vindas): todos os dias às 08:00
// Processa utilizadores que se registaram hoje
cron.schedule('0 8 * * *', async () => {
    console.log('[CRON 08:00] 👋 Agente de Boas-Vindas (Day 0)...');
    await agentService.runWelcomeAgent().catch(e => console.error('[CRON] Welcome error:', e));
});
// ── AGENTE 2 (Ativação): todos os dias às 09:00
// Processa utilizadores que se registaram há exactamente 1 dia
cron.schedule('0 9 * * *', async () => {
    console.log('[CRON 09:00] ⚡ Agente de Ativação (Day 1)...');
    await agentService.runDayNAgent(1).catch(e => console.error('[CRON] Day1 error:', e));
});
// ── AGENTE 3 (Conversão): todos os dias às 10:00
// Processa utilizadores que se registaram há exactamente 3 dias
cron.schedule('0 10 * * *', async () => {
    console.log('[CRON 10:00] 💎 Agente de Conversão (Day 3)...');
    await agentService.runDayNAgent(3).catch(e => console.error('[CRON] Day3 error:', e));
});
// ── AGENTE 4 (Urgência): todos os dias às 11:00
// Utilizadores em plano gratuito há ≥ 5 dias
cron.schedule('0 11 * * *', async () => {
    console.log('[CRON 11:00] 🔥 Agente de Urgência (Free Day 5)...');
    await agentService.runFreePlanDay5Agent().catch(e => console.error('[CRON] Day5 error:', e));
});
// ── AGENTE 5 (Retenção): todos os dias às 11:30
// Utilizadores em plano gratuito há ≥ 10 dias
cron.schedule('30 11 * * *', async () => {
    console.log('[CRON 11:30] 🤝 Agente de Retenção (Free Day 10)...');
    await agentService.runFreePlanDay10Agent().catch(e => console.error('[CRON] Day10 error:', e));
});
// ── Boas-vindas em tempo real: também roda a cada hora
// Para apanhar utilizadores que se registaram durante o dia
cron.schedule('0 * * * *', async () => {
    await agentService.runWelcomeAgent().catch(e => console.error('[CRON] Hourly welcome error:', e));
});
// ── ORQUESTRADOR CENTRAL ──
// Distribui as tarefas de the queue consoante a prioridade e previne overlap (cada 15 min)
cron.schedule('*/15 * * * *', async () => {
    await orchestrator.runOrchestrator().catch(e => console.error('[CRON] Orchestrator error:', e));
});
// Reseta agentes pausados e falhas diariamente às 06:00
cron.schedule('0 6 * * *', async () => {
    await orchestrator.resumeAllAgents().catch(e => console.error('[CRON] Rescue error:', e));
});
// ── AGENTE FUNIL (Hourly Scan) ──
// Varrimento de Leads para nutrição contínua
cron.schedule('0 * * * *', async () => {
    await funnelAgent.runFunnelAgent().catch(e => console.error('[CRON] Funnel scan error:', e));
});
// ── AGENTE FUNIL (Daily Recalculate) ──
// Recálculo global do Score (madrugada)
cron.schedule('30 2 * * *', async () => {
    await funnelAgent.recalculateAllActiveLeads().catch(e => console.error('[CRON] Funnel recalculate error:', e));
});
// ── AGENTE CAMPANHAS (Batch Processing) ──
// Processa lotes de campanhas activas a cada 30 minutos
cron.schedule('*/30 * * * *', async () => {
    await campaignsAgent.runCampaignsAgent().catch(e => console.error('[CRON] Campaigns agent error:', e));
});
// ── AGENTE RECUPERAÇÃO (Monitoring & Sequences) ──
// Processa sequências de recuperação a cada 6 horas
cron.schedule('0 */6 * * *', async () => {
    await recoveryAgent.runRecoveryAgent().catch(e => console.error('[CRON] Recovery agent error:', e));
});
// Reavaliação Diária de Risco de Churn às 01:00 AM
cron.schedule('0 1 * * *', async () => {
    await recoveryAgent.updateAllChurnRisks().catch(e => console.error('[CRON] Daily churn risk update error:', e));
});
// ── AGENTE MONITOR (Health & Surveillance) ──
// Ciclo de monitorização a cada 10 minutos
cron.schedule('*/10 * * * *', async () => {
    await monitorAgent.runMonitorAgent().catch(e => console.error('[CRON] Monitor agent error:', e));
});
// Resumo Diário para o Admin às 08:00 AM
cron.schedule('0 8 * * *', async () => {
    await monitorAgent.sendDailySummary().catch(e => console.error('[CRON] Daily summary error:', e));
    await reportService.generateDailyDigest().catch(e => console.error('[CRON] Daily digest error:', e));
});
// ── RELATÓRIO SEMANAL ──
// Toda segunda-feira às 07:00 AM
cron.schedule('0 7 * * 1', async () => {
    console.log('[CRON 07:00] 📊 Gerando Relatório Semanal...');
    await reportService.generateWeeklyReport().catch(e => console.error('[CRON] Weekly report error:', e));
});
// ── RETARGETING SYNC ──
// Monitoramento e sincronização de audiências diariamente à meia-noite
cron.schedule('0 0 * * *', async () => {
    console.log('[CRON 00:00] 🎯 Sincronizando audiências de retargeting...');
    await retargetingService.updateRetargetingAudiences().catch(e => console.error('[CRON] Retargeting sync error:', e));
});
console.log('[CRON] ✅ Equipa de Agentes Autónomos, Orquestrador, Agente Funil, Campanhas, Recuperação e Monitor inicializados');
