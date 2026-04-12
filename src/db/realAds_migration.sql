-- Migration: Create models, cores, and styles tables

-- 1. Models Table
CREATE TABLE IF NOT EXISTS models (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Cores Table
CREATE TABLE IF NOT EXISTS cores (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Styles Table
CREATE TABLE IF NOT EXISTS styles (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    core_id INTEGER REFERENCES cores(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seeding Data

-- Seed Models
INSERT INTO models (name) VALUES 
('Nano Banana Pro'),
('Nano Banana 2'),
('Seedream 4.5'),
('Seedream 5.0'),
('Ideogram')
ON CONFLICT DO NOTHING;

-- Seed Cores
INSERT INTO cores (name) VALUES 
('RealAds'),
('BrandShot'),
('LookAngo')
ON CONFLICT DO NOTHING;

-- Seed Styles (Only for RealAds)
-- First, get the id of RealAds
DO $$
DECLARE
    realads_id INTEGER;
BEGIN
    SELECT id INTO realads_id FROM cores WHERE name = 'RealAds' LIMIT 1;
    
    IF realads_id IS NOT NULL THEN
        INSERT INTO styles (name, description, core_id) VALUES 
        ('🛍️ Lifestyle Shot', 'Produto no dia a dia', realads_id),
        ('✨ Transformação', 'Antes e depois real', realads_id),
        ('⭐ Review Card', 'Depoimento que converte', realads_id),
        ('⚔️ VS — Comparação', 'O melhor do mercado', realads_id),
        ('📦 Unboxing', 'Unboxing do produto', realads_id)
        ON CONFLICT DO NOTHING;
    END IF;
END $$;
