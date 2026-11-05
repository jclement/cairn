// Cairn's tool names and the Basic Memory names they replace. With BM_COMPAT="true" the server
// also registers each Basic Memory name as an alias (same schema and handler), for skills written
// for Basic Memory; help() resolves the old names either way.

export const BM_NAMES: Record<string, string> = {
  bm_write: "write_note",
  bm_read: "read_note",
  bm_edit: "edit_note",
  bm_delete: "delete_note",
  bm_move: "move_note",
  bm_search: "search_notes",
  bm_find: "find_notes",
  bm_list: "list_notes",
  bm_context: "build_context",
  bm_project: "projects",
  bm_core: "core_memory",
  bm_supersede: "supersede",
  bm_attach: "attach_file",
  bm_schema: "check_schema",
  bm_man: "help",
};

/** Cairn name -> Basic Memory alias. */
export const BM_ALIAS_OF: Record<string, string> = Object.fromEntries(Object.entries(BM_NAMES).map(([bm, cairn]) => [cairn, bm]));

export const bmCompat = (env: { BM_COMPAT?: string }): boolean => env.BM_COMPAT === "true";
