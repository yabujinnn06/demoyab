from __future__ import annotations

import json
import uuid

from backend.database import get_connection, init_db, utcnow
from backend.security import get_password_hash


DEMO_AGENT_EMAIL = "operator.demo@yabujin.local"
DEMO_AGENT_PASSWORD = "DemoOperator123!"
DEMO_AGENT_NAME = "Demo Operator"
DEMO_LIST_NAME = "Demo Izmir Bayrakli Operasyon"
DEMO_SOURCE_FILE = "demo_izmir_bayrakli.xlsx"


def ensure_demo_agent(connection) -> str:
    row = connection.execute(
        "SELECT id FROM users WHERE lower(email) = ?",
        (DEMO_AGENT_EMAIL.lower(),),
    ).fetchone()
    now = utcnow()
    password_hash = get_password_hash(DEMO_AGENT_PASSWORD)

    if row is None:
        user_id = str(uuid.uuid4())
        connection.execute(
            """
            INSERT INTO users (id, email, password_hash, full_name, role, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'agent', 1, ?, ?)
            """,
            (user_id, DEMO_AGENT_EMAIL, password_hash, DEMO_AGENT_NAME, now, now),
        )
        return user_id

    connection.execute(
        """
        UPDATE users
        SET password_hash = ?, full_name = ?, is_active = 1, updated_at = ?
        WHERE id = ?
        """,
        (password_hash, DEMO_AGENT_NAME, now, row["id"]),
    )
    return row["id"]


def find_admin_id(connection) -> str:
    row = connection.execute(
        "SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1"
    ).fetchone()
    if row is None:
        raise RuntimeError("Admin user not found.")
    return row["id"]


def delete_existing_demo_list(connection) -> None:
    existing = connection.execute(
        "SELECT id FROM call_lists WHERE name = ?",
        (DEMO_LIST_NAME,),
    ).fetchall()
    for row in existing:
        connection.execute(
            """
            DELETE FROM call_record_events
            WHERE call_record_id IN (SELECT id FROM call_records WHERE call_list_id = ?)
            """,
            (row["id"],),
        )
        connection.execute("DELETE FROM call_records WHERE call_list_id = ?", (row["id"],))
        connection.execute("DELETE FROM call_lists WHERE id = ?", (row["id"],))


def demo_records():
    return [
        {
            "company_name": "Bayraklı Nova Klinik",
            "address": "Manas Bulvarı No:44 Bayraklı / İzmir",
            "phone": "0532 410 21 45",
            "website": None,
            "email": "iletisim@novaklinik.example",
            "call_status": "NOT_CALLED",
            "result_status": "PENDING",
            "note": None,
        },
        {
            "company_name": "Mavi Estetik Merkezi",
            "address": "Anadolu Caddesi No:112 Bayraklı / İzmir",
            "phone": "0533 781 64 20",
            "website": "https://maviestetik.example",
            "email": None,
            "call_status": "CALLBACK",
            "result_status": "PENDING",
            "note": "Sekreter geri dönüş istedi.",
        },
        {
            "company_name": "Kentplus Fizik Tedavi",
            "address": None,
            "phone": "0534 985 77 31",
            "website": "https://kentplus.example",
            "email": "randevu@kentplus.example",
            "call_status": "COMPLETED",
            "result_status": "POSITIVE",
            "note": "Yetkili sunum talep etti.",
        },
        {
            "company_name": "Ege Point Diş Polikliniği",
            "address": "Folkart Towers karşısı Bayraklı / İzmir",
            "phone": None,
            "website": "https://egepoint.example",
            "email": "iletisim@egepoint.example",
            "call_status": "UNREACHABLE",
            "result_status": "NO_ANSWER",
            "note": "İki kez arandı, cevap yok.",
        },
        {
            "company_name": "Aplus Güzellik Stüdyosu",
            "address": "Mansuroğlu Mah. 286/4 Sok. Bayraklı / İzmir",
            "phone": "0535 903 26 14",
            "website": "https://aplusguzellik.example",
            "email": "hello@aplusguzellik.example",
            "call_status": "CALLED",
            "result_status": "NEGATIVE",
            "note": "Hizmetle ilgilenmediklerini belirttiler.",
        },
        {
            "company_name": "Bayraklı Vera Tıp Merkezi",
            "address": "Ankara Asfaltı Cad. No:208 Bayraklı / İzmir",
            "phone": "0537 115 42 60",
            "website": None,
            "email": None,
            "call_status": "CALLING",
            "result_status": "PENDING",
            "note": "Görüşme sürüyor.",
        },
        {
            "company_name": "Medblue Klinik",
            "address": "Bayraklı Towers 18. Kat İzmir",
            "phone": "0530 884 71 53",
            "website": "https://medblue.example",
            "email": "info@medblue.example",
            "call_status": "NOT_CALLED",
            "result_status": "PENDING",
            "note": None,
        },
        {
            "company_name": "Smyrna Sağlık Danışmanlık",
            "address": "Mansuroğlu Mah. 286/7 Sok. Bayraklı / İzmir",
            "phone": "0538 221 35 08",
            "website": "https://smyrnasaglik.example",
            "email": "iletisim@smyrnasaglik.example",
            "call_status": "COMPLETED",
            "result_status": "WRONG_NUMBER",
            "note": "Numara farklı firmaya çıktı.",
        },
    ]


