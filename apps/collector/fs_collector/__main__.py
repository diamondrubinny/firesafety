"""Entry point: python -m fs_collector (configuration via environment variables)."""

from __future__ import annotations

import asyncio
import logging
import signal
import sys

from .bacnet import PanelClient, create_application
from .config import ConfigError, load_config
from .outbox import Outbox
from .service import Collector
from .uplink import Uplink


async def main() -> int:
    try:
        config = load_config()
    except ConfigError as err:
        print(f"configuration error: {err}", file=sys.stderr)
        return 2
    logging.basicConfig(level=config.log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    log = logging.getLogger("fs_collector")
    log.info("starting (read-only) %s", config.redacted())

    app = create_application(config.bacnet_address, config.bacnet_device_id)
    clients = {t.instance: PanelClient(app, t.address, t.instance, config.request_timeout) for t in config.panels}
    outbox = Outbox(config.outbox_path)
    collector = Collector(config, clients, outbox, Uplink(config.server_url, config.token, config.ca_file))
    app.on_notification = collector.on_notification

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, collector.stop)
    try:
        await collector.run()
    finally:
        app.close()
        outbox.close()
        log.info("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
