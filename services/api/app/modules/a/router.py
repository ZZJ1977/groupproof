from fastapi import APIRouter

router = APIRouter(prefix="/api/a", tags=["a"])


@router.get("/ready", include_in_schema=False)
def ready() -> dict[str, str]:
    return {"module": "a", "status": "ready"}
