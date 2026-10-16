import functools
import json
import shutil

import pytest


def test_get_datasets(get_with_status):
    response = get_with_status("/datasets/", 200)
    assert {ds["name"] for ds in response.json()["datasets"]} == {
        "road_network",
        "antennas",
        "heightmap",
    }


def test_get_single_dataset(get_with_status):
    response = get_with_status("/datasets/road_network", 200)
    assert response.json() == {
        "name": "road_network",
        "uuid": "road_network",
        "display_name": "Roads",
        "type": "transport_network",
        "format": "entity_based",
        "has_data": True,
        "general": {"enum": {"label": ["highway", "regular"]}},
        "epsg_code": 28992,
    }


def test_get_binary_dataset_data(get_with_status):
    response = get_with_status("/datasets/heightmap/data", 200)
    assert b"heightmap_info" in response.content


def test_get_dataset_with_data(get_with_status):
    response = get_with_status("/datasets/road_network/data", 200)
    assert response.json().keys() == {
        "name",
        "display_name",
        "type",
        "format",
        "bounding_box",
        "epsg_code",
        "created_on",
        "last_modified",
        "version",
        "general",
        "data",
    }
    assert "road_segment_entities" in response.json()["data"]


def test_get_datasets_data_ignores_query_parameters(get_with_status):
    response = get_with_status("/datasets/road_network/data?entity_group=some_entities", 200)
    assert "road_segment_entities" in response.json()["data"]


def test_dataset_data_is_not_browser_cacheable(get_with_status):
    response = get_with_status("/datasets/road_network/data", 200)
    assert response.headers["cache-control"] == "no-store"


def test_dataset_summary(get_with_status):
    response = get_with_status("/datasets/antennas/summary", 200)
    assert response.json() == {
        "count": 2,
        "general": {"enum": {"power_source": ["electricity_net", "battery", "no_power"]}},
        "entity_groups": [
            {
                "name": "antenna_entities",
                "count": 2,
                "properties": [
                    {
                        "component": None,
                        "name": "id",
                        "data_type": "INT",
                        "description": "",
                        "enum_name": None,
                        "unit": "",
                        "min_val": 0,
                        "max_val": 1,
                    },
                    {
                        "component": None,
                        "name": "geometry.x",
                        "data_type": "DOUBLE",
                        "description": "",
                        "enum_name": None,
                        "unit": "",
                        "min_val": 81017.0,
                        "max_val": 81758.0,
                    },
                    {
                        "component": None,
                        "name": "geometry.y",
                        "data_type": "DOUBLE",
                        "description": "",
                        "enum_name": None,
                        "unit": "",
                        "min_val": 454993.0,
                        "max_val": 455843.0,
                    },
                    {
                        "component": None,
                        "name": "operational.power_source",
                        "data_type": "INT",
                        "description": "",
                        "enum_name": "power_source",
                        "unit": "",
                        "min_val": 0.0,
                        "max_val": 1.0,
                    },
                ],
            }
        ],
    }


