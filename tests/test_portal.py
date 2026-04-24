from __future__ import annotations

import csv
import importlib
import sqlite3
import sys
import uuid
from io import StringIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from fastapi.testclient import TestClient


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def load_fresh_app():
    for module_name in (
        "backend.security",
        "backend.database",
        "backend.xlsx_reader",
        "backend.offer_module.teklif_kontrol",
        "backend.offer_module.portal_auth",
        "backend.offer_module.webapp",
        "backend.offer_module",
        "backend.app",
    ):
        if module_name in sys.modules:
            importlib.reload(sys.modules[module_name])
        else:
            importlib.import_module(module_name)
    return sys.modules["backend.app"].app


def make_test_db_path() -> Path:
    root = PROJECT_ROOT / ".tmp_testdata"
    root.mkdir(parents=True, exist_ok=True)
    return root / f"{uuid.uuid4().hex}.db"


def build_xlsx_bytes(rows: list[list[str]]) -> bytes:
    shared_values: list[str] = []
    shared_lookup: dict[str, int] = {}

    def shared_index(value: str) -> int:
        if value not in shared_lookup:
            shared_lookup[value] = len(shared_values)
            shared_values.append(value)
        return shared_lookup[value]

    def column_name(index: int) -> str:
        result = ""
        while index > 0:
            index, remainder = divmod(index - 1, 26)
            result = chr(65 + remainder) + result
        return result

    sheet_rows = []
    for row_number, row in enumerate(rows, start=1):
        cells = []
        for column_number, value in enumerate(row, start=1):
            ref = f"{column_name(column_number)}{row_number}"
            idx = shared_index(value)
            cells.append(f'<c r="{ref}" t="s"><v>{idx}</v></c>')
        sheet_rows.append(f'<row r="{row_number}">{"".join(cells)}</row>')

    shared_strings_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        f'count="{len(shared_values)}" uniqueCount="{len(shared_values)}">'
        + "".join(f"<si><t>{value}</t></si>" for value in shared_values)
        + "</sst>"
    )
    sheet_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData>{''.join(sheet_rows)}</sheetData>"
        "</worksheet>"
    )
    workbook_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="Sayfa1" sheetId="1" r:id="rId1" /></sheets>'
        "</workbook>"
    )
    workbook_rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        'Target="worksheets/sheet1.xml" />'
        '<Relationship Id="rId2" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" '
        'Target="sharedStrings.xml" />'
        "</Relationships>"
    )
    content_types_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />'
        '<Default Extension="xml" ContentType="application/xml" />'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" />'
        '<Override PartName="/xl/worksheets/sheet1.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml" />'
        '<Override PartName="/xl/sharedStrings.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml" />'
        "</Types>"
    )
    root_rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="xl/workbook.xml" />'
        "</Relationships>"
    )

    from io import BytesIO

    buffer = BytesIO()
    with ZipFile(buffer, "w", ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types_xml)
        archive.writestr("_rels/.rels", root_rels_xml)
        archive.writestr("xl/workbook.xml", workbook_xml)
        archive.writestr("xl/_rels/workbook.xml.rels", workbook_rels_xml)
        archive.writestr("xl/worksheets/sheet1.xml", sheet_xml)
        archive.writestr("xl/sharedStrings.xml", shared_strings_xml)
    return buffer.getvalue()


