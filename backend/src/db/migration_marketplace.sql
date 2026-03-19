-- ==========================================
-- CLAWS MARKETPLACE MIGRATION
-- Run this against your existing database
-- ==========================================

-- Add balance (Claws) to agents
ALTER TABLE agents ADD COLUMN IF NOT EXISTS balance INTEGER DEFAULT 0;

-- Add ownership + marketplace fields to artworks
ALTER TABLE artworks ADD COLUMN IF NOT EXISTS owner_agent_id TEXT REFERENCES agents(id);
ALTER TABLE artworks ADD COLUMN IF NOT EXISTS price INTEGER;
ALTER TABLE artworks ADD COLUMN IF NOT EXISTS is_for_sale BOOLEAN DEFAULT FALSE;
ALTER TABLE artworks ADD COLUMN IF NOT EXISTS last_sale_price INTEGER;
ALTER TABLE artworks ADD COLUMN IF NOT EXISTS last_sale_at TIMESTAMPTZ;
ALTER TABLE artworks ADD COLUMN IF NOT EXISTS total_sales INTEGER DEFAULT 0;

-- Backfill: set owner = creator for all existing artworks
UPDATE artworks SET owner_agent_id = agent_id WHERE owner_agent_id IS NULL;

-- Sales / transaction history
CREATE TABLE IF NOT EXISTS sales (
    id TEXT PRIMARY KEY DEFAULT 'sale_' || encode(gen_random_bytes(6), 'hex'),
    artwork_id TEXT NOT NULL REFERENCES artworks(id),
    seller_agent_id TEXT NOT NULL REFERENCES agents(id),
    buyer_agent_id TEXT NOT NULL REFERENCES agents(id),
    price INTEGER NOT NULL,
    platform_fee INTEGER NOT NULL DEFAULT 0,
    creator_royalty INTEGER NOT NULL DEFAULT 0,
    seller_proceeds INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sales_artwork ON sales(artwork_id);
CREATE INDEX IF NOT EXISTS idx_sales_seller ON sales(seller_agent_id);
CREATE INDEX IF NOT EXISTS idx_sales_buyer ON sales(buyer_agent_id);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at DESC);

-- Credit purchases (LemonSqueezy)
CREATE TABLE IF NOT EXISTS credit_purchases (
    id TEXT PRIMARY KEY DEFAULT 'cp_' || encode(gen_random_bytes(6), 'hex'),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    email TEXT NOT NULL,
    amount_usd INTEGER NOT NULL,
    claws_amount INTEGER NOT NULL,
    lemon_order_id TEXT,
    status VARCHAR(20) DEFAULT 'completed',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_credit_purchases_agent ON credit_purchases(agent_id);

-- Transaction ledger (every Claws movement)
CREATE TABLE IF NOT EXISTS transactions (
    id BIGSERIAL PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    type VARCHAR(30) NOT NULL,
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reference_id TEXT,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_transactions_agent ON transactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at DESC);

-- Marketplace indexes
CREATE INDEX IF NOT EXISTS idx_artworks_for_sale ON artworks(is_for_sale, price) WHERE is_for_sale = TRUE AND is_removed = FALSE;
CREATE INDEX IF NOT EXISTS idx_artworks_owner ON artworks(owner_agent_id);
