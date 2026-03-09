import { defineStore } from "pinia";
import { ref } from "vue";

export interface Command {
  entityGroup: string;
  id: number;
  property: string;
  oldValue: unknown;
  newValue: unknown;
}

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
