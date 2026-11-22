"""Run D's daily risk checks once per local day (also usable as a one-shot job)."""

import argparse
import logging
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app.db.session import SessionLocal
from app.modules.d.risk_checks import run_daily_risk_checks

log = logging.getLogger(__name__)


def run_once() -> int:
    with SessionLocal() as session:
        return run_daily_risk_checks(session)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--loop", action="store_true", help="Run every day at 01:00 Asia/Shanghai")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    if not args.loop:
        log.info("Created %s risks", run_once())
        return
    zone = ZoneInfo("Asia/Shanghai")
    while True:
        now = datetime.now(zone)
        next_run = (now + timedelta(days=1)).replace(hour=1, minute=0, second=0, microsecond=0)
        time.sleep(max(1, (next_run - now).total_seconds()))
        try:
            log.info("Created %s risks", run_once())
        except Exception:
            log.exception("Daily risk check failed; will retry next run")


if __name__ == "__main__":
    main()