class TestPatchDataset:
    @pytest.fixture
    def data_dir(self, base_data_dir, tmp_path):
        """PATCH writes to disk: run against a copy so the shared fixtures stay pristine"""
        target = tmp_path / "data"
        shutil.copytree(base_data_dir, target)
        return target

    @pytest.fixture
    def patch_with_status(self, request_with_status):
        return functools.partial(request_with_status, "patch")

    @pytest.fixture
    def dataset_file(self, data_dir):
        return data_dir / "init_data" / "antennas.json"

    def read_group(self, dataset_file):
        return json.loads(dataset_file.read_bytes())["data"]["antenna_entities"]

    def test_patch_updates_property(self, patch_with_status, dataset_file):
        response = patch_with_status(
            "/datasets/antennas",
            200,
            json={"data": {"antenna_entities": {"id": [1], "operational.power_source": [2]}}},
        )
        assert response.json()["result"] == "ok"
        group = self.read_group(dataset_file)
        assert group["operational.power_source"] == [0, 2]
        assert group["geometry.x"] == [81758.0, 81017.0]  # untouched

    def test_patch_updates_geometry(self, patch_with_status, dataset_file):
        patch_with_status(
            "/datasets/antennas",
            200,
            json={
                "data": {
                    "antenna_entities": {"id": [0], "geometry.x": [82000.0], "geometry.y": [456000.0]}
                }
            },
        )
        group = self.read_group(dataset_file)
        assert group["geometry.x"] == [82000.0, 81017.0]
        assert group["geometry.y"] == [456000.0, 455843.0]

    def test_patch_adds_new_entity_with_null_padding(self, patch_with_status, dataset_file):
        patch_with_status(
            "/datasets/antennas",
            200,
            json={
                "data": {
                    "antenna_entities": {"id": [5], "geometry.x": [80000.0], "geometry.y": [455000.0]}
                }
            },
        )
        group = self.read_group(dataset_file)
        assert group["id"] == [0, 1, 5]
        assert group["geometry.x"] == [81758.0, 81017.0, 80000.0]
        assert group["operational.power_source"] == [0, 1, None]

    def test_patch_assigns_fresh_ids_to_placeholder_entities(self, patch_with_status, dataset_file):
        patch_with_status(
            "/datasets/antennas",
            200,
            json={
                "data": {
                    "antenna_entities": {
                        "id": [-1, -1],
                        "geometry.x": [80000.0, 80500.0],
                        "geometry.y": [455000.0, 455500.0],
                    }
                }
            },
        )
        group = self.read_group(dataset_file)
        assert group["id"] == [0, 1, 2, 3]
        assert group["geometry.x"] == [81758.0, 81017.0, 80000.0, 80500.0]
        assert group["geometry.y"] == [454993.0, 455843.0, 455000.0, 455500.0]
        assert group["operational.power_source"] == [0, 1, None, None]

    def test_patch_creates_entity_group_for_placeholder_rows(
        self, patch_with_status, dataset_file
    ):
        """A group unknown to the dataset  is created on the fly when
        every row for it is a -1 create placeholder."""
        patch_with_status(
            "/datasets/antennas",
            200,
            json={
                "data": {
                    "tower_entities": {
                        "id": [-1, -1],
                        "geometry.x": [80000.0, 80500.0],
                        "geometry.y": [455000.0, 455500.0],
                    }
                }
            },
        )
        data = json.loads(dataset_file.read_bytes())["data"]
        assert data["tower_entities"] == {
            "id": [0, 1],
            "geometry.x": [80000.0, 80500.0],
            "geometry.y": [455000.0, 455500.0],
        }
        assert data["antenna_entities"]["id"] == [0, 1]  # untouched

    def test_patch_rejects_unknown_group_with_non_placeholder_ids(
        self, patch_with_status, dataset_file
    ):
        patch_with_status(
            "/datasets/antennas",
            404,
            json={
                "data": {
                    "antenna_entities": {"id": [0], "operational.power_source": [2]},
                    "tower_entities": {"id": [-1, 0], "geometry.x": [80000.0, 80500.0]},
                }
            },
        )
        data = json.loads(dataset_file.read_bytes())["data"]
        assert "tower_entities" not in data
        assert data["antenna_entities"]["operational.power_source"] == [0, 1]  # unchanged

    def test_patch_creates_missing_column(self, patch_with_status, dataset_file):
        patch_with_status(
            "/datasets/antennas",
            200,
            json={"data": {"antenna_entities": {"id": [0], "some.new_attribute": [42]}}},
        )
        group = self.read_group(dataset_file)
        assert group["some.new_attribute"] == [42, None]

    def test_patch_treats_nulls_as_holes(self, patch_with_status, dataset_file):
        patch_with_status(
            "/datasets/antennas",
            200,
            json={
                "data": {
                    "antenna_entities": {
                        "id": [0, 1],
                        "geometry.x": [82000.0, None],
                        "operational.power_source": [None, 2],
                    }
                }
            },
        )
        group = self.read_group(dataset_file)
        assert group["geometry.x"] == [82000.0, 81017.0]
        assert group["operational.power_source"] == [0, 2]

    def test_patch_nulls_overwrite_clears_values(self, patch_with_status, dataset_file):
        patch_with_status(
            "/datasets/antennas",
            200,
            json={
                "nulls_overwrite": True,
                "data": {
                    "antenna_entities": {"id": [0, 1], "operational.power_source": [None, 2]}
                },
            },
        )
        group = self.read_group(dataset_file)
        assert group["operational.power_source"] == [None, 2]

    def test_patch_deletes_entity(self, patch_with_status, dataset_file):
        patch_with_status(
            "/datasets/antennas",
            200,
            json={"data": {"antenna_entities": {"id": [0], "deleted": [True]}}},
        )
        group = self.read_group(dataset_file)
        assert group["id"] == [1]
        assert group["geometry.x"] == [81017.0]
        assert group["operational.power_source"] == [1]

    def test_patch_delete_and_update_combined(self, patch_with_status, dataset_file):
        patch_with_status(
            "/datasets/antennas",
            200,
            json={
                "data": {
                    "antenna_entities": {
                        "id": [0, 1],
                        "deleted": [True, False],
                        "operational.power_source": [None, 2],
                    }
                }
            },
        )
        group = self.read_group(dataset_file)
        assert group["id"] == [1]
        assert group["operational.power_source"] == [2]

    def test_patch_delete_unknown_entity(self, patch_with_status):
        patch_with_status(
            "/datasets/antennas",
            404,
            json={"data": {"antenna_entities": {"id": [99], "deleted": [True]}}},
        )

    def test_patch_rejects_ragged_columns(self, patch_with_status, dataset_file):
        """An attribute column shorter than "id" carries no way to tell which entity
        each value belongs to, so the patch is rejected rather than applied to the wrong rows.
        See the note on PatchEntityGroup in schemas/dataset.py."""
        patch_with_status(
            "/datasets/antennas",
            422,
            json={
                "data": {
                    "antenna_entities": {
                        "id": [0, 1],
                        "geometry.x": [82000.0],
                        "operational.power_source": [2],
                    }
                }
            },
        )
        group = self.read_group(dataset_file)
        assert group["geometry.x"] == [81758.0, 81017.0]  # unchanged
        assert group["operational.power_source"] == [0, 1]

    def test_patch_rejects_ragged_deleted_mask(self, patch_with_status, dataset_file):
        patch_with_status(
            "/datasets/antennas",
            422,
            json={"data": {"antenna_entities": {"id": [0, 1], "deleted": [True]}}},
        )
        assert self.read_group(dataset_file)["id"] == [0, 1]  # unchanged

    def test_patch_rejects_deleting_new_entity_placeholder(self, patch_with_status, dataset_file):
        """An entity that does not exist yet cannot carry a deleted flag.
          Rejected up front, so the valid update in the same patch must
          not have been applied either.
        """
        patch_with_status(
            "/datasets/antennas",
            422,
            json={
                "data": {
                    "antenna_entities": {
                        "id": [0, -1],
                        "deleted": [False, True],
                        "operational.power_source": [2, None],
                    }
                }
            },
        )
        group = self.read_group(dataset_file)
        assert group["id"] == [0, 1]  # unchanged
        assert group["operational.power_source"] == [0, 1]

    def test_patch_requires_id_column(self, patch_with_status):
        patch_with_status(
            "/datasets/antennas",
            400,
            json={"data": {"antenna_entities": {"operational.power_source": [2]}}},
        )

    def test_patch_unknown_dataset(self, patch_with_status):
        patch_with_status("/datasets/nope", 404, json={"data": {}})

    def test_patch_unknown_entity_group(self, patch_with_status):
        patch_with_status(
            "/datasets/antennas", 404, json={"data": {"no_such_entities": {"id": [0]}}}
        )

    def test_patch_binary_dataset_is_not_editable(self, patch_with_status):
        patch_with_status("/datasets/heightmap", 422, json={"data": {}})

    def test_patch_can_populate_new_dataset(
        self, patch_with_status, get_with_status, data_dir
    ):
        """ End-to-end with dataset creation (TestCreateDataset):
        a freshly created dataset starts with empty data, and its
        first entity group arrives as a patch of pure -1 creates."""
        (data_dir / "init_data" / "towers.json").write_text(
            json.dumps({"name": "towers", "type": "tower_point_set", "data": {}})
        )
        patch_with_status(
            "/datasets/towers",
            200,
            json={
                "data": {
                    "tower_entities": {
                        "id": [-1],
                        "geometry.x": [80000.0],
                        "geometry.y": [455000.0],
                    }
                }
            },
        )
        data = get_with_status("/datasets/towers/data", 200).json()["data"]
        assert data["tower_entities"] == {
            "id": [0],
            "geometry.x": [80000.0],
            "geometry.y": [455000.0],
        }

    def test_patch_refreshes_memoized_summary(self, get_with_status, patch_with_status):
        before = get_with_status("/datasets/antennas/summary", 200).json()
        x_before = next(
            p for p in before["entity_groups"][0]["properties"] if p["name"] == "geometry.x"
        )
        assert x_before["max_val"] == 81758.0

        patch_with_status(
            "/datasets/antennas",
            200,
            json={"data": {"antenna_entities": {"id": [0], "geometry.x": [90000.0]}}},
        )

        after = get_with_status("/datasets/antennas/summary", 200).json()
        x_after = next(
            p for p in after["entity_groups"][0]["properties"] if p["name"] == "geometry.x"
        )
        assert x_after["max_val"] == 90000.0


