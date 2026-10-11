from uuid import uuid4

from fastapi import FastAPI, Request

from app.api.errors import install_exception_handlers
from app.api.examples import router as examples_router
from app.modules.a.router import router as a_router
from app.modules.b.router import router as b_router
from app.modules.c.router import router as c_router
from app.modules.d.router import router as d_router
from app.modules.tasks.router import router as tasks_router

app = FastAPI(
    title="GroupProof API",
    version="0.2.0",
    description="Modular API with a PostgreSQL project example and shared response contract.",
)


@app.middleware("http")
async def request_context(request: Request, call_next):
    request.state.request_id = str(uuid4())
    response = await call_next(request)
    response.headers["X-Request-Id"] = request.state.request_id
    return response


install_exception_handlers(app)


@app.get("/healthz", tags=["system"])
def healthz() -> dict[str, str]:
    return {"service": "api", "status": "ok"}


app.include_router(a_router)
app.include_router(b_router)
app.include_router(c_router)
app.include_router(d_router)
app.include_router(examples_router)
app.include_router(tasks_router)
