/**
 * Official Codex apply_patch grammar (verbatim from
 * codex-rs/core/assets/tools/apply_patch.lark).
 *
 * Attached as an `openai_lark` grammar variant: providers that support
 * OpenAI grammar-constrained tools decode the `input` argument against this
 * grammar, making malformed patches structurally impossible. Providers
 * without grammar support (e.g. anthropic-messages) ignore it silently.
 */
export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

export const APPLY_PATCH_CONSTRAINED_SAMPLING = {
	type: "grammar",
	variants: { openai_lark: APPLY_PATCH_LARK_GRAMMAR },
} as const;
