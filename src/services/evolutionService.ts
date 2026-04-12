import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const DEFAULT_INSTANCE = process.env.EVOLUTION_INSTANCE || 'Conversio-Oficial';

export interface InstanceStatus {
    instanceName: string;
    state: 'open' | 'close' | 'connecting' | 'pair' | 'refused';
    owner?: string;
    profileName?: string;
    profilePictureUrl?: string;
}

export class EvolutionService {
    private static getHeaders() {
        return {
            'Content-Type': 'application/json',
            'apikey': EVOLUTION_API_KEY
        };
    }

    /**
     * Verifica o estado de ligação de uma instância específica
     */
    static async getInstanceStatus(instanceName: string = DEFAULT_INSTANCE): Promise<InstanceStatus> {
        try {
            // Usa fetchInstances para alinhar a 100% com o painel visual da Evolution API
            const response = await axios.get(`${EVOLUTION_API_URL}/instance/fetchInstances`, {
                headers: this.getHeaders()
            });
            
            const instances = response.data;
            const instanceData = Array.isArray(instances) ? instances.find(i => i.name === instanceName) : instances[instanceName];
            
            if (!instanceData) {
                return { instanceName, state: 'close' };
            }

            const rawState = instanceData.connectionStatus || instanceData.status || 'close';
            
            // Normalização de Estados para o Painel
            let state: any = 'close';
            if (['open', 'CONNECTED', 'open_connected', 'CONNECTED_SERVICE'].includes(rawState)) {
                state = 'open';
            } else if (['connecting', 'CONNECTING'].includes(rawState)) {
                state = 'connecting';
            }
            
            return {
                instanceName,
                state,
                owner: instanceData.ownerJid || instanceData.owner,
            };
        } catch (error: any) {
            console.error(`[Evolution] Error fetching status for ${instanceName}:`, error.message);
            throw new Error(`Falha ao obter estado da instância: ${error.message}`);
        }
    }

    /**
     * Configura o Webhook na Evolution API (v2.3.7 optimized)
     */
    static async setWebhook(instanceName: string = DEFAULT_INSTANCE) {
        try {
            const baseUrl = process.env.PUBLIC_URL || 'https://conversioai-conversio-ai-backend.odbegs.easypanel.host';
            const webhookUrl = `${baseUrl}/api/webhooks/whatsapp`;
            
            console.log(`[Evolution] 🛠️ Configurando Webhook v2 para a instância: ${instanceName}...`);

            // Evolution v2.x requires a nested "webhook" object and camelCase fields
            const payload = {
                webhook: {
                    enabled: true,
                    url: webhookUrl,
                    byEvents: false,
                    base64: false,
                    events: [
                        "MESSAGES_UPSERT",
                        "MESSAGES_UPDATE",
                        "MESSAGES_DELETE",
                        "SEND_MESSAGE",
                        "CONNECTION_UPDATE"
                    ]
                }
            };
            
            const response = await axios.post(`${EVOLUTION_API_URL}/webhook/set/${instanceName}`, payload, { 
                headers: this.getHeaders() 
            });

            console.log(`[Evolution] ✅ Webhook configurado com sucesso:`, response.data);
            return { success: true, data: response.data };
        } catch (error: any) {
            const apiError = error.response?.data || error.message;
            console.error(`[Evolution] ❌ Falha ao configurar Webhook (v2):`, JSON.stringify(apiError, null, 2));
            throw new Error(`Falha ao configurar Webhook: ${error.response?.data?.message || error.message}`);
        }
    }

    /**
     * Gera o QR Code para conexão
     */
    static async getQRCode(instanceName: string = DEFAULT_INSTANCE): Promise<string> {
        try {
            const response = await axios.get(`${EVOLUTION_API_URL}/instance/connect/${instanceName}`, {
                headers: this.getHeaders()
            });
            // O QR Code vem normalmente em base64 ou como uma string de pairing
            return response.data.base64 || response.data.code || '';
        } catch (error: any) {
            console.error(`[Evolution] Error getting QR code for ${instanceName}:`, error.message);
            throw new Error(`Falha ao gerar QR Code: ${error.message}`);
        }
    }

    /**
     * Logout da instância
     */
    static async logout(instanceName: string = DEFAULT_INSTANCE) {
        try {
            await axios.delete(`${EVOLUTION_API_URL}/instance/logout/${instanceName}`, {
                headers: this.getHeaders()
            });
            return { success: true };
        } catch (error: any) {
            console.error(`[Evolution] Error logging out ${instanceName}:`, error.message);
            throw new Error(`Falha ao desconectar instância: ${error.message}`);
        }
    }

    /**
     * Lista todas as instâncias e os seus estados
     */
    static async getAllInstances() {
        try {
            const response = await axios.get(`${EVOLUTION_API_URL}/instance/fetchInstances`, {
                headers: this.getHeaders()
            });
            return response.data;
        } catch (error: any) {
            console.error(`[Evolution] Error fetching all instances:`, error.message);
            throw new Error(`Falha ao listar instâncias: ${error.message}`);
        }
    }
}
