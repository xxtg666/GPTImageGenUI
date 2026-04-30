from __future__ import annotations

import base64
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import threading
import time
import urllib.parse
import uuid
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import httpx


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
IMAGES_DIR = DATA_DIR / "images"
CONFIG_PATH = DATA_DIR / "config.json"
DB_PATH = DATA_DIR / "db.json"

DEFAULT_CONFIG = {
    "endpoints": [],
    "active_endpoint_id": "default",
    "password_hash": "",
    "password_salt": "",
    "session_secret": "",
    "expected_task_seconds": 90,
    "default_retries": 0,
    "default_text_size": "1024x1024",
    "default_quality": "",
    "default_style": "",
    "default_background": "",
    "default_moderation": "",
    "default_output_format": "",
    "default_output_compression": "",
    "web_icon_url": "",
    "web_background_url": "",
    "web_background_opacity": 0.22,
    "color_theme": "terracotta",
    "server_port": 7860,
}

DEFAULT_DB = {"images": [], "prompts": []}
COOKIE_NAME = "imagegen_session"
SESSION_TTL = 7 * 24 * 60 * 60
TASKS: dict[str, dict[str, Any]] = {}
TASK_LOCK = threading.Lock()
DB_LOCK = threading.Lock()
MAX_TASK_HISTORY = 100


def default_endpoint() -> dict[str, Any]:
    return {
        "id": "default",
        "alias": "默认后端",
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-image-1",
        "api_key": "",
    }


class UpstreamError(RuntimeError):
    def __init__(self, message: str, status: int | None = None, detail: Any = None, raw: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.detail = detail
        self.raw = raw


def ensure_files() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    IMAGES_DIR.mkdir(exist_ok=True)
    if not CONFIG_PATH.exists():
        config = normalize_config(DEFAULT_CONFIG | {"session_secret": secrets.token_hex(32)})
        write_json(CONFIG_PATH, config)
    else:
        config = normalize_config(DEFAULT_CONFIG | read_json(CONFIG_PATH, DEFAULT_CONFIG))
        if not config.get("session_secret"):
            config["session_secret"] = secrets.token_hex(32)
        write_json(CONFIG_PATH, config)
    if not DB_PATH.exists():
        write_json(DB_PATH, DEFAULT_DB)


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default.copy() if isinstance(default, dict) else default


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), "utf-8")


def normalize_config(config: dict[str, Any]) -> dict[str, Any]:
    config = DEFAULT_CONFIG | dict(config)
    endpoints = config.get("endpoints") or []
    if not endpoints:
        endpoints = [
            {
                "id": "default",
                "alias": config.get("alias", "") or "默认后端",
                "base_url": config.get("base_url", default_endpoint()["base_url"]),
                "model": config.get("model", default_endpoint()["model"]),
                "api_key": config.get("api_key", ""),
            }
        ]
    normalized_endpoints = normalize_endpoints(endpoints)
    config["endpoints"] = normalized_endpoints
    endpoint_ids = {item["id"] for item in normalized_endpoints}
    active_id = str(config.get("active_endpoint_id", "") or normalized_endpoints[0]["id"])
    config["active_endpoint_id"] = active_id if active_id in endpoint_ids else normalized_endpoints[0]["id"]
    return config


def normalize_endpoints(items: list[Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            continue
        endpoint_id = normalize_endpoint_id(item.get("id"), f"endpoint-{index}")
        if endpoint_id in seen_ids:
            endpoint_id = normalize_endpoint_id(f"{endpoint_id}-{index}", f"endpoint-{index}")
        seen_ids.add(endpoint_id)
        result.append(
            {
                "id": endpoint_id,
                "alias": str(item.get("alias", "")).strip() or f"后端 {index}",
                "base_url": str(item.get("base_url", "")).strip().rstrip("/") or default_endpoint()["base_url"],
                "model": str(item.get("model", "")).strip() or default_endpoint()["model"],
                "api_key": str(item.get("api_key", "") or "").strip(),
            }
        )
    return result or [default_endpoint()]


def normalize_endpoint_id(value: Any, fallback: str) -> str:
    raw = str(value or "").strip().lower()
    normalized = re.sub(r"[^a-z0-9_-]+", "-", raw).strip("-")
    return normalized[:40] or fallback


def get_active_endpoint(config: dict[str, Any], endpoint_id: str | None = None) -> dict[str, Any]:
    endpoints = config.get("endpoints", [])
    target_id = endpoint_id or config.get("active_endpoint_id")
    for item in endpoints:
        if item.get("id") == target_id:
            return item
    return endpoints[0] if endpoints else default_endpoint()


def merge_endpoints(existing: list[dict[str, Any]], incoming: list[Any]) -> list[dict[str, Any]]:
    existing_map = {item["id"]: item for item in normalize_endpoints(existing)}
    merged: list[dict[str, Any]] = []
    for index, raw in enumerate(incoming or [], start=1):
        if not isinstance(raw, dict):
            continue
        endpoint_id = normalize_endpoint_id(raw.get("id"), f"endpoint-{index}")
        previous = existing_map.get(endpoint_id, {})
        api_key = str(raw.get("api_key", "") or "").strip()
        merged.append(
            {
                "id": endpoint_id,
                "alias": str(raw.get("alias", "")).strip() or previous.get("alias", f"后端 {index}"),
                "base_url": str(raw.get("base_url", "")).strip().rstrip("/") or previous.get("base_url", default_endpoint()["base_url"]),
                "model": str(raw.get("model", "")).strip() or previous.get("model", default_endpoint()["model"]),
                "api_key": api_key,
            }
        )
    return normalize_endpoints(merged)


def get_config() -> dict[str, Any]:
    return normalize_config(DEFAULT_CONFIG | read_json(CONFIG_PATH, DEFAULT_CONFIG))


def save_config(config: dict[str, Any]) -> None:
    write_json(CONFIG_PATH, normalize_config(DEFAULT_CONFIG | config))


def get_db() -> dict[str, Any]:
    db = DEFAULT_DB | read_json(DB_PATH, DEFAULT_DB)
    db.setdefault("images", [])
    db.setdefault("prompts", [])
    return db


def save_db(db: dict[str, Any]) -> None:
    write_json(DB_PATH, db)


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False).encode("utf-8")


def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 200_000)
    return salt, base64.b64encode(digest).decode("ascii")


