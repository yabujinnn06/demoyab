from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
import csv
import io
import os
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.concurrency import run_in_threadpool

from .database import CURRENT_SCHEMA_VERSION, get_connection, init_db, utcnow
from .security import create_token, decode_token, get_password_hash, verify_password
from .xlsx_reader import parse_xlsx_records, raw_payload_json


STATIC_DIR = Path(__file__).resolve().parent / "static"
DEFAULT_SECRET_KEY = "call-portal-dev-secret-change-me"
DEFAULT_ADMIN_PASSWORD = "Admin12345!"
DEFAULT_ALLOWED_ORIGINS = tuple(
    origin.strip()
    for origin in os.getenv("CALL_PORTAL_ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
)
LOGIN_WINDOW_SECONDS = 10 * 60
LOGIN_MAX_ATTEMPTS = 8
CALL_STATUS_VALUES = {
    "NOT_CALLED",
    "CALLING",
    "CALLED",
    "UNREACHABLE",
    "CALLBACK",
    "COMPLETED",
}
RESULT_STATUS_VALUES = {
    "PENDING",
    "POSITIVE",
    "NEGATIVE",
    "NO_ANSWER",
    "WRONG_NUMBER",
    "NOT_INTERESTED",
}
REACH_STATUS_VALUES = {"REACHED", "UNREACHED", "FOLLOW_UP", "UNKNOWN"}
POOL_CALL_STATUSES = {"CALLED", "UNREACHABLE", "CALLBACK", "COMPLETED"}
REACHED_RESULT_STATUSES = {"POSITIVE", "NEGATIVE", "NOT_INTERESTED"}
UNREACHED_RESULT_STATUSES = {"NO_ANSWER", "WRONG_NUMBER"}


def _password_policy_error(password: str) -> str | None:
    if len(password) < 10:
        return "Şifre en az 10 karakter olmalı."
    if not any(character.islower() for character in password):
        return "Şifre en az bir küçük harf içermeli."
    if not any(character.isupper() for character in password):
        return "Şifre en az bir büyük harf içermeli."
    if not any(character.isdigit() for character in password):
        return "Şifre en az bir rakam içermeli."
    if not any(not character.isalnum() for character in password):
        return "Şifre en az bir sembol içermeli."
    return None


def _validate_password_policy(password: str) -> str:
    error = _password_policy_error(password)
    if error:
        raise ValueError(error)
    return password


def _validate_runtime_config() -> None:
    if not os.getenv("RENDER"):
        return
    secret_key = os.getenv("CALL_PORTAL_SECRET_KEY", DEFAULT_SECRET_KEY)
    admin_password = os.getenv("CALL_PORTAL_ADMIN_PASSWORD", DEFAULT_ADMIN_PASSWORD)
    if secret_key == DEFAULT_SECRET_KEY or len(secret_key) < 32:
        raise RuntimeError("Render ortaminda CALL_PORTAL_SECRET_KEY ayarlanmak zorunda.")
    if admin_password == DEFAULT_ADMIN_PASSWORD:
        raise RuntimeError("Render ortaminda CALL_PORTAL_ADMIN_PASSWORD varsayilan deger olamaz.")
    password_error = _password_policy_error(admin_password)
    if password_error:
        raise RuntimeError(f"Render ortaminda CALL_PORTAL_ADMIN_PASSWORD guclu olmali: {password_error}")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    _validate_runtime_config()
    await run_in_threadpool(init_db)
    yield


app = FastAPI(title="Yabujin Scrap Controller", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(DEFAULT_ALLOWED_ORIGINS),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-File-Name", "X-List-Name"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


VALIDATION_FIELD_LABELS = {
    "email": "Email",
    "password": "Şifre",
    "full_name": "Ad / takma ad",
    "role": "Rol",
    "is_active": "Aktiflik",
    "user_ids": "Kullanıcı seçimi",
    "allocations": "Özel dağıtım",
    "count": "Kayıt sayısı",
    "name": "Liste adı",
    "call_status": "Arama durumu",
    "result_status": "Sonuç durumu",
    "note": "Not",
    "reach_status": "Ulaşım durumu",
    "admin_note": "Havuz notu",
    "include_inactive": "Pasif havuz kayıtları",
}


def _validation_error_message(error: dict[str, Any]) -> str:
    location = [str(item) for item in error.get("loc", []) if item not in {"body", "query", "path"}]
    field_name = location[-1] if location else ""
    label = VALIDATION_FIELD_LABELS.get(field_name, field_name or "Alan")
    error_type = str(error.get("type", ""))
    context = error.get("ctx") or {}
    message = str(error.get("msg", "Geçersiz değer."))

    if message.startswith("Value error, "):
        message = message.removeprefix("Value error, ")
    elif error_type == "missing":
        message = "zorunlu."
    elif error_type == "string_too_short":
        message = f"en az {context.get('min_length', 1)} karakter olmalı."
    elif error_type == "string_too_long":
        message = f"en fazla {context.get('max_length', 255)} karakter olmalı."
    elif error_type == "literal_error":
        expected = context.get("expected")
        message = f"geçersiz seçim. Beklenen: {expected}."
    elif error_type in {"int_parsing", "int_type"}:
        message = "sayı olmalı."
    elif error_type == "greater_than_equal":
        message = f"en az {context.get('ge', 0)} olmalı."

    return f"{label}: {message}"


def _validation_error_detail(errors: list[dict[str, Any]]) -> str:
    return " ".join(_validation_error_message(error) for error in errors)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={"detail": _validation_error_detail(exc.errors())},
    )


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=6, max_length=255)


class UserCreateRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=10, max_length=255)
    full_name: str = Field(min_length=2, max_length=255)
    role: Literal["admin", "agent"] = "agent"

    @field_validator("password")
    @classmethod
    def password_is_strong(cls, value: str) -> str:
        return _validate_password_policy(value)


