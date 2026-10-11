from fastapi import APIRouter

router = APIRouter(prefix="/api/c", tags=["c"])


@router.get("/ready", include_in_schema=False)
def ready() -> dict[str, str]:
    return {"module": "c", "status": "ready"}
