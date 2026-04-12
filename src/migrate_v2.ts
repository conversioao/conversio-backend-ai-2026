import { query } from './db.js';

async function migrate() {
    console.log('Starting migration v2...');
    try {
        await query('ALTER TABLE generations ADD COLUMN IF NOT EXISTS model VARCHAR(255)');
        console.log('Added column: model');
        
        await query('ALTER TABLE generations ADD COLUMN IF NOT EXISTS style VARCHAR(255)');
        console.log('Added column: style');
        
        await query('ALTER TABLE generations ADD COLUMN IF NOT EXISTS aspect_ratio VARCHAR(50)');
        console.log('Added column: aspect_ratio');

        await query('ALTER TABLE generations ADD COLUMN IF NOT EXISTS batch_id VARCHAR(255)');
        console.log('Added column: batch_id');

        await query('ALTER TABLE generations ADD COLUMN IF NOT EXISTS copy TEXT');
        console.log('Added column: copy');

        await query('ALTER TABLE generations ADD COLUMN IF NOT EXISTS hashtags TEXT');
        console.log('Added column: hashtags');

        console.log('Migration v2 completed successfully!');
    } catch (error) {
        console.error('Migration v2 failed:', error);
        process.exit(1);
    }
}

migrate();
