import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from fs_collector.uplink import Uplink, UplinkError


class Handler(BaseHTTPRequestHandler):
    status = 200
    seen: list = []

    def do_POST(self):  # noqa: N802
        if self.path.startswith("/redirect"):
            self.send_response(307)
            self.send_header("Location", "http://127.0.0.1:9/steal")
            self.end_headers()
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Handler.seen.append((self.path, self.headers["Authorization"], body))
        self.send_response(Handler.status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ackedSeq": 42}).encode())

    def log_message(self, *args):
        pass


@pytest.fixture()
def server():
    srv = HTTPServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


def test_send_success(server):
    Handler.status, Handler.seen = 200, []
    up = Uplink(server, "fsc_" + "x" * 30, None)
    assert up.send({"hello": 1}) == 42
    path, auth, body = Handler.seen[0]
    assert path == "/ingest/v1/batch" and auth == "Bearer fsc_" + "x" * 30 and body == {"hello": 1}


@pytest.mark.parametrize("status, retryable", [(401, False), (400, False), (429, True), (503, True)])
def test_send_errors(server, status, retryable):
    Handler.status = status
    with pytest.raises(UplinkError) as err:
        Uplink(server, "fsc_" + "x" * 30, None).send({})
    assert err.value.retryable is retryable
    assert "fsc_" not in str(err.value)


def test_unreachable_is_retryable():
    with pytest.raises(UplinkError) as err:
        Uplink("http://127.0.0.1:9", "fsc_" + "x" * 30, None, timeout=1).send({})
    assert err.value.retryable


def test_redirects_are_never_followed(server):
    Handler.seen = []
    with pytest.raises(UplinkError) as err:
        Uplink(f"{server}/redirect", "fsc_" + "x" * 30, None).send({"a": 1})
    assert err.value.retryable is False
    assert Handler.seen == []  # the token was not re-sent anywhere
