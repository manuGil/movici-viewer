/* eslint-disable @typescript-eslint/no-explicit-any */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useMainStore } from "@/stores/main";
import LocalDatasetService from "@/api/services/LocalDatasetService";
import type { DatasetPatch } from "@/api/requests/datasets";
import type { DatasetWithData } from "@movici-flow-lib/types";
import { ViewMode, ModifyMode, TranslateMode } from "@deck.gl-community/editable-layers";
import type { Feature } from "geojson";
import {
  useEditorHistoryStore,
  type Command,
  type PropertyCommand,
  type GeometryCommand,
} from "./useEditorHistoryStore";
import {
  detectGeometryType,
  getGeometryKey,
  groupToFeatureCollection,
  extractGeometryColumns,
  geomColumnsToWgs84Geometry,
  computeLinestringLength,
} from "@/utils/geoJsonBridge";

// changes[entityGroup][entityId][propName] = newValue
type Changes = Map<string, Map<number, Record<string, unknown>>>;

export type EditModeKey = "view" | "modify" | "translate";

export const useEditorStore = defineStore("editor", () => {
  const datasetUUID = ref<string | null>(null);
  const dataset = ref<DatasetWithData | null>(null);
  const entityGroup = ref<string | null>(null);
  const selectedId = ref<number | null>(null);
  const changes = ref<Changes>(new Map());
  const geometryChanges = ref<Changes>(new Map());
  const wgs84Features = ref<Record<string, Feature[]>>({});
  const saving = ref(false);
  const error = ref<string | null>(null);

  // Edit mode
  const editModeKey = ref<EditModeKey>("view");
  const modeInstances = {
    view: new ViewMode(),
    modify: new ModifyMode(),
    translate: new TranslateMode(),
  };
  const editMode = computed(() => modeInstances[editModeKey.value]);

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
    for (const groupGeomChanges of geometryChanges.value.values()) {
      if (groupGeomChanges.size > 0) return true;
    }
    return false;
  });

  const dirtyCount = computed(() => {
    let count = 0;
    for (const groupChanges of changes.value.values()) {
      count += groupChanges.size;
    }
    for (const groupGeomChanges of geometryChanges.value.values()) {
      count += groupGeomChanges.size;
    }
    return count;
  });

  const patch = computed<DatasetPatch>(() => {
    const data: Record<string, Record<string, unknown[]>> = {};

    // Collect all entity groups that have any change
    const allGroups = new Set([...changes.value.keys(), ...geometryChanges.value.keys()]);

    for (const group of allGroups) {
      const propChanges = changes.value.get(group) ?? new Map();
      const geomChanges = geometryChanges.value.get(group) ?? new Map();

      // Collect all entity IDs that have any change
      const allIds = new Set([...propChanges.keys(), ...geomChanges.keys()]);
      if (allIds.size === 0) continue;

      const ids: number[] = [];
      const propArrays: Record<string, unknown[]> = {};

      for (const id of allIds) {
        ids.push(id);
        const props = propChanges.get(id) ?? {};
        const geom = geomChanges.get(id) ?? {};
        const allProps = { ...props, ...geom };
        for (const [propName, value] of Object.entries(allProps)) {
          if (!propArrays[propName]) propArrays[propName] = [];
          propArrays[propName].push(value);
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
    geometryChanges.value = new Map();
    wgs84Features.value = {};
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

  function initWgs84Features(): void {
    if (!dataset.value?.data) {
      wgs84Features.value = {};
      return;
    }
    const epsg = dataset.value.epsg_code ?? null;
    const result: Record<string, Feature[]> = {};
    for (const [groupName, groupDataRaw] of Object.entries(dataset.value.data)) {
      const groupData = groupDataRaw as Record<string, unknown[]>;
      const fc = groupToFeatureCollection(groupData, epsg);
      result[groupName] = fc.features;
    }
    wgs84Features.value = result;
  }

  function getOriginalGeomColumns(groupName: string, id: number): Record<string, unknown> {
    const groupData = dataset.value?.data?.[groupName] as Record<string, unknown[]> | undefined;
    if (!groupData) return {};
    const geomType = detectGeometryType(groupData);
    if (!geomType) return {};
    const ids = (groupData["id"] as number[]) ?? [];
    const idx = ids.indexOf(id);
    if (idx === -1) return {};

    if (geomType === "point") {
      return {
        "geometry.x": (groupData["geometry.x"] as number[])[idx],
        "geometry.y": (groupData["geometry.y"] as number[])[idx],
      };
    }
    const geomKey = getGeometryKey(groupData, geomType);
    return { [geomKey]: (groupData[geomKey] as unknown[])[idx] };
  }

  /**
   * Recompute shape.length for a linestring entity from its native-CRS coordinates and
   * record the result as a property change (without adding to undo history).
   * If the computed value matches the original stored value, reverts the change instead
   * so the property is no longer marked as modified.
   */
  function syncShapeLength(
    groupName: string,
    id: number,
    geomColumns: Record<string, unknown>,
    geomKey: string,
  ): void {
    const groupData = dataset.value?.data?.[groupName] as Record<string, unknown[]> | undefined;
    if (!groupData || !("shape.length" in groupData)) return;

    const coords = geomColumns[geomKey] as number[][] | undefined;
    if (!coords) return;
    const newLength = computeLinestringLength(coords);

    // Retrieve the original stored value
    const ids = (groupData["id"] as number[]) ?? [];
    const idx = ids.indexOf(id);
    const originalLength = idx !== -1 ? (groupData["shape.length"] as number[])[idx] : undefined;

    if (newLength === originalLength) {
      revertProperty(groupName, id, "shape.length", true);
    } else {
      updateProperty(groupName, id, "shape.length", newLength, true /* skipHistory */);
    }
  }

  function onGeometryEdit(
    groupName: string,
    updatedFeatures: Feature[],
    featureIndexes: number[],
    editType: string,
  ): void {
    // Always update live features for visual feedback
    wgs84Features.value = { ...wgs84Features.value, [groupName]: updatedFeatures };

    // Only commit to history and geometryChanges on final editTypes
    const isFinal = ["finishMovePosition", "translated", "addPosition", "removePosition"].includes(
      editType,
    );
    if (!isFinal) return;

    const epsg = dataset.value?.epsg_code ?? null;
    const groupData = dataset.value?.data?.[groupName] as Record<string, unknown[]> | undefined;
    if (!groupData) return;

    const geomType = detectGeometryType(groupData);
    if (!geomType) return;
    const geomKey = getGeometryKey(groupData, geomType);

    for (const featureIdx of featureIndexes) {
      const feature = updatedFeatures[featureIdx];
      if (!feature) continue;
      const id = (feature as any).properties?.__id as number | undefined;
      if (id === undefined) continue;

      const newGeomColumns = extractGeometryColumns(feature as any, geomType, geomKey, epsg);
      const oldGeomColumns = getOriginalGeomColumns(groupName, id);

      // Update geometryChanges
      if (!geometryChanges.value.has(groupName)) {
        geometryChanges.value.set(groupName, new Map());
      }
      const groupGeomChanges = geometryChanges.value.get(groupName)!;
      if (!groupGeomChanges.has(id)) {
        groupGeomChanges.set(id, {});
      }
      Object.assign(groupGeomChanges.get(id)!, newGeomColumns);

      // Push to history
      historyStore.push({
        kind: "geometry",
        entityGroup: groupName,
        id,
        featureIdx,
        geomType,
        geomKey,
        oldGeomColumns,
        newGeomColumns,
      });

      // Keep shape.length in sync (linestring only, no history entry)
      if (geomType === "linestring") {
        syncShapeLength(groupName, id, newGeomColumns, geomKey);
      }
    }
  }

  function applyGeometryCommand(cmd: GeometryCommand, isUndo: boolean) {
    const geomToApply = isUndo ? cmd.oldGeomColumns : cmd.newGeomColumns;
    const epsg = dataset.value?.epsg_code ?? null;

    // Check if restoring to original
    const originalGeom = getOriginalGeomColumns(cmd.entityGroup, cmd.id);
    const isOriginal = JSON.stringify(geomToApply) === JSON.stringify(originalGeom);

    if (isOriginal) {
      // Remove from geometryChanges
      const groupGeomChanges = geometryChanges.value.get(cmd.entityGroup);
      groupGeomChanges?.delete(cmd.id);
    } else {
      // Update geometryChanges
      if (!geometryChanges.value.has(cmd.entityGroup)) {
        geometryChanges.value.set(cmd.entityGroup, new Map());
      }
      const groupGeomChanges = geometryChanges.value.get(cmd.entityGroup)!;
      if (!groupGeomChanges.has(cmd.id)) {
        groupGeomChanges.set(cmd.id, {});
      }
      Object.assign(groupGeomChanges.get(cmd.id)!, geomToApply);
    }

    // Update wgs84Features for rendering
    const currentFeatures = wgs84Features.value[cmd.entityGroup];
    if (currentFeatures && currentFeatures[cmd.featureIdx]) {
      const newGeom = geomColumnsToWgs84Geometry(geomToApply, cmd.geomType, cmd.geomKey, epsg);
      const updatedFeatures = [...currentFeatures];
      updatedFeatures[cmd.featureIdx] = {
        ...updatedFeatures[cmd.featureIdx],
        geometry: newGeom,
      } as unknown as Feature;
      wgs84Features.value = { ...wgs84Features.value, [cmd.entityGroup]: updatedFeatures };
    }

    // Keep shape.length in sync after undo/redo (linestring only, no history entry)
    if (cmd.geomType === "linestring") {
      syncShapeLength(cmd.entityGroup, cmd.id, geomToApply, cmd.geomKey);
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

  function setEditMode(mode: EditModeKey): void {
    editModeKey.value = mode;
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
      historyStore.push({
        kind: "property",
        entityGroup: group,
        id,
        property: prop,
        oldValue,
        newValue,
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
    if (cmd.kind === "geometry") {
      applyGeometryCommand(cmd, isUndo);
      return;
    }
    // Property command
    const propCmd = cmd as PropertyCommand;
    if (isUndo) {
      const groupData = dataset.value?.data?.[propCmd.entityGroup] as
        | Record<string, unknown[]>
        | undefined;
      const ids: number[] = (groupData?.["id"] as number[]) ?? [];
      const idx = ids.indexOf(propCmd.id);
      const originalValue =
        idx !== -1 ? (groupData?.[propCmd.property] as unknown[])?.[idx] : undefined;
      if (propCmd.oldValue === originalValue) {
        revertProperty(propCmd.entityGroup, propCmd.id, propCmd.property, true);
      } else {
        updateProperty(propCmd.entityGroup, propCmd.id, propCmd.property, propCmd.oldValue, true);
      }
    } else {
      updateProperty(propCmd.entityGroup, propCmd.id, propCmd.property, propCmd.newValue, true);
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
      // Reinitialize WGS84 features (projection is already loaded)
      initWgs84Features();
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
    geometryChanges.value = new Map();
    historyStore.clear();
    // Reset wgs84Features from original dataset
    initWgs84Features();
  }

  return {
    datasetUUID,
    dataset,
    entityGroup,
    selectedId,
    changes,
    geometryChanges,
    wgs84Features,
    saving,
    error,
    editModeKey,
    editMode,
    entityGroupNames,
    entities,
    selectedEntity,
    boundingBox,
    isDirty,
    dirtyCount,
    patch,
    loadDataset,
    initWgs84Features,
    onGeometryEdit,
    setEditMode,
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
