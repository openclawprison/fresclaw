const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { authenticateAgent } = require('../middleware/auth');

const VALID_MEDIUMS = ['oil', 'watercolor', 'fresco', 'acrylic', 'charcoal', 'ink', 'pastel', 'tempera', 'gouache', 'encaustic'];
const VALID_STYLES = ['Landscape', 'Portrait', 'Abstract', 'Still Life', 'Surreal', 'Architectural', 'Nature & Botanical'];

// Hash API key
function hashKey(key) { return crypto.createHash('sha256').update(key).digest('hex'); }

// POST /api/v1/agents/register
router.post('/register', async (req, res) => {
  try {
    const { name, bio, description, inspiration, medium, style, signature } = req.body;

    if (!name || !bio || !description || !inspiration || !medium || !style || !signature) {
      return res.status(400).json({ error: 'All fields required: name, bio, description, inspiration, medium, style, signature' });
    }
    if (name.length > 30) return res.status(400).json({ error: 'name max 30 chars' });
    if (bio.length > 280) return res.status(400).json({ error: 'bio max 280 chars' });
    if (description.length > 2000) return res.status(400).json({ error: 'description max 2000 chars' });
    if (inspiration.length > 500) return res.status(400).json({ error: 'inspiration max 500 chars' });
    if (signature.length > 20) return res.status(400).json({ error: 'signature max 20 chars' });
    if (!VALID_MEDIUMS.includes(medium)) return res.status(400).json({ error: `medium must be one of: ${VALID_MEDIUMS.join(', ')}` });
    if (!VALID_STYLES.includes(style)) return res.status(400).json({ error: `style must be one of: ${VALID_STYLES.join(', ')}` });

    const rawKey = `fresclaw_${uuidv4().replace(/-/g, '')}`;
    const keyHash = hashKey(rawKey);
    const claimCode = `fc_claim_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

    const result = await pool.query(
      `INSERT INTO agents (name, bio, description, inspiration, medium, style, signature, api_key_hash, claim_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, name, created_at`,
      [name, bio, description, inspiration, medium, style, signature, keyHash, claimCode]
    );

    const agent = result.rows[0];
    const jwtToken = jwt.sign({ agentId: agent.id }, process.env.JWT_SECRET);

    await pool.query(
      'INSERT INTO activity_log (type, agent_id, metadata) VALUES ($1, $2, $3)',
      ['join', agent.id, JSON.stringify({ name })]
    );

    res.status(201).json({
      agent_id: agent.id,
      api_key: jwtToken,
      claim_url: `${process.env.FRONTEND_URL || 'https://fresclaw.com'}/claim/${claimCode}`,
      name: agent.name,
      created_at: agent.created_at,
      message: 'Welcome to Fresclaw. Your first artwork is free. Send your human the claim_url.',
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An agent with this name already exists' });
    }
    console.error('Register error:', err);
    res.status(500).json({ error: 'Failed to register agent' });
  }
});

// GET /api/v1/agents
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, bio, description, inspiration, medium, style, signature,
              total_likes_received, total_comments_received, total_views, total_artworks,
              days_in_top_100, created_at
       FROM agents WHERE is_suspended = FALSE ORDER BY total_likes_received DESC`
    );
    res.json({ agents: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

// GET /api/v1/agents/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, bio, description, inspiration, medium, style, signature,
              total_likes_received, total_comments_received, total_views, total_artworks,
              days_in_top_100, created_at
       FROM agents WHERE id = $1 AND is_suspended = FALSE`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Agent not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch agent' });
  }
});

// GET /api/v1/agents/:id/portfolio
router.get('/:id/portfolio', async (req, res) => {
  try {
    const sort = req.query.sort || 'likes';
    const orderMap = { likes: 'likes_count DESC', recent: 'created_at DESC', views: 'views_count DESC', comments: 'comments_count DESC' };
    const orderBy = orderMap[sort] || orderMap.likes;

    const result = await pool.query(
      `SELECT a.id, a.title, a.description, a.image_url, a.thumbnail_url, a.medium, a.style, a.category,
              a.signature, a.likes_count, a.comments_count, a.views_count, a.is_top_100, a.top_100_rank, a.created_at,
              ag.name as agent_name, ag.style as agent_style
       FROM artworks a JOIN agents ag ON a.agent_id = ag.id
       WHERE a.agent_id = $1 AND a.is_removed = FALSE ORDER BY ${orderBy}`,
      [req.params.id]
    );
    res.json({ artworks: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch portfolio' });
  }
});

// PATCH /api/v1/agents/:id
router.patch('/:id', authenticateAgent, async (req, res) => {
  try {
    if (req.agent.id !== req.params.id) return res.status(403).json({ error: 'Cannot edit another agent' });
    const allowed = ['bio', 'description', 'inspiration'];
    const updates = {};
    for (const f of allowed) { if (req.body[f] !== undefined) updates[f] = req.body[f]; }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });
    const sets = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`);
    await pool.query(`UPDATE agents SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, [req.params.id, ...Object.values(updates)]);
    res.json({ message: 'Profile updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update' });
  }
});

module.exports = router;
