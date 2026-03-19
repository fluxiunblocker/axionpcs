// AxionPCs Backend — server.js
// npm install express ws jsonwebtoken bcryptjs uuid cors mongoose

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const MONGO_URL = process.env.MONGO_URL || '';

// ─── MONGOOSE MODELS ─────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  id: { type: String, default: () => uuidv4() },
  username: { type: String, unique: true },
  email: { type: String, unique: true },
  password: String,
  createdAt: { type: Number, default: () => Date.now() },
});

const pcSchema = new mongoose.Schema({
  id: { type: String, default: () => uuidv4() },
  userId: String,
  name: String,
  os: String,
  agentToken: { type: String, default: () => uuidv4() },
  agentConnected: { type: Boolean, default: false },
  ip: { type: String, default: null },
  cpu: { type: Number, default: 0 },
  ram: { type: Number, default: 0 },
  disk: { type: Number, default: 0 },
  createdAt: { type: Number, default: () => Date.now() },
});

const User = mongoose.model('User', userSchema);
const PC = mongoose.model('PC', pcSchema);

// ─── MIDDLEWARE ───────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

const frontendPath = fs.existsSync(path.join(__dirname, 'index.html'))
  ? __dirname : path.join(__dirname, 'frontend');
app.use(express.static(frontendPath));

const novncPath = path.join(__dirname, 'novnc');
if (fs.existsSync(novncPath)) app.use('/novnc', express.static(novncPath));

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ─── AUTH ROUTES ──────────────────────────────────────────────────
app.post('/api/signup', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });
  if (await User.findOne({ $or: [{ username }, { email }] }))
    return res.status(409).json({ error: 'Username or email already taken' });
  const hash = await bcrypt.hash(password, 10);
  const user = await User.create({ username, email, password: hash });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ $or: [{ username }, { email: username }] });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
});

// ─── PC ROUTES ────────────────────────────────────────────────────
app.get('/api/pcs', authMiddleware, async (req, res) => {
  const pcs = await PC.find({ userId: req.user.id });
  res.json(pcs.map(p => ({
    id: p.id, name: p.name, os: p.os,
    ip: p.ip, status: p.agentConnected ? 'online' : 'offline',
    cpu: p.cpu, ram: p.ram, disk: p.disk,
  })));
});

app.post('/api/pcs', authMiddleware, async (req, res) => {
  const { name, os } = req.body;
  if (!name || !os) return res.status(400).json({ error: 'Missing fields' });
  const pc = await PC.create({ userId: req.user.id, name, os });
  res.json({ id: pc.id, agentToken: pc.agentToken });
});

app.delete('/api/pcs/:id', authMiddleware, async (req, res) => {
  await PC.deleteOne({ id: req.params.id, userId: req.user.id });
  res.json({ ok: true });
});

app.post('/api/pcs/:id/power', authMiddleware, async (req, res) => {
  const { action } = req.body;
  const pc = await PC.findOne({ id: req.params.id, userId: req.user.id });
  if (!pc) return res.status(404).json({ error: 'Not found' });
  const ctrlWs = agentConnections.get(pc.id + ':ctrl');
  if (!ctrlWs || ctrlWs.readyState !== WebSocket.OPEN)
    return res.status(503).json({ error: 'Agent not connected' });
  ctrlWs.send(JSON.stringify({ type: 'power', action }));
  res.json({ ok: true });
});

// ─── WEBSOCKET ────────────────────────────────────────────────────
const agentConnections = new Map();
const vncQueue = new Map();
const wss = new WebSocket.Server({ server });

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/agent-ws') {
    const agentToken = url.searchParams.get('token');
    const mode = url.searchParams.get('mode') || 'control';
    const pc = await PC.findOne({ agentToken });
    if (!pc) { ws.close(4001, 'Invalid token'); return; }

    if (mode === 'control') {
      pc.agentConnected = true; await pc.save();
      agentConnections.set(pc.id + ':ctrl', ws);
      console.log(`[ctrl] "${pc.name}" connected`);

      ws.on('message', async msg => {
        try {
          const d = JSON.parse(msg);
          if (d.type === 'stats') {
            await PC.updateOne({ id: pc.id }, { cpu: d.cpu, ram: d.ram, disk: d.disk, ip: d.ip, agentConnected: true });
          }
        } catch { }
      });

      ws.on('close', async () => {
        agentConnections.delete(pc.id + ':ctrl');
        await PC.updateOne({ id: pc.id }, { agentConnected: false });
        console.log(`[ctrl] "${pc.name}" disconnected`);
      });

    } else {
      agentConnections.set(pc.id, ws);
      console.log(`[vnc] "${pc.name}" tunnel connected`);
      if (vncQueue.has(pc.id)) {
        for (const bws of vncQueue.get(pc.id)) bridgeWS(bws, ws);
        vncQueue.delete(pc.id);
      }
      ws.on('close', () => { agentConnections.delete(pc.id); });
    }
    return;
  }

  const vncMatch = pathname.match(/^\/vnc-ws\/([a-f0-9-]+)/);
  if (vncMatch) {
    const pcId = vncMatch[1];

    // Tell the agent's control channel to open a VNC tunnel NOW
    const ctrlWs = agentConnections.get(pcId + ':ctrl');
    if (ctrlWs && ctrlWs.readyState === WebSocket.OPEN) {
      ctrlWs.send(JSON.stringify({ type: 'connect_vnc' }));
    }

    // Wait up to 8 seconds for the agent to open the VNC tunnel
    const tryBridge = (attempts) => {
      const agentWs = agentConnections.get(pcId);
      if (agentWs && agentWs.readyState === WebSocket.OPEN) {
        bridgeWS(ws, agentWs);
      } else if (attempts > 0 && ws.readyState === WebSocket.OPEN) {
        setTimeout(() => tryBridge(attempts - 1), 500);
      } else {
        if (ws.readyState === WebSocket.OPEN) ws.close(4002, 'Agent timeout');
      }
    };
    setTimeout(() => tryBridge(16), 300); // try for 8 seconds
  }
});

function bridgeWS(a, b) {
  a.on('message', (data, isBinary) => { if (b.readyState === WebSocket.OPEN) b.send(data, { binary: isBinary }); });
  b.on('message', (data, isBinary) => { if (a.readyState === WebSocket.OPEN) a.send(data, { binary: isBinary }); });
  a.on('close', () => { try { b.close(4003, 'Peer closed'); } catch { } });
  b.on('close', () => { try { a.close(4003, 'Agent disconnected'); } catch { } });
}

// ─── FALLBACK ─────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/agent/'))
    return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// ─── START ────────────────────────────────────────────────────────
async function start() {
  if (MONGO_URL) {
    await mongoose.connect(MONGO_URL);
    console.log('[db] Connected to MongoDB');
  } else {
    console.warn('[db] No MONGO_URL set — running without database (data will not persist)');
  }
  server.listen(PORT, () => {
    console.log(`\n✦ AxionPCs running on http://localhost:${PORT}\n`);
  });
}
start();