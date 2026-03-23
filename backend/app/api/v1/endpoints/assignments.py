from fastapi import APIRouter, Body, HTTPException
from backend.app.models.assignment import LayerAssignmentRequest, LayerAssignmentResult
from backend.app.services.assignment_engine import assignment_engine

router = APIRouter()

@router.post("/compute", response_model=LayerAssignmentResult)
async def compute_assignments(
    request: LayerAssignmentRequest = Body(..., embed=False)
):
    """
    Compute layer assignments for the graph based on the provided configuration.
    This replaces the client-side useLayerAssignment hook.
    """
    try:
        return await assignment_engine.compute_assignments(request)
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
