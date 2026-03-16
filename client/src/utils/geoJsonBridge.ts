/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  transform,
  reverseTransform,
  transformArray,
  reverseTransformArray,
  determineCRS,
} from "@movici-flow-lib/crs";

import type { Feature, FeatureCollection } from "geojson";

export type { Feature, FeatureCollection };
export type GeometryType = "point" | "linestring" | "polygon";

export function detectGeometryType(groupData: Record<string, unknown[]>): GeometryType | null {
  if ("geometry.x" in groupData && "geometry.y" in groupData) {
    return "point";
  }
  if ("geometry.linestring_2d" in groupData || "geometry.linestring_3d" in groupData) {
    return "linestring";
  }
  if (
    "geometry.polygon" in groupData ||
    "geometry.polygon_2d" in groupData ||
    "geometry.polygon_3d" in groupData
  ) {
    return "polygon";
  }
  return null;
}

export function getGeometryKey(
  groupData: Record<string, unknown[]>,
  geomType: GeometryType,
): string {
  if (geomType === "point") {
    return "geometry.x";
  }
  if (geomType === "linestring") {
    if ("geometry.linestring_2d" in groupData) return "geometry.linestring_2d";
    return "geometry.linestring_3d";
  }
  // polygon
  if ("geometry.polygon" in groupData) return "geometry.polygon";
  if ("geometry.polygon_2d" in groupData) return "geometry.polygon_2d";
  return "geometry.polygon_3d";
}

export function groupToFeatureCollection(
  groupData: Record<string, unknown[]>,
  epsg: number | null,
): FeatureCollection {
  const geomType = detectGeometryType(groupData);
  const ids = (groupData["id"] as number[]) ?? [];
  const crs = determineCRS(epsg);

  // Non-geometry property keys
  const geometryKeys = new Set([
    "geometry.x",
    "geometry.y",
    "geometry.linestring_2d",
    "geometry.linestring_3d",
    "geometry.polygon",
    "geometry.polygon_2d",
    "geometry.polygon_3d",
  ]);

  const propKeys = Object.keys(groupData).filter((k) => !geometryKeys.has(k));

  const features: Feature[] = ids.map((id, idx) => {
    // Build properties
    const properties: Record<string, unknown> = { __id: id };
    for (const key of propKeys) {
      properties[key] = (groupData[key] as unknown[])[idx];
    }

    // Build geometry
    let geometry: any = null;

    if (geomType === "point") {
      const x = (groupData["geometry.x"] as number[])[idx] ?? 0;
      const y = (groupData["geometry.y"] as number[])[idx] ?? 0;
      const [lng, lat] = transform([x, y], crs);
      geometry = { type: "Point", coordinates: [lng, lat] };
    } else if (geomType === "linestring") {
      const geomKey = getGeometryKey(groupData, geomType);
      const line = (groupData[geomKey] as number[][][])[idx] ?? [];
      const transformed = transformArray(line as [number, number][], crs);
      geometry = { type: "LineString", coordinates: transformed.map(([lng, lat]) => [lng, lat]) };
    } else if (geomType === "polygon") {
      const geomKey = getGeometryKey(groupData, geomType);
      const ring = (groupData[geomKey] as number[][][])[idx] ?? [];
      const transformed = transformArray(ring as [number, number][], crs);
      geometry = { type: "Polygon", coordinates: [transformed.map(([lng, lat]) => [lng, lat])] };
    }

    return {
      type: "Feature",
      geometry,
      properties,
    } as Feature;
  });

  return { type: "FeatureCollection", features };
}

export function extractGeometryColumns(
  feature: Feature,
  geomType: GeometryType,
  geomKey: string,
  epsg: number | null,
): Record<string, unknown> {
  const crs = determineCRS(epsg);
  const geom = (feature as any).geometry;

  if (geomType === "point") {
    const [lng, lat] = geom?.coordinates ?? [0, 0];
    const [x, y] = reverseTransform([lng, lat], crs);
    return { "geometry.x": x, "geometry.y": y };
  }

  if (geomType === "linestring") {
    const coords: [number, number][] = geom?.coordinates ?? [];
    const transformed = reverseTransformArray(coords, crs);
    return { [geomKey]: transformed.map(([x, y]) => [x, y]) };
  }

  // polygon — GeoJSON stores as [[ring]], we keep outer ring
  const rings: [number, number][][] = geom?.coordinates ?? [];
  const outerRing: [number, number][] = rings[0] ?? [];
  const transformed = reverseTransformArray(outerRing, crs);
  return { [geomKey]: transformed.map(([x, y]) => [x, y]) };
}

/**
 * Compute the 2D Euclidean length of a linestring from its native-CRS coordinates.
 * Coordinates are [[x1,y1], [x2,y2], ...] in a projected CRS (metres).
 */
export function computeLinestringLength(coords: number[][]): number {
  let length = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const dx = coords[i + 1]![0]! - coords[i]![0]!;
    const dy = coords[i + 1]![1]! - coords[i]![1]!;
    length += Math.sqrt(dx * dx + dy * dy);
  }
  return length;
}

export function geomColumnsToWgs84Geometry(
  geomColumns: Record<string, unknown>,
  geomType: GeometryType,
  geomKey: string,
  epsg: number | null,
): any {
  const crs = determineCRS(epsg);

  if (geomType === "point") {
    const x = geomColumns["geometry.x"] as number;
    const y = geomColumns["geometry.y"] as number;
    const [lng, lat] = transform([x, y], crs);
    return { type: "Point", coordinates: [lng, lat] };
  }

  if (geomType === "linestring") {
    const line = geomColumns[geomKey] as number[][];
    const transformed = transformArray(line as [number, number][], crs);
    return { type: "LineString", coordinates: transformed.map(([lng, lat]) => [lng, lat]) };
  }

  // polygon
  const ring = geomColumns[geomKey] as number[][];
  const transformed = transformArray(ring as [number, number][], crs);
  return { type: "Polygon", coordinates: [transformed.map(([lng, lat]) => [lng, lat])] };
}
