import { query } from '../db.js';
import dotenv from 'dotenv';
dotenv.config();
/**
 * Retorna o número de WhatsApp configurado para receber alertas administrativos.
 * Procura primeiro na tabela agent_config, e usa o .env como fallback.
 */
export async function getAdminWhatsApp() {
    try {
        // Procuramos a configuração do Agente Monitor ou qualquer agência que tenha o campo preenchido
        const res = await query(`
            SELECT admin_alert_whatsapp 
            FROM agent_config 
            WHERE admin_alert_whatsapp IS NOT NULL 
            AND admin_alert_whatsapp != ''
            LIMIT 1
        `);
        if (res.rows.length > 0 && res.rows[0].admin_alert_whatsapp) {
            let num = res.rows[0].admin_alert_whatsapp.replace(/\D/g, '');
            // Garantir DDI Angola se tiver 9 dígitos
            if (num.length === 9 && !num.startsWith('244')) {
                num = '244' + num;
            }
            return num;
        }
        // Fallback
        const fallback = (process.env.ADMIN_WHATSAPP || '').replace(/\D/g, '');
        return fallback;
    }
    catch (e) {
        console.error('[ConfigService] Erro ao buscar WhatsApp Admin:', e);
        return (process.env.ADMIN_WHATSAPP || '').replace(/\D/g, '');
    }
}
/**
 * Retorna as configurações completas de um agente específico
 */
export async function getAgentConfig(agentName) {
    try {
        const res = await query('SELECT * FROM agent_config WHERE agent_name = $1', [agentName]);
        return res.rows[0] || null;
    }
    catch (e) {
        console.error(`[ConfigService] Erro ao buscar config para ${agentName}:`, e);
        return null;
    }
}
