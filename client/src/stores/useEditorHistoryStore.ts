import { defineStore } from "pinia";
import { ref } from "vue";
import type { GeometryType } from "@/utils/geoJsonBridge";

export interface PropertyCommand {
  kind: "property";
  entityGroup: string;
  id: number;
  property: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface GeometryCommand {
  kind: "geometry";
  entityGroup: string;
  id: number;
  featureIdx: number;
  geomType: GeometryType;
  geomKey: string;
  oldGeomColumns: Record<string, unknown>;
  newGeomColumns: Record<string, unknown>;
}

export type Command = PropertyCommand | GeometryCommand;

export const useEditorHistoryStore = defineStore("editorHistory", () => {
  const undoStack = ref<Command[]>([]);
  const redoStack = ref<Command[]>([]);

  function push(cmd: Command) {
    undoStack.value.push(cmd);
    redoStack.value = [];
  }

  function undo(applyFn: (cmd: Command, isUndo: boolean) => void) {
    const cmd = undoStack.value.pop();
    if (!cmd) return;
    applyFn(cmd, true);
    redoStack.value.push(cmd);
  }

  function redo(applyFn: (cmd: Command, isUndo: boolean) => void) {
    const cmd = redoStack.value.pop();
    if (!cmd) return;
    applyFn(cmd, false);
    undoStack.value.push(cmd);
  }

  function clear() {
    undoStack.value = [];
    redoStack.value = [];
  }

  return {
    undoStack,
    redoStack,
    push,
    undo,
    redo,
    clear,
  };
});
