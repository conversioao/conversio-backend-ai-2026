import OpenAI from 'openai';

let openaiInstance: OpenAI | null = null;

function getOpenAI() {
    if (!openaiInstance) {
        if (!process.env.OPENAI_API_KEY) console.error('[UGCVideoAgent] OPENAI_API_KEY is missing!');
        openaiInstance = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return openaiInstance;
}

/**
 * CV-05 — UGCVideoAgent
 * Especialista em gerar roteiros e prompts para vídeos UGC (User Generated Content)
 * focados no mercado Angolano.
 */
export class UGCVideoAgent {
    static async generate(params: {
        analysis: string;
        userPrompt: string;
        aspectRatio: string;
        seed: number;
        useBrandColors?: boolean;
        brandColors?: any;
    }): Promise<any> {
        console.log(`[UGCVideoAgent] 🎬 Gerando roteiro criativo para vídeo UGC (Mirror)...`);
        try {
            // Nota: No backend esta é uma versão auto-contida. 
            // A execução em produção ocorre na Generation Engine.
            const systemMessage = `Você é um especialista em criação de anúncios de vídeo UGC (User-Generated Content) para o mercado angolano.
            PESSOAS: sempre negras/morenas angolanas.
            IDIOMA: Português de Angola.
            ESTILO: Candid, natural, autêntico.
            
            RETORNE APENAS JSON NO FORMATO:
            {
              "prompt_veo3": "[EN — descreva a cena técnica]",
              "copy_anuncio": {
                "headline": "...",
                "corpo": "...",
                "cta": "...",
                "versao_stories": "...",
                "versao_whatsapp": "..."
              },
              "hashtags": {
                "principais": ["#Angola", "..."],
                "nicho": ["..."],
                "trending_angola": ["..."]
              }
            }`;
            
            let userMessage = `Analise este produto: ${params.analysis}. 
            Pedido do utilizador: ${params.userPrompt}. 
            Proporção: ${params.aspectRatio}. Seed: ${params.seed}`;

            if (params.useBrandColors && params.brandColors) {
                userMessage += `\nCores da marca: ${JSON.stringify(params.brandColors)}`;
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
            console.error('[UGCVideoAgent] Error:', error.message);
            throw error;
        }
    }
}