def verify_password(password: str, salt: str, digest: str) -> bool:
    _, candidate = hash_password(password, salt)
    return hmac.compare_digest(candidate, digest)


def make_session(config: dict[str, Any]) -> str:
    expires = str(int(time.time()) + SESSION_TTL)
    sig = hmac.new(config["session_secret"].encode("utf-8"), expires.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{expires}.{sig}"


def verify_session(token: str, config: dict[str, Any]) -> bool:
    try:
        expires, sig = token.split(".", 1)
        if int(expires) < int(time.time()):
            return False
        expected = hmac.new(config["session_secret"].encode("utf-8"), expires.encode("utf-8"), hashlib.sha256).hexdigest()
        return hmac.compare_digest(sig, expected)
    except (ValueError, TypeError):
        return False


def safe_filename(name: str) -> str:
    stem = Path(name).stem or "image"
    ext = Path(name).suffix.lower()
    stem = re.sub(r"[^a-zA-Z0-9._-]+", "-", stem).strip(".-")[:60] or "image"
    if ext not in {".png", ".jpg", ".jpeg", ".webp"}:
        ext = ".png"
    return f"{stem}{ext}"


def safe_download_prefix(value: str) -> str:
    value = re.sub(r"[\r\n]+", " ", value or "")
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "-", value).strip(". -")
    value = re.sub(r"\s+", "-", value)
    return value[:80]


