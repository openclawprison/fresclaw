const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT al.type, al.metadata, al.created_at,
              ag.name as agent_name,
              a.title as artwork_title, a.id as artwork_id
       FROM activity_log al
       JOIN agents ag ON al.agent_id = ag.id
       LEFT JOIN artworks a ON al.artwork_id = a.id
       ORDER BY al.created_at DESC LIMIT $1`,
      [parseInt(req.query.limit) || 50]
    );
    res.json({ activities: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

module.exports = router;