def test_login_import_assign_and_agent_update(monkeypatch) -> None:
    db_path = make_test_db_path()
    monkeypatch.setenv("CALL_PORTAL_DB_PATH", str(db_path))
    monkeypatch.setenv("CALL_PORTAL_ADMIN_EMAIL", "admin@test.local")
    monkeypatch.setenv("CALL_PORTAL_ADMIN_PASSWORD", "Admin12345!")
    monkeypatch.delenv("RENDER", raising=False)

    app = load_fresh_app()

    workbook = build_xlsx_bytes(
        [
            ["İsim", "Adres", "Telefon", "Website", "Email"],
            ["Alem Bar", "Alsancak", "+90 530 237 14 74", "https://ornek.com", "mail@ornek.com"],
            ["Kordon Cafe", "Konak", "0530 111 22 33", "https://kordon.example", "iletisim@kordon.com"],
        ]
    )

    with TestClient(app) as client:
        login = client.post(
            "/api/auth/login",
            json={"email": "admin@test.local", "password": "Admin12345!"},
        )
        assert login.status_code == 200
        admin_token = login.json()["access_token"]

        create_user = client.post(
            "/api/users",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "full_name": "Operator Bir",
                "email": "operator@test.local",
                "password": "Operator123!",
                "role": "agent",
            },
        )
        assert create_user.status_code == 201
        agent_id = create_user.json()["id"]

        imported = client.post(
            "/api/lists/import",
            headers={
                "Authorization": f"Bearer {admin_token}",
                "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "X-File-Name": "izmir.xlsx",
                "X-List-Name": "Izmir Arama",
            },
            content=workbook,
        )
        assert imported.status_code == 201
        call_list_id = imported.json()["id"]
        assert imported.json()["summary"]["total"] == 2

        assigned = client.post(
            f"/api/lists/{call_list_id}/assign-evenly",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"user_ids": [agent_id], "mode": "all"},
        )
        assert assigned.status_code == 200
        assert assigned.json()["assigned_count"] == 2

        agent_login = client.post(
            "/api/auth/login",
            json={"email": "operator@test.local", "password": "Operator123!"},
        )
        assert agent_login.status_code == 200
        agent_token = agent_login.json()["access_token"]

        records = client.get(
            f"/api/records?call_list_id={call_list_id}",
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert records.status_code == 200
        assert records.json()["total"] == 2
        record_id = records.json()["items"][0]["id"]

        updated = client.patch(
            f"/api/records/{record_id}",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "call_status": "CALLING",
                "result_status": "PENDING",
                "note": "Arama basladi",
            },
        )
        assert updated.status_code == 200
        assert updated.json()["call_status"] == "CALLING"
        assert updated.json()["assigned_user_id"] == agent_id

        processed_records = client.get(
            f"/api/records?call_list_id={call_list_id}&assigned_user_id={agent_id}&processed=true",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert processed_records.status_code == 200
        assert processed_records.json()["total"] == 1
        assert processed_records.json()["items"][0]["id"] == record_id

        health = client.get("/health")
        assert health.status_code == 200
        assert health.json() == {"status": "ok", "db": "ok"}
    db_path.unlink(missing_ok=True)


def test_processed_records_are_added_to_contact_pool(monkeypatch) -> None:
    db_path = make_test_db_path()
    monkeypatch.setenv("CALL_PORTAL_DB_PATH", str(db_path))
    monkeypatch.setenv("CALL_PORTAL_ADMIN_EMAIL", "admin@test.local")
    monkeypatch.setenv("CALL_PORTAL_ADMIN_PASSWORD", "Admin12345!")
    monkeypatch.delenv("RENDER", raising=False)

    app = load_fresh_app()

    workbook = build_xlsx_bytes(
        [
            ["İsim", "Adres", "Telefon", "Website", "Email"],
            ["Havuz Klinik", "Bayrakli", "05301112233", "https://havuz.example", "info@havuz.example"],
        ]
    )

    with TestClient(app) as client:
        admin_login = client.post(
            "/api/auth/login",
            json={"email": "admin@test.local", "password": "Admin12345!"},
        )
        admin_token = admin_login.json()["access_token"]
        agent_id = client.post(
            "/api/users",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "full_name": "Operator Bir",
                "email": "operator@test.local",
                "password": "Operator123!",
                "role": "agent",
            },
        ).json()["id"]
        imported = client.post(
            "/api/lists/import",
            headers={
                "Authorization": f"Bearer {admin_token}",
                "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "X-File-Name": "havuz.xlsx",
                "X-List-Name": "Havuz Test",
            },
            content=workbook,
        )
        call_list_id = imported.json()["id"]
        client.post(
            f"/api/lists/{call_list_id}/assign-evenly",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"user_ids": [agent_id], "mode": "all"},
        )
        agent_login = client.post(
            "/api/auth/login",
            json={"email": "operator@test.local", "password": "Operator123!"},
        )
        agent_token = agent_login.json()["access_token"]
        records = client.get(
            f"/api/records?call_list_id={call_list_id}",
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        record_id = records.json()["items"][0]["id"]

        updated = client.patch(
            f"/api/records/{record_id}",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "call_status": "CALLED",
                "result_status": "POSITIVE",
                "note": "Yetkiliye ulasildi",
            },
        )
        assert updated.status_code == 200

        pool = client.get(
            f"/api/contact-pool?call_list_id={call_list_id}",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert pool.status_code == 200
        assert pool.json()["total"] == 1
        entry = pool.json()["items"][0]
        assert entry["company_name"] == "Havuz Klinik"
        assert entry["reach_status"] == "REACHED"
        assert entry["record_note"] == "Yetkiliye ulasildi"

        operator_pool = client.get(
            "/api/contact-pool",
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert operator_pool.status_code == 403

        edited = client.patch(
            f"/api/contact-pool/{entry['id']}",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"reach_status": "UNREACHED", "admin_note": "Tekrar teyit edilecek", "is_active": True},
        )
        assert edited.status_code == 200
        assert edited.json()["reach_status"] == "UNREACHED"
        assert edited.json()["admin_note"] == "Tekrar teyit edilecek"

        exported = client.get(
            "/api/contact-pool/export.csv",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert exported.status_code == 200
        exported_text = exported.content.decode("utf-8-sig")
        assert "Havuz Klinik" in exported_text
        assert "Tekrar teyit edilecek" in exported_text

        stats = client.get(
            f"/api/operator-stats?call_list_id={call_list_id}",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert stats.status_code == 200
        operator_stat = next(item for item in stats.json() if item["user_id"] == agent_id)
        assert operator_stat["assigned_count"] == 1
        assert operator_stat["processed_count"] == 1
        assert operator_stat["reached_count"] == 1
        assert operator_stat["positive_count"] == 1
        assert operator_stat["negative_count"] == 0

        filtered_records = client.get(
            f"/api/records?call_list_id={call_list_id}&assigned_user_id={agent_id}",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert filtered_records.status_code == 200
        assert filtered_records.json()["total"] == 1

        operator_stats_denied = client.get(
            "/api/operator-stats",
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert operator_stats_denied.status_code == 403

    db_path.unlink(missing_ok=True)


def test_agent_export_only_returns_assigned_rows(monkeypatch) -> None:
    db_path = make_test_db_path()
    monkeypatch.setenv("CALL_PORTAL_DB_PATH", str(db_path))
    monkeypatch.setenv("CALL_PORTAL_ADMIN_EMAIL", "admin@test.local")
    monkeypatch.setenv("CALL_PORTAL_ADMIN_PASSWORD", "Admin12345!")
    monkeypatch.delenv("RENDER", raising=False)

    app = load_fresh_app()

    workbook = build_xlsx_bytes(
        [
            ["İsim", "Adres", "Telefon", "Website", "Email"],
            ["Birinci Firma", "Konak", "05301112233", "https://bir.example", "bir@example.com"],
            ["İkinci Firma", "Bornova", "05302223344", "https://iki.example", "iki@example.com"],
        ]
    )

    with TestClient(app) as client:
        admin_login = client.post(
            "/api/auth/login",
            json={"email": "admin@test.local", "password": "Admin12345!"},
        )
        admin_token = admin_login.json()["access_token"]

        first_agent = client.post(
            "/api/users",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "full_name": "Operator Bir",
                "email": "operator1@test.local",
                "password": "Operator123!",
                "role": "agent",
            },
        ).json()["id"]

        second_agent = client.post(
            "/api/users",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "full_name": "Operator İki",
                "email": "operator2@test.local",
                "password": "Operator123!",
                "role": "agent",
            },
        ).json()["id"]

        imported = client.post(
            "/api/lists/import",
            headers={
                "Authorization": f"Bearer {admin_token}",
                "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "X-File-Name": "izmir.xlsx",
                "X-List-Name": "Izmir Arama",
            },
            content=workbook,
        )
        call_list_id = imported.json()["id"]

        assigned = client.post(
            f"/api/lists/{call_list_id}/assign-evenly",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"user_ids": [first_agent, second_agent], "mode": "all"},
        )
        assert assigned.status_code == 200

        agent_login = client.post(
            "/api/auth/login",
            json={"email": "operator1@test.local", "password": "Operator123!"},
        )
        agent_token = agent_login.json()["access_token"]

        exported = client.get(
            f"/api/lists/{call_list_id}/export.csv",
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert exported.status_code == 200

        rows = list(csv.reader(StringIO(exported.content.decode("utf-8-sig"))))
        assert len(rows) == 2
        assert rows[1][1] == "Birinci Firma"
    db_path.unlink(missing_ok=True)


def test_records_endpoint_filters_and_summarizes_on_server(monkeypatch) -> None:
    db_path = make_test_db_path()
    monkeypatch.setenv("CALL_PORTAL_DB_PATH", str(db_path))
    monkeypatch.setenv("CALL_PORTAL_ADMIN_EMAIL", "admin@test.local")
    monkeypatch.setenv("CALL_PORTAL_ADMIN_PASSWORD", "Admin12345!")
    monkeypatch.delenv("RENDER", raising=False)

    app = load_fresh_app()

    workbook = build_xlsx_bytes(
        [
            ["İsim", "Adres", "Telefon", "Website", "Email"],
            ["Email Firma", "Konak", "05301112233", "https://bir.example", "bir@example.com"],
            ["Telefonsuz Firma", "Bornova", "", "https://iki.example", ""],
        ]
    )

    with TestClient(app) as client:
        admin_login = client.post(
            "/api/auth/login",
            json={"email": "admin@test.local", "password": "Admin12345!"},
        )
        admin_token = admin_login.json()["access_token"]

        imported = client.post(
            "/api/lists/import",
            headers={
                "Authorization": f"Bearer {admin_token}",
                "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "X-File-Name": "izmir.xlsx",
                "X-List-Name": "Izmir Arama",
            },
            content=workbook,
        )
        call_list_id = imported.json()["id"]

        filtered = client.get(
            f"/api/records?call_list_id={call_list_id}&has_email=true&limit=100",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert filtered.status_code == 200
        assert filtered.json()["total"] == 1
        assert filtered.json()["summary"]["total"] == 1
        assert filtered.json()["items"][0]["company_name"] == "Email Firma"

    db_path.unlink(missing_ok=True)


def test_render_startup_requires_nondefault_admin_password(monkeypatch) -> None:
    db_path = make_test_db_path()
    monkeypatch.setenv("CALL_PORTAL_DB_PATH", str(db_path))
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("CALL_PORTAL_SECRET_KEY", "super-secret-key-for-render-1234567890")
    monkeypatch.delenv("CALL_PORTAL_ADMIN_PASSWORD", raising=False)
    monkeypatch.setenv("CALL_PORTAL_ADMIN_EMAIL", "admin@test.local")

    app = load_fresh_app()

    with pytest.raises(RuntimeError, match="CALL_PORTAL_ADMIN_PASSWORD"):
        with TestClient(app):
            pass
    db_path.unlink(missing_ok=True)


def test_custom_assign_respects_requested_counts(monkeypatch) -> None:
    db_path = make_test_db_path()
    monkeypatch.setenv("CALL_PORTAL_DB_PATH", str(db_path))
    monkeypatch.setenv("CALL_PORTAL_ADMIN_EMAIL", "admin@test.local")
    monkeypatch.setenv("CALL_PORTAL_ADMIN_PASSWORD", "Admin12345!")
    monkeypatch.delenv("RENDER", raising=False)

    app = load_fresh_app()

    workbook = build_xlsx_bytes(
        [
            ["İsim", "Adres", "Telefon", "Website", "Email"],
            ["Firma 1", "Konak", "05300000001", "", "f1@example.com"],
            ["Firma 2", "Konak", "05300000002", "", "f2@example.com"],
            ["Firma 3", "Konak", "05300000003", "", "f3@example.com"],
            ["Firma 4", "Konak", "05300000004", "", "f4@example.com"],
            ["Firma 5", "Konak", "05300000005", "", "f5@example.com"],
        ]
    )

    with TestClient(app) as client:
        admin_login = client.post(
            "/api/auth/login",
            json={"email": "admin@test.local", "password": "Admin12345!"},
        )
        admin_token = admin_login.json()["access_token"]

        first_agent = client.post(
            "/api/users",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "full_name": "Operator Bir",
                "email": "operator1@test.local",
                "password": "Operator123!",
                "role": "agent",
            },
        ).json()["id"]

        second_agent = client.post(
            "/api/users",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "full_name": "Operator İki",
                "email": "operator2@test.local",
                "password": "Operator123!",
                "role": "agent",
            },
        ).json()["id"]

        imported = client.post(
            "/api/lists/import",
            headers={
                "Authorization": f"Bearer {admin_token}",
                "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "X-File-Name": "izmir.xlsx",
                "X-List-Name": "Izmir Arama",
            },
            content=workbook,
        )
        call_list_id = imported.json()["id"]

        assigned = client.post(
            f"/api/lists/{call_list_id}/assign-custom",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "mode": "all",
                "allocations": [
                    {"user_id": first_agent, "count": 2},
                    {"user_id": second_agent, "count": 1},
                ],
            },
        )
        assert assigned.status_code == 200
        assert assigned.json()["assigned_count"] == 3
        assert assigned.json()["remaining_count"] == 2

        records = client.get(
            f"/api/records?call_list_id={call_list_id}&limit=100",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert records.status_code == 200
        items = records.json()["items"]
        first_count = sum(1 for item in items if item["assigned_user_id"] == first_agent)
        second_count = sum(1 for item in items if item["assigned_user_id"] == second_agent)
        unassigned_count = sum(1 for item in items if item["assigned_user_id"] is None)
        assert first_count == 2
        assert second_count == 1
        assert unassigned_count == 2

    db_path.unlink(missing_ok=True)


def test_assignment_rejects_admin_users(monkeypatch) -> None:
    db_path = make_test_db_path()
    monkeypatch.setenv("CALL_PORTAL_DB_PATH", str(db_path))
    monkeypatch.setenv("CALL_PORTAL_ADMIN_EMAIL", "admin@test.local")
    monkeypatch.setenv("CALL_PORTAL_ADMIN_PASSWORD", "Admin12345!")
    monkeypatch.delenv("RENDER", raising=False)

    app = load_fresh_app()
    workbook = build_xlsx_bytes(
        [
            ["İsim", "Adres", "Telefon", "Website", "Email"],
            ["Firma 1", "Konak", "05300000001", "", "f1@example.com"],
        ]
    )

    with TestClient(app) as client:
        admin_login = client.post(
            "/api/auth/login",
            json={"email": "admin@test.local", "password": "Admin12345!"},
        )
        admin_token = admin_login.json()["access_token"]

        second_admin = client.post(
            "/api/users",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "full_name": "Admin Iki",
                "email": "admin2@test.local",
                "password": "Admin23456!",
                "role": "admin",
            },
        ).json()["id"]

        imported = client.post(
            "/api/lists/import",
            headers={
                "Authorization": f"Bearer {admin_token}",
                "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "X-File-Name": "izmir.xlsx",
                "X-List-Name": "Izmir Arama",
            },
            content=workbook,
        )
        call_list_id = imported.json()["id"]

        assigned = client.post(
            f"/api/lists/{call_list_id}/assign-evenly",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"user_ids": [second_admin], "mode": "all"},
        )
        assert assigned.status_code == 422

    db_path.unlink(missing_ok=True)


