from fastapi import FastAPI

from app.modules.a.router import router as a_router
from app.modules.b.router import router as b_router
from app.modules.c.router import router as c_router
from app.modules.d.router import router as d_router

app = FastAPI(
    title="GroupProof API",
    version="0.1.0",
    description="A1 runtime skeleton; business modules are added in A2 and later.",
)


@app.get("/healthz", tags=["system"])
def healthz() -> dict[str, str]:
    return {"service": "api", "status": "ok"}


app.include_router(a_router)
app.include_router(b_router)
app.include_router(c_router)
app.include_router(d_router)
