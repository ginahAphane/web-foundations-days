// TicketHub - Final Working Code - Day 8
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/tickethub'
});

// GET /api/events
app.get('/api/events', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM events ORDER BY start_time');
  res.json(rows);
});

// GET /api/events/:id
app.get('/api/events/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM events WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

// GET /api/events/:id/seats
app.get('/api/events/:id/seats', async (req, res) => {
  const { rows } = await pool.query('SELECT id, label, section, status FROM seats WHERE event_id=$1 ORDER BY label LIMIT 500', [req.params.id]);
  res.json(rows);
});

// POST /api/events/:eventId/holds - ATOMIC PROTECTION
app.post('/api/events/:eventId/holds', async (req, res) => {
  const { seatIds, userId } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT id, status FROM seats WHERE id = ANY($1) AND event_id=$2 FOR UPDATE', [seatIds, req.params.eventId]);
    if (locked.rows.length!== seatIds.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Seat not found' });
    }
    if (locked.rows.some(r => r.status!== 'AVAILABLE')) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Already held/sold' });
    }
    const holdId = require('crypto').randomUUID();
    const expiresAt = new Date(Date.now() + 10*60*1000);
    await client.query('INSERT INTO holds (id, user_id, event_id, expires_at) VALUES ($1,$2,$3,$4)', [holdId, userId, req.params.eventId, expiresAt]);
    const upd = await client.query("UPDATE seats SET status='HELD', hold_id=$1, version=version+1 WHERE id = ANY($2) AND status='AVAILABLE'", [holdId, seatIds]);
    if (upd.rowCount!== seatIds.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Race condition' });
    }
    for (const sid of seatIds) await client.query('INSERT INTO hold_seats (hold_id, seat_id) VALUES ($1,$2)', [holdId, sid]);
    await client.query('COMMIT');
    res.status(201).json({ holdId, expiresAt });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// POST /api/orders
app.post('/api/orders', async (req, res) => {
  const { holdId } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query("SELECT * FROM holds WHERE id=$1 AND status='ACTIVE' FOR UPDATE", [holdId]);
    if (!rows[0] || new Date(rows[0].expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Hold expired' });
    }
    await client.query("UPDATE seats SET status='SOLD' WHERE hold_id=$1", [holdId]);
    await client.query("UPDATE holds SET status='CONVERTED' WHERE id=$1", [holdId]);
    const orderId = require('crypto').randomUUID();
    await client.query('INSERT INTO orders (id, user_id, event_id, hold_id, total_amount) VALUES ($1,$2,$3,$4,$5)', [orderId, rows[0].user_id, rows[0].event_id, holdId, 10000]);
    await client.query('COMMIT');
    res.status(201).json({ orderId, status: 'PAID' });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

app.get('/api/users/me/orders', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM orders WHERE user_id=$1', [req.query.user_id]);
  res.json(rows);
});

app.delete('/api/holds/:id', async (req, res) => {
  await pool.query("UPDATE seats SET status='AVAILABLE', hold_id=NULL WHERE hold_id=$1", [req.params.id]);
  await pool.query("UPDATE holds SET status='EXPIRED' WHERE id=$1", [req.params.id]);
  res.json({ released: true });
});

app.listen(3000, () => console.log('TicketHub http://localhost:3000'));