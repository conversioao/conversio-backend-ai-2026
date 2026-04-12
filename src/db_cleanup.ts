import { query } from './db.js';

async function cleanup() {
    console.log('Starting DB cleanup and enhancement...');
    try {
        // 1. Cleanup plans table
        // We'll keep: price_monthly, price_yearly, monthly_credits, images_per_month, videos_per_month
        // We'll drop: price, credits (redundant)
        console.log('Consolidating plans columns...');
        await query(`
            DO $$ 
            BEGIN 
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='plans' AND column_name='price') THEN
                    ALTER TABLE plans DROP COLUMN price;
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='plans' AND column_name='credits') THEN
                    ALTER TABLE plans DROP COLUMN credits;
                END IF;
            END $$;
        `);

        // 2. Enhance credit_packages table
        // Add total_credits if missing
        console.log('Enhancing credit_packages...');
        await query(`
            ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS total_credits INTEGER;
        `);
        
        // Update total_credits based on images + roughly 5*videos (since 1 video = 5 credits)
        await query(`
            UPDATE credit_packages SET total_credits = images + (videos * 5) WHERE total_credits IS NULL;
        `);

        console.log('Cleanup completed successfully!');
    } catch (error) {
        console.error('Cleanup failed:', error);
        process.exit(1);
    }
}

cleanup();
