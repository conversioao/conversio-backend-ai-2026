import { ImageAnalysisAgent as AnalysisAgent } from './agents/image/ImageAnalysisAgent.js';
import { PromptAgent } from './agents/image/ImagePromptAgent.js';
import { KieAiNode } from './nodes/KieAiNode.js';
import { SeedSystem } from './utils/SeedSystem.js';
import { query } from '../db.js';

export interface PipelineOptions {
    userId: string;
    userPrompt: string;
    productImageUrl: string;
    coreId: string;
    coreName: string;
    style: string;
    aspectRatio: string;
    generationId: string; // The ID of the record already created in DB
}

export class ImagePipeline {
    /**
     * Runs the full image generation pipeline
     */
    static async run(options: PipelineOptions) {
        console.log(`[ImagePipeline] 🚀 Starting pipeline for generation: ${options.generationId}`);
        
        try {
            // 1. Image Analysis
            await this.updateStatus(options.generationId, 'Analisando produto...', 10);
            const analysis = await AnalysisAgent.analyze(options.productImageUrl);
            
            // 2. Anti-Repetition & Prompt Engineering
            await this.updateStatus(options.generationId, 'Configurando ambiente visual...', 30);
            const seed = SeedSystem.generateSeed();
            const { prompt, title, copy, hashtags } = await PromptAgent.generate({
                analysis,
                userPrompt: options.userPrompt,
                coreId: options.coreId,
                core: options.coreName,
                style: options.style,
                seed
            });

            // Update record with generated prompt and copy
            await query(
                `UPDATE generations SET prompt = $1, metadata = metadata || $2 WHERE id = $3`,
                [prompt, JSON.stringify({ title, copy, hashtags, seed, analysis_summary: analysis.substring(0, 200) }), options.generationId]
            );

            // 3. Image Generation Task
            await this.updateStatus(options.generationId, 'Gerando imagem publicitária...', 50);
            const taskId = await KieAiNode.createTask({
                model: this.mapCoreToModel(options.coreId),
                prompt,
                imageUrls: [options.productImageUrl],
                aspectRatio: options.aspectRatio
            });

            // 4. Async Polling (Every 10s)
            await this.updateStatus(options.generationId, 'Finalizando detalhes visuais (Polling)...', 70);
            const finalImageUrl = await KieAiNode.pollJobStatus(taskId, 10);

            // 5. Success - Finalize record
            await query(
                `UPDATE generations SET result_url = $1, status = 'completed', updated_at = NOW() WHERE id = $2`,
                [finalImageUrl, options.generationId]
            );

            console.log(`[ImagePipeline] ✅ Pipeline completed for ${options.generationId}`);
            return { success: true, imageUrl: finalImageUrl };

        } catch (error: any) {
            console.error(`[ImagePipeline] ❌ Pipeline failed for ${options.generationId}:`, error.message);
            
            await query(
                `UPDATE generations SET status = 'failed', metadata = metadata || $1, updated_at = NOW() WHERE id = $2`,
                [JSON.stringify({ error: error.message }), options.generationId]
            );

            throw error;
        }
    }

    private static async updateStatus(id: string, message: string, progress: number) {
        console.log(`[ImagePipeline] [${progress}%] ${message}`);
        // We can optionally store the sub-status in metadata if the frontend wants to show it
        await query(
            `UPDATE generations SET metadata = metadata || $1 WHERE id = $2`,
            [JSON.stringify({ pipeline_status: message, pipeline_progress: progress }), id]
        );
    }

    private static mapCoreToModel(coreId: string): string {
        // Mapping based on n8n research
        switch (coreId) {
            case 'ugc-realistic': return 'google/nano-banana-edit';
            case 'brand-visual': return 'nano-banana-pro';
            case 'impact-ads-pro': return 'seedream/4.5-edit';
            default: return 'google/nano-banana-edit';
        }
    }
}
