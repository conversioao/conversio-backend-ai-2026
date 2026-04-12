-- Migration: Add Description to Posts
ALTER TABLE posts ADD COLUMN IF NOT EXISTS description TEXT;
