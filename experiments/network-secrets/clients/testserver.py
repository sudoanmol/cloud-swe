# Upstream under the spike's control, reached through an E2B port URL: slow replies, long SSE, header echo, cookies.
import json, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def reply(self, status, body, ctype="application/json", extra=()):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(status); self.send_header("content-type", ctype); self.send_header("content-length", str(len(data)))
        for k, v in extra: self.send_header(k, v)
        self.end_headers(); self.wfile.write(data)
    def handle_any(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        n = int(self.headers.get("content-length") or 0); body = self.rfile.read(n) if n else b""
        if u.path == "/slow":
            time.sleep(int(q.get("s", ["5"])[0])); return self.reply(200, json.dumps({"slept": q.get("s", ["5"])[0]}))
        if u.path == "/sse":
            self.send_response(200); self.send_header("content-type", "text/event-stream"); self.send_header("cache-control", "no-cache"); self.send_header("transfer-encoding", "chunked"); self.end_headers()
            for i in range(int(q.get("n", ["10"])[0])):
                chunk = f"data: {i} {time.time():.3f}\n\n".encode()
                self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n"); self.wfile.flush(); time.sleep(1)
            self.wfile.write(b"0\r\n\r\n"); return
        if u.path == "/cookies":
            return self.reply(200, "{}", extra=[("set-cookie", "a=1; Path=/"), ("set-cookie", "b=2; Path=/")])
        return self.reply(200, json.dumps({"method": self.command, "headers": dict(self.headers), "bodyBytes": len(body)}))
    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = handle_any
    def do_HEAD(self):
        self.send_response(200); self.send_header("content-length", "0"); self.send_header("x-head", "ok"); self.end_headers()

ThreadingHTTPServer(("0.0.0.0", 8080), H).serve_forever()
