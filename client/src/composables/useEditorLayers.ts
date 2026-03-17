/* eslint-disable @typescript-eslint/no-explicit-any */
import { computed } from "vue";
import {
  EditableGeoJsonLayer,
  ViewMode,
  SelectionLayer,
  SELECTION_TYPE,
} from "@deck.gl-community/editable-layers";
import type { Layer } from "@deck.gl/core";
import { useEditorStore } from "@/stores/useEditorStore";

const VIEW_MODE = new ViewMode();

const HIGHLIGHT_COLOR: [number, number, number, number] = [255, 140, 0, 220];
const DEFAULT_FILL_COLOR: [number, number, number, number] = [70, 130, 180, 180];
const DEFAULT_LINE_COLOR: [number, number, number, number] = [11, 179, 47, 255];
const EDIT_HANDLE_COLOR: [number, number, number, number] = [255, 255, 255, 255];
const EDIT_HANDLE_OUTLINE_COLOR: [number, number, number, number] = [255, 140, 0, 255];

export function useEditorLayers() {
  const store = useEditorStore();

  const layers = computed<Layer[]>(() => {
    if (!store.dataset?.data) return [];

    const editableLayers: Layer[] = Object.entries(store.dataset.data).map(
      ([groupName, groupDataRaw]) => {
        const groupData = groupDataRaw as Record<string, unknown[]>;
        const ids = (groupData["id"] as number[]) ?? [];

        // Use live WGS84 features from store, fallback to empty
        const features = store.wgs84Features[groupName] ?? [];
        const featureCollection = { type: "FeatureCollection" as const, features };

        // Map entity id → feature index for selection (single + multi-select)
        const selectedIndexes: number[] = [];
        if (store.entityGroup === groupName) {
          if (store.multiSelectedIds.length > 0) {
            for (const id of store.multiSelectedIds) {
              const i = ids.indexOf(id);
              if (i !== -1) selectedIndexes.push(i);
            }
          } else if (store.selectedId !== null) {
            const i = ids.indexOf(store.selectedId);
            if (i !== -1) selectedIndexes.push(i);
          }
        }

        // Draw/delete modes apply only to the active group; other groups stay in view mode
        const isScopedMode = ["draw-point", "draw-line", "draw-polygon", "delete"].includes(
          store.editModeKey,
        );
        const layerMode =
          isScopedMode && groupName !== store.entityGroup ? VIEW_MODE : store.editMode;

        return new EditableGeoJsonLayer({
          id: `editor-${groupName}`,
          data: featureCollection,
          mode: layerMode,
          modeConfig: { formatTooltip: () => "" },
          selectedFeatureIndexes: selectedIndexes,
          pickable: true,
          // Styling
          getFillColor: ((feature: any, isSelected: boolean) =>
            isSelected ? HIGHLIGHT_COLOR : DEFAULT_FILL_COLOR) as any,
          getLineColor: ((feature: any, isSelected: boolean) =>
            isSelected ? HIGHLIGHT_COLOR : DEFAULT_LINE_COLOR) as any,
          getLineWidth: 3,
          lineWidthUnits: "pixels",
          getRadius: 12,
          pointRadiusUnits: "pixels",
          // Edit handle appearance
          getEditHandlePointColor: EDIT_HANDLE_COLOR,
          getEditHandlePointOutlineColor: EDIT_HANDLE_OUTLINE_COLOR,
          editHandlePointOutline: true,
          editHandlePointStrokeWidth: 2,
          // Edit callback
          onEdit: ((editAction: any) => {
            const { updatedData, editType, editContext } = editAction;
            const featureIndexes: number[] = editContext?.featureIndexes ?? [];
            if (editType === "addFeature") {
              const newFeatureIdx: number = featureIndexes[0] ?? updatedData.features.length - 1;
              const newFeature = updatedData.features[newFeatureIdx];
              if (newFeature) {
                store.addEntity(groupName, newFeature, store.dataset?.epsg_code ?? null);
              }
            } else {
              store.onGeometryEdit(groupName, updatedData.features, featureIndexes, editType);
            }
          }) as any,
          updateTriggers: {
            getFillColor: [store.selectedId, store.multiSelectedIds, store.entityGroup],
            getLineColor: [store.selectedId, store.multiSelectedIds, store.entityGroup],
            data: [store.wgs84Features[groupName]],
            mode: [store.editModeKey, store.entityGroup],
          },
        } as any);
      },
    );

    // Append a SelectionLayer on top when in rectangle-select mode
    if (store.editModeKey === "select-rect" && store.entityGroup) {
      editableLayers.push(
        new SelectionLayer({
          id: "editor-selection",
          selectionType: SELECTION_TYPE.RECTANGLE,
          layerIds: [`editor-${store.entityGroup}`],
          onSelect: ({ pickingInfos }: { pickingInfos: any[] }) => {
            const ids = pickingInfos
              .map((info) => info.object?.properties?.__id as number | undefined)
              .filter((id): id is number => id !== undefined);
            store.setMultiSelection(ids);
          },
          getTentativeFillColor: () => [100, 160, 220, 40] as [number, number, number, number],
          getTentativeLineColor: () => [100, 160, 220, 200] as [number, number, number, number],
          lineWidthMinPixels: 1,
        } as any),
      );
    }

    return editableLayers;
  });

  return { layers };
}