def test_agent_cannot_update_unassigned_record(monkeypatch) -> None:
    db_path = make_test_db_path()
    monkeypatch.setenv("CALL_PORTAL_DB_PATH", str(db_path))
    monkeypatch.setenv("CALL_PORTAL_ADMIN_EMAIL", "admin@test.local")
    monkeypatch.setenv("CALL_PORTAL_ADMIN_PASSWORD", "Admin12345!")
    monkeypatch.delenv("RENDER", raising=False)

    app = load_fresh_app()
    workbook = build_xlsx_bytes(
        [
            ["İsim", "Adres", "Telefon", "Website", "Email"],
            ["Firma 1", "Konak", "05300000001", "", "f1@example.com"],
        ]
    )

    with TestClient(app) as client:
        admin_login = client.post(
            "/api/auth/login",
            json={"email": "admin@test.local", "password": "Admin12345!"},
        )
        admin_token = admin_login.json()["access_token"]

        client.post(
            "/api/users",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "full_name": "Operator Bir",
                "email": "operator@test.local",
                "password": "Operator123!",
                "role": "agent",
            },
        )

        imported = client.post(
            "/api/lists/import",
            headers={
                "Authorization": f"Bearer {admin_token}",
                "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "X-File-Name": "izmir.xlsx",
                "X-List-Name": "Izmir Arama",
            },
            content=workbook,
        )
        call_list_id = imported.json()["id"]
        records = client.get(
            f"/api/records?call_list_id={call_list_id}",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        record_id = records.json()["items"][0]["id"]

        agent_login = client.post(
            "/api/auth/login",
            json={"email": "operator@test.local", "password": "Operator123!"},
        )
        agent_token = agent_login.json()["access_token"]

        updated = client.patch(
            f"/api/records/{record_id}",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={"call_status": "CALLING", "result_status": "PENDING"},
        )
        assert updated.status_code == 403

    db_path.unlink(missing_ok=True)


def test_agent_cannot_export_inactive_list(monkeypatch) -> None:
    db_path = make_test_db_path()
    monkeypatch.setenv("CALL_PORTAL_DB_PATH", str(db_path))
    monkeypatch.setenv("CALL_PORTAL_ADMIN_EMAIL", "admin@test.local")
    monkeypatch.setenv("CALL_PORTAL_ADMIN_PASSWORD", "Admin12345!")
    monkeypatch.delenv("RENDER", raising=False)

    app = load_fresh_app()
    workbook = build_xlsx_bytes(
        [
            ["İsim", "Adres", "Telefon", "Website", "Email"],
            ["Firma 1", "Konak", "05300000001", "", "f1@example.com"],
        ]
    )

    with TestClient(app) as client:
        admin_login = client.post(
            "/api/auth/login",
            json={"email": "admin@test.local", "password": "Admin12345!"},
        )
        admin_token = admin_login.json()["access_token"]

        agent_id = client.post(
            "/api/users",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "full_name": "Operator Bir",
                "email": "operator@test.local",
                "password": "Operator123!",
                "role": "agent",
            },
        ).json()["id"]

        imported = client.post(
            "/api/lists/import",
            headers={
                "Authorization": f"Bearer {admin_token}",
                "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "X-File-Name": "izmir.xlsx",
                "X-List-Name": "Izmir Arama",
            },
            content=workbook,
        )
        call_list_id = imported.json()["id"]
        client.post(
            f"/api/lists/{call_list_id}/assign-evenly",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"user_ids": [agent_id], "mode": "all"},
        )
        client.patch(
            f"/api/lists/{call_list_id}",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"is_active": False},
        )

        agent_login = client.post(
            "/api/auth/login",
            json={"email": "operator@test.local", "password": "Operator123!"},
        )
        agent_token = agent_login.json()["access_token"]
        exported = client.get(
            f"/api/lists/{call_list_id}/export.csv",
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert exported.status_code == 403

    db_path.unlink(missing_ok=True)


def test_password_change_invalidates_existing_token(monkeypatch) -> None:
    db_path = make_test_db_path()
    monkeypatch.setenv("CALL_PORTAL_DB_PATH", str(db_path))
    monkeypatch.setenv("CALL_PORTAL_ADMIN_EMAIL", "admin@test.local")
    monkeypatch.setenv("CALL_PORTAL_ADMIN_PASSWORD", "Admin12345!")
    monkeypatch.delenv("RENDER", raising=False)

    app = load_fresh_app()

    with TestClient(app) as client:
        admin_login = client.post(
            "/api/auth/login",
            json={"email": "admin@test.local", "password": "Admin12345!"},
        )
        admin_token = admin_login.json()["access_token"]

        agent_id = client.post(
            "/api/users",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "full_name": "Operator Bir",
                "email": "operator@test.local",
                "password": "Operator123!",
                "role": "agent",
            },
        ).json()["id"]

        agent_login = client.post(
            "/api/auth/login",
            json={"email": "operator@test.local", "password": "Operator123!"},
        )
        old_token = agent_login.json()["access_token"]

        changed = client.patch(
            f"/api/users/{agent_id}",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"full_name": "Operator Bir", "password": "Operator456!", "role": "agent", "is_active": True},
        )
        assert changed.status_code == 200

        stale_session = client.get(
            "/api/auth/me",
            headers={"Authorization": f"Bearer {old_token}"},
        )
        assert stale_session.status_code == 401

        new_login = client.post(
            "/api/auth/login",
            json={"email": "operator@test.local", "password": "Operator456!"},
        )
        assert new_login.status_code == 200

    db_path.unlink(missing_ok=True)


