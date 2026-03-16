/* eslint-disable @typescript-eslint/no-explicit-any */
import { computed } from "vue";
import { EditableGeoJsonLayer } from "@deck.gl-community/editable-layers";
import type { Layer } from "@deck.gl/core";
import { useEditorStore } from "@/stores/useEditorStore";

const HIGHLIGHT_COLOR: [number, number, number, number] = [255, 140, 0, 220];
const DEFAULT_FILL_COLOR: [number, number, number, number] = [70, 130, 180, 100];
const DEFAULT_LINE_COLOR: [number, number, number, number] = [70, 130, 180, 200];
const EDIT_HANDLE_COLOR: [number, number, number, number] = [255, 255, 255, 255];
const EDIT_HANDLE_OUTLINE_COLOR: [number, number, number, number] = [255, 140, 0, 255];

export function useEditorLayers() {
  const store = useEditorStore();

  const layers = computed<Layer[]>(() => {
    if (!store.dataset?.data) return [];

    return Object.entries(store.dataset.data).map(([groupName, groupDataRaw]) => {
      const groupData = groupDataRaw as Record<string, unknown[]>;
      const ids = (groupData["id"] as number[]) ?? [];

      // Use live WGS84 features from store, fallback to empty
      const features = store.wgs84Features[groupName] ?? [];
      const featureCollection = { type: "FeatureCollection" as const, features };

      // Map entity id → feature index for selection
      const selectedIndexes: number[] =
        store.selectedId !== null && store.entityGroup === groupName
          ? [ids.indexOf(store.selectedId)].filter((i) => i !== -1)
          : [];

      return new EditableGeoJsonLayer({
        id: `editor-${groupName}`,
        data: featureCollection,
        mode: store.editMode,
        selectedFeatureIndexes: selectedIndexes,
        pickable: true,
        // Styling
        getFillColor: ((feature: any, isSelected: boolean) =>
          isSelected ? HIGHLIGHT_COLOR : DEFAULT_FILL_COLOR) as any,
        getLineColor: ((feature: any, isSelected: boolean) =>
          isSelected ? HIGHLIGHT_COLOR : DEFAULT_LINE_COLOR) as any,
        getLineWidth: 2,
        lineWidthUnits: "pixels",
        getRadius: 8,
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
          store.onGeometryEdit(groupName, updatedData.features, featureIndexes, editType);
        }) as any,
        updateTriggers: {
          getFillColor: [store.selectedId, store.entityGroup],
          getLineColor: [store.selectedId, store.entityGroup],
          data: [store.wgs84Features[groupName]],
        },
      } as any);
    });
  });

  return { layers };
}
