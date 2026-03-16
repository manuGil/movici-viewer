<template>
  <div class="edit-mode-toolbar">
    <o-tooltip v-for="mode in modes" :key="mode.key" :label="mode.label" position="right">
      <o-button
        :variant="store.editModeKey === mode.key ? 'primary' : 'white'"
        size="small"
        :icon-left="mode.icon"
        icon-pack="fas"
        @click="store.setEditMode(mode.key)"
        class="mode-btn"
      />
    </o-tooltip>
  </div>
</template>

<script setup lang="ts">
import { useEditorStore } from "@/stores/useEditorStore";

const store = useEditorStore();

const modes = [
  { key: "view" as const, label: "Select", icon: "mouse-pointer" },
  { key: "modify" as const, label: "Edit vertices", icon: "project-diagram" },
  { key: "translate" as const, label: "Move feature", icon: "arrows-alt" },
];
</script>

<style scoped lang="scss">
.edit-mode-toolbar {
  display: flex;
  flex-direction: column;
  gap: 4px;

  .mode-btn {
    width: 32px;
    height: 32px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
}
</style>
