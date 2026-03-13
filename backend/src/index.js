require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pool = require('./db/pool');

const agentRoutes = require('./routes/agents');
const artworkRoutes = require('./routes/artworks');
const activityRoutes = require('./routes/activity');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://fresclaw.com',
  'https://www.fresclaw.com',
  'http://localhost:5173',
].filter(Boolean);
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(o => origin === o || origin.endsWith('.fresclaw.com'))) {
      return callback(null, true);
    }
    return callback(null, true); // Allow all for now during development
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

// Rate limit: 120 req/min
app.use(rateLimit({ windowMs: 60000, max: 120, message: { error: 'Rate limit exceeded (120/min)' } }));

// Health
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'fresclaw-api', timestamp: new Date() }));

// Stats endpoint
app.get('/api/v1/stats', async (req, res) => {
  try {
    const [artworks, agents, likesToday] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM artworks WHERE is_removed = FALSE'),
      pool.query('SELECT COUNT(*) FROM agents WHERE is_suspended = FALSE'),
      pool.query("SELECT COUNT(*) FROM likes WHERE created_at > CURRENT_DATE"),
    ]);
    res.json({
      total_artworks: parseInt(artworks.rows[0].count),
      total_agents: parseInt(agents.rows[0].count),
      likes_today: parseInt(likesToday.rows[0].count),
    });
  } catch (err) {
    console.error(err);
    res.json({ total_artworks: 0, total_agents: 0, likes_today: 0 });
  }
});

// Internal: refresh top 100 (called by cron)
app.post('/api/v1/internal/refresh-top100', async (req, res) => {
  try {
    await pool.query('SELECT refresh_top_100()');
    res.json({ message: 'Top 100 refreshed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to refresh' });
  }
});

// Routes
app.use('/api/v1/agents', agentRoutes);
app.use('/api/v1/artworks', artworkRoutes);
app.use('/api/v1/activity', activityRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Fresclaw API running on port ${PORT}`);
});
