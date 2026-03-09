import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useMainStore } from "@/stores/main";
import LocalDatasetService from "@/api/services/LocalDatasetService";
import type { DatasetPatch } from "@/api/requests/datasets";
import type { DatasetWithData } from "@movici-flow-lib/types";
import { useEditorHistoryStore, type Command } from "./useEditorHistoryStore";

// changes[entityGroup][entityId][propName] = newValue
type Changes = Map<string, Map<number, Record<string, unknown>>>;

export const useEditorStore = defineStore("editor", () => {
  const datasetUUID = ref<string | null>(null);
  const dataset = ref<DatasetWithData | null>(null);
  const entityGroup = ref<string | null>(null);
  const selectedId = ref<number | null>(null);
  const changes = ref<Changes>(new Map());
  const saving = ref(false);
  const error = ref<string | null>(null);

  const historyStore = useEditorHistoryStore();

  const entityGroupNames = computed<string[]>(() => {
    if (!dataset.value?.data) return [];
    return Object.keys(dataset.value.data);
  });

  const entities = computed<Record<string, unknown>[]>(() => {
    if (!dataset.value?.data || !entityGroup.value) return [];
    const groupData = dataset.value.data[entityGroup.value] as Record<string, unknown[]>;
    if (!groupData) return [];
    const keys = Object.keys(groupData);
    const ids: number[] = (groupData["id"] as number[]) ?? [];
    return ids.map((id, idx) => {
      const row: Record<string, unknown> = {};
      for (const key of keys) {
        row[key] = (groupData[key] as unknown[])[idx];
      }
      return row;
    });
  });

  const selectedEntity = computed<Record<string, unknown> | null>(() => {
    if (selectedId.value === null || !entityGroup.value) return null;
    const groupData = dataset.value?.data?.[entityGroup.value] as
      | Record<string, unknown[]>
      | undefined;
    if (!groupData) return null;
    const ids: number[] = (groupData["id"] as number[]) ?? [];
    const idx = ids.indexOf(selectedId.value);
    if (idx === -1) return null;
    const row: Record<string, unknown> = {};
    for (const key of Object.keys(groupData)) {
      row[key] = (groupData[key] as unknown[])[idx];
    }
    // Apply pending changes on top
    const pending = changes.value.get(entityGroup.value)?.get(selectedId.value);
    if (pending) {
      Object.assign(row, pending);
    }
    return row;
  });

  // Compute a bounding box [minX, minY, maxX, maxY] in the dataset's CRS from geometry columns.
  // Handles point (geometry.x/y), line (geometry.linestring_2d/3d) and polygon geometry.
  const boundingBox = computed<[number, number, number, number] | null>(() => {
    if (!dataset.value?.data) return null;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    let found = false;

    function expand(x: number, y: number) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      found = true;
    }

    for (const groupDataRaw of Object.values(dataset.value.data)) {
      const g = groupDataRaw as Record<string, unknown[]>;

      if ("geometry.x" in g && "geometry.y" in g) {
        const xs = g["geometry.x"] as number[];
        const ys = g["geometry.y"] as number[];
        xs.forEach((x, i) => expand(x, ys[i] ?? 0));
      }

      for (const key of ["geometry.linestring_2d", "geometry.linestring_3d"] as const) {
        if (key in g) {
          for (const line of g[key] as number[][][]) {
            for (const coord of line) {
              if (coord[0] !== undefined && coord[1] !== undefined) {
                expand(coord[0], coord[1]);
              }
            }
          }
        }
      }

      for (const key of [
        "geometry.polygon",
        "geometry.polygon_2d",
        "geometry.polygon_3d",
      ] as const) {
        if (key in g) {
          for (const ring of g[key] as number[][][]) {
            for (const coord of ring) {
              if (coord[0] !== undefined && coord[1] !== undefined) {
                expand(coord[0], coord[1]);
              }
            }
          }
        }
      }
    }

    return found ? [minX, minY, maxX, maxY] : null;
  });

  const isDirty = computed(() => {
    for (const groupChanges of changes.value.values()) {
      if (groupChanges.size > 0) return true;
    }
    return false;
  });

  const dirtyCount = computed(() => {
    let count = 0;
    for (const groupChanges of changes.value.values()) {
      count += groupChanges.size;
    }
    return count;
  });

  const patch = computed<DatasetPatch>(() => {
    const data: Record<string, Record<string, unknown[]>> = {};
    for (const [group, groupChanges] of changes.value.entries()) {
      if (groupChanges.size === 0) continue;
      const ids: number[] = [];
      const propArrays: Record<string, unknown[]> = {};
      for (const [id, props] of groupChanges.entries()) {
        ids.push(id);
        for (const [prop, value] of Object.entries(props)) {
          if (!propArrays[prop]) propArrays[prop] = [];
          propArrays[prop].push(value);
        }
      }
      data[group] = { id: ids, ...propArrays };
    }
    return { data };
  });

  async function loadDataset(uuid: string) {
    datasetUUID.value = uuid;
    dataset.value = null;
    entityGroup.value = null;
    selectedId.value = null;
    changes.value = new Map();
    historyStore.clear();
    error.value = null;

    const mainStore = useMainStore();
    const service = new LocalDatasetService(mainStore.client);
    const result = await service.getData({ datasetUUID: uuid });
    if (result) {
      dataset.value = result as DatasetWithData;
      const groups = Object.keys(result.data ?? {});
      if (groups.length > 0) {
        entityGroup.value = groups[0] ?? null;
      }
    }
  }

  function selectEntityGroup(name: string) {
    entityGroup.value = name;
    selectedId.value = null;
  }

  function selectEntity(id: number) {
    selectedId.value = id;
  }

  function clearSelection() {
    selectedId.value = null;
  }

  function updateProperty(
    group: string,
    id: number,
    prop: string,
    newValue: unknown,
    skipHistory = false,
  ) {
    // Determine old value (from pending changes or original data)
    const pending = changes.value.get(group)?.get(id);
    const groupData = dataset.value?.data?.[group] as Record<string, unknown[]> | undefined;
    const ids: number[] = (groupData?.["id"] as number[]) ?? [];
    const idx = ids.indexOf(id);
    const originalValue = idx !== -1 ? (groupData?.[prop] as unknown[])?.[idx] : undefined;
    const oldValue = pending?.[prop] !== undefined ? pending[prop] : originalValue;

    if (!changes.value.has(group)) {
      changes.value.set(group, new Map());
    }
    const groupChanges = changes.value.get(group)!;
    if (!groupChanges.has(id)) {
      groupChanges.set(id, {});
    }
    groupChanges.get(id)![prop] = newValue;

    if (!skipHistory) {
      historyStore.push({ entityGroup: group, id, property: prop, oldValue, newValue });
    }
  }

  function revertProperty(group: string, id: number, prop: string, skipHistory = false) {
    const groupChanges = changes.value.get(group);
    if (!groupChanges) return;
    const entityChanges = groupChanges.get(id);
    if (!entityChanges) return;
    delete entityChanges[prop];
    if (Object.keys(entityChanges).length === 0) {
      groupChanges.delete(id);
    }
  }

  function applyCommand(cmd: Command, isUndo: boolean) {
    if (isUndo) {
      const groupData = dataset.value?.data?.[cmd.entityGroup] as
        | Record<string, unknown[]>
        | undefined;
      const ids: number[] = (groupData?.["id"] as number[]) ?? [];
      const idx = ids.indexOf(cmd.id);
      const originalValue =
        idx !== -1 ? (groupData?.[cmd.property] as unknown[])?.[idx] : undefined;
      if (cmd.oldValue === originalValue) {
        revertProperty(cmd.entityGroup, cmd.id, cmd.property, true);
      } else {
        updateProperty(cmd.entityGroup, cmd.id, cmd.property, cmd.oldValue, true);
      }
    } else {
      updateProperty(cmd.entityGroup, cmd.id, cmd.property, cmd.newValue, true);
    }
  }

  function undo() {
    historyStore.undo(applyCommand);
  }

  function redo() {
    historyStore.redo(applyCommand);
  }

  async function save() {
    if (!datasetUUID.value || !isDirty.value) return;
    saving.value = true;
    error.value = null;
    // Preserve selection so the property panel stays open after reload
    const savedGroup = entityGroup.value;
    const savedId = selectedId.value;
    try {
      const mainStore = useMainStore();
      const service = new LocalDatasetService(mainStore.client);
      await service.patch(datasetUUID.value, patch.value);
      // Reload dataset so dataset.value reflects the saved values
      await loadDataset(datasetUUID.value);
      // Restore selection — loadDataset resets both to null
      entityGroup.value = savedGroup;
      selectedId.value = savedId;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      saving.value = false;
    }
  }

  function clearChanges() {
    changes.value = new Map();
    historyStore.clear();
  }

  return {
    datasetUUID,
    dataset,
    entityGroup,
    selectedId,
    changes,
    saving,
    error,
    entityGroupNames,
    entities,
    selectedEntity,
    boundingBox,
    isDirty,
    dirtyCount,
    patch,
    loadDataset,
    selectEntityGroup,
    selectEntity,
    clearSelection,
    updateProperty,
    revertProperty,
    undo,
    redo,
    save,
    clearChanges,
  };
});