class UserUpdateRequest(BaseModel):
    full_name: str | None = Field(default=None, min_length=2, max_length=255)
    password: str | None = Field(default=None, min_length=10, max_length=255)
    role: Literal["admin", "agent"] | None = None
    is_active: bool | None = None

    @field_validator("password")
    @classmethod
    def password_is_strong(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_password_policy(value)


class UserRead(BaseModel):
    id: str
    email: str
    full_name: str | None = None
    role: Literal["admin", "agent"]
    is_active: bool
    created_at: str
    updated_at: str

    model_config = ConfigDict(extra="ignore")


class UserLoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserRead


class CallListSummaryRead(BaseModel):
    total: int = 0
    assigned: int = 0
    not_called: int = 0
    calling: int = 0
    called: int = 0
    unreachable: int = 0
    callback: int = 0
    completed: int = 0
    positive: int = 0
    negative: int = 0
    pending: int = 0


class CallListRead(BaseModel):
    id: str
    name: str
    source_file_name: str | None = None
    row_count: int
    duplicate_count: int
    is_active: bool
    created_at: str
    updated_at: str
    summary: CallListSummaryRead


class CallRecordRead(BaseModel):
    id: str
    call_list_id: str
    call_list_name: str
    source_sheet_name: str | None = None
    source_row_number: int | None = None
    company_name: str | None = None
    address: str | None = None
    phone: str | None = None
    website: str | None = None
    email: str | None = None
    email_status: str | None = None
    rating: str | None = None
    review_count: str | None = None
    source_link: str | None = None
    source_created_at: str | None = None
    assigned_user_id: str | None = None
    assigned_user_name: str | None = None
    call_status: Literal["NOT_CALLED", "CALLING", "CALLED", "UNREACHABLE", "CALLBACK", "COMPLETED"]
    result_status: Literal["PENDING", "POSITIVE", "NEGATIVE", "NO_ANSWER", "WRONG_NUMBER", "NOT_INTERESTED"]
    note: str | None = None
    locked_by_user_id: str | None = None
    locked_by_user_name: str | None = None
    last_contacted_at: str | None = None
    updated_by_user_id: str | None = None
    updated_by_user_name: str | None = None
    updated_at: str


class CallRecordPageResponse(BaseModel):
    items: list[CallRecordRead]
    total: int
    offset: int
    limit: int
    summary: CallListSummaryRead | None = None


class ContactPoolEntryRead(BaseModel):
    id: str
    call_record_id: str
    call_list_id: str
    call_list_name: str
    company_name: str | None = None
    address: str | None = None
    phone: str | None = None
    website: str | None = None
    email: str | None = None
    reach_status: Literal["REACHED", "UNREACHED", "FOLLOW_UP", "UNKNOWN"]
    call_status: str
    result_status: str
    record_note: str | None = None
    admin_note: str | None = None
    assigned_user_name: str | None = None
    updated_by_user_name: str | None = None
    is_active: bool
    last_record_updated_at: str
    updated_at: str


class ContactPoolPageResponse(BaseModel):
    items: list[ContactPoolEntryRead]
    total: int
    offset: int
    limit: int


class ContactPoolUpdateRequest(BaseModel):
    reach_status: Literal["REACHED", "UNREACHED", "FOLLOW_UP", "UNKNOWN"] | None = None
    admin_note: str | None = Field(default=None, max_length=4000)
    is_active: bool | None = None


class OperatorStatsRead(BaseModel):
    user_id: str
    full_name: str | None = None
    email: str
    is_active: bool
    assigned_count: int
    processed_count: int
    reached_count: int
    unreached_count: int
    positive_count: int
    negative_count: int
    no_answer_count: int
    callback_count: int
    last_activity_at: str | None = None


class ActivityRead(BaseModel):
    id: str
    call_record_id: str
    call_list_id: str
    call_list_name: str
    company_name: str | None = None
    actor_user_id: str | None = None
    actor_user_name: str | None = None
    actor_role: str
    action: str
    previous_call_status: str | None = None
    next_call_status: str | None = None
    previous_result_status: str | None = None
    next_result_status: str | None = None
    note: str | None = None
    created_at: str


class CallListAssignRequest(BaseModel):
    user_ids: list[str] = Field(min_length=1)
    mode: Literal["unassigned", "all"] = "unassigned"


class CallListCustomAssignItem(BaseModel):
    user_id: str = Field(min_length=1)
    count: int = Field(ge=1)


class CallListCustomAssignRequest(BaseModel):
    allocations: list[CallListCustomAssignItem] = Field(min_length=1)
    mode: Literal["unassigned", "all"] = "unassigned"


class CallListUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    is_active: bool | None = None


class CallRecordUpdateRequest(BaseModel):
    assigned_user_id: str | None = None
    clear_assignment: bool = False
    call_status: str | None = None
    result_status: str | None = None
    note: str | None = Field(default=None, max_length=4000)


class AssignResponse(BaseModel):
    ok: bool
    assigned_count: int
    remaining_count: int = 0


class OkResponse(BaseModel):
    ok: bool


class AuthUser(BaseModel):
    id: str
    email: str
    full_name: str | None
    role: Literal["admin", "agent"]
    is_active: bool
    token_version: int = 0

def _api_error(status_code: int, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail=message)


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").strip()
    raw_ip = request.client.host if request.client else "unknown"
    if os.getenv("RENDER") and forwarded:
        raw_ip = forwarded.split(",", 1)[0].strip() or raw_ip
    raw_ip = raw_ip.strip().replace("\x00", "")
    return raw_ip[:80] or "unknown"


def _csv_cell(value: Any) -> str:
    if value is None:
        return ""
    text = str(value)
    if text and text[0] in ("=", "+", "-", "@", "\t", "\r"):
        return f"'{text}"
    return text


def _cleanup_attempts(connection: sqlite3.Connection, ip_address: str) -> int:
    now = int(time.time())
    min_created_at = now - LOGIN_WINDOW_SECONDS
    connection.execute("DELETE FROM login_attempts WHERE created_at < ?", (min_created_at,))
    row = connection.execute(
        """
        SELECT COUNT(*) AS total
        FROM login_attempts
        WHERE ip_address = ? AND created_at >= ?
        """,
        (ip_address, min_created_at),
    ).fetchone()
    return int(row["total"]) if row is not None else 0


def _ensure_login_allowed(connection: sqlite3.Connection, request: Request) -> str:
    ip_address = _client_ip(request)
    attempts = _cleanup_attempts(connection, ip_address)
    connection.commit()
    if attempts >= LOGIN_MAX_ATTEMPTS:
        raise _api_error(429, "Cok fazla hatali giris denemesi. Lutfen biraz bekleyip tekrar dene.")
    return ip_address


def _register_login_failure(connection: sqlite3.Connection, ip_address: str) -> None:
    connection.execute(
        "INSERT INTO login_attempts (id, ip_address, created_at) VALUES (?, ?, ?)",
        (str(uuid.uuid4()), ip_address, int(time.time())),
    )


def _clear_login_failures(connection: sqlite3.Connection, ip_address: str) -> None:
    connection.execute("DELETE FROM login_attempts WHERE ip_address = ?", (ip_address,))


def _persist_imported_list(
    *,
    admin_id: str,
    file_name: str,
    list_name: str,
    records: list[dict[str, Any]],
    duplicate_count: int,
) -> CallListRead:
    list_id = str(uuid.uuid4())
    now = utcnow()
    insert_rows = [
        (
            str(uuid.uuid4()),
            list_id,
            record.get("source_sheet_name"),
            record.get("source_row_number"),
            record.get("dedupe_key"),
            record.get("company_name"),
            record.get("address"),
            record.get("phone"),
            record.get("normalized_phone"),
            record.get("website"),
            record.get("email"),
            record.get("email_status"),
            record.get("rating"),
            record.get("review_count"),
            record.get("source_link"),
            record.get("source_created_at"),
            raw_payload_json(record.get("raw_payload") or {}),
            now,
            now,
        )
        for record in records
    ]

    with get_connection() as connection:
        try:
            connection.execute(
                """
                INSERT INTO call_lists (
                    id, name, source_file_name, row_count, duplicate_count, is_active,
                    created_by_user_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
                """,
                (
                    list_id,
                    list_name,
                    file_name,
                    len(records),
                    duplicate_count,
                    admin_id,
                    now,
                    now,
                ),
            )
            connection.executemany(
                """
                INSERT INTO call_records (
                    id, call_list_id, source_sheet_name, source_row_number, dedupe_key,
                    company_name, address, phone, normalized_phone, website, email,
                    email_status, rating, review_count, source_link, source_created_at,
                    raw_payload, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                insert_rows,
            )
            connection.commit()
        except Exception:
            connection.rollback()
            raise

        row = connection.execute("SELECT * FROM call_lists WHERE id = ?", (list_id,)).fetchone()
        assert row is not None
        return _call_list_read(connection, row)


def _validate_call_status(value: str) -> str:
    normalized = value.strip().upper()
    if normalized not in CALL_STATUS_VALUES:
        raise _api_error(422, "Gecersiz arama durumu.")
    return normalized


def _validate_result_status(value: str) -> str:
    normalized = value.strip().upper()
    if normalized not in RESULT_STATUS_VALUES:
        raise _api_error(422, "Gecersiz sonuc durumu.")
    return normalized


def _summary_for_list(connection: sqlite3.Connection, call_list_id: str) -> dict[str, int]:
    rows = connection.execute(
        "SELECT assigned_user_id, call_status, result_status FROM call_records WHERE call_list_id = ?",
        (call_list_id,),
    ).fetchall()
    call_counts = {key: 0 for key in CALL_STATUS_VALUES}
    result_counts = {key: 0 for key in RESULT_STATUS_VALUES}
    assigned = 0
    for row in rows:
        if row["assigned_user_id"]:
            assigned += 1
        call_counts[row["call_status"]] = call_counts.get(row["call_status"], 0) + 1
        result_counts[row["result_status"]] = result_counts.get(row["result_status"], 0) + 1
    return {
        "total": len(rows),
        "assigned": assigned,
        "not_called": call_counts["NOT_CALLED"],
        "calling": call_counts["CALLING"],
        "called": call_counts["CALLED"],
        "unreachable": call_counts["UNREACHABLE"],
        "callback": call_counts["CALLBACK"],
        "completed": call_counts["COMPLETED"],
        "positive": result_counts["POSITIVE"],
        "negative": result_counts["NEGATIVE"],
        "pending": result_counts["PENDING"],
    }


def _call_list_read(connection: sqlite3.Connection, row: sqlite3.Row) -> CallListRead:
    return CallListRead(
        id=row["id"],
        name=row["name"],
        source_file_name=row["source_file_name"],
        row_count=row["row_count"],
        duplicate_count=row["duplicate_count"],
        is_active=bool(row["is_active"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        summary=CallListSummaryRead(**_summary_for_list(connection, row["id"])),
    )


def _user_read(row: sqlite3.Row) -> UserRead:
    return UserRead(
        id=row["id"],
        email=row["email"],
        full_name=row["full_name"],
        role=row["role"],
        is_active=bool(row["is_active"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _record_select_sql() -> str:
    return """
        SELECT
            r.*,
            l.name AS call_list_name,
            l.is_active AS call_list_is_active,
            assigned.full_name AS assigned_user_name,
            locker.full_name AS locked_by_user_name,
            updater.full_name AS updated_by_user_name
        FROM call_records r
        JOIN call_lists l ON l.id = r.call_list_id
        LEFT JOIN users assigned ON assigned.id = r.assigned_user_id
        LEFT JOIN users locker ON locker.id = r.locked_by_user_id
        LEFT JOIN users updater ON updater.id = r.updated_by_user_id
    """


def _record_row(row: sqlite3.Row) -> CallRecordRead:
    return CallRecordRead(
        id=row["id"],
        call_list_id=row["call_list_id"],
        call_list_name=row["call_list_name"],
        source_sheet_name=row["source_sheet_name"],
        source_row_number=row["source_row_number"],
        company_name=row["company_name"],
        address=row["address"],
        phone=row["phone"],
        website=row["website"],
        email=row["email"],
        email_status=row["email_status"],
        rating=row["rating"],
        review_count=row["review_count"],
        source_link=row["source_link"],
        source_created_at=row["source_created_at"],
        assigned_user_id=row["assigned_user_id"],
        assigned_user_name=row["assigned_user_name"],
        call_status=row["call_status"],
        result_status=row["result_status"],
        note=row["note"],
        locked_by_user_id=row["locked_by_user_id"],
        locked_by_user_name=row["locked_by_user_name"],
        last_contacted_at=row["last_contacted_at"],
        updated_by_user_id=row["updated_by_user_id"],
        updated_by_user_name=row["updated_by_user_name"],
        updated_at=row["updated_at"],
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


def _validate_reach_status(value: str) -> str:
    normalized = value.strip().upper()
    if normalized not in REACH_STATUS_VALUES:
        raise _api_error(422, "Gecersiz havuz durumu.")
    return normalized


def _sync_contact_pool_entry(
    connection: sqlite3.Connection,
    *,
    record_id: str,
    updated_by_user_id: str,
    now: str,
) -> None:
    row = connection.execute(
        """
        SELECT
            id, call_list_id, company_name, address, phone, website, email,
            call_status, result_status, note, updated_at
        FROM call_records
        WHERE id = ?
        """,
        (record_id,),
    ).fetchone()
    if row is None:
        return

    existing = connection.execute(
        "SELECT id, reach_status_is_manual FROM contact_pool_entries WHERE call_record_id = ?",
        (record_id,),
    ).fetchone()

    if not _record_belongs_to_pool(row["call_status"], row["result_status"]):
        if existing is not None:
            connection.execute(
                """
                UPDATE contact_pool_entries
                SET is_active = 0,
                    call_status = ?,
                    result_status = ?,
                    record_note = ?,
                    last_record_updated_at = ?,
                    updated_by_user_id = ?,
                    updated_at = ?
                WHERE call_record_id = ?
                """,
                (
                    row["call_status"],
                    row["result_status"],
                    row["note"],
                    row["updated_at"],
                    updated_by_user_id,
                    now,
                    record_id,
                ),
            )
        return

    reach_status = _derive_reach_status(row["call_status"], row["result_status"])
    if existing is None:
        connection.execute(
            """
            INSERT INTO contact_pool_entries (
                id, call_record_id, call_list_id, company_name, address, phone, website, email,
                reach_status, reach_status_is_manual, call_status, result_status, record_note,
                admin_note, is_active, last_record_updated_at, updated_by_user_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, 1, ?, ?, ?, ?)
            """,
            (
                str(uuid.uuid4()),
                record_id,
                row["call_list_id"],
                row["company_name"],
                row["address"],
                row["phone"],
                row["website"],
                row["email"],
                reach_status,
                row["call_status"],
                row["result_status"],
                row["note"],
                row["updated_at"],
                updated_by_user_id,
                now,
                now,
            ),
        )
        return

    manual_reach_status = bool(existing["reach_status_is_manual"])
    connection.execute(
        f"""
        UPDATE contact_pool_entries
        SET call_list_id = ?,
            company_name = ?,
            address = ?,
            phone = ?,
            website = ?,
            email = ?,
            {"reach_status = ?," if not manual_reach_status else ""}
            call_status = ?,
            result_status = ?,
            record_note = ?,
            is_active = 1,
            last_record_updated_at = ?,
            updated_by_user_id = ?,
            updated_at = ?
        WHERE call_record_id = ?
        """,
        tuple(
            [
                row["call_list_id"],
                row["company_name"],
                row["address"],
                row["phone"],
                row["website"],
                row["email"],
                *([] if manual_reach_status else [reach_status]),
                row["call_status"],
                row["result_status"],
                row["note"],
                row["updated_at"],
                updated_by_user_id,
                now,
                record_id,
            ]
        ),
    )


def _contact_pool_select_sql() -> str:
    return """
        SELECT
            p.*,
            l.name AS call_list_name,
            assigned.full_name AS assigned_user_name,
            updater.full_name AS updated_by_user_name
        FROM contact_pool_entries p
        JOIN call_lists l ON l.id = p.call_list_id
        LEFT JOIN call_records r ON r.id = p.call_record_id
        LEFT JOIN users assigned ON assigned.id = r.assigned_user_id
        LEFT JOIN users updater ON updater.id = p.updated_by_user_id
    """


def _contact_pool_row(row: sqlite3.Row) -> ContactPoolEntryRead:
    return ContactPoolEntryRead(
        id=row["id"],
        call_record_id=row["call_record_id"],
        call_list_id=row["call_list_id"],
        call_list_name=row["call_list_name"],
        company_name=row["company_name"],
        address=row["address"],
        phone=row["phone"],
        website=row["website"],
        email=row["email"],
        reach_status=row["reach_status"],
        call_status=row["call_status"],
        result_status=row["result_status"],
        record_note=row["record_note"],
        admin_note=row["admin_note"],
        assigned_user_name=row["assigned_user_name"],
        updated_by_user_name=row["updated_by_user_name"],
        is_active=bool(row["is_active"]),
        last_record_updated_at=row["last_record_updated_at"],
        updated_at=row["updated_at"],
    )


def _operator_stats_row(row: sqlite3.Row) -> OperatorStatsRead:
    return OperatorStatsRead(
        user_id=row["user_id"],
        full_name=row["full_name"],
        email=row["email"],
        is_active=bool(row["is_active"]),
        assigned_count=int(row["assigned_count"] or 0),
        processed_count=int(row["processed_count"] or 0),
        reached_count=int(row["reached_count"] or 0),
        unreached_count=int(row["unreached_count"] or 0),
        positive_count=int(row["positive_count"] or 0),
        negative_count=int(row["negative_count"] or 0),
        no_answer_count=int(row["no_answer_count"] or 0),
        callback_count=int(row["callback_count"] or 0),
        last_activity_at=row["last_activity_at"],
    )


def _activity_select_sql() -> str:
    return """
        SELECT
            e.*,
            r.call_list_id,
            r.company_name,
            l.name AS call_list_name,
            actor.full_name AS actor_user_name
        FROM call_record_events e
        JOIN call_records r ON r.id = e.call_record_id
        JOIN call_lists l ON l.id = r.call_list_id
        LEFT JOIN users actor ON actor.id = e.actor_user_id
    """


def _activity_row(row: sqlite3.Row) -> ActivityRead:
    return ActivityRead(
        id=row["id"],
        call_record_id=row["call_record_id"],
        call_list_id=row["call_list_id"],
        call_list_name=row["call_list_name"],
        company_name=row["company_name"],
        actor_user_id=row["actor_user_id"],
        actor_user_name=row["actor_user_name"],
        actor_role=row["actor_role"],
        action=row["action"],
        previous_call_status=row["previous_call_status"],
        next_call_status=row["next_call_status"],
        previous_result_status=row["previous_result_status"],
        next_result_status=row["next_result_status"],
        note=row["note"],
        created_at=row["created_at"],
    )


def _load_user(connection: sqlite3.Connection, user_id: str) -> AuthUser:
    row = connection.execute(
        "SELECT id, email, full_name, role, is_active, token_version FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    if row is None:
        raise _api_error(401, "Kullanici bulunamadi.")
    return AuthUser(
        id=row["id"],
        email=row["email"],
        full_name=row["full_name"],
        role=row["role"],
        is_active=bool(row["is_active"]),
        token_version=int(row["token_version"] or 0),
    )


def _load_record(connection: sqlite3.Connection, record_id: str) -> sqlite3.Row:
    row = connection.execute(
        f"{_record_select_sql()} WHERE r.id = ?",
        (record_id,),
    ).fetchone()
    if row is None:
        raise _api_error(404, "Kayit bulunamadi.")
    return row


def _append_event(
    connection: sqlite3.Connection,
    *,
    record_id: str,
    actor: AuthUser,
    action: str,
    previous_call_status: str | None,
    next_call_status: str | None,
    previous_result_status: str | None,
    next_result_status: str | None,
    note: str | None,
) -> None:
    connection.execute(
        """
        INSERT INTO call_record_events (
            id,
            call_record_id,
            actor_user_id,
            actor_role,
            action,
            previous_call_status,
            next_call_status,
            previous_result_status,
            next_result_status,
            note,
            created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(uuid.uuid4()),
            record_id,
            actor.id,
            actor.role,
            action,
            previous_call_status,
            next_call_status,
            previous_result_status,
            next_result_status,
            note,
            utcnow(),
        ),
    )


def get_current_user(request: Request) -> AuthUser:
    authorization = request.headers.get("Authorization", "")
    if not authorization.startswith("Bearer "):
        raise _api_error(401, "Oturum gerekli.")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise _api_error(401, "Oturum gerekli.")
    try:
        payload = decode_token(token)
    except ValueError as exc:
        raise _api_error(401, str(exc)) from exc
    user_id = payload.get("sub")
    if not isinstance(user_id, str) or not user_id:
        raise _api_error(401, "Gecersiz oturum.")
    token_version = payload.get("tv", 0)
    if not isinstance(token_version, int):
        raise _api_error(401, "Gecersiz oturum.")
    with get_connection() as connection:
        user = _load_user(connection, user_id)
        if user.token_version != token_version:
            raise _api_error(401, "Oturum gecersiz. Lutfen tekrar giris yap.")
        if not user.is_active:
            raise _api_error(403, "Pasif kullanici.")
        return user


def require_admin(user: AuthUser = Depends(get_current_user)) -> AuthUser:
    if user.role != "admin":
        raise _api_error(403, "Bu alan sadece admin kullanicilar icin.")
    return user


@app.middleware("http")
async def apply_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if request.url.scheme == "https" or os.getenv("RENDER"):
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self'; "
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "font-src 'self'; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "frame-ancestors 'none'; "
        "form-action 'self'"
    )
    if (
        request.url.path in {"/", "/health", "/ping"}
        or request.url.path.startswith("/api/")
        or request.url.path.startswith("/static/")
    ):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
    return response


