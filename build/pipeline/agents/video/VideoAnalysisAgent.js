import OpenAI from 'openai';
let openaiInstance = null;
function getOpenAI() {
    if (!openaiInstance) {
        if (!process.env.OPENAI_API_KEY)
            console.error('[VideoAnalysisAgent] OPENAI_API_KEY is missing!');
        openaiInstance = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return openaiInstance;
}
/**
 * CV-04 — VideoAnalysisAgent
 * High-depth Vision analysis for Video campaigns in Angola
 */
export class VideoAnalysisAgent {
    static async analyze(imageUrl, userPrompt) {
        console.log(`[VideoAnalysisAgent] Analyzing product for video (Mirror)...`);
        try {
            const openai = getOpenAI();
            const response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    { role: "system", content: "Analyze this image for a video marketing campaign. Be detailed about lighting, texture and mood." },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: `User request: ${userPrompt}` },
                            { type: "image_url", image_url: { url: imageUrl } },
                        ],
                    },
                ],
                max_tokens: 1000,
            });
            return response.choices[0]?.message?.content || '{}';
        }
        catch (error) {
            console.error('[VideoAnalysisAgent] Error:', error.message);
            return JSON.stringify({ error: error.message });
        }
    }
}
