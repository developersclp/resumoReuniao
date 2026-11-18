"""Servidor HTTP estático pronto para produção local e deploy no Railway/Cloud.

Compatível com Railway, Render, Fly.io, Vercel e execução local no Windows/Linux/Mac.
"""

import functools
import http.server
import json
import os
import socketserver
import sys
import webbrowser

# No Railway e em contêineres cloud, o host DEVE ser '0.0.0.0' para aceitar conexões externas
HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8080"))
DIRECTORY = os.path.dirname(os.path.abspath(__file__))


class ProductionStaticHTTPHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".csv": "text/csv; charset=utf-8",
    }

    def do_GET(self):
        # Healthcheck endpoint para o Railway / monitoramento
        if self.path in ("/health", "/healthz"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            payload = json.dumps({"status": "ok", "service": "locar-atas"}).encode("utf-8")
            self.wfile.write(payload)
            return

        super().do_GET()

    def end_headers(self):
        # Evitar cache de arquivos estáticos durante updates
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, format, *args):
        # Em produção, registrar requisições de forma limpa
        sys.stdout.write(f"[{self.log_date_time_string()}] {format % args}\n")
        sys.stdout.flush()


def main():
    handler = functools.partial(ProductionStaticHTTPHandler, directory=DIRECTORY)
    socketserver.TCPServer.allow_reuse_address = True

    with socketserver.TCPServer((HOST, PORT), handler) as httpd:
        print(f"============================================================")
        print(f" LOCAR Gestão de Resíduos — Sistema de Atas & Plano de Ação")
        print(f" Servidor pronto e escutando em: http://0.0.0.0:{PORT}/")
        print(f" Modo: {'Cloud/Railway' if os.environ.get('PORT') else 'Local'}")
        print(f"============================================================")
        sys.stdout.flush()

        # Abrir navegador apenas se estiver rodando localmente no desktop (sem variável PORT e sem flag --no-browser)
        is_cloud = bool(os.environ.get("PORT") or os.environ.get("RAILWAY_ENVIRONMENT") or os.environ.get("RAILWAY_STATIC_URL"))
        if not is_cloud and "--no-browser" not in sys.argv:
            try:
                webbrowser.open(f"http://localhost:{PORT}/")
            except Exception:
                pass

        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServidor finalizado com sucesso.")


if __name__ == "__main__":
    main()
