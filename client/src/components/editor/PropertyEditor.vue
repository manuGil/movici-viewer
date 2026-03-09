<template>
  <div class="property-editor">
    <div v-if="!entity" class="has-text-grey is-size-7 p-4">Select an entity on the map</div>
    <div v-else>
      <div
        v-for="(value, key) in editableProperties"
        :key="key"
        class="property-row is-flex is-align-items-center mb-2"
      >
        <span
          class="property-key is-size-7 has-text-grey-dark mr-2"
          :title="String(key)"
          :class="{ 'has-text-warning-dark has-text-weight-bold': isModified(String(key)) }"
        >
          {{ String(key) }}
          <span v-if="isModified(String(key))">*</span>
        </span>
        <div class="is-flex-grow-1">
          <!-- enum -->
          <o-select
            v-if="getEnumOptions(String(key))"
            :model-value="currentValue(String(key))"
            @update:model-value="(v: unknown) => emit('change', String(key), Number(v))"
            size="small"
          >
            <option v-for="(label, idx) in getEnumOptions(String(key))" :key="idx" :value="idx">
              {{ label }}
            </option>
          </o-select>
          <!-- boolean -->
          <o-switch
            v-else-if="typeof value === 'boolean'"
            :model-value="Boolean(currentValue(String(key)))"
            @update:model-value="(v: boolean) => emit('change', String(key), v)"
            size="small"
          />
          <!-- number -->
          <o-input
            v-else-if="typeof value === 'number'"
            type="number"
            :model-value="String(currentValue(String(key)))"
            @change="
              (e: Event) =>
                emit('change', String(key), Number((e.target as HTMLInputElement).value))
            "
            size="small"
          />
          <!-- read-only geometry or complex -->
          <span
            v-else-if="isGeometry(String(key))"
            class="is-size-7 has-text-grey is-family-monospace"
          >
            [geometry]
          </span>
          <!-- string / fallback -->
          <o-input
            v-else
            type="text"
            :model-value="String(currentValue(String(key)))"
            @change="
              (e: Event) => emit('change', String(key), (e.target as HTMLInputElement).value)
            "
            size="small"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useEditorStore } from "@/stores/useEditorStore";

const props = defineProps<{
  entity: Record<string, unknown> | null;
  entityGroup: string | null;
  generalEnums: Record<string, string[]>;
  enumNames: Record<string, string>; // propName -> enumName
}>();

const emit = defineEmits<{
  (e: "change", prop: string, value: unknown): void;
}>();

const store = useEditorStore();

const editableProperties = computed(() => {
  if (!props.entity) return {};
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props.entity)) {
    result[k] = v;
  }
  return result;
});

function isGeometry(key: string): boolean {
  return key.startsWith("geometry.");
}

function isModified(key: string): boolean {
  if (!props.entityGroup || store.selectedId === null) return false;
  const pending = store.changes.get(props.entityGroup)?.get(store.selectedId);
  return pending !== undefined && key in pending;
}

function currentValue(key: string): unknown {
  if (!props.entityGroup || store.selectedId === null) return props.entity?.[key];
  const pending = store.changes.get(props.entityGroup)?.get(store.selectedId);
  if (pending && key in pending) return pending[key];
  return props.entity?.[key];
}

function getEnumOptions(key: string): string[] | null {
  const enumName = props.enumNames[key];
  if (!enumName) return null;
  return props.generalEnums[enumName] ?? null;
}
</script>

<style scoped lang="scss">
.property-editor {
  overflow-y: auto;
}
.property-row {
  gap: 0.5rem;
  .property-key {
    min-width: 140px;
    max-width: 140px;
    word-break: break-all;
    flex-shrink: 0;
  }
}
</style>
