import os
import signal
from threading import Event

from redis import Redis
from redis.exceptions import RedisError


def run() -> None:
    stop = Event()
    for signal_name in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signal_name, lambda *_args: stop.set())

    redis_client = Redis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379/0"))
    while not stop.wait(5):
        try:
            redis_client.ping()
        except RedisError:
            # A2 will add a queue and retry policy. The A1 process stays alive
            # so Compose can start the full stack while Redis is restarting.
            continue


if __name__ == "__main__":
    run()
