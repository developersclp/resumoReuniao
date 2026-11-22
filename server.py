"""Servidor principal da Plataforma Grupo LOCAR — Atas de Reunião, PDF Congelado e Consentimento Público."""

from __future__ import annotations

import logging
import os
import threading
import webbrowser
from pathlib import Path

from flask import Flask, jsonify, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix

from backend.config import BASE_DIR, is_production
from backend.database import SessionLocal, check_db_health, init_db
from backend.pdf_generator import get_pdf_engine_status
from backend.routes_admin import admin_bp
from backend.routes_public import public_bp
from backend.seed import seed_initial_data

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("locar.server")

_BOOTSTRAP_LOCK = threading.Lock()
_BOOTSTRAPPED = False


def bootstrap_database() -> None:
    """Inicializa schema e carga inicial das 12 cidades/projetos de forma idempotente."""
    global _BOOTSTRAPPED
    with _BOOTSTRAP_LOCK:
        if _BOOTSTRAPPED:
            return
        init_db()
        db = SessionLocal()
        try:
            seed_initial_data(db)
        finally:
            db.close()
        _BOOTSTRAPPED = True


def reset_bootstrap_flag() -> None:
    global _BOOTSTRAPPED
    with _BOOTSTRAP_LOCK:
        _BOOTSTRAPPED = False


def create_app() -> Flask:
    app = Flask(__name__, static_folder=None)
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
    app.config["JSON_AS_ASCII"] = False
    app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024  # 8 MB

    if is_production() and not os.environ.get("APP_SECRET_KEY"):
        logger.warning(
            "APP_SECRET_KEY não definida no ambiente de produção! Configure APP_SECRET_KEY nas variáveis do Railway."
        )

    bootstrap_database()

    app.register_blueprint(admin_bp)
    app.register_blueprint(public_bp)

    @app.route("/health", methods=["GET"])
    @app.route("/healthz", methods=["GET"])
    def healthcheck():
        db_ok, dialect = check_db_health()
        pdf_engine = get_pdf_engine_status()
        status_code = 200 if db_ok else 503
        return (
            jsonify(
                {
                    "status": "ok" if db_ok else "degraded",
                    "service": "locar-atas-plataforma",
                    "database": dialect,
                    "database_ok": db_ok,
                    "pdf_engine": pdf_engine,
                }
            ),
            status_code,
        )

    @app.route("/", methods=["GET"])
    def index_page():
        resp = send_from_directory(BASE_DIR, "index.html")
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return resp

    @app.route("/css/<path:filename>", methods=["GET"])
    def serve_css(filename: str):
        return send_from_directory(BASE_DIR / "css", filename)

    @app.route("/js/<path:filename>", methods=["GET"])
    def serve_js(filename: str):
        return send_from_directory(BASE_DIR / "js", filename)

    @app.route("/assets/<path:filename>", methods=["GET"])
    def serve_assets(filename: str):
        return send_from_directory(BASE_DIR / "assets", filename)

    @app.route("/public/<path:filename>", methods=["GET"])
    def serve_public_assets(filename: str):
        return send_from_directory(BASE_DIR / "public", filename)

    @app.after_request
    def apply_security_headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        if "Content-Security-Policy" not in response.headers:
            response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        return response

    return app


app = create_app()


def main():
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8080"))
    cloud_mode = bool(
        os.environ.get("PORT")
        or os.environ.get("RAILWAY_ENVIRONMENT")
        or os.environ.get("RAILWAY_STATIC_URL")
    )

    print("============================================================")
    print(" Grupo LOCAR — Gestão de Atas das 12 Cidades/Projetos")
    print(f" Servidor pronto e escutando em: http://{host}:{port}/")
    print(f" Modo: {'Cloud/Railway' if cloud_mode else 'Local'}")
    print(f" Motor PDF: {get_pdf_engine_status()}")
    print("============================================================")

    import sys

    if not cloud_mode and "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(f"http://localhost:{port}/")).start()

    app.run(host=host, port=port, debug=False, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
