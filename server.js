// AxionPCs Backend — server.js
// npm install express ws jsonwebtoken bcryptjs uuid cors

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const net = require('net');

const app = express();
const server = http.createServer(app);

// ─── CONFIG ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const DATA_FILE = path.join(__dirname, 'data.json');

// ─── MIDDLEWARE ───────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

const frontendPath = fs.existsSync(path.join(__dirname, 'index.html'))
  ? __dirname
  : path.join(__dirname, 'frontend');
app.use(express.static(frontendPath));

// ─── DATABASE ─────────────────────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DATA_FILE)) return { users: [], pcs: [] };
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function saveDB(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

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
  const db = loadDB();
  if (db.users.find(u => u.username === username || u.email === email))
    return res.status(409).json({ error: 'Username or email already taken' });
  const hash = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), username, email, password: hash, createdAt: Date.now() };
  db.users.push(user);
  saveDB(db);
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const db = loadDB();
  const user = db.users.find(u => u.username === username || u.email === username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
});

// ─── PC ROUTES ────────────────────────────────────────────────────
app.get('/api/pcs', authMiddleware, (req, res) => {
  const db = loadDB();
  const userPCs = db.pcs
    .filter(p => p.userId === req.user.id)
    .map(p => ({
      id: p.id, name: p.name, os: p.os,
      ip: p.ip || null, vnc_port: p.vnc_port || null,
      status: p.agentConnected ? 'online' : 'offline',
      cpu: p.cpu || 0, ram: p.ram || 0, disk: p.disk || 0,
    }));
  res.json(userPCs);
});

app.post('/api/pcs', authMiddleware, (req, res) => {
  const { name, os } = req.body;
  if (!name || !os) return res.status(400).json({ error: 'Missing fields' });
  const db = loadDB();
  const pc = {
    id: uuidv4(), userId: req.user.id, name, os,
    agentToken: uuidv4(), agentConnected: false,
    sleeping: false, ip: null, vnc_port: null,
    cpu: 0, ram: 0, disk: 0, createdAt: Date.now(),
  };
  db.pcs.push(pc);
  saveDB(db);
  res.json({ id: pc.id, agentToken: pc.agentToken });
});

app.delete('/api/pcs/:id', authMiddleware, (req, res) => {
  const db = loadDB();
  const idx = db.pcs.findIndex(p => p.id === req.params.id && p.userId === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.pcs.splice(idx, 1);
  saveDB(db);
  res.json({ ok: true });
});

app.post('/api/pcs/:id/power', authMiddleware, (req, res) => {
  const { action } = req.body;
  const pc = loadDB().pcs.find(p => p.id === req.params.id && p.userId === req.user.id);
  if (!pc) return res.status(404).json({ error: 'Not found' });
  const agentWs = agentConnections.get(pc.id + ':ctrl');
  if (!agentWs || agentWs.readyState !== WebSocket.OPEN)
    return res.status(503).json({ error: 'Agent not connected' });
  agentWs.send(JSON.stringify({ type: 'power', action }));
  res.json({ ok: true });
});

// ─── WEBSOCKET SERVER ─────────────────────────────────────────────
// agentConnections: pcId:ctrl -> WS (control)
//                  pcId       -> WS (vnc tunnel from agent)
const agentConnections = new Map();
const vncQueue = new Map();

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // ── AGENT ──
  if (pathname === '/agent-ws') {
    const agentToken = url.searchParams.get('token');
    const mode = url.searchParams.get('mode') || 'control';
    const db = loadDB();
    const pc = db.pcs.find(p => p.agentToken === agentToken);
    if (!pc) { ws.close(4001, 'Invalid token'); return; }

    if (mode === 'control') {
      console.log(`[agent] "${pc.name}" control connected`);
      pc.agentConnected = true; saveDB(db);
      agentConnections.set(pc.id + ':ctrl', ws);

      ws.on('message', msg => {
        try {
          const d = JSON.parse(msg);
          if (d.type === 'stats') {
            const db2 = loadDB();
            const pc2 = db2.pcs.find(p => p.id === pc.id);
            if (pc2) {
              pc2.cpu = d.cpu; pc2.ram = d.ram;
              pc2.disk = d.disk; pc2.ip = d.ip;
              pc2.agentConnected = true;
              saveDB(db2);
            }
          }
        } catch { }
      });

      ws.on('close', () => {
        agentConnections.delete(pc.id + ':ctrl');
        const db2 = loadDB();
        const pc2 = db2.pcs.find(p => p.id === pc.id);
        if (pc2) { pc2.agentConnected = false; saveDB(db2); }
        console.log(`[agent] "${pc.name}" control disconnected`);
      });

    } else {
      // VNC tunnel from agent
      console.log(`[agent] "${pc.name}" VNC tunnel connected`);
      agentConnections.set(pc.id, ws);

      if (vncQueue.has(pc.id)) {
        for (const browserWs of vncQueue.get(pc.id)) bridgeWS(browserWs, ws);
        vncQueue.delete(pc.id);
      }

      ws.on('close', () => {
        agentConnections.delete(pc.id);
        console.log(`[agent] "${pc.name}" VNC tunnel disconnected`);
      });
    }
    return;
  }

  // ── BROWSER (noVNC) via /vnc-ws/:pcId ──
  const vncMatch = pathname.match(/^\/vnc-ws\/([a-f0-9-]+)/);
  if (vncMatch) {
    const pcId = vncMatch[1];
    const isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    if (!isLocal) {
      const t = url.searchParams.get('token') || '';
      try { jwt.verify(t, JWT_SECRET); } catch { ws.close(4001, 'Unauthorized'); return; }
    }

    const db = loadDB();
    const pc = db.pcs.find(p => p.id === pcId);
    if (!pc) { ws.close(4004, 'PC not found'); return; }

    // Use websockify proxy: connect directly to TightVNC via TCP
    // The agent reports its local IP — we connect through the agent's VNC tunnel WS
    const agentVncWs = agentConnections.get(pcId);
    if (agentVncWs && agentVncWs.readyState === WebSocket.OPEN) {
      bridgeWS(ws, agentVncWs);
    } else {
      if (!vncQueue.has(pcId)) vncQueue.set(pcId, []);
      vncQueue.get(pcId).push(ws);
      setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.close(4002, 'Agent timeout'); }, 15000);
    }
    return;
  }
});

// Bridge two WebSockets bidirectionally (binary + text)
function bridgeWS(a, b) {
  a.on('message', (data, isBinary) => {
    if (b.readyState === WebSocket.OPEN) b.send(data, { binary: isBinary });
  });
  b.on('message', (data, isBinary) => {
    if (a.readyState === WebSocket.OPEN) a.send(data, { binary: isBinary });
  });
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
server.listen(PORT, () => {
  console.log(`\n✦ AxionPCs running on http://localhost:${PORT}\n`);
});