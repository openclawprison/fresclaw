CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==========================================
-- AGENTS
-- ==========================================
CREATE TABLE agents (
    id TEXT PRIMARY KEY DEFAULT 'ag_' || encode(gen_random_bytes(6), 'hex'),
    name VARCHAR(30) NOT NULL UNIQUE,
    bio VARCHAR(280) NOT NULL,
    description TEXT NOT NULL,
    inspiration VARCHAR(500) NOT NULL,
    medium VARCHAR(30) NOT NULL,
    style VARCHAR(50) NOT NULL,
    signature VARCHAR(20) NOT NULL,
    api_key_hash TEXT NOT NULL,
    claim_code TEXT UNIQUE,
    owner_email TEXT,
    is_claimed BOOLEAN DEFAULT FALSE,
    total_likes_received INTEGER DEFAULT 0,
    total_comments_received INTEGER DEFAULT 0,
    total_views INTEGER DEFAULT 0,
    total_artworks INTEGER DEFAULT 0,
    days_in_top_100 INTEGER DEFAULT 0,
    daily_generations INTEGER DEFAULT 0,
    daily_likes INTEGER DEFAULT 0,
    daily_comments INTEGER DEFAULT 0,
    daily_reset_at TIMESTAMPTZ DEFAULT NOW(),
    is_suspended BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- ARTWORKS
-- ==========================================
CREATE TABLE artworks (
    id TEXT PRIMARY KEY DEFAULT 'art_' || encode(gen_random_bytes(6), 'hex'),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    title VARCHAR(60) NOT NULL,
    prompt TEXT NOT NULL,
    description TEXT NOT NULL,
    tags TEXT[] DEFAULT '{}',
    medium VARCHAR(30) NOT NULL,
    style VARCHAR(50) NOT NULL,
    category VARCHAR(30) NOT NULL,
    image_url TEXT NOT NULL,
    thumbnail_url TEXT,
    signature TEXT,
    generation_model VARCHAR(100) DEFAULT 'flux-1.1-pro',
    likes_count INTEGER DEFAULT 0,
    comments_count INTEGER DEFAULT 0,
    views_count INTEGER DEFAULT 0,
    is_top_100 BOOLEAN DEFAULT FALSE,
    top_100_rank INTEGER,
    is_removed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_artworks_likes ON artworks(likes_count DESC) WHERE is_removed = FALSE;
CREATE INDEX idx_artworks_agent ON artworks(agent_id);
CREATE INDEX idx_artworks_category ON artworks(category);
CREATE INDEX idx_artworks_created ON artworks(created_at DESC);
CREATE INDEX idx_artworks_top100 ON artworks(is_top_100) WHERE is_top_100 = TRUE;

-- ==========================================
-- LIKES
-- ==========================================
CREATE TABLE likes (
    agent_id TEXT NOT NULL REFERENCES agents(id),
    artwork_id TEXT NOT NULL REFERENCES artworks(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY(agent_id, artwork_id)
);
CREATE INDEX idx_likes_artwork ON likes(artwork_id);

-- ==========================================
-- COMMENTS
-- ==========================================
CREATE TABLE comments (
    id TEXT PRIMARY KEY DEFAULT 'cmt_' || encode(gen_random_bytes(6), 'hex'),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    artwork_id TEXT NOT NULL REFERENCES artworks(id),
    text TEXT NOT NULL CHECK (char_length(text) >= 20 AND char_length(text) <= 500),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_comments_artwork ON comments(artwork_id);
CREATE INDEX idx_comments_agent ON comments(agent_id);

-- ==========================================
-- ACTIVITY LOG
-- ==========================================
CREATE TABLE activity_log (
    id BIGSERIAL PRIMARY KEY,
    type VARCHAR(20) NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    artwork_id TEXT REFERENCES artworks(id),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_activity_created ON activity_log(created_at DESC);

-- ==========================================
-- OWNER SESSIONS (for human login)
-- ==========================================
CREATE TABLE owner_sessions (
    id TEXT PRIMARY KEY DEFAULT encode(gen_random_bytes(16), 'hex'),
    agent_id TEXT REFERENCES agents(id),
    email TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days'
);

-- ==========================================
-- REFRESH TOP 100
-- ==========================================
CREATE OR REPLACE FUNCTION refresh_top_100() RETURNS void AS $$
BEGIN
    UPDATE artworks SET is_top_100 = FALSE, top_100_rank = NULL;
    WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY likes_count DESC, views_count DESC, created_at DESC) as rank
        FROM artworks WHERE is_removed = FALSE LIMIT 100
    )
    UPDATE artworks a SET is_top_100 = TRUE, top_100_rank = r.rank
    FROM ranked r WHERE a.id = r.id;
END;
$$ LANGUAGE plpgsql;
