import { computed } from "vue";
import { ScatterplotLayer } from "@deck.gl/layers";
import { PathLayer } from "@deck.gl/layers";
import { PolygonLayer } from "@deck.gl/layers";
import type { Layer } from "@deck.gl/core";
import { transform, transformArray, determineCRS } from "@movici-flow-lib/crs";
import { useEditorStore } from "@/stores/useEditorStore";

const HIGHLIGHT_COLOR: [number, number, number, number] = [255, 140, 0, 220];
const DEFAULT_POINT_COLOR: [number, number, number, number] = [70, 130, 180, 200];
const DEFAULT_LINE_COLOR: [number, number, number, number] = [70, 130, 180, 200];
const DEFAULT_POLYGON_COLOR: [number, number, number, number] = [70, 130, 180, 100];

function hasKeys(data: Record<string, unknown[]>, keys: string[]): boolean {
  return keys.every((k) => k in data);
}

export function useEditorLayers() {
  const store = useEditorStore();

  const layers = computed<Layer[]>(() => {
    if (!store.dataset?.data) return [];
    const epsg = store.dataset.epsg_code ?? null;
    const crs = determineCRS(epsg);
    const result: Layer[] = [];

    for (const [groupName, groupDataRaw] of Object.entries(store.dataset.data)) {
      const groupData = groupDataRaw as Record<string, unknown[]>;
      const ids = (groupData["id"] as number[]) ?? [];

      if (hasKeys(groupData, ["geometry.x", "geometry.y"])) {
        const xs = groupData["geometry.x"] as number[];
        const ys = groupData["geometry.y"] as number[];
        const data = ids.map((id, idx) => ({
          id,
          position: [xs[idx] ?? 0, ys[idx] ?? 0] as [number, number],
        }));

        result.push(
          new ScatterplotLayer({
            id: `editor-points-${groupName}`,
            data,
            pickable: true,
            getPosition: (d: { id: number; position: [number, number] }) => {
              const [lng, lat] = transform(d.position, crs);
              return [lng, lat, 0];
            },
            getRadius: 8,
            radiusUnits: "pixels",
            getFillColor: (d: { id: number }) =>
              d.id === store.selectedId && groupName === store.entityGroup
                ? HIGHLIGHT_COLOR
                : DEFAULT_POINT_COLOR,
            updateTriggers: {
              getFillColor: [store.selectedId, store.entityGroup],
            },
          } as unknown as ConstructorParameters<typeof ScatterplotLayer>[0]),
        );
      } else if (
        hasKeys(groupData, ["geometry.linestring_2d"]) ||
        hasKeys(groupData, ["geometry.linestring_3d"])
      ) {
        const lineKey =
          "geometry.linestring_2d" in groupData
            ? "geometry.linestring_2d"
            : "geometry.linestring_3d";
        const lines = groupData[lineKey] as number[][][];
        const data = ids.map((id, idx) => ({ id, path: lines[idx] ?? [] }));

        result.push(
          new PathLayer({
            id: `editor-paths-${groupName}`,
            data,
            pickable: true,
            getPath: (d: { id: number; path: number[][] }) =>
              transformArray(d.path as [number, number][], crs).map(([lng, lat]) => [lng, lat, 0]),
            getWidth: 3,
            widthUnits: "pixels",
            getColor: (d: { id: number }) =>
              d.id === store.selectedId && groupName === store.entityGroup
                ? HIGHLIGHT_COLOR
                : DEFAULT_LINE_COLOR,
            updateTriggers: {
              getColor: [store.selectedId, store.entityGroup],
            },
          } as unknown as ConstructorParameters<typeof PathLayer>[0]),
        );
      } else if (hasKeys(groupData, ["geometry.polygon"])) {
        const polygons = groupData["geometry.polygon"] as number[][][];
        const data = ids.map((id, idx) => ({ id, polygon: polygons[idx] ?? [] }));

        result.push(
          new PolygonLayer({
            id: `editor-polygons-${groupName}`,
            data,
            pickable: true,
            getPolygon: (d: { id: number; polygon: number[][] }) =>
              transformArray(d.polygon as [number, number][], crs).map(([lng, lat]) => [lng, lat]),
            getFillColor: (d: { id: number }) =>
              d.id === store.selectedId && groupName === store.entityGroup
                ? HIGHLIGHT_COLOR
                : DEFAULT_POLYGON_COLOR,
            getLineColor: [50, 100, 150, 200],
            getLineWidth: 1,
            lineWidthUnits: "pixels",
            updateTriggers: {
              getFillColor: [store.selectedId, store.entityGroup],
            },
          } as unknown as ConstructorParameters<typeof PolygonLayer>[0]),
        );
      }
    }

    return result;
  });

  return { layers };
}
