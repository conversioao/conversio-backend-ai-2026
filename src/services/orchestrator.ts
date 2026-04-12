import { query } from '../db.js';
import { sendWhatsAppMessage } from './whatsappService.js';

/**
 * Agente Orquestrador Central
 * Controla e coordena todos os agentes (Funil, Campanhas, Recuperação, Envios, Monitor)
 */

export const runOrchestrator = async () => {
    console.log('[ORCHESTRATOR] Iniciando rotina de distribuição de tarefas...');

    try {
        // Heartbeat Orquestrador
        await query(`UPDATE agents SET last_run = now() WHERE name = 'Orquestrador'`);

        // 1. Obter todos os agentes ativos
        const activeAgentsRes = await query(`SELECT name, config FROM agents WHERE status = 'active'`);
        if (activeAgentsRes.rowCount === 0) {
            console.log('[ORCHESTRATOR] Nenhum agente ativo na BD.');
            return;
        }

        const activeAgents = activeAgentsRes.rows.map(r => r.name);

        // 2. Filar tarefas pendentes (Atenção às Prioridades 1, 2, 3)
        // Apenas para agentes que estejam 'active' (via inner/left check)
        const pendingTasksRes = await query(`
            SELECT id, agent_name, task_type, priority, payload, attempts 
            FROM agent_tasks 
            WHERE status = 'pending' AND agent_name = ANY($1)
            ORDER BY priority ASC, created_at ASC
        `, [activeAgents]);

        if (pendingTasksRes.rowCount === 0) {
            console.log('[ORCHESTRATOR] Nenhuma tarefa na fila para processar.');
            return;
        }

        const tasks = pendingTasksRes.rows;
        console.log(`[ORCHESTRATOR] Foram encontradas ${tasks.length} tarefas pendentes.`);

        // 3. Regra de Ouro: Nunca correr 2 agentes iguais em paralelo para o mesmo utilizador
        // Para isso, guardamos o ID do utilizador num Set para saber quem já foi intervencionado nesta run.
        const processedUsers = new Set<string>();

        // Registarmos os agent_names que falham para pausar no final da verificação
        const failedAgents = new Set<string>();

        for (const task of tasks) {
            const { id, agent_name, payload, attempts, task_type } = task;
            
            // O payload tem sempre o userId embutido (caso envolva um user)
            const userId = payload.userId;

            // Bloqueia a sobreposição / conflito de acções
            if (userId && processedUsers.has(userId)) {
                console.log(`[ORCHESTRATOR] Conflito Evitado: Tarefa ${id} do agente ${agent_name} ignorada nesta janela. User ${userId} já foi alocado.`);
                continue;
            }

            // Marca o user como em uso
            if (userId) {
                processedUsers.add(userId);
            }

            // Bloqueia se o agente acabou de ser pausado em iteracções anteriores deste loop
            if (failedAgents.has(agent_name)) {
                continue;
            }

            // Inicia e bloqueia a task
            await query(`UPDATE agent_tasks SET status = 'running' WHERE id = $1`, [id]);
            await query(`UPDATE agents SET last_run = now() WHERE name = $1`, [agent_name]);

            let resultStatus = 'done';
            
            try {
                // =============== LÓGICA DE DISTRIBUIÇÃO E INTEGRAÇÃO =================
                // O orquestrador coordena mas não envia. 
                // Exemplo prático de chamada a submotores (dependendo do código existente/futuro)
                console.log(`[ORCHESTRATOR] A executar [${agent_name}] -> Tipo: ${task_type}`);
                
                // --- LÓGICA ESPECÍFICA POR AGENTE ---
                if (agent_name === 'Agente Envios') {
                    if (task_type === 'send_message' || task_type === 'send_automation_msg' || task_type === 'send_campaign_msg' || task_type === 'send_recovery_msg') {
                        const { message, userId } = payload;
                        
                        // Obter número de telefone do utilizador
                        const userRes = await query('SELECT whatsapp FROM users WHERE id = $1', [userId]);
                        const whatsapp = userRes.rows[0]?.whatsapp;

                        if (whatsapp) {
                            console.log(`[ORCHESTRATOR] [Agente Envios] Enviando mensagem para ${whatsapp}...`);
                            const sendResult = await sendWhatsAppMessage(whatsapp, message, task_type);
                            if (!sendResult.success) {
                                throw new Error(`Falha no disparo WhatsApp: ${sendResult.error}`);
                            }
                        } else {
                            console.warn(`[ORCHESTRATOR] [Agente Envios] Utilizador ${userId} não tem WhatsApp cadastrado. Pulando task.`);
                        }
                    }
                }
                // Adicione outros agentes aqui conforme necessário
                
                // Conclui Tarefa na Base de Dados
                await query(`UPDATE agent_tasks SET status = 'done', executed_at = now() WHERE id = $1`, [id]);

                // Guarda Log (Regra: Guardar SEMPRE resultado)
                await query(`
                    INSERT INTO agent_logs (agent_name, action, user_id, result, metadata)
                    VALUES ($1, $2, $3, $4, $5)
                `, [agent_name, task_type, userId || null, 'success', JSON.stringify({ taskId: id, payload })]);

            } catch (error: any) {
                console.error(`[ORCHESTRATOR] ❌ Erro ao correr ${agent_name}:`, error.message);
                
                resultStatus = 'error';
                const newAttempts = attempts + 1;
                
                // Captura erro sem ser silencioso e faz logging imutável:
                await query(`
                    INSERT INTO agent_logs (agent_name, action, user_id, result, metadata)
                    VALUES ($1, $2, $3, $4, $5)
                `, [agent_name, task_type, userId || null, 'error', JSON.stringify({ error: error.message, taskId: id })]);

                // Detecta agentes com falha e pausa ao fim do 3º erro
                if (newAttempts >= 3) {
                    await query(`UPDATE agent_tasks SET status = 'failed', error_message = $1, attempts = $2 WHERE id = $3`, [error.message, newAttempts, id]);
                    
                    await query(`UPDATE agents SET status = 'paused' WHERE name = $1`, [agent_name]);
                    failedAgents.add(agent_name);
                    console.log(`[ORCHESTRATOR] 🚨 Agente [${agent_name}] MAX_FAIL (3) -> Pausado automaticamente por segurança.`);
                } else {
                    // Volta a estar pendente para a próxima run de 15 min
                    await query(`UPDATE agent_tasks SET status = 'pending', error_message = $1, attempts = $2 WHERE id = $3`, [error.message, newAttempts, id]);
                    console.log(`[ORCHESTRATOR] Agente [${agent_name}] falhou (${newAttempts}/3). Agendado novo retry.`);
                }
            }
        }
        
        console.log('[ORCHESTRATOR] Janela de execução terminada. Próximo ciclo em 15min.');

    } catch (e) {
        console.error('[ORCHESTRATOR] Falha severa no fluxo central (core):', e);
    }
};

/**
 * Função Reset invocada às 06:00 pelo cron
 * Recoloca os Agentes em 'active' para nova jornada
 */
export const resumeAllAgents = async () => {
    try {
        console.log('[ORCHESTRATOR] Reset Diário: Retomando todos os agentes que estavam pausados...');
        await query(`UPDATE agents SET status = 'active' WHERE status = 'paused'`);
        // Opcional: Reagendar tasks que tenham ficado 'failed' para fresh start
        await query(`UPDATE agent_tasks SET status = 'pending', attempts = 0 WHERE status = 'failed'`);
        console.log('[ORCHESTRATOR] Reset concluído. Todos os agentes ativos.');
    } catch (e) {
        console.error('[ORCHESTRATOR] Erro no resume automático de Agentes:', e);
    }
};
