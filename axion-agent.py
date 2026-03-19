#!/usr/bin/env python3
"""
AxionPCs Agent — uses websockify to bridge VNC properly
pip install websocket-client psutil websockify
python axion-agent.py --token YOUR_TOKEN --server http://localhost:3000
"""
import argparse, json, socket, sys, threading, time, subprocess, platform, os

try: import psutil
except ImportError: print("[!] pip install psutil"); sys.exit(1)
try: import websocket
except ImportError: print("[!] pip install websocket-client"); sys.exit(1)

VNC_HOST       = "127.0.0.1"
VNC_PORT       = 5900
WEBSOCKIFY_PORT = 15900   # local port websockify listens on
STATS_INTERVAL = 10
RECONNECT      = 5
running        = True
websockify_proc = None

def get_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80)); ip = s.getsockname()[0]; s.close(); return ip
    except: return "unknown"

def execute_power(action):
    print(f"[power] {action}")
    if platform.system() == "Windows":
        cmds = {"shutdown":["shutdown","/s","/t","5"],
                "restart": ["shutdown","/r","/t","5"],
                "sleep":   ["rundll32.exe","powrprof.dll,SetSuspendState","0,1,0"]}
    else:
        cmds = {"shutdown":["sudo","shutdown","-h","now"],
                "restart": ["sudo","shutdown","-r","now"],
                "sleep":   ["systemctl","suspend"]}
    cmd = cmds.get(action)
    if cmd: subprocess.Popen(cmd)

def start_websockify():
    """Start websockify to bridge WebSocket -> TightVNC TCP"""
    global websockify_proc
    print(f"[ws4y] Starting websockify on port {WEBSOCKIFY_PORT} -> {VNC_HOST}:{VNC_PORT}")
    try:
        websockify_proc = subprocess.Popen(
            [sys.executable, "-m", "websockify", str(WEBSOCKIFY_PORT), f"{VNC_HOST}:{VNC_PORT}"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        time.sleep(1)
        print(f"[ws4y] websockify running (pid {websockify_proc.pid})")
        return True
    except Exception as e:
        print(f"[ws4y] Failed to start websockify: {e}")
        return False

def stop_websockify():
    global websockify_proc
    if websockify_proc:
        try: websockify_proc.terminate()
        except: pass
        websockify_proc = None

# ══════════════════════════════════════
# CONTROL CONNECTION (stats + power)
# ══════════════════════════════════════
def run_control(server, token):
    ws_url = server.replace("https://","wss://").replace("http://","ws://")
    ws_url = f"{ws_url}/agent-ws?token={token}&mode=control"

    def on_open(ws):
        print("[ctrl] Connected")
        def stats():
            while running:
                try:
                    cpu  = round(psutil.cpu_percent(interval=1))
                    ram  = round(psutil.virtual_memory().percent)
                    disk = round(psutil.disk_usage("C:\\" if platform.system()=="Windows" else "/").percent)
                    ip   = get_ip()
                    ws.send(json.dumps({"type":"stats","cpu":cpu,"ram":ram,"disk":disk,"ip":ip}))
                    print(f"[stats] CPU:{cpu}% RAM:{ram}% Disk:{disk}% IP:{ip}")
                except Exception as e: print(f"[stats] {e}"); break
                time.sleep(STATS_INTERVAL)
        threading.Thread(target=stats, daemon=True).start()

    def on_message(ws, msg):
        try:
            d = json.loads(msg)
            if d.get("type") == "power": execute_power(d["action"])
        except: pass

    def on_error(ws, e): print(f"[ctrl] Error: {e}")
    def on_close(ws, c, m): print(f"[ctrl] Disconnected")

    while running:
        ws = websocket.WebSocketApp(ws_url, on_open=on_open,
            on_message=on_message, on_error=on_error, on_close=on_close)
        ws.run_forever(ping_interval=30, ping_timeout=10)
        if running: time.sleep(RECONNECT)

# ══════════════════════════════════════
# VNC TUNNEL (websockify -> server)
# Connects local websockify WS to the AxionPCs server WS tunnel
# ══════════════════════════════════════
def run_vnc_tunnel(server, token):
    """
    Bridge: AxionPCs server <-> local websockify
    - Connect to AxionPCs server as agent VNC endpoint
    - Connect to local websockify as a WebSocket client
    - Forward all binary frames between them
    """
    server_ws_url = server.replace("https://","wss://").replace("http://","ws://")
    server_ws_url = f"{server_ws_url}/agent-ws?token={token}&mode=vnc"
    local_ws_url  = f"ws://127.0.0.1:{WEBSOCKIFY_PORT}"

    while running:
        print("[vnc] Connecting VNC tunnel to server...")
        server_ws = None
        local_ws  = None

        try:
            # Connect to server with keepalive ping
            server_ws = websocket.create_connection(server_ws_url, ping_interval=20, ping_timeout=10)
            print("[vnc] Server tunnel open")

            # Connect to local websockify with keepalive
            local_ws = websocket.create_connection(local_ws_url, subprotocols=["binary", "base64"], ping_interval=20, ping_timeout=10)
            print("[vnc] Local websockify open — VNC tunnel active!")

            # Bridge them: two threads forwarding in each direction
            stop_event = threading.Event()

            def fwd(src, dst, label):
                try:
                    while not stop_event.is_set():
                        opcode, data = src.recv_data()
                        if data:
                            dst.send_binary(data) if opcode == websocket.ABNF.OPCODE_BINARY else dst.send(data)
                except Exception as e:
                    if running: print(f"[vnc] {label}: {e}")
                finally:
                    stop_event.set()

            t1 = threading.Thread(target=fwd, args=(server_ws, local_ws, "server->local"), daemon=True)
            t2 = threading.Thread(target=fwd, args=(local_ws, server_ws, "local->server"), daemon=True)
            t1.start(); t2.start()
            stop_event.wait()

        except Exception as e:
            print(f"[vnc] Tunnel error: {e}")
        finally:
            for ws in [server_ws, local_ws]:
                if ws:
                    try: ws.close()
                    except: pass

        if running:
            print(f"[vnc] Reconnecting in {RECONNECT}s...")
            time.sleep(RECONNECT)

# ══════════════════════════════════════
# MAIN
# ══════════════════════════════════════
def main():
    global VNC_PORT, WEBSOCKIFY_PORT
    parser = argparse.ArgumentParser()
    parser.add_argument("--token",    required=True)
    parser.add_argument("--server",   required=True)
    parser.add_argument("--vnc-port", type=int, default=5900)
    args = parser.parse_args()

    VNC_PORT        = args.vnc_port
    WEBSOCKIFY_PORT = VNC_PORT + 10000  # e.g. 5900 -> 15900
    server          = args.server.rstrip('/')
    token           = args.token

    print(f"""
╔══════════════════════════════════════╗
║          AxionPCs Agent              ║
║  Server : {server:<28}║
║  VNC    : {VNC_HOST}:{VNC_PORT:<24}║
╚══════════════════════════════════════╝
""")

    # Start websockify
    if not start_websockify():
        print("[!] Could not start websockify. Run: pip install websockify")
        sys.exit(1)

    # Run control + VNC tunnel in parallel threads
    t1 = threading.Thread(target=run_control,    args=(server, token), daemon=True)
    t2 = threading.Thread(target=run_vnc_tunnel, args=(server, token), daemon=True)
    t1.start(); t2.start()

    try:
        while running: time.sleep(1)
    except KeyboardInterrupt:
        print("\n[agent] Stopping...")
        stop_websockify()

if __name__ == "__main__":
    main()