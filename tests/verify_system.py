"""Testes automatizados completos da Plataforma LOCAR — Fluxo Simplificado, Cores/Logo, Bloqueio ao Enviar Link e Consentimento."""

from __future__ import annotations

import base64
import hashlib
import io
import os
import shutil
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image
import pypdf

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR))


def make_test_logo_data_url(color: tuple[int, int, int, int] = (10, 126, 58, 255)) -> str:
    img = Image.new("RGBA", (180, 72), color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def run_all_tests() -> None:
    tmp_dir = tempfile.mkdtemp(prefix="locar_test_")
    try:
        os.environ["LOCAR_DATA_DIR"] = tmp_dir
        os.environ["LOCAR_DATABASE_URL"] = f"sqlite:///{(Path(tmp_dir) / 'test_locar.db').as_posix()}"
        os.environ["APP_SECRET_KEY"] = "test-secret-key-locar-2026-deterministico"

        from backend.database import reconfigure_engine
        from backend.pdf_generator import build_a4_html
        from backend.security import clear_rate_limits
        from server import create_app, reset_bootstrap_flag

        reconfigure_engine(os.environ["LOCAR_DATABASE_URL"])
        reset_bootstrap_flag()
        clear_rate_limits()
        app = create_app()
        client = app.test_client()

        # 1. Health & Seed
        res = client.get("/health")
        assert res.status_code == 200, f"Health falhou: {res.status_code}"
        health = res.get_json()
        assert health["status"] == "ok" and health["database_ok"] is True
        assert health["pdf_engine"] in ("chromium", "weasyprint")

        # 2. Proteção de rotas administrativas sem autenticação
        for url in ("/api/dashboard", "/api/cities", "/api/admin/users"):
            r = client.get(url)
            assert r.status_code == 401, f"Esperado 401 em {url}, veio {r.status_code}"

        r_not_found = client.get("/api/public/atas/token-inexistente-xyz")
        assert r_not_found.status_code == 404
        r_leak = client.get("/data/test_locar.db")
        assert r_leak.status_code == 404

        # Login inválido e login válido
        r_bad = client.post("/api/auth/login", json={"email": "admin@locar.srv.br", "password": "errada"})
        assert r_bad.status_code == 401

        r_login = client.post("/api/auth/login", json={"email": "admin@locar.srv.br", "password": "Locar@2026"})
        assert r_login.status_code == 200, f"Login falhou: {r_login.get_data(as_text=True)}"
        assert r_login.get_json()["authenticated"] is True

        # 3. Verificar 12 cidades e edição de cidade/logo preservando histórico
        r_dash = client.get("/api/dashboard")
        assert r_dash.status_code == 200
        dash = r_dash.get_json()
        assert dash["summary"]["total_cities"] == 12, f"Esperado 12 cidades, veio {dash['summary']['total_cities']}"

        caruaru_entry = next(c for c in dash["cities"] if c["city"]["slug"] == "caruaru")
        vitoria_entry = next(c for c in dash["cities"] if c["city"]["slug"] == "vitoria-de-santo-antao")
        caruaru_id = caruaru_entry["city"]["id"]
        caruaru_meeting_id = caruaru_entry["latest_meeting"]["id"]
        vitoria_meeting_id = vitoria_entry["latest_meeting"]["id"]

        logo_url = make_test_logo_data_url((10, 126, 58, 255))
        report_logo_url = make_test_logo_data_url((21, 101, 192, 255))

        r_upd_city = client.put(
            f"/api/cities/{caruaru_id}",
            json={
                "name": "Caruaru",
                "project_name": "Limpeza Urbana e Coleta — Caruaru Sede",
                "project_code": "LOCAR-01-CAR",
                "logo_data_url": logo_url,
            },
        )
        assert r_upd_city.status_code == 200, r_upd_city.get_data(as_text=True)
        assert r_upd_city.get_json()["city"]["has_logo"] is True

        r_tl = client.get(f"/api/cities/{caruaru_id}/timeline")
        assert r_tl.status_code == 200
        assert len(r_tl.get_json()["meetings"]) == 1, "Histórico da cidade deve permanecer preservado após edição"

        # 4. Personalização de cores e logo do relatório no editor + verificação no HTML/PDF A4
        r_custom = client.put(
            f"/api/meetings/{caruaru_meeting_id}",
            json={
                "primaryColor": "#1565c0",
                "secondaryColor": "#64b5f6",
                "reportLogoDataUrl": report_logo_url,
            },
        )
        assert r_custom.status_code == 200, r_custom.get_data(as_text=True)
        custom_json = r_custom.get_json()
        snap_custom = custom_json["meeting"]["snapshot"]
        assert snap_custom["primaryColor"] == "#1565c0"
        assert snap_custom["secondaryColor"] == "#64b5f6"
        assert snap_custom["reportLogoDataUrl"] == report_logo_url

        rendered_html = build_a4_html(snap_custom, custom_json["city"])
        assert "--report-primary: #1565c0" in rendered_html
        assert "--report-secondary: #64b5f6" in rendered_html
        assert report_logo_url in rendered_html

        # 5. Finalizar Vitória explicitamente e enviar link em Caruaru com auto_finalize
        r_fin_vit = client.post(f"/api/meetings/{vitoria_meeting_id}/finalize", json={"change_reason": "Versão inicial"})
        assert r_fin_vit.status_code == 201, f"Finalize Vitoria falhou: {r_fin_vit.get_data(as_text=True)}"
        ver_vit = r_fin_vit.get_json()["generated_version"]
        r_pdf_vit = client.get(f"/api/meetings/{vitoria_meeting_id}/versions/{ver_vit['id']}/pdf")
        assert r_pdf_vit.status_code == 200
        reader_vit = pypdf.PdfReader(io.BytesIO(r_pdf_vit.data))
        assert len(reader_vit.pages) == 1, f"Vitoria: esperado 1 página A4, gerou {len(reader_vit.pages)}"

        # Caruaru: envia link em 1 clique (auto_finalize=True) -> gera PDF, trava edição imediatamente!
        r_link = client.post(
            f"/api/meetings/{caruaru_meeting_id}/public-link",
            json={"snapshot": snap_custom, "auto_finalize": True, "expires_in_days": 30},
        )
        assert r_link.status_code == 201, f"Envio de link Caruaru falhou: {r_link.get_data(as_text=True)}"
        link_data = r_link.get_json()
        assert link_data["workflow_status"] == "link_enviado"
        assert link_data["is_locked"] is True, "Relatório deve ser bloqueado imediatamente após envio do link"
        token = link_data["public_url"].rsplit("/", 1)[-1]
        ver_car = link_data["current_version"]

        r_pdf_car = client.get(f"/api/meetings/{caruaru_meeting_id}/versions/{ver_car['id']}/pdf")
        assert r_pdf_car.status_code == 200
        assert hashlib.sha256(r_pdf_car.data).hexdigest() == ver_car["pdf_sha256"]
        reader_car = pypdf.PdfReader(io.BytesIO(r_pdf_car.data))
        assert len(reader_car.pages) == 1, f"Caruaru: esperado 1 página A4, gerou {len(reader_car.pages)}"
        box = reader_car.pages[0].mediabox
        assert 590 <= float(box.width) <= 600 and 838 <= float(box.height) <= 846
        txt = reader_car.pages[0].extract_text() or ""
        assert "Outubro/2026" in txt and "Itens de ação" in txt and "Proprietários" in txt

        # Bloqueio imediato após envio do link (antes mesmo do consentimento)
        r_edit_blocked_after_link = client.put(
            f"/api/meetings/{caruaru_meeting_id}",
            json={"title": "Tentativa de edição após envio do link"},
        )
        assert r_edit_blocked_after_link.status_code == 409, (
            f"Esperado 409 ao tentar editar após envio do link, veio {r_edit_blocked_after_link.status_code}"
        )
        assert client.post(f"/api/meetings/{caruaru_meeting_id}/finalize", json={}).status_code == 409
        assert client.post(f"/api/meetings/{caruaru_meeting_id}/import-pending-actions", json={}).status_code == 409

        # Enquanto travada pelo envio do link, alteração de status do Plano de Ação DEVE funcionar
        r_m_before = client.get(f"/api/meetings/{caruaru_meeting_id}")
        v1_actions = r_m_before.get_json()["meeting"]["snapshot"]["actions"]
        first_action_id = v1_actions[0]["id"]
        r_track_while_sent = client.patch(
            f"/api/actions/{first_action_id}/tracking",
            json={"tracking_status": "em_andamento", "follow_up_notes": "Em execução"},
        )
        assert r_track_while_sent.status_code == 200
        assert r_track_while_sent.get_json()["action"]["tracking_status"] == "em_andamento"

        # 6. Sessão pública, visualização do PDF e consentimento concorrente
        pub_client = app.test_client()
        r_pub_page = pub_client.get(f"/ata/{token}")
        assert r_pub_page.status_code == 200
        assert b"Confirmar e registrar consentimento" in r_pub_page.data

        r_pub_meta = pub_client.get(f"/api/public/atas/{token}")
        assert r_pub_meta.status_code == 200
        pub_meta = r_pub_meta.get_json()
        assert pub_meta["state"] == "pending_consent"
        assert pub_meta["city"]["logo_data_url"] == logo_url

        r_m_check = client.get(f"/api/meetings/{caruaru_meeting_id}")
        assert r_m_check.get_json()["meeting"]["workflow_status"] == "aguardando_confirmacao"

        r_pub_pdf = pub_client.get(f"/api/public/atas/{token}/pdf")
        assert r_pub_pdf.status_code == 200
        assert hashlib.sha256(r_pub_pdf.data).hexdigest() == pub_meta["version"]["pdf_sha256"]

        def submit_concurrent(idx: int) -> int:
            c = app.test_client()
            resp = c.post(
                f"/api/public/atas/{token}/consent",
                json={
                    "representative_name": f"Representante Caruaru {idx}",
                    "representative_email": f"rep{idx}@caruaru.pe.gov.br",
                    "representative_role": "Fiscal de Contrato",
                    "accepted_terms": True,
                    "client_timezone": "America/Recife",
                    "screen_resolution": "1920x1080",
                },
            )
            return resp.status_code

        with ThreadPoolExecutor(max_workers=5) as pool:
            statuses = list(pool.map(submit_concurrent, range(5)))

        assert statuses.count(201) == 1, f"Esperado exatamente 1 sucesso 201 na concorrência, veio {statuses}"
        assert statuses.count(409) == 4, f"Esperado 4 conflitos 409 na concorrência, veio {statuses}"

        # Após consentimento, continua bloqueada contra edição e contra novo link
        r_locked = client.get(f"/api/meetings/{caruaru_meeting_id}")
        locked_json = r_locked.get_json()
        assert locked_json["meeting"]["workflow_status"] == "confirmada"
        assert locked_json["meeting"]["is_locked"] is True
        v1_sha_before = locked_json["current_version"]["pdf_sha256"]

        assert client.put(f"/api/meetings/{caruaru_meeting_id}", json={"title": "Alteracao Silenciosa"}).status_code == 409
        assert client.post(f"/api/meetings/{caruaru_meeting_id}/public-link", json={}).status_code == 409

        # 7. Alteração de status do Plano de Ação após consentimento sem alterar PDF congelado
        r_check = client.patch(
            f"/api/actions/{first_action_id}/tracking",
            json={"checked_completed": True, "tracking_status": "concluida", "follow_up_notes": "Auditoria concluída"},
        )
        assert r_check.status_code == 200
        assert r_check.get_json()["action"]["checked_completed"] is True

        r_vers_after = client.get(f"/api/meetings/{caruaru_meeting_id}/versions").get_json()
        v1_meta = next(v for v in r_vers_after["versions"] if v["version_number"] == 1)
        assert v1_meta["pdf_sha256"] == v1_sha_before

        # 8. Próxima reunião puxa apenas pendências da anterior, sem copiar o resumo antigo, e herda cores/logo
        r_new_m = client.post(
            f"/api/cities/{caruaru_id}/meetings",
            json={
                "reference_label": "Novembro/2026",
                "reference_month": "2026-11",
                "meeting_date": "2026-12-16",
                "title": "Ata de Reunião de Indicadores Novembro/2026",
                "auto_import_pending": True,
            },
        )
        assert r_new_m.status_code == 201
        new_m_data = r_new_m.get_json()
        new_snap = new_m_data["meeting"]["snapshot"]
        assert new_m_data["previous_meeting"]["id"] == caruaru_meeting_id
        assert new_snap["summary"] == "", f"Resumo da nova reunião deve iniciar vazio, veio: {new_snap['summary']}"
        assert new_snap["primaryColor"] == "#1565c0"
        assert new_snap["secondaryColor"] == "#64b5f6"
        assert new_snap["reportLogoDataUrl"] == report_logo_url

        imported_actions = new_snap["actions"]
        assert len(imported_actions) == len(v1_actions) - 1, (
            f"Ação concluída não devia ser importada; esperado {len(v1_actions) - 1}, veio {len(imported_actions)}"
        )
        assert all(a["status"] == "" for a in imported_actions), "Coluna Status no papel deve iniciar vazia"

        # 9. Revogação de link em Vitória -> link_invalido e 410 na rota pública
        r_link_vit = client.post(f"/api/meetings/{vitoria_meeting_id}/public-link", json={}).get_json()
        token_vit = r_link_vit["public_url"].rsplit("/", 1)[-1]
        r_rev = client.post(f"/api/public-links/{r_link_vit['link']['id']}/revoke", json={"reason": "Teste revogação"})
        assert r_rev.status_code == 200
        assert r_rev.get_json()["workflow_status"] == "link_invalido"
        assert pub_client.get(f"/api/public/atas/{token_vit}").status_code == 410
        assert pub_client.get(f"/api/public/atas/{token_vit}/pdf").status_code == 410

        print("TODOS OS TESTES AUTOMATIZADOS PASSARAM COM SUCESSO!")
    finally:
        try:
            from backend.database import engine

            engine.dispose()
        except Exception:
            pass
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    run_all_tests()
