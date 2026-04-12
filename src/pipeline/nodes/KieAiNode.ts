import axios from 'axios';

const KIE_AI_API_KEY = process.env.KIE_AI_API_KEY || '56d2b8e5f458d72d9bdf2dd9f204d60a';
const BASE_URL = 'https://api.kie.ai/api/v1';

export interface KieAiJobResult {
    status: 'pending' | 'processing' | 'completed' | 'failed';
    imageUrl?: string;
    error?: string;
}

export class KieAiNode {
    /**
     * Creates a new generation task in KIE.ai
     */
    static async createTask(params: {
        model: string;
        prompt: string;
        imageUrls?: string[];
        aspectRatio?: string;
    }): Promise<string> {
        console.log(`[KieAiNode] Creating task with model: ${params.model}`);
        
        try {
            const response = await axios.post(`${BASE_URL}/jobs/createTask`, {
                model: params.model,
                input: {
                    prompt: params.prompt,
                    image_urls: params.imageUrls || [],
                    output_format: 'png',
                    image_size: params.aspectRatio || '1:1',
                    quality: 'basic'
                }
            }, {
                headers: {
                    'Authorization': `Bearer ${KIE_AI_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.data?.success && response.data?.data?.taskId) {
                return response.data.data.taskId;
            }

            throw new Error(response.data?.message || 'Falha ao criar tarefa no KIE.ai');
        } catch (error: any) {
            console.error('[KieAiNode] Error in createTask:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Polls the job status until it's finished or timed out
     */
    static async pollJobStatus(taskId: string, intervalSeconds: number = 10, timeoutMinutes: number = 5): Promise<string> {
        console.log(`[KieAiNode] Starting poll for task: ${taskId}`);
        
        const startTime = Date.now();
        const timeoutMs = timeoutMinutes * 60 * 1000;

        while (Date.now() - startTime < timeoutMs) {
            try {
                const response = await axios.get(`${BASE_URL}/jobs/recordInfo`, {
                    params: { taskId },
                    headers: {
                        'Authorization': `Bearer ${KIE_AI_API_KEY}`
                    }
                });

                const data = response.data?.data;
                const state = data?.state;

                console.log(`[KieAiNode] Task ${taskId} status: ${state}`);

                if (state === 'success') {
                    const resultJson = JSON.parse(data.resultJson);
                    const imageUrl = resultJson.resultUrls?.[0];
                    if (imageUrl) return imageUrl;
                    throw new Error('Tarefa concluída mas URL de imagem não encontrada.');
                }

                if (state === 'failed' || state === 'error') {
                    throw new Error(data.errorMessage || 'Tarefa falhou no KIE.ai');
                }

                // Wait for the next poll
                await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
            } catch (error: any) {
                if (error.message.includes('falhou') || error.message.includes('não encontrada')) {
                   throw error;
                }
                console.warn(`[KieAiNode] Polling error for ${taskId}:`, error.message);
                await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
            }
        }

        throw new Error(`Timeout atingido após ${timeoutMinutes} minutos de espera.`);
    }
}
