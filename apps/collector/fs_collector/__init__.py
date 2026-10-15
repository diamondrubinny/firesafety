"""Read-only BACnet/IP collector for fire alarm panels.

This package must never send any BACnet service that changes state on a
panel; tests/test_readonly.py enforces this with a list of forbidden services.
"""

__version__ = "0.2.0"