@app.get("/")
def root() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/favicon.ico")
def favicon() -> FileResponse:
    return FileResponse(STATIC_DIR / "yabujin-mark.svg", media_type="image/svg+xml")


@app.get("/ping")
def ping() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health")
def health() -> dict[str, str]:
    try:
        with get_connection() as connection:
            connection.execute("SELECT 1").fetchone()
            connection.execute("SELECT COUNT(*) AS total FROM users").fetchone()
            row = connection.execute("SELECT MAX(version) AS version FROM schema_migrations").fetchone()
            if row is None or int(row["version"] or 0) < CURRENT_SCHEMA_VERSION:
                raise _api_error(503, "Veri tabani semasi guncel degil.")
    except sqlite3.Error as exc:
        raise _api_error(503, "Veri tabani hazir degil.") from exc
    return {"status": "ok", "db": "ok"}


@app.post("/api/auth/login", response_model=UserLoginResponse)
def login(payload: LoginRequest, request: Request) -> UserLoginResponse:
    with get_connection() as connection:
        ip_address = _ensure_login_allowed(connection, request)
        row = connection.execute(
            """
            SELECT id, email, full_name, role, is_active, password_hash, token_version, created_at, updated_at
            FROM users
            WHERE lower(email) = ?
            """,
            (payload.email.strip().lower(),),
        ).fetchone()
        if row is None or not verify_password(payload.password, row["password_hash"]):
            _register_login_failure(connection, ip_address)
            connection.commit()
            raise _api_error(401, "Email veya sifre hatali.")
        if not row["is_active"]:
            _register_login_failure(connection, ip_address)
            connection.commit()
            raise _api_error(403, "Kullanici pasif durumda.")
        _clear_login_failures(connection, ip_address)
        connection.commit()
        token = create_token(
            user_id=row["id"],
            role=row["role"],
            email=row["email"],
            token_version=int(row["token_version"] or 0),
        )
        return UserLoginResponse(
            access_token=token,
            user=UserRead(
                id=row["id"],
                email=row["email"],
                full_name=row["full_name"],
                role=row["role"],
                is_active=bool(row["is_active"]),
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            ),
        )


