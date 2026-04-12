CREATE TABLE IF NOT EXISTS vozes (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO vozes (id, name, description) VALUES
('LG95yZDEHg6fCZDQjLqj', 'Phil', 'Explosive, Passionate Announcer'),
('CeNX9CMwmxDxUF5Q2Inm', 'Johnny Dynamite', 'Vintage Radio DJ'),
('st7NwhTPEzqo2riw7qWC', 'Blondie', 'Radio Host'),
('aD6riP1btT197c6dACmy', 'Rachel M', 'Pro British Radio Presenter'),
('FF7KdobWPAiR0vkcALHF', 'David', 'Movie Trailer Narrator'),
('mtrel1q69YZsNwzUSyXh', 'Rex Thunder', 'Deep N Tough'),
('dHd5gvgS0zSfduK4CvEg', 'Ed', 'Late Night Announcer'),
('cTNP6ZM2mLTKj2BFhxEh', 'Paul French', 'Podcaster'),
('eVItLK1UvXctxuarRV20q', 'Jean', 'Alluring and Playful Femme Fatale'),
('U1Vk2oyatMdYs096Ety7', 'Michael', 'Deep, Dark and Urban'),
('esy0r39YPLQj0czyOib8', 'Britney', 'Calm and Calculative Villain'),
('bwCXcoVxWNYM1C6Esa8u', 'Matthew Schmitz', 'Gravel, Deep Anti-Hero'),
('D2jw4N9m4xePLTQ3IHjU', 'Ian', 'Strange and Distorted Alien')
ON CONFLICT (id) DO NOTHING;
