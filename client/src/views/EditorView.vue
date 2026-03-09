<template>
  <div class="editor-view" @keydown="onKeyDown">
    <EditorToolbar />
    <div class="editor-body">
      <div class="editor-map">
        <Deck ref="deckRef" :layers="layers" :camera="camera" @update:camera="camera = $event">
          <template #control-left="{ onViewstateChange }">
            <MapControlNavigation
              :model-value="camera"
              :initial-camera="initialCamera"
              @update:model-value="onViewstateChange($event)"
            />
            <MapControlBaseMap :model-value="basemap" @update:model-value="basemap = $event" />
          </template>
          <template #control-zero="{ on }">
            <span ref="deckOnRef" :data-on="registerOn(on)" style="display: none" />
          </template>
        </Deck>
      </div>
      <EditorSidebar class="editor-sidebar" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { useEditorStore } from "@/stores/useEditorStore";
import { useEditorLayers } from "@/composables/useEditorLayers";
import { ensureProjection, transformBBox } from "@movici-flow-lib/crs";
import type { DeckCamera, DeckEventCallback } from "@movici-flow-lib/types";
import { useMoviciSettings } from "@movici-flow-lib/baseComposables/useMoviciSettings";
import Deck from "@movici-flow-lib/components/Deck.vue";
import MapControlNavigation from "@movici-flow-lib/components/mapControls/MapControlNavigation.vue";
import MapControlBaseMap from "@movici-flow-lib/components/mapControls/MapControlBaseMap.vue";
import EditorToolbar from "@/components/editor/EditorToolbar.vue";
import EditorSidebar from "@/components/editor/EditorSidebar.vue";

const props = defineProps<{
  uuid: string;
}>();

const store = useEditorStore();
const { layers } = useEditorLayers();

const DEFAULT_VIEWSTATE = useMoviciSettings().settings.defaultViewState;
const camera = ref<DeckCamera>({ viewState: DEFAULT_VIEWSTATE });
const initialCamera = ref<DeckCamera>();
const basemap = ref("mapbox://styles/mapbox/light-v10");

// We need to register a click handler on the Deck component's `on` method.
// This is done via the control-zero slot which exposes `on`.
let _on: ((event: "click", callbacks: Record<string, DeckEventCallback>) => void) | null = null;

function registerOn(on: (event: "click", callbacks: Record<string, DeckEventCallback>) => void) {
  if (_on === on) return "";
  _on = on;
  on("click", {
    editorClick: (payload) => {
      const info = payload.pickInfo;
      if (info?.object?.id !== undefined) {
        // Also switch entity group if different
        const layerId: string = info.layer?.id ?? "";
        const groupMatch = layerId.match(/^editor-(?:points|paths|polygons)-(.+)$/);
        if (groupMatch?.[1]) {
          const clickedGroup = groupMatch[1];
          if (clickedGroup !== store.entityGroup) {
            store.selectEntityGroup(clickedGroup);
          }
        }
        store.selectEntity(info.object.id as number);
      } else {
        store.clearSelection();
      }
    },
  });
  return "";
}

function onKeyDown(e: KeyboardEvent) {
  if (e.ctrlKey && e.key === "z") {
    e.preventDefault();
    store.undo();
  } else if (e.ctrlKey && e.key === "y") {
    e.preventDefault();
    store.redo();
  }
}

/** Expand a WGS84 bbox to at least `minDeg` degrees on each axis, keeping the centroid fixed. */
function padBBox(
  bbox: [number, number, number, number],
  minDeg = 0.05,
): [number, number, number, number] {
  const [west, south, east, north] = bbox;
  const cx = (west + east) / 2;
  const cy = (south + north) / 2;
  const halfW = Math.max((east - west) / 2, minDeg / 2);
  const halfH = Math.max((north - south) / 2, minDeg / 2);
  return [cx - halfW, cy - halfH, cx + halfW, cy + halfH];
}

onMounted(async () => {
  await store.loadDataset(props.uuid);
  if (store.boundingBox) {
    await ensureProjection(store.dataset?.epsg_code);
    const rawBbox = transformBBox(store.boundingBox, store.dataset?.epsg_code);
    const bbox = padBBox(rawBbox);
    const cam = { bbox: { coords: bbox, fillRatio: 0.7 } };
    camera.value = cam;
    initialCamera.value = cam;
  }
});

watch(
  () => props.uuid,
  async (uuid) => {
    await store.loadDataset(uuid);
  },
);
</script>

<style scoped lang="scss">
.editor-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  outline: none;
}

.editor-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.editor-map {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.editor-sidebar {
  width: 360px;
  min-width: 280px;
  max-width: 480px;
  flex-shrink: 0;
}
</style>