@app.get("/api/auth/me", response_model=UserRead)
def me(user: AuthUser = Depends(get_current_user)) -> UserRead:
    with get_connection() as connection:
        row = connection.execute("SELECT * FROM users WHERE id = ?", (user.id,)).fetchone()
        if row is None:
            raise _api_error(404, "Kullanici bulunamadi.")
        return _user_read(row)


@app.get("/api/users", response_model=list[UserRead])
def list_users(_admin: AuthUser = Depends(require_admin)) -> list[UserRead]:
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT id, email, full_name, role, is_active, created_at, updated_at
            FROM users
            ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, full_name, email
            """
        ).fetchall()
    return [_user_read(row) for row in rows]


@app.post("/api/users", response_model=UserRead, status_code=status.HTTP_201_CREATED)
def create_user(payload: UserCreateRequest, _admin: AuthUser = Depends(require_admin)) -> UserRead:
    now = utcnow()
    with get_connection() as connection:
        existing = connection.execute(
            "SELECT id FROM users WHERE lower(email) = ?",
            (payload.email.strip().lower(),),
        ).fetchone()
        if existing is not None:
            raise _api_error(409, "Bu email zaten kayitli.")
        user_id = str(uuid.uuid4())
        connection.execute(
            """
            INSERT INTO users (id, email, password_hash, full_name, role, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (
                user_id,
                payload.email.strip().lower(),
                get_password_hash(payload.password),
                payload.full_name.strip(),
                payload.role,
                now,
                now,
            ),
        )
        connection.commit()
        row = connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    assert row is not None
    return _user_read(row)


