from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse

from .. import dependencies
from ..model.model import Repository
from ..schemas.dataset import Dataset, DatasetCollection, DatasetCreate, DatasetPatch
from ..schemas.summary import DatasetSummary

dataset_router = APIRouter(prefix="/datasets")


@dataset_router.get("/", response_model=DatasetCollection)
def list_datasets(repository: Repository = Depends(dependencies.repository)):
    return {"datasets": repository.get_datasets()}


@dataset_router.post("/", response_model=Dataset, status_code=201)
def add_dataset(
    payload: DatasetCreate,
    repository: Repository = Depends(dependencies.repository),
):
    return repository.add_dataset(payload)


@dataset_router.get("/{uuid}", response_model=Dataset)
def get_dataset(uuid: str, repository: Repository = Depends(dependencies.repository)):
    return repository.get_dataset(uuid)


@dataset_router.get("/{uuid}/data")
def get_dataset_data(uuid: str, repository: Repository = Depends(dependencies.repository)):
    # The dataset file is mutable (PATCH below): forbid browser caching, otherwise
    # heuristic freshness (FileResponse sends Last-Modified but no Cache-Control)
    # makes the client re-read pre-edit data from its disk cache after saving
    return FileResponse(repository.get_dataset_data(uuid), headers={"Cache-Control": "no-store"})


@dataset_router.patch("/{uuid}")
def patch_dataset(
    uuid: str,
    payload: DatasetPatch,
    repository: Repository = Depends(dependencies.repository),
):
    repository.patch_dataset(uuid, payload)
    return {"result": "ok", "message": "dataset updated", "dataset_uuid": uuid}


@dataset_router.get("/{uuid}/summary", response_model=DatasetSummary)
def get_dataset_summary(uuid: str, repository: Repository = Depends(dependencies.repository)):
    return repository.get_dataset_summary(uuid)
