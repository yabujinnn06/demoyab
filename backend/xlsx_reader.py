from __future__ import annotations

import json
import re
import unicodedata
import xml.etree.ElementTree as ET
from collections import Counter
from io import BytesIO
from typing import Any
from zipfile import BadZipFile, ZipFile


MAX_ZIP_ENTRIES = 250
MAX_TOTAL_UNCOMPRESSED_BYTES = 80 * 1024 * 1024
MAX_XML_ENTRY_BYTES = 32 * 1024 * 1024


HEADER_MAP = {
    "isim": "company_name",
    "adsoyad": "company_name",
    "firma": "company_name",
    "firmaadi": "company_name",
    "sirket": "company_name",
    "name": "company_name",
    "adres": "address",
    "address": "address",
    "telefon": "phone",
    "phone": "phone",
    "tel": "phone",
    "website": "website",
    "websitesi": "website",
    "web": "website",
    "email": "email",
    "mail": "email",
    "emaildurumu": "email_status",
    "puan": "rating",
    "rating": "rating",
    "yorumsayisi": "review_count",
    "reviews": "review_count",
    "link": "source_link",
    "kayitzamani": "source_created_at",
    "kayittarihi": "source_created_at",
}


def normalize_header(value: Any) -> str:
    raw = str(value or "").strip().lower()
    replacements = {
        "ı": "i",
        "ğ": "g",
        "ü": "u",
        "ş": "s",
        "ö": "o",
        "ç": "c",
        "â": "a",
        "î": "i",
        "û": "u",
        "i̇": "i",
        "Ä±": "i",
        "iÌ‡": "i",
        "ÄŸ": "g",
        "Ã¼": "u",
        "ÅŸ": "s",
        "Ã¶": "o",
        "Ã§": "c",
    }
    for source, target in replacements.items():
        raw = raw.replace(source, target)
    raw = unicodedata.normalize("NFKD", raw)
    raw = "".join(character for character in raw if not unicodedata.combining(character))
    return re.sub(r"[^a-z0-9]+", "", raw)


def normalize_phone(value: Any) -> str:
    if value is None:
        return ""
    raw = str(value).strip()
    digits = re.sub(r"\D+", "", raw)
    if len(digits) > 10 and digits.startswith("90"):
        digits = digits[2:]
    if len(digits) > 10 and digits.startswith("0"):
        digits = digits[1:]
    return digits


def cell_to_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if re.fullmatch(r"-?\d+\.0", text):
        return text[:-2]
    return text


def _text_content(element: ET.Element | None) -> str:
    if element is None:
        return ""
    return "".join(element.itertext())


def _column_index(cell_reference: str) -> int:
    letters = "".join(character for character in cell_reference if character.isalpha()).upper()
    value = 0
    for character in letters:
        value = (value * 26) + (ord(character) - 64)
    return value


def _validate_archive(archive: ZipFile) -> None:
    entries = archive.infolist()
    if len(entries) > MAX_ZIP_ENTRIES:
        raise ValueError("Excel dosyasi beklenenden fazla parca iceriyor.")

    total_size = 0
    for entry in entries:
        name = entry.filename.replace("\\", "/")
        if entry.flag_bits & 0x1:
            raise ValueError("Sifreli Excel dosyalari desteklenmez.")
        if name.startswith("/") or "/../" in f"/{name}/":
            raise ValueError("Excel dosyasi guvenli olmayan dosya yolu iceriyor.")
        total_size += entry.file_size
        if name.endswith(".xml") and entry.file_size > MAX_XML_ENTRY_BYTES:
            raise ValueError("Excel XML parcasi cok buyuk.")

    if total_size > MAX_TOTAL_UNCOMPRESSED_BYTES:
        raise ValueError("Excel dosyasi acildiginda cok buyuk hale geliyor.")


def _read_xml(archive: ZipFile, path: str) -> ET.Element:
    try:
        payload = archive.read(path)
    except KeyError as exc:
        raise ValueError("Excel dosya yapisi eksik veya bozuk.") from exc
    if b"<!DOCTYPE" in payload[:4096].upper():
        raise ValueError("Excel XML dosyasinda desteklenmeyen tanim bulundu.")
    try:
        return ET.fromstring(payload)
    except ET.ParseError as exc:
        raise ValueError("Excel XML dosyasi okunamadi.") from exc