@app.patch("/api/users/{user_id}", response_model=UserRead)
def update_user(
    user_id: str,
    payload: UserUpdateRequest,
    admin: AuthUser = Depends(require_admin),
) -> UserRead:
    now = utcnow()
    with get_connection() as connection:
        row = connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise _api_error(404, "Kullanici bulunamadi.")

        next_role = payload.role or row["role"]
        next_active = bool(row["is_active"]) if payload.is_active is None else bool(payload.is_active)
        next_name = row["full_name"]
        if payload.full_name is not None:
            next_name = payload.full_name.strip()

        if user_id == admin.id:
            if payload.role is not None and payload.role != row["role"]:
                raise _api_error(409, "Kendi rolunu bu ekrandan degistiremezsin.")
            if payload.is_active is False:
                raise _api_error(409, "Kendi hesabini pasife alamazsin.")

        if row["role"] == "admin" and (next_role != "admin" or not next_active):
            remaining_admins = connection.execute(
                """
                SELECT COUNT(*) AS total
                FROM users
                WHERE role = 'admin' AND is_active = 1 AND id != ?
                """,
                (user_id,),
            ).fetchone()["total"]
            if remaining_admins < 1:
                raise _api_error(409, "Sistemde en az bir aktif yonetici kalmali.")

        password_hash = row["password_hash"]
        token_version = int(row["token_version"] or 0)
        if payload.password is not None:
            password_hash = get_password_hash(payload.password)
            token_version += 1
        if payload.role is not None and payload.role != row["role"]:
            token_version += 1
        if payload.is_active is not None and bool(payload.is_active) != bool(row["is_active"]):
            token_version += 1

        connection.execute(
            """
            UPDATE users
            SET full_name = ?, password_hash = ?, role = ?, is_active = ?, token_version = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                next_name,
                password_hash,
                next_role,
                1 if next_active else 0,
                token_version,
                now,
                user_id,
            ),
        )
        connection.commit()
        updated = connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()

    assert updated is not None
    return _user_read(updated)


@app.delete("/api/users/{user_id}", response_model=OkResponse)
def delete_user(user_id: str, admin: AuthUser = Depends(require_admin)) -> OkResponse:
    if user_id == admin.id:
        raise _api_error(409, "Kendi hesabini silemezsin.")

    with get_connection() as connection:
        row = connection.execute("SELECT id, role, is_active FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise _api_error(404, "Kullanici bulunamadi.")

        if row["role"] == "admin" and bool(row["is_active"]):
            remaining_admins = connection.execute(
                """
                SELECT COUNT(*) AS total
                FROM users
                WHERE role = 'admin' AND is_active = 1 AND id != ?
                """,
                (user_id,),
            ).fetchone()["total"]
            if remaining_admins < 1:
                raise _api_error(409, "Sistemde en az bir aktif yonetici kalmali.")

        connection.execute(
            """
            UPDATE users
            SET is_active = 0,
                token_version = token_version + 1,
                updated_at = ?
            WHERE id = ?
            """,
            (utcnow(), user_id),
        )
        connection.commit()

    return OkResponse(ok=True)


@app.get("/api/lists", response_model=list[CallListRead])
def list_call_lists(
    include_inactive: bool = False,
    user: AuthUser = Depends(get_current_user),
) -> list[CallListRead]:
    with get_connection() as connection:
        if user.role == "admin":
            query = "SELECT * FROM call_lists"
            params: tuple[Any, ...] = ()
            if not include_inactive:
                query += " WHERE is_active = 1"
        else:
            query = """
                SELECT DISTINCT l.*
                FROM call_lists l
                JOIN call_records r ON r.call_list_id = l.id
                WHERE r.assigned_user_id = ?
            """
            params = (user.id,)
            query += " AND l.is_active = 1"
        query += " ORDER BY updated_at DESC, created_at DESC"
        rows = connection.execute(query, params).fetchall()
        return [_call_list_read(connection, row) for row in rows]


@app.post("/api/lists/import", response_model=CallListRead, status_code=status.HTTP_201_CREATED)
async def import_call_list(
    request: Request,
    admin: AuthUser = Depends(require_admin),
    x_file_name: str | None = Header(default=None, alias="X-File-Name"),
    x_list_name: str | None = Header(default=None, alias="X-List-Name"),
) -> CallListRead:
    file_bytes = await request.body()
    if not file_bytes:
        raise _api_error(422, "Excel dosyasi bos.")
    if len(file_bytes) > 20 * 1024 * 1024:
        raise _api_error(413, "Excel dosyasi cok buyuk.")
    file_name = (x_file_name or "arama-listesi.xlsx").strip() or "arama-listesi.xlsx"
    if not file_name.lower().endswith(".xlsx"):
        raise _api_error(422, "Sadece .xlsx uzantili dosyalar kabul edilir.")
    try:
        records, duplicate_count = await run_in_threadpool(parse_xlsx_records, file_bytes)
    except ValueError as exc:
        raise _api_error(422, str(exc)) from exc
    if not records:
        raise _api_error(422, "Excel dosyasinda islenecek kayit bulunamadi.")

    list_name = (x_list_name or "").strip() or Path(file_name).stem
    return await run_in_threadpool(
        _persist_imported_list,
        admin_id=admin.id,
        file_name=file_name,
        list_name=list_name,
        records=records,
        duplicate_count=duplicate_count,
    )


@app.patch("/api/lists/{call_list_id}", response_model=CallListRead)
def update_call_list(
    call_list_id: str,
    payload: CallListUpdateRequest,
    _admin: AuthUser = Depends(require_admin),
) -> CallListRead:
    with get_connection() as connection:
        row = connection.execute("SELECT * FROM call_lists WHERE id = ?", (call_list_id,)).fetchone()
        if row is None:
            raise _api_error(404, "Liste bulunamadi.")

        name = payload.name.strip() if payload.name is not None else row["name"]
        is_active = int(payload.is_active if payload.is_active is not None else bool(row["is_active"]))
        connection.execute(
            "UPDATE call_lists SET name = ?, is_active = ?, updated_at = ? WHERE id = ?",
            (name, is_active, utcnow(), call_list_id),
        )
        connection.commit()
        updated = connection.execute("SELECT * FROM call_lists WHERE id = ?", (call_list_id,)).fetchone()
        assert updated is not None
        return _call_list_read(connection, updated)


@app.get("/api/records", response_model=CallRecordPageResponse)
def list_records(
    call_list_id: str | None = None,
    q: str | None = None,
    call_status: str | None = None,
    result_status: str | None = None,
    assigned_user_id: str | None = None,
    unassigned: bool = False,
    has_email: bool = False,
    has_phone: bool = False,
    has_address: bool = False,
    has_website: bool = False,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    user: AuthUser = Depends(get_current_user),
) -> CallRecordPageResponse:
    filters: list[str] = []
    params: list[Any] = []

    if call_list_id:
        filters.append("r.call_list_id = ?")
        params.append(call_list_id)
    if q:
        filters.append("(r.company_name LIKE ? OR r.phone LIKE ? OR r.address LIKE ? OR r.email LIKE ?)")
        pattern = f"%{q.strip()}%"
        params.extend([pattern, pattern, pattern, pattern])
    if call_status:
        filters.append("r.call_status = ?")
        params.append(_validate_call_status(call_status))
    if result_status:
        filters.append("r.result_status = ?")
        params.append(_validate_result_status(result_status))
    if assigned_user_id and user.role == "admin":
        filters.append("r.assigned_user_id = ?")
        params.append(assigned_user_id)
    if unassigned:
        filters.append("r.assigned_user_id IS NULL")
    if has_email:
        filters.append("r.email IS NOT NULL AND trim(r.email) != ''")
    if has_phone:
        filters.append("r.phone IS NOT NULL AND trim(r.phone) != ''")
    if has_address:
        filters.append("r.address IS NOT NULL AND trim(r.address) != ''")
    if has_website:
        filters.append("r.website IS NOT NULL AND trim(r.website) != ''")

    if user.role != "admin":
        filters.append("r.assigned_user_id = ?")
        params.append(user.id)
        filters.append("l.is_active = 1")

    where_clause = f"WHERE {' AND '.join(filters)}" if filters else ""
    with get_connection() as connection:
        total = connection.execute(
            f"SELECT COUNT(*) AS total FROM call_records r JOIN call_lists l ON l.id = r.call_list_id {where_clause}",
            tuple(params),
        ).fetchone()["total"]
        summary_row = connection.execute(
            f"""
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN r.assigned_user_id IS NOT NULL THEN 1 ELSE 0 END) AS assigned,
                SUM(CASE WHEN r.call_status = 'NOT_CALLED' THEN 1 ELSE 0 END) AS not_called,
                SUM(CASE WHEN r.call_status = 'CALLING' THEN 1 ELSE 0 END) AS calling,
                SUM(CASE WHEN r.call_status = 'CALLED' THEN 1 ELSE 0 END) AS called,
                SUM(CASE WHEN r.call_status = 'UNREACHABLE' THEN 1 ELSE 0 END) AS unreachable,
                SUM(CASE WHEN r.call_status = 'CALLBACK' THEN 1 ELSE 0 END) AS callback,
                SUM(CASE WHEN r.call_status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN r.result_status = 'POSITIVE' THEN 1 ELSE 0 END) AS positive,
                SUM(CASE WHEN r.result_status = 'NEGATIVE' THEN 1 ELSE 0 END) AS negative,
                SUM(CASE WHEN r.result_status = 'PENDING' THEN 1 ELSE 0 END) AS pending
            FROM call_records r
            JOIN call_lists l ON l.id = r.call_list_id
            {where_clause}
            """,
            tuple(params),
        ).fetchone()
        rows = connection.execute(
            f"""
            {_record_select_sql()}
            {where_clause}
            ORDER BY r.updated_at DESC, r.created_at DESC
            LIMIT ? OFFSET ?
            """,
            tuple([*params, limit, offset]),
        ).fetchall()
    return CallRecordPageResponse(
        items=[_record_row(row) for row in rows],
        total=int(total),
        offset=offset,
        limit=limit,
        summary=CallListSummaryRead(
            **{
                key: int(summary_row[key] or 0)
                for key in (
                    "total",
                    "assigned",
                    "not_called",
                    "calling",
                    "called",
                    "unreachable",
                    "callback",
                    "completed",
                    "positive",
                    "negative",
                    "pending",
                )
            }
        ),
    )


@app.get("/api/operator-stats", response_model=list[OperatorStatsRead])
def operator_stats(
    call_list_id: str | None = None,
    _admin: AuthUser = Depends(require_admin),
) -> list[OperatorStatsRead]:
    join_filters = ["r.assigned_user_id = u.id"]
    params: list[Any] = []
    if call_list_id:
        join_filters.append("r.call_list_id = ?")
        params.append(call_list_id)

    with get_connection() as connection:
        rows = connection.execute(
            f"""
            SELECT
                u.id AS user_id,
                u.full_name,
                u.email,
                u.is_active,
                COUNT(r.id) AS assigned_count,
                SUM(CASE
                    WHEN r.id IS NOT NULL AND (r.call_status != 'NOT_CALLED' OR r.result_status != 'PENDING')
                    THEN 1 ELSE 0
                END) AS processed_count,
                SUM(CASE
                    WHEN r.call_status IN ('CALLED', 'COMPLETED')
                      OR r.result_status IN ('POSITIVE', 'NEGATIVE', 'NOT_INTERESTED')
                    THEN 1 ELSE 0
                END) AS reached_count,
                SUM(CASE
                    WHEN r.call_status = 'UNREACHABLE'
                      OR r.result_status IN ('NO_ANSWER', 'WRONG_NUMBER')
                    THEN 1 ELSE 0
                END) AS unreached_count,
                SUM(CASE WHEN r.result_status = 'POSITIVE' THEN 1 ELSE 0 END) AS positive_count,
                SUM(CASE WHEN r.result_status IN ('NEGATIVE', 'NOT_INTERESTED') THEN 1 ELSE 0 END) AS negative_count,
                SUM(CASE WHEN r.result_status = 'NO_ANSWER' THEN 1 ELSE 0 END) AS no_answer_count,
                SUM(CASE WHEN r.call_status = 'CALLBACK' THEN 1 ELSE 0 END) AS callback_count,
                MAX(CASE
                    WHEN r.call_status != 'NOT_CALLED' OR r.result_status != 'PENDING'
                    THEN r.updated_at ELSE NULL
                END) AS last_activity_at
            FROM users u
            LEFT JOIN call_records r ON {' AND '.join(join_filters)}
            WHERE u.role = 'agent'
            GROUP BY u.id, u.full_name, u.email, u.is_active
            ORDER BY u.is_active DESC, processed_count DESC, positive_count DESC, u.full_name, u.email
            """,
            tuple(params),
        ).fetchall()
    return [_operator_stats_row(row) for row in rows]


@app.get("/api/activity", response_model=list[ActivityRead])
def list_activity(
    call_list_id: str | None = None,
    limit: int = Query(default=25, ge=1, le=200),
    user: AuthUser = Depends(get_current_user),
) -> list[ActivityRead]:
    filters: list[str] = []
    params: list[Any] = []

    if call_list_id:
        filters.append("r.call_list_id = ?")
        params.append(call_list_id)

    if user.role != "admin":
        filters.append("(r.assigned_user_id = ? OR e.actor_user_id = ?)")
        params.extend([user.id, user.id])
        filters.append("l.is_active = 1")

    where_clause = f"WHERE {' AND '.join(filters)}" if filters else ""
    with get_connection() as connection:
        rows = connection.execute(
            f"""
            {_activity_select_sql()}
            {where_clause}
            ORDER BY e.created_at DESC
            LIMIT ?
            """,
            tuple([*params, limit]),
        ).fetchall()
    return [_activity_row(row) for row in rows]


@app.post("/api/lists/{call_list_id}/assign-evenly", response_model=AssignResponse)
def assign_evenly(
    call_list_id: str,
    payload: CallListAssignRequest,
    admin: AuthUser = Depends(require_admin),
) -> AssignResponse:
    with get_connection() as connection:
        list_row = connection.execute("SELECT id FROM call_lists WHERE id = ?", (call_list_id,)).fetchone()
        if list_row is None:
            raise _api_error(404, "Liste bulunamadi.")
        users = connection.execute(
            f"SELECT id FROM users WHERE role = 'agent' AND is_active = 1 AND id IN ({','.join(['?'] * len(payload.user_ids))})",
            tuple(payload.user_ids),
        ).fetchall()
        active_user_ids = {row["id"] for row in users}
        valid_user_ids = [user_id for user_id in payload.user_ids if user_id in active_user_ids]
        if len(valid_user_ids) != len(set(payload.user_ids)):
            raise _api_error(422, "Secilen kullanicilarin tamami aktif degil.")

        query = "SELECT id, call_status, result_status FROM call_records WHERE call_list_id = ?"
        params: list[Any] = [call_list_id]
        if payload.mode == "unassigned":
            query += " AND assigned_user_id IS NULL"
        elif payload.mode != "all":
            raise _api_error(422, "Gecersiz dagitim modu.")
        query += " ORDER BY created_at ASC, source_row_number ASC, id ASC"
        records = connection.execute(query, tuple(params)).fetchall()

        for index, record in enumerate(records):
            assigned_user_id = valid_user_ids[index % len(valid_user_ids)]
            connection.execute(
                """
                UPDATE call_records
                SET assigned_user_id = ?, updated_by_user_id = ?, updated_at = ?
                WHERE id = ?
                """,
                (assigned_user_id, admin.id, utcnow(), record["id"]),
            )
            _append_event(
                connection,
                record_id=record["id"],
                actor=admin,
                action="ASSIGNED",
                previous_call_status=record["call_status"],
                next_call_status=record["call_status"],
                previous_result_status=record["result_status"],
                next_result_status=record["result_status"],
                note=None,
            )
        connection.commit()
        return AssignResponse(ok=True, assigned_count=len(records), remaining_count=0)


@app.post("/api/lists/{call_list_id}/assign-custom", response_model=AssignResponse)
def assign_custom(
    call_list_id: str,
    payload: CallListCustomAssignRequest,
    admin: AuthUser = Depends(require_admin),
) -> AssignResponse:
    requested_user_ids = [item.user_id for item in payload.allocations]
    if len(requested_user_ids) != len(set(requested_user_ids)):
        raise _api_error(422, "Ayni kullaniciya birden fazla ozel dagitim satiri verilemez.")

    with get_connection() as connection:
        list_row = connection.execute("SELECT id FROM call_lists WHERE id = ?", (call_list_id,)).fetchone()
        if list_row is None:
            raise _api_error(404, "Liste bulunamadi.")

        users = connection.execute(
            f"SELECT id FROM users WHERE role = 'agent' AND is_active = 1 AND id IN ({','.join(['?'] * len(requested_user_ids))})",
            tuple(requested_user_ids),
        ).fetchall()
        active_user_ids = {row["id"] for row in users}
        valid_user_ids = [user_id for user_id in requested_user_ids if user_id in active_user_ids]
        if len(valid_user_ids) != len(requested_user_ids):
            raise _api_error(422, "Secilen kullanicilarin tamami aktif degil.")

        query = "SELECT id, call_status, result_status FROM call_records WHERE call_list_id = ?"
        params: list[Any] = [call_list_id]
        if payload.mode == "unassigned":
            query += " AND assigned_user_id IS NULL"
        elif payload.mode != "all":
            raise _api_error(422, "Gecersiz dagitim modu.")
        query += " ORDER BY created_at ASC, source_row_number ASC, id ASC"
        records = connection.execute(query, tuple(params)).fetchall()

        requested_total = sum(item.count for item in payload.allocations)
        if requested_total > len(records):
            raise _api_error(422, "Istenen ozel dagitim adedi, kapsamdaki kayit sayisini asiyor.")

        now = utcnow()
        if payload.mode == "all":
            connection.execute(
                """
                UPDATE call_records
                SET assigned_user_id = NULL, updated_by_user_id = ?, updated_at = ?
                WHERE call_list_id = ?
                """,
                (admin.id, now, call_list_id),
            )

        cursor = 0
        for allocation in payload.allocations:
            for record in records[cursor : cursor + allocation.count]:
                connection.execute(
                    """
                    UPDATE call_records
                    SET assigned_user_id = ?, updated_by_user_id = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (allocation.user_id, admin.id, now, record["id"]),
                )
                _append_event(
                    connection,
                    record_id=record["id"],
                    actor=admin,
                    action="ASSIGNED",
                    previous_call_status=record["call_status"],
                    next_call_status=record["call_status"],
                    previous_result_status=record["result_status"],
                    next_result_status=record["result_status"],
                    note=f"Ozel dagitim: {allocation.count} kayit",
                )
            cursor += allocation.count

        connection.commit()
        return AssignResponse(
            ok=True,
            assigned_count=requested_total,
            remaining_count=len(records) - requested_total,
        )


