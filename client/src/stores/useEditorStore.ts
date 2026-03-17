/* eslint-disable @typescript-eslint/no-explicit-any */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useMainStore } from "@/stores/main";
import LocalDatasetService from "@/api/services/LocalDatasetService";
import type { DatasetPatch } from "@/api/requests/datasets";
import type { DatasetWithData } from "@movici-flow-lib/types";
import {
  ViewMode,
  ModifyMode,
  TranslateMode,
  DrawPointMode,
  DrawLineStringMode,
  DrawPolygonMode,
} from "@deck.gl-community/editable-layers";
import type { Feature } from "geojson";
import {
  useEditorHistoryStore,
  type Command,
  type PropertyCommand,
  type GeometryCommand,
  type DeleteCommand,
  type CreateCommand,
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

export type EditModeKey =
  | "view"
  | "modify"
  | "translate"
  | "draw-point"
  | "draw-line"
  | "draw-polygon"
  | "delete"
  | "select-rect";

export const useEditorStore = defineStore("editor", () => {
  const datasetUUID = ref<string | null>(null);
  const dataset = ref<DatasetWithData | null>(null);
  const entityGroup = ref<string | null>(null);
  const selectedId = ref<number | null>(null);
  const changes = ref<Changes>(new Map());
  const geometryChanges = ref<Changes>(new Map());
  const wgs84Features = ref<Record<string, Feature[]>>({});
  // IDs of entities that were created in this editing session (not pre-existing)
  const newEntityIds = ref<Map<string, Set<number>>>(new Map());
  // IDs of pre-existing entities deleted in this editing session
  const deletedEntityIds = ref<Map<string, Set<number>>>(new Map());
  // IDs selected via rectangle selection (current entity group only)
  const multiSelectedIds = ref<number[]>([]);
  const saving = ref(false);
  const error = ref<string | null>(null);

  // Edit mode
  const editModeKey = ref<EditModeKey>("view");
  const modeInstances: Record<EditModeKey, unknown> = {
    view: new ViewMode(),
    modify: new ModifyMode(),
    translate: new TranslateMode(),
    "draw-point": new DrawPointMode(),
    "draw-line": new DrawLineStringMode(),
    "draw-polygon": new DrawPolygonMode(),
    // "delete" reuses ViewMode — clicking a feature is intercepted by EditorView's click handler
    delete: new ViewMode(),
    // "select-rect" reuses ViewMode — the SelectionLayer handles the rectangle interaction
    "select-rect": new ViewMode(),
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

  const currentGroupGeometryType = computed(() => {
    if (!dataset.value?.data || !entityGroup.value) return null;
    const groupData = dataset.value.data[entityGroup.value] as
      | Record<string, unknown[]>
      | undefined;
    return groupData ? detectGeometryType(groupData) : null;
  });

  const isDirty = computed(() => {
    for (const groupChanges of changes.value.values()) {
      if (groupChanges.size > 0) return true;
    }
    for (const groupGeomChanges of geometryChanges.value.values()) {
      if (groupGeomChanges.size > 0) return true;
    }
    for (const ids of deletedEntityIds.value.values()) {
      if (ids.size > 0) return true;
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
    for (const ids of deletedEntityIds.value.values()) {
      count += ids.size;
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

    // Collect deletions (only pre-existing entities — new entities were never on the server)
    const deleted: Record<string, number[]> = {};
    for (const [group, ids] of deletedEntityIds.value) {
      if (ids.size > 0) {
        deleted[group] = Array.from(ids);
      }
    }

    return { data, ...(Object.keys(deleted).length > 0 ? { deleted } : {}) };
  });

  async function loadDataset(uuid: string) {
    datasetUUID.value = uuid;
    dataset.value = null;
    entityGroup.value = null;
    selectedId.value = null;
    changes.value = new Map();
    geometryChanges.value = new Map();
    wgs84Features.value = {};
    newEntityIds.value = new Map();
    deletedEntityIds.value = new Map();
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
    // Reset draw/delete/select modes when switching groups
    if (
      ["draw-point", "draw-line", "draw-polygon", "delete", "select-rect"].includes(
        editModeKey.value,
      )
    ) {
      editModeKey.value = "view";
    }
    multiSelectedIds.value = [];
  }

  function selectEntity(id: number) {
    selectedId.value = id;
  }

  function clearSelection() {
    selectedId.value = null;
    multiSelectedIds.value = [];
  }

  function setEditMode(mode: EditModeKey): void {
    editModeKey.value = mode;
    selectedId.value = null;
    if (mode !== "select-rect") {
      multiSelectedIds.value = [];
    }
  }

  function setMultiSelection(ids: number[]): void {
    multiSelectedIds.value = ids;
    // If exactly one entity selected, mirror into selectedId for the properties panel
    selectedId.value = ids.length === 1 ? ids[0]! : null;
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

  function restoreEntity(params: {
    entityGroup: string;
    id: number;
    isNew: boolean;
    dataIdx: number;
    rowData: Record<string, unknown>;
    wgs84FeatureIdx: number;
    wgs84Feature: Feature;
    pendingChanges?: Record<string, unknown>;
    pendingGeomChanges?: Record<string, unknown>;
  }) {
    const {
      entityGroup: group,
      id,
      isNew,
      dataIdx,
      rowData,
      wgs84FeatureIdx,
      wgs84Feature,
      pendingChanges,
      pendingGeomChanges,
    } = params;

    // Restore the entity row into columnar data at its original index
    const groupData = dataset.value?.data?.[group] as Record<string, unknown[]> | undefined;
    if (groupData) {
      for (const [key, value] of Object.entries(rowData)) {
        if (groupData[key]) {
          (groupData[key] as unknown[]).splice(dataIdx, 0, value);
        }
      }
    }

    // Restore wgs84Feature at its original index
    const currentFeatures = [...(wgs84Features.value[group] ?? [])];
    currentFeatures.splice(wgs84FeatureIdx, 0, wgs84Feature);
    wgs84Features.value = { ...wgs84Features.value, [group]: currentFeatures };

    // Restore any pending property/geometry changes
    if (pendingChanges) {
      if (!changes.value.has(group)) changes.value.set(group, new Map());
      changes.value.get(group)!.set(id, { ...pendingChanges });
    }
    if (pendingGeomChanges) {
      if (!geometryChanges.value.has(group)) geometryChanges.value.set(group, new Map());
      geometryChanges.value.get(group)!.set(id, { ...pendingGeomChanges });
    }

    // Restore tracking state
    if (isNew) {
      if (!newEntityIds.value.has(group)) newEntityIds.value.set(group, new Set());
      newEntityIds.value.get(group)!.add(id);
    } else {
      deletedEntityIds.value.get(group)?.delete(id);
    }
  }

  function applyDeleteCommand(cmd: DeleteCommand, isUndo: boolean) {
    if (isUndo) {
      restoreEntity(cmd);
    } else {
      deleteEntity(cmd.entityGroup, cmd.id, true);
    }
  }

  function applyCreateCommand(cmd: CreateCommand, isUndo: boolean) {
    if (isUndo) {
      // Entity is still in newEntityIds — deleteEntity handles the rest correctly
      deleteEntity(cmd.entityGroup, cmd.id, true);
    } else {
      restoreEntity({
        entityGroup: cmd.entityGroup,
        id: cmd.id,
        isNew: true,
        dataIdx: cmd.dataIdx,
        rowData: cmd.rowData,
        wgs84FeatureIdx: cmd.wgs84FeatureIdx,
        wgs84Feature: cmd.wgs84Feature,
        pendingGeomChanges: cmd.geomColumns,
      });
    }
  }

  function applyCommand(cmd: Command, isUndo: boolean) {
    if (cmd.kind === "geometry") {
      applyGeometryCommand(cmd, isUndo);
      return;
    }
    if (cmd.kind === "delete") {
      applyDeleteCommand(cmd as DeleteCommand, isUndo);
      return;
    }
    if (cmd.kind === "create") {
      applyCreateCommand(cmd as CreateCommand, isUndo);
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

  function addEntity(groupName: string, newFeature: Feature, epsg: number | null): void {
    const groupData = dataset.value?.data?.[groupName] as Record<string, unknown[]> | undefined;
    if (!groupData) return;

    const geomType = detectGeometryType(groupData);
    if (!geomType) return;
    const geomKey = getGeometryKey(groupData, geomType);

    // Generate a unique ID (max existing + 1)
    const ids = (groupData["id"] as number[]) ?? [];
    const newId = ids.length > 0 ? Math.max(...ids) + 1 : 1;

    // Extract geometry in dataset CRS
    const geomColumns = extractGeometryColumns(newFeature as any, geomType, geomKey, epsg);

    // Record positions before inserting (for undo)
    const dataIdx = ids.length; // will be appended at this index
    const wgs84FeatureIdx = (wgs84Features.value[groupName] ?? []).length;

    // Add new row to dataset columnar data
    (groupData["id"] as number[]).push(newId);
    for (const key of Object.keys(groupData)) {
      if (key === "id") continue;
      const geomValue = geomColumns[key];
      (groupData[key] as unknown[]).push(geomValue !== undefined ? geomValue : null);
    }

    // Update wgs84Features with the correct __id in properties
    const newFeatureWithId: Feature = {
      ...newFeature,
      properties: { ...(newFeature.properties ?? {}), __id: newId },
    };
    const currentFeatures = wgs84Features.value[groupName] ?? [];
    wgs84Features.value = {
      ...wgs84Features.value,
      [groupName]: [...currentFeatures, newFeatureWithId],
    };

    // Track geometry as changed (so patch includes this entity)
    if (!geometryChanges.value.has(groupName)) {
      geometryChanges.value.set(groupName, new Map());
    }
    geometryChanges.value.get(groupName)!.set(newId, { ...geomColumns });

    // Track as new entity
    if (!newEntityIds.value.has(groupName)) {
      newEntityIds.value.set(groupName, new Set());
    }
    newEntityIds.value.get(groupName)!.add(newId);

    // Recompute shape.length for new linestring entities
    if (geomType === "linestring") {
      syncShapeLength(groupName, newId, geomColumns, geomKey);
    }

    // Build the rowData snapshot for undo (all columns for this new entity)
    const rowData: Record<string, unknown> = {};
    for (const key of Object.keys(groupData)) {
      const arr = groupData[key] as unknown[];
      rowData[key] = arr[arr.length - 1];
    }

    // Push to history so the draw can be undone
    historyStore.push({
      kind: "create",
      entityGroup: groupName,
      id: newId,
      dataIdx,
      rowData,
      wgs84FeatureIdx,
      wgs84Feature: newFeatureWithId,
      geomColumns: { ...geomColumns },
    } as CreateCommand);

    // Select the new entity and switch back to view mode
    entityGroup.value = groupName;
    selectedId.value = newId;
    editModeKey.value = "view";
  }

  function deleteEntity(groupName: string, id: number, skipHistory = false): void {
    // Capture snapshot before mutating (needed for undo)
    const groupData = dataset.value?.data?.[groupName] as Record<string, unknown[]> | undefined;
    let dataIdx = -1;
    const rowData: Record<string, unknown> = {};
    if (groupData) {
      const ids = (groupData["id"] as number[]) ?? [];
      dataIdx = ids.indexOf(id);
      if (dataIdx !== -1) {
        for (const key of Object.keys(groupData)) {
          rowData[key] = (groupData[key] as unknown[])[dataIdx];
        }
      }
    }
    const allFeatures = wgs84Features.value[groupName] ?? [];
    const wgs84FeatureIdx = allFeatures.findIndex((f) => (f as any).properties?.__id === id);
    const wgs84Feature = wgs84FeatureIdx !== -1 ? allFeatures[wgs84FeatureIdx] : null;
    const pendingChanges = changes.value.get(groupName)?.get(id)
      ? { ...changes.value.get(groupName)!.get(id)! }
      : undefined;
    const pendingGeomChanges = geometryChanges.value.get(groupName)?.get(id)
      ? { ...geometryChanges.value.get(groupName)!.get(id)! }
      : undefined;
    const isNew = newEntityIds.value.get(groupName)?.has(id) ?? false;

    // Remove the row from columnar dataset data
    if (groupData && dataIdx !== -1) {
      for (const key of Object.keys(groupData)) {
        (groupData[key] as unknown[]).splice(dataIdx, 1);
      }
    }

    // Remove from wgs84Features
    wgs84Features.value = {
      ...wgs84Features.value,
      [groupName]: allFeatures.filter((f) => (f as any).properties?.__id !== id),
    };

    // Discard any pending changes for this entity
    changes.value.get(groupName)?.delete(id);
    geometryChanges.value.get(groupName)?.delete(id);

    // If the entity was created this session, just forget it — no need to tell the server
    if (isNew) {
      newEntityIds.value.get(groupName)?.delete(id);
    } else {
      // Track for deletion in the next patch
      if (!deletedEntityIds.value.has(groupName)) {
        deletedEntityIds.value.set(groupName, new Set());
      }
      deletedEntityIds.value.get(groupName)!.add(id);
    }

    // Clear selection if this entity was selected
    if (selectedId.value === id && entityGroup.value === groupName) {
      selectedId.value = null;
    }

    // Push to history so undo/redo works (skip for redo replays)
    if (!skipHistory && wgs84Feature) {
      historyStore.push({
        kind: "delete",
        entityGroup: groupName,
        id,
        isNew,
        dataIdx,
        rowData,
        wgs84FeatureIdx,
        wgs84Feature,
        pendingChanges,
        pendingGeomChanges,
      } as DeleteCommand);
    }

    // Return to view mode after deletion
    editModeKey.value = "view";
  }

  function clearChanges() {
    changes.value = new Map();
    geometryChanges.value = new Map();
    newEntityIds.value = new Map();
    deletedEntityIds.value = new Map();
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
    newEntityIds,
    multiSelectedIds,
    saving,
    error,
    editModeKey,
    editMode,
    entityGroupNames,
    entities,
    selectedEntity,
    boundingBox,
    currentGroupGeometryType,
    isDirty,
    dirtyCount,
    patch,
    loadDataset,
    initWgs84Features,
    onGeometryEdit,
    addEntity,
    deleteEntity,
    setEditMode,
    setMultiSelection,
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
