"""Testes automatizados completos da Plataforma Grupo LOCAR (12 cidades, PDF congelado, concorrência e check de melhorias)."""

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


def make_test_logo_data_url() -> str:
    img = Image.new("RGBA", (180, 72), (10, 126, 58, 255))
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

        from backend.database import SessionLocal, init_db, reconfigure_engine
        from backend.security import clear_rate_limits
        from backend.seed import seed_initial_data
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

        # Proteção contra token público inexistente ou acesso direto ao banco/arquivos
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

        # 3. Verificar 12 cidades/projetos e preservação ao editar identificação + logotipo
        r_dash = client.get("/api/dashboard")
        assert r_dash.status_code == 200
        dash = r_dash.get_json()
        assert dash["summary"]["total_cities"] == 12, f"Esperado 12 cidades, veio {dash['summary']['total_cities']}"

        caruaru_entry = next(c for c in dash["cities"] if c["city"]["slug"] == "caruaru")
        vitoria_entry = next(c for c in dash["cities"] if c["city"]["slug"] == "vitoria-de-santo-antao")
        caruaru_id = caruaru_entry["city"]["id"]
        caruaru_meeting_id = caruaru_entry["latest_meeting"]["id"]
        vitoria_meeting_id = vitoria_entry["latest_meeting"]["id"]

        logo_url = make_test_logo_data_url()
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

        # 4. Testes comparativos de PDF A4 definitivo (Caruaru Out/2026 e Vitória Abr/2026)
        for label, mid, expected_title in (
            ("Caruaru", caruaru_meeting_id, "Outubro/2026"),
            ("Vitoria", vitoria_meeting_id, "Abril/2026"),
        ):
            r_fin = client.post(f"/api/meetings/{mid}/finalize", json={"change_reason": "Versão inicial"})
            assert r_fin.status_code == 201, f"Finalize {label} falhou: {r_fin.get_data(as_text=True)}"
            fin_data = r_fin.get_json()
            ver = fin_data["generated_version"]
            assert ver["version_number"] == 1

            r_pdf = client.get(f"/api/meetings/{mid}/versions/{ver['id']}/pdf")
            assert r_pdf.status_code == 200
            pdf_bytes = r_pdf.data
            assert pdf_bytes.startswith(b"%PDF-")
            assert hashlib.sha256(pdf_bytes).hexdigest() == ver["pdf_sha256"]

            reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
            assert len(reader.pages) == 1, f"{label}: esperado 1 página A4, gerou {len(reader.pages)}"
            box = reader.pages[0].mediabox
            assert 590 <= float(box.width) <= 600 and 838 <= float(box.height) <= 846
            txt = reader.pages[0].extract_text() or ""
            assert expected_title in txt
            assert "Itens de ação" in txt
            assert "Proprietários" in txt
            assert "DIE" in txt

        # 5. Link público, atualização automática de situação e concorrência no consentimento
        r_link = client.post(f"/api/meetings/{caruaru_meeting_id}/public-link", json={"expires_in_days": 30})
        assert r_link.status_code == 201
        link_data = r_link.get_json()
        assert link_data["workflow_status"] == "link_enviado"
        token = link_data["public_url"].rsplit("/", 1)[-1]

        # Sessão pública anônima (novo test_client sem cookie admin)
        pub_client = app.test_client()
        r_pub_page = pub_client.get(f"/ata/{token}")
        assert r_pub_page.status_code == 200
        assert b"Confirmar e registrar consentimento" in r_pub_page.data

        r_pub_meta = pub_client.get(f"/api/public/atas/{token}")
        assert r_pub_meta.status_code == 200
        pub_meta = r_pub_meta.get_json()
        assert pub_meta["state"] == "pending_consent"
        assert pub_meta["city"]["logo_data_url"] == logo_url

        # Situação no painel admin deve ter avançado para aguardando_confirmacao
        r_m_check = client.get(f"/api/meetings/{caruaru_meeting_id}")
        assert r_m_check.get_json()["meeting"]["workflow_status"] == "aguardando_confirmacao"

        # Verifica integridade exata do PDF servido publicamente
        r_pub_pdf = pub_client.get(f"/api/public/atas/{token}/pdf")
        assert r_pub_pdf.status_code == 200
        assert hashlib.sha256(r_pub_pdf.data).hexdigest() == pub_meta["version"]["pdf_sha256"]

        # Disparo concorrente de 5 confirmações simultâneas (proteção contra duplicidade)
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

        # Reunião confirmada fica bloqueada contra edição silenciosa
        r_locked = client.get(f"/api/meetings/{caruaru_meeting_id}")
        locked_json = r_locked.get_json()
        assert locked_json["meeting"]["workflow_status"] == "confirmada"
        assert locked_json["meeting"]["is_locked"] is True
        v1_sha_before = locked_json["current_version"]["pdf_sha256"]
        v1_actions = locked_json["meeting"]["snapshot"]["actions"]

        r_edit_blocked = client.put(f"/api/meetings/{caruaru_meeting_id}", json={"title": "Alteracao Silenciosa"})
        assert r_edit_blocked.status_code == 409

        # 6. Versionamento: criar v2 preserva v1 PDF e consentimento de v1
        r_unlock = client.post(
            f"/api/meetings/{caruaru_meeting_id}/unlock-new-version",
            json={"change_reason": "Ajuste no prazo do item 2"},
        )
        assert r_unlock.status_code == 200
        snap_v2 = r_unlock.get_json()["meeting"]["snapshot"]
        snap_v2["actions"][1]["deadline"] = "15/12/2026"
        r_fin_v2 = client.post(
            f"/api/meetings/{caruaru_meeting_id}/finalize",
            json={"snapshot": snap_v2, "change_reason": "Ajuste no prazo do item 2"},
        )
        assert r_fin_v2.status_code == 201
        assert r_fin_v2.get_json()["generated_version"]["version_number"] == 2

        r_vers = client.get(f"/api/meetings/{caruaru_meeting_id}/versions").get_json()
        assert len(r_vers["versions"]) == 2
        assert len(r_vers["consents"]) == 1
        assert r_vers["consents"][0]["version_number"] == 1

        # Gerar link para v2 e depois revogar -> link_invalido e PDF indisponível (410)
        r_link2 = client.post(f"/api/meetings/{caruaru_meeting_id}/public-link", json={}).get_json()
        token2 = r_link2["public_url"].rsplit("/", 1)[-1]
        r_rev = client.post(f"/api/public-links/{r_link2['link']['id']}/revoke", json={"reason": "Teste revogação"})
        assert r_rev.status_code == 200
        assert r_rev.get_json()["workflow_status"] == "link_invalido"
        assert pub_client.get(f"/api/public/atas/{token2}").status_code == 410
        assert pub_client.get(f"/api/public/atas/{token2}/pdf").status_code == 410

        # 7. Acompanhamento de melhorias com CHECK em futura reunião sem alterar v1 congelada
        first_action_id = v1_actions[0]["id"]
        r_check = client.patch(
            f"/api/actions/{first_action_id}/tracking",
            json={"checked_completed": True, "tracking_status": "concluida", "follow_up_notes": "Auditoria concluída"},
        )
        assert r_check.status_code == 200
        assert r_check.get_json()["action"]["checked_completed"] is True

        # Verifica que o hash do PDF congelado v1 continua idêntico
        r_vers_after = client.get(f"/api/meetings/{caruaru_meeting_id}/versions").get_json()
        v1_meta = next(v for v in r_vers_after["versions"] if v["version_number"] == 1)
        assert v1_meta["pdf_sha256"] == v1_sha_before

        # Criar reunião futura (Novembro/2026) na mesma cidade com importação apenas das pendências
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
        assert new_m_data["previous_meeting"]["id"] == caruaru_meeting_id
        imported_actions = new_m_data["meeting"]["snapshot"]["actions"]
        assert len(imported_actions) == len(v1_actions) - 1, (
            f"Ação marcada com check como concluída não devia ser importada como pendente; "
            f"esperado {len(v1_actions) - 1}, veio {len(imported_actions)}"
        )
        assert all(a["status"] == "" for a in imported_actions), "Coluna Status no papel deve iniciar vazia"

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
