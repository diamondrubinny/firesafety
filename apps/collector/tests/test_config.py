import pytest

from fs_collector.config import ConfigError, load_config, parse_panels

BASE = {
    "FS_SERVER_URL": "https://fs.campus.example",
    "FS_COLLECTOR_TOKEN": "fsc_" + "A" * 43,
    "FS_BACNET_ADDRESS": "10.0.0.20/24:47808",
    "FS_BACNET_DEVICE_ID": "4000001",
    "FS_PANELS": "1001@10.0.0.5, 1002@10.0.0.6:47808",
}


def test_valid_config_and_redaction():
    cfg = load_config(BASE)
    assert [p.instance for p in cfg.panels] == [1001, 1002]
    assert cfg.redacted()["token"] == "***"
    assert BASE["FS_COLLECTOR_TOKEN"] not in repr(cfg.redacted())


@pytest.mark.parametrize(
    "override, message",
    [
        ({"FS_SERVER_URL": "http://fs.campus.example"}, "https"),
        ({"FS_COLLECTOR_TOKEN": "secret"}, "invalid format"),
        ({"FS_PANELS": ""}, "required"),
        ({"FS_PANELS": "abc"}, "<instance>@<address>"),
        ({"FS_PANELS": "1@a,1@b"}, "duplicate"),
        ({"FS_POLL_INTERVAL": "0.1"}, "between"),
        ({"FS_BACNET_DEVICE_ID": ""}, "FS_BACNET_DEVICE_ID"),
    ],
)
def test_invalid_config(override, message):
    with pytest.raises(ConfigError, match=message):
        load_config({**BASE, **override})


def test_insecure_http_only_with_explicit_flag():
    cfg = load_config({**BASE, "FS_SERVER_URL": "http://localhost:3000", "FS_ALLOW_INSECURE_HTTP": "1"})
    assert cfg.server_url == "http://localhost:3000"


def test_config_errors_do_not_echo_token():
    with pytest.raises(ConfigError) as err:
        load_config({**BASE, "FS_COLLECTOR_TOKEN": "fsc_short-secret"})
    assert "short-secret" not in str(err.value)


def test_parse_panels_range():
    with pytest.raises(ConfigError):
        parse_panels("4194303@1.2.3.4")
