from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .api.v1.api import api_router

app = FastAPI(
    title="NexusLineage Graph API",
    description="Backend service for billion-node graph metadata and lineage.",
    version="0.1.0"
)

# CORS Configuration
origins = [
    "http://localhost:3000",
    "http://localhost:5173", # Vite default
    "*"
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API Router
app.include_router(api_router, prefix="/api/v1")

@app.middleware("http")
async def add_process_time_header(request: "Request", call_next):
    from fastapi import Request
    import time
    start_time = time.time()
    response = await call_next(request)
    process_time = time.time() - start_time
    response.headers["X-Process-Time"] = str(process_time)
    print(f"Path: {request.url.path} | Method: {request.method} | Time: {process_time:.4f}s")
    return response

@app.get("/health")
async def health_check():
    return {"status": "ok"}