def seed_demo() -> None:
    init_db()
    with get_connection() as connection:
        admin_id = find_admin_id(connection)
        agent_id = ensure_demo_agent(connection)
        delete_existing_demo_list(connection)

        now = utcnow()
        call_list_id = str(uuid.uuid4())
        connection.execute(
            """
            INSERT INTO call_lists (
                id, name, source_file_name, row_count, duplicate_count, is_active,
                created_by_user_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?)
            """,
            (
                call_list_id,
                DEMO_LIST_NAME,
                DEMO_SOURCE_FILE,
                len(demo_records()),
                admin_id,
                now,
                now,
            ),
        )

        for index, item in enumerate(demo_records(), start=2):
            record_id = str(uuid.uuid4())
            record_now = utcnow()
            last_contacted_at = record_now if item["call_status"] != "NOT_CALLED" else None
            updated_by_user_id = agent_id if item["note"] else admin_id
            normalized_phone = (
                "".join(ch for ch in (item["phone"] or "") if ch.isdigit())[-10:] or None
            )
            connection.execute(
                """
                INSERT INTO call_records (
                    id, call_list_id, source_sheet_name, source_row_number, dedupe_key,
                    company_name, address, phone, normalized_phone, website, email,
                    email_status, rating, review_count, source_link, source_created_at,
                    raw_payload, assigned_user_id, call_status, result_status, note,
                    locked_by_user_id, locked_at, last_contacted_at, updated_by_user_id,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record_id,
                    call_list_id,
                    "Demo",
                    index,
                    f"demo:{index}",
                    item["company_name"],
                    item["address"],
                    item["phone"],
                    normalized_phone,
                    item["website"],
                    item["email"],
                    "unknown",
                    None,
                    None,
                    item["website"],
                    now,
                    json.dumps(item, ensure_ascii=False),
                    agent_id,
                    item["call_status"],
                    item["result_status"],
                    item["note"],
                    agent_id if item["call_status"] == "CALLING" else None,
                    record_now if item["call_status"] == "CALLING" else None,
                    last_contacted_at,
                    updated_by_user_id,
                    record_now,
                    record_now,
                ),
            )

            connection.execute(
                """
                INSERT INTO call_record_events (
                    id, call_record_id, actor_user_id, actor_role, action,
                    previous_call_status, next_call_status, previous_result_status,
                    next_result_status, note, created_at
                ) VALUES (?, ?, ?, 'admin', 'ASSIGNED', 'NOT_CALLED', ?, 'PENDING', ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    record_id,
                    admin_id,
                    item["call_status"],
                    item["result_status"],
                    None,
                    record_now,
                ),
            )

            if item["note"]:
                connection.execute(
                    """
                    INSERT INTO call_record_events (
                        id, call_record_id, actor_user_id, actor_role, action,
                        previous_call_status, next_call_status, previous_result_status,
                        next_result_status, note, created_at
                    ) VALUES (?, ?, ?, 'agent', 'UPDATED', 'NOT_CALLED', ?, 'PENDING', ?, ?, ?)
                    """,
                    (
                        str(uuid.uuid4()),
                        record_id,
                        agent_id,
                        item["call_status"],
                        item["result_status"],
                        item["note"],
                        record_now,
                    ),
                )

        connection.commit()

    print("Demo data seeded.")
    print(f"Agent email: {DEMO_AGENT_EMAIL}")
    print(f"Agent password: {DEMO_AGENT_PASSWORD}")
    print(f"Demo list: {DEMO_LIST_NAME}")


if __name__ == "__main__":
    seed_demo()
