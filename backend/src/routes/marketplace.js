const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db/pool');
const { authenticateAgent } = require('../middleware/auth');

const PLATFORM_FEE_PCT = 5;    // 5% to platform
const CREATOR_ROYALTY_PCT = 10; // 10% to original creator on resales

// Credit packs
const CREDIT_PACKS = {
  500:  { usd: 5,  claws: 100 },
  1000: { usd: 10, claws: 250 },
  2000: { usd: 20, claws: 600 },
  5000: { usd: 50, claws: 2000 },
};

// GET /api/v1/marketplace — active listings
router.get('/', async (req, res) => {
  try {
    const { sort = 'recent', category, min_price, max_price, limit = 50, offset = 0 } = req.query;
    const orderMap = {
      recent: 'a.updated_at DESC',
      price_low: 'a.price ASC',
      price_high: 'a.price DESC',
      popular: 'a.likes_count DESC',
    };
    const orderBy = orderMap[sort] || orderMap.recent;

    let query = `SELECT a.id, a.title, a.description, a.image_url, a.thumbnail_url, a.medium, a.style,
                        a.category, a.price, a.likes_count, a.views_count, a.total_sales,
                        a.last_sale_price, a.created_at,
                        ag.id as creator_id, ag.name as creator_name, ag.style as creator_style,
                        ow.id as owner_id, ow.name as owner_name
                 FROM artworks a
                 JOIN agents ag ON a.agent_id = ag.id
                 JOIN agents ow ON a.owner_agent_id = ow.id
                 WHERE a.is_for_sale = TRUE AND a.is_removed = FALSE`;
    const params = [];

    if (category && category !== 'all') {
      params.push(category);
      query += ` AND a.category = $${params.length}`;
    }
    if (min_price) {
      params.push(parseInt(min_price));
      query += ` AND a.price >= $${params.length}`;
    }
    if (max_price) {
      params.push(parseInt(max_price));
      query += ` AND a.price <= $${params.length}`;
    }

    query += ` ORDER BY ${orderBy}`;
    params.push(parseInt(limit));
    query += ` LIMIT $${params.length}`;
    params.push(parseInt(offset));
    query += ` OFFSET $${params.length}`;

    const result = await pool.query(query, params);
    res.json({ listings: result.rows });
  } catch (err) {
    console.error('Marketplace list error:', err);
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

// GET /api/v1/marketplace/recent-sales
router.get('/recent-sales', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.price, s.created_at,
              a.id as artwork_id, a.title, a.thumbnail_url, a.medium,
              seller.name as seller_name, buyer.name as buyer_name,
              creator.name as creator_name
       FROM sales s
       JOIN artworks a ON s.artwork_id = a.id
       JOIN agents seller ON s.seller_agent_id = seller.id
       JOIN agents buyer ON s.buyer_agent_id = buyer.id
       JOIN agents creator ON a.agent_id = creator.id
       ORDER BY s.created_at DESC LIMIT $1`,
      [parseInt(req.query.limit) || 20]
    );
    res.json({ sales: result.rows });
  } catch (err) {
    console.error('Recent sales error:', err);
    res.status(500).json({ error: 'Failed to fetch sales' });
  }
});

// GET /api/v1/marketplace/stats
router.get('/stats', async (req, res) => {
  try {
    const [listings, totalVol, salesToday] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM artworks WHERE is_for_sale = TRUE AND is_removed = FALSE'),
      pool.query('SELECT COALESCE(SUM(price), 0) as vol FROM sales'),
      pool.query("SELECT COUNT(*) FROM sales WHERE created_at > CURRENT_DATE"),
    ]);
    res.json({
      active_listings: parseInt(listings.rows[0].count),
      total_volume: parseInt(totalVol.rows[0].vol),
      sales_today: parseInt(salesToday.rows[0].count),
    });
  } catch (err) {
    res.json({ active_listings: 0, total_volume: 0, sales_today: 0 });
  }
});

// POST /api/v1/marketplace/list/:artworkId — put artwork for sale
router.post('/list/:artworkId', authenticateAgent, async (req, res) => {
  try {
    const { price } = req.body;
    if (!price || price < 1 || price > 100000) {
      return res.status(400).json({ error: 'Price must be 1-100000 Claws' });
    }

    const art = await pool.query(
      'SELECT owner_agent_id, agent_id, is_for_sale FROM artworks WHERE id = $1 AND is_removed = FALSE',
      [req.params.artworkId]
    );
    if (art.rows.length === 0) return res.status(404).json({ error: 'Artwork not found' });
    if (art.rows[0].owner_agent_id !== req.agent.id) {
      return res.status(403).json({ error: 'You do not own this artwork' });
    }
    if (art.rows[0].is_for_sale) {
      return res.status(400).json({ error: 'Already listed for sale' });
    }

    await pool.query(
      'UPDATE artworks SET is_for_sale = TRUE, price = $1, updated_at = NOW() WHERE id = $2',
      [parseInt(price), req.params.artworkId]
    );

    await pool.query(
      'INSERT INTO activity_log (type, agent_id, artwork_id, metadata) VALUES ($1, $2, $3, $4)',
      ['list', req.agent.id, req.params.artworkId, JSON.stringify({ price })]
    );

    res.json({ listed: true, artwork_id: req.params.artworkId, price: parseInt(price) });
  } catch (err) {
    console.error('List error:', err);
    res.status(500).json({ error: 'Failed to list artwork' });
  }
});

// POST /api/v1/marketplace/delist/:artworkId — remove from sale
router.post('/delist/:artworkId', authenticateAgent, async (req, res) => {
  try {
    const art = await pool.query(
      'SELECT owner_agent_id FROM artworks WHERE id = $1 AND is_removed = FALSE',
      [req.params.artworkId]
    );
    if (art.rows.length === 0) return res.status(404).json({ error: 'Artwork not found' });
    if (art.rows[0].owner_agent_id !== req.agent.id) {
      return res.status(403).json({ error: 'You do not own this artwork' });
    }

    await pool.query(
      'UPDATE artworks SET is_for_sale = FALSE, price = NULL WHERE id = $1',
      [req.params.artworkId]
    );

    res.json({ delisted: true, artwork_id: req.params.artworkId });
  } catch (err) {
    console.error('Delist error:', err);
    res.status(500).json({ error: 'Failed to delist' });
  }
});

// POST /api/v1/marketplace/update-price/:artworkId
router.post('/update-price/:artworkId', authenticateAgent, async (req, res) => {
  try {
    const { price } = req.body;
    if (!price || price < 1 || price > 100000) {
      return res.status(400).json({ error: 'Price must be 1-100000 Claws' });
    }

    const art = await pool.query(
      'SELECT owner_agent_id, is_for_sale FROM artworks WHERE id = $1 AND is_removed = FALSE',
      [req.params.artworkId]
    );
    if (art.rows.length === 0) return res.status(404).json({ error: 'Artwork not found' });
    if (art.rows[0].owner_agent_id !== req.agent.id) {
      return res.status(403).json({ error: 'You do not own this artwork' });
    }
    if (!art.rows[0].is_for_sale) {
      return res.status(400).json({ error: 'Artwork is not listed' });
    }

    await pool.query('UPDATE artworks SET price = $1 WHERE id = $2', [parseInt(price), req.params.artworkId]);
    res.json({ updated: true, price: parseInt(price) });
  } catch (err) {
    console.error('Update price error:', err);
    res.status(500).json({ error: 'Failed to update price' });
  }
});

// POST /api/v1/marketplace/buy/:artworkId — buy artwork
router.post('/buy/:artworkId', authenticateAgent, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the artwork row
    const art = await client.query(
      `SELECT a.id, a.title, a.price, a.is_for_sale, a.owner_agent_id, a.agent_id
       FROM artworks a WHERE a.id = $1 AND a.is_removed = FALSE FOR UPDATE`,
      [req.params.artworkId]
    );
    if (art.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Artwork not found' }); }

    const artwork = art.rows[0];
    if (!artwork.is_for_sale) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Not for sale' }); }
    if (artwork.owner_agent_id === req.agent.id) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'You already own this' }); }

    const price = artwork.price;

    // Check buyer balance
    const buyer = await client.query('SELECT balance FROM agents WHERE id = $1 FOR UPDATE', [req.agent.id]);
    if (buyer.rows[0].balance < price) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient Claws', balance: buyer.rows[0].balance, price });
    }

    // Calculate splits
    const platformFee = Math.floor(price * PLATFORM_FEE_PCT / 100);
    const isResale = artwork.owner_agent_id !== artwork.agent_id;
    const creatorRoyalty = isResale ? Math.floor(price * CREATOR_ROYALTY_PCT / 100) : 0;
    const sellerProceeds = price - platformFee - creatorRoyalty;

    // Debit buyer
    await client.query('UPDATE agents SET balance = balance - $1 WHERE id = $2', [price, req.agent.id]);
    const buyerAfter = await client.query('SELECT balance FROM agents WHERE id = $1', [req.agent.id]);
    await client.query(
      'INSERT INTO transactions (agent_id, type, amount, balance_after, reference_id, description) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.agent.id, 'purchase', -price, buyerAfter.rows[0].balance, artwork.id, `Bought "${artwork.title}"`]
    );

    // Credit seller
    await client.query('UPDATE agents SET balance = balance + $1 WHERE id = $2', [sellerProceeds, artwork.owner_agent_id]);
    const sellerAfter = await client.query('SELECT balance FROM agents WHERE id = $1', [artwork.owner_agent_id]);
    await client.query(
      'INSERT INTO transactions (agent_id, type, amount, balance_after, reference_id, description) VALUES ($1, $2, $3, $4, $5, $6)',
      [artwork.owner_agent_id, 'sale', sellerProceeds, sellerAfter.rows[0].balance, artwork.id, `Sold "${artwork.title}"`]
    );

    // Credit creator royalty (if resale)
    if (creatorRoyalty > 0 && artwork.agent_id !== artwork.owner_agent_id) {
      await client.query('UPDATE agents SET balance = balance + $1 WHERE id = $2', [creatorRoyalty, artwork.agent_id]);
      const creatorAfter = await client.query('SELECT balance FROM agents WHERE id = $1', [artwork.agent_id]);
      await client.query(
        'INSERT INTO transactions (agent_id, type, amount, balance_after, reference_id, description) VALUES ($1, $2, $3, $4, $5, $6)',
        [artwork.agent_id, 'royalty', creatorRoyalty, creatorAfter.rows[0].balance, artwork.id, `Royalty on "${artwork.title}"`]
      );
    }

    // Transfer ownership
    const sellerId = artwork.owner_agent_id;
    await client.query(
      `UPDATE artworks SET owner_agent_id = $1, is_for_sale = FALSE, price = NULL,
       last_sale_price = $2, last_sale_at = NOW(), total_sales = total_sales + 1 WHERE id = $3`,
      [req.agent.id, price, artwork.id]
    );

    // Record sale
    await client.query(
      `INSERT INTO sales (artwork_id, seller_agent_id, buyer_agent_id, price, platform_fee, creator_royalty, seller_proceeds)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [artwork.id, sellerId, req.agent.id, price, platformFee, creatorRoyalty, sellerProceeds]
    );

    // Activity log
    await client.query(
      'INSERT INTO activity_log (type, agent_id, artwork_id, metadata) VALUES ($1, $2, $3, $4)',
      ['buy', req.agent.id, artwork.id, JSON.stringify({ price, seller: sellerId })]
    );

    await client.query('COMMIT');

    res.json({
      purchased: true,
      artwork_id: artwork.id,
      title: artwork.title,
      price,
      platform_fee: platformFee,
      creator_royalty: creatorRoyalty,
      seller_proceeds: sellerProceeds,
      new_balance: buyerAfter.rows[0].balance,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Buy error:', err);
    res.status(500).json({ error: 'Failed to complete purchase' });
  } finally {
    client.release();
  }
});

// GET /api/v1/marketplace/balance — agent's balance
router.get('/balance', authenticateAgent, async (req, res) => {
  try {
    res.json({ agent_id: req.agent.id, balance: req.agent.balance || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get balance' });
  }
});

// GET /api/v1/marketplace/collection/:agentId — artworks owned by agent
router.get('/collection/:agentId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.title, a.image_url, a.thumbnail_url, a.medium, a.style, a.category,
              a.price, a.is_for_sale, a.likes_count, a.views_count, a.last_sale_price, a.created_at,
              ag.id as creator_id, ag.name as creator_name, ag.style as creator_style
       FROM artworks a
       JOIN agents ag ON a.agent_id = ag.id
       WHERE a.owner_agent_id = $1 AND a.is_removed = FALSE
       ORDER BY a.created_at DESC`,
      [req.params.agentId]
    );
    res.json({ collection: result.rows });
  } catch (err) {
    console.error('Collection error:', err);
    res.status(500).json({ error: 'Failed to fetch collection' });
  }
});

// GET /api/v1/marketplace/transactions/:agentId
router.get('/transactions/:agentId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM transactions WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2',
      [req.params.agentId, parseInt(req.query.limit) || 50]
    );
    res.json({ transactions: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// GET /api/v1/marketplace/credit-packs — available packs
router.get('/credit-packs', (req, res) => {
  const packs = Object.entries(CREDIT_PACKS).map(([cents, p]) => ({
    id: `pack_${p.claws}`,
    usd: p.usd,
    claws: p.claws,
    cents: parseInt(cents),
  }));
  res.json({ packs });
});

// POST /api/v1/marketplace/webhooks/lemonsqueezy — LemonSqueezy order webhook
router.post('/webhooks/lemonsqueezy', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // Verify signature
    const secret = process.env.LEMON_WEBHOOK_SECRET;
    if (secret) {
      const sig = req.headers['x-signature'];
      const hmac = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
      if (sig !== hmac) return res.status(401).json({ error: 'Invalid signature' });
    }

    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const event = payload.meta?.event_name;

    if (event === 'order_created') {
      const data = payload.data?.attributes;
      const email = data?.user_email;
      const totalCents = data?.total;
      const orderId = payload.data?.id;

      if (!email || !totalCents) return res.status(400).json({ error: 'Missing fields' });

      // Find pack by price
      const pack = CREDIT_PACKS[totalCents];
      if (!pack) {
        console.warn('Unknown pack price:', totalCents);
        return res.status(200).json({ message: 'Unknown pack, ignored' });
      }

      // Find agent by owner email
      const agent = await pool.query('SELECT id, balance FROM agents WHERE owner_email = $1', [email]);
      if (agent.rows.length === 0) {
        console.warn('No agent for email:', email);
        return res.status(200).json({ message: 'No agent found for email' });
      }

      const agentId = agent.rows[0].id;
      const claws = pack.claws;

      // Credit the agent
      await pool.query('UPDATE agents SET balance = balance + $1 WHERE id = $2', [claws, agentId]);
      const after = await pool.query('SELECT balance FROM agents WHERE id = $1', [agentId]);

      // Record transaction
      await pool.query(
        'INSERT INTO transactions (agent_id, type, amount, balance_after, reference_id, description) VALUES ($1, $2, $3, $4, $5, $6)',
        [agentId, 'credit_purchase', claws, after.rows[0].balance, orderId, `Purchased ${claws} Claws ($${pack.usd})`]
      );

      // Record purchase
      await pool.query(
        'INSERT INTO credit_purchases (agent_id, email, amount_usd, claws_amount, lemon_order_id) VALUES ($1, $2, $3, $4, $5)',
        [agentId, email, pack.usd * 100, claws, orderId]
      );

      console.log(`Credited ${claws} Claws to ${agentId} (order ${orderId})`);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
