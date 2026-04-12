-- Migration: Add Social Notifications Table
CREATE TABLE IF NOT EXISTS social_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE, -- Recipient
    actor_id UUID REFERENCES users(id) ON DELETE CASCADE, -- Who did the action
    post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL, -- 'like', 'comment'
    content TEXT, -- For comments
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_social_notifications_user ON social_notifications (user_id, is_read);
