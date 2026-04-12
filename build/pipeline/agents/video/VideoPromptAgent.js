import OpenAI from 'openai';
let openaiInstance = null;
function getOpenAI() {
    if (!openaiInstance) {
        if (!process.env.OPENAI_API_KEY)
            console.error('[VideoPromptAgent] OPENAI_API_KEY is missing!');
        openaiInstance = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return openaiInstance;
}
/**
 * CV-05 — VideoPromptAgent (Mirror)
 * Genera el prompt final para modelos de video (Veo/Sora).
 */
export class VideoPromptAgent {
    static async generate(params) {
        console.log(`[VideoPromptAgent] Generating Video prompt (Mirror)...`);
        try {
            const systemMessage = "Você é um especialista em prompts para geração de vídeo (Veo 3.1). Retorne um JSON com o campo 'prompt_veo3' e os detalhes do anúncio.";
            let userMessage = `Analysis: ${params.analysis}. Request: ${params.userPrompt}. Ratio: ${params.aspectRatio}. Seed: ${params.seed}`;
            if (params.useBrandColors && params.brandColors) {
                userMessage += `\nBrand Colors: ${JSON.stringify(params.brandColors)}`;
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
        }
        catch (error) {
            console.error('[VideoPromptAgent] Error:', error.message);
            throw error;
        }
    }
}