def parse_json_body(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    if length == 0:
        return {}
    raw = handler.rfile.read(length)
    return json.loads(raw.decode("utf-8"))


def parse_request_body(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    if length == 0:
        return {}
    raw = handler.rfile.read(length)
    content_type = handler.headers.get("Content-Type", "")
    if content_type.startswith("multipart/form-data"):
        return parse_multipart(content_type, raw)
    return json.loads(raw.decode("utf-8"))


def parse_cookie(header: str | None) -> dict[str, str]:
    jar = cookies.SimpleCookie()
    if header:
        jar.load(header)
    return {key: morsel.value for key, morsel in jar.items()}


def parse_content_disposition(value: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for part in value.split(";"):
        part = part.strip()
        if "=" in part:
            key, raw_value = part.split("=", 1)
            result[key.lower()] = raw_value.strip('"')
    return result


def parse_multipart(content_type: str, body: bytes) -> dict[str, Any]:
    match = re.search(r"boundary=(?P<boundary>[^;]+)", content_type)
    if not match:
        raise ValueError("Missing multipart boundary")
    boundary = match.group("boundary").strip('"').encode("utf-8")
    fields: dict[str, Any] = {}
    for chunk in body.split(b"--" + boundary):
        chunk = chunk.strip(b"\r\n")
        if not chunk or chunk == b"--":
            continue
        if chunk.endswith(b"--"):
            chunk = chunk[:-2].strip(b"\r\n")
        if b"\r\n\r\n" not in chunk:
            continue
        header_blob, content = chunk.split(b"\r\n\r\n", 1)
        headers: dict[str, str] = {}
        for line in header_blob.decode("utf-8", "replace").split("\r\n"):
            if ":" in line:
                key, value = line.split(":", 1)
                headers[key.lower()] = value.strip()
        disposition = parse_content_disposition(headers.get("content-disposition", ""))
        name = disposition.get("name")
        if not name:
            continue
        filename = disposition.get("filename")
        if filename:
            add_multipart_value(fields, name, {
                "filename": safe_filename(filename),
                "content_type": headers.get("content-type", "application/octet-stream"),
                "content": content,
            })
        else:
            add_multipart_value(fields, name, content.decode("utf-8", "replace"))
    return fields


def add_multipart_value(fields: dict[str, Any], name: str, value: Any) -> None:
    if name not in fields:
        fields[name] = value
    elif isinstance(fields[name], list):
        fields[name].append(value)
    else:
        fields[name] = [fields[name], value]


def build_multipart(fields: dict[str, str], files: list[dict[str, Any]]) -> tuple[bytes, str]:
    boundary = "----ImageGenUI" + uuid.uuid4().hex
    lines: list[bytes] = []
    for name, value in fields.items():
        lines.append(f"--{boundary}\r\n".encode("utf-8"))
        lines.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
        lines.append(str(value).encode("utf-8"))
        lines.append(b"\r\n")
    for file_item in files:
        lines.append(f"--{boundary}\r\n".encode("utf-8"))
        disposition = (
            f'Content-Disposition: form-data; name="{file_item["name"]}"; '
            f'filename="{file_item["filename"]}"\r\n'
        )
        lines.append(disposition.encode("utf-8"))
        lines.append(f'Content-Type: {file_item["content_type"]}\r\n\r\n'.encode("utf-8"))
        lines.append(file_item["content"])
        lines.append(b"\r\n")
    lines.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(lines), f"multipart/form-data; boundary={boundary}"


def upstream_url(config: dict[str, Any], path: str) -> str:
    return config.get("base_url", "").rstrip("/") + path


def request_upstream(
    config: dict[str, Any],
    path: str,
    body: bytes,
    content_type: str,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    headers = {
        "Content-Type": content_type,
        "Accept": "*/*",
        "Accept-Language": "zh-CN",
        "HTTP-Referer": "https://cherry-ai.com",
        "Origin": "https://cherry-ai.com",
        "Priority": "u=1, i",
        "Sec-CH-UA": '"Not-A.Brand";v="24", "Chromium";v="146"',
        "Sec-CH-UA-Mobile": "?0",
        "Sec-CH-UA-Platform": '"Windows"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "CherryStudio/1.9.3 Chrome/146.0.7680.188 Electron/41.2.1 Safari/537.36"
        ),
        "X-Title": "Cherry Studio",
    }
    if config.get("api_key"):
        headers["Authorization"] = f'Bearer {config["api_key"]}'
    owns_client = client is None
    client = client or httpx.Client(timeout=httpx.Timeout(180.0), follow_redirects=True, http2=True)
    try:
        response = client.post(upstream_url(config, path), content=body, headers=headers)
    except httpx.HTTPError as exc:
        raise UpstreamError(f"Upstream request failed: {exc}", detail=str(exc), raw=str(exc)) from exc
    finally:
        if owns_client:
            client.close()
    raw = response.content
    raw_text = response.text
    if response.status_code >= 400:
        try:
            detail = response.json()
        except json.JSONDecodeError:
            detail = raw_text
        raise UpstreamError(
            f"Upstream HTTP {response.status_code}",
            status=response.status_code,
            detail=detail,
            raw=raw_text,
        )
    try:
        return json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise UpstreamError("Upstream response is not JSON", raw=raw.decode("utf-8", "replace")) from exc


def save_generated_images(
    response: dict[str, Any],
    prompt: str,
    size: str,
    mode: str,
    model: str,
    source_image: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    with DB_LOCK:
        db = get_db()
        saved: list[dict[str, Any]] = []
        for index, item in enumerate(response.get("data", []), start=1):
            image_bytes: bytes | None = None
            ext = ".png"
            if item.get("b64_json"):
                image_bytes = base64.b64decode(item["b64_json"])
            elif item.get("url"):
                with httpx.Client(timeout=httpx.Timeout(180.0), follow_redirects=True, http2=True) as client:
                    response = client.get(item["url"], headers={"User-Agent": "ImageGenUI/1.0 (+httpx)"})
                    response.raise_for_status()
                    image_bytes = response.content
                    content_type = response.headers.get("Content-Type", "")
                    ext = mimetypes.guess_extension(content_type.split(";")[0]) or ".png"
            if not image_bytes:
                continue
            image_id = uuid.uuid4().hex
            filename = f"{int(time.time())}-{image_id[:8]}-{index}{ext}"
            (IMAGES_DIR / filename).write_bytes(image_bytes)
            record = {
                "id": image_id,
                "created_at": int(time.time()),
                "filename": filename,
                "url": f"/media/{filename}",
                "source_filename": source_image.get("filename", "") if source_image else "",
                "source_url": source_image.get("url", "") if source_image else "",
                "title": item.get("revised_prompt", "") or prompt[:40],
            "prompt": prompt,
            "revised_prompt": item.get("revised_prompt", ""),
                "size": size,
                "mode": mode,
                "model": model,
                "tags": [],
                "archived": False,
            }
            db["images"].insert(0, record)
            saved.append(record)
        save_db(db)
        return saved


def save_source_image(image: dict[str, Any] | None) -> dict[str, str] | None:
    if not image or not image.get("content"):
        return None
    ext = Path(image.get("filename", "")).suffix.lower()
    if ext not in {".png", ".jpg", ".jpeg", ".webp"}:
        ext = mimetypes.guess_extension(image.get("content_type", "").split(";")[0]) or ".png"
    image_id = uuid.uuid4().hex
    filename = f"{int(time.time())}-source-{image_id[:8]}{ext}"
    (IMAGES_DIR / filename).write_bytes(image["content"])
    return {"filename": filename, "url": f"/media/{filename}"}


def save_reference_image(image: dict[str, Any] | None) -> dict[str, str] | None:
    if not image or not image.get("content"):
        return None
    ext = Path(image.get("filename", "")).suffix.lower()
    if ext not in {".png", ".jpg", ".jpeg", ".webp"}:
        ext = mimetypes.guess_extension(image.get("content_type", "").split(";")[0]) or ".png"
    image_id = uuid.uuid4().hex
    filename = f"{int(time.time())}-prompt-ref-{image_id[:8]}{ext}"
    (IMAGES_DIR / filename).write_bytes(image["content"])
    return {"filename": filename, "url": f"/media/{filename}"}


def delete_stored_image(filename: str) -> None:
    if not filename:
        return
    file_path = (IMAGES_DIR / safe_filename(filename)).resolve()
    if str(file_path).startswith(str(IMAGES_DIR.resolve())) and file_path.exists():
        file_path.unlink()


def public_task(task: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in task.items() if key not in {"request", "client"}}


def list_tasks() -> list[dict[str, Any]]:
    with TASK_LOCK:
        tasks = sorted(TASKS.values(), key=lambda item: item["created_at"], reverse=True)
        return [public_task(task.copy()) for task in tasks]


def has_active_tasks_locked() -> bool:
    return any(task["status"] in {"queued", "running"} for task in TASKS.values())


def is_task_cancelled(task_id: str) -> bool:
    with TASK_LOCK:
        task = TASKS.get(task_id)
        return bool(task and task.get("status") == "cancelled")


def get_task(task_id: str) -> dict[str, Any] | None:
    with TASK_LOCK:
        task = TASKS.get(task_id)
        return public_task(task.copy()) if task else None


def update_task(task_id: str, **changes: Any) -> None:
    with TASK_LOCK:
        task = TASKS.get(task_id)
        if not task:
            return
        task.update(changes)
        task["updated_at"] = int(time.time())


def set_task_client(task_id: str, client: httpx.Client | None) -> None:
    with TASK_LOCK:
        task = TASKS.get(task_id)
        if task:
            task["client"] = client


def create_task(mode: str, prompt: str, size: str, retry_count: int, request_data: dict[str, Any]) -> dict[str, Any]:
    config = get_config()
    endpoint = get_active_endpoint(config, request_data.get("endpoint_id"))
    request_data = request_data | {"config": config, "endpoint": endpoint}
    task_id = uuid.uuid4().hex
    expected_seconds = normalize_expected_seconds(config.get("expected_task_seconds", 90))
    retry_count = normalize_retry_count(retry_count)
    task = {
        "id": task_id,
        "mode": mode,
        "status": "queued",
        "prompt": prompt,
        "size": size,
        "model": endpoint["model"],
        "endpoint_id": endpoint["id"],
        "endpoint_alias": endpoint["alias"],
        "attempt": 0,
        "max_attempts": max(1, min(10, retry_count + 1)),
        "created_at": int(time.time()),
        "updated_at": int(time.time()),
        "completed_at": None,
        "expected_seconds": expected_seconds,
        "images": [],
        "error": "",
        "raw_error": None,
        "client": None,
        "request": request_data,
    }
    with TASK_LOCK:
        TASKS[task_id] = task
        prune_tasks_locked()
    thread = threading.Thread(target=run_task, args=(task_id,), daemon=True)
    thread.start()
    return public_task(task)


def prune_tasks_locked() -> None:
    if len(TASKS) <= MAX_TASK_HISTORY:
        return
    removable = sorted(
        [task for task in TASKS.values() if task["status"] in {"succeeded", "failed"}],
        key=lambda item: item["updated_at"],
    )
    for task in removable[: max(0, len(TASKS) - MAX_TASK_HISTORY)]:
        TASKS.pop(task["id"], None)


def clear_task_history() -> int:
    with TASK_LOCK:
        if has_active_tasks_locked():
            raise ValueError("仍有任务在进行中，暂时不能清空历史")
        removable_ids = [task_id for task_id, task in TASKS.items() if task["status"] in {"succeeded", "failed", "cancelled"}]
        for task_id in removable_ids:
            TASKS.pop(task_id, None)
        return len(removable_ids)


def cancel_task(task_id: str) -> dict[str, Any] | None:
    with TASK_LOCK:
        task = TASKS.get(task_id)
        if not task:
            return None
        if task["status"] in {"succeeded", "failed", "cancelled"}:
            return public_task(task.copy())
        task["status"] = "cancelled"
        task["error"] = "任务已手动中断"
        task["completed_at"] = int(time.time())
        task["updated_at"] = int(time.time())
        client = task.get("client")
        snapshot = public_task(task.copy())
    if client:
        try:
            client.close()
        except Exception:
            pass
    return snapshot


def run_task(task_id: str) -> None:
    with TASK_LOCK:
        task = TASKS.get(task_id)
        if not task:
            return
        request_data = task["request"]
        max_attempts = task["max_attempts"]
        mode = task["mode"]
        prompt = task["prompt"]
        size = task["size"]
    for attempt in range(1, max_attempts + 1):
        if is_task_cancelled(task_id):
            return
        update_task(task_id, status="running", attempt=attempt, error="", raw_error=None)
        try:
            config = request_data["config"]
            endpoint = request_data["endpoint"]
            options = request_data.get("options", {})
            client = httpx.Client(timeout=httpx.Timeout(180.0), follow_redirects=True, http2=True)
            set_task_client(task_id, client)
            if mode == "text":
                payload = {"model": endpoint["model"], "prompt": prompt, "size": size} | options
                response = request_upstream(endpoint, "/images/generations", json_bytes(payload), "application/json", client)
                source_image = None
            else:
                fields = {"model": endpoint["model"], "prompt": prompt, "size": size}
                fields.update({key: str(value) for key, value in options.items()})
                files = request_data["images"].copy()
                source_image = None
                if request_data.get("mask"):
                    files.append(request_data["mask"])
                multipart_body, content_type = build_multipart(
                    fields,
                    files,
                )
                response = request_upstream(endpoint, "/images/edits", multipart_body, content_type, client)
            set_task_client(task_id, None)
            try:
                client.close()
            except Exception:
                pass
            if is_task_cancelled(task_id):
                return
            if mode == "image":
                source_image = save_source_image(request_data["images"][0] if request_data.get("images") else None)
            saved = save_generated_images(response, prompt, size, mode, endpoint["model"], source_image)
            update_task(
                task_id,
                status="succeeded",
                images=saved,
                model=endpoint["model"],
                endpoint_alias=endpoint["alias"],
                completed_at=int(time.time()),
            )
            return
        except UpstreamError as exc:
            set_task_client(task_id, None)
            raw_error = {
                "message": str(exc),
                "status": exc.status,
                "detail": exc.detail,
                "raw": exc.raw,
            }
            if is_task_cancelled(task_id):
                return
            update_task(task_id, error=format_upstream_error(exc), raw_error=raw_error)
        except Exception as exc:
            set_task_client(task_id, None)
            if is_task_cancelled(task_id):
                return
            update_task(task_id, error=str(exc), raw_error={"message": str(exc)})
        if attempt < max_attempts:
            time.sleep(min(2 * attempt, 8))
    if is_task_cancelled(task_id):
        return
    update_task(task_id, status="failed", completed_at=int(time.time()))


def format_upstream_error(exc: UpstreamError) -> str:
    if isinstance(exc.detail, dict):
        error = exc.detail.get("error", exc.detail)
        if isinstance(error, dict):
            code = error.get("code")
            message = error.get("message") or error.get("type") or exc.args[0]
            return f"{exc.args[0]}: {message}" + (f" (code: {code})" if code else "")
        return f"{exc.args[0]}: {error}"
    if exc.detail:
        return f"{exc.args[0]}: {exc.detail}"
    return str(exc)


def normalize_retry_count(value: Any) -> int:
    try:
        return max(0, min(9, int(str(value).strip() or "0")))
    except ValueError:
        return 0


def normalize_expected_seconds(value: Any) -> int:
    try:
        return max(5, min(3600, int(str(value).strip() or "90")))
    except ValueError:
        return 90


def normalize_default_size(value: Any) -> str:
    value = str(first_value(value) or "1024x1024").strip()
    if value in {
        "1024x1024",
        "1536x1024",
        "1024x1536",
        "1792x1024",
        "1024x1792",
        "2048x2048",
        "2048x1152",
        "1152x2048",
        "3840x2160",
        "2160x3840",
        "512x512",
        "256x256",
        "auto",
    }:
        return value
    if re.match(r"^\d+x\d+$", value):
        return value
    return "1024x1024"


def normalize_choice(value: Any, allowed: set[str]) -> str:
    value = str(first_value(value) or "").strip()
    return value if value in allowed else ""


def normalize_output_compression(value: Any) -> str:
    value = str(first_value(value) or "").strip()
    if not value:
        return ""
    try:
        return str(max(0, min(100, int(value))))
    except ValueError:
        return ""


def normalize_opacity(value: Any) -> float:
    raw = str(first_value(value) or "0.22").strip()
    try:
        opacity = float(raw)
    except ValueError:
        return 0.22
    if opacity > 1:
        opacity = opacity / 100
    return round(max(0, min(1, opacity)), 2)


def normalize_color_theme(value: Any) -> str:
    theme = str(first_value(value) or "terracotta").strip().lower()
    return theme if theme in {"terracotta", "forest", "ocean", "slate", "rose"} else "terracotta"


def normalize_port(value: Any) -> int:
    try:
        return max(1, min(65535, int(str(value).strip() or "7860")))
    except ValueError:
        return 7860


def collect_image_options(values: dict[str, Any], config: dict[str, Any] | None = None) -> dict[str, Any]:
    config = config or {}
    options: dict[str, Any] = {"n": 1}
    defaults = {
        "quality": config.get("default_quality", ""),
        "style": config.get("default_style", ""),
        "background": config.get("default_background", ""),
        "moderation": config.get("default_moderation", ""),
        "output_format": config.get("default_output_format", ""),
        "output_compression": config.get("default_output_compression", ""),
    }
    for key in ("quality", "style", "background", "moderation", "output_format", "output_compression"):
        value = first_value(values.get(key))
        if value in {None, ""}:
            value = defaults.get(key, "")
        if value:
            if key == "output_compression":
                compression = normalize_output_compression(value)
                if compression:
                    options[key] = int(compression)
            else:
                options[key] = value
    if options.get("output_compression") is not None and options.get("output_format") not in {"jpeg", "webp"}:
        options.pop("output_compression", None)
    return options


def normalize_positive_int(value: Any) -> int | None:
    value = first_value(value)
    if not value:
        return None
    try:
        return max(1, min(10, int(str(value).strip())))
    except ValueError:
        return None


def first_value(value: Any) -> Any:
    if isinstance(value, list):
        return value[0] if value else ""
    return value


def normalize_uploaded_files(value: Any, field_name: str) -> list[dict[str, Any]]:
    if not value:
        return []
    files = value if isinstance(value, list) else [value]
    result: list[dict[str, Any]] = []
    for item in files:
        if isinstance(item, dict) and item.get("content"):
            result.append({"name": field_name, **item})
    return result


def normalize_single_file(value: Any, field_name: str) -> dict[str, Any] | None:
    value = first_value(value)
    if isinstance(value, dict) and value.get("content"):
        return {"name": field_name, **value}
    return None


class ImageGenHandler(BaseHTTPRequestHandler):
    server_version = "ImageGenUI/1.0"

    def end_headers(self) -> None:
        cache_control = getattr(self, "_cache_control", "no-store")
        self.send_header("Cache-Control", cache_control)
        self._cache_control = "no-store"
        super().end_headers()

    def send_file_with_cache(
        self,
        file_path: Path,
        *,
        content_type: str,
        download_name: str | None = None,
        cache_control: str = "private, max-age=31536000, immutable",
    ) -> None:
        stat = file_path.stat()
        etag = f'W/"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Last-Modified", self.date_time_string(stat.st_mtime))
            self._cache_control = cache_control
            self.end_headers()
            return
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("ETag", etag)
        self.send_header("Last-Modified", self.date_time_string(stat.st_mtime))
        if download_name:
            quoted_name = urllib.parse.quote(download_name)
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quoted_name}")
        self._cache_control = cache_control
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, status: int, payload: Any, extra_headers: dict[str, str] | None = None) -> None:
        data = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def send_error_json(self, status: int, message: str) -> None:
        self.send_json(status, {"error": message})

    def is_authenticated(self) -> bool:
        config = get_config()
        if not config.get("password_hash"):
            return True
        token = parse_cookie(self.headers.get("Cookie")).get(COOKIE_NAME, "")
        return verify_session(token, config)

    def require_auth(self) -> bool:
        if self.is_authenticated():
            return True
        self.send_error_json(401, "需要登录")
        return False

    def do_GET(self) -> None:
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            if path == "/api/me":
                self.handle_me()
            elif path == "/api/settings":
                self.handle_get_settings()
            elif path == "/api/images":
                self.handle_list_images(parsed.query)
            elif path.startswith("/api/images/") and path.endswith("/download"):
                self.handle_download_image(path)
            elif path == "/api/tasks":
                self.handle_list_tasks()
            elif path.startswith("/api/tasks/"):
                self.handle_get_task(path)
            elif path == "/api/prompts":
                self.handle_list_prompts()
            elif path.startswith("/media/"):
                self.handle_media(path)
            else:
                self.handle_static(path)
        except Exception as exc:
            self.send_error_json(500, str(exc))

    def do_POST(self) -> None:
        try:
            path = urllib.parse.urlparse(self.path).path
            if path == "/api/login":
                self.handle_login()
            elif path == "/api/logout":
                self.handle_logout()
            elif path == "/api/settings":
                self.handle_save_settings()
            elif path == "/api/generate":
                self.handle_generate()
            elif path == "/api/edit":
                self.handle_edit()
            elif path.startswith("/api/tasks/") and path.endswith("/cancel"):
                self.handle_cancel_task(path)
            elif path == "/api/prompts":
                self.handle_create_prompt()
            else:
                self.send_error_json(404, "Not found")
        except json.JSONDecodeError:
            self.send_error_json(400, "JSON 格式错误")
        except Exception as exc:
            self.send_error_json(500, str(exc))

    def do_PATCH(self) -> None:
        try:
            path = urllib.parse.urlparse(self.path).path
            if path.startswith("/api/images/"):
                if path.endswith("/download"):
                    self.send_error_json(405, "Method not allowed")
                else:
                    self.handle_update_image(path)
            elif path.startswith("/api/prompts/"):
                self.handle_update_prompt(path)
            else:
                self.send_error_json(404, "Not found")
        except json.JSONDecodeError:
            self.send_error_json(400, "JSON 格式错误")
        except Exception as exc:
            self.send_error_json(500, str(exc))

    def do_DELETE(self) -> None:
        try:
            path = urllib.parse.urlparse(self.path).path
            if path == "/api/tasks":
                self.handle_clear_task_history()
            elif path.startswith("/api/images/"):
                self.handle_delete_image(path)
            elif path.startswith("/api/prompts/"):
                self.handle_delete_prompt(path)
            else:
                self.send_error_json(404, "Not found")
        except Exception as exc:
            self.send_error_json(500, str(exc))

    def handle_static(self, path: str) -> None:
        if path in {"/", ""}:
            file_path = STATIC_DIR / "index.html"
        elif path.startswith("/static/"):
            file_path = STATIC_DIR / path.removeprefix("/static/")
        else:
            file_path = STATIC_DIR / "index.html"
        resolved = file_path.resolve()
        if not str(resolved).startswith(str(STATIC_DIR.resolve())) or not resolved.exists():
            self.send_error_json(404, "Not found")
            return
        content_type = mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
        data = resolved.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_media(self, path: str) -> None:
        if not self.require_auth():
            return
        name = safe_filename(path.removeprefix("/media/"))
        file_path = (IMAGES_DIR / name).resolve()
        if not str(file_path).startswith(str(IMAGES_DIR.resolve())) or not file_path.exists():
            self.send_error_json(404, "Not found")
            return
        self.send_file_with_cache(
            file_path,
            content_type=mimetypes.guess_type(file_path.name)[0] or "image/png",
        )

    def handle_download_image(self, path: str) -> None:
        if not self.require_auth():
            return
        image_id = path.split("/")[3]
        record = next((item for item in get_db()["images"] if item["id"] == image_id), None)
        if not record:
            self.send_error_json(404, "Not found")
            return
        file_path = (IMAGES_DIR / record["filename"]).resolve()
        prefix = safe_download_prefix(record.get("title") or record.get("revised_prompt") or "")
        download_name = f"{prefix}-{file_path.name}" if prefix else file_path.name
        self.send_file_with_cache(
            file_path,
            content_type=mimetypes.guess_type(file_path.name)[0] or "image/png",
            download_name=download_name,
            cache_control="private, max-age=0, must-revalidate",
        )

    def handle_me(self) -> None:
        config = get_config()
        self.send_json(
            200,
            {
                "password_set": bool(config.get("password_hash")),
                "authenticated": self.is_authenticated(),
            },
        )

    def handle_login(self) -> None:
        body = parse_json_body(self)
        password = body.get("password", "")
        config = get_config()
        if config.get("password_hash") and not verify_password(password, config["password_salt"], config["password_hash"]):
            self.send_error_json(401, "密码错误")
            return
        token = make_session(config)
        self.send_json(
            200,
            {"ok": True},
            {"Set-Cookie": f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL}"},
        )

    def handle_logout(self) -> None:
        self.send_json(200, {"ok": True}, {"Set-Cookie": f"{COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax"})

    def handle_get_settings(self) -> None:
        if not self.require_auth():
            return
        config = get_config()
        self.send_json(
            200,
            {
                "endpoints": [
                    {
                        "id": item["id"],
                        "alias": item["alias"],
                        "base_url": item["base_url"],
                        "model": item["model"],
                        "api_key": item.get("api_key", ""),
                        "has_api_key": bool(item.get("api_key")),
                    }
                    for item in config.get("endpoints", [])
                ],
                "active_endpoint_id": config.get("active_endpoint_id", ""),
                "expected_task_seconds": normalize_expected_seconds(config.get("expected_task_seconds", 90)),
                "default_retries": normalize_retry_count(config.get("default_retries", 0)),
                "default_text_size": str(config.get("default_text_size", "1024x1024") or "1024x1024"),
                "default_quality": normalize_choice(config.get("default_quality", ""), {"auto", "standard", "hd", "low", "medium", "high"}),
                "default_style": normalize_choice(config.get("default_style", ""), {"vivid", "natural"}),
                "default_background": normalize_choice(config.get("default_background", ""), {"auto", "opaque", "transparent"}),
                "default_moderation": normalize_choice(config.get("default_moderation", ""), {"auto", "low"}),
                "default_output_format": normalize_choice(config.get("default_output_format", ""), {"png", "jpeg", "webp"}),
                "default_output_compression": normalize_output_compression(config.get("default_output_compression", "")),
                "web_icon_url": str(config.get("web_icon_url", "") or ""),
                "web_background_url": str(config.get("web_background_url", "") or ""),
                "web_background_opacity": normalize_opacity(config.get("web_background_opacity", 0.22)),
                "color_theme": normalize_color_theme(config.get("color_theme", "terracotta")),
                "server_port": normalize_port(config.get("server_port", 7860)),
                "has_api_key": bool(config.get("api_key")),
                "password_set": bool(config.get("password_hash")),
            },
        )

    def handle_save_settings(self) -> None:
        if not self.require_auth():
            return
        body = parse_json_body(self)
        config = get_config()
        if "endpoints" in body:
            config["endpoints"] = merge_endpoints(config.get("endpoints", []), body.get("endpoints", []))
        if "active_endpoint_id" in body:
            config["active_endpoint_id"] = normalize_endpoint_id(body.get("active_endpoint_id"), config.get("active_endpoint_id", "default"))
        if "expected_task_seconds" in body:
            config["expected_task_seconds"] = normalize_expected_seconds(body.get("expected_task_seconds"))
        if "default_retries" in body:
            config["default_retries"] = normalize_retry_count(body.get("default_retries"))
        if "default_text_size" in body:
            config["default_text_size"] = normalize_default_size(body.get("default_text_size"))
        if "default_quality" in body:
            config["default_quality"] = normalize_choice(body.get("default_quality"), {"auto", "standard", "hd", "low", "medium", "high"})
        if "default_style" in body:
            config["default_style"] = normalize_choice(body.get("default_style"), {"vivid", "natural"})
        if "default_background" in body:
            config["default_background"] = normalize_choice(body.get("default_background"), {"auto", "opaque", "transparent"})
        if "default_moderation" in body:
            config["default_moderation"] = normalize_choice(body.get("default_moderation"), {"auto", "low"})
        if "default_output_format" in body:
            config["default_output_format"] = normalize_choice(body.get("default_output_format"), {"png", "jpeg", "webp"})
        if "default_output_compression" in body:
            config["default_output_compression"] = normalize_output_compression(body.get("default_output_compression"))
        if "web_icon_url" in body:
            config["web_icon_url"] = str(body.get("web_icon_url", "") or "").strip()
        if "web_background_url" in body:
            config["web_background_url"] = str(body.get("web_background_url", "") or "").strip()
        if "web_background_opacity" in body:
            config["web_background_opacity"] = normalize_opacity(body.get("web_background_opacity"))
        if "color_theme" in body:
            config["color_theme"] = normalize_color_theme(body.get("color_theme"))
        if "server_port" in body:
            config["server_port"] = normalize_port(body.get("server_port"))
        if body.get("password"):
            salt, digest = hash_password(str(body["password"]))
            config["password_salt"] = salt
            config["password_hash"] = digest
        if body.get("clear_password"):
            config["password_salt"] = ""
            config["password_hash"] = ""
        save_config(config)
        self.send_json(200, {"ok": True, "password_set": bool(config.get("password_hash"))})

    def handle_generate(self) -> None:
        if not self.require_auth():
            return
        body = parse_json_body(self)
        prompt = str(body.get("prompt", "")).strip()
        size = normalize_size(body)
        config = get_config()
        retry_count = normalize_retry_count(body.get("retries", config.get("default_retries", 0)))
        options = collect_image_options(body, config)
        if not prompt:
            self.send_error_json(400, "提示词不能为空")
            return
        task = create_task("text", prompt, size, retry_count, {"options": options, "endpoint_id": body.get("endpoint_id")})
        self.send_json(202, {"task": task})

    def handle_edit(self) -> None:
        if not self.require_auth():
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length)
        fields = parse_multipart(self.headers.get("Content-Type", ""), body)
        prompt = str(fields.get("prompt", "")).strip()
        size = normalize_size(fields)
        config = get_config()
        retry_count = normalize_retry_count(fields.get("retries", config.get("default_retries", 0)))
        options = collect_image_options(fields, config)
        if fields.get("image[]"):
            images = normalize_uploaded_files(fields.get("image[]"), "image[]")
        else:
            images = normalize_uploaded_files(fields.get("image"), "image")
        mask = normalize_single_file(fields.get("mask"), "mask")
        if not prompt:
            self.send_error_json(400, "提示词不能为空")
            return
        if not images:
            self.send_error_json(400, "必须上传图片")
            return
        task = create_task(
            "image",
            prompt,
            size,
            retry_count,
            {"images": images, "mask": mask, "options": options, "endpoint_id": fields.get("endpoint_id")},
        )
        self.send_json(202, {"task": task})

    def handle_list_tasks(self) -> None:
        if not self.require_auth():
            return
        self.send_json(200, {"tasks": list_tasks()})

    def handle_clear_task_history(self) -> None:
        if not self.require_auth():
            return
        try:
            removed = clear_task_history()
        except ValueError as exc:
            self.send_error_json(409, str(exc))
            return
        self.send_json(200, {"ok": True, "removed": removed})

    def handle_cancel_task(self, path: str) -> None:
        if not self.require_auth():
            return
        task_id = path.split("/")[3]
        task = cancel_task(task_id)
        if not task:
            self.send_error_json(404, "Not found")
            return
        self.send_json(200, {"task": task})

    def handle_get_task(self, path: str) -> None:
        if not self.require_auth():
            return
        task_id = path.split("/")[3]
        task = get_task(task_id)
        if not task:
            self.send_error_json(404, "Not found")
            return
        self.send_json(200, {"task": task})

    def handle_list_images(self, query: str) -> None:
        if not self.require_auth():
            return
        params = urllib.parse.parse_qs(query)
        q = (params.get("q", [""])[0] or "").lower().strip()
        selected_tags = {
            tag.strip().lower()
            for raw in params.get("tags", params.get("tag", []))
            for tag in re.split(r"[,，]+", raw)
            if tag.strip()
        }
        show_archived = (params.get("show_archived", [""])[0] or "").lower() in {"1", "true", "yes", "on"}
        images = [item | {"archived": bool(item.get("archived"))} for item in get_db()["images"]]
        if not show_archived:
            images = [item for item in images if not item.get("archived")]
        available_tags = sorted({tag for item in images for tag in item.get("tags", [])}, key=str.lower)
        if q:
            images = [
                item
                for item in images
                if q in item.get("prompt", "").lower()
                or q in item.get("title", "").lower()
                or q in item.get("revised_prompt", "").lower()
                or q in item.get("size", "").lower()
                or q in item.get("model", "").lower()
                or any(q in tag_item.lower() for tag_item in item.get("tags", []))
            ]
        if selected_tags:
            images = [
                item
                for item in images
                if selected_tags.issubset({tag_item.lower() for tag_item in item.get("tags", [])})
            ]
        self.send_json(200, {"images": images, "available_tags": available_tags})

    def handle_update_image(self, path: str) -> None:
        if not self.require_auth():
            return
        image_id = path.split("/")[3]
        body = parse_json_body(self)
        with DB_LOCK:
            db = get_db()
            for item in db["images"]:
                if item["id"] == image_id:
                    if "title" in body:
                        item["title"] = str(body.get("title", "")).strip()
                    if "tags" in body:
                        item["tags"] = normalize_tags(body.get("tags", []))
                    if "archived" in body:
                        item["archived"] = bool(body.get("archived"))
                    save_db(db)
                    self.send_json(200, {"image": item})
                    return
        self.send_error_json(404, "Not found")

    def handle_delete_image(self, path: str) -> None:
        if not self.require_auth():
            return
        image_id = path.split("/")[3]
        deleted_file = ""
        with DB_LOCK:
            db = get_db()
            kept_images = []
            for item in db["images"]:
                if item["id"] == image_id:
                    deleted_file = item.get("filename", "")
                    continue
                kept_images.append(item)
            if len(kept_images) == len(db["images"]):
                self.send_error_json(404, "Not found")
                return
            db["images"] = kept_images
            save_db(db)
        if deleted_file:
            file_path = (IMAGES_DIR / safe_filename(deleted_file)).resolve()
            if str(file_path).startswith(str(IMAGES_DIR.resolve())) and file_path.exists():
                file_path.unlink()
        self.send_json(200, {"ok": True})

    def handle_list_prompts(self) -> None:
        if not self.require_auth():
            return
        prompts = [
            item
            | {
                "reference_filename": item.get("reference_filename", ""),
                "reference_url": item.get("reference_url", ""),
            }
            for item in get_db()["prompts"]
        ]
        self.send_json(200, {"prompts": prompts})

    def handle_create_prompt(self) -> None:
        if not self.require_auth():
            return
        body = parse_request_body(self)
        text = str(body.get("prompt", "")).strip()
        if not text:
            self.send_error_json(400, "提示词不能为空")
            return
        reference = save_reference_image(normalize_single_file(body.get("reference_image"), "reference_image"))
        item = {
            "id": uuid.uuid4().hex,
            "title": str(body.get("title", "")).strip() or text[:28],
            "prompt": text,
            "tags": normalize_tags(body.get("tags", [])),
            "reference_filename": reference.get("filename", "") if reference else "",
            "reference_url": reference.get("url", "") if reference else "",
            "created_at": int(time.time()),
        }
        with DB_LOCK:
            db = get_db()
            db["prompts"].insert(0, item)
            save_db(db)
        self.send_json(201, {"prompt": item})

    def handle_update_prompt(self, path: str) -> None:
        if not self.require_auth():
            return
        prompt_id = path.split("/")[3]
        body = parse_request_body(self)
        new_reference = save_reference_image(normalize_single_file(body.get("reference_image"), "reference_image"))
        old_reference = ""
        with DB_LOCK:
            db = get_db()
            for item in db["prompts"]:
                if item["id"] == prompt_id:
                    if "title" in body:
                        item["title"] = str(body["title"]).strip() or item["title"]
                    if "prompt" in body:
                        item["prompt"] = str(body["prompt"]).strip() or item["prompt"]
                    if "tags" in body:
                        item["tags"] = normalize_tags(body["tags"])
                    if str(body.get("clear_reference", "")).lower() in {"1", "true", "yes", "on"} or new_reference:
                        old_reference = item.get("reference_filename", "")
                        item["reference_filename"] = ""
                        item["reference_url"] = ""
                    if new_reference:
                        item["reference_filename"] = new_reference["filename"]
                        item["reference_url"] = new_reference["url"]
                    save_db(db)
                    if old_reference:
                        delete_stored_image(old_reference)
                    self.send_json(200, {"prompt": item})
                    return
        if new_reference:
            delete_stored_image(new_reference.get("filename", ""))
        self.send_error_json(404, "Not found")

    def handle_delete_prompt(self, path: str) -> None:
        if not self.require_auth():
            return
        prompt_id = path.split("/")[3]
        deleted_reference = ""
        with DB_LOCK:
            db = get_db()
            before = len(db["prompts"])
            kept_prompts = []
            for item in db["prompts"]:
                if item["id"] == prompt_id:
                    deleted_reference = item.get("reference_filename", "")
                    continue
                kept_prompts.append(item)
            db["prompts"] = kept_prompts
            save_db(db)
        if deleted_reference:
            delete_stored_image(deleted_reference)
        self.send_json(200, {"ok": len(db["prompts"]) != before})


def normalize_tags(value: Any) -> list[str]:
    if isinstance(value, str):
        parts = re.split(r"[,，\s]+", value)
    elif isinstance(value, list):
        parts = [str(item) for item in value]
    else:
        parts = []
    return sorted({part.strip() for part in parts if part.strip()})


def normalize_size(values: dict[str, Any]) -> str:
    raw_size = str(values.get("size", "1024x1024")).strip()
    if raw_size == "custom":
        width = int(str(values.get("width", "1024")).strip() or "1024")
        height = int(str(values.get("height", "1024")).strip() or "1024")
        return f"{max(1, width)}x{max(1, height)}"
    if raw_size:
        return raw_size
    return "1024x1024"


def main() -> None:
    ensure_files()
    config = get_config()
    host = os.environ.get("HOST", "127.0.0.1")
    port = normalize_port(os.environ.get("PORT") or config.get("server_port", 7860))
    server = ThreadingHTTPServer((host, port), ImageGenHandler)
    print(f"ImageGenUI running at http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