@app.patch("/api/records/{record_id}", response_model=CallRecordRead)
def update_record(
    record_id: str,
    payload: CallRecordUpdateRequest,
    user: AuthUser = Depends(get_current_user),
) -> CallRecordRead:
    now = utcnow()
    with get_connection() as connection:
        row = _load_record(connection, record_id)

        if user.role != "admin":
            if not bool(row["call_list_is_active"]):
                raise _api_error(403, "Pasif listedeki kayit operatore kapali.")
            if row["assigned_user_id"] != user.id:
                raise _api_error(403, "Bu kayit bu operatore atanmamis.")
            if payload.assigned_user_id is not None or payload.clear_assignment:
                raise _api_error(403, "Ajan atama degisikligi yapamaz.")

        assigned_user_id = row["assigned_user_id"]
        if user.role == "admin":
            if payload.clear_assignment:
                assigned_user_id = None
            elif payload.assigned_user_id is not None:
                target = connection.execute(
                    "SELECT id FROM users WHERE id = ? AND role = 'agent' AND is_active = 1",
                    (payload.assigned_user_id,),
                ).fetchone()
                if target is None:
                    raise _api_error(422, "Atanacak kullanici aktif operator degil.")
                assigned_user_id = payload.assigned_user_id
        elif assigned_user_id is None:
            assigned_user_id = user.id

        next_call_status = row["call_status"]
        if payload.call_status is not None:
            next_call_status = _validate_call_status(payload.call_status)

        next_result_status = row["result_status"]
        if payload.result_status is not None:
            next_result_status = _validate_result_status(payload.result_status)

        note = payload.note.strip() if isinstance(payload.note, str) else row["note"]
        if note == "":
            note = None

        locked_by_user_id = user.id if next_call_status == "CALLING" else None
        last_contacted_at = row["last_contacted_at"]
        if next_call_status != "NOT_CALLED":
            last_contacted_at = now

        connection.execute(
            """
            UPDATE call_records
            SET assigned_user_id = ?,
                call_status = ?,
                result_status = ?,
                note = ?,
                locked_by_user_id = ?,
                locked_at = ?,
                last_contacted_at = ?,
                updated_by_user_id = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (
                assigned_user_id,
                next_call_status,
                next_result_status,
                note,
                locked_by_user_id,
                now if locked_by_user_id else None,
                last_contacted_at,
                user.id,
                now,
                record_id,
            ),
        )
        _append_event(
            connection,
            record_id=record_id,
            actor=user,
            action="UPDATED",
            previous_call_status=row["call_status"],
            next_call_status=next_call_status,
            previous_result_status=row["result_status"],
            next_result_status=next_result_status,
            note=note,
        )
        _sync_contact_pool_entry(connection, record_id=record_id, updated_by_user_id=user.id, now=now)
        connection.commit()
        updated = _load_record(connection, record_id)
        return _record_row(updated)


@app.get("/api/contact-pool", response_model=ContactPoolPageResponse)
def list_contact_pool(
    call_list_id: str | None = None,
    q: str | None = None,
    reach_status: str | None = None,
    result_status: str | None = None,
    include_inactive: bool = False,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _admin: AuthUser = Depends(require_admin),
) -> ContactPoolPageResponse:
    filters: list[str] = []
    params: list[Any] = []

    if call_list_id:
        filters.append("p.call_list_id = ?")
        params.append(call_list_id)
    if q:
        pattern = f"%{q.strip()}%"
        filters.append(
            """
            (
                p.company_name LIKE ? OR p.phone LIKE ? OR p.address LIKE ? OR
                p.email LIKE ? OR p.admin_note LIKE ? OR p.record_note LIKE ? OR l.name LIKE ?
            )
            """
        )
        params.extend([pattern, pattern, pattern, pattern, pattern, pattern, pattern])
    if reach_status:
        filters.append("p.reach_status = ?")
        params.append(_validate_reach_status(reach_status))
    if result_status:
        filters.append("p.result_status = ?")
        params.append(_validate_result_status(result_status))
    if not include_inactive:
        filters.append("p.is_active = 1")

    where_clause = f"WHERE {' AND '.join(filters)}" if filters else ""
    with get_connection() as connection:
        total = connection.execute(
            f"""
            SELECT COUNT(*) AS total
            FROM contact_pool_entries p
            JOIN call_lists l ON l.id = p.call_list_id
            {where_clause}
            """,
            tuple(params),
        ).fetchone()["total"]
        rows = connection.execute(
            f"""
            {_contact_pool_select_sql()}
            {where_clause}
            ORDER BY p.updated_at DESC, p.last_record_updated_at DESC
            LIMIT ? OFFSET ?
            """,
            tuple([*params, limit, offset]),
        ).fetchall()
    return ContactPoolPageResponse(
        items=[_contact_pool_row(row) for row in rows],
        total=total,
        offset=offset,
        limit=limit,
    )


@app.patch("/api/contact-pool/{entry_id}", response_model=ContactPoolEntryRead)
def update_contact_pool_entry(
    entry_id: str,
    payload: ContactPoolUpdateRequest,
    admin: AuthUser = Depends(require_admin),
) -> ContactPoolEntryRead:
    with get_connection() as connection:
        row = connection.execute("SELECT * FROM contact_pool_entries WHERE id = ?", (entry_id,)).fetchone()
        if row is None:
            raise _api_error(404, "Havuz kaydi bulunamadi.")

        reach_status = row["reach_status"]
        reach_status_is_manual = int(row["reach_status_is_manual"] or 0)
        if payload.reach_status is not None:
            reach_status = _validate_reach_status(payload.reach_status)
            reach_status_is_manual = 1

        admin_note = row["admin_note"]
        if isinstance(payload.admin_note, str):
            admin_note = payload.admin_note.strip() or None

        is_active = int(payload.is_active if payload.is_active is not None else bool(row["is_active"]))
        now = utcnow()
        connection.execute(
            """
            UPDATE contact_pool_entries
            SET reach_status = ?,
                reach_status_is_manual = ?,
                admin_note = ?,
                is_active = ?,
                updated_by_user_id = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (reach_status, reach_status_is_manual, admin_note, is_active, admin.id, now, entry_id),
        )
        connection.commit()
        updated = connection.execute(
            f"{_contact_pool_select_sql()} WHERE p.id = ?",
            (entry_id,),
        ).fetchone()
        assert updated is not None
        return _contact_pool_row(updated)


