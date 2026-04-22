from __future__ import annotations

import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator

from .security import get_password_hash


BASE_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = BASE_DIR / "data" / "portal.db"
CURRENT_SCHEMA_VERSION = 4
POOL_CALL_STATUSES = {"CALLED", "UNREACHABLE", "CALLBACK", "COMPLETED"}
REACHED_RESULT_STATUSES = {"POSITIVE", "NEGATIVE", "NOT_INTERESTED"}
UNREACHED_RESULT_STATUSES = {"NO_ANSWER", "WRONG_NUMBER"}


def _migration_001_initial_schema() -> str:
    return """
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            full_name TEXT,
            role TEXT NOT NULL CHECK (role IN ('admin', 'agent')),
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS call_lists (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            source_file_name TEXT,
            row_count INTEGER NOT NULL DEFAULT 0,
            duplicate_count INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_by_user_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS call_records (
            id TEXT PRIMARY KEY,
            call_list_id TEXT NOT NULL,
            source_sheet_name TEXT,
            source_row_number INTEGER,
            dedupe_key TEXT NOT NULL,
            company_name TEXT,
            address TEXT,
            phone TEXT,
            normalized_phone TEXT,
            website TEXT,
            email TEXT,
            email_status TEXT,
            rating TEXT,
            review_count TEXT,
            source_link TEXT,
            source_created_at TEXT,
            raw_payload TEXT,
            assigned_user_id TEXT,
            call_status TEXT NOT NULL DEFAULT 'NOT_CALLED',
            result_status TEXT NOT NULL DEFAULT 'PENDING',
            note TEXT,
            locked_by_user_id TEXT,
            locked_at TEXT,
            last_contacted_at TEXT,
            updated_by_user_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (call_list_id) REFERENCES call_lists(id) ON DELETE CASCADE,
            FOREIGN KEY (assigned_user_id) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY (locked_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
            UNIQUE (call_list_id, dedupe_key)
        );

        CREATE TABLE IF NOT EXISTS call_record_events (
            id TEXT PRIMARY KEY,
            call_record_id TEXT NOT NULL,
            actor_user_id TEXT,
            actor_role TEXT NOT NULL,
            action TEXT NOT NULL,
            previous_call_status TEXT,
            next_call_status TEXT,
            previous_result_status TEXT,
            next_result_status TEXT,
            note TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (call_record_id) REFERENCES call_records(id) ON DELETE CASCADE,
            FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
        CREATE INDEX IF NOT EXISTS idx_call_lists_active ON call_lists(is_active);
        CREATE INDEX IF NOT EXISTS idx_call_records_list ON call_records(call_list_id);
        CREATE INDEX IF NOT EXISTS idx_call_records_assigned ON call_records(assigned_user_id);
        CREATE INDEX IF NOT EXISTS idx_call_records_status ON call_records(call_status, result_status);
        CREATE INDEX IF NOT EXISTS idx_call_records_updated ON call_records(updated_at);
        CREATE INDEX IF NOT EXISTS idx_call_record_events_record ON call_record_events(call_record_id, created_at);
    """


def _migration_002_login_attempts() -> str:
    return """
        CREATE TABLE IF NOT EXISTS login_attempts (
            id TEXT PRIMARY KEY,
            ip_address TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_created
        ON login_attempts(ip_address, created_at);
    """


def _migration_003_user_token_version() -> str:
    return """
        ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
    """


def _migration_004_contact_pool() -> str:
    return """
        CREATE TABLE IF NOT EXISTS contact_pool_entries (
            id TEXT PRIMARY KEY,
            call_record_id TEXT NOT NULL UNIQUE,
            call_list_id TEXT NOT NULL,
            company_name TEXT,
            address TEXT,
            phone TEXT,
            website TEXT,
            email TEXT,
            reach_status TEXT NOT NULL CHECK (reach_status IN ('REACHED', 'UNREACHED', 'FOLLOW_UP', 'UNKNOWN')),
            reach_status_is_manual INTEGER NOT NULL DEFAULT 0,
            call_status TEXT NOT NULL,
            result_status TEXT NOT NULL,
            record_note TEXT,
            admin_note TEXT,
            is_active INTEGER NOT NULL DEFAULT 1,
            last_record_updated_at TEXT NOT NULL,
            updated_by_user_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (call_record_id) REFERENCES call_records(id) ON DELETE CASCADE,
            FOREIGN KEY (call_list_id) REFERENCES call_lists(id) ON DELETE CASCADE,
            FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_contact_pool_list ON contact_pool_entries(call_list_id);
        CREATE INDEX IF NOT EXISTS idx_contact_pool_reach ON contact_pool_entries(reach_status, is_active);
        CREATE INDEX IF NOT EXISTS idx_contact_pool_updated ON contact_pool_entries(updated_at);
    """