def test_user_delete_is_soft_delete_and_invalidates_session(monkeypatch) -> None:
    db_path = make_test_db_path()
    monkeypatch.setenv("CALL_PORTAL_DB_PATH", str(db_path))
    monkeypatch.setenv("CALL_PORTAL_ADMIN_EMAIL", "admin@test.local")
    monkeypatch.setenv("CALL_PORTAL_ADMIN_PASSWORD", "Admin12345!")
    monkeypatch.delenv("RENDER", raising=False)

    app = load_fresh_app()

    with TestClient(app) as client:
        admin_login = client.post(
            "/api/auth/login",
            json={"email": "admin@test.local", "password": "Admin12345!"},
        )
        admin_token = admin_login.json()["access_token"]

        agent_id = client.post(
            "/api/users",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "full_name": "Operator Bir",
                "email": "operator@test.local",
                "password": "Operator123!",
                "role": "agent",
            },
        ).json()["id"]

        agent_login = client.post(
            "/api/auth/login",
            json={"email": "operator@test.local", "password": "Operator123!"},
        )
        old_token = agent_login.json()["access_token"]

        deleted = client.delete(
            f"/api/users/{agent_id}",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert deleted.status_code == 200

        stale_session = client.get(
            "/api/auth/me",
            headers={"Authorization": f"Bearer {old_token}"},
        )
        assert stale_session.status_code == 401

        users = client.get(
            "/api/users",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        soft_deleted_user = next(item for item in users.json() if item["id"] == agent_id)
        assert soft_deleted_user["is_active"] is False

    db_path.unlink(missing_ok=True)


def test_csv_export_escapes_formula_values(monkeypatch) -> None:
    db_path = make_test_db_path()
    monkeypatch.setenv("CALL_PORTAL_DB_PATH", str(db_path))
    monkeypatch.setenv("CALL_PORTAL_ADMIN_EMAIL", "admin@test.local")
    monkeypatch.setenv("CALL_PORTAL_ADMIN_PASSWORD", "Admin12345!")
    monkeypatch.delenv("RENDER", raising=False)

    app = load_fresh_app()
    workbook = build_xlsx_bytes(
        [
            ["İsim", "Adres", "Telefon", "Website", "Email"],
            ["=FORMULA", "+Adres", "05300000001", "https://example.com", "f1@example.com"],
        ]
    )

    with TestClient(app) as client:
        admin_login = client.post(
            "/api/auth/login",
            json={"email": "admin@test.local", "password": "Admin12345!"},
        )
        admin_token = admin_login.json()["access_token"]
        imported = client.post(
            "/api/lists/import",
            headers={
                "Authorization": f"Bearer {admin_token}",
                "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "X-File-Name": "izmir.xlsx",
                "X-List-Name": "Izmir Arama",
            },
            content=workbook,
        )
        call_list_id = imported.json()["id"]
        exported = client.get(
            f"/api/lists/{call_list_id}/export.csv",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        rows = list(csv.reader(StringIO(exported.content.decode("utf-8-sig"))))
        assert rows[1][1] == "'=FORMULA"
        assert rows[1][2] == "'+Adres"

    db_path.unlink(missing_ok=True)


def test_user_create_validation_returns_readable_detail(monkeypatch) -> None:
    db_path = make_test_db_path()
    monkeypatch.setenv("CALL_PORTAL_DB_PATH", str(db_path))
    monkeypatch.setenv("CALL_PORTAL_ADMIN_EMAIL", "admin@test.local")
    monkeypatch.setenv("CALL_PORTAL_ADMIN_PASSWORD", "Admin12345!")
    monkeypatch.delenv("RENDER", raising=False)

    app = load_fresh_app()

    with TestClient(app) as client:
        admin_login = client.post(
            "/api/auth/login",
            json={"email": "admin@test.local", "password": "Admin12345!"},
        )
        admin_token = admin_login.json()["access_token"]
        response = client.post(
            "/api/users",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "email": "operator@test.local",
                "full_name": "Operator",
                "password": "operator123!",
                "role": "agent",
            },
        )

    assert response.status_code == 422
    assert response.json()["detail"] == "Şifre: Şifre en az bir büyük harf içermeli."
    db_path.unlink(missing_ok=True)


def test_favicon_route_uses_brand_mark(monkeypatch) -> None:
    db_path = make_test_db_path()
    monkeypatch.setenv("CALL_PORTAL_DB_PATH", str(db_path))
    monkeypatch.setenv("CALL_PORTAL_ADMIN_EMAIL", "admin@test.local")
    monkeypatch.setenv("CALL_PORTAL_ADMIN_PASSWORD", "Admin12345!")
    monkeypatch.delenv("RENDER", raising=False)

    app = load_fresh_app()

    with TestClient(app) as client:
        response = client.get("/favicon.ico")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/svg+xml")
    db_path.unlink(missing_ok=True)


def test_ping_route_is_public_and_lightweight(monkeypatch) -> None:
    db_path = make_test_db_path()
    monkeypatch.setenv("CALL_PORTAL_DB_PATH", str(db_path))
    monkeypatch.setenv("CALL_PORTAL_ADMIN_EMAIL", "admin@test.local")
    monkeypatch.setenv("CALL_PORTAL_ADMIN_PASSWORD", "Admin12345!")
    monkeypatch.delenv("RENDER", raising=False)

    app = load_fresh_app()

    with TestClient(app) as client:
        response = client.get("/ping")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers["cache-control"] == "no-store"
    db_path.unlink(missing_ok=True)


def test_head_requests_work_for_root_ping_and_health(monkeypatch) -> None:
    db_path = make_test_db_path()
    monkeypatch.setenv("CALL_PORTAL_DB_PATH", str(db_path))
    monkeypatch.setenv("CALL_PORTAL_ADMIN_EMAIL", "admin@test.local")
    monkeypatch.setenv("CALL_PORTAL_ADMIN_PASSWORD", "Admin12345!")
    monkeypatch.delenv("RENDER", raising=False)

    app = load_fresh_app()

    with TestClient(app) as client:
        root_response = client.head("/")
        ping_response = client.head("/ping")
        health_response = client.head("/health")

    assert root_response.status_code == 200
    assert ping_response.status_code == 200
    assert health_response.status_code == 200
    assert root_response.text == ""
    assert ping_response.text == ""
    assert health_response.text == ""
    db_path.unlink(missing_ok=True)


def test_xlsx_parser_rejects_oversized_zip_structure() -> None:
    from io import BytesIO

    from backend.xlsx_reader import parse_xlsx_records

    buffer = BytesIO()
    with ZipFile(buffer, "w", ZIP_DEFLATED) as archive:
        for index in range(251):
            archive.writestr(f"xl/extra{index}.xml", "<x />")

    with pytest.raises(ValueError, match="fazla parca"):
        parse_xlsx_records(buffer.getvalue())


def test_login_rate_limit_persists_in_database(monkeypatch) -> None:
    db_path = make_test_db_path()
    monkeypatch.setenv("CALL_PORTAL_DB_PATH", str(db_path))
    monkeypatch.setenv("CALL_PORTAL_ADMIN_EMAIL", "admin@test.local")
    monkeypatch.setenv("CALL_PORTAL_ADMIN_PASSWORD", "Admin12345!")
    monkeypatch.delenv("RENDER", raising=False)

    app = load_fresh_app()

    with TestClient(app) as client:
        for _ in range(8):
            response = client.post(
                "/api/auth/login",
                json={"email": "admin@test.local", "password": "yanlis-sifre"},
            )
            assert response.status_code == 401

        blocked = client.post(
            "/api/auth/login",
            json={"email": "admin@test.local", "password": "yanlis-sifre"},
        )
        assert blocked.status_code == 429

    connection = sqlite3.connect(db_path)
    try:
        total = connection.execute("SELECT COUNT(*) FROM login_attempts").fetchone()[0]
        assert total == 8
    finally:
        connection.close()
    db_path.unlink(missing_ok=True)


def test_startup_creates_schema_migration_state(monkeypatch) -> None:
    db_path = make_test_db_path()
    monkeypatch.setenv("CALL_PORTAL_DB_PATH", str(db_path))
    monkeypatch.setenv("CALL_PORTAL_ADMIN_EMAIL", "admin@test.local")
    monkeypatch.setenv("CALL_PORTAL_ADMIN_PASSWORD", "Admin12345!")
    monkeypatch.delenv("RENDER", raising=False)

    app = load_fresh_app()

    with TestClient(app):
        pass

    connection = sqlite3.connect(db_path)
    try:
        applied_versions = {
            row[0]
            for row in connection.execute("SELECT version FROM schema_migrations ORDER BY version").fetchall()
        }
        assert applied_versions == {1, 2, 3, 4, 5}
        login_attempts_table = connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'login_attempts'"
        ).fetchone()
        assert login_attempts_table is not None
        token_version_column = connection.execute("PRAGMA table_info(users)").fetchall()
        user_columns = {row[1] for row in token_version_column}
        assert "token_version" in user_columns
        assert "can_access_offer_tool" in user_columns
        contact_pool_table = connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contact_pool_entries'"
        ).fetchone()
        assert contact_pool_table is not None
    finally:
        connection.close()
    db_path.unlink(missing_ok=True)