@app.get("/api/contact-pool/export.csv")
def export_contact_pool(
    call_list_id: str | None = None,
    q: str | None = None,
    reach_status: str | None = None,
    result_status: str | None = None,
    include_inactive: bool = False,
    _admin: AuthUser = Depends(require_admin),
) -> StreamingResponse:
    filters: list[str] = []
    params: list[Any] = []

    if call_list_id:
        filters.append("p.call_list_id = ?")
        params.append(call_list_id)
    if q:
        pattern = f"%{q.strip()}%"
        filters.append(
            """
            (
                p.company_name LIKE ? OR p.phone LIKE ? OR p.address LIKE ? OR
                p.email LIKE ? OR p.admin_note LIKE ? OR p.record_note LIKE ? OR l.name LIKE ?
            )
            """
        )
        params.extend([pattern, pattern, pattern, pattern, pattern, pattern, pattern])
    if reach_status:
        filters.append("p.reach_status = ?")
        params.append(_validate_reach_status(reach_status))
    if result_status:
        filters.append("p.result_status = ?")
        params.append(_validate_result_status(result_status))
    if not include_inactive:
        filters.append("p.is_active = 1")

    where_clause = f"WHERE {' AND '.join(filters)}" if filters else ""
    with get_connection() as connection:
        rows = connection.execute(
            f"""
            {_contact_pool_select_sql()}
            {where_clause}
            ORDER BY p.updated_at DESC, p.last_record_updated_at DESC
            """,
            tuple(params),
        ).fetchall()

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "Liste",
            "Firma",
            "Adres",
            "Telefon",
            "Website",
            "Email",
            "Ulasim Durumu",
            "Arama Durumu",
            "Sonuc",
            "Operator",
            "Kayit Notu",
            "Havuz Notu",
            "Aktif",
            "Son Kayit Guncelleme",
            "Havuz Guncelleme",
        ]
    )
    for row in rows:
        writer.writerow(
            [
                _csv_cell(value)
                for value in [
                    row["call_list_name"],
                    row["company_name"],
                    row["address"],
                    row["phone"],
                    row["website"],
                    row["email"],
                    row["reach_status"],
                    row["call_status"],
                    row["result_status"],
                    row["assigned_user_name"],
                    row["record_note"],
                    row["admin_note"],
                    "aktif" if row["is_active"] else "pasif",
                    row["last_record_updated_at"],
                    row["updated_at"],
                ]
            ]
        )
    payload = io.BytesIO(buffer.getvalue().encode("utf-8-sig"))
    headers = {"Content-Disposition": 'attachment; filename="islem-havuzu.csv"'}
    return StreamingResponse(payload, media_type="text/csv; charset=utf-8", headers=headers)


