from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any


PASSWORD_ITERATIONS = 480_000
DEFAULT_TOKEN_TTL_HOURS = 24
MIN_TOKEN_TTL_HOURS = 1
MAX_TOKEN_TTL_HOURS = 168


def _secret_key() -> bytes:
    return os.getenv("CALL_PORTAL_SECRET_KEY", "call-portal-dev-secret-change-me").encode("utf-8")


def _token_ttl_hours() -> int:
    raw = os.getenv("CALL_PORTAL_TOKEN_HOURS", str(DEFAULT_TOKEN_TTL_HOURS))
    try:
        value = int(raw)
    except ValueError:
        value = DEFAULT_TOKEN_TTL_HOURS
    return max(MIN_TOKEN_TTL_HOURS, min(MAX_TOKEN_TTL_HOURS, value))


def get_token_ttl_hours() -> int:
    return _token_ttl_hours()


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(raw: str) -> bytes:
    padding = "=" * (-len(raw) % 4)
    return base64.urlsafe_b64decode(raw + padding)


def get_password_hash(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PASSWORD_ITERATIONS,
    )
    return f"{_b64url_encode(salt)}${_b64url_encode(digest)}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        salt_b64, digest_b64 = stored_hash.split("$", 1)
    except ValueError:
        return False
    salt = _b64url_decode(salt_b64)
    expected = _b64url_decode(digest_b64)
    actual = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PASSWORD_ITERATIONS,
    )
    return hmac.compare_digest(actual, expected)


def create_token(*, user_id: str, role: str, email: str, token_version: int = 0) -> str:
    payload = {
        "sub": user_id,
        "role": role,
        "email": email,
        "tv": token_version,
        "exp": int((datetime.now(UTC) + timedelta(hours=_token_ttl_hours())).timestamp()),
    }
    encoded_payload = _b64url_encode(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    )
    signature = hmac.new(_secret_key(), encoded_payload.encode("utf-8"), hashlib.sha256).digest()
    return f"{encoded_payload}.{_b64url_encode(signature)}"


def decode_token(token: str) -> dict[str, Any]:
    try:
        encoded_payload, encoded_signature = token.split(".", 1)
    except ValueError as exc:
        raise ValueError("Invalid token format") from exc
    try:
        expected_signature = hmac.new(
            _secret_key(),
            encoded_payload.encode("utf-8"),
            hashlib.sha256,
        ).digest()
        provided_signature = _b64url_decode(encoded_signature)
        if not hmac.compare_digest(expected_signature, provided_signature):
            raise ValueError("Invalid token signature")
        payload = json.loads(_b64url_decode(encoded_payload).decode("utf-8"))
    except (binascii.Error, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValueError("Invalid token payload") from exc
    exp = payload.get("exp")
    if not isinstance(exp, int) or exp < int(datetime.now(UTC).timestamp()):
        raise ValueError("Token expired")
    return payload