def test_offer_module_requires_permission_and_uses_session_cookie(monkeypatch) -> None:
    db_path = make_test_db_path()
    monkeypatch.setenv("CALL_PORTAL_DB_PATH", str(db_path))
    monkeypatch.setenv("CALL_PORTAL_ADMIN_EMAIL", "admin@test.local")
    monkeypatch.setenv("CALL_PORTAL_ADMIN_PASSWORD", "Admin12345!")
    monkeypatch.delenv("RENDER", raising=False)

    app = load_fresh_app()

    with TestClient(app) as client:
        denied_redirect = client.get("/teklif/", follow_redirects=False)
        assert denied_redirect.status_code in {303, 307, 401}

        admin_login = client.post(
            "/api/auth/login",
            json={"email": "admin@test.local", "password": "Admin12345!"},
        )
        assert admin_login.status_code == 200
        assert "call_portal_session" in admin_login.cookies
        me_from_cookie = client.get("/api/auth/me")
        assert me_from_cookie.status_code == 200
        assert me_from_cookie.json()["email"] == "admin@test.local"

        admin_offer = client.get("/teklif/")
        assert admin_offer.status_code == 200
        assert "Rainwater Teklif Ofisi" in admin_offer.text
        assert "Teklif akışlarını tek merkezden yönet" in admin_offer.text
        assert "Şablon PDF yükle" in admin_offer.text
        assert "/teklif/create-offer" in admin_offer.text
        assert "/teklif/admin/import-template" in admin_offer.text
        assert "/teklif/admin/create-offer" not in admin_offer.text
        assert "/teklif/static/vendor/bootstrap/bootstrap.min.css" in admin_offer.text
        assert "/teklif/static/styles.css" in admin_offer.text

        offer_bootstrap = client.get("/teklif/static/vendor/bootstrap/bootstrap.min.css")
        assert offer_bootstrap.status_code == 200
        offer_styles = client.get("/teklif/static/styles.css")
        assert offer_styles.status_code == 200
        offer_sound = client.get("/teklif/static/audio/choose2.wav")
        assert offer_sound.status_code == 200
        assert len(offer_sound.content) > 0

        created_user = client.post(
            "/api/users",
            headers={"Authorization": f"Bearer {admin_login.json()['access_token']}"},
            json={
                "full_name": "Teklifsiz Operator",
                "email": "agent@test.local",
                "password": "Operator123!",
                "role": "agent",
                "can_access_offer_tool": False,
            },
        )
        assert created_user.status_code == 201

        agent_client = TestClient(app)
        with agent_client:
            agent_login = agent_client.post(
                "/api/auth/login",
                json={"email": "agent@test.local", "password": "Operator123!"},
            )
            assert agent_login.status_code == 200
            denied_offer = agent_client.get("/teklif/", follow_redirects=False)
            assert denied_offer.status_code == 403

        updated_user = client.patch(
            f"/api/users/{created_user.json()['id']}",
            headers={"Authorization": f"Bearer {admin_login.json()['access_token']}"},
            json={"can_access_offer_tool": True},
        )
        assert updated_user.status_code == 200
        assert updated_user.json()["can_access_offer_tool"] is True

        grant_client = TestClient(app)
        with grant_client:
            grant_login = grant_client.post(
                "/api/auth/login",
                json={"email": "agent@test.local", "password": "Operator123!"},
            )
            assert grant_login.status_code == 200
        granted_offer = grant_client.get("/teklif/")
        assert granted_offer.status_code == 200
        assert "Teklif akışlarını tek merkezden yönet" in granted_offer.text
        assert "Şablon PDF yükle" not in granted_offer.text
        assert "/teklif/static/styles.css" in granted_offer.text


