import OpenAI from 'openai';

let openaiInstance: OpenAI | null = null;

function getOpenAI() {
    if (!openaiInstance) {
        if (!process.env.OPENAI_API_KEY) console.error('[CinematicVFXAgent] OPENAI_API_KEY is missing!');
        openaiInstance = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return openaiInstance;
}

/**
 * CV-06 — CinematicVFXAgent (Mirror)
 * Especialista em gerar anúncios cinematográficos com VFX para o mercado angolano.
 */
export class CinematicVFXAgent {
    static async generate(params: {
        analysis: string;
        userPrompt: string;
        aspectRatio: string;
        seed: number;
        useBrandColors?: boolean;
        brandColors?: any;
    }): Promise<any> {
        console.log(`[CinematicVFXAgent] Generating Cinematic VFX Video (Mirror)...`);
        try {
            const systemMessage = `Você é um especialista em criação de anúncios de vídeo cinematográficos de alta gama com VFX para o mercado angolano.
            ESTILO: Hollywood, comercial de luxo, efeitos visuais épicos.
            PESSOAS: Africanos negros/morenos angolanos.
            IDIOMA: Português de Angola (narração potente).
            
            RETORNE APENAS JSON NO FORMATO:
            {
              "prompt_veo3": "[EN — single dense paragraph 250-350 words min]",
              "copy_anuncio": { ... },
              "hashtags": { ... }
            }`;
            
            let userMessage = `Analise: ${params.analysis}. Pedido: ${params.userPrompt}. Ratio: ${params.aspectRatio}. Seed: ${params.seed}`;

            if (params.useBrandColors && params.brandColors) {
                userMessage += `\nCores da Marca: ${JSON.stringify(params.brandColors)}`;
            }

            const openai = getOpenAI();
            const response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    { role: "system", content: systemMessage },
                    { role: "user", content: userMessage }
                ],
                response_format: { type: "json_object" }
            });

            return JSON.parse(response.choices[0]?.message?.content || '{}');
        } catch (error: any) {
            console.error('[CinematicVFXAgent] Error:', error.message);
            throw error;
        }
    }
}
