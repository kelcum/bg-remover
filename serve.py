import http.server
import sys

class COOPCOEPHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8743
http.server.test(HandlerClass=COOPCOEPHandler, port=port)
