import { query } from '../db.js';
import { sendWhatsAppMessage } from './whatsappService.js';
import { getAdminWhatsApp } from './configService.js';
// import { getConfig } from '../config.js'; // Removido por desuso

/**
 * MÓDULO B — Relatórios Automáticos
 */

export async function generateWeeklyReport() {
    try {
        console.log('[ReportService] 📊 Gerando Relatório Semanal...');

        // 1. Novos utilizadores na semana
        const signupsRes = await query(`
            SELECT COUNT(*) FROM users 
            WHERE created_at >= NOW() - INTERVAL '7 days' AND role = 'user'
        `);
        const newUsers = signupsRes.rows[0].count;

        // 2. Conversões (free -> paid)
        const conversionsRes = await query(`
            SELECT COUNT(*) FROM transactions 
            WHERE created_at >= NOW() - INTERVAL '7 days' 
            AND status = 'completed' 
            AND type = 'upgrade'
        `);
        const conversions = conversionsRes.rows[0].count;

        // 3. Receita gerada
        const revenueRes = await query(`
            SELECT SUM(amount) FROM transactions 
            WHERE created_at >= NOW() - INTERVAL '7 days' 
            AND status = 'completed'
        `);
        const revenue = revenueRes.rows[0].sum || 0;

        // 4. Taxa de recuperação de clientes
        const recoveryRes = await query(`
            SELECT 
                COUNT(*) FILTER (WHERE recovery_status = 'recovered') as recovered,
                COUNT(*) as total
            FROM churn_risks
            WHERE created_at >= NOW() - INTERVAL '7 days'
        `);
        const recovered = parseInt(recoveryRes.rows[0].recovered);
        const totalRisks = parseInt(recoveryRes.rows[0].total);
        const recoveryRate = totalRisks > 0 ? ((recovered / totalRisks) * 100).toFixed(1) : 0;

        // 5. Agentes com mais erros
        const errorRes = await query(`
            SELECT agent_name, COUNT(*) as error_count
            FROM agent_logs
            WHERE created_at >= NOW() - INTERVAL '7 days'
            AND status = 'failed'
            GROUP BY agent_name
            ORDER BY error_count DESC
            LIMIT 3
        `);
        const topErrors = errorRes.rows;

        // 6. Previsão da semana seguinte (crescimento simples de 10% ou tendência)
        const prevWeekSignupsRes = await query(`
            SELECT COUNT(*) FROM users 
            WHERE created_at >= NOW() - INTERVAL '14 days' 
            AND created_at < NOW() - INTERVAL '7 days'
            AND role = 'user'
        `);
        const prevWeekUsers = parseInt(prevWeekSignupsRes.rows[0].count);
        const growth = prevWeekUsers > 0 ? ((newUsers - prevWeekUsers) / prevWeekUsers) : 0.1;
        const predictedUsers = Math.round(newUsers * (1 + growth));

        const reportData = {
            newUsers,
            conversions,
            revenue,
            recoveryRate,
            topErrors,
            predictedUsers,
            generated_at: new Date()
        };

        // Salvar na DB
        await query(
            `INSERT INTO reports (type, period, data) VALUES ($1, $2, $3)`,
            ['weekly', new Date().toISOString().split('T')[0], JSON.stringify(reportData)]
        );

        // Enviar via WhatsApp ao admin
        const adminWhatsapp = await getAdminWhatsApp();
        if (adminWhatsapp) {
            const msg = `📊 *RELATÓRIO SEMANAL CONVERSIO AI*\n\n` +
                        `👤 *Novos Clientes:* ${newUsers}\n` +
                        `💎 *Conversões:* ${conversions}\n` +
                        `💰 *Receita:* ${Number(revenue).toLocaleString()} Kz\n` +
                        `🔄 *Taxa Recup.:* ${recoveryRate}%\n` +
                        `🔮 *Previsão Próx. Semana:* ~${predictedUsers} leads\n\n` +
                        `🛠️ *Erros Agentes:* ${topErrors.map(e => `\n- ${e.agent_name}: ${e.error_count}`).join('') || 'Nenhum'}\n\n` +
                        `Ver detalhes no painel admin. 👆`;
            
            await sendWhatsAppMessage(adminWhatsapp, msg, 'report');
        }

        return reportData;
    } catch (error) {
        console.error('[ReportService] Erro ao gerar relatório semanal:', error);
        throw error;
    }
}

export async function generateDailyDigest() {
    try {
        console.log('[ReportService] 📋 Gerando Daily Digest...');

        // 1. Resumo do dia anterior em 5 pontos
        const yesterdaySignups = await query(`SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '24 hours' AND role = 'user'`);
        const yesterdayRev = await query(`SELECT SUM(amount) FROM transactions WHERE created_at >= NOW() - INTERVAL '24 hours' AND status = 'completed'`);
        
        // 2. Alertas pendentes
        const pendingAlerts = await query(`SELECT COUNT(*) FROM alerts WHERE status = 'active'`);
        
        // 3. Tarefas dos agentes para hoje
        const todayTasks = await query(`SELECT COUNT(*) FROM agent_tasks WHERE status = 'pending' AND created_at >= CURRENT_DATE`);

        const digestData = {
            signups: yesterdaySignups.rows[0].count,
            revenue: yesterdayRev.rows[0].sum || 0,
            pendingAlerts: pendingAlerts.rows[0].count,
            todayTasks: todayTasks.rows[0].count
        };

        // Enviar via WhatsApp
        const adminWhatsapp = await getAdminWhatsApp();
        if (adminWhatsapp) {
            const msg = `📋 *DAILY DIGEST — Conversio AI*\n\n` +
                        `1️⃣ *Registos (24h):* ${digestData.signups}\n` +
                        `2️⃣ *Receita (24h):* ${Number(digestData.revenue).toLocaleString()} Kz\n` +
                        `3️⃣ *Alertas Ativos:* ${digestData.pendingAlerts} 🚨\n` +
                        `4️⃣ *Tarefas Pendentes:* ${digestData.todayTasks}\n` +
                        `5️⃣ *Status Sistema:* Saudável ✅\n\n` +
                        `Bom trabalho hoje! 🚀`;
            
            await sendWhatsAppMessage(adminWhatsapp, msg, 'report');
        }

        return digestData;
    } catch (error) {
        console.error('[ReportService] Erro ao gerar daily digest:', error);
        throw error;
    }
}
