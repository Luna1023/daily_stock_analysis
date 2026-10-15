#!/usr/bin/env python3
"""水彩配色记录器的本地服务：托管静态页面，并为「链接」输入提供解析与媒体代理。

仅使用标准库。默认只监听 127.0.0.1。

接口：
  GET /api/resolve?url=...  判断链接是图片 / 视频 / 网页，网页会列出候选图片与视频
  GET /api/proxy?url=...    以同源方式转发图片或视频字节，让浏览器能读取像素
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import mimetypes
import socket
import urllib.error
import urllib.request
import zlib
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlparse

WEB_DIR = Path(__file__).resolve().parent / "web"
USER_AGENT = "Mozilla/5.0 (compatible; WatercolorRecorder/1.0)"
FETCH_TIMEOUT = 15
MAX_HTML_BYTES = 2 * 1024 * 1024
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_VIDEO_BYTES = 80 * 1024 * 1024
MAX_REDIRECTS = 5
MAX_CANDIDATES = 24


class FetchError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _is_public_ip(value: str) -> bool:
    try:
        return ipaddress.ip_address(value.split("%")[0]).is_global
    except ValueError:
        return False


def assert_public_url(url: str) -> None:
    """拒绝非 http(s) 链接，以及解析到内网、回环、链路本地地址的主机（SSRF 防护）。"""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise FetchError("只支持 http / https 链接")
    try:
        infos = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror as exc:
        raise FetchError(f"无法解析域名: {parsed.hostname}") from exc
    addresses = {info[4][0] for info in infos}
    if not addresses or not all(_is_public_ip(addr) for addr in addresses):
        raise FetchError("出于安全考虑，不允许访问内网或本机地址", 403)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def open_url(url: str):
    """打开远程链接；每一跳重定向都重新做地址校验。返回 (response, final_url)。"""
    for _ in range(MAX_REDIRECTS + 1):
        assert_public_url(url)
        request = urllib.request.Request(
            url, headers={"User-Agent": USER_AGENT, "Accept": "*/*", "Accept-Encoding": "identity"}
        )
        try:
            return _opener.open(request, timeout=FETCH_TIMEOUT), url
        except urllib.error.HTTPError as exc:
            if exc.code in (301, 302, 303, 307, 308) and exc.headers.get("Location"):
                url = urljoin(url, exc.headers["Location"])
                continue
            raise FetchError(f"远程服务器返回 {exc.code}", 502) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise FetchError(f"无法访问该链接: {getattr(exc, 'reason', exc)}", 502) from exc
    raise FetchError("重定向次数过多", 502)


def read_limited(response, limit: int) -> bytes:
    """读取至多 limit 字节（解压后计）；个别服务器忽略 identity 仍返回 gzip/deflate，这里兜底解压。"""
    encoding = (response.headers.get("Content-Encoding") or "identity").lower()
    if encoding in ("", "identity"):
        return response.read(limit + 1)
    if encoding not in ("gzip", "x-gzip", "deflate"):
        raise FetchError(f"不支持的内容编码: {encoding}", 415)
    decoder = zlib.decompressobj(31 if "gzip" in encoding else 15)
    out = bytearray()
    while len(out) <= limit:
        chunk = response.read(64 * 1024)
        if not chunk:
            break
        try:
            out += decoder.decompress(chunk, limit + 1 - len(out))
        except zlib.error as exc:
            raise FetchError("远程内容解压失败", 502) from exc
    return bytes(out)


def _kind_of(content_type: str) -> str:
    main = content_type.split(";")[0].strip().lower()
    if main.startswith("image/"):
        return "image"
    if main.startswith("video/"):
        return "video"
    if main in ("text/html", "application/xhtml+xml"):
        return "page"
    return "other"


class _PageScanner(HTMLParser):
    """从网页中收集 og:image / og:video / <img> / <video> 候选。"""

    def __init__(self, base_url: str):
        super().__init__(convert_charrefs=True)
        self.base = base_url
        self.title = ""
        self._in_title = False
        self.meta_images: list[str] = []
        self.meta_videos: list[str] = []
        self.images: list[str] = []
        self.videos: list[str] = []

    def _abs(self, value: str | None) -> str | None:
        if not value or value.startswith(("data:", "javascript:", "blob:")):
            return None
        absolute = urljoin(self.base, value.strip())
        return absolute if urlparse(absolute).scheme in ("http", "https") else None

    def handle_starttag(self, tag, attrs):
        a = {k: v for k, v in attrs if v is not None}
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            target = self._abs(a.get("content"))
            if not target:
                return
            if key in ("og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"):
                self.meta_images.append(target)
            elif key in ("og:video", "og:video:url", "og:video:secure_url", "twitter:player:stream"):
                self.meta_videos.append(target)
        elif tag == "img":
            target = self._abs(a.get("src") or a.get("data-src") or a.get("data-original"))
            if target:
                self.images.append(target)
        elif tag in ("video", "source"):
            target = self._abs(a.get("src"))
            if target and (tag == "video" or (a.get("type") or "").startswith("video/")):
                self.videos.append(target)

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data


def _dedupe(urls: list[str], limit: int) -> list[str]:
    seen: dict[str, None] = {}
    for url in urls:
        seen.setdefault(url, None)
    return list(seen)[:limit]


def scan_page(html: str, base_url: str) -> dict:
    scanner = _PageScanner(base_url)
    scanner.feed(html)
    return {
        "title": scanner.title.strip()[:200],
        "images": _dedupe(scanner.meta_images + scanner.images, MAX_CANDIDATES),
        "videos": _dedupe(scanner.meta_videos + scanner.videos, MAX_CANDIDATES),
    }


def resolve_link(url: str) -> dict:
    response, final_url = open_url(url)
    with response:
        content_type = response.headers.get("Content-Type", "")
        kind = _kind_of(content_type)
        if kind in ("image", "video"):
            return {"kind": kind, "url": final_url}
        if kind != "page":
            raise FetchError(f"不支持的内容类型: {content_type or '未知'}", 415)
        raw = read_limited(response, MAX_HTML_BYTES)[:MAX_HTML_BYTES]
        charset = response.headers.get_content_charset() or "utf-8"
    page = scan_page(raw.decode(charset, errors="replace"), final_url)
    if not page["images"] and not page["videos"]:
        raise FetchError(
            "网页里没有找到可直接读取的图片或视频（视频平台页面通常无法直接解析，请下载后上传文件，或截图）", 422
        )
    return {"kind": "page", "url": final_url, **page}


def safe_static_path(request_path: str) -> Path | None:
    relative = request_path.split("?", 1)[0].lstrip("/") or "index.html"
    candidate = (WEB_DIR / relative).resolve()
    if WEB_DIR not in candidate.parents or not candidate.is_file():
        return None
    return candidate


class Handler(BaseHTTPRequestHandler):
    server_version = "WatercolorRecorder/1.0"

    def log_message(self, fmt, *args):  # noqa: D401 - 保持终端输出简洁
        pass

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _query_url(self) -> str:
        values = parse_qs(urlparse(self.path).query).get("url", [])
        if not values or not values[0].strip():
            raise FetchError("缺少 url 参数")
        return values[0].strip()

    def do_GET(self):  # noqa: N802
        route = urlparse(self.path).path
        try:
            if route == "/api/resolve":
                self._send_json(resolve_link(self._query_url()))
            elif route == "/api/proxy":
                self._proxy(self._query_url())
            else:
                self._static(route)
        except FetchError as exc:
            self._send_json({"error": str(exc)}, exc.status)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _static(self, route: str) -> None:
        path = safe_static_path(route)
        if path is None:
            self._send_json({"error": "Not Found"}, 404)
            return
        body = path.read_bytes()
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix == ".js":
            mime = "text/javascript"
        self.send_response(200)
        self.send_header("Content-Type", f"{mime}; charset=utf-8" if mime.startswith("text/") else mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _proxy(self, url: str) -> None:
        response, _ = open_url(url)
        with response:
            content_type = response.headers.get("Content-Type", "")
            kind = _kind_of(content_type)
            if kind not in ("image", "video"):
                raise FetchError("该链接不是图片或视频", 415)
            limit = MAX_IMAGE_BYTES if kind == "image" else MAX_VIDEO_BYTES
            declared = response.headers.get("Content-Length")
            if declared and declared.isdigit() and int(declared) > limit:
                raise FetchError(f"文件过大（上限 {limit // 1024 // 1024}MB），请下载后上传", 413)
            body = read_limited(response, limit)
        if len(body) > limit:
            raise FetchError(f"文件过大（上限 {limit // 1024 // 1024}MB），请下载后上传", 413)
        self.send_response(200)
        self.send_header("Content-Type", content_type.split(";")[0].strip())
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser(description="水彩配色记录器")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认仅本机访问")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"水彩配色记录器已启动: http://{args.host}:{args.port}  (Ctrl+C 退出)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
