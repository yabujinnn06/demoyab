from __future__ import annotations

from dataclasses import dataclass

from fastapi import Request
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse

from ..database import get_connection
from ..security import decode_token


SESSION_COOKIE_NAME = "call_portal_session"


@dataclass(slots=True)
class OfferPortalUser:
    id: str
    email: str
    full_name: str | None
    role: str
    is_active: bool
    token_version: int
    can_access_offer_tool: bool

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


def _load_offer_user_from_token(token: str) -> OfferPortalUser | None:
    if not token:
        return None
    try:
        payload = decode_token(token)
    except ValueError:
        return None

    user_id = payload.get("sub")
    token_version = payload.get("tv", 0)
    if not isinstance(user_id, str) or not user_id or not isinstance(token_version, int):
        return None

    with get_connection() as connection:
        row = connection.execute(
            """
            SELECT id, email, full_name, role, is_active, token_version, can_access_offer_tool
            FROM users
            WHERE id = ?
            """,
            (user_id,),
        ).fetchone()

    if row is None or not bool(row["is_active"]):
        return None
    if int(row["token_version"] or 0) != token_version:
        return None

    return OfferPortalUser(
        id=row["id"],
        email=row["email"],
        full_name=row["full_name"],
        role=row["role"],
        is_active=bool(row["is_active"]),
        token_version=int(row["token_version"] or 0),
        can_access_offer_tool=bool(row["can_access_offer_tool"]),
    )


def get_offer_portal_user(request: Request) -> OfferPortalUser | None:
    user = getattr(request.state, "portal_user", None)
    if isinstance(user, OfferPortalUser):
        return user
    return None


def require_offer_user(request: Request) -> OfferPortalUser:
    user = get_offer_portal_user(request)
    if user is None:
        raise PermissionError("Oturum gerekli.")
    if not (user.is_admin or user.can_access_offer_tool):
        raise PermissionError("Teklif modülüne erişim yetkin yok.")
    return user


def require_offer_admin(request: Request) -> OfferPortalUser:
    user = require_offer_user(request)
    if not user.is_admin:
        raise PermissionError("Bu alan sadece teklif yöneticileri için.")
    return user


async def enforce_offer_access(request: Request, call_next):
    token = request.cookies.get(SESSION_COOKIE_NAME, "").strip()
    user = _load_offer_user_from_token(token)
    accepts_html = "text/html" in (request.headers.get("accept") or "")

    if user is None:
        if request.method in {"GET", "HEAD"} and accepts_html:
            return RedirectResponse("/", status_code=303)
        return PlainTextResponse("Oturum gerekli.", status_code=401)

    if not (user.is_admin or user.can_access_offer_tool):
        if accepts_html:
            return HTMLResponse(
                "<html><body style='font-family:Tahoma,Arial,sans-serif;padding:24px;background:#dbe6f5;'>"
                "<h2>Teklif modülü erişimi kapalı</h2>"
                "<p>Bu kullanıcı için teklif modülü yetkisi tanımlı değil.</p>"
                "<p><a href='/'>Portala dön</a></p>"
                "</body></html>",
                status_code=403,
            )
        return PlainTextResponse("Teklif modülüne erişim yetkin yok.", status_code=403)

    request.state.portal_user = user
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    return response
