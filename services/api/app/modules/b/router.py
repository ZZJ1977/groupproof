from fastapi import APIRouter

router = APIRouter(prefix="/api/b", tags=["b"])


@router.get("/ready", include_in_schema=False)
def ready() -> dict[str, str]:
    return {"module": "b", "status": "ready"}
