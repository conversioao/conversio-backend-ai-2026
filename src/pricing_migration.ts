import { query } from './db.js';
import fs from 'fs';

async function migrate() {
    console.log('Starting pricing migration...');
    const logFile = 'migration_log.txt';
    fs.writeFileSync(logFile, 'Starting migration...\n');
    try {
        // 1. Alter plans table
        console.log('Updating plans table schema...');
        fs.appendFileSync(logFile, 'Updating plans table schema...\n');
        
        // Ensure ID is TEXT to allow slugs like 'free', 'pro'
        await query(`ALTER TABLE plans ALTER COLUMN id TYPE TEXT`);
        // Relax monthly_credits constraint if needed, or we'll just fill it
        await query(`ALTER TABLE plans ALTER COLUMN monthly_credits DROP NOT NULL`);
        
        await query(`
            ALTER TABLE plans 
            ADD COLUMN IF NOT EXISTS slug TEXT UNIQUE,
            ADD COLUMN IF NOT EXISTS price_monthly NUMERIC DEFAULT 0,
            ADD COLUMN IF NOT EXISTS price_yearly NUMERIC DEFAULT 0,
            ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE,
            ADD COLUMN IF NOT EXISTS is_free BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS images_per_month INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS videos_per_month INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS videos_veo3_per_month INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS batch_generation INTEGER DEFAULT 1,
            ADD COLUMN IF NOT EXISTS history_days INTEGER DEFAULT 7,
            ADD COLUMN IF NOT EXISTS workspaces INTEGER DEFAULT 1,
            ADD COLUMN IF NOT EXISTS watermark BOOLEAN DEFAULT TRUE,
            ADD COLUMN IF NOT EXISTS white_label BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS api_access BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS priority_support BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS early_access BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS export_quality TEXT DEFAULT 'standard',
            ADD COLUMN IF NOT EXISTS realads_image BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS realads_image_generations INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS realads_video BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS realads_video_generations INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS realads_types INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS brandshot BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS brandshot_generations INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS brandshot_types INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS lookango BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS lookango_generations INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS lookango_types INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS normal_generation BOOLEAN DEFAULT TRUE,
            ADD COLUMN IF NOT EXISTS normal_generations INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS text_to_image BOOLEAN DEFAULT TRUE,
            ADD COLUMN IF NOT EXISTS text_to_image_generations INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS nano_banana_preview BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS nano_banana_pro BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS nano_banana_2 BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS seedream_preview BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS seedream_45 BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS seedream_50 BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS sora_2_preview BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS sora_2_pro BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS veo_3 BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS veo_31 BOOLEAN DEFAULT FALSE
        `);

        // 2. Create credit_packages table
        console.log('Creating credit_packages table...');
        fs.appendFileSync(logFile, 'Creating credit_packages table...\n');
        await query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
        await query(`
            CREATE TABLE IF NOT EXISTS credit_packages (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name TEXT NOT NULL,
                slug TEXT UNIQUE NOT NULL,
                price NUMERIC NOT NULL,
                credits INTEGER NOT NULL DEFAULT 0,
                total_credits INTEGER NOT NULL DEFAULT 0,
                bonus_credits INTEGER NOT NULL DEFAULT 0,
                est_images INTEGER NOT NULL DEFAULT 0,
                est_videos INTEGER NOT NULL DEFAULT 0,
                est_music INTEGER NOT NULL DEFAULT 0,
                est_narration INTEGER NOT NULL DEFAULT 0,
                expires BOOLEAN DEFAULT FALSE,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Add missing columns if table already exists
        await query(`ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS credits INTEGER NOT NULL DEFAULT 0`);
        await query(`ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS total_credits INTEGER NOT NULL DEFAULT 0`);
        await query(`ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS bonus_credits INTEGER NOT NULL DEFAULT 0`);
        await query(`ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS est_images INTEGER NOT NULL DEFAULT 0`);
        await query(`ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS est_videos INTEGER NOT NULL DEFAULT 0`);
        await query(`ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS est_music INTEGER NOT NULL DEFAULT 0`);
        await query(`ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS est_narration INTEGER NOT NULL DEFAULT 0`);

        // Remove old redundant columns that cause NOT NULL constraints issues
        await query(`ALTER TABLE credit_packages DROP COLUMN IF EXISTS images`);
        await query(`ALTER TABLE credit_packages DROP COLUMN IF EXISTS videos`);

        // 3. Delete existing plans (safely)
        console.log('Cleaning existing plans...');
        fs.appendFileSync(logFile, 'Cleaning existing plans...\n');
        await query('TRUNCATE plans CASCADE');

        // 4. Insert New Plans
        // ... (existing plans code remains same) ...

        // 5. Insert Credit Packages
        console.log('Inserting credit packages...');
        await query(`
            INSERT INTO credit_packages (name, slug, price, credits, total_credits, bonus_credits, est_images, est_videos, est_music, est_narration)
            VALUES 
            ('Mini', 'credits_mini', 9900, 1500, 1500, 0, 100, 25, 10, 50),
            ('Standard', 'credits_standard', 24900, 4000, 4500, 500, 300, 75, 30, 150),
            ('Plus', 'credits_plus', 57900, 10000, 12000, 2000, 800, 200, 60, 400),
            ('Mega', 'credits_mega', 159900, 30000, 40000, 10000, 2500, 600, 200, 1000)
            ON CONFLICT (slug) DO UPDATE SET
                price = EXCLUDED.price,
                credits = EXCLUDED.credits,
                total_credits = EXCLUDED.total_credits,
                bonus_credits = EXCLUDED.bonus_credits,
                est_images = EXCLUDED.est_images,
                est_videos = EXCLUDED.est_videos,
                est_music = EXCLUDED.est_music,
                est_narration = EXCLUDED.est_narration
        `);

        console.log('Pricing migration completed successfully!');
        fs.appendFileSync(logFile, 'Success!\n');
    } catch (error: any) {
        console.error('Pricing migration failed:', error);
        fs.appendFileSync(logFile, `FAILED: ${error.message}\n${error.stack}\n`);
        process.exit(1);
    }
}

migrate();
