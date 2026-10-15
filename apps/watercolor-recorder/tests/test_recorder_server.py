import gzip
import json
import socket
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

APP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_DIR))
import recorder_server as rs  # noqa: E402

pytestmark = pytest.mark.unit

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32
PAGE = """<html><head><title> 手作水彩 </title>
<meta property="og:image" content="/cover.png">
<meta name="twitter:image" content="https://cdn.example.com/a.jpg">
</head><body>
<img src="/cover.png"><img src="data:image/png;base64,AAAA"><img data-src="b.png">
<video src="/clip.mp4"></video><video><source src="alt.webm" type="video/webm"></video>
</body></html>"""


class _Remote(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _reply(self, content_type, body, status=200, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        routes = {
            "/page": ("text/html; charset=utf-8", PAGE.encode()),
            "/empty": ("text/html", b"<html><body>nothing</body></html>"),
            "/cover.png": ("image/png", PNG),
            "/clip.mp4": ("video/mp4", b"\x00\x00\x00\x18ftypmp42"),
            "/data.json": ("application/json", b"{}"),
        }
        if self.path in ("/gzpage", "/gzbomb"):
            raw = PAGE.encode() if self.path == "/gzpage" else b"<html>" + b"a" * 5_000_000
            self._reply("text/html", gzip.compress(raw), headers={"Content-Encoding": "gzip"})
            return
        if self.path == "/redirect":
            self._reply("text/plain", b"", 302, {"Location": "/cover.png"})
        elif self.path in routes:
            self._reply(*routes[self.path])
        else:
            self._reply("text/plain", b"nope", 404)


@pytest.fixture()
def remote(monkeypatch):
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Remote)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setattr(rs, "assert_public_url", lambda url: None)
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


@pytest.fixture()
def app():
    server = ThreadingHTTPServer(("127.0.0.1", 0), rs.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


def _get(url):
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            return resp.status, resp.headers, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers, exc.read()


def test_public_ip_classification():
    assert rs._is_public_ip("8.8.8.8")
    for blocked in ("127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "::1", "172.16.0.1", "0.0.0.0"):
        assert not rs._is_public_ip(blocked), blocked


def test_assert_public_url_rejects_unsafe_targets(monkeypatch):
    for url in ("file:///etc/passwd", "ftp://example.com/a", "http:///nohost"):
        with pytest.raises(rs.FetchError):
            rs.assert_public_url(url)

    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("127.0.0.1", 80))])
    with pytest.raises(rs.FetchError) as exc:
        rs.assert_public_url("http://localhost.example/")
    assert exc.value.status == 403

    monkeypatch.setattr(
        socket, "getaddrinfo",
        lambda *a, **k: [(2, 1, 6, "", ("8.8.8.8", 80)), (2, 1, 6, "", ("10.0.0.1", 80))],
    )
    with pytest.raises(rs.FetchError):
        rs.assert_public_url("http://mixed.example/")

    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("93.184.216.34", 80))])
    rs.assert_public_url("http://example.com/")


def test_scan_page_collects_absolute_deduped_candidates():
    page = rs.scan_page(PAGE, "http://site.test/dir/page")
    assert page["title"] == "手作水彩"
    assert page["images"] == [
        "http://site.test/cover.png",
        "https://cdn.example.com/a.jpg",
        "http://site.test/dir/b.png",
    ]
    assert page["videos"] == ["http://site.test/clip.mp4", "http://site.test/dir/alt.webm"]


def test_resolve_direct_image_and_video(remote):
    assert rs.resolve_link(f"{remote}/cover.png") == {"kind": "image", "url": f"{remote}/cover.png"}
    assert rs.resolve_link(f"{remote}/clip.mp4")["kind"] == "video"


def test_resolve_follows_redirect(remote):
    assert rs.resolve_link(f"{remote}/redirect") == {"kind": "image", "url": f"{remote}/cover.png"}


def test_resolve_page_lists_candidates(remote):
    result = rs.resolve_link(f"{remote}/page")
    assert result["kind"] == "page"
    assert f"{remote}/cover.png" in result["images"]
    assert f"{remote}/clip.mp4" in result["videos"]


def test_resolve_decodes_gzip_page(remote):
    result = rs.resolve_link(f"{remote}/gzpage")
    assert result["kind"] == "page" and f"{remote}/cover.png" in result["images"]


def test_gzip_expansion_is_bounded(remote, monkeypatch):
    monkeypatch.setattr(rs, "MAX_HTML_BYTES", 1024)
    with pytest.raises(rs.FetchError) as exc:
        rs.resolve_link(f"{remote}/gzbomb")
    assert exc.value.status == 422


def test_resolve_errors(remote):
    with pytest.raises(rs.FetchError) as empty:
        rs.resolve_link(f"{remote}/empty")
    assert empty.value.status == 422
    with pytest.raises(rs.FetchError) as other:
        rs.resolve_link(f"{remote}/data.json")
    assert other.value.status == 415
    with pytest.raises(rs.FetchError):
        rs.resolve_link(f"{remote}/missing")


def test_redirect_hops_are_revalidated(monkeypatch, remote):
    seen = []

    def guard(url):
        seen.append(url)

    monkeypatch.setattr(rs, "assert_public_url", guard)
    rs.resolve_link(f"{remote}/redirect")
    assert seen == [f"{remote}/redirect", f"{remote}/cover.png"]


def test_api_proxy_streams_image_and_rejects_non_media(remote, app):
    from urllib.parse import quote

    status, headers, body = _get(f"{app}/api/proxy?url={quote(remote + '/cover.png')}")
    assert status == 200 and headers["Content-Type"] == "image/png" and body == PNG

    status, _, body = _get(f"{app}/api/proxy?url={quote(remote + '/data.json')}")
    assert status == 415 and "error" in json.loads(body)


def test_api_proxy_enforces_size_limit(remote, app, monkeypatch):
    from urllib.parse import quote

    monkeypatch.setattr(rs, "MAX_IMAGE_BYTES", 8)
    status, _, body = _get(f"{app}/api/proxy?url={quote(remote + '/cover.png')}")
    assert status == 413 and "error" in json.loads(body)


def test_api_blocks_internal_addresses_without_patching(app):
    from urllib.parse import quote

    status, _, body = _get(f"{app}/api/resolve?url={quote('http://127.0.0.1:1/x')}")
    assert status == 403
    assert "内网" in json.loads(body)["error"]
    assert _get(f"{app}/api/resolve")[0] == 400


def test_static_serving_and_path_traversal(app):
    status, headers, body = _get(f"{app}/")
    assert status == 200 and "text/html" in headers["Content-Type"] and b"<html" in body
    status, headers, _ = _get(f"{app}/engine.js")
    assert status == 200 and "javascript" in headers["Content-Type"]
    assert _get(f"{app}/nope.js")[0] == 404
    assert rs.safe_static_path("/../recorder_server.py") is None
    assert rs.safe_static_path("/%2e%2e/recorder_server.py") is None
