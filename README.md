# AxionPCs — Full Setup Guide

## What you get
- Website (login/signup → dashboard showing your PCs → remote desktop viewer)
- Node.js backend server (auth, PC registry, VNC WebSocket proxy)
- Python agent (runs on your Windows PC, tunnels the VNC connection)

---

## PART 1 — Set up the Server (Linux VPS or home server)

Your server is what the website runs on. It needs to be reachable from the internet.
A cheap VPS (DigitalOcean, Linode, Vultr) works great — ~$5/month.
Or use your Linux spare computer with a domain/DDNS pointing to it.

### 1. Install Node.js
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Upload the project files
Copy the `axionpcs/` folder to your server (scp, git, whatever).

### 3. Install dependencies
```bash
cd axionpcs/backend
npm install
```

### 4. Set your secret key
```bash
export JWT_SECRET="some-long-random-string-here"
export PORT=3000
```

### 5. Install noVNC (the browser VNC client)
noVNC is what shows the remote desktop in the browser.
```bash
cd axionpcs
git clone https://github.com/novnc/noVNC.git
mv noVNC frontend/novnc
```

### 6. Start the server
```bash
cd backend
node server.js
```

Your site is now live at http://YOUR-SERVER-IP:3000

---

## PART 2 — Make it accessible from the internet (port forwarding / domain)

### Option A: VPS (easiest)
Your VPS already has a public IP. Just open port 3000 in your firewall:
```bash
sudo ufw allow 3000
```
Visit http://YOUR-VPS-IP:3000

### Option B: Home server with router port forwarding
1. Give your Linux server a static local IP (e.g. 192.168.1.50)
2. Log into your router → Port Forwarding → forward external port 3000 to 192.168.1.50:3000
3. Get your public IP from https://whatismyip.com
4. Optional: set up a free domain with DuckDNS (https://duckdns.org)

### Option C: Use ngrok (easiest for testing)
```bash
# Install ngrok, then:
ngrok http 3000
# You get a public URL like https://abc123.ngrok.io
```

---

## PART 3 — Set up HTTPS (required for noVNC + secure access)

### With Nginx + Let's Encrypt (recommended for VPS)
```bash
sudo apt install nginx certbot python3-certbot-nginx

# Create nginx config:
sudo nano /etc/nginx/sites-available/axionpcs
```

Paste this:
```nginx
server {
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/axionpcs /etc/nginx/sites-enabled/
sudo certbot --nginx -d yourdomain.com
sudo systemctl reload nginx
```

Now your site is at https://yourdomain.com ✓

---

## PART 4 — Install VNC on your Windows PC

noVNC needs a VNC server running on your Windows PC to show the desktop.

### Install TightVNC (free, recommended)
1. Download from: https://www.tightvnc.com/download.php
2. Install → choose "Full installation"
3. During install, set a **VNC Password** (you'll need this when connecting)
4. TightVNC Service starts automatically and runs in the background

Default port: **5900** ✓

---

## PART 5 — Run the Agent on your Windows PC

The agent connects your Windows PC to the AxionPCs server.
It works outbound (like Parsec/TeamViewer) — no port forwarding needed on your home router!

### 1. Install Python (if not already installed)
Download from https://python.org — check "Add to PATH" during install.

### 2. Install agent dependencies
```cmd
pip install websocket-client psutil
```

### 3. Get your agent token
- Log into AxionPCs on your website
- Click "Add PC" → copy the install command — it contains your token
- Or use the token shown after adding a PC

### 4. Run the agent
```cmd
python axion-agent.py --token YOUR_TOKEN_HERE --server https://yourdomain.com
```

You should see:
```
╔═══════════════════════════════════╗
║        AxionPCs Agent             ║
╠═══════════════════════════════════╣
║  Server : https://yourdomain.com  ║
║  VNC    : localhost:5900          ║
╚═══════════════════════════════════╝
[ws] Connected to server
[stats] CPU:3% RAM:42% Disk:67% IP:192.168.1.10
```

Your PC will show as **Online** in the dashboard! ✓

### 5. Auto-start agent on Windows boot (optional)
Create a batch file `start-axion.bat`:
```batch
@echo off
cd C:\path\to\agent
python axion-agent.py --token YOUR_TOKEN --server https://yourdomain.com
```
Press Win+R → `shell:startup` → paste a shortcut to the batch file there.

---

## PART 6 — Connect from anywhere!

1. Go to your website (https://yourdomain.com)
2. Log in with your account
3. Your PC shows as Online ✓
4. Click **Connect** → you see your Windows desktop in the browser
5. Use the toolbar: Ctrl+Alt+Del, Fullscreen, Sleep, Restart, Shutdown

---

## Architecture Overview

```
Your Browser
    │  HTTPS/WSS
    ▼
AxionPCs Server (VPS/Linux)
    │  WebSocket tunnel
    ▼
axion-agent.py (Windows PC)
    │  localhost TCP
    ▼
TightVNC Server (port 5900)
    │
    ▼
Your Windows Desktop
```

No port forwarding needed on your home router.
The agent makes an outbound connection to the server — just like Parsec.

---

## Troubleshooting

**PC shows Offline:**
- Make sure the agent is running on your Windows PC
- Check the agent output for error messages
- Make sure the server URL is correct (include https://)

**Black screen when connecting:**
- TightVNC must be running on your Windows PC (check System Tray)
- Try connecting with a VNC client first to confirm TightVNC works
- Check TightVNC isn't blocked by Windows Firewall

**Can't reach the server:**
- Check port forwarding / firewall rules
- Try `curl http://YOUR-IP:3000` from another machine

**noVNC not loading:**
- Make sure you cloned noVNC into `frontend/novnc/`
- Visit http://yourserver:3000/novnc/vnc.html directly to test
