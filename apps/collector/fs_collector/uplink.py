"""HTTPS uplink to the server. Synchronous urllib run in a thread (no extra dependencies)."""

from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.request
from typing import Any


class UplinkError(Exception):
    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow redirects: they could forward the bearer token elsewhere or downgrade to http."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ARG002
        raise urllib.error.HTTPError(req.full_url, code, "redirects are not allowed", headers, fp)


class Uplink:
    def __init__(self, server_url: str, token: str, ca_file: str | None, timeout: float = 15.0) -> None:
        self._url = f"{server_url}/ingest/v1/batch"
        self._token = token
        self._timeout = timeout
        ctx = ssl.create_default_context(cafile=ca_file) if server_url.startswith("https://") else None
        handlers: list[urllib.request.BaseHandler] = [_NoRedirect()]
        if ctx is not None:
            handlers.append(urllib.request.HTTPSHandler(context=ctx))
        self._opener = urllib.request.build_opener(*handlers)

    def send(self, batch: dict[str, Any]) -> int:
        """Posts a batch and returns the server's ackedSeq."""
        body = json.dumps(batch, separators=(",", ":")).encode()
        req = urllib.request.Request(
            self._url,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
                "User-Agent": "fs-collector",
            },
        )
        try:
            with self._opener.open(req, timeout=self._timeout) as res:  # noqa: S310 - URL is validated config
                data = json.loads(res.read(65_536))
                return int(data["ackedSeq"])
        except urllib.error.HTTPError as err:
            # 4xx (except 408/429) will not succeed on retry without operator action.
            retryable = err.code >= 500 or err.code in (408, 429)
            raise UplinkError(f"server responded {err.code}", retryable=retryable) from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError) as err:
            raise UplinkError(f"uplink failed: {type(err).__name__}", retryable=True) from None
