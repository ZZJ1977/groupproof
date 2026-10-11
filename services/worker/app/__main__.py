def run() -> None:
    """Start the Celery consumer used by the Compose worker service."""

    from .celery_app import celery_app

    celery_app.worker_main(["worker", "--loglevel=INFO"])


if __name__ == "__main__":
    run()
