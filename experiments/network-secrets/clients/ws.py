import json, time
from websockets.sync.client import connect
t = time.time()
try:
    with connect("wss://echo.websocket.org/") as ws:
        got = [ws.recv(timeout=10)]
        ws.send("hello-from-python"); got.append(ws.recv(timeout=10))
    print(json.dumps({"ok": True, "got": [g[:40] for g in got], "ms": int((time.time() - t) * 1000)}))
except Exception as e:
    print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"[:200]}))