class TestCreateDataset:
    @pytest.fixture
    def data_dir(self, base_data_dir, tmp_path):
        """POST writes to disk: run against a copy so the shared fixtures stay pristine"""
        target = tmp_path / "data"
        shutil.copytree(base_data_dir, target)
        return target

    @pytest.fixture
    def post_with_status(self, request_with_status):
        return functools.partial(request_with_status, "post")

    def test_create_dataset_writes_movici_format_file(self, post_with_status, data_dir):
        response = post_with_status(
            "/datasets/",
            201,
            json={"name": "My Towers", "type": "tower_point_set"},
        )
        assert response.json() == {
            "uuid": "my_towers",
            "name": "my_towers",
            "display_name": "My Towers",
            "type": "tower_point_set",
            "format": "entity_based",
            "has_data": True,
            "general": {},
            "epsg_code": 28992,
        }
        content = json.loads((data_dir / "init_data" / "my_towers.json").read_bytes())
        assert content == {
            "name": "my_towers",
            "display_name": "My Towers",
            "type": "tower_point_set",
            "format": "entity_based",
            "epsg_code": 28992,
            "general": {},
            "data": {},
        }

    def test_created_dataset_appears_in_listing(self, post_with_status, get_with_status):
        post_with_status("/datasets/", 201, json={"name": "towers"})
        response = get_with_status("/datasets/", 200)
        assert "towers" in {ds["name"] for ds in response.json()["datasets"]}

    def test_create_dataset_rejects_duplicate_name(self, post_with_status):
        post_with_status("/datasets/", 409, json={"name": "Antennas"})

    def test_create_dataset_rejects_name_without_word_characters(self, post_with_status):
        post_with_status("/datasets/", 422, json={"name": "###"})
