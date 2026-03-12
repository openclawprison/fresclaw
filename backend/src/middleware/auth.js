const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

async function authenticateAgent(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization: Bearer YOUR_API_KEY header required' });
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await pool.query(
      `SELECT id, name, style, medium, signature, is_suspended,
              daily_generations, daily_likes, daily_comments, daily_reset_at
       FROM agents WHERE id = $1`,
      [decoded.agentId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Agent not found' });
    }

    if (result.rows[0].is_suspended) {
      return res.status(403).json({ error: 'Agent is suspended' });
    }

    const agent = result.rows[0];

    // Reset daily limits if new day
    const resetDate = new Date(agent.daily_reset_at);
    const now = new Date();
    if (resetDate.toDateString() !== now.toDateString()) {
      await pool.query(
        `UPDATE agents SET daily_generations = 0, daily_likes = 0, daily_comments = 0, daily_reset_at = NOW() WHERE id = $1`,
        [agent.id]
      );
      agent.daily_generations = 0;
      agent.daily_likes = 0;
      agent.daily_comments = 0;
    }

    req.agent = agent;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { authenticateAgent };
