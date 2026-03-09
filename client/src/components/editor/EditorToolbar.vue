<template>
  <nav class="editor-toolbar is-flex is-align-items-center px-4 py-2">
    <router-link :to="{ name: 'home', params: { step: 'dataset' } }">
      <o-button icon-left="arrow-left" icon-pack="fas" size="small" variant="black">
        Datasets
      </o-button>
    </router-link>
    <span class="dataset-name is-size-6 has-text-weight-semibold ml-4 mr-auto">
      {{ datasetDisplayName }}
    </span>

    <span v-if="store.dirtyCount > 0" class="is-size-7 has-text-warning-dark mr-3">
      {{ store.dirtyCount }} unsaved change{{ store.dirtyCount !== 1 ? "s" : "" }}
    </span>

    <o-button
      icon-left="undo"
      icon-pack="fas"
      size="small"
      variant="dark"
      class="mr-1"
      :disabled="historyStore.undoStack.length === 0"
      @click="store.undo()"
      title="Undo (Ctrl+Z)"
    >
      Undo
    </o-button>

    <o-button
      icon-left="redo"
      icon-pack="fas"
      size="small"
      variant="dark"
      class="mr-3"
      :disabled="historyStore.redoStack.length === 0"
      @click="store.redo()"
      title="Redo (ßCtrl+Y)"
    >
      Redo
    </o-button>

    <o-button
      icon-left="save"
      icon-pack="fas"
      size="small"
      variant="primary"
      :disabled="!store.isDirty || store.saving"
      :loading="store.saving"
      @click="store.save()"
    >
      Save
    </o-button>
  </nav>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useEditorStore } from "@/stores/useEditorStore";
import { useEditorHistoryStore } from "@/stores/useEditorHistoryStore";

const store = useEditorStore();
const historyStore = useEditorHistoryStore();

const datasetDisplayName = computed(() => {
  const ds = store.dataset;
  if (!ds) return store.datasetUUID ?? "Dataset Editor";
  return ds.display_name || ds.name || store.datasetUUID || "Dataset Editor";
});
</script>

<style scoped lang="scss">
.editor-toolbar {
  background: white;
  border-bottom: 1px solid $grey-lighter;
  height: 52px;
  flex-shrink: 0;

  .dataset-name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 400px;
  }
}
</style>
