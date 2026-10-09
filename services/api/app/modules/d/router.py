from fastapi import APIRouter

router = APIRouter(prefix="/api/d", tags=["d"])


@router.get("/ready", include_in_schema=False)
def ready() -> dict[str, str]:
    return {"module": "d", "status": "ready"}
