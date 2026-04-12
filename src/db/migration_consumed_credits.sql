-- Migration: Add total_consumed_credits column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_consumed_credits INTEGER DEFAULT 0;

-- Update existing users to have 50 bonus credits if they are new (optional logic)
-- UPDATE users SET credits = credits + 50 WHERE created_at > NOW() - INTERVAL '1 day';
