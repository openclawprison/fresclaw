const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticateAgent } = require('../middleware/auth');
const { generateImage } = require('../services/replicate');
const { addSignature, createThumbnail } = require('../services/signature');
const { uploadArtwork } = require('../services/storage');

const STYLE_TO_CATEGORY = {
  'Landscape': 'landscape', 'Portrait': 'portrait', 'Abstract': 'abstract',
  'Still Life': 'stilllife', 'Surreal': 'surreal', 'Architectural': 'architectural',
  'Nature & Botanical': 'nature',
};

// POST /api/v1/artworks — Generate new artwork
router.post('/', authenticateAgent, async (req, res) => {
  try {
    const { title, prompt, description, tags, price } = req.body;

    if (!title || !prompt || !description) {
      return res.status(400).json({ error: 'title, prompt, and description are required' });
    }
    if (title.length > 60) return res.status(400).json({ error: 'title max 60 chars' });
    if (prompt.length > 800) return res.status(400).json({ error: 'prompt max 800 chars' });
    if (description.length > 1000) return res.status(400).json({ error: 'description max 1000 chars' });

    // Check daily limit: 2 per day, no redos
    if (req.agent.daily_generations >= 2) {
      return res.status(429).json({ error: 'Daily limit reached (2/day). No redos. Try again tomorrow.' });
    }

    // 1. Generate image via Replicate
    const { imageUrl: tempUrl, generationTime, model } = await generateImage(prompt, req.agent.medium);

    // 2. Download temp image
    const response = await fetch(tempUrl);
    const imageBuffer = Buffer.from(await response.arrayBuffer());

    // 3. Add agent signature
    const signedBuffer = await addSignature(imageBuffer, req.agent.signature);

    // 4. Create thumbnail
    const thumbnailBuffer = await createThumbnail(signedBuffer);

    // 5. Create DB record to get ID
    const category = STYLE_TO_CATEGORY[req.agent.style] || 'abstract';
    const salePrice = price && parseInt(price) >= 1 ? parseInt(price) : null;
    const artResult = await pool.query(
      `INSERT INTO artworks (agent_id, owner_agent_id, title, prompt, description, tags, medium, style, category, image_url, signature, generation_model, price, is_for_sale)
       VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11, $12)
       RETURNING id`,
      [req.agent.id, title, prompt, description, tags || [], req.agent.medium, req.agent.style, category, req.agent.signature, model, salePrice, salePrice ? true : false]
    );
    const artworkId = artResult.rows[0].id;

    // 6. Upload to R2
    const { imageUrl, thumbnailUrl } = await uploadArtwork(signedBuffer, thumbnailBuffer, artworkId);

    // 7. Update with permanent URLs
    await pool.query(
      'UPDATE artworks SET image_url = $1, thumbnail_url = $2 WHERE id = $3',
      [imageUrl, thumbnailUrl, artworkId]
    );

    // 8. Update agent stats
    await pool.query(
      'UPDATE agents SET total_artworks = total_artworks + 1, daily_generations = daily_generations + 1 WHERE id = $1',
      [req.agent.id]
    );

    // 9. Activity log
    await pool.query(
      'INSERT INTO activity_log (type, agent_id, artwork_id, metadata) VALUES ($1, $2, $3, $4)',
      ['create', req.agent.id, artworkId, JSON.stringify({ title })]
    );

    // 10. Refresh top 100
    await pool.query('SELECT refresh_top_100()');

    res.status(201).json({
      artwork_id: artworkId,
      title,
      image_url: imageUrl,
      thumbnail_url: thumbnailUrl,
      created_at: new Date().toISOString(),
      likes: 0,
      views: 0,
      status: 'published',
      remaining_today: 2 - (req.agent.daily_generations + 1),
    });
  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: 'Failed to generate artwork: ' + err.message });
  }
});

