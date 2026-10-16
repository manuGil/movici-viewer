from __future__ import annotations

import typing as t

from pydantic import BaseModel, ConfigDict


class DatasetCollection(BaseModel):
    datasets: t.List[Dataset]


class Dataset(BaseModel):
    uuid: str
    name: str
    display_name: str
    type: str
    format: str
    has_data: bool
    general: dict | None = None
    epsg_code: int | None = None


class DatasetWithData(Dataset):
    general: t.Optional[dict]
    data: dict
    bounding_box: t.Optional[t.List[float]] = None


class DatasetCreate(BaseModel):
    """A new, empty entity-based dataset, stored as `<name>.json` in the movici data
    format. `name` is snake_cased into the file/dataset name; the original spelling
    becomes the display name unless one is given explicitly.

    The dataset starts without entity groups: groups and their entities are added
    afterwards through PATCH (see DatasetPatch), which creates a group on the fly
    when every row for it is a `-1` create placeholder."""

    name: str
    display_name: t.Optional[str] = None
    type: str = "custom"
    # default to the Dutch grid (RD New, EPSG:28992)
    epsg_code: int = 28992
    general: t.Optional[dict] = None


class PatchEntityGroup(BaseModel):
    """One entity group of a patch, mirroring flow-lib's `PatchEntityGroupData`.

    Every column is positional against `id`: `deleted[i]` and `<attribute>[i]` both
    describe the entity `id[i]`, so all columns must be exactly as long as `id`.
    Attribute names are arbitrary, so they arrive as extras rather than declared
    fields."""

    model_config = ConfigDict(extra="allow")

    id: t.List[int]
    deleted: t.Optional[t.List[bool]] = None

    @property
    def attributes(self) -> t.Dict[str, t.Any]:
        return self.model_extra or {}
    
    def columns(self) -> t.Iterator[t.Tuple[str, t.Any]]:
        if self.deleted is not None:
            yield "deleted", self.deleted
        yield from self.attributes.items()


class DatasetPatch(BaseModel):
    """
    Ids already present in the dataset are updated in place, unknown ids are appended
    as new entities, and entities whose `deleted` flag is set are removed.

    `nulls_overwrite` decides how a null in an attribute column is read. By default a
    null is a hole, meaning "this entity did not change this attribute" -- that is what
    lets the editor pad a column to the full length of `id` when only some of the
    listed entities changed it. When true, nulls are written through and clear the
    stored value."""

    nulls_overwrite: bool = False
    data: t.Dict[str, PatchEntityGroup]


DatasetCollection.model_rebuild()
