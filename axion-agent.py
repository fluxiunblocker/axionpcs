#!/usr/bin/env python3
"""
AxionPCs Agent — on-demand VNC tunnel
pip install websocket-client psutil websockify
python axion-agent.py --token YOUR_TOKEN --server https://axionpcs.onrender.com
"""
import argparse, json, socket, sys, threading, time, subprocess, platform, os

try: import psutil
except ImportError: print("[!] pip install psutil"); sys.exit(1)
try: import websocket
except ImportError: print("[!] pip install websocket-client"); sys.exit(1)

VNC_HOST        = "127.0.0.1"
VNC_PORT        = 5900
WEBSOCKIFY_PORT = 15900
STATS_INTERVAL  = 20
RECONNECT       = 5
running         = True
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
    global websockify_proc
    if websockify_proc and websockify_proc.poll() is None:
        return True
    try:
        websockify_proc = subprocess.Popen(
            [sys.executable, "-m", "websockify", str(WEBSOCKIFY_PORT), f"{VNC_HOST}:{VNC_PORT}"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        time.sleep(1)
        print(f"[ws4y] websockify running (pid {websockify_proc.pid})")
        return True
    except Exception as e:
        print(f"[ws4y] Failed: {e}"); return False

# ── CONTROL CONNECTION ─────────────────────────────────────────────
# Stays connected permanently, sends stats, receives power commands
# When server sends {"type":"connect_vnc"}, we open a VNC tunnel
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
                    print(f"[stats] CPU:{cpu}% RAM:{ram}% Disk:{disk}%")
                except Exception as e: print(f"[stats] {e}"); break
                time.sleep(STATS_INTERVAL)
        threading.Thread(target=stats, daemon=True).start()

    def on_message(ws, msg):
        try:
            d = json.loads(msg)
            if d.get("type") == "power":
                execute_power(d["action"])
            elif d.get("type") == "connect_vnc":
                # Server is telling us a browser wants to connect — open tunnel now
                print("[ctrl] Browser connecting — opening VNC tunnel...")
                threading.Thread(target=run_vnc_tunnel, args=(server, token), daemon=True).start()
        except: pass

    def on_error(ws, e): print(f"[ctrl] Error: {e}")
    def on_close(ws, c, m): print(f"[ctrl] Disconnected")

    while running:
        ws = websocket.WebSocketApp(ws_url, on_open=on_open,
            on_message=on_message, on_error=on_error, on_close=on_close)
        ws.run_forever(ping_interval=20, ping_timeout=10)
        if running: time.sleep(RECONNECT)

# ── ON-DEMAND VNC TUNNEL ───────────────────────────────────────────
# Only opens when server requests it (browser clicked Connect)
def run_vnc_tunnel(server, token):
    server_ws_url = server.replace("https://","wss://").replace("http://","ws://")
    server_ws_url = f"{server_ws_url}/agent-ws?token={token}&mode=vnc"
    local_ws_url  = f"ws://127.0.0.1:{WEBSOCKIFY_PORT}"

    print("[vnc] Opening on-demand VNC tunnel...")
    server_ws = None
    local_ws  = None

    try:
        server_ws = websocket.create_connection(server_ws_url, timeout=30)
        print("[vnc] Server tunnel open")

        local_ws = websocket.create_connection(local_ws_url,
            subprotocols=["binary","base64"], timeout=30)
        print("[vnc] Local VNC open — streaming!")

        stop_event = threading.Event()

        def fwd(src, dst, label):
            src.sock.settimeout(None)  # no timeout during active session
            try:
                while not stop_event.is_set():
                    opcode, data = src.recv_data()
                    if data:
                        if opcode == websocket.ABNF.OPCODE_BINARY:
                            dst.send(data, websocket.ABNF.OPCODE_BINARY)
                        else:
                            dst.send(data)
            except Exception as e:
                if running: print(f"[vnc] {label}: {e}")
            finally:
                stop_event.set()

        t1 = threading.Thread(target=fwd, args=(server_ws, local_ws, "srv->vnc"), daemon=True)
        t2 = threading.Thread(target=fwd, args=(local_ws, server_ws, "vnc->srv"), daemon=True)
        t1.start(); t2.start()
        stop_event.wait()
        print("[vnc] Session ended")

    except Exception as e:
        print(f"[vnc] Tunnel error: {e}")
    finally:
        for ws in [server_ws, local_ws]:
            if ws:
                try: ws.close()
                except: pass

def main():
    global VNC_PORT, WEBSOCKIFY_PORT
    parser = argparse.ArgumentParser()
    parser.add_argument("--token",    required=True)
    parser.add_argument("--server",   required=True)
    parser.add_argument("--vnc-port", type=int, default=5900)
    args = parser.parse_args()

    VNC_PORT        = args.vnc_port
    WEBSOCKIFY_PORT = VNC_PORT + 10000
    server          = args.server.rstrip('/')
    token           = args.token

    print(f"""
╔══════════════════════════════════════╗
║          AxionPCs Agent              ║
║  Server : {server:<28}║
║  VNC    : {VNC_HOST}:{VNC_PORT:<24}║
╚══════════════════════════════════════╝
""")
    if not start_websockify():
        print("[!] Could not start websockify. Run: pip install websockify")
        sys.exit(1)

    threading.Thread(target=run_control, args=(server, token), daemon=True).start()

    try:
        while running: time.sleep(1)
    except KeyboardInterrupt:
        print("\n[agent] Stopped.")
        if websockify_proc: websockify_proc.terminate()

if __name__ == "__main__":
    main()