@app.get("/api/lists/{call_list_id}/export.csv")
def export_call_list(call_list_id: str, user: AuthUser = Depends(get_current_user)) -> StreamingResponse:
    with get_connection() as connection:
        list_row = connection.execute("SELECT * FROM call_lists WHERE id = ?", (call_list_id,)).fetchone()
        if list_row is None:
            raise _api_error(404, "Liste bulunamadi.")
        if user.role != "admin" and not bool(list_row["is_active"]):
            raise _api_error(403, "Pasif liste operatore kapali.")
        params: list[Any] = [call_list_id]
        where_clause = "WHERE r.call_list_id = ?"
        if user.role != "admin":
            where_clause += " AND r.assigned_user_id = ?"
            params.append(user.id)

        rows = connection.execute(
            f"{_record_select_sql()} {where_clause} ORDER BY r.created_at ASC, r.source_row_number ASC, r.id ASC",
            tuple(params),
        ).fetchall()
        if user.role != "admin" and not rows:
            raise _api_error(403, "Bu listeye erisim izniniz yok.")

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "Liste",
            "Firma",
            "Adres",
            "Telefon",
            "Website",
            "Email",
            "Email Durumu",
            "Puan",
            "Yorum Sayisi",
            "Link",
            "Kayit Zamani",
            "Sorumlu",
            "Arama Durumu",
            "Sonuc",
            "Not",
            "Guncelleyen",
            "Guncellenme",
        ]
    )
    for row in rows:
        writer.writerow(
            [
                _csv_cell(value)
                for value in [
                row["call_list_name"],
                row["company_name"],
                row["address"],
                row["phone"],
                row["website"],
                row["email"],
                row["email_status"],
                row["rating"],
                row["review_count"],
                row["source_link"],
                row["source_created_at"],
                row["assigned_user_name"],
                row["call_status"],
                row["result_status"],
                row["note"],
                row["updated_by_user_name"],
                row["updated_at"],
            ]
            ]
        )
    payload = io.BytesIO(buffer.getvalue().encode("utf-8-sig"))
    safe_name = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in list_row["name"]) or "arama-listesi"
    headers = {"Content-Disposition": f'attachment; filename="{safe_name}.csv"'}
    return StreamingResponse(payload, media_type="text/csv; charset=utf-8", headers=headers)