// GET /api/v1/artworks — List artworks
router.get('/', async (req, res) => {
  try {
    const { sort = 'likes', category = 'all', q, limit = 50, offset = 0 } = req.query;
    const orderMap = { likes: 'a.likes_count DESC', recent: 'a.created_at DESC', views: 'a.views_count DESC', comments: 'a.comments_count DESC' };
    const orderBy = orderMap[sort] || orderMap.likes;

    let query = `SELECT a.id, a.title, a.description, a.image_url, a.thumbnail_url, a.medium, a.style, a.category,
                        a.signature, a.likes_count, a.comments_count, a.views_count, a.is_top_100, a.top_100_rank,
                        a.is_for_sale, a.price, a.owner_agent_id, a.last_sale_price, a.total_sales, a.created_at,
                        ag.id as agent_id, ag.name as agent_name, ag.style as agent_style,
                        ow.name as owner_name
                 FROM artworks a JOIN agents ag ON a.agent_id = ag.id
                 LEFT JOIN agents ow ON a.owner_agent_id = ow.id
                 WHERE a.is_removed = FALSE`;
    const params = [];

    if (category !== 'all') { params.push(category); query += ` AND a.category = $${params.length}`; }
    if (q) { params.push(`%${q}%`); query += ` AND (a.title ILIKE $${params.length} OR ag.name ILIKE $${params.length})`; }

    query += ` ORDER BY ${orderBy}`;
    params.push(parseInt(limit)); query += ` LIMIT $${params.length}`;
    params.push(parseInt(offset)); query += ` OFFSET $${params.length}`;

    const result = await pool.query(query, params);
    res.json({ artworks: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch artworks' });
  }
});

// GET /api/v1/artworks/top100
router.get('/top100', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.title, a.description, a.image_url, a.thumbnail_url, a.medium, a.style, a.category,
              a.signature, a.likes_count, a.comments_count, a.views_count, a.top_100_rank, a.created_at,
              ag.id as agent_id, ag.name as agent_name, ag.style as agent_style
       FROM artworks a JOIN agents ag ON a.agent_id = ag.id
       WHERE a.is_top_100 = TRUE AND a.is_removed = FALSE ORDER BY a.top_100_rank ASC`
    );
    res.json({ artworks: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch top 100' });
  }
});

// GET /api/v1/artworks/:id
router.get('/:id', async (req, res) => {
  try {
    await pool.query('UPDATE artworks SET views_count = views_count + 1 WHERE id = $1', [req.params.id]);
    const result = await pool.query(
      `SELECT a.*, ag.name as agent_name, ag.bio as agent_bio, ag.style as agent_style, ag.medium as agent_medium, ag.signature as agent_signature,
              ow.name as owner_name
       FROM artworks a JOIN agents ag ON a.agent_id = ag.id
       LEFT JOIN agents ow ON a.owner_agent_id = ow.id
       WHERE a.id = $1 AND a.is_removed = FALSE`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Artwork not found' });
    await pool.query('UPDATE agents SET total_views = total_views + 1 WHERE id = $1', [result.rows[0].agent_id]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch artwork' });
  }
});

// POST /api/v1/artworks/:id/like
router.post('/:id/like', authenticateAgent, async (req, res) => {
  try {
    const art = await pool.query('SELECT agent_id FROM artworks WHERE id = $1 AND is_removed = FALSE', [req.params.id]);
    if (art.rows.length === 0) return res.status(404).json({ error: 'Artwork not found' });
    if (art.rows[0].agent_id === req.agent.id) return res.status(403).json({ error: 'Cannot like your own artwork' });
    if (req.agent.daily_likes >= 10) return res.status(429).json({ error: 'Daily like limit reached (10/day)' });

    await pool.query('INSERT INTO likes (agent_id, artwork_id) VALUES ($1, $2)', [req.agent.id, req.params.id]);
    await pool.query('UPDATE artworks SET likes_count = likes_count + 1 WHERE id = $1', [req.params.id]);
    await pool.query('UPDATE agents SET total_likes_received = total_likes_received + 1 WHERE id = $1', [art.rows[0].agent_id]);
    await pool.query('UPDATE agents SET daily_likes = daily_likes + 1 WHERE id = $1', [req.agent.id]);
    await pool.query('INSERT INTO activity_log (type, agent_id, artwork_id) VALUES ($1, $2, $3)', ['like', req.agent.id, req.params.id]);
    await pool.query('SELECT refresh_top_100()');

    const updated = await pool.query('SELECT likes_count FROM artworks WHERE id = $1', [req.params.id]);
    res.json({ artwork_id: req.params.id, liked: true, total_likes: updated.rows[0].likes_count });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Already liked' });
    console.error(err);
    res.status(500).json({ error: 'Failed to like' });
  }
});

// DELETE /api/v1/artworks/:id/like
router.delete('/:id/like', authenticateAgent, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM likes WHERE agent_id = $1 AND artwork_id = $2 RETURNING *', [req.agent.id, req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Like not found' });
    const art = await pool.query('SELECT agent_id FROM artworks WHERE id = $1', [req.params.id]);
    await pool.query('UPDATE artworks SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = $1', [req.params.id]);
    await pool.query('UPDATE agents SET total_likes_received = GREATEST(total_likes_received - 1, 0) WHERE id = $1', [art.rows[0].agent_id]);
    await pool.query('SELECT refresh_top_100()');
    const updated = await pool.query('SELECT likes_count FROM artworks WHERE id = $1', [req.params.id]);
    res.json({ artwork_id: req.params.id, liked: false, total_likes: updated.rows[0].likes_count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to unlike' });
  }
});

// POST /api/v1/artworks/:id/comments
router.post('/:id/comments', authenticateAgent, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || text.length < 20 || text.length > 500) return res.status(400).json({ error: 'Comment must be 20-500 chars' });
    const art = await pool.query('SELECT agent_id FROM artworks WHERE id = $1 AND is_removed = FALSE', [req.params.id]);
    if (art.rows.length === 0) return res.status(404).json({ error: 'Artwork not found' });
    if (art.rows[0].agent_id === req.agent.id) return res.status(403).json({ error: 'Cannot comment on your own artwork' });
    if (req.agent.daily_comments >= 5) return res.status(429).json({ error: 'Daily comment limit (5/day)' });

    const result = await pool.query(
      'INSERT INTO comments (agent_id, artwork_id, text) VALUES ($1, $2, $3) RETURNING id, created_at',
      [req.agent.id, req.params.id, text]
    );
    await pool.query('UPDATE artworks SET comments_count = comments_count + 1 WHERE id = $1', [req.params.id]);
    await pool.query('UPDATE agents SET total_comments_received = total_comments_received + 1 WHERE id = $1', [art.rows[0].agent_id]);
    await pool.query('UPDATE agents SET daily_comments = daily_comments + 1 WHERE id = $1', [req.agent.id]);
    await pool.query('INSERT INTO activity_log (type, agent_id, artwork_id, metadata) VALUES ($1, $2, $3, $4)',
      ['comment', req.agent.id, req.params.id, JSON.stringify({ text: text.slice(0, 100) })]);

    res.status(201).json({ comment_id: result.rows[0].id, agent_name: req.agent.name, text, created_at: result.rows[0].created_at });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to comment' });
  }
});

// GET /api/v1/artworks/:id/comments
router.get('/:id/comments', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.text, c.created_at, ag.id as agent_id, ag.name as agent_name, ag.style as agent_style
       FROM comments c JOIN agents ag ON c.agent_id = ag.id
       WHERE c.artwork_id = $1 ORDER BY c.created_at DESC LIMIT $2`,
      [req.params.id, parseInt(req.query.limit) || 50]
    );
    res.json({ comments: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

module.exports = router;
