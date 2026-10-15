"""python -m fs_simulator --address 127.0.0.1:47808 --device 1001 --points 50 --control 127.0.0.1:8099

Control API (bound to localhost only):
  GET  /health
  GET  /points                      -> current state of every point
  POST /points/<n>   {"state": "alarm"|"pre-alarm"|"fault"|"supervisory"|"disabled"|"test-alarm"|"quiet"}
  POST /offline      {"offline": true|false}   (stop answering BACnet requests)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import re

from .panel import STATES, SimulatedPanel, create_panel

log = logging.getLogger("fs_simulator")


async def handle(panel: SimulatedPanel, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    status, body = 200, {}
    try:
        request_line = (await reader.readline()).decode("latin-1").strip()
        method, path, _ = request_line.split(" ", 2)
        length = 0
        while (line := (await reader.readline()).decode("latin-1").strip()) != "":
            k, _, v = line.partition(":")
            if k.lower() == "content-length":
                length = min(int(v.strip()), 10_000)
        payload = json.loads(await reader.readexactly(length)) if length else {}

        if method == "GET" and path == "/health":
            body = {"ok": True}
        elif method == "GET" and path == "/points":
            body = {
                "points": [
                    {"instance": o.objectIdentifier[1], "presentValue": str(o.presentValue), "eventState": str(o.eventState), "outOfService": bool(o.outOfService)}
                    for o in panel.points()
                ]
            }
        elif method == "POST" and (m := re.fullmatch(r"/points/(\d+)", path)):
            await panel.set_state(int(m[1]), str(payload.get("state")))
            body = {"ok": True}
        elif method == "POST" and path == "/offline":
            panel.offline = bool(payload.get("offline"))
            body = {"offline": panel.offline}
        else:
            status, body = 404, {"error": "not found"}
    except (KeyError, ValueError) as err:
        status, body = 400, {"error": str(err)}
    except Exception as err:  # noqa: BLE001
        status, body = 500, {"error": type(err).__name__}
    data = json.dumps(body).encode()
    reason = {200: "OK", 400: "Bad Request", 404: "Not Found"}.get(status, "Error")
    writer.write(f"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\nConnection: close\r\n\r\n".encode() + data)
    await writer.drain()
    writer.close()


async def main() -> None:
    ap = argparse.ArgumentParser(description="BACnet fire panel simulator (development only)")
    ap.add_argument("--address", default="127.0.0.1:47808")
    ap.add_argument("--device", type=int, default=1001)
    ap.add_argument("--points", type=int, default=50)
    ap.add_argument("--notify", action="append", default=[], help="recipient address for event notifications")
    ap.add_argument("--control", default="127.0.0.1:8099", help="localhost control API host:port")
    ap.add_argument("--page-size", type=int, default=25)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    host, port = args.control.rsplit(":", 1)
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("control API must bind to localhost")
    panel = create_panel(args.address, args.device, args.points, args.notify)
    panel.page_size = args.page_size
    server = await asyncio.start_server(lambda r, w: handle(panel, r, w), host, int(port))
    log.info("simulator device %s on %s, %s points, states=%s, control http://%s", args.device, args.address, args.points, list(STATES), args.control)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