def test_generated_offer_pdf_keeps_turkish_text_and_template_layout(tmp_path) -> None:
    from datetime import date

    import fitz
    from openpyxl import Workbook

    from backend.offer_module.teklif_kontrol import OfferSelection, create_offer_from_catalog

    template_path = tmp_path / "sablon.pdf"
    template_doc = fitz.open()
    template_page = template_doc.new_page(width=540, height=780)
    template_page.draw_rect(
        fitz.Rect(0, 0, 540, 84),
        color=(0.2, 0.6, 0.9),
        fill=(0.2, 0.6, 0.9),
    )
    template_page.insert_textbox(
        fitz.Rect(340, 732, 520, 748),
        "444 0 420 | www.rainwater.com.tr",
        fontsize=8,
        color=(0, 0, 0),
    )
    template_doc.save(template_path)
    template_doc.close()

    price_path = tmp_path / "fiyat.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["URUN", "2026 KURUMSAL NAKIT"])
    sheet.append(["Rainwater \u00c7ift Filtre \u00d6zel \u0130\u00e7me Suyu Ar\u0131tma Sistemi", 12500])
    workbook.save(price_path)

    output_path = tmp_path / "teklif.pdf"
    create_offer_from_catalog(
        template_path=template_path,
        price_list_path=price_path,
        selected_column="2026 KURUMSAL NAKIT",
        selected_entries=[OfferSelection(2, 2, discount_type="amount", discount_value=500)],
        vat_included=False,
        offer_number="RW-TEST-001",
        offer_date=date(2026, 4, 24),
        valid_until=date(2026, 5, 1),
        company_name="\u00c7a\u011fr\u0131 \u0130leti\u015fim \u015eirketi",
        contact_name="\u0130lknur Han\u0131m",
        email="test@example.com",
        gsm="0555 111 22 33",
        note_text="T\u00fcrk\u00e7e karakter kontrol\u00fc: \u015f, \u011f, \u00fc, \u00f6, \u00e7, \u0130",
        output_path=output_path,
    )

    generated = fitz.open(output_path)
    page = generated[0]
    text = page.get_text().replace("\xa0", " ")
    assert "\u00c7a\u011fr\u0131 \u0130leti\u015fim \u015eirketi" in text
    assert "RAINWATER \u00c7\u0130FT F\u0130LTRE \u00d6ZEL \u0130\u00c7ME" in text
    assert "SUYU ARITMA S\u0130STEM\u0130" in text
    assert "T\u00fcrk\u00e7e karakter kontrol\u00fc: \u015f, \u011f, \u00fc, \u00f6, \u00e7, \u0130" in text
    assert "\u0130SKONTO TUTARI" in text
    assert "YATIRIM MAL\u0130YET\u0130" in text
    assert "KDV (%20)" in text
    assert "19.833 TL" in text
    assert "23.800 TL" in text

    bottom_signature_lines = []
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            line_text = "".join(span.get("text", "") for span in line.get("spans", []))
            if "YETK\u0130L\u0130" in line_text and fitz.Rect(line["bbox"]).y0 > 630:
                bottom_signature_lines.append(fitz.Rect(line["bbox"]))
    assert bottom_signature_lines
    assert bottom_signature_lines[0].x0 > 330