def _load_shared_strings(archive: ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = _read_xml(archive, "xl/sharedStrings.xml")
    namespace = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    shared_strings: list[str] = []
    for entry in root.findall("s:si", namespace):
        shared_strings.append(_text_content(entry))
    return shared_strings


def _sheet_targets(archive: ZipFile) -> list[tuple[str, str]]:
    workbook_root = _read_xml(archive, "xl/workbook.xml")
    rels_root = _read_xml(archive, "xl/_rels/workbook.xml.rels")
    sheets_ns = {
        "s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
        "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    }
    rels_ns = {"r": "http://schemas.openxmlformats.org/package/2006/relationships"}
    rel_map = {
        rel_id: target
        for rel in rels_root.findall("r:Relationship", rels_ns)
        if (rel_id := rel.attrib.get("Id")) and (target := rel.attrib.get("Target"))
    }
    targets: list[tuple[str, str]] = []
    for sheet in workbook_root.findall("s:sheets/s:sheet", sheets_ns):
        rel_id = sheet.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
        if not rel_id:
            continue
        target = rel_map.get(rel_id)
        if not target:
            continue
        normalized = target.lstrip("/")
        if not normalized.startswith("xl/"):
            normalized = f"xl/{normalized}"
        targets.append((sheet.attrib.get("name", "Sheet"), normalized))
    return targets


def _read_sheet_rows(archive: ZipFile, path: str, shared_strings: list[str]) -> list[list[str | None]]:
    root = _read_xml(archive, path)
    namespace = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    rows: list[list[str | None]] = []

    for row in root.findall("s:sheetData/s:row", namespace):
        cell_map: dict[int, str | None] = {}
        max_index = 0
        for cell in row.findall("s:c", namespace):
            cell_ref = cell.attrib.get("r", "")
            column_index = _column_index(cell_ref)
            max_index = max(max_index, column_index)
            cell_type = cell.attrib.get("t")
            value: str | None
            if cell_type == "s":
                raw_index = _text_content(cell.find("s:v", namespace))
                try:
                    value = shared_strings[int(raw_index)]
                except (ValueError, IndexError):
                    value = raw_index or None
            elif cell_type == "inlineStr":
                value = _text_content(cell.find("s:is", namespace)) or None
            elif cell_type == "b":
                value = "TRUE" if _text_content(cell.find("s:v", namespace)) == "1" else "FALSE"
            else:
                value = _text_content(cell.find("s:v", namespace)) or None
            cell_map[column_index] = cell_to_text(value)
        if max_index == 0:
            continue
        rows.append([cell_map.get(index) for index in range(1, max_index + 1)])
    return rows


def record_dedupe_key(mapped: dict[str, Any]) -> str:
    phone = normalize_phone(mapped.get("phone"))
    if phone and len(phone) >= 7:
        return f"phone:{phone}"
    fallback = "|".join(
        str(mapped.get(key) or "").strip().lower()
        for key in ("company_name", "address", "website")
    )
    return f"row:{fallback[:220]}"


def parse_xlsx_records(file_bytes: bytes) -> tuple[list[dict[str, Any]], int]:
    try:
        archive = ZipFile(BytesIO(file_bytes))
    except BadZipFile as exc:
        raise ValueError("Excel dosyasi okunamadi.") from exc

    records_by_key: dict[str, dict[str, Any]] = {}
    duplicate_count = 0
    try:
        _validate_archive(archive)
        shared_strings = _load_shared_strings(archive)

        for sheet_name, target in _sheet_targets(archive):
            if target not in archive.namelist():
                continue
            rows = _read_sheet_rows(archive, target, shared_strings)
            if not rows:
                continue
            headers = [cell or "" for cell in rows[0]]
            mapped_headers = [HEADER_MAP.get(normalize_header(header)) for header in headers]

            for row_index, raw_row in enumerate(rows[1:], start=2):
                raw_payload = {
                    (headers[index] or f"Column {index + 1}"): raw_row[index]
                    for index in range(len(raw_row))
                    if raw_row[index] not in (None, "")
                }
                mapped: dict[str, Any] = {
                    "source_sheet_name": sheet_name,
                    "source_row_number": row_index,
                    "raw_payload": raw_payload,
                }
                for index, field_name in enumerate(mapped_headers):
                    if not field_name or index >= len(raw_row):
                        continue
                    value = raw_row[index]
                    if value not in (None, ""):
                        mapped[field_name] = value

                if not mapped.get("company_name") and not mapped.get("phone"):
                    continue

                mapped["normalized_phone"] = normalize_phone(mapped.get("phone")) or None
                dedupe_key = record_dedupe_key(mapped)
                mapped["dedupe_key"] = dedupe_key
                existing = records_by_key.get(dedupe_key)
                if existing is None:
                    records_by_key[dedupe_key] = mapped
                    continue

                duplicate_count += 1
                for field_name in (
                    "company_name",
                    "address",
                    "phone",
                    "normalized_phone",
                    "website",
                    "email",
                    "email_status",
                    "rating",
                    "review_count",
                    "source_link",
                    "source_created_at",
                ):
                    if existing.get(field_name) in (None, "") and mapped.get(field_name) not in (None, ""):
                        existing[field_name] = mapped[field_name]
    finally:
        archive.close()
    return list(records_by_key.values()), duplicate_count


def build_summary(records: list[dict[str, Any]]) -> dict[str, int]:
    call_counts = Counter(record.get("call_status", "NOT_CALLED") for record in records)
    result_counts = Counter(record.get("result_status", "PENDING") for record in records)
    assigned = sum(1 for record in records if record.get("assigned_user_id"))
    return {
        "total": len(records),
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


def raw_payload_json(raw_payload: dict[str, Any]) -> str:
    return json.dumps(raw_payload, ensure_ascii=False)