MIGRATIONS: tuple[tuple[int, str, str], ...] = (
    (1, "initial_schema", _migration_001_initial_schema()),
    (2, "login_attempts", _migration_002_login_attempts()),
    (3, "user_token_version", _migration_003_user_token_version()),
    (4, "contact_pool", _migration_004_contact_pool()),
)


def utcnow() -> str:
    return datetime.now(UTC).isoformat()


def get_db_path() -> Path:
    raw = os.getenv("CALL_PORTAL_DB_PATH")
    if raw:
        return Path(raw).expanduser().resolve()
    return DEFAULT_DB_PATH


def connect_db() -> sqlite3.Connection:
    db_path = get_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path, check_same_thread=False, timeout=30.0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA synchronous = NORMAL")
    connection.execute("PRAGMA busy_timeout = 5000")
    return connection


@contextmanager
def get_connection() -> Iterator[sqlite3.Connection]:
    connection = connect_db()
    try:
        yield connection
    finally:
        connection.close()


def _ensure_migration_table(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL
        )
        """
    )


def _apply_migrations(connection: sqlite3.Connection) -> None:
    _ensure_migration_table(connection)
    applied_versions = {
        row["version"]
        for row in connection.execute("SELECT version FROM schema_migrations").fetchall()
    }
    for version, name, sql in MIGRATIONS:
        if version in applied_versions:
            continue
        connection.executescript(sql)
        connection.execute(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
            (version, name, utcnow()),
        )


def _ensure_admin_user(connection: sqlite3.Connection) -> None:
    admin_email = os.getenv("CALL_PORTAL_ADMIN_EMAIL", "admin@callportal.local").strip().lower()
    admin_password = os.getenv("CALL_PORTAL_ADMIN_PASSWORD", "Admin12345!")
    admin_name = os.getenv("CALL_PORTAL_ADMIN_NAME", "Portal Admin").strip() or "Portal Admin"

    existing_admin = connection.execute(
        "SELECT id FROM users WHERE lower(email) = ?",
        (admin_email,),
    ).fetchone()
    if existing_admin is not None:
        return

    now = utcnow()
    connection.execute(
        """
        INSERT INTO users (id, email, password_hash, full_name, role, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'admin', 1, ?, ?)
        """,
        (
            str(uuid.uuid4()),
            admin_email,
            get_password_hash(admin_password),
            admin_name,
            now,
            now,
        ),
    )


def _record_belongs_to_pool(call_status: str, result_status: str) -> bool:
    return call_status in POOL_CALL_STATUSES or result_status != "PENDING"


def _derive_reach_status(call_status: str, result_status: str) -> str:
    if result_status in REACHED_RESULT_STATUSES:
        return "REACHED"
    if result_status in UNREACHED_RESULT_STATUSES:
        return "UNREACHED"
    if call_status in {"CALLED", "COMPLETED"}:
        return "REACHED"
    if call_status == "UNREACHABLE":
        return "UNREACHED"
    if call_status == "CALLBACK":
        return "FOLLOW_UP"
    return "UNKNOWN"


def _backfill_contact_pool_entries(connection: sqlite3.Connection) -> None:
    table = connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contact_pool_entries'"
    ).fetchone()
    if table is None:
        return

    rows = connection.execute(
        """
        SELECT
            id, call_list_id, company_name, address, phone, website, email,
            call_status, result_status, note, updated_by_user_id, updated_at
        FROM call_records
        WHERE call_status IN ('CALLED', 'UNREACHABLE', 'CALLBACK', 'COMPLETED')
           OR result_status != 'PENDING'
        """
    ).fetchall()
    now = utcnow()
    for row in rows:
        if not _record_belongs_to_pool(row["call_status"], row["result_status"]):
            continue
        connection.execute(
            """
            INSERT OR IGNORE INTO contact_pool_entries (
                id, call_record_id, call_list_id, company_name, address, phone, website, email,
                reach_status, reach_status_is_manual, call_status, result_status, record_note,
                admin_note, is_active, last_record_updated_at, updated_by_user_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, 1, ?, ?, ?, ?)
            """,
            (
                str(uuid.uuid4()),
                row["id"],
                row["call_list_id"],
                row["company_name"],
                row["address"],
                row["phone"],
                row["website"],
                row["email"],
                _derive_reach_status(row["call_status"], row["result_status"]),
                row["call_status"],
                row["result_status"],
                row["note"],
                row["updated_at"],
                row["updated_by_user_id"],
                now,
                now,
            ),
        )


def init_db() -> None:
    with get_connection() as connection:
        _apply_migrations(connection)
        _ensure_admin_user(connection)
        _backfill_contact_pool_entries(connection)
        connection.commit()


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {key: row[key] for key in row.keys()}
