import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * CV-01 — ImageAnalysisAgent
 * Analyzes a product image using GPT-4o Vision to extract details
 * for use in the image generation pipeline (UGC, ImpactAds, etc.)
 */
export class ImageAnalysisAgent {
    static async analyze(imageUrl: string): Promise<string> {
        console.log(`[ImageAnalysisAgent] Analyzing product image: ${imageUrl.substring(0, 50)}...`);

        try {
            const response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    {
                        role: "system",
                        content: "You are a senior product analyst for a creative advertising agency. Your task is to analyze a product image and describe it in detail for an ad generation pipeline. Focus on: branding, physical dimensions (scale), colors, materials, and key visual features. Output a concise but detailed technical analysis in English."
                    },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "Analyze this product for an advertising campaign. Describe it physically and identify the brand/type." },
                            {
                                type: "image_url",
                                image_url: {
                                    url: imageUrl,
                                },
                            },
                        ],
                    },
                ],
                max_tokens: 500,
            });

            const analysis = response.choices[0]?.message?.content || 'Unidentified product.';
            console.log(`[ImageAnalysisAgent] Analysis complete.`);
            return analysis;
        } catch (error: any) {
            console.error('[ImageAnalysisAgent] Error analyzing image:', error.message);
            return 'Could not analyze product image. Proceed with general instructions.';
        }
    }
}
